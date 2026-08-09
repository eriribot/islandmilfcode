import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'shujuku', 'IslandMilfCode数据库转发桥.js'), 'utf8');
const requestEvent = 'islandmilfcode:shujuku-relay:request:v1';
const responseEvent = 'islandmilfcode:shujuku-relay:response:v1';
const listeners = new Map();
const calls = [];
let exportCalls = 0;
let capturedGenerateOptions;
let qrfMode = 'immediate';
const hostChat = [{ message_id: 0, role: 'assistant', is_user: false, mes: 'HOST_ROOT' }];
const originalChat = hostChat;
const originalSaveChat = async () => { calls.push('host-save'); };
const originalSetChatMessages = async () => { calls.push('host-set'); };
const originalDeleteLastMessage = async () => { calls.push('host-delete'); };
const originalGetChatMessages = () => hostChat;
const originalGetLastMessageId = () => hostChat.length - 1;
const originalHelperSetChatMessages = async () => { calls.push('host-helper-set'); };
const originalCreateChatMessages = async () => { calls.push('host-create'); };
const originalDeleteChatMessages = async () => { calls.push('host-helper-delete'); };
const isolationKey = 'active';
const wrongIsolationKey = 'stale';

function eventOn(name, listener) {
  const group = listeners.get(name) ?? new Set();
  group.add(listener);
  listeners.set(name, group);
  return { stop: () => group.delete(listener) };
}

async function eventEmit(name, ...args) {
  for (const listener of [...(listeners.get(name) ?? [])]) await listener(...args);
}

const sillyTavern = {
  chat: originalChat,
  saveChat: originalSaveChat,
  setChatMessages: originalSetChatMessages,
  deleteLastMessage: originalDeleteLastMessage,
};

const tavernHelper = {
  getChatMessages: originalGetChatMessages,
  getLastMessageId: originalGetLastMessageId,
  setChatMessages: originalHelperSetChatMessages,
  createChatMessages: originalCreateChatMessages,
  deleteChatMessages: originalDeleteChatMessages,
  async generate(options) {
    calls.push('generate');
    capturedGenerateOptions = options;
    assert.equal(options.should_stream, false, 'contract: shujuku wrapper generation is non-streaming');
    assert.equal(options.should_silence, true, 'contract: shujuku wrapper generation is silent');
    assert.equal(options.generation_id, 'gen-1', 'contract: generation identity reaches wrapped generate');
    assert.equal(
      JSON.stringify(this.getChatMessages().map(message => message.mes)),
      JSON.stringify(['ROOT', 'HISTORY_USER', 'HISTORY_ASSISTANT', 'INPUT']),
      'contract: wrapped generate sees only the virtual timeline before assistant append',
    );
    const currentUser = this.getChatMessages().at(-1);
    if (qrfMode === 'immediate') {
      currentUser.qrf_plot = 'QRF_SENTINEL';
      currentUser.qrf_plot_tasks = { task: 'TASK_SENTINEL' };
    } else if (qrfMode === 'pending') {
      currentUser._qrf_from_planning = true;
      currentUser._qrf_plot_pending_hash = 'PENDING_SENTINEL';
    } else if (qrfMode === 'delayed') {
      setTimeout(() => { currentUser.qrf_plot = 'DELAYED_QRF_SENTINEL'; }, 300);
    }
    options.user_input = 'PLANNED_SENTINEL';
    return '<content>ASSISTANT_SENTINEL</content>';
  },
};

const api = {
  async triggerUpdate() {
    calls.push('triggerUpdate');
    const chat = sillyTavern.chat;
    if (qrfMode === 'immediate' || qrfMode === 'delayed') {
      assert.equal(
        chat.at(-2)?.qrf_plot,
        qrfMode === 'delayed' ? 'DELAYED_QRF_SENTINEL' : 'QRF_SENTINEL',
        'contract: current-user qrf is ready before assistant table triggering',
      );
    }
    assert.equal(chat.at(-1)?.mes, '<content>ASSISTANT_SENTINEL</content>', 'contract: triggerUpdate runs after virtual assistant append');
    chat[chat.length - 1] = {
      ...chat.at(-1),
      TavernDB_ACU_IsolatedData: {
        [wrongIsolationKey]: { storageFrame: { version: 2, logEntries: [{ id: 'STALE_SENTINEL' }] } },
        active: { storageFrame: { version: 2, logEntries: [{ id: 'STORAGE_SENTINEL' }] } },
      },
    };
    await sillyTavern.saveChat();
    return { success: true };
  },
  async exportTableAsJson() {
    exportCalls += 1;
    return { story: { revision: 2 } };
  },
  async restoreTableAsJson() { return true; },
  async importTableAsJson() { return true; },
};

const runtimeWindow = {
  TavernHelper: tavernHelper,
  SillyTavern: sillyTavern,
  original_TavernHelper_generate_ACU() {},
};
const frame = { id: 'TH-script--contract', contentWindow: runtimeWindow };
const hostDocument = { querySelectorAll: () => [frame] };
const context = {
  eventOn,
  eventEmit,
  AutoCardUpdaterAPI: api,
  document: hostDocument,
  parent: null,
  top: null,
  window: null,
  SillyTavern: { getContext: () => ({ extensionSettings: { activeIsolationKey: isolationKey } }) },
  crypto: webcrypto,
  TextEncoder,
  setTimeout,
  clearTimeout,
  console: { info() {}, warn() {}, error() {} },
};
context.parent = context;
context.top = context;
context.window = context;
vm.runInNewContext(source, context, { filename: 'IslandMilfCode数据库转发桥.js' });

function requestVirtualTurn(requestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${requestId} timed out`)), 5_000);
    const subscription = eventOn(responseEvent, response => {
      if (response?.requestId !== requestId) return;
      clearTimeout(timer);
      subscription.stop();
      resolve(response);
    });
    void eventEmit(requestEvent, {
      protocolVersion: 1,
      requestId,
      action: 'generateVirtual',
      inputJson: JSON.stringify({
        rootText: 'ROOT',
        messages: [
          { role: 'user', text: 'HISTORY_USER' },
          { role: 'assistant', text: 'HISTORY_ASSISTANT' },
          { role: 'user', text: 'INPUT', current: true },
        ],
        userInput: 'INPUT',
        systemPrompt: 'SYSTEM',
        generationId: 'gen-1',
        mode: 'turn',
      }),
    });
  });
}

const result = await requestVirtualTurn('contract-generate-1');

if (!result.ok) console.error('virtual relay response', result);
assert.equal(result.ok, true, 'contract: generateVirtual request is accepted');
assert.equal(result.action, 'generateVirtual');
assert.equal(result.result.rawText, '<content>ASSISTANT_SENTINEL</content>');
assert.equal(result.result.plannedText, 'PLANNED_SENTINEL');
assert.equal(result.result.userPluginData.qrf_plot, 'QRF_SENTINEL');
assert.equal(result.result.userPluginData.qrf_plot_tasks.task, 'TASK_SENTINEL');
assert.equal(result.result.assistantPluginData.TavernDB_ACU_IsolatedData.active.storageFrame.logEntries[0].id, 'STORAGE_SENTINEL');
assert.equal(result.result.tableSnapshot.tables.story.revision, 2);
assert.equal(result.result.planningObserved, true);
assert.equal(result.result.databaseCommitted, true);
assert.equal(result.result.diagnostics.adapterRestored, true);
assert.equal(result.result.diagnostics.databaseSaveCalls, 1);
assert.equal(result.result.diagnostics.databaseSaveBaseline, 0, 'contract: database evidence starts from this turn save baseline');
assert.equal(result.result.diagnostics.databaseSaveCallsAfterTrigger, 1, 'contract: database save is observed after trigger');
assert.equal(result.result.diagnostics.storageFrameLocation.includes(isolationKey), true, 'contract: storage evidence is scoped to the active isolation key');
assert.equal(result.result.diagnostics.storageFrameLocation.includes(wrongIsolationKey), false, 'contract: stale isolation evidence is ignored');
assert.equal(
  JSON.stringify(capturedGenerateOptions.overrides.chat_history.prompts),
  JSON.stringify([
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'HISTORY_USER' },
    { role: 'assistant', content: 'HISTORY_ASSISTANT' },
  ]),
  'contract: Island system/history reaches the wrapper exactly once without duplicating current input',
);
assert.deepEqual(calls.slice(0, 2), ['generate', 'triggerUpdate'], 'contract: planning generation precedes table trigger');
assert.equal(sillyTavern.chat, originalChat, 'contract: SillyTavern.chat is restored');
assert.equal(sillyTavern.saveChat, originalSaveChat, 'contract: SillyTavern.saveChat is restored');
assert.equal(sillyTavern.setChatMessages, originalSetChatMessages, 'contract: SillyTavern mutators are restored');
assert.equal(tavernHelper.getChatMessages, originalGetChatMessages, 'contract: TavernHelper readers are restored');
assert.equal(tavernHelper.getLastMessageId, originalGetLastMessageId, 'contract: TavernHelper id reader is restored');
assert.equal(tavernHelper.setChatMessages, originalHelperSetChatMessages, 'contract: TavernHelper setter is restored');
assert.equal(tavernHelper.createChatMessages, originalCreateChatMessages, 'contract: TavernHelper creator is restored');
assert.equal(tavernHelper.deleteChatMessages, originalDeleteChatMessages, 'contract: TavernHelper deleter is restored');
assert.deepEqual(hostChat, [{ message_id: 0, role: 'assistant', is_user: false, mes: 'HOST_ROOT' }], 'contract: host chat is never persisted');

qrfMode = 'missing';
const missingQrfResult = await requestVirtualTurn('contract-generate-missing-qrf');
assert.equal(missingQrfResult.ok, true, 'contract: missing qrf remains an explicit result instead of a relay transport error');
assert.equal(missingQrfResult.result.plannedText, 'PLANNED_SENTINEL');
assert.equal(
  missingQrfResult.result.planningObserved,
  false,
  'contract: rewritten plannedText cannot impersonate qrf written to the current virtual user',
);

qrfMode = 'pending';
const pendingOnlyResult = await requestVirtualTurn('contract-generate-pending-only');
assert.equal(
  pendingOnlyResult.result.planningObserved,
  false,
  'contract: internal qrf pending markers cannot impersonate a completed planning result',
);

qrfMode = 'delayed';
const delayedQrfResult = await requestVirtualTurn('contract-generate-delayed-qrf');
assert.equal(delayedQrfResult.ok, true, 'contract: delayed current-user qrf remains inside the bounded polling window');
assert.equal(delayedQrfResult.result.planningObserved, true);
assert.equal(delayedQrfResult.result.userPluginData.qrf_plot, 'DELAYED_QRF_SENTINEL');

console.info('[shujuku-v2-virtual-relay] 30 contracts passed');
