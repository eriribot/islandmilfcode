import assert from 'node:assert/strict';

import type { UiMessage } from '../types';
import { createInitialState, rollbackConversation } from '../state/store';

const createdAt = '2026-08-05T13:03:14.000Z';

function message(index: number): UiMessage {
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    speaker: index % 2 === 0 ? 'User' : 'Assistant',
    text: `floor ${index}`,
  };
}

async function main() {
  const state = createInitialState({ x: 0, y: 0 });
  state.uiMessages = [
    { id: 'system', role: 'system', speaker: 'system', text: '' },
    ...Array.from({ length: 16 }, (_, index) => message(index)),
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
