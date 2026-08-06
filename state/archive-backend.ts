import type { FloorRecord, GameState, MessageWindowState, SaveKind, SaveMeta } from '../types';
import type { IslandMemoryDB } from '../memorydatabase/types';
import type { SummaryStore } from '../summary/types';

export type ArchiveBackendMode =
  | 'unknown'
  | 'probing'
  | 'browser-primary'
  | 'local-v1'
  | 'local-v3'
  | 'no-event-api'
  | 'no-responder'
  | 'backend-unsupported'
  | 'temporarily-failed';

export type ArchiveObjectKind =
  | 'state'
  | 'floor-chunk'
  | 'floor-index'
  | 'summary'
  | 'memory'
  | 'compatibility'
  | 'root';

export type ArchiveObjectReference = {
  kind: ArchiveObjectKind;
  hash: string;
  byteLength: number;
};

export type StoredFloorRecord = Omit<FloorRecord, 'saveId'>;

export type ArchiveFloorChunk = {
  formatVersion: 3;
  chunkNo: number;
  startFloor: number;
  endFloorExclusive: number;
  /** saveId belongs to the active root, not immutable content, so forks share chunks. */
  floors: StoredFloorRecord[];
};

export type ArchiveFloorIndexEntry = {
  chunkNo: number;
  startFloor: number;
  endFloorExclusive: number;
  chunkHash: string;
  messageCount: number;
  hasImages: boolean;
};

export type ArchiveFloorIndexPage = {
  formatVersion: 3;
  pageNo: number;
  entries: ArchiveFloorIndexEntry[];
};

export type ArchiveStateBlock = {
  formatVersion: 3;
  gameState: GameState;
  legacyExtras?: Record<string, unknown>;
};

export type ArchiveSummaryBlock = {
  formatVersion: 3;
  summaryStore: SummaryStore;
  floorBoundary: number;
};

export type ArchiveMemoryBlock = {
  formatVersion: 3;
  memoryDB: IslandMemoryDB;
  floorBoundary: number;
};

export type ArchiveCompatibilityBlock = {
  formatVersion: 3;
  sourceSchemaVersion: string | number | null;
  rawLegacyExtras: Record<string, unknown>;
  excludedRuntimeFlagKeys: string[];
  messageSnapshots?: unknown[];
  migrationIssues?: unknown[];
};

export type ArchiveRoot = {
  formatVersion: 3;
  schemaVersion: 3;
  saveId: string;
  runId: string;
  revision: number;
  messageCount: number;
  /** Counts source user/assistant messages; synthetic pairing users do not count. */
  messageCountMode?: 'source';
  floorCount: number;
  currentFloor: number;
  chunkSize: number;
  indexPageChunkCount: number;
  floorIndexPageHashes: Record<string, string>;
  stateHash: string;
  summaryHash?: string;
  memoryHash?: string;
  compatibilityHash?: string;
  previousRootHash?: string;
  committedAt: string;
};

export type ArchiveSaveMeta = SaveMeta & {
  schemaVersion: 3;
  browserRevision: number;
  localBackedUpRevision: number;
  archiveBackendMode: ArchiveBackendMode;
  rootHash: string;
  floorCount: number;
  currentFloorIndex: number;
  health: 'ok' | 'degraded';
  migrationWarnings?: string[];
};

export type ArchiveJournalRecord = {
  id: string;
  saveId: string;
  revision: number;
  rootHash: string;
  objects: ArchiveObjectReference[];
  status: 'pending' | 'syncing' | 'backed-up' | 'retry' | 'conflict';
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
};

export type ArchiveMigrationJournal = {
  saveId: string;
  sourceVersion: string | number | null;
  sourceFingerprint: string;
  status: 'planning' | 'floors' | 'indexes' | 'publishing' | 'published' | 'failed';
  nextChunkNo: number;
  nextIndexPageNo: number;
  writtenFloorCount: number;
  warnings: string[];
  updatedAt: number;
  error?: string;
};

export type ArchiveSaveSnapshot = {
  meta: ArchiveSaveMeta;
  root: ArchiveRoot;
  state: ArchiveStateBlock;
  summary?: ArchiveSummaryBlock;
  memory?: ArchiveMemoryBlock;
  messageWindow?: ArchiveMessageWindow;
};

export type ArchiveMessageWindow = MessageWindowState & {
  floors: FloorRecord[];
};

export type ArchiveCreateInput = {
  saveId: string;
  runId: string;
  kind: SaveKind;
  label: string;
  meta: SaveMeta;
};

export type ArchiveLocalCapability = {
  mode: ArchiveBackendMode;
  protocolVersion: number | null;
  persistent: boolean;
  storagePath: string;
  archiveLayout?: 'categorized-v1' | 'subdir-v1' | 'flat-v3';
  reason?: string;
};

export interface ArchiveBackend {
  readonly mode: ArchiveBackendMode;
  getRoot(saveId: string): Promise<{ root: ArchiveRoot; rootHash: string } | null>;
  getObject<T>(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string): Promise<T | null>;
  putObject(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string, value: unknown): Promise<void>;
  commitRoot(
    saveId: string,
    rootHash: string,
    root: ArchiveRoot,
    meta: ArchiveSaveMeta,
    journal?: ArchiveJournalRecord,
  ): Promise<void>;
}
