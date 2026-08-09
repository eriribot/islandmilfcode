import assert from 'node:assert/strict';

import {
  inspectCommittedShujukuBinding,
  SHUJUKU_NATIVE_HANDOFF_VERSION,
} from '../shujuku/adapter';

const identity = { saveId: 'save-contract', runId: 'run-contract' };

function validFlags(): Record<string, unknown> {
  return {
    shujukuCompatibility: {
      route: 'shujuku',
      handoffPhase: 'committed',
      branchId: 'branch-contract',
      runId: identity.runId,
      saveId: identity.saveId,
      isolationKey: 'isolation-contract',
      handoffId: 'handoff-contract',
      mappingVersion: SHUJUKU_NATIVE_HANDOFF_VERSION,
      lastTableHash: 'table-current',
    },
    shujukuHandoff: {
      handoffId: 'handoff-contract',
      runId: identity.runId,
      saveId: identity.saveId,
      branchId: 'branch-contract',
      timelineAnchor: 'assistant-before-handoff',
      cutoffFloor: 10,
      mappingVersion: SHUJUKU_NATIVE_HANDOFF_VERSION,
      sourceHash: 'source-contract',
      tableHash: 'table-at-handoff',
      status: 'committed',
    },
    shujukuTableSnapshot: {
      capturedAt: '2026-08-09T00:00:00.000Z',
      tableHash: 'table-current',
      tables: { story: { revision: 2 } },
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const valid = validFlags();
assert.equal(
  inspectCommittedShujukuBinding(valid, identity).kind,
  'active',
  'contract: a complete committed binding stays active after current tables advance beyond the handoff baseline',
);

const missingHandoffTableHash = clone(valid);
(missingHandoffTableHash.shujukuHandoff as Record<string, unknown>).tableHash = '';
assert.equal(
  inspectCommittedShujukuBinding(missingHandoffTableHash, identity).kind,
  'invalid',
  'contract: reroll requires a persisted handoff table baseline hash',
);

const missingBranch = clone(valid);
delete (missingBranch.shujukuCompatibility as Record<string, unknown>).branchId;
assert.equal(
  inspectCommittedShujukuBinding(missingBranch, identity).kind,
  'invalid',
  'contract: a UI label cannot call a branchless binding connected',
);

const mismatchedHandoff = clone(valid);
(mismatchedHandoff.shujukuHandoff as Record<string, unknown>).branchId = 'other-branch';
assert.equal(
  inspectCommittedShujukuBinding(mismatchedHandoff, identity).kind,
  'invalid',
  'contract: compatibility and handoff identities cannot select different routes',
);

const wrongSave = clone(valid);
assert.equal(
  inspectCommittedShujukuBinding(wrongSave, { ...identity, saveId: 'other-save' }).kind,
  'invalid',
  'contract: a binding from another active save cannot reach shujuku',
);

const missingSnapshot = clone(valid);
delete missingSnapshot.shujukuTableSnapshot;
assert.equal(
  inspectCommittedShujukuBinding(missingSnapshot, identity).kind,
  'invalid',
  'contract: the first post-handoff turn requires a persisted before-turn table baseline',
);

const mismatchedCurrentHash = clone(valid);
(mismatchedCurrentHash.shujukuCompatibility as Record<string, unknown>).lastTableHash = 'other-table';
assert.equal(
  inspectCommittedShujukuBinding(mismatchedCurrentHash, identity).kind,
  'invalid',
  'contract: the current table snapshot must match the compatibility head',
);

const reviewState = clone(valid);
(reviewState.shujukuCompatibility as Record<string, unknown>).handoffPhase = 'needs_review';
assert.equal(
  inspectCommittedShujukuBinding(reviewState, identity).kind,
  'inactive',
  'contract: a review-only route does not claim an active committed binding',
);

const islandState = clone(valid);
(islandState.shujukuCompatibility as Record<string, unknown>).route = 'island';
assert.equal(
  inspectCommittedShujukuBinding(islandState, identity).kind,
  'inactive',
  'contract: an explicit Island route remains inactive for shujuku',
);

console.info('[shujuku-v2-route-binding] 9 contracts passed');
