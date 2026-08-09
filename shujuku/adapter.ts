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
const READ_TIMEOUT_MS = 10_000;
const TABLE_TIMEOUT_MS = 300_000;
const VIRTUAL_TURN_TIMEOUT_MS = 300_000;

export const SHUJUKU_NATIVE_HANDOFF_VERSION = 'shujuku-logical-v1';

type UnknownRecord = Record<string, unknown>;

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
};

export type ShujukuVirtualMessageInput = {
  role: 'user' | 'assistant';
  name?: string;
  text: string;
  rawText?: string;
  pluginData?: Record<string, unknown>;
  /** Exactly one message in a request must mark the current logical user turn. */
  current?: boolean;
};

export type ShujukuVirtualTurnInput = {
  rootText?: string;
  messages: ShujukuVirtualMessageInput[];
  userInput: string;
  systemPrompt?: string;
  generationId: string;
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
  databaseCommitted: boolean;
  diagnostics: Record<string, unknown>;
};

type TavernEventSubscription = { stop?: () => void } | undefined;
type TavernEventApi = {
  eventEmit?: (eventType: string, ...args: unknown[]) => Promise<void> | void;
  eventOn?: (eventType: string, listener: (...args: unknown[]) => void) => TavernEventSubscription;
};

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
): Promise<T> {
  const api = getEventApi(win);
  if (!api) throw new Error('Tavern Helper 事件接口不可用；请把 IslandMilfCode 数据库转发桥绑定到当前角色');
  const requestId = createRequestId(action);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let subscription: TavernEventSubscription;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.stop?.();
    };
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(`shujuku 转发桥未响应：${action}`));
    }, timeoutMs);
    subscription = api.eventOn(RESPONSE_EVENT, (...args: unknown[]) => {
      const response = args[0];
      if (!isRecord(response)
        || response.protocolVersion !== PROTOCOL_VERSION
        || response.requestId !== requestId
        || response.action !== action
        || response.backend !== 'shujuku-role-bridge') return;
      cleanup();
      if (response.ok === true) resolve(response.result as T);
      else reject(relayError(response, action));
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
      ? {
          capturedAt: new Date().toISOString(),
          tableHash: await sha256(tablesResult.tables),
          tables: cloneJson(tablesResult.tables),
        }
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
  return {
    capturedAt: new Date().toISOString(),
    tableHash: await sha256(result.tables),
    tables: cloneJson(result.tables),
  };
}

async function relayRestoreTables(win: TavernWindow, tables: Record<string, unknown>): Promise<void> {
  const result = await requestRelay<{ applied?: boolean }>(
    win,
    'restoreTableAsJson',
    { tableJson: JSON.stringify(tables) },
    TABLE_TIMEOUT_MS,
  );
  if (result?.applied !== true) throw new Error('shujuku 拒绝恢复表快照');
}

async function normalizeVirtualTurnResult(value: unknown): Promise<ShujukuVirtualTurnResult> {
  if (!isRecord(value) || typeof value.rawText !== 'string' || !value.rawText.trim()) {
    throw new Error('shujuku 虚拟回合没有返回完整正文');
  }
  if (typeof value.planningObserved !== 'boolean' || typeof value.databaseCommitted !== 'boolean') {
    throw new Error('shujuku 虚拟回合缺少明确的规划/数据库提交结果');
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

/** Run one shujuku-owned planning/generation/table-update turn on a virtual chat. */
export async function runShujukuVirtualTurn(
  win: TavernWindow,
  input: ShujukuVirtualTurnInput,
): Promise<ShujukuVirtualTurnResult> {
  if (typeof input.generationId !== 'string' || !input.generationId.trim()) {
    throw new Error('shujuku 虚拟回合缺少 generationId');
  }
  if (typeof input.userInput !== 'string' || !input.userInput.trim()) {
    throw new Error('shujuku 虚拟回合缺少 userInput');
  }
  if (!Array.isArray(input.messages)) throw new Error('shujuku 虚拟回合消息不是数组');
  const currentUsers = input.messages.filter(message => message?.role === 'user' && message.current === true);
  if (currentUsers.length !== 1 || input.messages[input.messages.length - 1] !== currentUsers[0]) {
    throw new Error('shujuku 虚拟回合必须把唯一当前 user 放在消息末尾');
  }
  const result = await requestRelay<UnknownRecord>(
    win,
    'generateVirtual',
    {
      inputJson: JSON.stringify({
        rootText: input.rootText ?? '',
        messages: input.messages,
        userInput: input.userInput,
        systemPrompt: input.systemPrompt ?? '',
        generationId: input.generationId,
        mode: input.mode ?? 'turn',
      }),
    },
    VIRTUAL_TURN_TIMEOUT_MS,
  );
  return normalizeVirtualTurnResult(result);
}

function findSubsetDifference(expected: unknown, actual: unknown, path = String.fromCharCode(36)): string | null {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return path + ' array mismatch';
    for (let index = 0; index < expected.length; index += 1) {
      const difference = findSubsetDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (isRecord(expected) || isRecord(actual)) {
    if (!isRecord(expected) || !isRecord(actual)) return path + ' shape mismatch';
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) return `${path}.${key} missing`;
      const difference = findSubsetDifference(expected[key], actual[key], `${path}.${key}`);
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
    if (probe.activeIsolationKey && probe.activeIsolationKey !== isolationKey.trim()) {
      throw new Error('shujuku 隔离码不一致，拒绝导入老档表格');
    }
    previous = await relayExportTables(win);
    await relayRestoreTables(win, cloneJson(tables));
    const current = await relayExportTables(win);
    const difference = findSubsetDifference(tables, current.tables);
    if (difference) throw new Error(`shujuku 导入后回读与目标不匹配（${difference}）`);
    return await operation({
      previousTableSnapshot: previous,
      tableSnapshot: current,
      capabilityHash: await sha256(probe.capabilities ?? {}),
      frameId: probe.runtimeSource ?? 'role-script',
      runtimeKind: 'relay',
    });
  } catch (error) {
    if (previous) {
      try { await relayRestoreTables(win, previous.tables); } catch (restoreError) {
        throw new Error(
          `shujuku 表事务失败且原表恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          { cause: error },
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
): Promise<void> {
  const expected = await sha256(snapshot.tables);
  if (expected !== snapshot.tableHash) throw new Error('待恢复表快照 hash 不一致');
  const release = await acquireTableOperation();
  try {
    const probe = await requestRelay<RelayProbe>(win, 'probe');
    if (!probe.apiAvailable) throw new Error('shujuku AutoCardUpdaterAPI 不可用');
    if (probe.activeIsolationKey && probe.activeIsolationKey !== isolationKey.trim()) {
      throw new Error('shujuku 隔离码不一致，拒绝恢复表格');
    }
    await relayRestoreTables(win, snapshot.tables);
    const current = await relayExportTables(win);
    const difference = findSubsetDifference(snapshot.tables, current.tables);
    if (difference) throw new Error(`shujuku 恢复后回读与快照不匹配（${difference}）`);
  } finally {
    release();
  }
}
