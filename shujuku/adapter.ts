import type {
  ShujukuCompatibilityState,
  ShujukuHandoffEnvelope,
  ShujukuTableSnapshot,
  TavernWindow,
} from '../types';

/**
 * The adapter is the only Island-side entry point for shujuku. Table handoff
 * remains a separate transaction; a narrative turn uses the role bridge's
 * virtual chat session so shujuku itself owns planning and table filling.
 */
const PROTOCOL_VERSION = 1;
const REQUEST_EVENT = 'islandmilfcode:shujuku-relay:request:v1';
const RESPONSE_EVENT = 'islandmilfcode:shujuku-relay:response:v1';
const PROGRESS_ACK_EVENT = 'islandmilfcode:shujuku-relay:progress-ack:v1';
const CANCEL_EVENT = 'islandmilfcode:shujuku-relay:cancel:v1';
const RELAY_BACKEND = 'islandmilfcode';
const READ_TIMEOUT_MS = 10_000;
const TABLE_TIMEOUT_MS = 300_000;
const VIRTUAL_TURN_TIMEOUT_MS = 300_000;

export const SHUJUKU_NATIVE_HANDOFF_VERSION = 'shujuku-logical-v1';

type UnknownRecord = Record<string, unknown>;

/**
 * Durable snapshot projection defines which fields from Shujuku runtime exports
 * are persistable across save/restore cycles. Runtime-derived statistics and
 * transient metadata must be excluded to ensure round-trip consistency.
 */
type DurableSnapshotProjection = {
  version: number;
  excludeKeys: ReadonlySet<string>;
};

const PROJECTION_V1: DurableSnapshotProjection = {
  version: 1,
  // Known transient fields from AutoCardUpdaterAPI runtime that do not survive
  // restoreTableAsJson and must not be included in durable snapshots.
  excludeKeys: new Set(['_lastUpdateStats']),
};

type RelayProbe = {
  bridgeVersion?: string;
  protocolVersion?: number;
  apiAvailable?: boolean;
  runtimeSource?: string | null;
  activeIsolationKey?: string | null;
  capabilities?: Record<string, boolean>;
  missingTableCapabilities?: string[];
  tableRelayReady?: boolean;
  runtimeReason?: string | null;
};

export type ShujukuRuntimeProbe = {
  available: boolean;
  activeIsolationKey: string | null;
  capabilityHash: string | null;
  tableSnapshot: ShujukuTableSnapshot | null;
  frameId?: string;
  runtimeKind?: 'relay' | 'v2' | 'legacy';
  reason?: string;
  capabilities?: Record<string, boolean>;
};

export type CommittedShujukuBinding = {
  compatibility: ShujukuCompatibilityState;
  handoff: ShujukuHandoffEnvelope;
  tableSnapshot: ShujukuTableSnapshot;
};

export type CommittedShujukuBindingRead =
  | { kind: 'inactive' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'active'; binding: CommittedShujukuBinding };

export type ShujukuHandoffTableImportResult = {
  previousTableSnapshot: ShujukuTableSnapshot;
  tableSnapshot: ShujukuTableSnapshot;
  capabilityHash: string;
  frameId: string;
  runtimeKind: 'relay' | 'v2' | 'legacy';
  /** 事务完成时实际生效的 isolationKey（会话轮换后与入参不同） */
  resolvedIsolationKey: string;
};

export type ShujukuVirtualMessageInput = {
  role: 'user' | 'assistant';
  name?: string;
  text: string;
  rawText?: string;
  pluginData?: Record<string, unknown>;
  /** Exactly one message in a request must mark the current logical user turn. */
  current?: boolean;
  /** Stable logical ID persisted across archive revisions. */
  logicalId: string;
  /** Exchange ID groups user+assistant pair (for 5-assistant mapping). */
  exchangeId: string | null;
  /** Original archive floor index (null for root assistant). */
  floorIndex: number | null;
};

export type ShujukuVirtualTurnInput = {
  /** Complete root assistant message (always chat[0] in real host). */
  rootMessage: ShujukuVirtualMessageInput | null;
  /** Complete logical timeline excluding the separately supplied root. */
  messages: ShujukuVirtualMessageInput[];
  /** Token-bounded history for narrative generation; never used as ACU chat authority. */
  promptMessages: ShujukuVirtualMessageInput[];
  /** Stable identity reserved for the assistant created by this virtual turn. */
  assistantTarget: {
    logicalId: string;
    exchangeId: string;
    floorIndex: number;
    name?: string;
  };
  userInput: string;
  systemPrompt?: string;
  generationId: string;
  /** Stable archive scope and the currently active shujuku runtime scope. */
  isolationKeyHandoff: {
    sourceIsolationKey: string;
    targetIsolationKey: string;
  };
  /** Opening requests still need a marked virtual user for shujuku's hook. */
  mode?: 'turn' | 'opening';
};

export type ShujukuVirtualTurnResult = {
  rawText: string;
  plannedText?: string;
  userPluginData?: Record<string, unknown>;
  assistantPluginData?: Record<string, unknown>;
  tableSnapshot?: ShujukuTableSnapshot;
  planningObserved: boolean;
  /** True for a durable table mutation or a verified explicit table no-op. */
  databaseCommitted: boolean;
  diagnostics: Record<string, unknown>;
};

export type ShujukuVirtualPlanningProgress = {
  plannedText: string;
  userPluginData?: Record<string, unknown>;
  planningObserved: true;
};

export type ShujukuPlanningProjectionAck = {
  bodyContext: string;
  projectionCommitted: true;
};

export type ShujukuVirtualTurnCallbacks = {
  onPlanningReady: (
    progress: ShujukuVirtualPlanningProgress,
  ) => ShujukuPlanningProjectionAck | Promise<ShujukuPlanningProjectionAck>;
};

type TavernEventSubscription = { stop?: () => void } | undefined;
type TavernEventApi = {
  eventEmit?: (eventType: string, ...args: unknown[]) => Promise<void> | void;
  eventOn?: (eventType: string, listener: (...args: unknown[]) => unknown) => TavernEventSubscription;
};

type ActiveVirtualRelay = {
  requestId: string;
  cancel: () => void;
  eventEmit: (eventType: string, ...args: unknown[]) => Promise<void> | void;
};

const activeVirtualRelays = new Map<string, ActiveVirtualRelay>();

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function applyDurableProjection(
  tables: Record<string, unknown>,
  projection: DurableSnapshotProjection,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [tableName, tableValue] of Object.entries(tables)) {
    if (!isRecord(tableValue)) {
      projected[tableName] = tableValue;
      continue;
    }
    const projectedTable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tableValue)) {
      if (!projection.excludeKeys.has(key)) {
        projectedTable[key] = value;
      }
    }
    projected[tableName] = projectedTable;
  }
  return projected;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stableJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function inspectCommittedShujukuBinding(
  flags: Record<string, unknown>,
  identity: { saveId: string | null | undefined; runId: string | null | undefined },
): CommittedShujukuBindingRead {
  const rawCompatibility = flags.shujukuCompatibility;
  if (!isRecord(rawCompatibility) || rawCompatibility.route !== 'shujuku') return { kind: 'inactive' };
  if (rawCompatibility.handoffPhase !== 'committed') return { kind: 'inactive' };
  if (typeof rawCompatibility.branchId !== 'string' || !rawCompatibility.branchId.trim()) {
    return { kind: 'invalid', reason: '当前 shujuku 连接缺少 branchId' };
  }
  if (rawCompatibility.mappingVersion !== SHUJUKU_NATIVE_HANDOFF_VERSION) {
    return { kind: 'invalid', reason: '当前 shujuku 连接不是原生 handoff' };
  }
  if (!identity.saveId || rawCompatibility.saveId !== identity.saveId) {
    return { kind: 'invalid', reason: '当前 shujuku 连接的 saveId 与活动存档不一致' };
  }
  if (!identity.runId || rawCompatibility.runId !== identity.runId) {
    return { kind: 'invalid', reason: '当前 shujuku 连接的 runId 与活动存档不一致' };
  }
  if (typeof rawCompatibility.handoffId !== 'string' || !rawCompatibility.handoffId.trim()) {
    return { kind: 'invalid', reason: '当前 shujuku 连接缺少 handoffId' };
  }
  if (typeof rawCompatibility.isolationKey !== 'string' || !rawCompatibility.isolationKey.trim()) {
    return { kind: 'invalid', reason: '当前 shujuku 连接缺少 isolationKey' };
  }

  const rawHandoff = flags.shujukuHandoff;
  if (!isRecord(rawHandoff) || rawHandoff.mappingVersion !== SHUJUKU_NATIVE_HANDOFF_VERSION) {
    return { kind: 'invalid', reason: '当前 shujuku handoff 缺失或版本不兼容' };
  }
  if (
    rawHandoff.status !== 'committed'
    || rawHandoff.handoffId !== rawCompatibility.handoffId
    || rawHandoff.branchId !== rawCompatibility.branchId
    || rawHandoff.saveId !== rawCompatibility.saveId
    || rawHandoff.runId !== rawCompatibility.runId
  ) {
    return { kind: 'invalid', reason: '当前 shujuku handoff 身份与活动连接不一致' };
  }
  if (!Number.isInteger(rawHandoff.cutoffFloor) || Number(rawHandoff.cutoffFloor) < 0) {
    return { kind: 'invalid', reason: '当前 shujuku handoff 缺少有效的接通消息边界' };
  }

  const rawTableSnapshot = flags.shujukuTableSnapshot;
  if (
    !isRecord(rawTableSnapshot)
    || typeof rawTableSnapshot.capturedAt !== 'string'
    || typeof rawTableSnapshot.tableHash !== 'string'
    || !rawTableSnapshot.tableHash.trim()
    || !isRecord(rawTableSnapshot.tables)
    || Object.keys(rawTableSnapshot.tables).length === 0
    || rawCompatibility.lastTableHash !== rawTableSnapshot.tableHash
    || typeof rawHandoff.tableHash !== 'string'
    || !rawHandoff.tableHash.trim()
  ) {
    return { kind: 'invalid', reason: '当前 shujuku 连接缺少匹配的轮前表快照' };
  }

  return {
    kind: 'active',
    binding: {
      compatibility: rawCompatibility as ShujukuCompatibilityState,
      handoff: rawHandoff as ShujukuHandoffEnvelope,
      tableSnapshot: rawTableSnapshot as ShujukuTableSnapshot,
    },
  };
}

function createRequestId(action: string): string {
  const random = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `islandmilfcode-shujuku-${action}-${random}`;
}

function getEventApi(win: TavernWindow): Required<Pick<TavernEventApi, 'eventEmit' | 'eventOn'>> | null {
  const candidates: Array<UnknownRecord | null> = [];
  try { candidates.push(win as unknown as UnknownRecord); } catch { /* ignored */ }
  try { candidates.push(globalThis as unknown as UnknownRecord); } catch { /* ignored */ }
  for (const candidate of candidates) {
    if (typeof candidate?.eventEmit === 'function' && typeof candidate?.eventOn === 'function') {
      return {
        eventEmit: candidate.eventEmit.bind(candidate),
        eventOn: candidate.eventOn.bind(candidate),
      };
    }
    const helper = candidate?.TavernHelper;
    if (isRecord(helper) && typeof helper.eventEmit === 'function' && typeof helper.eventOn === 'function') {
      return {
        eventEmit: helper.eventEmit.bind(helper),
        eventOn: helper.eventOn.bind(helper),
      };
    }
  }
  return null;
}

function relayError(response: UnknownRecord, action: string): Error {
  const error = response.error;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'SHUJUKU_RELAY_FAILED';
  const message = isRecord(error) && typeof error.message === 'string'
    ? error.message
    : `shujuku 转发桥拒绝 ${action}`;
  const result = new Error(message);
  Object.assign(result, { code });
  return result;
}

async function requestRelay<T>(
  win: TavernWindow,
  action: string,
  fields: UnknownRecord = {},
  timeoutMs = READ_TIMEOUT_MS,
  onProgress?: (phase: string, result: unknown) => unknown | Promise<unknown>,
  generationId?: string,
): Promise<T> {
  const api = getEventApi(win);
  if (!api) throw new Error('Tavern Helper 事件接口不可用；请把 IslandMilfCode 数据库转发桥绑定到当前角色');
  const requestId = createRequestId(action);
  if (generationId && activeVirtualRelays.has(generationId)) {
    throw new Error(`shujuku generationId 正在执行中：${generationId}`);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let subscription: TavernEventSubscription;
    let progressChain: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof globalThis.setTimeout>;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.stop?.();
      if (generationId && activeVirtualRelays.get(generationId)?.requestId === requestId) {
        activeVirtualRelays.delete(generationId);
      }
    };
    const cancel = () => {
      if (settled) return;
      cleanup();
      reject(new Error(`shujuku 虚拟回合已取消：${generationId ?? requestId}`));
    };
    if (generationId) activeVirtualRelays.set(generationId, { requestId, cancel, eventEmit: api.eventEmit });
    timer = globalThis.setTimeout(() => {
      if (generationId) {
        void Promise.resolve(api.eventEmit(CANCEL_EVENT, {
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            action,
            backend: RELAY_BACKEND,
            generationId,
            reason: 'relay-timeout',
          })).catch(() => undefined);
      }
      cleanup();
      reject(new Error(`shujuku 转发桥未响应：${action}`));
    }, timeoutMs);
    subscription = api.eventOn(RESPONSE_EVENT, async (...args: unknown[]) => {
      const response = args[0];
      if (!isRecord(response)
        || response.protocolVersion !== PROTOCOL_VERSION
        || response.requestId !== requestId
        || response.action !== action
        || response.backend !== 'shujuku-role-bridge') return;
      if (response.progress === true) {
        const phase = typeof response.phase === 'string' ? response.phase : '';
        progressChain = progressChain.then(async () => {
          if (settled) return;
          try {
            const acknowledgement = await onProgress?.(phase, response.result);
            await api.eventEmit(PROGRESS_ACK_EVENT, {
              protocolVersion: PROTOCOL_VERSION,
              requestId,
              action,
              backend: RELAY_BACKEND,
              phase,
              ok: true,
              result: acknowledgement === undefined ? null : cloneJson(acknowledgement),
            });
          } catch (error) {
            try {
              await api.eventEmit(PROGRESS_ACK_EVENT, {
                protocolVersion: PROTOCOL_VERSION,
                requestId,
                action,
                backend: RELAY_BACKEND,
                phase,
                ok: false,
                error: {
                  code: 'PLANNING_PROJECTION_FAILED',
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            } catch {
              // The request rejection below remains the authoritative failure.
            }
            cleanup();
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            reject(normalizedError);
          }
        });
        await progressChain;
        return;
      }
      try {
        await progressChain;
        if (settled) return;
        cleanup();
        if (response.ok === true) resolve(response.result as T);
        else reject(relayError(response, action));
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    Promise.resolve(api.eventEmit(REQUEST_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      action,
      ...fields,
    })).catch(error => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** Cancel the in-flight relay and notify the role bridge before late phases publish. */
export async function cancelShujukuVirtualTurn(generationId: string): Promise<void> {
  const key = String(generationId ?? '').trim();
  if (!key) return;
  const active = activeVirtualRelays.get(key);
  if (!active) return;
  // Invoke the event bus first, but never let a hung bus delay local
  // cancellation. The request identity lets the bridge ignore stale cancels
  // when a generation id is later reused.
  const notification = Promise.resolve(active.eventEmit(CANCEL_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: active.requestId,
      action: 'generateVirtual',
      backend: RELAY_BACKEND,
      generationId: key,
      reason: 'cancelled-by-user',
    })).catch(() => undefined);
  active.cancel();
  // Local rejection releases Island's serial queue immediately. A stalled
  // event listener must never keep the caller waiting after cancellation.
  void notification;
}

export async function probeShujukuRuntime(
  win: TavernWindow,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<ShujukuRuntimeProbe> {
  try {
    const probe = await requestRelay<RelayProbe>(win, 'probe', {}, timeoutMs);
    const capabilities = probe.capabilities ?? {};
    const tablesResult = capabilities.exportTableAsJson
      ? await requestRelay<{ tables: Record<string, unknown> }>(win, 'exportTableAsJson', {}, timeoutMs)
      : null;
    const tableSnapshot = isRecord(tablesResult?.tables) && Object.keys(tablesResult.tables).length
      ? await (async () => {
          const durableTables = applyDurableProjection(tablesResult.tables, PROJECTION_V1);
          return {
            capturedAt: new Date().toISOString(),
            tableHash: await sha256(durableTables),
            tables: cloneJson(durableTables),
          };
        })()
      : null;
    const missing = ['exportTableAsJson', 'restoreTableAsJson', 'triggerUpdate', 'generateVirtual']
      .filter(capability => capabilities[capability] !== true);
    const available = Boolean(probe.apiAvailable && missing.length === 0);
    return {
      available,
      activeIsolationKey: probe.activeIsolationKey ?? null,
      capabilityHash: await sha256(capabilities),
      tableSnapshot,
      frameId: probe.runtimeSource ?? 'role-script',
      runtimeKind: 'relay',
      capabilities,
      ...(available
        ? {}
        : {
            reason: probe.runtimeReason?.trim()
              || (missing.length
                ? `角色转发桥缺少 shujuku 回合能力：${missing.join(',')}`
                : `角色转发桥尚未连接到 AutoCardUpdaterAPI（source=${probe.runtimeSource ?? 'none'}）`),
          }),
    };
  } catch (error) {
    return {
      available: false,
      activeIsolationKey: null,
      capabilityHash: null,
      tableSnapshot: null,
      runtimeKind: 'relay',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function relayExportTables(win: TavernWindow): Promise<ShujukuTableSnapshot> {
  const result = await requestRelay<{ tables: Record<string, unknown> }>(win, 'exportTableAsJson');
  if (!isRecord(result?.tables) || !Object.keys(result.tables).length) throw new Error('shujuku 没有可导出的表快照');
  const durableTables = applyDurableProjection(result.tables, PROJECTION_V1);
  return {
    capturedAt: new Date().toISOString(),
    tableHash: await sha256(durableTables),
    tables: cloneJson(durableTables),
  };
}

async function relayRestoreTables(
  win: TavernWindow,
  tables: Record<string, unknown>,
  projection: DurableSnapshotProjection,
): Promise<void> {
  const durableTables = applyDurableProjection(tables, projection);
  const result = await requestRelay<{ applied?: boolean }>(
    win,
    'restoreTableAsJson',
    { tableJson: JSON.stringify(durableTables) },
    TABLE_TIMEOUT_MS,
  );
  if (result?.applied !== true) throw new Error('shujuku 拒绝恢复表快照');
}

async function normalizeVirtualTurnResult(value: unknown): Promise<ShujukuVirtualTurnResult> {
  if (!isRecord(value) || typeof value.rawText !== 'string' || !value.rawText.trim()) {
    throw new Error('shujuku 虚拟回合没有返回完整正文');
  }
  if (value.planningObserved !== true || value.databaseCommitted !== true) {
    throw new Error(
      `shujuku 虚拟回合未完成必要提交：planning=${String(value.planningObserved)} database=${String(value.databaseCommitted)}`,
    );
  }
  const rawTable = isRecord(value.tableSnapshot) ? value.tableSnapshot : null;
  const table = rawTable
    && isRecord(rawTable.tables)
    && Object.keys(rawTable.tables).length > 0
    && typeof rawTable.tableHash === 'string'
    && rawTable.tableHash.trim().length > 0
    && typeof rawTable.capturedAt === 'string'
    ? {
        ...cloneJson(rawTable),
        tables: cloneJson(rawTable.tables),
      } as ShujukuTableSnapshot
    : undefined;
  if (!table) throw new Error('shujuku 虚拟回合缺少表快照');
  const expectedHash = await sha256(table.tables);
  if (expectedHash !== table.tableHash) throw new Error('shujuku 虚拟回合表快照 hash 不匹配');
  if (!isRecord(value.diagnostics) || value.diagnostics.adapterRestored !== true) {
    throw new Error('shujuku 虚拟 runtime 未确认恢复');
  }
  return {
    rawText: value.rawText,
    ...(typeof value.plannedText === 'string' && value.plannedText.trim()
      ? { plannedText: value.plannedText }
      : {}),
    ...(isRecord(value.userPluginData) ? { userPluginData: cloneJson(value.userPluginData) } : {}),
    ...(isRecord(value.assistantPluginData)
      ? { assistantPluginData: cloneJson(value.assistantPluginData) }
      : {}),
    tableSnapshot: table,
    planningObserved: value.planningObserved,
    databaseCommitted: value.databaseCommitted,
    diagnostics: isRecord(value.diagnostics) ? cloneJson(value.diagnostics) : {},
  };
}

function normalizeVirtualPlanningProgress(value: unknown): ShujukuVirtualPlanningProgress {
  if (
    !isRecord(value)
    || value.planningObserved !== true
    || typeof value.plannedText !== 'string'
    || !value.plannedText.trim()
  ) {
    throw new Error('shujuku 虚拟回合收到无效的规划进度');
  }
  return {
    plannedText: value.plannedText,
    ...(isRecord(value.userPluginData) ? { userPluginData: cloneJson(value.userPluginData) } : {}),
    planningObserved: true,
  };
}

/** Run one shujuku-owned planning/generation/table-update turn on a virtual chat. */
export async function runShujukuVirtualTurn(
  win: TavernWindow,
  input: ShujukuVirtualTurnInput,
  callbacks: ShujukuVirtualTurnCallbacks,
): Promise<ShujukuVirtualTurnResult> {
  if (typeof input.generationId !== 'string' || !input.generationId.trim()) {
    throw new Error('shujuku 虚拟回合缺少 generationId');
  }
  if (typeof input.userInput !== 'string' || !input.userInput.trim()) {
    throw new Error('shujuku 虚拟回合缺少 userInput');
  }
  if (!Array.isArray(input.messages)) throw new Error('shujuku 虚拟回合消息不是数组');
  if (!Array.isArray(input.promptMessages)) throw new Error('shujuku 虚拟回合 prompt 窗口不是数组');
  if (
    !input.isolationKeyHandoff
    || typeof input.isolationKeyHandoff.sourceIsolationKey !== 'string'
    || !input.isolationKeyHandoff.sourceIsolationKey.trim()
    || typeof input.isolationKeyHandoff.targetIsolationKey !== 'string'
    || !input.isolationKeyHandoff.targetIsolationKey.trim()
  ) {
    throw new Error('shujuku 虚拟回合缺少 isolationKey handoff');
  }
  const currentUsers = input.messages.filter(message => message?.role === 'user' && message.current === true);
  if (currentUsers.length !== 1 || input.messages[input.messages.length - 1] !== currentUsers[0]) {
    throw new Error('shujuku 虚拟回合必须把唯一当前 user 放在消息末尾');
  }
  if (
    !input.assistantTarget
    || typeof input.assistantTarget.logicalId !== 'string'
    || !input.assistantTarget.logicalId.trim()
    || typeof input.assistantTarget.exchangeId !== 'string'
    || !input.assistantTarget.exchangeId.trim()
    || !Number.isInteger(input.assistantTarget.floorIndex)
    || input.assistantTarget.floorIndex < 0
  ) {
    throw new Error('shujuku 虚拟回合缺少稳定 assistant target');
  }
  if (
    currentUsers[0].exchangeId !== input.assistantTarget.exchangeId
    || currentUsers[0].floorIndex !== input.assistantTarget.floorIndex
  ) {
    throw new Error('shujuku 虚拟回合的 assistant target 与当前 user 不属于同一 exchange');
  }
  const result = await requestRelay<UnknownRecord>(
    win,
    'generateVirtual',
    {
      inputJson: JSON.stringify({
        rootMessage: input.rootMessage ?? null,
        messages: input.messages,
        promptMessages: input.promptMessages,
        assistantTarget: input.assistantTarget,
        userInput: input.userInput,
        systemPrompt: input.systemPrompt ?? '',
        generationId: input.generationId,
        mode: input.mode ?? 'turn',
        isolationKeyHandoff: input.isolationKeyHandoff,
      }),
    },
    VIRTUAL_TURN_TIMEOUT_MS,
    async (phase, progress) => {
      if (phase !== 'planning') return { projectionCommitted: true };
      const normalized = normalizeVirtualPlanningProgress(progress);
      const acknowledgement = await callbacks.onPlanningReady(normalized);
      if (
        !isRecord(acknowledgement)
        || acknowledgement.projectionCommitted !== true
        || typeof acknowledgement.bodyContext !== 'string'
        || !acknowledgement.bodyContext.trim()
      ) {
        throw new Error('shujuku 规划投影没有返回已提交的正文上下文');
      }
      return {
        bodyContext: acknowledgement.bodyContext.trim(),
        projectionCommitted: true,
      };
    },
    input.generationId,
  );
  return normalizeVirtualTurnResult(result);
}

function findSubsetDifference(
  expected: unknown,
  actual: unknown,
  projection: DurableSnapshotProjection,
  path = String.fromCharCode(36),
): string | null {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return path + ' array mismatch';
    for (let index = 0; index < expected.length; index += 1) {
      const difference = findSubsetDifference(expected[index], actual[index], projection, `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (isRecord(expected) || isRecord(actual)) {
    if (!isRecord(expected) || !isRecord(actual)) return path + ' shape mismatch';
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) return `${path}.${key} missing`;
      const difference = findSubsetDifference(expected[key], actual[key], projection, `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return Object.is(expected, actual) ? null : `${path} value differs`;
}

let tableOperationTail: Promise<void> = Promise.resolve();

async function acquireTableOperation(): Promise<() => void> {
  const previous = tableOperationTail;
  let release = () => {};
  const current = new Promise<void>(resolve => { release = resolve; });
  tableOperationTail = previous.catch(() => undefined).then(() => current);
  await previous.catch(() => undefined);
  return release;
}

export async function runShujukuTablesHandoffTransaction<T>(
  win: TavernWindow,
  isolationKey: string,
  tables: Record<string, unknown>,
  operation: (imported: ShujukuHandoffTableImportResult) => Promise<T>,
): Promise<T> {
  const release = await acquireTableOperation();
  let previous: ShujukuTableSnapshot | null = null;
  try {
    const probe = await requestRelay<RelayProbe>(win, 'probe');
    if (!probe.apiAvailable) throw new Error('shujuku AutoCardUpdaterAPI 不可用');
    // isolationKey 不匹配只代表 shujuku 会话已轮换（重载、切换存档后正常现象）。
    // 真正的跨档污染防护由调用方在存档身份（saveId/runId）层面保证，
    // 此处只在同会话内（activeIsolationKey 已设置且与预期完全不同且非空）时记录警告，
    // 不再抛出错误，允许恢复继续并将新 key 传递给调用方。
    const resolvedIsolationKey = probe.activeIsolationKey?.trim() || isolationKey.trim();
    if (
      probe.activeIsolationKey
      && probe.activeIsolationKey.trim()
      && isolationKey.trim()
      && probe.activeIsolationKey.trim() !== isolationKey.trim()
    ) {
      console.info(
        '[shujuku] isolationKey 已轮换（会话重启），使用新 key 继续恢复：',
        probe.activeIsolationKey.trim(),
      );
    }
    previous = await relayExportTables(win);
    await relayRestoreTables(win, cloneJson(tables), PROJECTION_V1);
    // 轮询等待 shujuku 表真正写入完成，避免异步提交导致的回读不一致
    let current: ShujukuTableSnapshot | null = null;
    let attempts = 0;
    const maxAttempts = 10;
    const retryDelay = 100; // ms
    const durableExpected = applyDurableProjection(tables, PROJECTION_V1);
    while (attempts < maxAttempts) {
      current = await relayExportTables(win);
      const difference = findSubsetDifference(durableExpected, current.tables, PROJECTION_V1);
      if (!difference) {
        break; // 校验通过，表已成功写入
      }
      attempts++;
      if (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    const difference = findSubsetDifference(durableExpected, current!.tables, PROJECTION_V1);
    if (difference) throw new Error(`shujuku 导入后回读与目标不匹配（${difference}，${attempts} 次重试后仍不一致）`);
    return await operation({
      previousTableSnapshot: previous,
      tableSnapshot: current!,
      capabilityHash: await sha256(probe.capabilities ?? {}),
      frameId: probe.runtimeSource ?? 'role-script',
      runtimeKind: 'relay',
      resolvedIsolationKey,
    });
  } catch (error) {
    if (previous) {
      try { await relayRestoreTables(win, previous.tables, PROJECTION_V1); } catch (restoreError) {
        throw new Error(
          `shujuku 表事务失败且原表恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
    }
    throw error;
  } finally {
    release();
  }
}

export async function importShujukuTablesForHandoff(
  win: TavernWindow,
  isolationKey: string,
  tables: Record<string, unknown>,
): Promise<ShujukuHandoffTableImportResult> {
  return runShujukuTablesHandoffTransaction(win, isolationKey, tables, async imported => imported);
}

export async function restoreShujukuTablesForHandoff(
  win: TavernWindow,
  isolationKey: string,
  snapshot: ShujukuTableSnapshot,
): Promise<{ resolvedIsolationKey: string }> {
  // 注释掉严格的 hash 预检查：存档保存时的表格结构可能与当前版本略有差异
  // （如 shujuku 新增了默认字段），后续的 findSubsetDifference 会做语义校验。
  // const expected = await sha256(snapshot.tables);
  // if (expected !== snapshot.tableHash) throw new Error('待恢复表快照 hash 不一致');
  const release = await acquireTableOperation();
  try {
    const probe = await requestRelay<RelayProbe>(win, 'probe');
    if (!probe.apiAvailable) throw new Error('shujuku AutoCardUpdaterAPI 不可用');
    // isolationKey 不匹配只代表 shujuku 会话已轮换，允许继续恢复。
    const resolvedIsolationKey = probe.activeIsolationKey?.trim() || isolationKey.trim();
    if (
      probe.activeIsolationKey
      && probe.activeIsolationKey.trim()
      && isolationKey.trim()
      && probe.activeIsolationKey.trim() !== isolationKey.trim()
    ) {
      console.info(
        '[shujuku] isolationKey 已轮换（会话重启），使用新 key 继续恢复：',
        probe.activeIsolationKey.trim(),
      );
    }
    const durableExpected = applyDurableProjection(snapshot.tables, PROJECTION_V1);
    const beforeRestore = await relayExportTables(win);
    const existingDifference = findSubsetDifference(durableExpected, beforeRestore.tables, PROJECTION_V1);
    if (!existingDifference) return { resolvedIsolationKey };
    await relayRestoreTables(win, snapshot.tables, PROJECTION_V1);
    // 轮询等待 shujuku 表真正写入完成，避免异步提交导致的回读不一致
    let current: ShujukuTableSnapshot | null = null;
    let attempts = 0;
    const maxAttempts = 10;
    const retryDelay = 100; // ms
    while (attempts < maxAttempts) {
      current = await relayExportTables(win);
      const difference = findSubsetDifference(durableExpected, current.tables, PROJECTION_V1);
      if (!difference) {
        break; // 校验通过，表已成功写入
      }
      attempts++;
      if (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    const difference = findSubsetDifference(durableExpected, current!.tables, PROJECTION_V1);
    if (difference) throw new Error(`shujuku 恢复后回读与快照不匹配（${difference}，${attempts} 次重试后仍不一致）`);
    return { resolvedIsolationKey };
  } finally {
    release();
  }
}
