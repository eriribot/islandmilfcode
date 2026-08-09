import { deserializeMessages, serializeMessages } from '../state/store';
import { buildLegacyV2ToV3MigrationPlan } from '../state/save-migration';
import type { PersistedMessage, ShujukuHandoffEnvelope, UiMessage } from '../types';

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

const exchangeId = 'shujuku-codec-contract-1';
const handoff = {
  handoffId: 'codec-run:codec-save:branch-main:logical-assistant-1:1:island-memory-v2',
  runId: 'codec-run',
  saveId: 'codec-save',
  branchId: 'branch-main',
  timelineAnchor: 'logical-assistant-1',
  cutoffFloor: 1,
  mappingVersion: 'island-memory-v2',
  sourceHash: 'sha256:source',
  status: 'pending',
} satisfies ShujukuHandoffEnvelope;
const user: UiMessage = {
  id: 'logical-user-1',
  role: 'user',
  speaker: 'User',
  text: 'input',
};
const assistant: UiMessage = {
  id: 'logical-assistant-1',
  role: 'assistant',
  speaker: 'Assistant',
  text: 'story',
};

// Prime the serializer cache before shujuku writes its delayed evidence.
serializeMessages([user, assistant]);

user.exchangeId = exchangeId;
user.plannedText = 'planned input';
user.pluginData = {
  qrf_plot: 'planned plot',
  qrf_plot_preset: 'preset-v1',
  qrf_plot_tasks: { main: 'advance scene' },
  _qrf_from_planning: true,
  _qrf_plot_pending_hash: 'input-hash-1',
  future_extension: { preserved: true },
};
assistant.exchangeId = exchangeId;
assistant.pluginData = {
  TavernDB_ACU_IsolatedData: {
    island: {
      _acu_storage_version: 2,
      storageFrame: {
        version: 2,
        headRevision: 'table-revision-1',
        checkpoint: { kind: 'full', revision: 'table-revision-1' },
        logEntries: [],
      },
    },
  },
};

const persisted = serializeMessages([user, assistant]);
const hydrated = deserializeMessages(JSON.parse(JSON.stringify(persisted)) as PersistedMessage[]);

assertEqual(hydrated.length, 2, 'contract: one logical exchange survives the message codec');
assertEqual(hydrated[0].exchangeId, exchangeId, 'contract: qrf remains bound to its logical exchange');
assertEqual(hydrated[1].exchangeId, exchangeId, 'contract: storageFrame remains bound to its logical exchange');
assertEqual(hydrated[0].plannedText, 'planned input', 'contract: plannedText survives persistence');
assertEqual(hydrated[0].pluginData?.qrf_plot, 'planned plot', 'contract: qrf remains on the logical user');
assertEqual(hydrated[0].pluginData?.qrf_plot_preset, 'preset-v1', 'contract: qrf preset survives persistence');
assertJsonEqual(
  hydrated[0].pluginData?.qrf_plot_tasks,
  { main: 'advance scene' },
  'contract: qrf task results survive persistence',
);
assertJsonEqual(
  hydrated[0].pluginData?.future_extension,
  { preserved: true },
  'contract: unknown plugin extensions survive inside the controlled pluginData container',
);
assertJsonEqual(
  hydrated[1].pluginData,
  assistant.pluginData,
  'contract: storageFrame remains on the matching logical assistant after a cached re-save',
);

const migrationPlan = buildLegacyV2ToV3MigrationPlan({
  saveId: 'codec-save',
  runId: 'codec-run',
  version: 2,
  gameState: { runId: 'codec-run' },
  chatLog: persisted,
});
const migratedFloor = migrationPlan.floors[0];
assertEqual(
  migratedFloor.userMessage.exchangeId,
  exchangeId,
  'contract: v2-to-v3 migration preserves the logical exchange binding',
);
assertJsonEqual(
  migratedFloor.userMessage.pluginData,
  user.pluginData,
  'contract: v2-to-v3 migration preserves qrf and unknown plugin extensions',
);
assertJsonEqual(
  migratedFloor.assistantMessage?.pluginData,
  assistant.pluginData,
  'contract: v2-to-v3 migration preserves the matching assistant storageFrame',
);
assertEqual(handoff.status, 'pending', 'contract: handoff envelope has a typed pending state');

console.info('[shujuku-v2-message-codec] 13 contracts passed');
