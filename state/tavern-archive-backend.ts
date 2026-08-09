import type {
  ArchiveBackend,
  ArchiveJournalRecord,
  ArchiveObjectKind,
  ArchiveRoot,
  ArchiveRootPointer,
  ArchiveSaveMeta,
} from './archive-backend';
import { BrowserArchiveBackend } from './browser-archive-backend';
import { readTavernArchiveObject, readTavernArchiveRoot, type TavernArchiveRoot } from './tavern-archive-read';

type LocalArchiveReader = {
  getRoot(saveId: string): Promise<TavernArchiveRoot | null>;
  getObject<T>(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string): Promise<T | null>;
};

const defaultLocalReader: LocalArchiveReader = {
  getRoot: readTavernArchiveRoot,
  getObject: readTavernArchiveObject,
};

/**
 * IndexedDB remains the transaction writer. Confirmed local objects are only
 * read on cache misses, so a cold historical chunk never requires a full
 * archive import before the reader can display it.
 */
export class TavernArchiveBackend implements ArchiveBackend {
  readonly mode = 'browser-primary' as const;
  private readonly localPreferredSaveIds = new Set<string>();

  constructor(
    private readonly browser: ArchiveBackend = new BrowserArchiveBackend(),
    private readonly local: LocalArchiveReader = defaultLocalReader,
  ) {}

  async preferLocalRoot(saveId: string): Promise<ArchiveRootPointer | null> {
    const local = await this.local.getRoot(saveId);
    if (!local) return null;
    this.localPreferredSaveIds.add(saveId);
    return { root: local.root, rootHash: local.rootHash, localMeta: local.meta };
  }

  async getRoot(saveId: string): Promise<ArchiveRootPointer | null> {
    if (this.localPreferredSaveIds.has(saveId)) {
      const local = await this.local.getRoot(saveId).catch(() => null);
      if (local) return { root: local.root, rootHash: local.rootHash, localMeta: local.meta };
    }
    const browser = await this.browser.getRoot(saveId).catch(() => null);
    if (browser) return browser;
    const local = await this.local.getRoot(saveId).catch(() => null);
    return local ? { root: local.root, rootHash: local.rootHash, localMeta: local.meta } : null;
  }

  async getObject<T>(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string): Promise<T | null> {
    const cached = await this.browser.getObject<T>(kind, hash).catch(() => null);
    if (cached !== null) return cached;
    const local = await this.local.getObject<T>(kind, hash).catch(() => null);
    if (local === null) return null;
    await this.browser.putObject(kind, hash, local).catch(() => undefined);
    return local;
  }

  async putObject(kind: Exclude<ArchiveObjectKind, 'root'>, hash: string, value: unknown): Promise<void> {
    await this.browser.putObject(kind, hash, value);
  }

  async commitRoot(
    saveId: string,
    rootHash: string,
    root: ArchiveRoot,
    meta: ArchiveSaveMeta,
    journal?: ArchiveJournalRecord,
  ): Promise<void> {
    this.localPreferredSaveIds.delete(saveId);
    await this.browser.commitRoot(saveId, rootHash, root, meta, journal);
  }
}
