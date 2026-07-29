// 极薄的 IndexedDB 封装：只暴露 open/get/put/delete/getAll 五个原子操作。
// 上层 save-store 负责内存 Map / 写队列 / BroadcastChannel。

import { IDB_SCHEMA_VERSION } from '../version';

const DB_NAME = 'islandmilfcode';
export const IDB_STORE_INDEX = 'save-index';
export const IDB_STORE_PAYLOAD = 'save-payload';
export const IDB_STORE_IMAGE_ASSETS = 'image-assets';
export const IDB_STORE_SAVE_META_V3 = 'save-meta-v3';
export const IDB_STORE_SAVE_STATE_V3 = 'save-state-v3';
export const IDB_STORE_FLOOR_CHUNKS_V3 = 'floor-chunks-v3';
export const IDB_STORE_FLOOR_INDEX_V3 = 'floor-index-v3';
export const IDB_STORE_SUMMARY_BLOCKS_V3 = 'summary-blocks-v3';
export const IDB_STORE_MEMORY_BLOCKS_V3 = 'memory-blocks-v3';
export const IDB_STORE_ARCHIVE_ROOTS_V3 = 'archive-roots-v3';
export const IDB_STORE_BACKUP_JOURNAL_V3 = 'backup-journal-v3';
export const IDB_STORE_MIGRATION_JOURNAL_V3 = 'migration-journal-v3';
export const IDB_STORE_WORLDBOOK_CACHE_V3 = 'worldbook-cache-v3';
export const IDB_STORE_IMAGE_REFERENCES_V3 = 'image-references-v3';

const V3_STORES = [
  IDB_STORE_SAVE_META_V3,
  IDB_STORE_SAVE_STATE_V3,
  IDB_STORE_FLOOR_CHUNKS_V3,
  IDB_STORE_FLOOR_INDEX_V3,
  IDB_STORE_SUMMARY_BLOCKS_V3,
  IDB_STORE_MEMORY_BLOCKS_V3,
  IDB_STORE_ARCHIVE_ROOTS_V3,
  IDB_STORE_BACKUP_JOURNAL_V3,
  IDB_STORE_MIGRATION_JOURNAL_V3,
  IDB_STORE_WORLDBOOK_CACHE_V3,
  IDB_STORE_IMAGE_REFERENCES_V3,
] as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, IDB_SCHEMA_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_INDEX)) {
        db.createObjectStore(IDB_STORE_INDEX, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_PAYLOAD)) {
        db.createObjectStore(IDB_STORE_PAYLOAD, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_IMAGE_ASSETS)) {
        db.createObjectStore(IDB_STORE_IMAGE_ASSETS, { keyPath: 'id' });
      }
      for (const storeName of V3_STORES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('indexedDB.open blocked'));
  });
  return dbPromise;
}

function txStore(db: IDBDatabase, storeName: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb request failed'));
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('idb transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('idb transaction failed'));
  });
}

/** 取一条记录；不存在返回 null。 */
export async function idbGet<T>(storeName: string, id: string): Promise<T | null> {
  const db = await openDb();
  const result = await promisifyRequest(txStore(db, storeName, 'readonly').get(id));
  if (!result) return null;
  // 我们存的形状是 { id, value }，剥掉 id 再返回。
  const wrapped = result as { id: string; value: T };
  return wrapped.value;
}

/** 写入一条记录（覆盖式）。 */
export async function idbPut<T>(storeName: string, id: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  const completed = waitForTransaction(tx);
  const requested = promisifyRequest(tx.objectStore(storeName).put({ id, value }));
  await Promise.all([requested, completed]);
}

/** 删除一条记录。 */
export async function idbDelete(storeName: string, id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  const completed = waitForTransaction(tx);
  const requested = promisifyRequest(tx.objectStore(storeName).delete(id));
  await Promise.all([requested, completed]);
}

/** 取整个 store 的所有记录。 */
export async function idbGetAll<T>(storeName: string): Promise<Array<{ id: string; value: T }>> {
  const db = await openDb();
  const result = await promisifyRequest(txStore(db, storeName, 'readonly').getAll());
  return (result as Array<{ id: string; value: T }>) ?? [];
}

/** Prefix cursor used by archive/export/GC paths; normal floor reads remain exact-key lookups. */
export async function idbGetByPrefix<T>(
  storeName: string,
  prefix: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<Array<{ id: string; value: T }>> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const upper = `${prefix}\uffff`;
  return new Promise((resolve, reject) => {
    const rows: Array<{ id: string; value: T }> = [];
    const request = store.openCursor(IDBKeyRange.bound(prefix, upper));
    request.onerror = () => reject(request.error ?? new Error('idb cursor failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) {
        resolve(rows);
        return;
      }
      const wrapped = cursor.value as { id: string; value: T };
      rows.push({ id: wrapped.id, value: wrapped.value });
      cursor.continue();
    };
  });
}

export type IdbAtomicMutation =
  | { type: 'put'; storeName: string; id: string; value: unknown }
  | { type: 'delete'; storeName: string; id: string };

export type IdbAtomicCheck = {
  storeName: string;
  id: string;
  validate: (currentValue: unknown | null) => void;
};

/**
 * Apply a bounded set of mutations in one IndexedDB transaction. Resolution
 * means the transaction emitted `complete`, not merely that each request was
 * accepted by the browser.
 */
export async function idbMutateAtomic(
  mutations: IdbAtomicMutation[],
  checks: IdbAtomicCheck[] = [],
): Promise<void> {
  if (mutations.length === 0) return;
  const db = await openDb();
  const storeNames = [...new Set([...mutations, ...checks].map(operation => operation.storeName))];
  const tx = db.transaction(storeNames, 'readwrite');
  const completed = waitForTransaction(tx);
  try {
    const currentValues = await Promise.all(
      checks.map(async check => {
        const result = await promisifyRequest(tx.objectStore(check.storeName).get(check.id));
        if (!result) return null;
        return (result as { id: string; value: unknown }).value;
      }),
    );
    checks.forEach((check, index) => check.validate(currentValues[index]));
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have aborted because the read failed.
    }
    void completed.catch(() => undefined);
    throw error;
  }
  const requested = mutations.map(mutation => {
    const store = tx.objectStore(mutation.storeName);
    return mutation.type === 'put'
      ? promisifyRequest(store.put({ id: mutation.id, value: mutation.value }))
      : promisifyRequest(store.delete(mutation.id));
  });
  await Promise.all([...requested, completed]);
}

/** 关闭并丢弃缓存的连接（一般只在测试/异常恢复时用）。 */
export function closeIdb(): void {
  if (!dbPromise) return;
  dbPromise.then(db => db.close()).catch(() => {});
  dbPromise = null;
}
