import {
  IDB_STORE_INDEX,
  IDB_STORE_PAYLOAD,
  idbGet,
  idbMutateAtomic,
  idbPut,
} from './idb';
import {
  isIncomingRevisionStale,
  nextBrowserRevision,
  normalizeBrowserRevision,
  readBrowserRevision,
  withBrowserRevision,
} from './save-revision';

export type StoreSavePayload = Record<string, unknown>;
export type StoreSaveIndex = Record<string, unknown>;

export type SaveStoreCommitReceipt = {
  browserRevision: number;
  committed: Promise<void>;
};

const LEGACY_INDEX_KEY = 'islandmilfcode:save-index:v2';
const LEGACY_PAYLOAD_PREFIX = 'islandmilfcode:save-payload:v2:';
const INDEX_SINGLETON_ID = '__index__';

const payloadMap = new Map<string, StoreSavePayload>();
let indexMap: StoreSaveIndex = {};
let committedIndexMap: StoreSaveIndex = {};

const latestRevisionBySaveId = new Map<string, number>();
const pendingRevisionBySaveId = new Map<string, number>();

let initialized = false;
let initPromise: Promise<void> | null = null;
let visibilityReloadInstalled = false;
let lastInitDiagnostics = {
  indexCount: 0,
  payloadCount: 0,
  migratedFromLocalStorage: false,
  legacyMigrationPending: false,
  degraded: false,
  initError: null as string | null,
};

// All current v2 index/payload mutations share one local queue. This prevents
// an older standalone write from completing after a newer atomic save commit.
let writeTail: Promise<void> = Promise.resolve();
let lastIssuedBrowserRevision = 0;
const pendingWrites = new Set<Promise<void>>();
const writeFailures = new Map<string, unknown>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneIndex(index: StoreSaveIndex): StoreSaveIndex {
  return { ...index };
}

function getIndexEntry(index: StoreSaveIndex, saveId: string): Record<string, unknown> | null {
  const entry = index[saveId];
  return isRecord(entry) ? entry : null;
}

function getKnownRevision(saveId: string): number {
  return Math.max(
    latestRevisionBySaveId.get(saveId) ?? 0,
    pendingRevisionBySaveId.get(saveId) ?? 0,
    readBrowserRevision(payloadMap.get(saveId)),
    readBrowserRevision(getIndexEntry(indexMap, saveId)),
  );
}

function observeRevision(saveId: string, ...values: unknown[]): number {
  const revision = Math.max(latestRevisionBySaveId.get(saveId) ?? 0, ...values.map(readBrowserRevision));
  latestRevisionBySaveId.set(saveId, revision);
  return revision;
}

function allocateRevision(saveId: string, ...values: unknown[]): number {
  const revision = Math.max(
    getKnownRevision(saveId) + 1,
    nextBrowserRevision(...values),
    Date.now() * 1000,
    lastIssuedBrowserRevision + 1,
  );
  lastIssuedBrowserRevision = revision;
  latestRevisionBySaveId.set(saveId, revision);
  pendingRevisionBySaveId.set(saveId, revision);
  return revision;
}

function clearPendingRevision(saveId: string, revision: number): void {
  if (pendingRevisionBySaveId.get(saveId) === revision) pendingRevisionBySaveId.delete(saveId);
}

function reconcileLatestRevision(saveId: string, ...fallbackValues: unknown[]): void {
  latestRevisionBySaveId.set(
    saveId,
    Math.max(
      pendingRevisionBySaveId.get(saveId) ?? 0,
      readBrowserRevision(payloadMap.get(saveId)),
      readBrowserRevision(getIndexEntry(indexMap, saveId)),
      ...fallbackValues.map(readBrowserRevision),
    ),
  );
}

function assertDiskRevisionNotNewer(input: {
  saveId: string;
  baseRevision: number;
  currentValue: unknown;
  source: 'index' | 'payload';
}): void {
  const revision =
    input.source === 'index' && isRecord(input.currentValue)
      ? readBrowserRevision(getIndexEntry(input.currentValue, input.saveId))
      : readBrowserRevision(input.currentValue);
  if (revision > input.baseRevision) {
    console.info('[save-store] newer disk revision observed; current gameplay write remains allowed', {
      saveId: input.saveId,
      expectedBaseRevision: input.baseRevision,
      diskRevision: revision,
      source: input.source,
    });
  }
}

function enqueue(scope: string, op: () => Promise<void>): Promise<void> {
  const next = writeTail.catch(() => undefined).then(async () => {
    try {
      await op();
      writeFailures.delete(scope);
    } catch (firstError) {
      console.error('[save-store] write failed, retrying:', scope, firstError);
      try {
        await op();
        writeFailures.delete(scope);
      } catch (retryError) {
        console.error('[save-store] retry failed:', scope, retryError);
        writeFailures.set(scope, retryError);
        throw retryError;
      }
    }
  });
  writeTail = next;
  pendingWrites.add(next);
  void next.catch(() => undefined);
  void next.then(
    () => pendingWrites.delete(next),
    () => pendingWrites.delete(next),
  );
  return next;
}

/** Wait until every queued write has reached IndexedDB transaction completion. */
export async function flushSaveStore(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
  const failure = writeFailures.values().next();
  if (!failure.done) throw failure.value;
}

let bc: BroadcastChannel | null = null;

type SaveStoreBroadcast = {
  type?: 'save-committed' | 'payload-changed' | 'payload-deleted' | 'index-changed';
  saveId?: string;
  browserRevision?: number;
};

function mergePayload(saveId: string, incoming: StoreSavePayload): boolean {
  const pendingRevision = pendingRevisionBySaveId.get(saveId) ?? 0;
  if (
    isIncomingRevisionStale({
      incoming,
      current: payloadMap.get(saveId),
      pendingRevision,
      knownRevision: latestRevisionBySaveId.get(saveId),
    }) ||
    (pendingRevision > 0 && readBrowserRevision(incoming) <= pendingRevision)
  ) {
    return false;
  }
  payloadMap.set(saveId, incoming);
  observeRevision(saveId, incoming);
  return true;
}

function mergeIndex(incoming: StoreSaveIndex): void {
  const next = cloneIndex(indexMap);
  const committedNext = cloneIndex(committedIndexMap);
  for (const [saveId, value] of Object.entries(incoming)) {
    if (!isRecord(value)) continue;
    const pendingRevision = pendingRevisionBySaveId.get(saveId) ?? 0;
    if (
      isIncomingRevisionStale({
        incoming: value,
        current: getIndexEntry(indexMap, saveId),
        pendingRevision,
        knownRevision: latestRevisionBySaveId.get(saveId),
      }) ||
      (pendingRevision > 0 && readBrowserRevision(value) <= pendingRevision)
    ) {
      continue;
    }
    next[saveId] = value;
    committedNext[saveId] = value;
    observeRevision(saveId, value);
  }
  indexMap = next;
  committedIndexMap = committedNext;
}

async function mergeCommittedSaveFromIdb(saveId: string): Promise<void> {
  const [freshPayload, freshIndex] = await Promise.all([
    idbGet<StoreSavePayload>(IDB_STORE_PAYLOAD, saveId),
    idbGet<StoreSaveIndex>(IDB_STORE_INDEX, INDEX_SINGLETON_ID),
  ]);
  if (freshPayload) mergePayload(saveId, freshPayload);
  if (freshIndex) mergeIndex(freshIndex);
}

function applyRemoteDelete(saveId: string, revisionValue: unknown): void {
  const revision = normalizeBrowserRevision(revisionValue);
  const pendingRevision = pendingRevisionBySaveId.get(saveId) ?? 0;
  if (revision < getKnownRevision(saveId) || (pendingRevision > 0 && revision <= pendingRevision)) return;
  payloadMap.delete(saveId);
  delete indexMap[saveId];
  delete committedIndexMap[saveId];
  latestRevisionBySaveId.set(saveId, revision);
}

function openBroadcast(): void {
  if (bc || typeof BroadcastChannel === 'undefined') return;
  try {
    bc = new BroadcastChannel('islandmilfcode-save-store');
    bc.onmessage = async event => {
      const data = event.data as SaveStoreBroadcast | null;
      if (!data?.type) return;
      try {
        if ((data.type === 'save-committed' || data.type === 'payload-changed') && data.saveId) {
          await mergeCommittedSaveFromIdb(data.saveId);
        } else if (data.type === 'payload-deleted' && data.saveId) {
          applyRemoteDelete(data.saveId, data.browserRevision);
        } else if (data.type === 'index-changed') {
          const fresh = await idbGet<StoreSaveIndex>(IDB_STORE_INDEX, INDEX_SINGLETON_ID);
          if (fresh) mergeIndex(fresh);
        }
      } catch (error) {
        console.warn('[save-store] broadcast sync failed:', error);
      }
    };
  } catch (error) {
    console.warn('[save-store] BroadcastChannel unavailable:', error);
    bc = null;
  }
}

function broadcast(message: SaveStoreBroadcast): void {
  if (!bc) return;
  try {
    bc.postMessage(message);
  } catch (error) {
    console.warn('[save-store] broadcast post failed:', error);
  }
}

function installVisibilityReload(): void {
  if (visibilityReloadInstalled || typeof document === 'undefined') return;
  visibilityReloadInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    reloadFromIdb(false).catch(error => console.warn('[save-store] visibility reload failed:', error));
  });
}

async function reloadFromIdb(replaceMemory: boolean): Promise<void> {
  // Startup and tab-focus refresh deliberately load only the small index.
  // Legacy aggregate payloads are exact-key hydrated when a player opens,
  // migrates or exports that save; otherwise one old long run would negate
  // the entire v3 archive split.
  const indexRow = await idbGet<StoreSaveIndex>(IDB_STORE_INDEX, INDEX_SINGLETON_ID);
  if (replaceMemory) {
    payloadMap.clear();
    latestRevisionBySaveId.clear();
    indexMap = indexRow ?? {};
    committedIndexMap = cloneIndex(indexMap);
    for (const [saveId, value] of Object.entries(indexMap)) observeRevision(saveId, value);
    return;
  }
  if (indexRow) mergeIndex(indexRow);
}

function jsonEquals(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

type LegacyMigrationResult = {
  migrated: boolean;
  pending: boolean;
};

/**
 * Legacy data is deleted only after every source record has been parsed,
 * written (or proven equivalent/newer), and read back from IndexedDB.
 */
async function migrateFromLocalStorage(): Promise<LegacyMigrationResult> {
  if (typeof localStorage === 'undefined') return { migrated: false, pending: false };

  let rawIndex: string | null = null;
  const payloadKeys: string[] = [];
  try {
    rawIndex = localStorage.getItem(LEGACY_INDEX_KEY);
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_PAYLOAD_PREFIX)) payloadKeys.push(key);
    }
  } catch (error) {
    console.warn('[save-store] legacy localStorage scan failed:', error);
    return { migrated: false, pending: true };
  }

  const sourceCount = payloadKeys.length + (rawIndex ? 1 : 0);
  if (sourceCount === 0) return { migrated: false, pending: false };

  let wroteRecord = false;
  let allVerified = true;

  for (const key of payloadKeys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        allVerified = false;
        continue;
      }
      const parsed = JSON.parse(raw) as StoreSavePayload;
      const saveId = key.slice(LEGACY_PAYLOAD_PREFIX.length);
      const existing = await idbGet<StoreSavePayload>(IDB_STORE_PAYLOAD, saveId);
      if (existing && !jsonEquals(existing, parsed)) {
        // A revisioned IndexedDB value is known to be newer than the v2
        // localStorage source. An unrevisioned conflict remains human-visible.
        if (readBrowserRevision(existing) > readBrowserRevision(parsed)) continue;
        allVerified = false;
        console.warn('[save-store] legacy payload conflicts with IndexedDB; source retained:', key);
        continue;
      }
      if (!existing) {
        await idbPut(IDB_STORE_PAYLOAD, saveId, parsed);
        wroteRecord = true;
      }
      const verified = await idbGet<StoreSavePayload>(IDB_STORE_PAYLOAD, saveId);
      if (!verified || !jsonEquals(verified, parsed)) allVerified = false;
    } catch (error) {
      allVerified = false;
      console.warn('[save-store] migrate payload failed; source retained:', key, error);
    }
  }

  if (rawIndex) {
    try {
      const legacyIndex = JSON.parse(rawIndex) as StoreSaveIndex;
      const existingIndex = (await idbGet<StoreSaveIndex>(IDB_STORE_INDEX, INDEX_SINGLETON_ID)) ?? {};
      const mergedIndex = { ...legacyIndex, ...existingIndex };
      if (!jsonEquals(existingIndex, mergedIndex)) {
        await idbPut(IDB_STORE_INDEX, INDEX_SINGLETON_ID, mergedIndex);
        wroteRecord = true;
      }
      const verifiedIndex = await idbGet<StoreSaveIndex>(IDB_STORE_INDEX, INDEX_SINGLETON_ID);
      if (!verifiedIndex || !jsonEquals(verifiedIndex, mergedIndex)) allVerified = false;
    } catch (error) {
      allVerified = false;
      console.warn('[save-store] migrate index failed; source retained:', error);
    }
  }

  if (allVerified) {
    try {
      if (rawIndex) localStorage.removeItem(LEGACY_INDEX_KEY);
      for (const key of payloadKeys) localStorage.removeItem(key);
      console.info('[save-store] verified localStorage migration:', sourceCount, 'records');
    } catch (error) {
      allVerified = false;
      console.warn('[save-store] legacy cleanup failed; remaining source will be retried:', error);
    }
  }

  return { migrated: wroteRecord, pending: !allVerified };
}

function updateInitDiagnostics(input: {
  migratedFromLocalStorage: boolean;
  legacyMigrationPending: boolean;
  degraded: boolean;
  initError: string | null;
}): void {
  lastInitDiagnostics = {
    indexCount: Object.keys(indexMap).length,
    payloadCount: payloadMap.size,
    ...input,
  };
}

/** Initialize the mirror. Storage failure degrades to memory-only mode and never rejects first render. */
export function initSaveStore(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let migration: LegacyMigrationResult = { migrated: false, pending: false };
    let degraded = false;
    let initError: string | null = null;
    try {
      await reloadFromIdb(true);
      // Retry a partial legacy migration on every launch, even when IDB is not empty.
      migration = await migrateFromLocalStorage();
      if (migration.migrated) await reloadFromIdb(true);
    } catch (error) {
      degraded = true;
      initError = error instanceof Error ? error.message : String(error);
      console.error('[save-store] init failed; continuing in memory-only mode:', error);
    }

    initialized = true;
    openBroadcast();
    installVisibilityReload();
    updateInitDiagnostics({
      migratedFromLocalStorage: migration.migrated,
      legacyMigrationPending: migration.pending,
      degraded,
      initError,
    });
    console.info('[save-store:init]', lastInitDiagnostics);
  })();
  return initPromise;
}

export function readPayloadSync(saveId: string): StoreSavePayload | null {
  if (!initialized) {
    console.warn('[save-store] readPayloadSync called before init');
    return null;
  }
  return payloadMap.get(saveId) ?? null;
}

/** Exact-key legacy payload hydration for open/migrate/export paths. */
export async function loadPayloadById(saveId: string): Promise<StoreSavePayload | null> {
  const cached = payloadMap.get(saveId);
  if (cached) return cached;
  try {
    const payload = await idbGet<StoreSavePayload>(IDB_STORE_PAYLOAD, saveId);
    if (!payload) return null;
    payloadMap.set(saveId, payload);
    observeRevision(saveId, payload);
    return payload;
  } catch (error) {
    console.warn('[save-store] exact-key payload load failed:', saveId, error);
    return null;
  }
}

export function listPayloadsSync(): Array<{ saveId: string; payload: StoreSavePayload }> {
  if (!initialized) {
    console.warn('[save-store] listPayloadsSync called before init');
    return [];
  }
  return [...payloadMap.entries()].map(([saveId, payload]) => ({ saveId, payload }));
}

export function readSaveIndexSync(): StoreSaveIndex {
  if (!initialized) {
    console.warn('[save-store] readSaveIndexSync called before init');
    return {};
  }
  // Callers mutate the returned index before publishing it. Never expose the
  // authoritative in-memory object or rollback cannot recover the prior meta.
  return cloneIndex(indexMap);
}

export function commitSaveSnapshotSync(
  saveId: string,
  payload: StoreSavePayload,
  index: StoreSaveIndex,
): SaveStoreCommitReceipt {
  const previousPayload = payloadMap.get(saveId);
  const previousMeta = getIndexEntry(indexMap, saveId);
  const requestedMeta = getIndexEntry(index, saveId);
  if (!requestedMeta) throw new Error(`save index is missing metadata for ${saveId}`);

  const baseRevision = getKnownRevision(saveId);
  const revision = allocateRevision(saveId, payload, requestedMeta);
  const revisionedPayload = withBrowserRevision(payload, revision);
  const revisionedMeta = withBrowserRevision(requestedMeta, revision);
  payloadMap.set(saveId, revisionedPayload);
  indexMap = { ...index, [saveId]: revisionedMeta };

  const queued = enqueue(`save:${saveId}`, async () => {
    const nextCommittedIndex = { ...committedIndexMap, [saveId]: revisionedMeta };
    await idbMutateAtomic(
      [
        { type: 'put', storeName: IDB_STORE_PAYLOAD, id: saveId, value: revisionedPayload },
        { type: 'put', storeName: IDB_STORE_INDEX, id: INDEX_SINGLETON_ID, value: nextCommittedIndex },
      ],
      [
        {
          storeName: IDB_STORE_INDEX,
          id: INDEX_SINGLETON_ID,
          validate: currentValue =>
            assertDiskRevisionNotNewer({ saveId, baseRevision, currentValue, source: 'index' }),
        },
      ],
    );
    committedIndexMap = nextCommittedIndex;
    broadcast({ type: 'save-committed', saveId, browserRevision: revision });
  });

  const committed = queued.then(
    () => {
      clearPendingRevision(saveId, revision);
    },
    error => {
      if (readBrowserRevision(payloadMap.get(saveId)) === revision) {
        if (previousPayload) payloadMap.set(saveId, previousPayload);
        else payloadMap.delete(saveId);
      }
      if (readBrowserRevision(getIndexEntry(indexMap, saveId)) === revision) {
        const restored = cloneIndex(indexMap);
        if (previousMeta) restored[saveId] = previousMeta;
        else delete restored[saveId];
        indexMap = restored;
      }
      clearPendingRevision(saveId, revision);
      reconcileLatestRevision(saveId, previousPayload, previousMeta);
      void mergeCommittedSaveFromIdb(saveId).catch(() => undefined);
      throw error;
    },
  );
  void committed.catch(() => undefined);
  return { browserRevision: revision, committed };
}

/**
 * Atomically imports an opaque/future-schema payload without adding, removing,
 * or rewriting any payload field. Only its legacy list metadata gets the local
 * browser revision used by this client.
 */
export function commitOpaqueSaveSnapshotSync(
  saveId: string,
  payload: StoreSavePayload,
  index: StoreSaveIndex,
): SaveStoreCommitReceipt {
  const previousPayload = payloadMap.get(saveId);
  const previousMeta = getIndexEntry(indexMap, saveId);
  const requestedMeta = getIndexEntry(index, saveId);
  if (!requestedMeta) throw new Error(`save index is missing metadata for ${saveId}`);

  const baseRevision = getKnownRevision(saveId);
  const revision = allocateRevision(saveId, requestedMeta);
  const revisionedMeta = withBrowserRevision(requestedMeta, revision);
  payloadMap.set(saveId, payload);
  indexMap = { ...index, [saveId]: revisionedMeta };

  const queued = enqueue(`save:${saveId}`, async () => {
    const nextCommittedIndex = { ...committedIndexMap, [saveId]: revisionedMeta };
    await idbMutateAtomic(
      [
        { type: 'put', storeName: IDB_STORE_PAYLOAD, id: saveId, value: payload },
        { type: 'put', storeName: IDB_STORE_INDEX, id: INDEX_SINGLETON_ID, value: nextCommittedIndex },
      ],
      [
        {
          storeName: IDB_STORE_INDEX,
          id: INDEX_SINGLETON_ID,
          validate: currentValue =>
            assertDiskRevisionNotNewer({ saveId, baseRevision, currentValue, source: 'index' }),
        },
      ],
    );
    committedIndexMap = nextCommittedIndex;
    broadcast({ type: 'save-committed', saveId, browserRevision: revision });
  });

  const committed = queued.then(
    () => clearPendingRevision(saveId, revision),
    error => {
      if (payloadMap.get(saveId) === payload) {
        if (previousPayload) payloadMap.set(saveId, previousPayload);
        else payloadMap.delete(saveId);
      }
      if (readBrowserRevision(getIndexEntry(indexMap, saveId)) === revision) {
        const restored = cloneIndex(indexMap);
        if (previousMeta) restored[saveId] = previousMeta;
        else delete restored[saveId];
        indexMap = restored;
      }
      clearPendingRevision(saveId, revision);
      reconcileLatestRevision(saveId, previousPayload, previousMeta);
      void mergeCommittedSaveFromIdb(saveId).catch(() => undefined);
      throw error;
    },
  );
  void committed.catch(() => undefined);
  return { browserRevision: revision, committed };
}

export function writePayloadSync(saveId: string, payload: StoreSavePayload): Promise<void> {
  const previousPayload = payloadMap.get(saveId);
  const baseRevision = getKnownRevision(saveId);
  const revision = allocateRevision(saveId, payload);
  const revisionedPayload = withBrowserRevision(payload, revision);
  payloadMap.set(saveId, revisionedPayload);

  const committed = enqueue(`save:${saveId}`, async () => {
    await idbMutateAtomic(
      [{ type: 'put', storeName: IDB_STORE_PAYLOAD, id: saveId, value: revisionedPayload }],
      [
        {
          storeName: IDB_STORE_PAYLOAD,
          id: saveId,
          validate: currentValue =>
            assertDiskRevisionNotNewer({ saveId, baseRevision, currentValue, source: 'payload' }),
        },
      ],
    );
    broadcast({ type: 'payload-changed', saveId, browserRevision: revision });
  }).then(
    () => clearPendingRevision(saveId, revision),
    error => {
      if (readBrowserRevision(payloadMap.get(saveId)) === revision) {
        if (previousPayload) payloadMap.set(saveId, previousPayload);
        else payloadMap.delete(saveId);
      }
      clearPendingRevision(saveId, revision);
      reconcileLatestRevision(saveId, previousPayload);
      void mergeCommittedSaveFromIdb(saveId).catch(() => undefined);
      throw error;
    },
  );
  void committed.catch(() => undefined);
  return committed;
}

/** Payload-only compatibility path for future-schema bulk backups; never rewrites the opaque object. */
export function writeOpaquePayloadSync(saveId: string, payload: StoreSavePayload): Promise<void> {
  const previousPayload = payloadMap.get(saveId);
  payloadMap.set(saveId, payload);
  const committed = enqueue(`opaque:${saveId}`, async () => {
    await idbPut(IDB_STORE_PAYLOAD, saveId, payload);
    broadcast({ type: 'payload-changed', saveId });
  }).catch(error => {
    if (payloadMap.get(saveId) === payload) {
      if (previousPayload) payloadMap.set(saveId, previousPayload);
      else payloadMap.delete(saveId);
    }
    throw error;
  });
  void committed.catch(() => undefined);
  return committed;
}

export function deleteSaveSnapshotSync(saveId: string, index: StoreSaveIndex): SaveStoreCommitReceipt {
  const previousPayload = payloadMap.get(saveId);
  const previousMeta = getIndexEntry(indexMap, saveId);
  const baseRevision = getKnownRevision(saveId);
  const revision = allocateRevision(saveId, previousPayload, previousMeta);
  payloadMap.delete(saveId);
  indexMap = cloneIndex(index);
  delete indexMap[saveId];

  const queued = enqueue(`save:${saveId}`, async () => {
    const nextCommittedIndex = cloneIndex(committedIndexMap);
    delete nextCommittedIndex[saveId];
    await idbMutateAtomic(
      [
        { type: 'delete', storeName: IDB_STORE_PAYLOAD, id: saveId },
        { type: 'put', storeName: IDB_STORE_INDEX, id: INDEX_SINGLETON_ID, value: nextCommittedIndex },
      ],
      [
        {
          storeName: IDB_STORE_INDEX,
          id: INDEX_SINGLETON_ID,
          validate: currentValue =>
            assertDiskRevisionNotNewer({ saveId, baseRevision, currentValue, source: 'index' }),
        },
      ],
    );
    committedIndexMap = nextCommittedIndex;
    broadcast({ type: 'payload-deleted', saveId, browserRevision: revision });
  });

  const committed = queued.then(
    () => clearPendingRevision(saveId, revision),
    error => {
      if (getKnownRevision(saveId) === revision) {
        if (previousPayload) payloadMap.set(saveId, previousPayload);
        if (previousMeta) indexMap = { ...indexMap, [saveId]: previousMeta };
        reconcileLatestRevision(saveId, previousPayload, previousMeta);
      }
      clearPendingRevision(saveId, revision);
      void mergeCommittedSaveFromIdb(saveId).catch(() => undefined);
      throw error;
    },
  );
  void committed.catch(() => undefined);
  return { browserRevision: revision, committed };
}

/** Kept for compatibility with payload-only callers. Prefer deleteSaveSnapshotSync for a real save. */
export function deletePayloadSync(saveId: string): Promise<void> {
  const previousPayload = payloadMap.get(saveId);
  const baseRevision = getKnownRevision(saveId);
  const revision = allocateRevision(saveId, previousPayload);
  payloadMap.delete(saveId);
  const committed = enqueue(`save:${saveId}`, async () => {
    await idbMutateAtomic(
      [{ type: 'delete', storeName: IDB_STORE_PAYLOAD, id: saveId }],
      [
        {
          storeName: IDB_STORE_PAYLOAD,
          id: saveId,
          validate: currentValue =>
            assertDiskRevisionNotNewer({ saveId, baseRevision, currentValue, source: 'payload' }),
        },
      ],
    );
    broadcast({ type: 'payload-deleted', saveId, browserRevision: revision });
  }).then(
    () => clearPendingRevision(saveId, revision),
    error => {
      if (getKnownRevision(saveId) === revision && previousPayload) payloadMap.set(saveId, previousPayload);
      clearPendingRevision(saveId, revision);
      throw error;
    },
  );
  void committed.catch(() => undefined);
  return committed;
}

/** Index-only compatibility path for init repair/legacy import. Save writes use the atomic API above. */
export function writeSaveIndexSync(index: StoreSaveIndex): Promise<void> {
  const previousIndex = indexMap;
  const baseRevisions = new Map<string, number>();
  for (const saveId of new Set([...Object.keys(indexMap), ...Object.keys(index)])) {
    baseRevisions.set(saveId, readBrowserRevision(getIndexEntry(indexMap, saveId)));
  }
  const nextIndex = cloneIndex(index);
  for (const [saveId, value] of Object.entries(nextIndex)) {
    if (!isRecord(value)) continue;
    const revision = Math.max(
      readBrowserRevision(value),
      readBrowserRevision(payloadMap.get(saveId)),
      readBrowserRevision(getIndexEntry(indexMap, saveId)),
    );
    nextIndex[saveId] = withBrowserRevision(value, revision);
    observeRevision(saveId, nextIndex[saveId]);
  }
  indexMap = nextIndex;
  const committed = enqueue('index', async () => {
    await idbMutateAtomic(
      [{ type: 'put', storeName: IDB_STORE_INDEX, id: INDEX_SINGLETON_ID, value: nextIndex }],
      [
        {
          storeName: IDB_STORE_INDEX,
          id: INDEX_SINGLETON_ID,
          validate: currentValue => {
            if (!isRecord(currentValue)) return;
            for (const [saveId, baseRevision] of baseRevisions) {
              assertDiskRevisionNotNewer({ saveId, baseRevision, currentValue, source: 'index' });
            }
          },
        },
      ],
    );
    committedIndexMap = cloneIndex(nextIndex);
    broadcast({ type: 'index-changed' });
  }).catch(error => {
    indexMap = previousIndex;
    void idbGet<StoreSaveIndex>(IDB_STORE_INDEX, INDEX_SINGLETON_ID)
      .then(fresh => {
        if (fresh) mergeIndex(fresh);
      })
      .catch(() => undefined);
    throw error;
  });
  void committed.catch(() => undefined);
  return committed;
}

export function isSaveStoreReady(): boolean {
  return initialized;
}

export function getSaveStoreDiagnostics() {
  let highestBrowserRevision = 0;
  for (const revision of latestRevisionBySaveId.values()) {
    highestBrowserRevision = Math.max(highestBrowserRevision, revision);
  }
  return {
    ...lastInitDiagnostics,
    indexCount: Object.keys(indexMap).length,
    payloadCount: payloadMap.size,
    ready: initialized,
    pendingWriteCount: pendingWrites.size,
    failedWriteCount: writeFailures.size,
    highestBrowserRevision,
  };
}
