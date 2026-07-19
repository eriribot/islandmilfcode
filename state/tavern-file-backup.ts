import type { SingleSaveBackupPayload } from './saves';

export const TAVERN_BACKUP_PROTOCOL_VERSION = 1;
export const TAVERN_BACKUP_REQUEST_EVENT = 'islandmilfcode:tavern-backup:request:v1';
export const TAVERN_BACKUP_RESPONSE_EVENT = 'islandmilfcode:tavern-backup:response:v1';

export type TavernBackupIndexEntry = {
  saveId: string;
  runId: string;
  playerName: string;
  label: string;
  updatedAt: number;
  backedUpAt: string;
  storage?: 'bundle-v2' | 'legacy-v1';
  storagePath?: string;
  bundleFile?: string;
  imageFolders?: string[];
  stateFile?: string;
  messagesFile?: string;
  assetsFile?: string;
};

type TavernBackupAction = 'probe' | 'list' | 'write' | 'load';

type TavernBackupRequest = {
  protocolVersion: typeof TAVERN_BACKUP_PROTOCOL_VERSION;
  requestId: string;
  action: TavernBackupAction;
  backup?: SingleSaveBackupPayload;
  saveId?: string;
};

type TavernBackupResponse<T = unknown> = {
  protocolVersion: typeof TAVERN_BACKUP_PROTOCOL_VERSION;
  requestId: string;
  action: TavernBackupAction;
  backend: 'tavern-file';
  ok: boolean;
  result?: T;
  error?: {
    code?: string;
    message?: string;
  };
};

type TavernEventSubscription = { stop?: () => void } | undefined;
type TavernEventApi = {
  eventEmit?: (eventType: string, ...args: unknown[]) => Promise<void> | void;
  eventOn?: (eventType: string, listener: (...args: unknown[]) => void) => TavernEventSubscription;
};

const BRIDGE_RETRY_DELAY_MS = 60_000;
const READ_REQUEST_TIMEOUT_MS = 5_000;
const WRITE_REQUEST_TIMEOUT_MS = 300_000;

let bridgeUnavailableUntil = 0;
let bridgeConfirmed = false;

function getEventApi(): TavernEventApi {
  const scope = globalThis as typeof globalThis & TavernEventApi & { TavernHelper?: TavernEventApi };
  const currentWindow = typeof window === 'undefined' ? null : (window as Window & TavernEventApi);
  if (typeof currentWindow?.eventEmit === 'function' && typeof currentWindow.eventOn === 'function') {
    return {
      eventEmit: currentWindow.eventEmit.bind(currentWindow),
      eventOn: currentWindow.eventOn.bind(currentWindow),
    };
  }
  if (typeof scope.eventEmit === 'function' && typeof scope.eventOn === 'function') {
    return {
      eventEmit: scope.eventEmit.bind(scope),
      eventOn: scope.eventOn.bind(scope),
    };
  }
  if (typeof scope.TavernHelper?.eventEmit === 'function' && typeof scope.TavernHelper.eventOn === 'function') {
    return {
      eventEmit: scope.TavernHelper.eventEmit.bind(scope.TavernHelper),
      eventOn: scope.TavernHelper.eventOn.bind(scope.TavernHelper),
    };
  }
  return {};
}

function createRequestId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `islandmilfcode-backup-${random}`;
}

export function isTavernFileBackupAvailable(): boolean {
  const api = getEventApi();
  return typeof api.eventEmit === 'function' && typeof api.eventOn === 'function' && Date.now() >= bridgeUnavailableUntil;
}

function requestTavernBackup<T>(
  action: TavernBackupAction,
  fields: Pick<TavernBackupRequest, 'backup' | 'saveId'> = {},
): Promise<T> {
  const api = getEventApi();
  if (typeof api.eventEmit !== 'function' || typeof api.eventOn !== 'function') {
    return Promise.reject(new Error('当前页面没有酒馆助手事件接口，请确认酒馆助手已启用。'));
  }

  const requestId = createRequestId();
  const timeoutMs = action === 'write' ? WRITE_REQUEST_TIMEOUT_MS : READ_REQUEST_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let subscription: TavernEventSubscription = undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      subscription?.stop?.();
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      bridgeUnavailableUntil = Date.now() + BRIDGE_RETRY_DELAY_MS;
      bridgeConfirmed = false;
      reject(new Error('本机存档桥没有响应，请导入并启用 savesolt/导入到酒馆中/IslandMilfCode本机存档桥.json。'));
    }, timeoutMs);

    subscription = api.eventOn?.(TAVERN_BACKUP_RESPONSE_EVENT, (...args: unknown[]) => {
      const response = args[0] as TavernBackupResponse<T> | null | undefined;
      if (
        !response ||
        response.protocolVersion !== TAVERN_BACKUP_PROTOCOL_VERSION ||
        response.requestId !== requestId ||
        response.action !== action
      ) {
        return;
      }
      cleanup();
      bridgeUnavailableUntil = 0;
      bridgeConfirmed = true;
      if (response.ok) {
        resolve(response.result as T);
      } else {
        reject(new Error(response.error?.message || '酒馆助手本机存档桥返回未知错误。'));
      }
    });

    const request: TavernBackupRequest = {
      protocolVersion: TAVERN_BACKUP_PROTOCOL_VERSION,
      requestId,
      action,
      ...fields,
    };
    Promise.resolve(api.eventEmit(TAVERN_BACKUP_REQUEST_EVENT, request)).catch(error => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function probeTavernFileBackup(): Promise<{
  persistent: boolean;
  storagePath: string;
  saveCount: number;
}> {
  return requestTavernBackup('probe');
}

export async function listTavernFileBackups(): Promise<TavernBackupIndexEntry[]> {
  const result = await requestTavernBackup<{ entries: TavernBackupIndexEntry[] }>('list');
  return Array.isArray(result.entries) ? result.entries : [];
}

export async function writeTavernFileBackup(backup: SingleSaveBackupPayload): Promise<TavernBackupIndexEntry> {
  if (!bridgeConfirmed) await probeTavernFileBackup();
  const result = await requestTavernBackup<{ entry: TavernBackupIndexEntry }>('write', { backup });
  if (!result.entry?.saveId) throw new Error('酒馆助手本机存档桥没有返回有效的存档索引。');
  return result.entry;
}

export async function readTavernFileBackup(saveId: string): Promise<SingleSaveBackupPayload> {
  const result = await requestTavernBackup<{ backup: SingleSaveBackupPayload }>('load', { saveId });
  if (result.backup?.kind !== 'single-save') throw new Error('酒馆助手本机存档桥没有返回有效的存档。');
  return result.backup;
}
