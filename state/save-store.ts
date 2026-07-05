// 存档存储中枢：内存 Map（权威态）+ IndexedDB（持久化镜像）+ 写队列 + BroadcastChannel。
//
// 设计目标：
// - 上层 saves.ts 的同步 API 保持不变；其内部从 localStorage 切到本模块的同步读写。
// - IndexedDB 容量按设备空间走，告别 localStorage 5MB 上限。
// - 写入按 (store, id) 串行入队，保证同 key 的写/删顺序。
// - 多标签页用 BroadcastChannel 通知 invalidation；可见性恢复时全量 reload 兜底。
//
// 启动契约：
// - UI/render 调用任何同步读写前，必须 await initSaveStore()。
// - initSaveStore 内会从 IndexedDB 加载全量到内存 Map；若 IndexedDB 是空但 localStorage 有旧数据，一次性迁移并清掉旧 key。
//
// 落盘契约：
// - 常规写入是 fire-and-forget（写队列内顺序异步落盘）。
// - 用户手动存档/导出/退出前，调用 flushSaveStore() 等待全部已入队写入完成。

import {
  IDB_STORE_INDEX,
  IDB_STORE_PAYLOAD,
  idbGet,
  idbGetAll,
  idbPut,
  idbDelete,
} from './idb';

// ── 类型 ──
// 这里用宽泛的 unknown 接，具体形状由 saves.ts 保证；本模块只做存取。
export type StoreSavePayload = Record<string, unknown>;
export type StoreSaveIndex = Record<string, unknown>;

const LEGACY_INDEX_KEY = 'islandmilfcode:save-index:v2';
const LEGACY_PAYLOAD_PREFIX = 'islandmilfcode:save-payload:v2:';

const INDEX_SINGLETON_ID = '__index__';

// ── 内存 Map（权威态） ──
const payloadMap = new Map<string, StoreSavePayload>();
let indexMap: StoreSaveIndex = {};

let initialized = false;
let initPromise: Promise<void> | null = null;
let lastInitDiagnostics = {
  indexCount: 0,
  payloadCount: 0,
  migratedFromLocalStorage: false,
};

// ── 写队列：per (store,id) 串行 ──
const writeQueues = new Map<string, Promise<void>>();

function enqueue(queueKey: string, op: () => Promise<void>): void {
  const prev = writeQueues.get(queueKey) ?? Promise.resolve();
  const next = prev.then(op).catch(async err => {
    console.error('[save-store] write failed:', queueKey, err);
    // 失败重试一次。
    try {
      await op();
    } catch (err2) {
      console.error('[save-store] retry failed:', queueKey, err2);
    }
  });
  writeQueues.set(queueKey, next);
  // 任务完成后清理已结束的链尾，避免 Map 无限增长。
  next.finally(() => {
    if (writeQueues.get(queueKey) === next) writeQueues.delete(queueKey);
  });
}

/** 等待所有已入队的写入落盘。在导出/手动存档/退出前调用。 */
export async function flushSaveStore(): Promise<void> {
  await Promise.allSettled([...writeQueues.values()]);
}

// ── BroadcastChannel：跨 tab 同步 ──
let bc: BroadcastChannel | null = null;
function openBroadcast(): void {
  if (bc) return;
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    bc = new BroadcastChannel('islandmilfcode-save-store');
    bc.onmessage = async ev => {
      const data = ev.data as { type?: string; saveId?: string } | null;
      if (!data?.type) return;
      try {
        if (data.type === 'payload-changed' && data.saveId) {
          const fresh = await idbGet<StoreSavePayload>(IDB_STORE_PAYLOAD, data.saveId);
          if (fresh) payloadMap.set(data.saveId, fresh);
          else payloadMap.delete(data.saveId);
        } else if (data.type === 'payload-deleted' && data.saveId) {
          payloadMap.delete(data.saveId);
        } else if (data.type === 'index-changed') {
          const fresh = await idbGet<StoreSaveIndex>(IDB_STORE_INDEX, INDEX_SINGLETON_ID);
          if (fresh) indexMap = fresh;
        }
      } catch (err) {
        console.warn('[save-store] broadcast sync failed:', err);
      }
    };
  } catch (err) {
    console.warn('[save-store] BroadcastChannel unavailable:', err);
    bc = null;
  }
}

function broadcast(msg: { type: string; saveId?: string }): void {
  if (!bc) return;
  try {
    bc.postMessage(msg);
  } catch (err) {
    console.warn('[save-store] broadcast post failed:', err);
  }
}

// 可见性恢复时全量 reload 兜底（防止 BroadcastChannel 漏消息）。
function installVisibilityReload(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    reloadFromIdb().catch(err => console.warn('[save-store] visibility reload failed:', err));
  });
}

async function reloadFromIdb(): Promise<void> {
  const [payloadRows, indexRow] = await Promise.all([
    idbGetAll<StoreSavePayload>(IDB_STORE_PAYLOAD),
    idbGet<StoreSaveIndex>(IDB_STORE_INDEX, INDEX_SINGLETON_ID),
  ]);
  payloadMap.clear();
  for (const row of payloadRows) payloadMap.set(row.id, row.value);
  indexMap = indexRow ?? {};
}

function updateInitDiagnostics(migratedFromLocalStorage: boolean): void {
  lastInitDiagnostics = {
    indexCount: Object.keys(indexMap).length,
    payloadCount: payloadMap.size,
    migratedFromLocalStorage,
  };
}

// ── 一次性迁移：localStorage → IndexedDB ──
async function migrateFromLocalStorage(): Promise<boolean> {
  if (typeof localStorage === 'undefined') return false;
  let migrated = 0;

  // 索引
  const rawIndex = localStorage.getItem(LEGACY_INDEX_KEY);
  if (rawIndex) {
    try {
      const parsed = JSON.parse(rawIndex) as StoreSaveIndex;
      await idbPut(IDB_STORE_INDEX, INDEX_SINGLETON_ID, parsed);
      indexMap = parsed;
      migrated += 1;
    } catch (err) {
      console.warn('[save-store] migrate index failed:', err);
    }
  }

  // payload
  const payloadKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LEGACY_PAYLOAD_PREFIX)) payloadKeys.push(key);
  }
  for (const key of payloadKeys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as StoreSavePayload;
      const saveId = key.slice(LEGACY_PAYLOAD_PREFIX.length);
      await idbPut(IDB_STORE_PAYLOAD, saveId, parsed);
      payloadMap.set(saveId, parsed);
      migrated += 1;
    } catch (err) {
      console.warn('[save-store] migrate payload failed:', key, err);
    }
  }

  // 迁完清掉旧 key（保留 active-run-id / active-save-id 这种小 key，它们继续待在 localStorage）。
  if (migrated > 0) {
    try {
      localStorage.removeItem(LEGACY_INDEX_KEY);
      for (const key of payloadKeys) localStorage.removeItem(key);
      console.info('[save-store] migrated from localStorage:', migrated, 'records');
    } catch (err) {
      console.warn('[save-store] cleanup legacy localStorage failed:', err);
    }
  }

  return migrated > 0;
}

// ── 公共 API ──

/**
 * 启动初始化。必须在任何同步读写之前 await 一次。
 * 多次调用是幂等的（返回同一个 promise）。
 */
export function initSaveStore(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await reloadFromIdb();
      let didMigrate = false;
      // 如果 IndexedDB 是全空但 localStorage 有旧数据 → 迁移。
      if (Object.keys(indexMap).length === 0 && payloadMap.size === 0) {
        didMigrate = await migrateFromLocalStorage();
        if (didMigrate) await reloadFromIdb();
      }
      updateInitDiagnostics(didMigrate);
      console.info('[save-store:init]', lastInitDiagnostics);
      openBroadcast();
      installVisibilityReload();
      initialized = true;
    } catch (err) {
      console.error('[save-store] init failed:', err);
      // 即使失败也标记 initialized 让上层不卡死；后续操作走内存空 Map。
      initialized = true;
      throw err;
    }
  })();
  return initPromise;
}

/** 同步读 payload。未初始化时返回 null 并告警。 */
export function readPayloadSync(saveId: string): StoreSavePayload | null {
  if (!initialized) {
    console.warn('[save-store] readPayloadSync called before init');
    return null;
  }
  return payloadMap.get(saveId) ?? null;
}

/** 同步列出所有 payload。用于 index 丢失后的本地恢复。 */
export function listPayloadsSync(): Array<{ saveId: string; payload: StoreSavePayload }> {
  if (!initialized) {
    console.warn('[save-store] listPayloadsSync called before init');
    return [];
  }
  return [...payloadMap.entries()].map(([saveId, payload]) => ({ saveId, payload }));
}

/** 同步读 index。未初始化时返回空对象并告警。 */
export function readSaveIndexSync(): StoreSaveIndex {
  if (!initialized) {
    console.warn('[save-store] readSaveIndexSync called before init');
    return {};
  }
  return indexMap;
}

/** 同步写 payload：先更新内存，再异步入队落盘。 */
export function writePayloadSync(saveId: string, payload: StoreSavePayload): void {
  payloadMap.set(saveId, payload);
  enqueue(`payload:${saveId}`, async () => {
    await idbPut(IDB_STORE_PAYLOAD, saveId, payload);
    broadcast({ type: 'payload-changed', saveId });
  });
}

/** 同步删除 payload：先更新内存，再异步入队落盘。 */
export function deletePayloadSync(saveId: string): void {
  payloadMap.delete(saveId);
  enqueue(`payload:${saveId}`, async () => {
    await idbDelete(IDB_STORE_PAYLOAD, saveId);
    broadcast({ type: 'payload-deleted', saveId });
  });
}

/** 同步写 index：先更新内存，再异步入队落盘。 */
export function writeSaveIndexSync(index: StoreSaveIndex): void {
  indexMap = index;
  enqueue('index', async () => {
    await idbPut(IDB_STORE_INDEX, INDEX_SINGLETON_ID, index);
    broadcast({ type: 'index-changed' });
  });
}

/** 检查初始化状态；上层入口诊断用。 */
export function isSaveStoreReady(): boolean {
  return initialized;
}

/** 启动诊断：给入口日志/用户截图确认 index 与 payload 是否真的读到了。 */
export function getSaveStoreDiagnostics() {
  return {
    ...lastInitDiagnostics,
    indexCount: Object.keys(indexMap).length,
    payloadCount: payloadMap.size,
    ready: initialized,
  };
}
