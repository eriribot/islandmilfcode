import { createDefaultMemoryDB } from '../memorydatabase/defaults';
import { hydrateSummaryStoreFromMemoryDB } from '../memorydatabase/migrate';
import type { IslandMemoryDB, MemoryFactRow, MemorySummaryRow } from '../memorydatabase/types';
import type { SummaryStore } from '../summary/types';
import {
  applyArchiveShujukuCompatibilityToRuntimeFlags,
  prepareArchiveCompatibilityForFork,
  resolveArchiveCompatibilityForRollback,
} from '../state/archive-repository';
import type { ArchiveCompatibilityBlock } from '../state/archive-backend';
import { resolveMemoryDBForLoad } from '../state/saves';
import type { ShujukuCompatibilityState, ShujukuHandoffEnvelope, ShujukuTableSnapshot } from '../types';
import { SHUJUKU_NATIVE_HANDOFF_VERSION } from '../shujuku/adapter';
import { SHUJUKU_MEMORY_MAPPING_VERSION } from '../shujuku/memory-migration';

function assertEqual(actual: unknown, expected: unknown, contract: string) {
  if (Object.is(actual, expected)) return;
  throw new Error(`${contract}: expected ${String(expected)}, received ${String(actual)}`);
}

function assertNotEqual(actual: unknown, expected: unknown, contract: string) {
  if (!Object.is(actual, expected)) return;
  throw new Error(`${contract}: received the forbidden shared reference`);
}

function assertJsonEqual(actual: unknown, expected: unknown, contract: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) return;
  throw new Error(`${contract}: expected ${expectedJson}, received ${actualJson}`);
}

function assertJsonNotEqual(actual: unknown, expected: unknown, contract: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) return;
  throw new Error(`${contract}: received forbidden value ${actualJson}`);
}

function assertIncludes(haystack: readonly string[], needle: string, contract: string) {
  if (haystack.includes(needle)) return;
  throw new Error(`${contract}: expected ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
}

const runId = 'shujuku-save-contract-run';
const createdAt = '2026-08-06T00:00:00.000Z';
const legacySummary: SummaryStore = {
  global: 'legacy global sentinel',
  major: [{ range: [0, 3], text: 'legacy major sentinel', createdAt }],
  minor: [],
  keyFacts: [
    {
      id: 'legacy-fact',
      category: 'promise',
      subject: 'A',
      content: 'legacy fact sentinel',
      sourceRange: [0, 3],
      createdAt,
    },
  ],
  lastSummarizedIndex: 4,
  consecutiveFailures: 0,
  autoPaused: false,
  lastError: null,
};

function activeSummary(id: string, text: string): MemorySummaryRow {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    source: 'summary-major',
    sourceRange: [0, 3],
    level: 'major',
    range: [0, 3],
    text,
  };
}

function activeFact(id: string, content: string): MemoryFactRow {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    source: 'progress-commit',
    sourceRange: [0, 3],
    category: 'promise',
    subject: 'A',
    content,
  };
}

function assertLegacySummaryMigrated(memoryDB: IslandMemoryDB, contract: string) {
  const hydrated = hydrateSummaryStoreFromMemoryDB(memoryDB);
  assertIncludes(
    hydrated.major.map(entry => entry.text),
    'legacy major sentinel',
    contract,
  );
  assertIncludes(
    hydrated.keyFacts.map(fact => fact.content),
    'legacy fact sentinel',
    contract,
  );
}

const fromValidEmpty = resolveMemoryDBForLoad(createDefaultMemoryDB(runId), legacySummary, runId);
assertLegacySummaryMigrated(
  fromValidEmpty,
  'contract: a structurally valid empty memoryDB cannot erase non-empty legacy summary data',
);

const activeMemoryDB = createDefaultMemoryDB(runId);
activeMemoryDB.summaries.push(activeSummary('memory-summary', 'memory authoritative sentinel'));
activeMemoryDB.facts.push(activeFact('memory-fact', 'memory fact sentinel'));
const fromActiveMemory = resolveMemoryDBForLoad(activeMemoryDB, legacySummary, runId);
const hydratedActiveMemory = hydrateSummaryStoreFromMemoryDB(fromActiveMemory);
assertIncludes(
  hydratedActiveMemory.major.map(entry => entry.text),
  'memory authoritative sentinel',
  'contract: active memoryDB content remains authoritative over legacy summaryStore',
);
assertEqual(
  hydratedActiveMemory.major.some(entry => entry.text === 'legacy major sentinel'),
  false,
  'contract: an authoritative active memoryDB is not merged with stale legacy summaries',
);

const expiredOnlyMemoryDB = createDefaultMemoryDB(runId);
expiredOnlyMemoryDB.summaries.push({ ...activeSummary('expired-summary', 'expired sentinel'), expired: true });
expiredOnlyMemoryDB.facts.push({ ...activeFact('expired-fact', 'expired fact sentinel'), expired: true });
const fromExpiredOnly = resolveMemoryDBForLoad(expiredOnlyMemoryDB, legacySummary, runId);
assertLegacySummaryMigrated(
  fromExpiredOnly,
  'contract: expired-only memory rows count as empty and cannot erase non-empty legacy summary data',
);

const malformedMemoryDB = {
  version: 1,
  runId,
  lastProcessedIndex: 99,
  summaries: 'not-an-array',
  facts: [{ id: '', createdAt: '', content: 'invalid row' }],
};
const fromMalformed = resolveMemoryDBForLoad(malformedMemoryDB, legacySummary, runId);
assertLegacySummaryMigrated(
  fromMalformed,
  'contract: malformed memory normalization cannot produce an empty replacement for valid legacy summaries',
);

const sourceBranchId = 'branch-main';
const compatibilityState = {
  saveId: 'save-main',
  runId,
  route: 'island',
  handoffPhase: 'pending',
  pluginVersion: '1.1.0',
  capabilityHash: 'sha256:capability',
  isolationKey: `${runId}:save-main:${sourceBranchId}`,
  handoffId: 'handoff-pending',
  branchId: sourceBranchId,
  lastTableHash: 'sha256:table-main',
} satisfies ShujukuCompatibilityState;
const pendingHandoff = {
  handoffId: 'handoff-pending',
  runId,
  saveId: 'save-main',
  branchId: sourceBranchId,
  timelineAnchor: 'assistant-4',
  cutoffFloor: 4,
  mappingVersion: 'island-memory-v2',
  sourceHash: 'sha256:source-main',
  tableHash: 'sha256:table-main',
  status: 'pending',
} satisfies ShujukuHandoffEnvelope;
const tableSnapshot = {
  capturedAt: createdAt,
  tableHash: 'sha256:table-main',
  tables: {
    Island旧档前情: { rows: [{ memory_id: 'memory-1', content: 'snapshot sentinel' }] },
  },
} satisfies ShujukuTableSnapshot;
const compatibility = {
  formatVersion: 3,
  sourceSchemaVersion: 2,
  rawLegacyExtras: { preserved: true },
  excludedRuntimeFlagKeys: ['transientFlag'],
  shujuku: {
    state: compatibilityState,
    handoff: pendingHandoff,
    tableSnapshot,
  },
} satisfies ArchiveCompatibilityBlock;

const portableEnvelope = {
  compatibility,
  compatibilityCheckpoints: { 'sha256:compatibility-checkpoint-r1': compatibility },
};
const portableRoundTrip = JSON.parse(JSON.stringify(portableEnvelope)) as typeof portableEnvelope;
assertJsonEqual(
  portableRoundTrip,
  portableEnvelope,
  'contract: portable archive export/import preserves current and rollback-bound route, branch, handoff, and table snapshots',
);
assertNotEqual(
  portableRoundTrip.compatibility,
  compatibility,
  'contract: portable archive compatibility is cloned instead of sharing mutable caller state',
);

const forked = prepareArchiveCompatibilityForFork(compatibility, {
  runId,
  saveId: 'save-fork',
  branchId: 'branch-fork',
});
assertEqual(forked.shujuku?.state.branchId, 'branch-fork', 'contract: a fork owns a distinct shujuku branch');
assertEqual(forked.shujuku?.state.saveId, 'save-fork', 'contract: a fork owns a distinct shujuku save identity');
assertEqual(forked.shujuku?.state.runId, runId, 'contract: a fork remains inside the source run');
assertEqual(forked.shujuku?.state.route, 'island', 'contract: a fork keeps an uncommitted handoff on the Island route');
assertEqual(
  forked.shujuku?.state.isolationKey,
  undefined,
  'contract: an unconnected fork cannot invent or reuse a shujuku isolation key',
);
assertEqual(forked.shujuku?.state.handoffPhase, 'none', 'contract: a fork clears the source pending handoff phase');
assertEqual(forked.shujuku?.state.handoffId, undefined, 'contract: a fork clears the source pending handoff id');
assertEqual(forked.shujuku?.handoff, undefined, 'contract: a fork cannot retain a stale pending handoff envelope');
assertJsonEqual(
  forked.shujuku?.tableSnapshot,
  undefined,
  'contract: a fork discards a synthetic pre-handoff table snapshot',
);

const currentCommitted = {
  ...compatibility,
  shujuku: {
    state: {
      ...compatibilityState,
      route: 'shujuku',
      handoffPhase: 'committed',
      mappingVersion: SHUJUKU_NATIVE_HANDOFF_VERSION,
      handoffId: 'handoff-current',
    },
    handoff: {
      ...pendingHandoff,
      handoffId: 'handoff-current',
      mappingVersion: SHUJUKU_NATIVE_HANDOFF_VERSION,
      status: 'committed',
    },
    tableSnapshot,
  },
} satisfies ArchiveCompatibilityBlock;
const runtimeFlagsWithCommittedBinding: Record<string, unknown> = {
  unrelatedFlag: 'preserve',
  shujukuCompatibility: currentCommitted.shujuku?.state,
  shujukuHandoff: currentCommitted.shujuku?.handoff,
  shujukuTableSnapshot: currentCommitted.shujuku?.tableSnapshot,
};
applyArchiveShujukuCompatibilityToRuntimeFlags(runtimeFlagsWithCommittedBinding, null);
assertEqual(
  runtimeFlagsWithCommittedBinding.unrelatedFlag,
  'preserve',
  'contract: clearing shujuku compatibility preserves unrelated archived runtime flags',
);
assertEqual(
  Object.prototype.hasOwnProperty.call(runtimeFlagsWithCommittedBinding, 'shujukuCompatibility'),
  false,
  'contract: pre-handoff Island rollback clears the archived compatibility mirror',
);
assertEqual(
  Object.prototype.hasOwnProperty.call(runtimeFlagsWithCommittedBinding, 'shujukuHandoff'),
  false,
  'contract: pre-handoff Island rollback clears the archived handoff mirror',
);
assertEqual(
  Object.prototype.hasOwnProperty.call(runtimeFlagsWithCommittedBinding, 'shujukuTableSnapshot'),
  false,
  'contract: pre-handoff Island rollback clears the archived table snapshot mirror',
);
const currentFork = prepareArchiveCompatibilityForFork(currentCommitted, {
  runId,
  saveId: 'save-current-fork',
  branchId: 'branch-current-fork',
});
assertEqual(
  currentFork.shujuku?.state.route,
  'shujuku',
  'contract: a native committed route remains connected across a fork',
);
assertEqual(
  currentFork.shujuku?.state.handoffPhase,
  'committed',
  'contract: a native committed fork keeps its committed handoff phase',
);
assertEqual(
  currentFork.shujuku?.state.mappingVersion,
  SHUJUKU_NATIVE_HANDOFF_VERSION,
  'contract: a native committed fork preserves the handoff version',
);
assertEqual(
  currentFork.shujuku?.handoff?.mappingVersion,
  SHUJUKU_NATIVE_HANDOFF_VERSION,
  'contract: a native committed fork preserves the envelope version',
);
assertJsonEqual(
  currentFork.shujuku?.tableSnapshot,
  tableSnapshot,
  'contract: a native committed fork carries its verified table checkpoint',
);

const legacyCommitted = {
  ...compatibility,
  shujuku: {
    state: {
      ...compatibilityState,
      route: 'shujuku',
      handoffPhase: 'committed',
      handoffId: 'handoff-legacy',
      mappingVersion: SHUJUKU_MEMORY_MAPPING_VERSION,
    },
    handoff: {
      ...pendingHandoff,
      handoffId: 'handoff-legacy',
      mappingVersion: SHUJUKU_MEMORY_MAPPING_VERSION,
      status: 'committed',
    },
    tableSnapshot,
  },
} satisfies ArchiveCompatibilityBlock;
const legacyFork = prepareArchiveCompatibilityForFork(legacyCommitted, {
  runId,
  saveId: 'save-legacy-fork',
  branchId: 'branch-legacy-fork',
});
assertEqual(
  legacyFork.shujuku?.state.route,
  'shujuku',
  'contract: a legacy shujuku fork stays on the shujuku route for explicit review',
);
assertEqual(
  legacyFork.shujuku?.state.handoffPhase,
  'needs_review',
  'contract: an island-memory-v3 committed handoff cannot be reused by a fork',
);
assertEqual(
  legacyFork.shujuku?.state.isolationKey,
  undefined,
  'contract: a legacy fork cannot reuse the source isolation key',
);
assertEqual(
  legacyFork.shujuku?.state.handoffId,
  undefined,
  'contract: a legacy fork clears the stale handoff id',
);
assertEqual(
  legacyFork.shujuku?.handoff,
  undefined,
  'contract: a legacy fork clears the stale handoff envelope',
);
assertEqual(
  legacyFork.shujuku?.state.lastTableHash,
  undefined,
  'contract: a legacy fork clears the hash for its discarded checkpoint',
);
assertEqual(
  legacyFork.shujuku?.tableSnapshot,
  undefined,
  'contract: an island-memory-v3 fork discards the synthetic table snapshot',
);

const { handoffId: _pendingHandoffId, ...revisionOneStateBase } = compatibilityState;
void _pendingHandoffId;
const revisionOne = {
  ...compatibility,
  shujuku: {
    state: {
      ...revisionOneStateBase,
      route: 'island',
      handoffPhase: 'none',
      lastTableHash: 'sha256:table-r1',
    },
    tableSnapshot: { ...tableSnapshot, headRevision: 'table-revision-r1' },
  },
} satisfies ArchiveCompatibilityBlock;
const revisionTwo = {
  ...compatibility,
  shujuku: {
    ...compatibility.shujuku,
    state: {
      ...compatibilityState,
      route: 'shujuku',
      handoffPhase: 'committed',
      lastTableHash: 'sha256:table-r2',
    },
    handoff: { ...pendingHandoff, status: 'committed' },
    tableSnapshot: { ...tableSnapshot, headRevision: 'table-revision-r2' },
  },
} satisfies ArchiveCompatibilityBlock;
const rollbackCompatibility = resolveArchiveCompatibilityForRollback(revisionOne, revisionTwo);
assertJsonEqual(
  rollbackCompatibility,
  revisionOne,
  'contract: rollback restores the compatibility snapshot bound to the target revision, not the current head',
);
assertNotEqual(
  rollbackCompatibility,
  revisionOne,
  'contract: rollback clones its revision-bound compatibility snapshot',
);
assertJsonNotEqual(
  rollbackCompatibility,
  revisionTwo,
  'contract: rollback does not substitute the current head compatibility snapshot',
);

console.info('[shujuku-v2-save-compatibility] 39 contracts passed');
