import { buildPrompt, resolveNarrativeRoute } from '../message-format';
import { createInitialState } from '../state/store';
import type { ShujukuCompatibilityState } from '../types';

function assertEqual(actual: string, expected: string, contract: string) {
  if (actual === expected) return;
  throw new Error(`${contract}: values differ`);
}

function assertIncludes(actual: string, expected: string, contract: string) {
  if (actual.includes(expected)) return;
  throw new Error(`${contract}: missing ${expected}`);
}

function assertExcludes(actual: string, expected: string, contract: string) {
  if (!actual.includes(expected)) return;
  throw new Error(`${contract}: unexpectedly included ${expected}`);
}

const MEMORY_SENTINEL = 'ISLAND_MEMORY_SENTINEL_SHOULD_NOT_REACH_SHUJUKU';
const SUMMARY_SENTINEL = 'ISLAND_SUMMARY_SENTINEL_SHOULD_NOT_REACH_SHUJUKU';
const HISTORY_SENTINEL = 'ISLAND_HISTORY_SENTINEL_SHOULD_NOT_REACH_SHUJUKU';
const CURRENT_INPUT = 'CURRENT_INPUT_MUST_REMAIN';
const CURRENT_TIME = '2042-03-04 05:06';
const CURRENT_LOCATION = 'HARD_LOCATION_MUST_REMAIN';
const CURRENT_EVENT = 'HARD_ROUTE_MUST_REMAIN';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  },
});

const state = createInitialState({ x: 0, y: 0 });
state.statusData.world.currentTime = CURRENT_TIME;
state.statusData.world.currentLocation = CURRENT_LOCATION;
state.statusData.world.currentMainEventId = CURRENT_EVENT;
state.statusData.world.mainEvents[CURRENT_EVENT] = '进行中';
state.uiMessages = [
  { id: 'system', role: 'system', speaker: 'System', text: '' },
  { id: 'history', role: 'assistant', speaker: 'Assistant', text: HISTORY_SENTINEL },
];
state.summaryStore.global = SUMMARY_SENTINEL;
state.memoryDB.summaries.push({
  id: 'memory-sentinel',
  createdAt: '2042-03-04T05:06:00.000Z',
  updatedAt: '2042-03-04T05:06:00.000Z',
  source: 'summary-global',
  level: 'global',
  range: [0, 1],
  text: MEMORY_SENTINEL,
});

const sharedOptions = {
  memoryDB: state.memoryDB,
  suppressUserInputLine: false,
};

const defaultPrompt = buildPrompt(
  state.statusData,
  state.uiMessages,
  CURRENT_INPUT,
  state.summaryStore,
  sharedOptions,
);
const islandPrompt = buildPrompt(
  state.statusData,
  state.uiMessages,
  CURRENT_INPUT,
  state.summaryStore,
  { ...sharedOptions, narrativeRoute: 'island' },
);
const shujukuPrompt = buildPrompt(
  state.statusData,
  state.uiMessages,
  CURRENT_INPUT,
  state.summaryStore,
  { ...sharedOptions, narrativeRoute: 'shujuku' },
);
const shujukuSummaryFallbackPrompt = buildPrompt(
  state.statusData,
  state.uiMessages,
  CURRENT_INPUT,
  state.summaryStore,
  { memoryDB: null, narrativeRoute: 'shujuku' },
);

const compatibility: ShujukuCompatibilityState = {
  route: 'shujuku',
  handoffPhase: 'committed',
  branchId: 'branch-contract',
};
state.runtimeFlags.shujukuCompatibility = compatibility;

assertEqual(defaultPrompt, islandPrompt, 'contract: an omitted route remains exactly compatible with the Island route');
assertIncludes(islandPrompt, MEMORY_SENTINEL, 'contract: the Island route retains Island memoryDB recall');
assertIncludes(islandPrompt, HISTORY_SENTINEL, 'contract: the Island route retains Island conversation history');
assertExcludes(shujukuPrompt, MEMORY_SENTINEL, 'contract: shujuku excludes Island memoryDB recall');
assertExcludes(shujukuPrompt, HISTORY_SENTINEL, 'contract: shujuku excludes Island conversation history');
assertExcludes(
  shujukuSummaryFallbackPrompt,
  SUMMARY_SENTINEL,
  'contract: shujuku excludes the legacy SummaryStore fallback',
);
assertIncludes(shujukuPrompt, CURRENT_INPUT, 'contract: shujuku retains the current player input');
assertIncludes(shujukuPrompt, CURRENT_TIME, 'contract: shujuku retains the exact hard-state time');
assertIncludes(shujukuPrompt, CURRENT_LOCATION, 'contract: shujuku retains the hard-state location');
assertIncludes(shujukuPrompt, CURRENT_EVENT, 'contract: shujuku retains the active route/event state');
assertIncludes(shujukuPrompt, '玩家性别与关系边界', 'contract: shujuku retains Island hard rules');
assertEqual(
  resolveNarrativeRoute(state.runtimeFlags.shujukuCompatibility),
  'shujuku',
  'contract: a per-save committed compatibility route reaches prompt routing',
);
assertEqual(resolveNarrativeRoute(undefined), 'island', 'contract: old saves default to the Island route');
assertEqual(resolveNarrativeRoute({ route: 'invalid' }), 'island', 'contract: malformed save routes fail closed to Island');
assertEqual(
  resolveNarrativeRoute({ route: 'shujuku', handoffPhase: 'pending', branchId: 'branch-contract' }),
  'island',
  'contract: an uncommitted handoff cannot disable Island memory',
);

console.info('[shujuku-v2-prompt-isolation] 15 contracts passed');
