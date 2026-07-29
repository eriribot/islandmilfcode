import { BRIDGE_PROTOCOL_VERSION } from '../version';
import type {
  ArchiveFloorChunk,
  ArchiveCompatibilityBlock,
  ArchiveFloorIndexEntry,
  ArchiveFloorIndexPage,
  ArchiveLocalCapability,
  ArchiveObjectKind,
  ArchiveObjectReference,
  ArchiveRoot,
  ArchiveSaveMeta,
  ArchiveStateBlock,
  ArchiveSummaryBlock,
  ArchiveMemoryBlock,
} from './archive-backend';
import { BrowserArchiveBackend } from './browser-archive-backend';
import {
  markArchiveLocalBackupResult,
  getArchiveMetaSync,
  subscribeArchiveCommits,
  type ArchiveCommitEvent,
  type PortableArchiveBackup,
} from './archive-repository';
import { exportImageAssetsForIds, restoreImageAssetFromBackup, type ImageAssetBackupRecord } from './image-assets';
import { readImageAssetReferences } from './image-references';
import type { FloorRecord } from '../types';
import type { SingleSaveBackupPayload } from './saves';

export const TAVERN_BACKUP_PROTOCOL_VERSION = BRIDGE_PROTOCOL_VERSION;
export const TAVERN_BACKUP_REQUEST_EVENT = 'islandmilfcode:tavern-backup:request:v2';
export const TAVERN_BACKUP_RESPONSE_EVENT = 'islandmilfcode:tavern-backup:response:v2';
const LEGACY_REQUEST_EVENT = 'islandmilfcode:tavern-backup:request:v1';
const LEGACY_RESPONSE_EVENT = 'islandmilfcode:tavern-backup:response:v1';

export type TavernBackupIndexEntry = {
  saveId: string;
  runId: string;
  playerName: string;
  label: string;
  updatedAt: number;
  backedUpAt: string;
  storage?: 'archive-v3' | 'bundle-v2' | 'legacy-v1';
  storagePath?: string;
  bundleFile?: string;
  imageFolders?: string[];
  stateFile?: string;
  messagesFile?: string;
  assetsFile?: string;
};

type TavernBackupAction =
  | 'probe'
  | 'list'
  | 'write'
  | 'load'
  | 'v3-put-object'
  | 'v3-get-object'
  | 'v3-put-image'
  | 'v3-get-image'
  | 'v3-commit-root'
  | 'v3-delete-save'
  | 'v3-read-root'
  | 'v3-read-registry';

type TavernBackupResponse<T = unknown> = {
  protocolVersion: number;
  requestId: string;
  action: TavernBackupAction;
  backend: 'tavern-file';
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
};

type TavernEventSubscription = { stop?: () => void } | undefined;
type TavernEventApi = {
  eventEmit?: (eventType: string, ...args: unknown[]) => Promise<void> | void;
  eventOn?: (eventType: string, listener: (...args: unknown[]) => void) => TavernEventSubscription;
};

const READ_REQUEST_TIMEOUT_MS = 8_000;
const WRITE_REQUEST_TIMEOUT_MS = 300_000;
const RETRY_DELAY_MS = 60_000;
const ARCHIVE_DELETE_BROADCAST_CHANNEL = 'islandmilfcode:archive-delete:v3';
const ARCHIVE_DELETE_BROADCAST_TYPE = 'deleted-save';
const browserBackend = new BrowserArchiveBackend();

let capability: ArchiveLocalCapability = {
  mode: 'unknown',
  protocolVersion: null,
  persistent: false,
  storagePath: '',
};
let probePromise: Promise<ArchiveLocalCapability> | null = null;
let uninstallArchiveListener: (() => void) | null = null;
let syncTail: Promise<void> = Promise.resolve();
const retryTimers = new Map<string, number>();
const repeatedBackgroundFailures = new Map<string, { signature: string; suppressed: number }>();
const syncEpochBySaveId = new Map<string, number>();
let archiveDeleteBroadcastChannel: BroadcastChannel | null | undefined;

type ArchiveBridgeWriteResult = {
  outcome?: 'uploaded' | 'reused';
  uploaded?: boolean;
  reused?: boolean;
  jsonUploads?: number;
  imageUploads?: number;
  fileUploads?: number;
  storagePath?: string;
};

type ArchiveObjectWriteResult = ArchiveBridgeWriteResult & {
  kind?: unknown;
  hash?: unknown;
};

type ArchiveImageWriteResult = ArchiveBridgeWriteResult & {
  assetId?: unknown;
};

type ArchiveRootCommitResult = {
  entry?: { saveId?: unknown; revision?: unknown; rootHash?: unknown } | null;
  ignored?: boolean;
  reason?: string;
  rootWrite?: ArchiveObjectWriteResult;
  registryWrite?: ArchiveBridgeWriteResult;
  gc?: TavernArchiveGcSummary;
  storagePath?: string;
};

export type TavernArchiveGcSummary = {
  status?: string;
  deleted?: number;
  missing?: number;
  retainedShared?: number;
  failed?: number;
  blocker?: string;
  error?: string;
  [key: string]: unknown;
};

export type TavernArchiveDeleteResult = {
  saveId?: string;
  deleted?: boolean;
  alreadyMissing?: boolean;
  tombstoneId?: string | null;
  gc?: TavernArchiveGcSummary;
};

type ArchiveSyncCounter = {
  attempted: number;
  uploaded: number;
  reused: number;
  jsonUploads: number;
  imageUploads: number;
};

type ArchiveSyncStats = {
  saveId: string;
  revision: number;
  mode: 'full' | 'incremental';
  stage: 'probe' | 'objects' | 'images' | 'commit' | 'metadata' | 'complete';
  objects: ArchiveSyncCounter;
  images: ArchiveSyncCounter;
  root: ArchiveSyncCounter;
  registry: ArchiveSyncCounter;
  expectedImages: number;
  missingImages: number;
  gc?: TavernArchiveGcSummary;
  startedAt: number;
};

class ArchiveRevisionConflictError extends Error {
  constructor(
    readonly browserRevision: number,
    readonly localRevision: number | null,
  ) {
    const localLabel = localRevision === null ? '未知' : String(localRevision);
    super(
      `本机存档 revision ${localLabel} 已高于当前浏览器 revision ${browserRevision}，`
      + '已拒绝用旧版本覆盖本机存档。请先恢复本机较新版本，或另存为新存档后再备份。',
    );
    this.name = 'ArchiveRevisionConflictError';
  }
}

class ArchiveDeletedSaveError extends Error {
  constructor(readonly saveId: string) {
    super(`本机存档 ${saveId} 已被删除，停止旧版本备份重试`);
    this.name = 'ArchiveDeletedSaveError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createSyncCounter(): ArchiveSyncCounter {
  return { attempted: 0, uploaded: 0, reused: 0, jsonUploads: 0, imageUploads: 0 };
}

function createSyncStats(event: ArchiveCommitEvent): ArchiveSyncStats {
  return {
    saveId: event.meta.saveId,
    revision: event.receipt.revision,
    mode: 'incremental',
    stage: 'probe',
    objects: createSyncCounter(),
    images: createSyncCounter(),
    root: createSyncCounter(),
    registry: createSyncCounter(),
    expectedImages: 0,
    missingImages: 0,
    gc: undefined,
    startedAt: Date.now(),
  };
}

function recordWriteOutcome(
  counter: ArchiveSyncCounter,
  result: ArchiveBridgeWriteResult | null | undefined,
  fallback: 'uploaded' | 'reused' = 'uploaded',
  fallbackUploads: { json: number; image: number } = { json: 1, image: 0 },
) {
  const reused = result?.outcome === 'reused' || result?.reused === true;
  const uploaded = result?.outcome === 'uploaded' || result?.uploaded === true;
  if (reused) counter.reused += 1;
  else if (uploaded || fallback === 'uploaded') {
    counter.uploaded += 1;
    const jsonUploads = Number(result?.jsonUploads);
    const imageUploads = Number(result?.imageUploads);
    counter.jsonUploads += Number.isFinite(jsonUploads) && jsonUploads >= 0
      ? jsonUploads
      : fallbackUploads.json;
    counter.imageUploads += Number.isFinite(imageUploads) && imageUploads >= 0
      ? imageUploads
      : fallbackUploads.image;
  } else {
    counter.reused += 1;
  }
}

function publicSyncStats(stats: ArchiveSyncStats) {
  const counters = [stats.objects, stats.images, stats.root, stats.registry];
  return {
    saveId: stats.saveId,
    revision: stats.revision,
    mode: stats.mode,
    stage: stats.stage,
    uploaded: counters.reduce((sum, counter) => sum + counter.uploaded, 0),
    reused: counters.reduce((sum, counter) => sum + counter.reused, 0),
    attempted: counters.reduce((sum, counter) => sum + counter.attempted, 0),
    jsonUploads: counters.reduce((sum, counter) => sum + counter.jsonUploads, 0),
    imageUploads: counters.reduce((sum, counter) => sum + counter.imageUploads, 0),
    fileUploads: counters.reduce((sum, counter) => sum + counter.jsonUploads + counter.imageUploads, 0),
    expectedImages: stats.expectedImages,
    missingImages: stats.missingImages,
    degraded: stats.missingImages > 0,
    gc: stats.gc,
    objects: stats.objects,
    images: stats.images,
    root: stats.root,
    registry: stats.registry,
    durationMs: Math.max(0, Date.now() - stats.startedAt),
    archiveLayout: capability.archiveLayout ?? 'unknown',
  };
}

function assertObjectWriteAck(
  result: ArchiveObjectWriteResult,
  expectedKind: string,
  expectedHash: string,
) {
  if (!isRecord(result) || result.kind !== expectedKind || result.hash !== expectedHash) {
    throw new Error(`本机存档桥 object 回执不匹配：${expectedKind}/${expectedHash}`);
  }
}

function assertImageWriteAck(result: ArchiveImageWriteResult, expectedAssetId: string) {
  if (!isRecord(result) || result.assetId !== expectedAssetId) {
    throw new Error(`本机存档桥 image 回执不匹配：${expectedAssetId}`);
  }
}

function isFloorIndexEntry(value: unknown): value is ArchiveFloorIndexEntry {
  return (
    isRecord(value) &&
    typeof value.chunkHash === 'string' &&
    typeof value.chunkNo === 'number' && Number.isFinite(value.chunkNo) &&
    typeof value.startFloor === 'number' && Number.isFinite(value.startFloor) &&
    typeof value.endFloorExclusive === 'number' && Number.isFinite(value.endFloorExclusive)
  );
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
  return `islandmilfcode-backup-${random}`;
}

function requestBridge<T>(
  action: TavernBackupAction,
  fields: Record<string, unknown> = {},
  protocolVersion = TAVERN_BACKUP_PROTOCOL_VERSION,
): Promise<T> {
  const api = getEventApi();
  if (typeof api.eventEmit !== 'function' || typeof api.eventOn !== 'function') {
    return Promise.reject(new Error('Tavern event API unavailable'));
  }
  const requestEvent = protocolVersion === 1 ? LEGACY_REQUEST_EVENT : TAVERN_BACKUP_REQUEST_EVENT;
  const responseEvent = protocolVersion === 1 ? LEGACY_RESPONSE_EVENT : TAVERN_BACKUP_RESPONSE_EVENT;
  const requestId = createRequestId();
  const timeoutMs = action === 'probe'
    || action === 'write'
    || action.startsWith('v3-put')
    || action === 'v3-commit-root'
    || action === 'v3-delete-save'
    ? WRITE_REQUEST_TIMEOUT_MS
    : READ_REQUEST_TIMEOUT_MS;

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
    }, timeoutMs);
    subscription = api.eventOn?.(responseEvent, (...args: unknown[]) => {
      const response = args[0] as TavernBackupResponse<T> | null | undefined;
      if (
        !response ||
        response.protocolVersion !== protocolVersion ||
        response.requestId !== requestId ||
        response.action !== action
      ) return;
      cleanup();
      if (response.ok) resolve(response.result as T);
      else reject(new Error(response.error?.message || `Tavern bridge rejected ${action}`));
    });
    Promise.resolve(api.eventEmit(requestEvent, { protocolVersion, requestId, action, ...fields })).catch(error => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function getTavernArchiveCapability(): ArchiveLocalCapability {
  return { ...capability };
}

export function isTavernFileBackupAvailable(): boolean {
  return capability.mode === 'local-v3' || capability.mode === 'local-v1' || capability.mode === 'backend-unsupported';
}

export function probeTavernArchiveCapability(options: { force?: boolean } = {}): Promise<ArchiveLocalCapability> {
  // The probe uses one fixed file name. Reuse an in-flight probe even for a
  // forced refresh so two nonces cannot overwrite each other and report a
  // false bridge failure.
  if (probePromise) return probePromise;
  if (
    !options.force
    && (capability.mode === 'local-v3' || capability.mode === 'local-v1' || capability.mode === 'backend-unsupported')
  ) {
    return Promise.resolve(getTavernArchiveCapability());
  }
  const api = getEventApi();
  if (typeof api.eventEmit !== 'function' || typeof api.eventOn !== 'function') {
    capability = { mode: 'no-event-api', protocolVersion: null, persistent: false, storagePath: '', reason: 'event API unavailable' };
    return Promise.resolve(getTavernArchiveCapability());
  }
  capability = { ...capability, mode: 'probing' };
  probePromise = (async () => {
    try {
      const result = await requestBridge<{
        persistent?: boolean;
        storagePath?: string;
        archiveFormatVersion?: number;
        archiveLayout?: 'subdir-v1' | 'flat-v3';
      }>('probe');
      capability = {
        mode: result.archiveFormatVersion === 3 ? 'local-v3' : 'backend-unsupported',
        protocolVersion: 2,
        // An older protocol-v2 bridge can still list/read/write its aggregate
        // backups even though it cannot accept v3 archive objects.
        persistent: Boolean(result.persistent),
        storagePath: String(result.storagePath || ''),
        ...(result.archiveLayout ? { archiveLayout: result.archiveLayout } : {}),
        ...(result.archiveFormatVersion === 3 ? {} : { reason: 'bridge has no archive v3 capability' }),
      };
      return getTavernArchiveCapability();
    } catch (v2Error) {
      try {
        const legacy = await requestBridge<{ persistent?: boolean; storagePath?: string }>('probe', {}, 1);
        capability = {
          mode: 'local-v1',
          protocolVersion: 1,
          persistent: Boolean(legacy.persistent),
          storagePath: String(legacy.storagePath || ''),
          reason: 'legacy whole-backup bridge; archive sync remains browser-primary',
        };
      } catch (legacyError) {
        capability = {
          mode: 'no-responder',
          protocolVersion: null,
          persistent: false,
          storagePath: '',
          reason: legacyError instanceof Error ? legacyError.message : String(v2Error),
        };
      }
      return getTavernArchiveCapability();
    }
  })().finally(() => {
    probePromise = null;
  });
  return probePromise;
}

export async function probeTavernFileBackup(): Promise<{ persistent: boolean; storagePath: string; saveCount: number }> {
  const next = await probeTavernArchiveCapability({ force: true });
  if (next.mode !== 'local-v3' && next.mode !== 'local-v1' && next.mode !== 'backend-unsupported') {
    throw new Error(next.reason || 'Tavern bridge unavailable');
  }
  return { persistent: next.persistent, storagePath: next.storagePath, saveCount: 0 };
}

async function requestLegacy<T>(action: 'list' | 'write' | 'load', fields: Record<string, unknown> = {}) {
  if (capability.mode === 'unknown' || capability.mode === 'probing') await probeTavernArchiveCapability();
  const protocol = capability.mode === 'local-v1' ? 1 : 2;
  return requestBridge<T>(action, fields, protocol);
}

function registryEntriesToPublic(registry: unknown): TavernBackupIndexEntry[] {
  if (!registry || typeof registry !== 'object') return [];
  const entries = (registry as { entries?: unknown }).entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
  return Object.values(entries as Record<string, Record<string, unknown>>)
    .filter(entry => entry && typeof entry.saveId === 'string')
    .map(entry => {
      const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta as Record<string, unknown> : {};
      const profile = meta.playerProfile && typeof meta.playerProfile === 'object'
        ? meta.playerProfile as Record<string, unknown>
        : {};
      return {
        saveId: String(entry.saveId),
        runId: String(entry.runId || meta.runId || ''),
        playerName: String(profile.name || meta.characterName || '未命名主角'),
        label: String(meta.label || 'v3 存档'),
        updatedAt: Number(meta.updatedAt || entry.updatedAt) || 0,
        backedUpAt: new Date(Number(entry.updatedAt) || Date.now()).toISOString(),
        storage: 'archive-v3' as const,
        storagePath: 'user/files/islandmilfcode-archive-registry-v3.json',
      };
    });
}

export async function listTavernFileBackups(): Promise<TavernBackupIndexEntry[]> {
  const next = await probeTavernArchiveCapability();
  const results = await Promise.allSettled([
    next.mode === 'local-v3'
      ? requestBridge<{ registry: unknown }>('v3-read-registry')
      : Promise.resolve({ registry: null }),
    next.mode === 'local-v3' || next.mode === 'local-v1' || next.mode === 'backend-unsupported'
      ? requestLegacy<{ entries: TavernBackupIndexEntry[] }>('list')
      : Promise.resolve({ entries: [] }),
  ]);
  const merged = new Map<string, TavernBackupIndexEntry>();
  if (results[1].status === 'fulfilled') {
    const entries = Array.isArray(results[1].value.entries) ? results[1].value.entries : [];
    entries
      .filter(entry => entry && typeof entry.saveId === 'string')
      .forEach(entry => merged.set(`${entry.storage ?? 'legacy'}\u0000${entry.saveId}`, entry));
  }
  if (results[0].status === 'fulfilled') {
    registryEntriesToPublic(results[0].value.registry)
      .forEach(entry => merged.set(`${entry.storage ?? 'archive-v3'}\u0000${entry.saveId}`, entry));
  }
  const entries = [...merged.values()];
  const candidateCountBySaveId = new Map<string, number>();
  entries.forEach(entry => candidateCountBySaveId.set(entry.saveId, (candidateCountBySaveId.get(entry.saveId) ?? 0) + 1));
  const storageLabels: Record<NonNullable<TavernBackupIndexEntry['storage']>, string> = {
    'archive-v3': 'v3 归档',
    'bundle-v2': 'v2 备份',
    'legacy-v1': 'v1 备份',
  };
  return entries
    .map(entry => candidateCountBySaveId.get(entry.saveId) === 1
      ? entry
      : { ...entry, label: `${entry.label}（${entry.storage ? storageLabels[entry.storage] : '旧备份'}）` })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function writeTavernFileBackup(backup: SingleSaveBackupPayload): Promise<TavernBackupIndexEntry> {
  const result = await requestLegacy<{ entry: TavernBackupIndexEntry }>('write', { backup });
  if (!result.entry?.saveId) throw new Error('Tavern bridge returned no backup entry');
  return result.entry;
}

export async function readTavernFileBackup(
  saveId: string,
  preferredStorage?: 'bundle-v2' | 'legacy-v1',
): Promise<SingleSaveBackupPayload> {
  const result = await requestLegacy<{ backup?: unknown }>('load', { saveId, preferredStorage });
  const backup = result.backup;
  if (
    !isRecord(backup) ||
    backup.kind !== 'single-save' ||
    !isRecord(backup.meta) ||
    !isRecord(backup.payload) ||
    !Array.isArray(backup.payload.chatLog)
  ) {
    throw new Error('Tavern bridge returned no valid legacy backup');
  }
  return backup as unknown as SingleSaveBackupPayload;
}

async function collectFullReferences(root: ArchiveRoot): Promise<ArchiveObjectReference[]> {
  const result: ArchiveObjectReference[] = [{ kind: 'state', hash: root.stateHash, byteLength: 0 }];
  if (root.summaryHash) result.push({ kind: 'summary', hash: root.summaryHash, byteLength: 0 });
  if (root.memoryHash) result.push({ kind: 'memory', hash: root.memoryHash, byteLength: 0 });
  if (root.compatibilityHash) result.push({ kind: 'compatibility', hash: root.compatibilityHash, byteLength: 0 });
  for (const pageHash of Object.values(root.floorIndexPageHashes)) {
    result.push({ kind: 'floor-index', hash: pageHash, byteLength: 0 });
    const page = await browserBackend.getObject<ArchiveFloorIndexPage>('floor-index', pageHash);
    page?.entries.forEach(entry => result.push({ kind: 'floor-chunk', hash: entry.chunkHash, byteLength: 0 }));
  }
  return result;
}

function collectImageIdsFromObject(value: unknown, ids: Set<string>) {
  if (!value || typeof value !== 'object') return;
  const chunk = value as Partial<ArchiveFloorChunk>;
  if (!Array.isArray(chunk.floors)) return;
  chunk.floors.forEach(floor => floor.imageAssetIds?.forEach(id => ids.add(id)));
}

async function syncArchiveEvent(
  event: ArchiveCommitEvent,
  stats: ArchiveSyncStats,
  forceFull = false,
  expectedEpoch = getArchiveSyncEpoch(event.meta.saveId),
) {
  const assertStillActive = () => {
    if (getArchiveSyncEpoch(event.meta.saveId) !== expectedEpoch) {
      throw new ArchiveDeletedSaveError(event.meta.saveId);
    }
  };
  assertStillActive();
  stats.mode = forceFull ? 'full' : 'incremental';
  stats.stage = 'probe';
  const next = await probeTavernArchiveCapability();
  assertStillActive();
  if (next.mode !== 'local-v3') throw new Error(next.reason || 'local v3 bridge unavailable');
  const currentMeta = getArchiveMetaSync(event.meta.saveId);
  const localBackedUpRevision = Number(currentMeta?.localBackedUpRevision ?? event.meta.localBackedUpRevision);
  const full = forceFull
    || !Number.isFinite(localBackedUpRevision)
    || localBackedUpRevision <= 0
    || localBackedUpRevision < event.receipt.revision - 1;
  stats.mode = full ? 'full' : 'incremental';
  const references = full ? await collectFullReferences(event.root) : event.journal.objects;
  const unique = new Map(references.map(reference => [`${reference.kind}\u0000${reference.hash}`, reference]));
  const imageIds = new Set<string>();
  stats.stage = 'objects';
  for (const reference of unique.values()) {
    const value = await browserBackend.getObject(
      reference.kind as Exclude<ArchiveObjectKind, 'root'>,
      reference.hash,
    );
    if (value === null) throw new Error(`browser archive object missing: ${reference.kind}/${reference.hash}`);
    collectImageIdsFromObject(value, imageIds);
    stats.objects.attempted += 1;
    const result = await requestBridge<ArchiveObjectWriteResult>('v3-put-object', {
      object: { kind: reference.kind, hash: reference.hash, value },
    });
    assertStillActive();
    assertObjectWriteAck(result, reference.kind, reference.hash);
    recordWriteOutcome(stats.objects, result);
  }
  if (full) {
    (await readImageAssetReferences(`save:${event.meta.saveId}`)).forEach(id => imageIds.add(id));
  }
  if (event.meta.playerProfile.avatarAssetId) imageIds.add(event.meta.playerProfile.avatarAssetId);
  const assets = await exportImageAssetsForIds(imageIds);
  const exportedImageIds = new Set(assets.map(asset => asset.id));
  stats.expectedImages = imageIds.size;
  stats.missingImages = [...imageIds].filter(id => !exportedImageIds.has(id)).length;
  stats.stage = 'images';
  for (const asset of assets) {
    stats.images.attempted += 1;
    const result = await requestBridge<ArchiveImageWriteResult>('v3-put-image', { asset });
    assertStillActive();
    assertImageWriteAck(result, asset.id);
    recordWriteOutcome(stats.images, result, 'uploaded', { json: 1, image: 1 });
  }
  stats.stage = 'commit';
  assertStillActive();
  stats.root.attempted += 1;
  stats.registry.attempted += 1;
  const commitResult = await requestBridge<ArchiveRootCommitResult>('v3-commit-root', {
    saveId: event.meta.saveId,
    rootHash: event.receipt.rootHash,
    root: event.root,
    meta: event.meta,
  });
  stats.gc = commitResult?.gc;
  if (commitResult?.ignored && commitResult.reason === 'older-revision') {
    const rawLocalRevision = Number(commitResult.entry?.revision);
    throw new ArchiveRevisionConflictError(
      event.receipt.revision,
      Number.isFinite(rawLocalRevision) ? rawLocalRevision : null,
    );
  }
  if (commitResult?.ignored && commitResult.reason === 'deleted-save') {
    throw new ArchiveDeletedSaveError(event.meta.saveId);
  }
  if (commitResult?.ignored && commitResult.reason !== 'already-committed') {
    throw new Error(`本机存档桥拒绝提交 root：${commitResult.reason || 'unknown-reason'}`);
  }
  const committedEntry = commitResult?.entry;
  if (
    !committedEntry ||
    committedEntry.rootHash !== event.receipt.rootHash ||
    Number(committedEntry.revision) !== event.receipt.revision ||
    (committedEntry.saveId !== undefined && committedEntry.saveId !== event.meta.saveId)
  ) {
    throw new Error(`本机存档桥 root 提交回执不匹配：${event.meta.saveId}/${event.receipt.revision}`);
  }
  if (commitResult.rootWrite) {
    assertObjectWriteAck(commitResult.rootWrite, 'root', event.receipt.rootHash);
  }
  recordWriteOutcome(
    stats.root,
    commitResult.rootWrite,
    'uploaded',
  );
  recordWriteOutcome(
    stats.registry,
    commitResult.registryWrite,
    commitResult.ignored && commitResult.reason === 'already-committed' ? 'reused' : 'uploaded',
  );
  stats.stage = 'metadata';
  await markArchiveLocalBackupResult({
    saveId: event.meta.saveId,
    revision: event.receipt.revision,
    success: true,
    mode: 'local-v3',
  });
  const retryTimer = retryTimers.get(event.meta.saveId);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimers.delete(event.meta.saveId);
  stats.stage = 'complete';
}

function getArchiveSyncEpoch(saveId: string) {
  return syncEpochBySaveId.get(saveId) ?? 0;
}

function advanceArchiveSyncEpoch(saveId: string) {
  const next = getArchiveSyncEpoch(saveId) + 1;
  syncEpochBySaveId.set(saveId, next);
  return next;
}

function scheduleRetry(event: ArchiveCommitEvent, expectedEpoch = getArchiveSyncEpoch(event.meta.saveId)) {
  if (getArchiveSyncEpoch(event.meta.saveId) !== expectedEpoch) return;
  const old = retryTimers.get(event.meta.saveId);
  if (old) clearTimeout(old);
  const timer = window.setTimeout(() => {
    retryTimers.delete(event.meta.saveId);
    if (getArchiveSyncEpoch(event.meta.saveId) !== expectedEpoch) return;
    const latest = getArchiveMetaSync(event.meta.saveId);
    if (
      Number(latest?.localBackedUpRevision) >= event.receipt.revision ||
      Number(latest?.browserRevision) > event.receipt.revision
    ) return;
    enqueueArchiveSync(event, false, 'background', expectedEpoch);
  }, RETRY_DELAY_MS);
  retryTimers.set(event.meta.saveId, timer);
}

function clearScheduledRetry(saveId: string) {
  const timer = retryTimers.get(saveId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(saveId);
}

function getArchiveDeleteBroadcastChannel() {
  if (archiveDeleteBroadcastChannel !== undefined) return archiveDeleteBroadcastChannel;
  if (typeof BroadcastChannel !== 'function') {
    archiveDeleteBroadcastChannel = null;
    return archiveDeleteBroadcastChannel;
  }
  try {
    const channel = new BroadcastChannel(ARCHIVE_DELETE_BROADCAST_CHANNEL);
    channel.addEventListener('message', event => {
      const message = event.data;
      if (
        !isRecord(message) ||
        message.type !== ARCHIVE_DELETE_BROADCAST_TYPE ||
        typeof message.saveId !== 'string' ||
        !message.saveId.trim()
      ) return;
      const saveId = message.saveId.trim();
      advanceArchiveSyncEpoch(saveId);
      clearScheduledRetry(saveId);
      repeatedBackgroundFailures.delete(saveId);
    });
    archiveDeleteBroadcastChannel = channel;
  } catch {
    archiveDeleteBroadcastChannel = null;
  }
  return archiveDeleteBroadcastChannel;
}

function broadcastArchiveSaveDeleted(saveId: string) {
  try {
    getArchiveDeleteBroadcastChannel()?.postMessage({
      type: ARCHIVE_DELETE_BROADCAST_TYPE,
      saveId,
    });
  } catch {
    // BroadcastChannel is an optional cross-tab guard. The local epoch remains authoritative here.
  }
}

function enqueueArchiveSync(
  event: ArchiveCommitEvent,
  forceFull = false,
  source: 'background' | 'manual' = 'background',
  expectedEpoch = getArchiveSyncEpoch(event.meta.saveId),
) {
  const stats = createSyncStats(event);
  syncTail = syncTail.catch(() => undefined).then(async () => {
    if (getArchiveSyncEpoch(event.meta.saveId) !== expectedEpoch) return;
    stats.startedAt = Date.now();
    try {
      await syncArchiveEvent(event, stats, forceFull, expectedEpoch);
      if (getArchiveSyncEpoch(event.meta.saveId) !== expectedEpoch) return;
      const previousFailure = repeatedBackgroundFailures.get(event.meta.saveId);
      repeatedBackgroundFailures.delete(event.meta.saveId);
      console.info('[archive-bridge] 备份成功', {
        ...publicSyncStats(stats),
        suppressedFailures: previousFailure ? previousFailure.suppressed : 0,
      });
    } catch (error) {
      if (getArchiveSyncEpoch(event.meta.saveId) !== expectedEpoch) return;
      const revisionConflict = error instanceof ArchiveRevisionConflictError;
      const deletedSave = error instanceof ArchiveDeletedSaveError;
      const nonRetryable = revisionConflict || deletedSave;
      capability = {
        ...capability,
        mode: nonRetryable
          ? 'local-v3'
          : capability.mode === 'no-event-api' ? 'no-event-api' : 'temporarily-failed',
        reason: error instanceof Error ? error.message : String(error),
      };
      await markArchiveLocalBackupResult({
        saveId: event.meta.saveId,
        revision: event.receipt.revision,
        success: false,
        mode: capability.mode,
        error: capability.reason,
        retryable: !nonRetryable,
      }).catch(() => undefined);
      if (nonRetryable) {
        clearScheduledRetry(event.meta.saveId);
        repeatedBackgroundFailures.delete(event.meta.saveId);
      } else if (source === 'background') {
        scheduleRetry(event, expectedEpoch);
      }
      const failureSignature = `${stats.stage}\u0000${capability.reason || ''}`;
      const previousFailure = repeatedBackgroundFailures.get(event.meta.saveId);
      const repeated = source === 'background' && previousFailure?.signature === failureSignature;
      if (repeated && previousFailure) {
        previousFailure.suppressed += 1;
      } else {
        if (source === 'background' && !nonRetryable) {
          repeatedBackgroundFailures.set(event.meta.saveId, { signature: failureSignature, suppressed: 0 });
        }
        console.warn('[archive-bridge] 备份失败', {
          ...publicSyncStats(stats),
          retry: !nonRetryable && source === 'background',
          error: capability.reason,
        });
      }
      throw error;
    }
  });
  void syncTail.catch(() => undefined);
  return syncTail;
}

export function installArchiveBridgeSync() {
  uninstallArchiveListener?.();
  uninstallArchiveListener = subscribeArchiveCommits(event => enqueueArchiveSync(event).catch(() => undefined));
  getArchiveDeleteBroadcastChannel();
  void probeTavernArchiveCapability();
  return () => {
    uninstallArchiveListener?.();
    uninstallArchiveListener = null;
  };
}

export async function deleteTavernArchiveSave(saveIdValue: string): Promise<TavernArchiveDeleteResult> {
  const saveId = String(saveIdValue || '').trim();
  if (!saveId) throw new Error('Deleting a local v3 archive requires a saveId');

  // Invalidate queued syncs and delayed retries before this deletion is appended
  // to the same queue, then notify other tabs before they can publish stale work.
  advanceArchiveSyncEpoch(saveId);
  clearScheduledRetry(saveId);
  repeatedBackgroundFailures.delete(saveId);
  broadcastArchiveSaveDeleted(saveId);

  const deletion = syncTail
    .catch(() => undefined)
    .then(async () => {
      const current = capability.mode === 'local-v3'
        ? getTavernArchiveCapability()
        : await probeTavernArchiveCapability({ force: true });
      if (current.mode !== 'local-v3') {
        throw new Error(current.reason || `Local v3 bridge unavailable (${current.mode})`);
      }
      return requestBridge<TavernArchiveDeleteResult>('v3-delete-save', { saveId });
    });
  syncTail = deletion.then(
    () => undefined,
    () => undefined,
  );
  return deletion;
}

export async function persistArchiveSaveToTavernFiles(saveId: string): Promise<TavernBackupIndexEntry> {
  const expectedEpoch = getArchiveSyncEpoch(saveId);
  const currentCapability = await probeTavernArchiveCapability();
  if (currentCapability.mode !== 'local-v3') {
    throw new Error(currentCapability.reason || 'Local v3 bridge unavailable');
  }
  const pointer = await browserBackend.getRoot(saveId);
  if (!pointer) throw new Error('Browser v3 archive root not found');
  const metaResult = await requestBridge<{ registry: { entries?: Record<string, { meta?: ArchiveSaveMeta }> } }>('v3-read-registry')
    .catch(() => null);
  const localMeta = metaResult?.registry?.entries?.[saveId]?.meta;
  const state = await browserBackend.getObject<ArchiveStateBlock>('state', pointer.root.stateHash);
  if (!state) throw new Error('Browser v3 state block not found');
  const meta: ArchiveSaveMeta = getArchiveMetaSync(saveId) ?? localMeta ?? ({
    saveId,
    runId: pointer.root.runId,
    kind: 'manual',
    label: 'v3 save',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageIndex: pointer.root.currentFloor,
    playerProfile: (state.gameState.runtimeFlags?.playerProfile ?? {}) as ArchiveSaveMeta['playerProfile'],
    activeTarget: null,
    messageCount: pointer.root.messageCount,
    version: 3,
    schemaVersion: 3,
    browserRevision: pointer.root.revision,
    localBackedUpRevision: 0,
    archiveBackendMode: 'browser-primary',
    rootHash: pointer.rootHash,
    floorCount: pointer.root.floorCount,
    currentFloorIndex: pointer.root.currentFloor,
    health: 'ok',
  } as ArchiveSaveMeta);
  const now = Date.now();
  const event: ArchiveCommitEvent = {
    receipt: { saveId, revision: pointer.root.revision, rootHash: pointer.rootHash, floorCount: pointer.root.floorCount, committed: true },
    root: pointer.root,
    meta,
    journal: {
      id: `${saveId}:${pointer.root.revision}`,
      saveId,
      revision: pointer.root.revision,
      rootHash: pointer.rootHash,
      objects: [],
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    },
  };
  await enqueueArchiveSync(event, true, 'manual', expectedEpoch);
  if (getArchiveSyncEpoch(saveId) !== expectedEpoch) {
    throw new Error('Local archive backup was cancelled because the save was deleted');
  }
  return {
    saveId,
    runId: pointer.root.runId,
    playerName: meta.playerProfile.name || '未命名主角',
    label: meta.label,
    updatedAt: meta.updatedAt,
    backedUpAt: new Date().toISOString(),
    storage: 'archive-v3',
    storagePath: getTavernArchiveCapability().storagePath,
    imageFolders: ['user/images/islandmilfcode-v3-images'],
  };
}

export async function readTavernArchiveBackup(saveId: string): Promise<(PortableArchiveBackup & {
  imageAssets?: ImageAssetBackupRecord[];
  degradedRecovery?: { reason: string; requestedRootHash: string; resolvedRootHash: string };
}) | null> {
  const result = await requestBridge<{
    entry: { meta?: unknown } | null;
    root: ArchiveRoot | null;
    degraded?: boolean;
    reason?: string;
    requestedRootHash?: string;
    resolvedRootHash?: string | null;
  }>('v3-read-root', { saveId });
  const resultEntry = result.entry;
  if (!isRecord(result.root) || !resultEntry || !isRecord(resultEntry.meta)) return null;
  if (
    Number(result.root.formatVersion) > 3 ||
    Number(result.root.schemaVersion) > 3 ||
    Number(resultEntry.meta.formatVersion) > 3 ||
    Number(resultEntry.meta.schemaVersion) > 3
  ) {
    throw new Error('本机存档的 root 或 meta 由更新的归档版本创建；当前版本只读保留，不会恢复或覆盖它');
  }
  if (
    typeof result.root.stateHash !== 'string' ||
    !isRecord(result.root.floorIndexPageHashes) ||
    typeof result.root.floorCount !== 'number' ||
    !Number.isFinite(result.root.floorCount)
  ) {
    throw new Error('Local v3 archive root shape is invalid');
  }
  const root = result.root as ArchiveRoot;
  const sourceMeta = resultEntry.meta as ArchiveSaveMeta;
  const requestedRootHash = String(result.requestedRootHash || sourceMeta.rootHash || '');
  const resolvedRootHash = String(result.resolvedRootHash || sourceMeta.rootHash || '');
  let meta: ArchiveSaveMeta = result.degraded
    ? {
        ...sourceMeta,
        browserRevision: root.revision,
        rootHash: resolvedRootHash,
        floorCount: root.floorCount,
        currentFloorIndex: root.currentFloor,
        health: 'degraded',
        migrationWarnings: [
          ...(Array.isArray(sourceMeta.migrationWarnings) ? sourceMeta.migrationWarnings : []),
          '本机当前 root 不可读，已回退到上一个可玩版本',
        ],
      }
    : sourceMeta;
  if (result.degraded) {
    console.warn('[archive-bridge] current local root unreadable; restored previous root', {
      saveId,
      requestedRootHash,
      resolvedRootHash,
    });
  }
  const getObject = async <T>(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string | undefined) => {
    if (!hash) return null;
    const response = await requestBridge<{ value?: T } | null>('v3-get-object', { kind, hash });
    return response?.value ?? null;
  };
  const stateValue = await getObject<unknown>('state', root.stateHash);
  if (!isRecord(stateValue) || !isRecord(stateValue.gameState)) {
    throw new Error('Local v3 archive has no valid core state block');
  }
  const state = stateValue as ArchiveStateBlock;
  const [summaryValue, memoryValue] = await Promise.all([
    getObject<ArchiveSummaryBlock>('summary', root.summaryHash).catch(() => null),
    getObject<ArchiveMemoryBlock>('memory', root.memoryHash).catch(() => null),
  ]);
  const summary = isRecord(summaryValue) && isRecord(summaryValue.summaryStore)
    ? summaryValue as ArchiveSummaryBlock
    : null;
  const memory = isRecord(memoryValue) && isRecord(memoryValue.memoryDB)
    ? memoryValue as ArchiveMemoryBlock
    : null;
  const compatibilityValue = await getObject<ArchiveCompatibilityBlock>('compatibility', root.compatibilityHash).catch(() => null);
  const compatibility = isRecord(compatibilityValue) &&
    Array.isArray(compatibilityValue.excludedRuntimeFlagKeys) &&
    (!('messageSnapshots' in compatibilityValue) || Array.isArray(compatibilityValue.messageSnapshots)) &&
    (!('migrationIssues' in compatibilityValue) || Array.isArray(compatibilityValue.migrationIssues))
    ? compatibilityValue as ArchiveCompatibilityBlock
    : null;
  const pageHashes = Object.values(root.floorIndexPageHashes)
    .filter((hash): hash is string => typeof hash === 'string' && Boolean(hash));
  const pageResults = await Promise.allSettled(
    pageHashes.map(hash => getObject<ArchiveFloorIndexPage>('floor-index', hash)),
  );
  const entries = pageResults
    .filter((item): item is PromiseFulfilledResult<ArchiveFloorIndexPage | null> => item.status === 'fulfilled')
    .flatMap(item => Array.isArray(item.value?.entries) ? item.value.entries.filter(isFloorIndexEntry) : [])
    .sort((a, b) => a.chunkNo - b.chunkNo);
  const chunkResults = await Promise.allSettled(entries.map(entry => getObject<ArchiveFloorChunk>('floor-chunk', entry.chunkHash)));
  const floors: FloorRecord[] = chunkResults
    .filter((item): item is PromiseFulfilledResult<ArchiveFloorChunk | null> => item.status === 'fulfilled')
    .flatMap(item => Array.isArray(item.value?.floors)
      ? item.value.floors
        .filter(floor => isRecord(floor) && typeof floor.floorIndex === 'number' && Number.isFinite(floor.floorIndex))
        .map(floor => ({ ...floor, saveId }) as FloorRecord)
      : [])
    .sort((a, b) => a.floorIndex - b.floorIndex);
  const timelineIncomplete = floors.length !== root.floorCount
    || floors.some((floor, index) => floor.floorIndex !== index);
  if (timelineIncomplete) {
    meta = {
      ...meta,
      health: 'degraded',
      migrationWarnings: [
        ...(meta.migrationWarnings ?? []),
        `本机楼层只恢复 ${floors.length}/${root.floorCount} 层，已按可读内容降级导入`,
      ],
    };
  }
  const assetIds = new Set(floors.flatMap(floor => Array.isArray(floor.imageAssetIds) ? floor.imageAssetIds : []));
  if (meta.playerProfile?.avatarAssetId) assetIds.add(meta.playerProfile.avatarAssetId);
  const imageResults = await Promise.allSettled(
    [...assetIds].map(assetId => requestBridge<{ asset?: ImageAssetBackupRecord | null }>('v3-get-image', { assetId })),
  );
  const imageAssets = imageResults
    .filter((item): item is PromiseFulfilledResult<{ asset?: ImageAssetBackupRecord | null }> => item.status === 'fulfilled')
    .map(item => item.value.asset)
    .filter((asset): asset is ImageAssetBackupRecord => (
      isRecord(asset) &&
      typeof asset.id === 'string' &&
      typeof asset.dataUrl === 'string' &&
      typeof asset.mimeType === 'string'
    ));
  return {
    version: 3,
    kind: 'archive-v3',
    exportedAt: new Date().toISOString(),
    meta,
    root,
    state,
    ...(summary ? { summary } : {}),
    ...(memory ? { memory } : {}),
    ...(compatibility ? { compatibility } : {}),
    floors,
    ...(imageAssets.length ? { imageAssets } : {}),
    ...((result.degraded || timelineIncomplete) && resolvedRootHash
      ? {
          degradedRecovery: {
            reason: String(result.reason || (timelineIncomplete ? 'partial-floor-recovery' : 'current-root-unreadable')),
            requestedRootHash,
            resolvedRootHash,
          },
        }
      : {}),
  };
}

export async function restoreTavernArchiveImages(backup: { imageAssets?: ImageAssetBackupRecord[] }) {
  await Promise.allSettled((backup.imageAssets ?? []).map(asset => restoreImageAssetFromBackup(asset)));
}
