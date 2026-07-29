import type { IslandMemoryDB } from '../memorydatabase/types';
import type { SummaryStore } from '../summary/types';
import type {
  AppState,
  DrawingSettings,
  FloorPhoneStateSnapshot,
  FloorRecord,
  FloorStateSnapshot,
  GameState,
  PersistedAssistantMessage,
  PersistedMessage,
  PersistedUserMessage,
  PhoneMessageStore,
  PlayerProfile,
  RollbackSnapshot,
  SaveKind,
  SaveMeta,
  UiMessage,
} from '../types';
import { SAVE_DATA_SCHEMA_VERSION } from '../version';
import type {
  ArchiveFloorChunk,
  ArchiveFloorIndexEntry,
  ArchiveFloorIndexPage,
  ArchiveJournalRecord,
  ArchiveCompatibilityBlock,
  ArchiveMemoryBlock,
  ArchiveMigrationJournal,
  ArchiveObjectKind,
  ArchiveObjectReference,
  ArchiveRoot,
  ArchiveSaveMeta,
  ArchiveSaveSnapshot,
  ArchiveStateBlock,
  ArchiveSummaryBlock,
  StoredFloorRecord,
} from './archive-backend';
import { hashArchiveValue } from './archive-hash';
import { BrowserArchiveBackend } from './browser-archive-backend';
import {
  IDB_STORE_ARCHIVE_ROOTS_V3,
  IDB_STORE_BACKUP_JOURNAL_V3,
  IDB_STORE_MIGRATION_JOURNAL_V3,
  IDB_STORE_SAVE_META_V3,
  idbDelete,
  idbGet,
  idbGetAll,
  idbMutateAtomic,
  idbPut,
} from './idb';
import { buildLegacyV2ToV3MigrationPlan, type LegacyMigrationIssue } from './save-migration';
import { deserializeMessages, restoreGameDevelopmentSnapshot, serializeMessages } from './store';
import { readImageAssetReferences, replaceImageAssetReferences } from './image-references';

const FLOOR_CHUNK_SIZE = 16;
const INDEX_PAGE_CHUNK_COUNT = 128;
const FLOOR_CACHE_LIMIT = 24;

type RuntimeArchiveState = Pick<
  AppState,
  'statusData' | 'playerProfile' | 'phoneMessages' | 'drawingSettings' | 'summaryStore' | 'memoryDB' | 'uiMessages'
>;

export type ArchiveCheckpointInput = {
  saveId: string;
  runId: string;
  kind: SaveKind;
  label: string;
  gameState: GameState;
  state: RuntimeArchiveState;
  existingMeta?: SaveMeta | null;
};

export type ArchiveCommitReceipt = {
  saveId: string;
  revision: number;
  rootHash: string;
  floorCount: number;
  committed: true;
};

export type ArchiveRollbackReceipt = ArchiveCommitReceipt & {
  restoredState: FloorStateSnapshot;
  sourceUserText: string;
  capability: 'exact' | 'best-effort';
};

export type PortableArchiveBackup = {
  version: 3;
  kind: 'archive-v3';
  exportedAt: string;
  meta: ArchiveSaveMeta;
  root: ArchiveRoot;
  state: ArchiveStateBlock;
  summary?: ArchiveSummaryBlock;
  memory?: ArchiveMemoryBlock;
  compatibility?: ArchiveCompatibilityBlock;
  floors: FloorRecord[];
};

export type ReadonlyFutureArchiveBackup = {
  version: number;
  kind: 'archive-future-readonly';
  exportedAt: string;
  saveId: string;
  rootHash: string;
  meta: unknown;
  root: unknown;
  /** Known v3-compatible objects are copied without normalization or write-back. */
  objects: Array<{ kind: Exclude<ArchiveObjectKind, 'root'>; hash: string; value: unknown }>;
  referencedImageAssetIds: string[];
  warnings: string[];
};

export type ArchiveCommitEvent = {
  receipt: ArchiveCommitReceipt;
  root: ArchiveRoot;
  meta: ArchiveSaveMeta;
  journal: ArchiveJournalRecord;
};

type ArchiveCommitListener = (event: ArchiveCommitEvent) => Promise<void> | void;

const backend = new BrowserArchiveBackend();
const metaCache = new Map<string, ArchiveSaveMeta>();
const floorCache = new Map<string, { floor: FloorRecord; accessedAt: number }>();
const pendingOperations = new Set<Promise<unknown>>();
const listeners = new Set<ArchiveCommitListener>();
let mutationTail: Promise<void> = Promise.resolve();
let initialized = false;
let initPromise: Promise<void> | null = null;
let lastRevision = 0;
let lastError = '';

class ArchiveMetaCasConflict extends Error {
  constructor() {
    super('Archive metadata changed during backup status update');
    this.name = 'ArchiveMetaCasConflict';
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneMemoryDB(value: IslandMemoryDB): IslandMemoryDB {
  const persisted = cloneJson(value);
  delete persisted._indexes;
  return persisted;
}

function track<T>(promise: Promise<T>): Promise<T> {
  pendingOperations.add(promise);
  void promise.finally(() => pendingOperations.delete(promise)).catch(() => undefined);
  return promise;
}

/**
 * Archive roots are immutable, but their active pointer is not. Serialize
 * mutations so two closely-spaced autosaves cannot publish an older branch
 * after a newer one. A failed write never poisons the following player save.
 */
function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.catch(() => undefined).then(operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return track(result);
}

function nextRevision(previous = 0): number {
  const candidate = Math.max(previous + 1, Date.now() * 1000, lastRevision + 1);
  lastRevision = candidate;
  return candidate;
}

function assertNoFutureArchiveSchema(value: { schemaVersion?: unknown; formatVersion?: unknown }, context: string) {
  const schemaVersion = Number(value.schemaVersion);
  const formatVersion = Number(value.formatVersion);
  if (
    (Number.isFinite(schemaVersion) && schemaVersion > SAVE_DATA_SCHEMA_VERSION) ||
    (Number.isFinite(formatVersion) && formatVersion > 3)
  ) {
    throw new Error(`${context} uses a newer archive schema and is read-only in this build`);
  }
}

function floorCacheKey(saveId: string, floorIndex: number) {
  return `${saveId}\u0000${floorIndex}`;
}

function cacheFloor(floor: FloorRecord) {
  floorCache.set(floorCacheKey(floor.saveId, floor.floorIndex), { floor: cloneJson(floor), accessedAt: Date.now() });
  if (floorCache.size <= FLOOR_CACHE_LIMIT) return;
  const oldest = [...floorCache.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt)[0];
  if (oldest) floorCache.delete(oldest[0]);
}

function invalidateFloorCache(saveId: string) {
  for (const key of floorCache.keys()) {
    if (key.startsWith(`${saveId}\u0000`)) floorCache.delete(key);
  }
}

function stripSaveId(floor: FloorRecord): StoredFloorRecord {
  const { saveId: _saveId, ...stored } = cloneJson(floor);
  return stored;
}

function withSaveId(saveId: string, floor: StoredFloorRecord): FloorRecord {
  return { ...cloneJson(floor), saveId };
}

function serializeUiMessage(message: UiMessage): PersistedMessage | null {
  return serializeMessages([message])[0] ?? null;
}

function getPersistedMessages(messages: UiMessage[]): PersistedMessage[] {
  const result: PersistedMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const persisted = serializeUiMessage(message);
    if (persisted) result.push(persisted);
  }
  return result;
}

function getPersistedMessageSlice(messages: UiMessage[], startOrdinal: number) {
  const result: PersistedMessage[] = [];
  const safeStart = Math.max(0, Math.floor(startOrdinal));
  let total = 0;
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (total >= safeStart) {
      const persisted = serializeUiMessage(message);
      if (persisted) result.push(persisted);
    }
    total += 1;
  }
  return { messages: result, total };
}

function countPersistableMessages(messages: UiMessage[]) {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') total += 1;
  }
  return total;
}

function getEntryMessageCount(entry: ArchiveFloorIndexEntry): number {
  const stored = Number(entry.messageCount);
  if (Number.isFinite(stored) && stored >= 0) return Math.floor(stored);
  throw new Error(`Archive index entry ${entry.chunkNo} has no valid messageCount`);
}

function summarizeMigrationIssues(issues: LegacyMigrationIssue[], extra: string[] = []): string[] {
  const grouped = new Map<string, { count: number; sample: string }>();
  for (const issue of issues) {
    const current = grouped.get(issue.code);
    grouped.set(issue.code, {
      count: (current?.count ?? 0) + 1,
      sample: current?.sample ?? issue.detail,
    });
  }
  return [
    ...extra,
    ...[...grouped.entries()].map(([code, value]) =>
      value.count > 1 ? `${code} × ${value.count}：${value.sample}` : `${code}：${value.sample}`,
    ),
  ].slice(0, 16);
}

function collectImageAssetIds(...messages: Array<PersistedMessage | undefined>): string[] {
  const result = new Set<string>();
  for (const message of messages) {
    for (const illustration of message?.illustrations ?? []) {
      if (illustration.assetId) result.add(illustration.assetId);
    }
  }
  return [...result];
}

function getFloorSourceMessageCount(floor: Pick<FloorRecord, 'assistantMessage' | 'provenance'>): number {
  return (floor.provenance.syntheticUserMessage ? 0 : 1) + (floor.assistantMessage ? 1 : 0);
}

/**
 * Convert an archive floor back to the source chat messages visible to the
 * player. Assistant-first turns use an internal synthetic user solely for
 * floor pairing; exposing it would create a blank reader card and turn it into
 * a real message on the next autosave.
 */
export function getArchiveFloorPersistedMessages(floor: FloorRecord): PersistedMessage[] {
  const messages: PersistedMessage[] = [];
  if (!floor.provenance?.syntheticUserMessage) messages.push(floor.userMessage);
  if (floor.assistantMessage) messages.push(floor.assistantMessage);
  return messages;
}

export function deserializeArchiveFloorMessages(floors: readonly FloorRecord[]): UiMessage[] {
  return deserializeMessages(floors.flatMap(getArchiveFloorPersistedMessages));
}

function collectRuntimeImageAssetIds(state: RuntimeArchiveState): string[] {
  const ids = new Set<string>();
  if (state.playerProfile.avatarAssetId) ids.add(state.playerProfile.avatarAssetId);
  for (const message of state.uiMessages) {
    for (const illustration of message.illustrations ?? []) {
      if (illustration.assetId) ids.add(illustration.assetId);
    }
  }
  return [...ids];
}

function phoneSnapshot(phoneMessages: PhoneMessageStore, floorIndex: number, position: 'before' | 'after') {
  const threads: FloorPhoneStateSnapshot['threads'] = {};
  for (const [targetId, thread] of Object.entries(phoneMessages.threads ?? {})) {
    const messages = thread.messages.filter(message => {
      if (typeof message.floorIndex !== 'number') return true;
      return position === 'before' ? message.floorIndex < floorIndex : message.floorIndex <= floorIndex;
    });
    threads[targetId] = {
      lastMessageId: messages[messages.length - 1]?.id ?? null,
      messageCount: messages.length,
      unread: Math.min(thread.unread, messages.length),
    };
  }
  return {
    activeThreadId: phoneMessages.activeThreadId,
    draft: phoneMessages.draft,
    threads,
  } satisfies FloorPhoneStateSnapshot;
}

function snapshotFromRuntime(
  state: RuntimeArchiveState,
  floorIndex: number,
  position: 'before' | 'after',
  source: FloorStateSnapshot['provenance']['statusData'] = 'save-current-fallback',
  phoneFloorIndex = floorIndex,
): FloorStateSnapshot {
  return {
    statusData: cloneJson(state.statusData),
    playerProfile: cloneJson(state.playerProfile),
    phoneState: phoneSnapshot(state.phoneMessages, phoneFloorIndex, position),
    drawingSettings: cloneJson(state.drawingSettings),
    runtime: {},
    provenance: {
      statusData: source,
      playerProfile: source,
      phoneState: source,
      drawingSettings: source,
      runtime: source,
    },
  };
}

function snapshotFromRollback(
  input: RollbackSnapshot | undefined,
  fallback: FloorStateSnapshot,
  source: 'message-snapshot' | 'same-floor-before',
): FloorStateSnapshot {
  if (!input) return cloneJson(fallback);
  return {
    statusData: cloneJson(input.statusData ?? fallback.statusData),
    playerProfile: cloneJson(input.playerProfile ?? fallback.playerProfile),
    phoneState: cloneJson(fallback.phoneState),
    drawingSettings: cloneJson(input.drawingSettings ?? fallback.drawingSettings),
    runtime: input.gameDevelopment === undefined ? cloneJson(fallback.runtime) : { gameDevelopment: cloneJson(input.gameDevelopment) },
    provenance: {
      statusData: input.statusData ? source : fallback.provenance.statusData,
      playerProfile: input.playerProfile ? source : fallback.provenance.playerProfile,
      phoneState: fallback.provenance.phoneState,
      drawingSettings: input.drawingSettings ? source : fallback.provenance.drawingSettings,
      runtime: input.gameDevelopment !== undefined ? source : fallback.provenance.runtime,
    },
  };
}

function messagesToFloors(input: {
  saveId: string;
  messages: PersistedMessage[];
  sourceMessageOffset: number;
  startFloor: number;
  revision: number;
  state: RuntimeArchiveState;
  previousAfter?: FloorStateSnapshot;
  existingByUserId?: Map<string, FloorRecord>;
}): FloorRecord[] {
  const groups: Array<{ user: PersistedUserMessage; assistant?: PersistedAssistantMessage; sourceIndexes: number[]; synthetic: boolean }> = [];
  let pendingUser: { message: PersistedUserMessage; sourceIndex: number } | null = null;
  input.messages.forEach((message, localIndex) => {
    const sourceIndex = input.sourceMessageOffset + localIndex;
    if (message.role === 'user') {
      if (pendingUser) groups.push({ user: pendingUser.message, sourceIndexes: [pendingUser.sourceIndex], synthetic: false });
      pendingUser = { message: cloneJson(message) as PersistedUserMessage, sourceIndex };
      return;
    }
    if (pendingUser) {
      groups.push({
        user: pendingUser.message,
        assistant: cloneJson(message) as PersistedAssistantMessage,
        sourceIndexes: [pendingUser.sourceIndex, sourceIndex],
        synthetic: false,
      });
      pendingUser = null;
      return;
    }
    groups.push({
      user: {
        id: `${message.id}:synthetic-opening-user`,
        role: 'user',
        speaker: 'System',
        text: '',
      },
      assistant: cloneJson(message) as PersistedAssistantMessage,
      sourceIndexes: [sourceIndex],
      synthetic: true,
    });
  });
  if (pendingUser) groups.push({ user: pendingUser.message, sourceIndexes: [pendingUser.sourceIndex], synthetic: false });

  const floors: FloorRecord[] = [];
  let previousAfter = input.previousAfter;
  groups.forEach((group, localFloorIndex) => {
    const floorIndex = input.startFloor + localFloorIndex;
    const existing = input.existingByUserId?.get(group.user.id);
    const beforePhoneFloorIndex = group.sourceIndexes[0] ?? floorIndex;
    const afterPhoneFloorIndex = group.sourceIndexes[group.sourceIndexes.length - 1] ?? beforePhoneFloorIndex;
    const beforeFallback = previousAfter ?? snapshotFromRuntime(input.state, floorIndex, 'before', 'save-current-fallback', beforePhoneFloorIndex);
    const beforeTurnState = group.user.statusSnapshot
      ? snapshotFromRollback(group.user.statusSnapshot, beforeFallback, 'message-snapshot')
      : cloneJson(existing?.beforeTurnState ?? beforeFallback);
    const isLatest = localFloorIndex === groups.length - 1;
    const afterFallback = isLatest
      ? snapshotFromRuntime(input.state, floorIndex, 'after', 'save-current-fallback', afterPhoneFloorIndex)
      : cloneJson(beforeTurnState);
    const afterTurnState = group.assistant
      ? group.assistant.statusSnapshot
        ? snapshotFromRollback(group.assistant.statusSnapshot, afterFallback, 'same-floor-before')
        : cloneJson(existing?.afterTurnState ?? afterFallback)
      : undefined;
    if (existing?.userMessage.id === group.user.id) {
      beforeTurnState.phoneState = cloneJson(existing.beforeTurnState.phoneState);
      if (afterTurnState && existing.afterTurnState && existing.assistantMessage?.id === group.assistant?.id) {
        afterTurnState.phoneState = cloneJson(existing.afterTurnState.phoneState);
      }
    }
    const floor: FloorRecord = {
      saveId: input.saveId,
      floorIndex,
      userMessage: cloneJson(group.user),
      ...(group.assistant ? { assistantMessage: cloneJson(group.assistant) } : {}),
      beforeTurnState,
      ...(afterTurnState ? { afterTurnState } : {}),
      ...(existing?.generationContext
        ? { generationContext: cloneJson(existing.generationContext) }
        : group.assistant
          ? {
              generationContext: {
                kind: 'reader' as const,
                promptFloorRange: [Math.max(0, floorIndex - 12), floorIndex] as [number, number],
                summaryBoundary: Math.min(input.state.summaryStore.lastSummarizedIndex, floorIndex),
                memoryBoundary: Math.min(input.state.memoryDB.lastProcessedIndex, floorIndex),
                routeContextId: input.state.statusData.world.currentMainEventId || undefined,
              },
            }
          : {}),
      summaryBoundary: Math.min(input.state.summaryStore.lastSummarizedIndex, floorIndex + 1),
      memoryBoundary: Math.min(input.state.memoryDB.lastProcessedIndex, floorIndex + 1),
      imageAssetIds: collectImageAssetIds(group.user, group.assistant),
      revision: input.revision,
      provenance: existing?.provenance ?? {
        origin: 'v3-native',
        sourceSchemaVersion: SAVE_DATA_SCHEMA_VERSION,
        sourceMessageIndexes: group.sourceIndexes,
        sourceMessageIds: [group.user.id, group.assistant?.id].filter((id): id is string => Boolean(id)),
        syntheticUserMessage: group.synthetic,
      },
    };
    floors.push(floor);
    previousAfter = afterTurnState ?? beforeTurnState;
  });
  return floors;
}

async function putHashed(
  kind: Exclude<ArchiveObjectKind, 'root'>,
  value: unknown,
  references: ArchiveObjectReference[],
) {
  const hashed = await hashArchiveValue(value);
  await backend.putObject(kind, hashed.hash, value);
  references.push({ kind, hash: hashed.hash, byteLength: hashed.byteLength });
  return hashed.hash;
}

async function readIndexEntries(root: ArchiveRoot): Promise<ArchiveFloorIndexEntry[]> {
  const pages = await Promise.all(Object.entries(root.floorIndexPageHashes).map(async ([pageNoText, hash]) => {
    const pageNo = Number(pageNoText);
    const page = await backend.getObject<ArchiveFloorIndexPage>('floor-index', hash);
    if (!page || !Array.isArray(page.entries)) {
      throw new Error(`Archive floor index page is missing or invalid: page ${pageNoText}, ${hash}`);
    }
    return { pageNo, page };
  }));
  return pages
    .sort((a, b) => a.pageNo - b.pageNo)
    .flatMap(item => item.page.entries)
    .sort((a, b) => a.chunkNo - b.chunkNo);
}

async function writeFloorLayout(
  floors: FloorRecord[],
  references: ArchiveObjectReference[],
): Promise<{ pageHashes: Record<string, string>; messageCount: number }> {
  const entries: ArchiveFloorIndexEntry[] = [];
  for (let offset = 0; offset < floors.length; offset += FLOOR_CHUNK_SIZE) {
    const chunkFloors = floors.slice(offset, offset + FLOOR_CHUNK_SIZE);
    const chunkNo = Math.floor(offset / FLOOR_CHUNK_SIZE);
    const chunk: ArchiveFloorChunk = {
      formatVersion: 3,
      chunkNo,
      startFloor: offset,
      endFloorExclusive: offset + chunkFloors.length,
      floors: chunkFloors.map(stripSaveId),
    };
    const chunkHash = await putHashed('floor-chunk', chunk, references);
    entries.push({
      chunkNo,
      startFloor: chunk.startFloor,
      endFloorExclusive: chunk.endFloorExclusive,
      chunkHash,
      messageCount: chunkFloors.reduce((sum, floor) => sum + getFloorSourceMessageCount(floor), 0),
      hasImages: chunkFloors.some(floor => floor.imageAssetIds.length > 0),
    });
  }

  const pageHashes: Record<string, string> = {};
  for (let offset = 0; offset < entries.length; offset += INDEX_PAGE_CHUNK_COUNT) {
    const pageNo = Math.floor(offset / INDEX_PAGE_CHUNK_COUNT);
    const page: ArchiveFloorIndexPage = {
      formatVersion: 3,
      pageNo,
      entries: entries.slice(offset, offset + INDEX_PAGE_CHUNK_COUNT),
    };
    pageHashes[String(pageNo)] = await putHashed('floor-index', page, references);
  }
  return {
    pageHashes,
    messageCount: entries.reduce((sum, entry) => sum + entry.messageCount, 0),
  };
}

async function writeTailFloorLayout(input: {
  saveId: string;
  root: ArchiveRoot;
  revision: number;
  state: RuntimeArchiveState;
  references: ArchiveObjectReference[];
}): Promise<{ pageHashes: Record<string, string>; floorCount: number; messageCount: number }> {
  if (input.root.messageCountMode !== 'source') {
    // One-time compatibility rebuild for early v3 drafts that counted the
    // synthetic opening user. Without this, every chunk after the first would
    // be sliced one message too far and slowly corrupt pairing.
    const messages = getPersistedMessages(input.state.uiMessages);
    const floors = messagesToFloors({
      saveId: input.saveId,
      messages,
      sourceMessageOffset: 0,
      startFloor: 0,
      revision: input.revision,
      state: input.state,
    });
    const previousFloorCount = Number(input.root.floorCount);
    if (!Number.isInteger(previousFloorCount) || previousFloorCount < 0) {
      throw new Error('Archive root has an invalid floor count');
    }
    if (floors.length < previousFloorCount) {
      throw new Error('Runtime archive history is incomplete; preserving the previous complete archive root');
    }
    const layout = await writeFloorLayout(floors, input.references);
    return { ...layout, floorCount: floors.length };
  }
  const rootMessageCount = Number(input.root.messageCount);
  if (!Number.isFinite(rootMessageCount) || rootMessageCount < 0) {
    throw new Error('Archive root has an invalid source message count');
  }
  if (countPersistableMessages(input.state.uiMessages) < rootMessageCount) {
    // This is a recovery window, not an intentional deletion. Explicit
    // rollback/delete operations republish floors through their own paths.
    throw new Error('Runtime archive history is incomplete; preserving the previous complete archive root');
  }
  const pageNumbers = Object.keys(input.root.floorIndexPageHashes)
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const lastPageNo = pageNumbers[pageNumbers.length - 1];
  const lastPageHash = Number.isFinite(lastPageNo)
    ? input.root.floorIndexPageHashes[String(lastPageNo)]
    : undefined;
  const lastPage = lastPageHash
    ? await backend.getObject<ArchiveFloorIndexPage>('floor-index', lastPageHash)
    : null;
  const pageEntries = [...(lastPage?.entries ?? [])].sort((left, right) => left.chunkNo - right.chunkNo);
  const lastEntry = pageEntries[pageEntries.length - 1];
  if (!lastEntry) {
    const messages = getPersistedMessages(input.state.uiMessages);
    const floors = messagesToFloors({
      saveId: input.saveId,
      messages,
      sourceMessageOffset: 0,
      startFloor: 0,
      revision: input.revision,
      state: input.state,
    });
    const layout = await writeFloorLayout(floors, input.references);
    return { ...layout, floorCount: floors.length };
  }

  const lastEntryMessageCount = getEntryMessageCount(lastEntry);
  const prefixMessageCount = Math.max(0, Number(input.root.messageCount) - lastEntryMessageCount);
  const current = getPersistedMessageSlice(input.state.uiMessages, prefixMessageCount);
  if (current.total < rootMessageCount) {
    // The runtime only holds a recovery window, not the complete archive.
    // A normal autosave must never reinterpret that partial window as an
    // intentional deletion and publish it over the last complete root.
    throw new Error('Runtime archive history is incomplete; preserving the previous complete archive root');
  }

  const previousFloor = lastEntry.startFloor > 0 ? await getArchiveFloor(input.saveId, lastEntry.startFloor - 1) : null;
  const oldChunk = await backend.getObject<ArchiveFloorChunk>('floor-chunk', lastEntry.chunkHash);
  const firstOldFloor = oldChunk?.floors[0];
  const firstOldSourceMessageId = firstOldFloor?.provenance.syntheticUserMessage
    ? firstOldFloor.assistantMessage?.id
    : firstOldFloor?.userMessage.id;
  if (!oldChunk || firstOldSourceMessageId !== current.messages[0]?.id) {
    // A deletion or structural edit before the tail shifts message identities.
    // Tail-only rewriting would retain the stale prefix, so rebuild exactly in
    // this exceptional path. Normal append/autosave remains tail-bounded.
    const messages = getPersistedMessages(input.state.uiMessages);
    const floors = messagesToFloors({
      saveId: input.saveId,
      messages,
      sourceMessageOffset: 0,
      startFloor: 0,
      revision: input.revision,
      state: input.state,
    });
    const layout = await writeFloorLayout(floors, input.references);
    return { ...layout, floorCount: floors.length };
  }
  const existingByUserId = new Map(
    (oldChunk?.floors ?? []).map(stored => {
      const floor = withSaveId(input.saveId, stored);
      return [floor.userMessage.id, floor] as const;
    }),
  );
  const replacementFloors = messagesToFloors({
    saveId: input.saveId,
    messages: current.messages,
    sourceMessageOffset: prefixMessageCount,
    startFloor: lastEntry.startFloor,
    revision: input.revision,
    state: input.state,
    previousAfter: previousFloor?.afterTurnState ?? previousFloor?.beforeTurnState,
    existingByUserId,
  });

  const prefixEntries = pageEntries.slice(0, -1);
  const replacementEntries: ArchiveFloorIndexEntry[] = [];
  for (let offset = 0; offset < replacementFloors.length; offset += FLOOR_CHUNK_SIZE) {
    const floors = replacementFloors.slice(offset, offset + FLOOR_CHUNK_SIZE);
    const chunkNo = lastEntry.chunkNo + Math.floor(offset / FLOOR_CHUNK_SIZE);
    const startFloor = lastEntry.startFloor + offset;
    const chunk: ArchiveFloorChunk = {
      formatVersion: 3,
      chunkNo,
      startFloor,
      endFloorExclusive: startFloor + floors.length,
      floors: floors.map(stripSaveId),
    };
    replacementEntries.push({
      chunkNo,
      startFloor,
      endFloorExclusive: chunk.endFloorExclusive,
      chunkHash: await putHashed('floor-chunk', chunk, input.references),
      messageCount: floors.reduce((sum, floor) => sum + getFloorSourceMessageCount(floor), 0),
      hasImages: floors.some(floor => floor.imageAssetIds.length > 0),
    });
  }

  const nextTailEntries = [...prefixEntries, ...replacementEntries];
  const pageHashes: Record<string, string> = Object.fromEntries(
    Object.entries(input.root.floorIndexPageHashes).filter(([pageNo]) => Number(pageNo) < lastPageNo),
  );
  for (let offset = 0; offset < nextTailEntries.length; offset += INDEX_PAGE_CHUNK_COUNT) {
    const pageNo = lastPageNo + Math.floor(offset / INDEX_PAGE_CHUNK_COUNT);
    const nextPageEntries = nextTailEntries.slice(offset, offset + INDEX_PAGE_CHUNK_COUNT);
    const previousHash = input.root.floorIndexPageHashes[String(pageNo)];
    const previousPage = previousHash
      ? await backend.getObject<ArchiveFloorIndexPage>('floor-index', previousHash)
      : null;
    if (previousPage && JSON.stringify(previousPage.entries) === JSON.stringify(nextPageEntries)) {
      pageHashes[String(pageNo)] = previousHash;
      continue;
    }
    pageHashes[String(pageNo)] = await putHashed(
      'floor-index',
      { formatVersion: 3, pageNo, entries: nextPageEntries } satisfies ArchiveFloorIndexPage,
      input.references,
    );
  }
  return {
    pageHashes,
    floorCount: replacementFloors.length ? replacementFloors[replacementFloors.length - 1].floorIndex + 1 : lastEntry.startFloor,
    messageCount: prefixMessageCount + replacementEntries.reduce((sum, entry) => sum + getEntryMessageCount(entry), 0),
  };
}

function createMeta(input: {
  saveId: string;
  runId: string;
  kind: SaveKind;
  label: string;
  gameState: GameState;
  state: RuntimeArchiveState;
  rootHash: string;
  revision: number;
  floorCount: number;
  messageCount: number;
  existing?: SaveMeta | ArchiveSaveMeta | null;
  warnings?: string[];
}): ArchiveSaveMeta {
  const now = Date.now();
  const activeTarget = input.state.statusData.targets.find(target => target.id === input.state.statusData.activeTargetId);
  let preview = '';
  for (let index = input.state.uiMessages.length - 1; index >= 0; index -= 1) {
    const message = input.state.uiMessages[index];
    if (message?.role !== 'assistant') continue;
    preview = message.text.slice(0, 180);
    break;
  }
  return {
    saveId: input.saveId,
    runId: input.runId,
    kind: input.kind,
    label: input.label,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    messageIndex: Math.max(0, input.floorCount - 1),
    playerProfile: cloneJson(input.state.playerProfile),
    activeTarget: activeTarget
      ? { id: activeTarget.id, name: activeTarget.name, alias: activeTarget.alias, affinity: activeTarget.affinity, stage: activeTarget.stage }
      : null,
    location: input.state.statusData.world.currentLocation,
    gameTime: input.state.statusData.world.currentTime,
    preview,
    messageCount: input.messageCount,
    version: SAVE_DATA_SCHEMA_VERSION,
    schemaVersion: 3,
    browserRevision: input.revision,
    localBackedUpRevision: (input.existing as ArchiveSaveMeta | undefined)?.localBackedUpRevision ?? 0,
    archiveBackendMode: (input.existing as ArchiveSaveMeta | undefined)?.archiveBackendMode ?? 'browser-primary',
    rootHash: input.rootHash,
    floorCount: input.floorCount,
    currentFloorIndex: Math.max(0, input.floorCount - 1),
    health: input.warnings?.length ? 'degraded' : 'ok',
    ...(input.warnings?.length ? { migrationWarnings: input.warnings } : {}),
  };
}

async function publish(input: {
  saveId: string;
  runId: string;
  kind: SaveKind;
  label: string;
  gameState: GameState;
  state: RuntimeArchiveState;
  previous?: { root: ArchiveRoot; rootHash: string } | null;
  revision: number;
  pageHashes: Record<string, string>;
  floorCount: number;
  messageCount: number;
  references: ArchiveObjectReference[];
  existingMeta?: SaveMeta | ArchiveSaveMeta | null;
  warnings?: string[];
  compatibility?: ArchiveCompatibilityBlock;
}): Promise<ArchiveCommitReceipt> {
  const stateBlock: ArchiveStateBlock = {
    formatVersion: 3,
    gameState: cloneJson(input.gameState),
  };
  const stateHash = await putHashed('state', stateBlock, input.references);
  const summaryBlock: ArchiveSummaryBlock = {
    formatVersion: 3,
    summaryStore: cloneJson(input.state.summaryStore),
    floorBoundary: input.state.summaryStore.lastSummarizedIndex,
  };
  const summaryHash = await putHashed('summary', summaryBlock, input.references);
  const memoryBlock: ArchiveMemoryBlock = {
    formatVersion: 3,
    memoryDB: cloneMemoryDB(input.state.memoryDB),
    floorBoundary: input.state.memoryDB.lastProcessedIndex,
  };
  const memoryHash = await putHashed('memory', memoryBlock, input.references);
  const compatibilityHash = input.compatibility
    ? await putHashed('compatibility', input.compatibility, input.references)
    : input.previous?.root.compatibilityHash;
  const root: ArchiveRoot = {
    formatVersion: 3,
    schemaVersion: 3,
    saveId: input.saveId,
    runId: input.runId,
    revision: input.revision,
    messageCount: input.messageCount,
    messageCountMode: 'source',
    floorCount: input.floorCount,
    currentFloor: Math.max(0, input.floorCount - 1),
    chunkSize: FLOOR_CHUNK_SIZE,
    indexPageChunkCount: INDEX_PAGE_CHUNK_COUNT,
    floorIndexPageHashes: input.pageHashes,
    stateHash,
    summaryHash,
    memoryHash,
    ...(compatibilityHash ? { compatibilityHash } : {}),
    ...(input.previous?.rootHash ? { previousRootHash: input.previous.rootHash } : {}),
    committedAt: new Date().toISOString(),
  };
  const rootHash = (await hashArchiveValue(root)).hash;
  const meta = createMeta({
    ...input,
    rootHash,
    existing: input.existingMeta,
  });
  const now = Date.now();
  const journal: ArchiveJournalRecord = {
    id: `${input.saveId}:${input.revision}`,
    saveId: input.saveId,
    revision: input.revision,
    rootHash,
    objects: input.references,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await backend.commitRoot(input.saveId, rootHash, root, meta, journal);
  await replaceImageAssetReferences(`save:${input.saveId}`, collectRuntimeImageAssetIds(input.state)).catch(error => {
    console.warn('[archive] image reference update deferred:', error);
  });
  metaCache.set(input.saveId, meta);
  invalidateFloorCache(input.saveId);
  const receipt: ArchiveCommitReceipt = {
    saveId: input.saveId,
    revision: input.revision,
    rootHash,
    floorCount: input.floorCount,
    committed: true,
  };
  for (const listener of listeners) {
    Promise.resolve(listener({ receipt, root, meta, journal })).catch(error => {
      console.warn('[archive] post-commit sync deferred:', error);
    });
  }
  return receipt;
}

export function initArchiveRepository(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const rows = await idbGetAll<ArchiveSaveMeta>(IDB_STORE_SAVE_META_V3);
      metaCache.clear();
      rows.forEach(row => {
        const schemaVersion = Number(row.value?.schemaVersion);
        const hasArchivePointer = typeof row.value?.rootHash === 'string' && Boolean(row.value.rootHash);
        if ((schemaVersion >= 3 || hasArchivePointer) && typeof row.value?.saveId === 'string' && row.value.saveId) {
          // Future metadata remains listable. All open/commit paths still hit
          // the explicit future-schema guard before they can normalize it.
          metaCache.set(row.value.saveId, row.value);
          lastRevision = Math.max(lastRevision, Number(row.value.browserRevision) || 0);
        }
      });
      initialized = true;
      lastError = '';
    } catch (error) {
      initialized = true;
      lastError = error instanceof Error ? error.message : String(error);
      console.warn('[archive] metadata init failed; legacy play remains available:', error);
    }
  })();
  return initPromise;
}

export function listArchiveSavesSync(): ArchiveSaveMeta[] {
  return [...metaCache.values()]
    .map(meta => {
      const raw = cloneJson(meta) as ArchiveSaveMeta & Record<string, unknown>;
      const profile = isRecord(raw.playerProfile) ? raw.playerProfile : {};
      return {
        ...raw,
        saveId: String(raw.saveId || ''),
        runId: String(raw.runId || raw.saveId || ''),
        kind: raw.kind === 'autosave' ? 'autosave' : 'manual',
        label: String(raw.label || '只读归档存档'),
        createdAt: Number(raw.createdAt) || 0,
        updatedAt: Number(raw.updatedAt) || 0,
        messageIndex: Math.max(0, Number(raw.messageIndex) || 0),
        messageCount: Math.max(0, Number(raw.messageCount) || 0),
        playerProfile: {
          ...profile,
          name: String(profile.name || ''),
          familyName: String(profile.familyName || ''),
          givenName: String(profile.givenName || ''),
          personality: String(profile.personality || ''),
          appearance: String(profile.appearance || ''),
        },
        activeTarget: isRecord(raw.activeTarget) ? raw.activeTarget : null,
      } as ArchiveSaveMeta;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getArchiveMetaSync(saveId: string): ArchiveSaveMeta | null {
  const meta = metaCache.get(saveId);
  return meta ? cloneJson(meta) : null;
}

export function hasArchiveSaveSync(saveId: string): boolean {
  return metaCache.has(saveId);
}

export function subscribeArchiveCommits(listener: ArchiveCommitListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function commitRuntimeArchive(input: ArchiveCheckpointInput): Promise<ArchiveCommitReceipt> {
  return enqueueMutation(async () => {
    const authoritativeMeta = getArchiveMetaSync(input.saveId);
    if (authoritativeMeta) assertNoFutureArchiveSchema(authoritativeMeta, 'Existing save metadata');
    const previous = await backend.getRoot(input.saveId);
    if (previous) assertNoFutureArchiveSchema(previous.root, 'Existing save');
    const revision = nextRevision(previous?.root.revision ?? (Number(input.existingMeta?.browserRevision) || 0));
    const references: ArchiveObjectReference[] = [];
    const layout = previous
      ? await writeTailFloorLayout({
          saveId: input.saveId,
          root: previous.root,
          revision,
          state: input.state,
          references,
        })
      : await (async () => {
          const messages = getPersistedMessages(input.state.uiMessages);
          const floors = messagesToFloors({
            saveId: input.saveId,
            messages,
            sourceMessageOffset: 0,
            startFloor: 0,
            revision,
            state: input.state,
          });
          const layout = await writeFloorLayout(floors, references);
          return { ...layout, floorCount: floors.length };
        })();
    return publish({
      ...input,
      previous,
      revision,
      pageHashes: layout.pageHashes,
      floorCount: layout.floorCount,
      messageCount: layout.messageCount,
      references,
      existingMeta: input.existingMeta ?? getArchiveMetaSync(input.saveId),
    });
  }).catch(error => {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  });
}

export function migrateLegacySaveToArchive(
  meta: SaveMeta,
  payload: unknown,
): Promise<ArchiveCommitReceipt> {
  return enqueueMutation(async () => {
    const existing = await backend.getRoot(meta.saveId);
    if (existing) assertNoFutureArchiveSchema(existing.root, 'Existing save');
    const existingMeta = getArchiveMetaSync(meta.saveId);
    if (existingMeta) assertNoFutureArchiveSchema(existingMeta, 'Existing save metadata');
    const existingState = existing
      ? await backend.getObject<ArchiveStateBlock>('state', existing.root.stateHash).catch(() => null)
      : null;
    if (
      existing &&
      existingState &&
      existingMeta?.runId === meta.runId &&
      existingMeta.updatedAt >= meta.updatedAt &&
      Number(existingMeta.browserRevision) >= Number(meta.browserRevision ?? 0)
    ) {
      return {
        saveId: meta.saveId,
        revision: existing.root.revision,
        rootHash: existing.rootHash,
        floorCount: existing.root.floorCount,
        committed: true,
      };
    }
    const sourceFingerprint = (await hashArchiveValue(payload)).hash;
    const plan = buildLegacyV2ToV3MigrationPlan(payload);
    const targetSaveId = meta.saveId;
    const identityWarnings: string[] = [];
    if (plan.saveId !== targetSaveId) {
      identityWarnings.push(`payload saveId ${plan.saveId} 已按当前槽位 ${targetSaveId} 恢复，原值保留在兼容块。`);
    }
    if (meta.runId && plan.runId !== meta.runId) {
      identityWarnings.push(`索引 runId ${meta.runId} 与 payload runId ${plan.runId} 不同，已采用 payload 的可玩运行态。`);
    }
    const warnings = summarizeMigrationIssues(plan.issues, identityWarnings);
    const journalId = targetSaveId;
    const migrationJournal: ArchiveMigrationJournal = {
      saveId: targetSaveId,
      sourceVersion: plan.sourceSchemaVersion,
      sourceFingerprint,
      status: 'planning',
      nextChunkNo: 0,
      nextIndexPageNo: 0,
      writtenFloorCount: 0,
      warnings,
      updatedAt: Date.now(),
    };
    await idbPut(IDB_STORE_MIGRATION_JOURNAL_V3, journalId, migrationJournal);
    const revision = nextRevision(Math.max(
      Number(meta.browserRevision) || 0,
      Number(existing?.root.revision) || 0,
    ));
    const references: ArchiveObjectReference[] = [];
    migrationJournal.status = 'floors';
    await idbPut(IDB_STORE_MIGRATION_JOURNAL_V3, journalId, migrationJournal);
    const migratedFloors = plan.floors.map(floor => ({ ...floor, saveId: targetSaveId, revision }));
    const layout = await writeFloorLayout(migratedFloors, references);
    migrationJournal.status = 'indexes';
    migrationJournal.writtenFloorCount = plan.floors.length;
    migrationJournal.nextChunkNo = Math.ceil(plan.floors.length / FLOOR_CHUNK_SIZE);
    migrationJournal.nextIndexPageNo = Math.ceil(migrationJournal.nextChunkNo / INDEX_PAGE_CHUNK_COUNT);
    migrationJournal.updatedAt = Date.now();
    await idbPut(IDB_STORE_MIGRATION_JOURNAL_V3, journalId, migrationJournal);

    const migratedMemoryDB = cloneJson(plan.memoryDB ?? createEmptyMemoryDB(plan.runId));
    if (plan.currentState.runtime.gameDevelopment !== undefined) {
      restoreGameDevelopmentSnapshot(migratedMemoryDB, cloneJson(plan.currentState.runtime.gameDevelopment));
    }
    const state: RuntimeArchiveState = {
      statusData: plan.currentState.statusData,
      playerProfile: plan.currentState.playerProfile,
      phoneMessages: plan.currentState.phoneMessages,
      drawingSettings: plan.currentState.drawingSettings,
      summaryStore: plan.summaryStore ?? {
        global: null,
        major: [],
        minor: [],
        keyFacts: [],
        lastSummarizedIndex: 0,
        consecutiveFailures: 0,
        autoPaused: false,
        lastError: null,
      },
      memoryDB: migratedMemoryDB,
      uiMessages: deserializeArchiveFloorMessages(migratedFloors),
    };
    const gameState: GameState = {
      runId: plan.runId,
      statusData: cloneJson(plan.currentState.statusData),
      currentMessageIndex: Math.max(0, layout.messageCount - 1),
      ...(plan.currentState.worldState ? { worldState: cloneJson(plan.currentState.worldState) } : {}),
      runtimeFlags: {
        ...cloneJson(plan.legacyExtras.runtimeFlags),
        ...cloneJson(plan.legacyExtras.runtimeAuthoritativeRawSource),
        playerProfile: cloneJson(plan.currentState.playerProfile),
        phoneMessages: cloneJson(plan.currentState.phoneMessages),
        drawingSettings: cloneJson(plan.currentState.drawingSettings),
      },
    };
    migrationJournal.status = 'publishing';
    migrationJournal.updatedAt = Date.now();
    await idbPut(IDB_STORE_MIGRATION_JOURNAL_V3, journalId, migrationJournal);
    const receipt = await publish({
      saveId: targetSaveId,
      runId: plan.runId,
      kind: meta.kind,
      label: meta.label,
      gameState,
      state,
      previous: existing,
      revision,
      pageHashes: layout.pageHashes,
      floorCount: plan.floors.length,
      messageCount: layout.messageCount,
      references,
      existingMeta: meta,
      warnings,
      compatibility: {
        formatVersion: 3,
        sourceSchemaVersion: plan.sourceSchemaVersion,
        rawLegacyExtras: {
          ...cloneJson(plan.legacyExtras),
          sourceIdentity: { saveId: plan.saveId, runId: plan.runId },
        },
        excludedRuntimeFlagKeys: [...plan.excludedRuntimeFlagKeys],
        ...(plan.messageSnapshots ? { messageSnapshots: cloneJson(plan.messageSnapshots) } : {}),
        migrationIssues: cloneJson(plan.issues),
      },
    });
    migrationJournal.status = 'published';
    migrationJournal.updatedAt = Date.now();
    await idbPut(IDB_STORE_MIGRATION_JOURNAL_V3, journalId, migrationJournal);
    return receipt;
  });
}

function createEmptyMemoryDB(runId: string): IslandMemoryDB {
  return {
    version: 1,
    runId,
    lastProcessedIndex: 0,
    entities: [],
    events: [],
    facts: [],
    relations: [],
    impressions: [],
    tasks: [],
    secrets: [],
    items: [],
    phoneMessages: [],
    summaries: [],
    attributes: [],
    worldState: [],
  };
}

export async function openArchiveSave(saveId: string): Promise<ArchiveSaveSnapshot | null> {
  const pointer = await backend.getRoot(saveId);
  if (!pointer) return null;
  assertNoFutureArchiveSchema(pointer.root, 'Save');
  const meta = getArchiveMetaSync(saveId) ?? await idbGet<ArchiveSaveMeta>(IDB_STORE_SAVE_META_V3, saveId);
  if (!meta) return null;
  assertNoFutureArchiveSchema(meta, 'Save metadata');
  const state = await backend.getObject<ArchiveStateBlock>('state', pointer.root.stateHash);
  if (!state) return null;
  const [summary, memory] = await Promise.all([
    pointer.root.summaryHash
      ? backend.getObject<ArchiveSummaryBlock>('summary', pointer.root.summaryHash).catch(() => null)
      : null,
    pointer.root.memoryHash
      ? backend.getObject<ArchiveMemoryBlock>('memory', pointer.root.memoryHash).catch(() => null)
      : null,
  ]);
  const resolvedMeta: ArchiveSaveMeta = pointer.rootHash === meta.rootHash
    ? meta
    : {
        ...meta,
        browserRevision: pointer.root.revision,
        rootHash: pointer.rootHash,
        floorCount: pointer.root.floorCount,
        currentFloorIndex: pointer.root.currentFloor,
        messageIndex: pointer.root.currentFloor,
        messageCount: pointer.root.messageCount,
        health: 'degraded',
        migrationWarnings: [
          ...(meta.migrationWarnings ?? []).filter(message => message !== '浏览器当前 root 不可读，已回退到上一个可玩版本'),
          '浏览器当前 root 不可读，已回退到上一个可玩版本',
        ],
      };
  return {
    meta: resolvedMeta,
    root: pointer.root,
    state,
    ...(summary ? { summary } : {}),
    ...(memory ? { memory } : {}),
  };
}

export async function getArchiveFloor(saveId: string, floorIndex: number): Promise<FloorRecord | null> {
  if (!Number.isFinite(floorIndex) || floorIndex < 0) return null;
  const key = floorCacheKey(saveId, Math.floor(floorIndex));
  const cached = floorCache.get(key);
  if (cached) {
    cached.accessedAt = Date.now();
    return cloneJson(cached.floor);
  }
  const pointer = await backend.getRoot(saveId);
  if (pointer) assertNoFutureArchiveSchema(pointer.root, 'Save');
  if (!pointer || floorIndex >= pointer.root.floorCount) return null;
  const chunkNo = Math.floor(floorIndex / pointer.root.chunkSize);
  const pageNo = Math.floor(chunkNo / pointer.root.indexPageChunkCount);
  const pageHash = pointer.root.floorIndexPageHashes[String(pageNo)];
  if (!pageHash) return null;
  const page = await backend.getObject<ArchiveFloorIndexPage>('floor-index', pageHash);
  const entry = page?.entries.find(candidate => floorIndex >= candidate.startFloor && floorIndex < candidate.endFloorExclusive);
  if (!entry) return null;
  const chunk = await backend.getObject<ArchiveFloorChunk>('floor-chunk', entry.chunkHash);
  const stored = chunk?.floors.find(candidate => candidate.floorIndex === floorIndex);
  if (!stored) return null;
  const floor = withSaveId(saveId, stored);
  cacheFloor(floor);
  return cloneJson(floor);
}

export async function getArchiveFloorWindow(saveId: string, centerFloor: number, radius = 2) {
  const pointer = await backend.getRoot(saveId);
  if (pointer) assertNoFutureArchiveSchema(pointer.root, 'Save');
  const maxFloor = Math.max(0, (pointer?.root.floorCount ?? centerFloor + 1) - 1);
  const start = Math.max(0, Math.floor(centerFloor) - Math.max(0, radius));
  const end = Math.min(maxFloor, Math.floor(centerFloor) + Math.max(0, radius));
  const floors = await Promise.all(Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => getArchiveFloor(saveId, start + index)));
  return { startFloor: start, endFloor: end, floors: floors.filter((floor): floor is FloorRecord => Boolean(floor)) };
}

export async function streamArchiveFloors(saveId: string): Promise<FloorRecord[]> {
  const pointer = await backend.getRoot(saveId);
  if (!pointer) return [];
  assertNoFutureArchiveSchema(pointer.root, 'Save');
  const entries = await readIndexEntries(pointer.root);
  const chunks = await Promise.all(entries.map(entry => backend.getObject<ArchiveFloorChunk>('floor-chunk', entry.chunkHash)));
  const floors: FloorRecord[] = [];
  chunks.forEach((chunk, index) => {
    const entry = entries[index];
    if (!chunk || !Array.isArray(chunk.floors)) {
      throw new Error(`Archive floor chunk is missing or invalid: chunk ${entry.chunkNo}, ${entry.chunkHash}`);
    }
    floors.push(...chunk.floors.map(floor => withSaveId(saveId, floor)));
  });
  floors.sort((left, right) => left.floorIndex - right.floorIndex);
  if (floors.length !== pointer.root.floorCount || floors.some((floor, index) => floor.floorIndex !== index)) {
    throw new Error(`Archive floor timeline is incomplete: expected ${pointer.root.floorCount}, received ${floors.length}`);
  }
  return floors;
}

export async function hydrateArchiveMessages(saveId: string): Promise<UiMessage[]> {
  const floors = await streamArchiveFloors(saveId);
  return deserializeArchiveFloorMessages(floors);
}

export async function getArchivePromptContext(saveId: string, maxFloors = 12) {
  const pointer = await backend.getRoot(saveId);
  if (pointer) assertNoFutureArchiveSchema(pointer.root, 'Save');
  const floorCount = pointer?.root.floorCount ?? 0;
  if (!floorCount) return { startFloor: 0, floors: [] as FloorRecord[] };
  const startFloor = Math.max(0, floorCount - Math.max(1, maxFloors));
  const floors = await Promise.all(
    Array.from({ length: floorCount - startFloor }, (_, index) => getArchiveFloor(saveId, startFloor + index)),
  );
  return { startFloor, floors: floors.filter((floor): floor is FloorRecord => Boolean(floor)) };
}

function runtimeStateFromSnapshot(snapshot: ArchiveSaveSnapshot, floors: FloorRecord[]): RuntimeArchiveState {
  if (snapshot.root.summaryHash && !snapshot.summary) {
    throw new Error('Cannot preserve archive state: summary block is temporarily unreadable');
  }
  if (snapshot.root.memoryHash && !snapshot.memory) {
    throw new Error('Cannot preserve archive state: memory block is temporarily unreadable');
  }
  const runtimeFlags = snapshot.state.gameState.runtimeFlags ?? {};
  return {
    statusData: cloneJson(snapshot.state.gameState.statusData),
    playerProfile: cloneJson((runtimeFlags.playerProfile as PlayerProfile | undefined) ?? snapshot.meta.playerProfile),
    phoneMessages: cloneJson((runtimeFlags.phoneMessages as PhoneMessageStore | undefined) ?? {
      activeThreadId: null,
      draft: '',
      generating: false,
      threads: {},
    }),
    drawingSettings: cloneJson((runtimeFlags.drawingSettings as DrawingSettings | undefined) ?? {
      enabled: false,
      qualityPrompt: '',
      negativePrompt: '',
      contextMessageCount: 0,
      width: 832,
      height: 1216,
      manualPrompt: '',
      characterAnchors: [],
      systemPrompt: '',
    }),
    summaryStore: cloneJson(snapshot.summary?.summaryStore ?? {
      global: null,
      major: [],
      minor: [],
      keyFacts: [],
      lastSummarizedIndex: 0,
      consecutiveFailures: 0,
      autoPaused: false,
      lastError: null,
    }),
    memoryDB: cloneJson(snapshot.memory?.memoryDB ?? createEmptyMemoryDB(snapshot.meta.runId)),
    uiMessages: deserializeArchiveFloorMessages(floors),
  };
}

async function republishFloors(input: {
  saveId: string;
  floors: FloorRecord[];
  stateSnapshot: ArchiveSaveSnapshot;
  gameState: GameState;
  runtimeState: RuntimeArchiveState;
  preserveState?: boolean;
}): Promise<ArchiveCommitReceipt> {
  const revision = nextRevision(input.stateSnapshot.root.revision);
  const references: ArchiveObjectReference[] = [];
  const layout = await writeFloorLayout(input.floors.map(floor => ({ ...floor, revision })), references);
  const runtimeState = input.preserveState
    ? runtimeStateFromSnapshot(input.stateSnapshot, input.floors)
    : input.runtimeState;
  const gameState = input.preserveState
    ? cloneJson(input.stateSnapshot.state.gameState)
    : input.gameState;
  return publish({
    saveId: input.saveId,
    runId: input.stateSnapshot.meta.runId,
    kind: input.stateSnapshot.meta.kind,
    label: input.stateSnapshot.meta.label,
    gameState,
    state: runtimeState,
    previous: { root: input.stateSnapshot.root, rootHash: input.stateSnapshot.meta.rootHash },
    revision,
    pageHashes: layout.pageHashes,
    floorCount: input.floors.length,
    messageCount: layout.messageCount,
    references,
    existingMeta: input.stateSnapshot.meta,
    warnings: input.stateSnapshot.meta.migrationWarnings,
  });
}

export function truncateArchiveFromAssistant(input: {
  saveId: string;
  floorIndex: number;
  gameState: GameState;
  runtimeState: RuntimeArchiveState;
}): Promise<ArchiveRollbackReceipt | null> {
  return enqueueMutation(async () => {
    const snapshot = await openArchiveSave(input.saveId);
    if (!snapshot) return null;
    const floors = await streamArchiveFloors(input.saveId);
    const target = floors[input.floorIndex];
    if (!target) return null;
    const nextTarget: FloorRecord = {
      ...target,
      assistantMessage: undefined,
      afterTurnState: undefined,
      imageAssetIds: collectImageAssetIds(target.userMessage),
    };
    const nextFloors = [...floors.slice(0, input.floorIndex), nextTarget];
    const receipt = await republishFloors({ ...input, floors: nextFloors, stateSnapshot: snapshot });
    return {
      ...receipt,
      restoredState: cloneJson(target.beforeTurnState),
      sourceUserText: target.userMessage.text,
      capability: Object.values(target.beforeTurnState.provenance).some(value => value === 'defaulted' || value === 'save-current-fallback')
        ? 'best-effort'
        : 'exact',
    };
  });
}

export function truncateArchiveAfterFloor(input: {
  saveId: string;
  floorIndex: number;
  gameState: GameState;
  runtimeState: RuntimeArchiveState;
}): Promise<ArchiveRollbackReceipt | null> {
  return enqueueMutation(async () => {
    const snapshot = await openArchiveSave(input.saveId);
    if (!snapshot) return null;
    const floors = await streamArchiveFloors(input.saveId);
    const target = floors[input.floorIndex];
    if (!target?.afterTurnState) return null;
    const nextFloors = floors.slice(0, input.floorIndex + 1);
    const receipt = await republishFloors({ ...input, floors: nextFloors, stateSnapshot: snapshot });
    return {
      ...receipt,
      restoredState: cloneJson(target.afterTurnState),
      sourceUserText: target.userMessage.text,
      capability: Object.values(target.afterTurnState.provenance).some(value => value === 'defaulted' || value === 'save-current-fallback')
        ? 'best-effort'
        : 'exact',
    };
  });
}

export function replaceArchiveFloorAssistant(input: {
  saveId: string;
  floorIndex: number;
  assistantMessage: PersistedAssistantMessage;
  gameState: GameState;
  runtimeState: RuntimeArchiveState;
}): Promise<ArchiveCommitReceipt | null> {
  return enqueueMutation(async () => {
    const snapshot = await openArchiveSave(input.saveId);
    if (!snapshot) return null;
    const floors = await streamArchiveFloors(input.saveId);
    const target = floors[input.floorIndex];
    if (!target) return null;
    floors[input.floorIndex] = {
      ...target,
      assistantMessage: cloneJson(input.assistantMessage),
      imageAssetIds: collectImageAssetIds(target.userMessage, input.assistantMessage),
    };
    return republishFloors({ ...input, floors, stateSnapshot: snapshot, preserveState: true });
  });
}

export function replaceArchiveFloorMessage(input: {
  saveId: string;
  messageId: string;
  message: PersistedMessage;
  gameState: GameState;
  runtimeState: RuntimeArchiveState;
}): Promise<ArchiveCommitReceipt | null> {
  return enqueueMutation(async () => {
    const snapshot = await openArchiveSave(input.saveId);
    if (!snapshot) return null;
    const floors = await streamArchiveFloors(input.saveId);
    const floorIndex = floors.findIndex(
      floor => floor.userMessage.id === input.messageId || floor.assistantMessage?.id === input.messageId,
    );
    if (floorIndex < 0) return null;
    const target = floors[floorIndex];
    if (input.message.role === 'user') {
      target.userMessage = cloneJson(input.message) as PersistedUserMessage;
    } else {
      target.assistantMessage = cloneJson(input.message) as PersistedAssistantMessage;
    }
    target.imageAssetIds = collectImageAssetIds(target.userMessage, target.assistantMessage);
    return republishFloors({ ...input, floors, stateSnapshot: snapshot, preserveState: true });
  });
}

/**
 * Delete exactly one visible source message without restoring an older state
 * snapshot. State/summary/memory remain authoritative; only the immutable text
 * floor layout is republished.
 */
export function deleteArchiveFloorMessage(input: {
  saveId: string;
  messageId: string;
  gameState: GameState;
  runtimeState: RuntimeArchiveState;
}): Promise<ArchiveCommitReceipt | null> {
  return enqueueMutation(async () => {
    const snapshot = await openArchiveSave(input.saveId);
    if (!snapshot) return null;
    const floors = await streamArchiveFloors(input.saveId);
    const floorIndex = floors.findIndex(
      floor => floor.userMessage.id === input.messageId || floor.assistantMessage?.id === input.messageId,
    );
    if (floorIndex < 0) return null;

    const target = floors[floorIndex];
    let nextFloors: FloorRecord[];
    if (target.assistantMessage?.id === input.messageId) {
      if (target.provenance.syntheticUserMessage) {
        // An assistant-first floor has no source user to retain.
        nextFloors = [...floors.slice(0, floorIndex), ...floors.slice(floorIndex + 1)];
      } else {
        const nextTarget: FloorRecord = {
          ...target,
          assistantMessage: undefined,
          afterTurnState: undefined,
          generationContext: undefined,
          imageAssetIds: collectImageAssetIds(target.userMessage),
          provenance: {
            ...target.provenance,
            syntheticUserMessage: false,
            sourceMessageIndexes: Array.isArray(target.provenance.sourceMessageIndexes)
              ? target.provenance.sourceMessageIndexes.slice(0, 1)
              : [],
            sourceMessageIds: [target.userMessage.id],
          },
        };
        nextFloors = [...floors];
        nextFloors[floorIndex] = nextTarget;
      }
    } else if (target.assistantMessage) {
      const assistantMessage = target.assistantMessage;
      const nextTarget: FloorRecord = {
        ...target,
        userMessage: {
          id: `${assistantMessage.id}:synthetic-opening-user`,
          role: 'user',
          speaker: 'System',
          text: '',
        },
        imageAssetIds: collectImageAssetIds(assistantMessage),
        provenance: {
          ...target.provenance,
          syntheticUserMessage: true,
          sourceMessageIndexes: Array.isArray(target.provenance.sourceMessageIndexes)
            ? target.provenance.sourceMessageIndexes.slice(-1)
            : [],
          sourceMessageIds: [assistantMessage.id],
        },
      };
      nextFloors = [...floors];
      nextFloors[floorIndex] = nextTarget;
    } else {
      nextFloors = [...floors.slice(0, floorIndex), ...floors.slice(floorIndex + 1)];
    }

    nextFloors = nextFloors.map((floor, nextFloorIndex) => ({
      ...floor,
      floorIndex: nextFloorIndex,
    }));
    return republishFloors({
      ...input,
      floors: nextFloors,
      stateSnapshot: snapshot,
      preserveState: true,
    });
  });
}

export function forkArchiveSave(input: {
  sourceSaveId: string;
  saveId?: string;
  label: string;
}): Promise<ArchiveCommitReceipt | null> {
  return enqueueMutation(async () => {
    const source = await openArchiveSave(input.sourceSaveId);
    if (!source) return null;
    const saveId = input.saveId ?? crypto.randomUUID();
    const revision = nextRevision();
    const root: ArchiveRoot = {
      ...cloneJson(source.root),
      saveId,
      revision,
      previousRootHash: source.meta.rootHash,
      committedAt: new Date().toISOString(),
    };
    const rootHash = (await hashArchiveValue(root)).hash;
    const meta: ArchiveSaveMeta = {
      ...cloneJson(source.meta),
      saveId,
      kind: 'manual',
      label: input.label,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      browserRevision: revision,
      localBackedUpRevision: 0,
      rootHash,
      archiveBackendMode: 'browser-primary',
    };
    const now = Date.now();
    const journal: ArchiveJournalRecord = {
      id: `${saveId}:${revision}`,
      saveId,
      revision,
      rootHash,
      objects: [],
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await backend.commitRoot(saveId, rootHash, root, meta, journal);
    const sourceImageIds = await readImageAssetReferences(`save:${input.sourceSaveId}`).catch(() => []);
    await replaceImageAssetReferences(`save:${saveId}`, sourceImageIds).catch(() => undefined);
    metaCache.set(saveId, meta);
    const receipt = { saveId, revision, rootHash, floorCount: root.floorCount, committed: true as const };
    listeners.forEach(listener => Promise.resolve(listener({ receipt, root, meta, journal })).catch(() => undefined));
    return receipt;
  });
}

export function deleteArchiveSave(saveId: string): Promise<void> {
  return enqueueMutation(async () => {
    metaCache.delete(saveId);
    invalidateFloorCache(saveId);
    await Promise.all([
      idbDelete(IDB_STORE_SAVE_META_V3, saveId),
      idbDelete(IDB_STORE_ARCHIVE_ROOTS_V3, `save:${saveId}`),
    ]);
    await replaceImageAssetReferences(`save:${saveId}`, []).catch(() => undefined);
    // Immutable objects are intentionally retained. Conservative GC can reclaim
    // them only after every active/previous/local root has been reconciled.
  });
}

export async function exportPortableArchive(saveId: string): Promise<PortableArchiveBackup> {
  const snapshot = await openArchiveSave(saveId);
  if (!snapshot) throw new Error('Archive save does not exist');
  const compatibility = snapshot.root.compatibilityHash
    ? await backend.getObject<ArchiveCompatibilityBlock>('compatibility', snapshot.root.compatibilityHash).catch(() => null)
    : null;
  return {
    version: 3,
    kind: 'archive-v3',
    exportedAt: new Date().toISOString(),
    meta: cloneJson(snapshot.meta),
    root: cloneJson(snapshot.root),
    state: cloneJson(snapshot.state),
    ...(snapshot.summary ? { summary: cloneJson(snapshot.summary) } : {}),
    ...(snapshot.memory ? { memory: cloneJson(snapshot.memory) } : {}),
    ...(compatibility ? { compatibility: cloneJson(compatibility) } : {}),
    floors: await streamArchiveFloors(saveId),
  };
}

/**
 * Export a future archive as an opaque, read-only rescue package. The current
 * build never imports or rewrites this envelope; it only copies the raw root,
 * metadata, and every object reachable through the v3 fields it recognizes.
 */
export async function exportReadonlyFutureArchive(saveId: string): Promise<ReadonlyFutureArchiveBackup> {
  const pointer = await backend.getRoot(saveId);
  if (!pointer) throw new Error('Archive save does not exist');
  const rawMeta = await idbGet<unknown>(IDB_STORE_SAVE_META_V3, saveId);
  const schemaVersion = Number(pointer.root.schemaVersion);
  const formatVersion = Number(pointer.root.formatVersion);
  const metaSchemaVersion = Number(isRecord(rawMeta) ? rawMeta.schemaVersion : undefined);
  if (!(schemaVersion > SAVE_DATA_SCHEMA_VERSION || formatVersion > 3 || metaSchemaVersion > SAVE_DATA_SCHEMA_VERSION)) {
    throw new Error('Archive is not a future read-only schema');
  }
  const objects: ReadonlyFutureArchiveBackup['objects'] = [];
  const warnings: string[] = [
    '只复制了当前版本认识的 v3 引用字段；未来版本新增的对象引用可能需要由创建该存档的新版本补充导出',
  ];
  const imageAssetIds = new Set<string>();
  const seenObjectKeys = new Set<string>();
  const collectImageIds = (value: unknown, seen = new WeakSet<object>()) => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(item => collectImageIds(item, seen));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'assetId' || key === 'avatarAssetId') && typeof child === 'string' && child) {
        imageAssetIds.add(child);
      } else if (key === 'imageAssetIds' && Array.isArray(child)) {
        child.forEach(id => {
          if (typeof id === 'string' && id) imageAssetIds.add(id);
        });
      }
      collectImageIds(child, seen);
    }
  };
  const copyObject = async (kind: Exclude<ArchiveObjectKind, 'root'>, hash: unknown) => {
    if (typeof hash !== 'string' || !hash) return null;
    const objectKey = `${kind}\u0000${hash}`;
    if (seenObjectKeys.has(objectKey)) {
      return objects.find(item => item.kind === kind && item.hash === hash)?.value ?? null;
    }
    seenObjectKeys.add(objectKey);
    const value = await backend.getObject<unknown>(kind, hash).catch(() => null);
    if (value === null) {
      warnings.push(`无法读取 ${kind}/${hash}；其余未来版原始数据仍已导出`);
      return null;
    }
    objects.push({ kind, hash, value: cloneJson(value) });
    collectImageIds(value);
    return value;
  };

  const root = pointer.root as unknown as Record<string, unknown>;
  collectImageIds(root);
  await copyObject('state', root.stateHash);
  await copyObject('summary', root.summaryHash);
  await copyObject('memory', root.memoryHash);
  await copyObject('compatibility', root.compatibilityHash);
  const pageHashes = isRecord(root.floorIndexPageHashes)
    ? Object.values(root.floorIndexPageHashes).filter((hash): hash is string => typeof hash === 'string' && Boolean(hash))
    : [];
  for (const pageHash of pageHashes) {
    const page = await copyObject('floor-index', pageHash);
    if (!isRecord(page) || !Array.isArray(page.entries)) continue;
    for (const entry of page.entries) {
      if (isRecord(entry)) await copyObject('floor-chunk', entry.chunkHash);
    }
  }

  return {
    version: Math.max(3, Number.isFinite(formatVersion) ? formatVersion : 3),
    kind: 'archive-future-readonly',
    exportedAt: new Date().toISOString(),
    saveId,
    rootHash: pointer.rootHash,
    meta: cloneJson(rawMeta ?? getArchiveMetaSync(saveId)),
    root: cloneJson(pointer.root),
    objects,
    referencedImageAssetIds: [...imageAssetIds],
    warnings,
  };
}

export function importPortableArchive(input: PortableArchiveBackup): Promise<ArchiveCommitReceipt> {
  return enqueueMutation(async () => {
    if (input?.kind !== 'archive-v3' || input.version !== 3 || !Array.isArray(input.floors)) {
      throw new Error('Not an IslandMilfCode v3 archive');
    }
    assertNoFutureArchiveSchema(input.root, 'Imported save');
    assertNoFutureArchiveSchema(input.meta, 'Imported save metadata');
    const saveId = String(input.meta?.saveId || input.root?.saveId || '').trim();
    if (!saveId) throw new Error('Archive saveId is missing');
    const runId = String(input.root?.runId || input.meta?.runId || input.state?.gameState?.runId || '').trim();
    if (!runId) throw new Error('Archive runId is missing');
    const previous = await backend.getRoot(saveId);
    if (previous) assertNoFutureArchiveSchema(previous.root, 'Existing save');
    const uiMessages = deserializeArchiveFloorMessages(input.floors);
    const runtimeFlags = input.state.gameState.runtimeFlags ?? {};
    const runtimeState: RuntimeArchiveState = {
      statusData: cloneJson(input.state.gameState.statusData),
      playerProfile: cloneJson((runtimeFlags.playerProfile as PlayerProfile | undefined) ?? input.meta.playerProfile),
      phoneMessages: cloneJson((runtimeFlags.phoneMessages as PhoneMessageStore | undefined) ?? { activeThreadId: null, draft: '', generating: false, threads: {} }),
      drawingSettings: cloneJson((runtimeFlags.drawingSettings as DrawingSettings | undefined) ?? { enabled: false, qualityPrompt: '', negativePrompt: '', contextMessageCount: 0, width: 832, height: 1216, manualPrompt: '', characterAnchors: [], systemPrompt: '' }),
      summaryStore: cloneJson(input.summary?.summaryStore ?? { global: null, major: [], minor: [], keyFacts: [], lastSummarizedIndex: 0, consecutiveFailures: 0, autoPaused: false, lastError: null }),
      memoryDB: cloneJson(input.memory?.memoryDB ?? createEmptyMemoryDB(runId)),
      uiMessages,
    };
    runtimeState.memoryDB.runId = runId;
    const references: ArchiveObjectReference[] = [];
    const revision = nextRevision(Math.max(Number(input.meta.browserRevision) || 0, previous?.root.revision ?? 0));
    const floors = input.floors.map((floor, floorIndex) => ({
      ...cloneJson(floor),
      saveId,
      floorIndex,
      revision,
      imageAssetIds: Array.isArray(floor.imageAssetIds)
        ? floor.imageAssetIds.filter(id => typeof id === 'string' && Boolean(id))
        : [],
    }));
    const layout = await writeFloorLayout(floors, references);
    return publish({
      saveId,
      runId,
      kind: input.meta.kind,
      label: input.meta.label,
      gameState: { ...cloneJson(input.state.gameState), runId },
      state: runtimeState,
      previous,
      revision,
      pageHashes: layout.pageHashes,
      floorCount: floors.length,
      messageCount: layout.messageCount,
      references,
      existingMeta: input.meta,
      warnings: input.meta.migrationWarnings,
      compatibility: input.compatibility,
    });
  });
}

export function markArchiveLocalBackupResult(input: {
  saveId: string;
  revision: number;
  success: boolean;
  mode: ArchiveSaveMeta['archiveBackendMode'];
  error?: string;
  retryable?: boolean;
}): Promise<void> {
  return enqueueMutation(async () => {
    // The in-memory cache is page-local. A backup callback from another tab or
    // an older revision must compare-and-swap the authoritative IDB row rather
    // than rewriting a stale rootHash/browserRevision pair.
    let updatedMeta: ArchiveSaveMeta | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const meta = await idbGet<ArchiveSaveMeta>(IDB_STORE_SAVE_META_V3, input.saveId);
      // A deleted row stays deleted. Old async callbacks never resurrect it.
      if (!meta) {
        metaCache.delete(input.saveId);
        return;
      }
      if (Number((meta as ArchiveSaveMeta & { schemaVersion?: unknown }).schemaVersion) !== 3) return;
      const browserRevision = Number(meta.browserRevision);
      if (!Number.isFinite(browserRevision) || typeof meta.rootHash !== 'string' || !meta.rootHash) return;

      const isCurrentOrNewerResult = input.revision >= browserRevision;
      const nextMeta: ArchiveSaveMeta = {
        ...meta,
        archiveBackendMode: input.success || isCurrentOrNewerResult
          ? input.mode
          : meta.archiveBackendMode,
        ...(input.success
          ? {
              localBackedUpRevision: Math.max(
                Number(meta.localBackedUpRevision) || 0,
                input.revision,
              ),
            }
          : {}),
      };

      try {
        await idbMutateAtomic(
          [{ type: 'put', storeName: IDB_STORE_SAVE_META_V3, id: input.saveId, value: nextMeta }],
          [{
            storeName: IDB_STORE_SAVE_META_V3,
            id: input.saveId,
            validate: currentValue => {
              if (!currentValue || typeof currentValue !== 'object') throw new ArchiveMetaCasConflict();
              const current = currentValue as Partial<ArchiveSaveMeta>;
              if (
                Number(current.schemaVersion) !== Number(meta.schemaVersion)
                || Number(current.browserRevision) !== browserRevision
                || current.rootHash !== meta.rootHash
                || Number(current.localBackedUpRevision ?? 0) !== Number(meta.localBackedUpRevision ?? 0)
                || current.archiveBackendMode !== meta.archiveBackendMode
              ) {
                throw new ArchiveMetaCasConflict();
              }
            },
          }],
        );
        updatedMeta = nextMeta;
        break;
      } catch (error) {
        if (error instanceof ArchiveMetaCasConflict) continue;
        throw error;
      }
    }
    if (!updatedMeta) throw new Error('Archive metadata kept changing; backup status update deferred');

    const authoritativeMeta = await idbGet<ArchiveSaveMeta>(IDB_STORE_SAVE_META_V3, input.saveId);
    if (authoritativeMeta?.schemaVersion === 3) metaCache.set(input.saveId, authoritativeMeta);
    else metaCache.delete(input.saveId);

    const journalId = `${input.saveId}:${input.revision}`;
    const journal = await idbGet<ArchiveJournalRecord>(IDB_STORE_BACKUP_JOURNAL_V3, journalId);
    if (journal) {
      await idbPut(IDB_STORE_BACKUP_JOURNAL_V3, journalId, {
        ...journal,
        status: input.success ? 'backed-up' : input.retryable === false ? 'conflict' : 'retry',
        attempts: journal.attempts + 1,
        updatedAt: Date.now(),
        ...(input.error ? { lastError: input.error } : {}),
      });
    }
  });
}

export async function flushArchiveRepository(): Promise<void> {
  await Promise.allSettled([...pendingOperations]);
}

export function getArchiveDiagnostics() {
  return {
    initialized,
    saveCount: metaCache.size,
    cachedFloorCount: floorCache.size,
    pendingOperationCount: pendingOperations.size,
    lastRevision,
    lastError,
  };
}
