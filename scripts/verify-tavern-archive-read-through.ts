import type {
  ArchiveBackend,
  ArchiveJournalRecord,
  ArchiveObjectKind,
  ArchiveRoot,
  ArchiveRootPointer,
  ArchiveSaveMeta,
} from '../state/archive-backend';
import { TavernArchiveBackend } from '../state/tavern-archive-backend';

function assertEqual(actual: unknown, expected: unknown, contract: string) {
  if (Object.is(actual, expected)) return;
  throw new Error(`${contract}: expected ${String(expected)}, received ${String(actual)}`);
}

function assertJsonEqual(actual: unknown, expected: unknown, contract: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) return;
  throw new Error(`${contract}: expected ${expectedJson}, received ${actualJson}`);
}

const root = {
  formatVersion: 3,
  schemaVersion: 3,
  saveId: 'save',
  runId: 'run',
  revision: 1,
  messageCount: 0,
  floorCount: 0,
  currentFloor: 0,
  chunkSize: 16,
  indexPageChunkCount: 128,
  floorIndexPageHashes: {},
  stateHash: 'state-hash',
  committedAt: '2026-08-06T00:00:00.000Z',
} satisfies ArchiveRoot;

const meta = {
  saveId: 'save',
  runId: 'run',
  rootHash: 'local-root',
  archiveBackendMode: 'local-v3',
  browserRevision: 1,
  localBackedUpRevision: 1,
} as ArchiveSaveMeta;

let browserRoot: ArchiveRootPointer | null = { root, rootHash: 'browser-root' };
let browserObject: unknown = null;
let localRootReads = 0;
let localObjectReads = 0;
let cacheWrites = 0;

const browser: ArchiveBackend = {
  mode: 'browser-primary',
  async getRoot() {
    return browserRoot;
  },
  async getObject() {
    return browserObject as null;
  },
  async putObject(_kind, _hash, value) {
    cacheWrites += 1;
    browserObject = value;
  },
  async commitRoot(_saveId, rootHash, nextRoot, nextMeta, _journal?: ArchiveJournalRecord) {
    browserRoot = { root: nextRoot, rootHash, localMeta: nextMeta };
  },
};

const local = {
  async getRoot() {
    localRootReads += 1;
    return { root, rootHash: 'local-root', meta, degraded: false };
  },
  async getObject<T>(_kind: Exclude<ArchiveObjectKind, 'root'>, _hash: string): Promise<T | null> {
    localObjectReads += 1;
    return { from: 'local' } as T;
  },
};

async function main() {
  const backend = new TavernArchiveBackend(browser, local);

  const warmRoot = await backend.getRoot('save');
  assertEqual(warmRoot?.rootHash, 'browser-root', 'browser root remains the fast path');
  assertEqual(localRootReads, 0, 'a valid browser root must not trigger a local root read');

  const coldObject = await backend.getObject<{ from: string }>('floor-chunk', 'chunk-hash');
  assertJsonEqual(coldObject, { from: 'local' }, 'a missing browser object must come from the local hash reader');
  assertEqual(localObjectReads, 1, 'only the requested object may be read locally');
  assertEqual(cacheWrites, 1, 'a locally read object becomes a browser hot-cache entry');

  browserRoot = null;
  const localRoot = await backend.preferLocalRoot('save');
  assertEqual(localRoot?.rootHash, 'local-root', 'explicit local entry must resolve its registry root');

  browserRoot = { root, rootHash: 'new-browser-root' };
  await backend.commitRoot('save', 'new-browser-root', root, meta);
  const afterCommit = await backend.getRoot('save');
  assertEqual(afterCommit?.rootHash, 'new-browser-root', 'a new browser revision clears the local-root preference');

  console.info('[archive-read-through] 6 contracts passed');
}

void main();
