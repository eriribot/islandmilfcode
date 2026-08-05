import type {
  ArchiveBackend,
  ArchiveFloorChunk,
  ArchiveFloorIndexPage,
  ArchiveJournalRecord,
  ArchiveMemoryBlock,
  ArchiveObjectKind,
  ArchiveRoot,
  ArchiveSaveMeta,
  ArchiveSummaryBlock,
} from './archive-backend';
import {
  IDB_STORE_ARCHIVE_ROOTS_V3,
  IDB_STORE_BACKUP_JOURNAL_V3,
  IDB_STORE_FLOOR_CHUNKS_V3,
  IDB_STORE_FLOOR_INDEX_V3,
  IDB_STORE_MEMORY_BLOCKS_V3,
  IDB_STORE_SAVE_META_V3,
  IDB_STORE_SAVE_STATE_V3,
  IDB_STORE_SUMMARY_BLOCKS_V3,
  idbGet,
  idbMutateAtomic,
  idbPut,
} from './idb';

function storeForKind(kind: Exclude<ArchiveObjectKind, 'root'>): string {
  if (kind === 'state') return IDB_STORE_SAVE_STATE_V3;
  if (kind === 'floor-chunk') return IDB_STORE_FLOOR_CHUNKS_V3;
  if (kind === 'floor-index') return IDB_STORE_FLOOR_INDEX_V3;
  if (kind === 'summary') return IDB_STORE_SUMMARY_BLOCKS_V3;
  if (kind === 'compatibility') return IDB_STORE_SAVE_STATE_V3;
  return IDB_STORE_MEMORY_BLOCKS_V3;
}

type BrowserRootPointer = { rootHash: string; previousRootHash?: string; revision?: number };
type BrowserRootResult = BrowserRootPointer & { root: ArchiveRoot };

const pointerKey = (saveId: string) => `save:${saveId}`;
const rootKey = (rootHash: string) => `root:${rootHash}`;

export class BrowserArchiveBackend implements ArchiveBackend {
  readonly mode = 'browser-primary' as const;
  private static readonly OBJECT_CACHE_LIMIT = 12;
  private readonly knownPlayableRootHashes = new Set<string>();
  private readonly knownReadableStateRootHashes = new Set<string>();
  private readonly objectCache = new Map<string, unknown>();

  private cacheObject(key: string, value: unknown) {
    this.objectCache.delete(key);
    this.objectCache.set(key, value);
    while (this.objectCache.size > BrowserArchiveBackend.OBJECT_CACHE_LIMIT) {
      const oldest = this.objectCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.objectCache.delete(oldest);
    }
  }

  private isFutureRoot(root: ArchiveRoot) {
    return Number(root.formatVersion) > 3 || Number(root.schemaVersion) > 3;
  }

  private async isPlayableRoot(rootHash: string, root: ArchiveRoot): Promise<boolean> {
    if (this.knownPlayableRootHashes.has(rootHash)) return true;
    try {
      if (typeof root.stateHash !== 'string' || !root.stateHash) return false;
      const state = await this.getObject<unknown>('state', root.stateHash);
      if (!state || typeof state !== 'object') return false;
      const gameState = (state as { gameState?: unknown }).gameState;
      if (!gameState || typeof gameState !== 'object') return false;
      if (typeof (gameState as { runId?: unknown }).runId !== 'string') return false;
      const statusData = (gameState as { statusData?: unknown }).statusData;
      if (!statusData || typeof statusData !== 'object') return false;
      this.knownReadableStateRootHashes.add(rootHash);

      if (typeof root.summaryHash !== 'string' || !root.summaryHash) return false;
      const summary = await this.getObject<ArchiveSummaryBlock>('summary', root.summaryHash);
      if (
        !summary
        || !summary.summaryStore
        || typeof summary.summaryStore !== 'object'
      ) {
        return false;
      }
      if (typeof root.memoryHash !== 'string' || !root.memoryHash) return false;
      const memory = await this.getObject<ArchiveMemoryBlock>('memory', root.memoryHash);
      if (!memory || !memory.memoryDB || typeof memory.memoryDB !== 'object') return false;

      const floorCount = Number(root.floorCount);
      const messageCount = Number(root.messageCount);
      const chunkSize = Number(root.chunkSize);
      const indexPageChunkCount = Number(root.indexPageChunkCount);
      if (!Number.isInteger(floorCount) || floorCount < 0) return false;
      if (!Number.isInteger(messageCount) || messageCount < 0) return false;
      if (!Number.isInteger(chunkSize) || chunkSize <= 0) return false;
      if (!Number.isInteger(indexPageChunkCount) || indexPageChunkCount <= 0) return false;
      if (
        !root.floorIndexPageHashes
        || typeof root.floorIndexPageHashes !== 'object'
        || Array.isArray(root.floorIndexPageHashes)
      ) {
        return false;
      }

      const expectedChunkCount = Math.ceil(floorCount / chunkSize);
      const expectedPageCount = Math.ceil(expectedChunkCount / indexPageChunkCount);
      const pageHashes = Object.entries(root.floorIndexPageHashes);
      if (pageHashes.length !== expectedPageCount) return false;
      for (let pageNo = 0; pageNo < expectedPageCount; pageNo += 1) {
        const pageHash = root.floorIndexPageHashes[String(pageNo)];
        if (typeof pageHash !== 'string' || !pageHash) return false;
      }

      // Normal open validates only the storage head. Cold chunks are checked
      // when their 16-floor reader slice is requested, so opening cost stays
      // bounded instead of walking the complete timeline twice.
      if (expectedChunkCount > 0) {
        const chunkNo = expectedChunkCount - 1;
        const pageNo = Math.floor(chunkNo / indexPageChunkCount);
        const pageHash = root.floorIndexPageHashes[String(pageNo)];
        const page = await this.getObject<ArchiveFloorIndexPage>('floor-index', pageHash);
        if (!page || Number(page.pageNo) !== pageNo || !Array.isArray(page.entries)) return false;
        const entry = page.entries.find(candidate => Number(candidate.chunkNo) === chunkNo);
        const startFloor = chunkNo * chunkSize;
        const endFloorExclusive = floorCount;
        if (
          !entry
          || Number(entry.startFloor) !== startFloor
          || Number(entry.endFloorExclusive) !== endFloorExclusive
          || typeof entry.chunkHash !== 'string'
          || !entry.chunkHash
        ) {
          return false;
        }
        const chunk = await this.getObject<ArchiveFloorChunk>('floor-chunk', entry.chunkHash);
        if (
          !chunk
          || Number(chunk.chunkNo) !== chunkNo
          || Number(chunk.startFloor) !== startFloor
          || Number(chunk.endFloorExclusive) !== endFloorExclusive
          || !Array.isArray(chunk.floors)
          || chunk.floors.length !== endFloorExclusive - startFloor
        ) {
          return false;
        }
        for (let offset = 0; offset < chunk.floors.length; offset += 1) {
          const floor = chunk.floors[offset];
          if (!floor || typeof floor !== 'object' || Number(floor.floorIndex) !== startFloor + offset) return false;
          const userMessage = floor.userMessage;
          if (
            !userMessage
            || typeof userMessage !== 'object'
            || userMessage.role !== 'user'
            || typeof userMessage.id !== 'string'
            || typeof userMessage.text !== 'string'
          ) {
            return false;
          }
          const assistantMessage = floor.assistantMessage;
          if (
            assistantMessage !== undefined
            && (
              !assistantMessage
              || typeof assistantMessage !== 'object'
              || assistantMessage.role !== 'assistant'
              || typeof assistantMessage.id !== 'string'
              || typeof assistantMessage.text !== 'string'
            )
          ) {
            return false;
          }
          if (floor.provenance?.syntheticUserMessage && !assistantMessage) return false;
        }
      }
      this.knownPlayableRootHashes.add(rootHash);
      return true;
    } catch {
      // Missing/corrupt data may be transient. Do not cache failures; the next
      // player attempt can retry the current root before falling back again.
      return false;
    }
  }

  async getRoot(saveId: string): Promise<BrowserRootResult | null> {
    const pointer = await idbGet<BrowserRootPointer>(IDB_STORE_ARCHIVE_ROOTS_V3, pointerKey(saveId));
    if (!pointer || typeof pointer.rootHash !== 'string' || !pointer.rootHash) return null;

    const visited = new Set<string>();
    let candidateHash: string | undefined = pointer.rootHash;
    let pointerFallback = pointer.previousRootHash;
    let stateOnlyFallback: BrowserRootResult | null = null;
    // Normal roots only retain one previous pointer, but a short bounded walk
    // also recovers when two consecutive interrupted commits left bad objects.
    for (let depth = 0; candidateHash && depth < 8; depth += 1) {
      if (visited.has(candidateHash)) return stateOnlyFallback;
      visited.add(candidateHash);
      const root = await idbGet<ArchiveRoot>(IDB_STORE_ARCHIVE_ROOTS_V3, rootKey(candidateHash)).catch(() => null);
      if (root) {
        // A future root is deliberately returned even if its objects are not
        // readable, so the repository can enforce the sole hard read-only
        // boundary instead of silently downgrading and overwriting it.
        if (this.isFutureRoot(root)) return { rootHash: candidateHash, root };
        if (await this.isPlayableRoot(candidateHash, root)) return { rootHash: candidateHash, root };
        if (!stateOnlyFallback && this.knownReadableStateRootHashes.has(candidateHash)) {
          stateOnlyFallback = { rootHash: candidateHash, root };
        }
      }
      const nextHash = root?.previousRootHash || pointerFallback;
      pointerFallback = undefined;
      candidateHash = typeof nextHash === 'string' && nextHash ? nextHash : undefined;
    }
    // With no complete previous root, retain state-only recovery. The caller
    // can load any surviving recent floors and keep the player in the game;
    // the archive partial-history guard prevents that window from overwriting
    // this immutable root.
    return stateOnlyFallback;
  }

  async getObject<T>(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string): Promise<T | null> {
    const key = `${kind}\u0000${hash}`;
    if (this.objectCache.has(key)) {
      const value = this.objectCache.get(key) as T;
      this.cacheObject(key, value);
      return value;
    }
    const value = await idbGet<T>(storeForKind(kind), hash);
    if (value == null) return null;
    this.cacheObject(key, value);
    return value;
  }

  async putObject(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string, value: unknown): Promise<void> {
    await idbPut(storeForKind(kind), hash, value);
    const key = `${kind}\u0000${hash}`;
    this.cacheObject(key, value);
  }

  async commitRoot(
    saveId: string,
    rootHash: string,
    root: ArchiveRoot,
    meta: ArchiveSaveMeta,
    journal?: ArchiveJournalRecord,
  ): Promise<void> {
    await idbMutateAtomic([
      {
        type: 'put',
        storeName: IDB_STORE_ARCHIVE_ROOTS_V3,
        id: rootKey(rootHash),
        value: root,
      },
      {
        type: 'put',
        storeName: IDB_STORE_ARCHIVE_ROOTS_V3,
        id: pointerKey(saveId),
        value: {
          rootHash,
          revision: root.revision,
          ...(root.previousRootHash ? { previousRootHash: root.previousRootHash } : {}),
        } satisfies BrowserRootPointer,
      },
      { type: 'put', storeName: IDB_STORE_SAVE_META_V3, id: saveId, value: meta },
      ...(journal
        ? [{ type: 'put' as const, storeName: IDB_STORE_BACKUP_JOURNAL_V3, id: journal.id, value: journal }]
        : []),
    ], [
      {
        storeName: IDB_STORE_ARCHIVE_ROOTS_V3,
        id: pointerKey(saveId),
        validate: currentValue => {
          if (!currentValue || typeof currentValue !== 'object') return;
          const current = currentValue as BrowserRootPointer;
          const currentRevision = Number(current.revision);
          if (!Number.isFinite(currentRevision)) return;
          if (currentRevision > root.revision) {
            throw new Error(`Browser archive already has newer revision ${currentRevision}`);
          }
          if (currentRevision === root.revision && current.rootHash !== rootHash) {
            throw new Error(`Browser archive revision ${root.revision} points to a different root`);
          }
        },
      },
    ]);
    this.knownPlayableRootHashes.add(rootHash);
    this.knownReadableStateRootHashes.add(rootHash);
  }
}
