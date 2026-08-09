import assert from 'node:assert/strict';

import type { UiMessage } from '../types';
import {
  createInitialState,
  createRollbackSnapshot,
  hasAuthoritativeFloorStatusData,
  restoreFloorStateSnapshot,
  rollbackConversation,
} from '../state/store';
import type { FloorSnapshotFieldSource, FloorStateSnapshot } from '../types';

const createdAt = '2026-08-05T13:03:14.000Z';
const beforeTurnTime = '2012-03-30 22:15';
const headTime = '2012-03-31 08:30';

function message(index: number): UiMessage {
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    speaker: index % 2 === 0 ? 'User' : 'Assistant',
    text: `floor ${index}`,
  };
}

function floorSnapshot(state: ReturnType<typeof createInitialState>, source: FloorSnapshotFieldSource): FloorStateSnapshot {
  return {
    statusData: JSON.parse(JSON.stringify(state.statusData)),
    playerProfile: JSON.parse(JSON.stringify(state.playerProfile)),
    phoneState: {
      activeThreadId: state.phoneMessages.activeThreadId,
      draft: state.phoneMessages.draft,
      threads: {},
    },
    drawingSettings: JSON.parse(JSON.stringify(state.drawingSettings)),
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

function verifyFloorTimeProvenance() {
  const state = createInitialState({ x: 0, y: 0 });
  state.statusData.world.currentTime = beforeTurnTime;
  const exact = floorSnapshot(state, 'message-snapshot');
  state.statusData.world.currentTime = headTime;
  restoreFloorStateSnapshot(state, exact);
  assert.equal(
    state.statusData.world.currentTime,
    beforeTurnTime,
    'an exact message snapshot restores its before-turn time',
  );

  const fallback = floorSnapshot(state, 'save-current-fallback');
  assert.equal(hasAuthoritativeFloorStatusData(fallback), false, 'save-current fallback is not a reroll time authority');
  fallback.statusData.world.currentTime = '2012-01-01 00:00';
  state.statusData.world.currentTime = headTime;
  restoreFloorStateSnapshot(state, fallback);
  assert.equal(
    state.statusData.world.currentTime,
    headTime,
    'a save-current fallback cannot overwrite the current time with a fabricated historical baseline',
  );

  const defaulted = floorSnapshot(state, 'defaulted');
  assert.equal(hasAuthoritativeFloorStatusData(defaulted), false, 'defaulted status is not a reroll time authority');
  defaulted.statusData.world.currentTime = '2012-01-02 00:00';
  state.statusData.world.currentTime = headTime;
  restoreFloorStateSnapshot(state, defaulted);
  assert.equal(
    state.statusData.world.currentTime,
    headTime,
    'a defaulted snapshot cannot overwrite the current time with a fabricated historical baseline',
  );
}

async function main() {
  verifyFloorTimeProvenance();
  const state = createInitialState({ x: 0, y: 0 });
  state.statusData.world.currentTime = beforeTurnTime;
  const beforeTurnSnapshot = createRollbackSnapshot(state);
  state.statusData.world.currentTime = headTime;
  const residentMessages = Array.from({ length: 16 }, (_, index) => message(index));
  residentMessages[14].statusSnapshot = beforeTurnSnapshot;
  state.uiMessages = [
    { id: 'system', role: 'system', speaker: 'system', text: '' },
    ...residentMessages,
  ];
  state.messageWindow = {
    startFloor: 229,
    endFloorExclusive: 245,
    startMessage: 229,
    endMessageExclusive: 245,
    totalFloorCount: 245,
    totalMessageCount: 245,
  };
  state.summaryStore.major = [
    { range: [0, 104], text: 'major-a', createdAt },
    { range: [105, 239], text: 'major-b', createdAt },
  ];
  state.summaryStore.minor = [{ range: [240, 244], text: 'minor-tail', createdAt }];
  state.summaryStore.global = 'global-before-rollback';
  state.summaryStore.lastSummarizedIndex = 245;
  state.memoryDB.lastProcessedIndex = 245;
  state.memoryDB.summaries.push(
    {
      id: 'major-a',
      createdAt,
      updatedAt: createdAt,
      source: 'summary-major',
      sourceRange: [0, 104],
      level: 'major',
      range: [0, 104],
      text: 'major-a',
    },
    {
      id: 'major-b',
      createdAt,
      updatedAt: createdAt,
      source: 'summary-major',
      sourceRange: [105, 239],
      level: 'major',
      range: [105, 239],
      text: 'major-b',
    },
    {
      id: 'minor-tail',
      createdAt,
      updatedAt: createdAt,
      source: 'summary-minor',
      sourceRange: [240, 244],
      level: 'minor',
      range: [240, 244],
      text: 'minor-tail',
    },
  );

  const result = await rollbackConversation(state, 14);
  assert.ok(result, 'rollback target must exist');
  assert.equal(
    state.statusData.world.currentTime,
    beforeTurnTime,
    'reroll restores the exact user before-turn time instead of retaining the current head time',
  );
  assert.equal(state.memoryDB.lastProcessedIndex, 243, 'memory cursor uses the global rollback boundary');
  assert.equal(state.summaryStore.lastSummarizedIndex, 243, 'summary cursor uses the global rollback boundary');
  assert.deepEqual(
    state.memoryDB.summaries.filter(row => !row.expired).map(row => row.id),
    ['major-a', 'major-b'],
    'only the summary crossing the global rollback boundary is retired',
  );
  assert.deepEqual(
    state.summaryStore.major.map(entry => entry.text),
    ['major-a', 'major-b'],
    'resident slice length must not erase earlier major summaries',
  );
}

void main();
