import type {
  ArchiveBackend,
  ArchiveFloorChunk,
  ArchiveFloorIndexPage,
  ArchiveJournalRecord,
  ArchiveObjectKind,
  ArchiveRoot,
  ArchiveSaveMeta,
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
  private readonly knownPlayableRootHashes = new Set<string>();
  private readonly knownReadableStateRootHashes = new Set<string>();

  private isFutureRoot(root: ArchiveRoot) {
    return Number(root.formatVersion) > 3 || Number(root.schemaVersion) > 3;
  }

  private async isPlayableRoot(rootHash: string, root: ArchiveRoot): Promise<boolean> {
    if (this.knownPlayableRootHashes.has(rootHash)) return true;
    try {
      if (typeof root.stateHash !== 'string' || !root.stateHash) return false;
      const state = await idbGet<unknown>(IDB_STORE_SAVE_STATE_V3, root.stateHash);
      if (!state || typeof state !== 'object') return false;
      const gameState = (state as { gameState?: unknown }).gameState;
      if (!gameState || typeof gameState !== 'object') return false;
      if (typeof (gameState as { runId?: unknown }).runId !== 'string') return false;
      const statusData = (gameState as { statusData?: unknown }).statusData;
      if (!statusData || typeof statusData !== 'object') return false;
      this.knownReadableStateRootHashes.add(rootHash);

      const floorCount = Number(root.floorCount);
      const chunkSize = Number(root.chunkSize);
      const indexPageChunkCount = Number(root.indexPageChunkCount);
      if (!Number.isInteger(floorCount) || floorCount < 0) return false;
      if (!Number.isInteger(chunkSize) || chunkSize <= 0) return false;
      if (!Number.isInteger(indexPageChunkCount) || indexPageChunkCount <= 0) return false;
      if (
        !root.floorIndexPageHashes
        || typeof root.floorIndexPageHashes !== 'object'
        || Array.isArray(root.floorIndexPageHashes)
      ) {
        return false;
      }

      const entries: Array<{ pageNo: number; entry: ArchiveFloorIndexPage['entries'][number] }> = [];
      for (const [pageNoText, pageHash] of Object.entries(root.floorIndexPageHashes)) {
        const pageNo = Number(pageNoText);
        if (!Number.isInteger(pageNo) || pageNo < 0 || typeof pageHash !== 'string' || !pageHash) return false;
        const page = await idbGet<ArchiveFloorIndexPage>(IDB_STORE_FLOOR_INDEX_V3, pageHash);
        if (!page || !Array.isArray(page.entries)) return false;
        for (const entry of page.entries) entries.push({ pageNo, entry });
      }
      entries.sort((left, right) => Number(left.entry.chunkNo) - Number(right.entry.chunkNo));

      const expectedChunkCount = Math.ceil(floorCount / chunkSize);
      if (entries.length !== expectedChunkCount) return false;
      let observedFloorCount = 0;
      for (let chunkNo = 0; chunkNo < entries.length; chunkNo += 1) {
        const { pageNo, entry } = entries[chunkNo];
        const startFloor = chunkNo * chunkSize;
        const endFloorExclusive = Math.min(floorCount, startFloor + chunkSize);
        if (
          Number(entry.chunkNo) !== chunkNo
          || Number(entry.startFloor) !== startFloor
          || Number(entry.endFloorExclusive) !== endFloorExclusive
          || Math.floor(chunkNo / indexPageChunkCount) !== pageNo
          || typeof entry.chunkHash !== 'string'
          || !entry.chunkHash
        ) {
          return false;
        }
        const chunk = await idbGet<ArchiveFloorChunk>(IDB_STORE_FLOOR_CHUNKS_V3, entry.chunkHash);
        if (!chunk || !Array.isArray(chunk.floors) || chunk.floors.length !== endFloorExclusive - startFloor) {
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
        observedFloorCount += chunk.floors.length;
      }
      if (observedFloorCount !== floorCount) return false;
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
    return idbGet<T>(storeForKind(kind), hash);
  }

  async putObject(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string, value: unknown): Promise<void> {
    await idbPut(storeForKind(kind), hash, value);
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
