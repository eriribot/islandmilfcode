import { BRIDGE_PROTOCOL_VERSION } from '../version';
import type { ArchiveObjectKind, ArchiveRoot, ArchiveSaveMeta } from './archive-backend';

const REQUEST_EVENT = 'islandmilfcode:tavern-backup:request:v2';
const RESPONSE_EVENT = 'islandmilfcode:tavern-backup:response:v2';
const READ_TIMEOUT_MS = 8_000;

type TavernArchiveReadAction = 'v3-get-object' | 'v3-get-image' | 'v3-read-root';
type TavernEventSubscription = { stop?: () => void } | undefined;
type TavernEventApi = {
  eventEmit?: (eventType: string, ...args: unknown[]) => Promise<void> | void;
  eventOn?: (eventType: string, listener: (...args: unknown[]) => void) => TavernEventSubscription;
};

type TavernBridgeResponse<T> = {
  protocolVersion: number;
  requestId: string;
  action: TavernArchiveReadAction;
  ok: boolean;
  result?: T;
  error?: { message?: string };
};

export type TavernArchiveRoot = {
  root: ArchiveRoot;
  rootHash: string;
  meta: ArchiveSaveMeta;
  degraded: boolean;
};

export type TavernArchiveImage = {
  id: string;
  dataUrl: string;
  mimeType: string;
  byteLength: number;
  createdAt: number;
  prompt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getEventApi(): TavernEventApi {
  const scope = globalThis as typeof globalThis & TavernEventApi & { TavernHelper?: TavernEventApi };
  const currentWindow = typeof window === 'undefined' ? null : (window as Window & TavernEventApi);
  if (typeof currentWindow?.eventEmit === 'function' && typeof currentWindow.eventOn === 'function') {
    return { eventEmit: currentWindow.eventEmit.bind(currentWindow), eventOn: currentWindow.eventOn.bind(currentWindow) };
  }
  if (typeof scope.eventEmit === 'function' && typeof scope.eventOn === 'function') {
    return { eventEmit: scope.eventEmit.bind(scope), eventOn: scope.eventOn.bind(scope) };
  }
  if (typeof scope.TavernHelper?.eventEmit === 'function' && typeof scope.TavernHelper.eventOn === 'function') {
    return {
      eventEmit: scope.TavernHelper.eventEmit.bind(scope.TavernHelper),
      eventOn: scope.TavernHelper.eventOn.bind(scope.TavernHelper),
    };
  }
  return {};
}

function createRequestId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `islandmilfcode-archive-read-${random}`;
}

function requestArchiveRead<T>(action: TavernArchiveReadAction, fields: Record<string, unknown> = {}): Promise<T> {
  const api = getEventApi();
  const eventEmit = api.eventEmit;
  const eventOn = api.eventOn;
  if (typeof eventEmit !== 'function' || typeof eventOn !== 'function') {
    return Promise.reject(new Error('Tavern event API unavailable'));
  }
  const requestId = createRequestId();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let subscription: TavernEventSubscription;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      subscription?.stop?.();
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Tavern bridge did not respond to ${action}`));
    }, READ_TIMEOUT_MS);
    subscription = eventOn(RESPONSE_EVENT, (...args: unknown[]) => {
      const response = args[0] as TavernBridgeResponse<T> | null | undefined;
      if (
        !response
        || response.protocolVersion !== BRIDGE_PROTOCOL_VERSION
        || response.requestId !== requestId
        || response.action !== action
      ) return;
      cleanup();
      if (response.ok) resolve(response.result as T);
      else reject(new Error(response.error?.message || `Tavern bridge rejected ${action}`));
    });
    Promise.resolve(eventEmit(REQUEST_EVENT, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId,
      action,
      ...fields,
    })).catch(error => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function readTavernArchiveRoot(saveId: string): Promise<TavernArchiveRoot | null> {
  const result = await requestArchiveRead<{
    entry?: { meta?: unknown } | null;
    root?: unknown;
    degraded?: boolean;
    resolvedRootHash?: unknown;
  }>('v3-read-root', { saveId });
  if (!isRecord(result?.root) || !isRecord(result.entry?.meta)) return null;
  const rootHash = String(result.resolvedRootHash || result.entry?.meta?.rootHash || '');
  if (!rootHash) return null;
  return {
    root: result.root as ArchiveRoot,
    rootHash,
    meta: result.entry.meta as ArchiveSaveMeta,
    degraded: Boolean(result.degraded),
  };
}

export async function readTavernArchiveObject<T>(
  kind: Exclude<ArchiveObjectKind, 'root'>,
  hash: string,
): Promise<T | null> {
  const result = await requestArchiveRead<{ value?: T } | null>('v3-get-object', { kind, hash });
  return result?.value ?? null;
}

export async function readTavernArchiveImage(assetId: string): Promise<TavernArchiveImage | null> {
  const result = await requestArchiveRead<{ asset?: unknown }>('v3-get-image', { assetId });
  const asset = result?.asset;
  if (!isRecord(asset) || typeof asset.id !== 'string' || typeof asset.dataUrl !== 'string') return null;
  return {
    id: asset.id,
    dataUrl: asset.dataUrl,
    mimeType: String(asset.mimeType || 'image/png'),
    byteLength: Number(asset.byteLength) || 0,
    createdAt: Number(asset.createdAt) || Date.now(),
    ...(typeof asset.prompt === 'string' ? { prompt: asset.prompt } : {}),
  };
}
