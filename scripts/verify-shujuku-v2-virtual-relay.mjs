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
const progressAckEvent = 'islandmilfcode:shujuku-relay:progress-ack:v1';
const cancelEvent = 'islandmilfcode:shujuku-relay:cancel:v1';
const listeners = new Map();
const calls = [];
const planningProgresses = [];
const planningDescriptions = [];
const bodyPromptDescriptions = [];
const bodyPersonaDescriptions = [];
const triggerDescriptions = [];
let exportCalls = 0;
let capturedGenerateOptions;
let qrfMode = 'immediate';
let planningSaveMode = 'none';
let databaseMode = 'native';
let tableFillProvider = 'generateRaw';
let tableFillResponse = '{"format":"table_edit_ops_v1","ops":[]}';
let tableFillPrompt = 'Return only {"format":"table_edit_ops_v1","ops":[]}';
let tableRevision = 2;
let restoreCalls = 0;
let runtimeTableDataOverride = null;
let expectedGenerationId = 'gen-1';
const planningContextKey = '_islandmilfcode_planning_context_v1';
const planningUserName = '结城理';
const planningContextSentinel = `【当前玩家 User 身份（权威）】\n- User 姓名：${planningUserName}`;
const presentRoleCardSentinel = 'PRESENT_ROLE_ZERO_SENTINEL';
const absentRoleCardSentinel = 'ABSENT_ROLE_ZERO_SENTINEL';
const currentPlotSentinel = 'CURRENT_PLOT_SENTINEL';
const bodyContextSentinel = [presentRoleCardSentinel, currentPlotSentinel].join('\n');
const baseCharacterDescription = 'BASE_CHARACTER_DESCRIPTION';
const isolationKey = 'active';
const archivedIsolationKey = 'archived';
const wrongIsolationKey = 'stale';
const islandGuideData = {
  sheet_island: {
    name: 'Island角色状态表',
    content: [['row_id', '姓名'], [1, '结城理']],
  },
};
const archivedScopedConfig = {
  version: 1,
  template: {
    [archivedIsolationKey]: {
      mode: 'chat_override',
      isolationKey: archivedIsolationKey,
      templateStr: JSON.stringify(islandGuideData),
      guideData: islandGuideData,
    },
  },
};
const archivedSheetGuide = {
  version: 2,
  tags: {
    [archivedIsolationKey]: { data: islandGuideData, templateScopeMode: 'chat_override' },
  },
};
const hostChat = [{
  message_id: 0,
  role: 'assistant',
  is_user: false,
  mes: 'HOST_ROOT',
  TavernDB_ACU_ScopedConfig: structuredClone(archivedScopedConfig),
  TavernDB_ACU_InternalSheetGuide: structuredClone(archivedSheetGuide),
}];
const originalChat = hostChat;
const originalHostChatSnapshot = structuredClone(hostChat);
const hostChatMetadata = {
  TavernDB_ACU_ScopedConfig: structuredClone(archivedScopedConfig),
  TavernDB_ACU_InternalSheetGuide: structuredClone(archivedSheetGuide),
};
const originalHostChatMetadataSnapshot = structuredClone(hostChatMetadata);
const originalSaveChat = async () => { calls.push('host-save'); };
const originalSetChatMessages = async () => { calls.push('host-set'); };
const originalDeleteLastMessage = async () => { calls.push('host-delete'); };
const originalGetChatMessages = () => hostChat;
const originalGetLastMessageId = () => hostChat.length - 1;
const originalHelperSetChatMessages = async () => { calls.push('host-helper-set'); };
const originalCreateChatMessages = async () => { calls.push('host-create'); };
const originalDeleteChatMessages = async () => { calls.push('host-helper-delete'); };
const originalGenerateRaw = async options => {
  return tableFillResponse;
};
const originalConnectionManagerSendRequest = async (_profileId, messages) => {
  return { ok: true, result: { choices: [{ message: { content: tableFillResponse } }] } };
};
const connectionManagerService = { sendRequest: originalConnectionManagerSendRequest };
const originalGetCharData = target => {
  assert.equal(target, 'current', 'contract: character reads stay on the current card');
  return { name: 'CARD', description: baseCharacterDescription };
};
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
  name1: '安艺伦也',
  persona_description: 'DEFAULT_CARD_PROTAGONIST',
  saveChat: originalSaveChat,
  setChatMessages: originalSetChatMessages,
  deleteLastMessage: originalDeleteLastMessage,
  chatMetadata: hostChatMetadata,
  updateChatMetadata: async patch => {
    Object.entries(patch ?? {}).forEach(([key, value]) => {
      if (value === undefined) delete sillyTavern.chatMetadata[key];
      else sillyTavern.chatMetadata[key] = structuredClone(value);
    });
  },
  // Model the plugin-mode host object: shujuku's internal API is a Proxy
  // that resolves every property through this getContext snapshot.
  getContext: () => ({
    chat: sillyTavern.chat,
    name1: sillyTavern.name1,
    persona_description: sillyTavern.persona_description,
    saveChat: sillyTavern.saveChat,
    setChatMessages: sillyTavern.setChatMessages,
    deleteLastMessage: sillyTavern.deleteLastMessage,
    chatMetadata: sillyTavern.chatMetadata,
    updateChatMetadata: sillyTavern.updateChatMetadata,
    ConnectionManagerRequestService: connectionManagerService,
    extensionSettings: { activeIsolationKey: isolationKey },
    powerUserSettings: { persona_description: sillyTavern.persona_description },
  }),
};
const originalHostGetContext = sillyTavern.getContext;
const sillyTavernProxy = new Proxy({}, {
  get(_target, property) {
    return sillyTavern.getContext()?.[property];
  },
  has(_target, property) {
    return property in (sillyTavern.getContext() ?? {});
  },
});

const tavernHelper = {
  getChatMessages: originalGetChatMessages,
  getLastMessageId: originalGetLastMessageId,
  setChatMessages: originalHelperSetChatMessages,
  createChatMessages: originalCreateChatMessages,
  deleteChatMessages: originalDeleteChatMessages,
  generateRaw: originalGenerateRaw,
  getCharData: originalGetCharData,
  async generate(options) {
    calls.push('generate');
    capturedGenerateOptions = options;
    assert.equal(options.should_stream, false, 'contract: shujuku wrapper generation is non-streaming');
    assert.equal(options.should_silence, true, 'contract: shujuku wrapper generation is silent');
    assert.equal(options.generation_id, expectedGenerationId, 'contract: generation identity reaches wrapped generate');
    assert.equal(sillyTavernProxy.name1, planningUserName,
      'contract: shujuku $U resolves to the current Island player during planning');
    assert.equal(
      JSON.stringify(this.getChatMessages().map(message => message.mes)),
      JSON.stringify(['ROOT', 'HISTORY_USER', 'HISTORY_ASSISTANT', 'INPUT']),
      'contract: wrapped generate sees only the virtual timeline before assistant append',
    );
    planningDescriptions.push(this.getCharData('current').description);
    const currentUser = this.getChatMessages().at(-1);
    if (qrfMode === 'immediate') {
      currentUser.qrf_plot = 'QRF_SENTINEL';
      currentUser.qrf_plot_tasks = { task: 'TASK_SENTINEL' };
    } else if (qrfMode === 'pending') {
      currentUser.qrf_plot = 'PENDING_QRF_SENTINEL';
      currentUser._qrf_from_planning = true;
      currentUser._qrf_plot_pending_hash = 'PENDING_SENTINEL';
    } else if (qrfMode === 'delayed') {
      setTimeout(() => { currentUser.qrf_plot = 'DELAYED_QRF_SENTINEL'; }, 300);
    } else if (qrfMode === 'generation-failure') {
      currentUser.qrf_plot = 'QRF_BEFORE_BODY_FAILURE';
    } else if (qrfMode === 'preset-only') {
      currentUser.qrf_plot_preset = 'PRESET_ONLY_SENTINEL';
    } else if (qrfMode === 'tasks-only') {
      currentUser.qrf_plot_tasks = { task: 'TASK_ONLY_SENTINEL' };
    } else if (qrfMode === 'stale-round') {
      assert.equal(currentUser.qrf_plot, undefined,
        'contract: a reroll starts without the previous qrf_plot commit');
      assert.equal(currentUser.qrf_plot_tasks, undefined,
        'contract: a reroll starts without the previous qrf task metadata');
      assert.equal(currentUser.qrf_plot_preset, undefined,
        'contract: a reroll starts without the previous qrf preset metadata');
      assert.equal(currentUser._qrf_from_planning, undefined,
        'contract: a reroll starts without the previous planning marker');
      assert.equal(currentUser._qrf_plot_pending_hash, undefined,
        'contract: a reroll starts without the previous pending hash');
      assert.equal(currentUser._qrf_plot_round_id, undefined,
        'contract: a reroll starts without the previous round identity');
      currentUser.qrf_plot = 'QRF_NEW_ROUND_SENTINEL';
    }
    options.user_input = 'PLANNED_SENTINEL';
    if (planningSaveMode === 'awaited') await sillyTavernProxy.saveChat();
    else if (planningSaveMode === 'detached') void sillyTavernProxy.saveChat();
    const body = await runtimeWindow.original_TavernHelper_generate_ACU.call(this, options);
    if (databaseMode === 'bridge-export-stale') {
      const chat = sillyTavernProxy.chat;
      chat.push({
        message_id: chat.length,
        role: 'assistant',
        is_user: false,
        is_system: false,
        mes: body,
        message: body,
        TavernDB_ACU_IsolatedData: {
          active: { storageFrame: { version: 2, logEntries: [{ id: 'BEFORE_TURN_SENTINEL' }] } },
        },
      });
    }
    return body;
  },
};

function makeFetchResponse(content) {
  const body = JSON.stringify({ choices: [{ message: { content } }] });
  return {
    ok: true,
    clone: () => makeFetchResponse(content),
    text: async () => body,
  };
}

const originalRuntimeFetch = async (_url, options) => {
  assert.match(String(options?.body ?? ''), /table_edit_ops_v1/,
    'contract: the fetch capture is limited to an explicit table-fill request');
  return makeFetchResponse(tableFillResponse);
};

async function requestTableFillResponse() {
  const messages = [{ role: 'user', content: tableFillPrompt }];
  if (tableFillProvider === 'connection-manager') {
    return sillyTavernProxy.ConnectionManagerRequestService.sendRequest('profile', messages, 4096);
  }
  if (tableFillProvider === 'fetch') {
    return runtimeWindow.fetch('/api/backends/chat-completions/generate', {
      method: 'POST',
      body: JSON.stringify({ messages }),
    });
  }
  return tavernHelper.generateRaw({ ordered_prompts: messages, should_stream: false });
}

const api = {
  // Opening is allowed to inherit shujuku's default/current plot settings.
  // An empty preset name must not prevent qrf planning from starting.
  getCurrentPlotPreset() { return ''; },
  getPlotPresetDetails() { return null; },
  async triggerUpdate() {
    calls.push('triggerUpdate');
    const chat = sillyTavernProxy.chat;
    triggerDescriptions.push(tavernHelper.getCharData('current').description);
    assert.equal(
      Object.prototype.hasOwnProperty.call(chat.at(-2), planningContextKey),
      false,
      'contract: the ephemeral planning key is consumed before table triggering',
    );
    if (qrfMode === 'immediate' || qrfMode === 'delayed' || qrfMode === 'stale-round') {
      assert.equal(
        chat.at(-2)?.qrf_plot,
        qrfMode === 'delayed'
          ? 'DELAYED_QRF_SENTINEL'
          : qrfMode === 'stale-round' ? 'QRF_NEW_ROUND_SENTINEL' : 'QRF_SENTINEL',
        'contract: current-user qrf is ready before assistant table triggering',
      );
    }
    assert.equal(chat.at(-1)?.mes, '<content>ASSISTANT_SENTINEL</content>', 'contract: triggerUpdate runs after virtual assistant append');
    if (databaseMode === 'native') {
      chat[chat.length - 1] = {
        ...chat.at(-1),
        TavernDB_ACU_IsolatedData: {
          [wrongIsolationKey]: { storageFrame: { version: 2, logEntries: [{ id: 'STALE_SENTINEL' }] } },
          active: { storageFrame: { version: 2, logEntries: [{ id: 'STORAGE_SENTINEL' }] } },
        },
      };
      await sillyTavernProxy.saveChat();
    } else if (databaseMode === 'bridge-export-stale') {
      tableRevision = 3;
      // Deliberately omit saveChat and native storageFrame. The bridge must
      // accept the awaited trigger + changed table export as its own commit
      // checkpoint instead of rolling the table back.
    } else if (databaseMode.startsWith('operation-log-rejected')) {
      await requestTableFillResponse();
      if (databaseMode === 'operation-log-rejected-table-change') tableRevision = 3;
      return {
        success: false,
        modifiedKeys: [],
        error: 'V2 operation log requires explicit operations for source=group_fill; snapshot diff fallback is not allowed.',
        errorCategory: 'infrastructure',
      };
    } else if (databaseMode === 'default-table-edit') {
      const activeTemplate = chat[0]?.TavernDB_ACU_ScopedConfig?.template?.[isolationKey];
      const activeGuide = sillyTavernProxy.chatMetadata
        ?.TavernDB_ACU_InternalSheetGuide?.tags?.[isolationKey]?.data;
      assert.equal(activeTemplate?.isolationKey, isolationKey,
        'contract: the virtual root exposes the archived template under the active isolation key');
      assert.equal(activeGuide?.sheet_island?.name, 'Island角色状态表',
        'contract: chat metadata exposes the archived Island guide under the active isolation key');
      const promptSheetKeys = Object.keys(await this.exportTableAsJson())
        .filter(sheetKey => Object.hasOwn(activeGuide ?? {}, sheetKey));
      assert.deepEqual(promptSheetKeys, ['sheet_island'],
        'contract: default $0 projection remains non-empty after isolationKey rotation');
      const response = await requestTableFillResponse();
      assert.match(JSON.stringify(response), /<tableEdit>/,
        'contract: shujuku default <tableEdit> output remains a legal fill response');
      tableRevision = 3;
      chat[chat.length - 1] = {
        ...chat.at(-1),
        TavernDB_ACU_IsolatedData: {
          [isolationKey]: { storageFrame: { version: 2, logEntries: [{ id: 'DEFAULT_DSL_SENTINEL' }] } },
        },
      };
      await sillyTavernProxy.saveChat();
    }
    return { success: true };
  },
  async exportTableAsJson() {
    exportCalls += 1;
    if (runtimeTableDataOverride !== null) return structuredClone(runtimeTableDataOverride);
    return {
      story: { revision: tableRevision },
      sheet_island: {
        name: 'Island角色状态表',
        revision: tableRevision,
        content: [['row_id', '姓名'], [1, '结城理']],
      },
    };
  },
  async restoreTableAsJson(json) {
    restoreCalls += 1;
    try {
      const parsed = JSON.parse(json);
      tableRevision = Number(parsed?.story?.revision ?? tableRevision);
      if (runtimeTableDataOverride !== null) runtimeTableDataOverride = structuredClone(parsed);
    } catch { /* fixture */ }
    return true;
  },
  async importTableAsJson(json) {
    return this.restoreTableAsJson(json);
  },
};

const runtimeWindow = {
  TavernHelper: tavernHelper,
  SillyTavern: sillyTavernProxy,
  fetch: originalRuntimeFetch,
  async original_TavernHelper_generate_ACU(options) {
    bodyPromptDescriptions.push(String(options?.overrides?.char_description ?? ''));
    bodyPersonaDescriptions.push(String(options?.overrides?.persona_description ?? ''));
    calls.push('generate-body');
    if (qrfMode === 'generation-failure') throw new Error('BODY_FAILURE_SENTINEL');
    return '<content>ASSISTANT_SENTINEL</content>';
  },
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
  SillyTavern: sillyTavern,
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

function requestVirtualTurn(requestId, {
  withPlanningContext = true,
  currentPluginData = {},
  generationId = 'gen-1',
  cancelOnProgress = false,
} = {}) {
  expectedGenerationId = generationId;
  const pluginData = {
    ...currentPluginData,
    ...(withPlanningContext
      ? {
          [planningContextKey]: {
            version: 1,
            content: planningContextSentinel,
            userIdentity: { name: planningUserName, persona: planningContextSentinel },
          },
        }
      : {}),
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${requestId} timed out`)), 10_000);
    const subscription = eventOn(responseEvent, async response => {
      if (response?.requestId !== requestId) return;
      if (response.progress === true) {
        planningProgresses.push(response);
        calls.push('planning-render');
        await Promise.resolve();
        if (cancelOnProgress) {
          await eventEmit(cancelEvent, {
            protocolVersion: 1,
            requestId,
            action: 'generateVirtual',
            backend: 'islandmilfcode',
            generationId,
            reason: 'contract-cancel-during-planning-ack',
          });
          return;
        }
        await eventEmit(progressAckEvent, {
          protocolVersion: 1,
          requestId,
          action: 'generateVirtual',
          backend: 'islandmilfcode',
          phase: response.phase,
          ok: true,
          result: {
            bodyContext: bodyContextSentinel,
            projectionCommitted: true,
          },
        });
        return;
      }
      clearTimeout(timer);
      subscription.stop();
      resolve(response);
    });
    void eventEmit(requestEvent, {
      protocolVersion: 1,
      requestId,
      action: 'generateVirtual',
      inputJson: JSON.stringify({
        rootMessage: {
          role: 'assistant',
          text: 'ROOT',
          logicalId: 'root-assistant',
          exchangeId: null,
          floorIndex: null,
          pluginData: {
            TavernDB_ACU_ScopedConfig: structuredClone(archivedScopedConfig),
            TavernDB_ACU_InternalSheetGuide: structuredClone(archivedSheetGuide),
          },
        },
        messages: [
          {
            role: 'user',
            text: 'HISTORY_USER',
            logicalId: 'history-user',
            exchangeId: 'history-exchange',
            floorIndex: 0,
          },
          {
            role: 'assistant',
            text: 'HISTORY_ASSISTANT',
            logicalId: 'history-assistant',
            exchangeId: 'history-exchange',
            floorIndex: 0,
          },
          {
            role: 'user',
            text: 'INPUT',
            current: true,
            logicalId: `current-user-${generationId}`,
            exchangeId: `current-exchange-${generationId}`,
            floorIndex: 1,
            ...(Object.keys(pluginData).length ? { pluginData } : {}),
          },
        ],
        promptMessages: [
          {
            role: 'user',
            text: 'HISTORY_USER',
            logicalId: 'history-user',
            exchangeId: 'history-exchange',
            floorIndex: 0,
          },
          {
            role: 'assistant',
            text: 'HISTORY_ASSISTANT',
            logicalId: 'history-assistant',
            exchangeId: 'history-exchange',
            floorIndex: 0,
          },
        ],
        assistantTarget: {
          logicalId: `current-assistant-${generationId}`,
          exchangeId: `current-exchange-${generationId}`,
          floorIndex: 1,
        },
        userInput: 'INPUT',
        systemPrompt: 'SYSTEM',
        generationId,
        mode: 'turn',
        isolationKeyHandoff: {
          sourceIsolationKey: archivedIsolationKey,
          targetIsolationKey: isolationKey,
        },
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
assert.equal(result.result.userPluginData[planningContextKey], undefined, 'contract: ephemeral planning data never round-trips');
assert.equal(result.result.diagnostics.planningContextRequested, true);
assert.equal(result.result.diagnostics.planningContextInjected, false);
assert.equal(result.result.diagnostics.planningContextVisibleReads, 0,
  'contract: planning does not receive role-card or plot authority through $C');
assert.equal(result.result.diagnostics.bodyContextBoundaryInstalled, true);
assert.equal(result.result.diagnostics.bodyContextBoundaryObserved, true);
assert.equal(result.result.diagnostics.bodyContextInjected, true);
assert.equal(result.result.diagnostics.planningContextRestoredBeforeBody, true);
assert.equal(result.result.diagnostics.planningContextRestoredBeforeTrigger, true);
assert.equal(
  planningDescriptions[0],
  baseCharacterDescription,
  'contract: qrf planning keeps the base character description unchanged before present is committed',
);
assert.equal(
  bodyPromptDescriptions[0],
  `${baseCharacterDescription}\n\n<island_runtime_body_context>\n${bodyContextSentinel}\n</island_runtime_body_context>`,
  'contract: final body generation waits for the projection acknowledgement and sees its selected authority appendix',
);
assert.equal(bodyPromptDescriptions[0].split(presentRoleCardSentinel).length - 1, 1,
  'contract: the selected role-0 card enters the final body prompt exactly once');
assert.equal(bodyPromptDescriptions[0].split(currentPlotSentinel).length - 1, 1,
  'contract: the current plot enters the final body prompt exactly once');
assert.equal(bodyPromptDescriptions[0].includes(absentRoleCardSentinel), false,
  'contract: an absent role-0 card never enters the final body prompt');
assert.equal(bodyPromptDescriptions[0].includes(planningContextSentinel), false,
  'contract: the planning-only appendix is absent from the final body prompt');
assert.equal(bodyPersonaDescriptions[0], planningContextSentinel,
  'contract: the final body API receives the current Island User identity through its documented override');
assert.equal(result.result.diagnostics.bodyPromptOverrideInjected, true,
  'contract: the acknowledged projection is passed through Tavern Helper prompt overrides');
assert.equal(result.result.diagnostics.bodyPromptOverridePassed, true,
  'contract: the acknowledged正文 context is passed to the documented prompt override');
assert.equal(result.result.diagnostics.bodyPromptOverrideConsumed, undefined,
  'contract: local fixtures do not claim that Tavern consumed the final prompt override');
assert.equal(result.result.diagnostics.bodyContextVisibleReads, 0,
  'contract: the direct正文 prompt contract remains sufficient when the original API never reads getCharData');
assert.equal(
  triggerDescriptions[0],
  `${baseCharacterDescription}\n\n<island_runtime_body_context>\n${bodyContextSentinel}\n</island_runtime_body_context>`,
  'contract: triggerUpdate sees the acknowledged selected role-0/current-plot authority through $C',
);
assert.equal(triggerDescriptions[0].split(presentRoleCardSentinel).length - 1, 1,
  'contract: the selected role-0 card enters the table-fill prompt exactly once');
assert.equal(triggerDescriptions[0].split(currentPlotSentinel).length - 1, 1,
  'contract: the current plot enters the table-fill prompt exactly once');
assert.equal(triggerDescriptions[0].includes(absentRoleCardSentinel), false,
  'contract: an absent role-0 card never enters the table-fill prompt');
assert.equal(triggerDescriptions[0].includes(planningContextSentinel), false,
  'contract: the planning-only appendix is absent from the table-fill prompt');
assert.equal(result.result.diagnostics.planningProgressSent, true, 'contract: planning progress is emitted for the current turn');
assert.equal(result.result.diagnostics.planningSaveCalls, 0,
  'contract: the native body boundary can publish an already-written qrf without a saveChat callback');
assert.equal(result.result.diagnostics.hostSaveRequestedAt, null,
  'contract: qrf observation is not mislabeled as a host save request');
assert.equal(result.result.diagnostics.qrfObservedAt > 0, true);
assert.equal(result.result.diagnostics.planningPublishedAt >= result.result.diagnostics.qrfObservedAt, true);
assert.equal(result.result.diagnostics.projectionAcknowledgedAt >= result.result.diagnostics.planningPublishedAt, true);
assert.equal(result.result.diagnostics.bodyGenerationStartedAt >= result.result.diagnostics.projectionAcknowledgedAt, true,
  'contract:正文 main API starts only after the persisted planning projection ACK');
assert.equal(
  result.result.diagnostics.planningProgressBeforeGenerationReturn,
  true,
  'contract: the planning panel is acknowledged before wrapped narrative generation returns',
);
assert.equal(planningProgresses.length, 1, 'contract: planning progress is emitted exactly once before the final result');
assert.equal(planningProgresses[0].phase, 'planning');
assert.equal(planningProgresses[0].result.plannedText, 'PLANNED_SENTINEL');
assert.equal(planningProgresses[0].result.userPluginData.qrf_plot, 'QRF_SENTINEL');
assert.equal(result.result.diagnostics.adapterRestored, true);
assert.equal(result.result.diagnostics.virtualContextOverlayReads > 0, true,
  'contract: plugin-mode getContext proxy reads the virtual timeline overlay');
assert.equal(result.result.diagnostics.databaseSaveCalls, 1);
assert.equal(result.result.diagnostics.databaseSaveBaseline, 0, 'contract: database evidence starts from this turn save baseline');
assert.equal(result.result.diagnostics.databaseSaveCallsAfterTrigger, 1, 'contract: database save is observed after trigger');
assert.equal(result.result.diagnostics.triggerBodyContextInjected, true,
  'contract: the acknowledged body authority is installed only for table filling');
assert.equal(result.result.diagnostics.triggerBodyContextVisibleReads > 0, true,
  'contract: triggerUpdate actually consumes the selected authority through $C');
assert.equal(result.result.diagnostics.bodyContextRestoredAfterTrigger, true,
  'contract: the table-fill $C overlay is restored after triggerUpdate settles');
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
assert.deepEqual(
  calls.slice(0, 4),
  ['generate', 'planning-render', 'generate-body', 'triggerUpdate'],
  'contract: planning render acknowledgement precedes narrative completion and table triggering',
);
assert.equal(sillyTavern.chat, originalChat, 'contract: SillyTavern.chat is restored');
assert.equal(sillyTavern.saveChat, originalSaveChat, 'contract: SillyTavern.saveChat is restored');
assert.equal(sillyTavern.setChatMessages, originalSetChatMessages, 'contract: SillyTavern mutators are restored');
assert.equal(tavernHelper.getChatMessages, originalGetChatMessages, 'contract: TavernHelper readers are restored');
assert.equal(tavernHelper.getLastMessageId, originalGetLastMessageId, 'contract: TavernHelper id reader is restored');
assert.equal(tavernHelper.setChatMessages, originalHelperSetChatMessages, 'contract: TavernHelper setter is restored');
assert.equal(tavernHelper.createChatMessages, originalCreateChatMessages, 'contract: TavernHelper creator is restored');
assert.equal(tavernHelper.deleteChatMessages, originalDeleteChatMessages, 'contract: TavernHelper deleter is restored');
assert.equal(tavernHelper.getCharData, originalGetCharData, 'contract: TavernHelper character reader is restored');
assert.equal(sillyTavern.name1, '安艺伦也', 'contract: the temporary $U identity overlay is restored');
assert.equal(sillyTavern.getContext, originalHostGetContext,
  'contract: the plugin host getContext function is restored');
assert.deepEqual(hostChat, originalHostChatSnapshot, 'contract: host chat is never persisted');

databaseMode = 'bridge-export-stale';
tableRevision = 2;
const restoreCallsBeforeBridgeExport = restoreCalls;
const bridgeExportResult = await requestVirtualTurn('contract-generate-plugin-proxy-bridge-export', {
  generationId: 'gen-plugin-proxy-bridge-export',
});
assert.equal(bridgeExportResult.ok, true,
  'contract: a successful changed table export survives when plugin mode exposes neither saveChat evidence nor a native storageFrame');
assert.equal(bridgeExportResult.result.databaseCommitted, true);
assert.equal(bridgeExportResult.result.tableSnapshot.tables.story.revision, 3);
assert.equal(bridgeExportResult.result.diagnostics.databaseSaveObserved, false,
  'contract: an unobservable host save is diagnostic only for the bridge-owned virtual commit');
assert.equal(bridgeExportResult.result.diagnostics.storageFrameSource, 'bridge-export');
assert.equal(bridgeExportResult.result.diagnostics.bridgeStorageFrameMaterialized, true);
assert.equal(bridgeExportResult.result.diagnostics.staleStorageFrameObserved, true,
  'contract: a before-turn storageFrame cannot satisfy the current table commit');
assert.equal(
  bridgeExportResult.result.assistantPluginData.TavernDB_ACU_IsolatedData.active.storageFrame._island_bridge_snapshot,
  true,
  'contract: the changed table export is bound to the current logical assistant as a durable checkpoint',
);
assert.equal(restoreCalls, restoreCallsBeforeBridgeExport,
  'contract: successful table edits are never restored to the before-turn snapshot');
databaseMode = 'native';
tableRevision = 2;

databaseMode = 'operation-log-rejected';
tableFillResponse = '{"format":"table_edit_ops_v1","ops":[]}';
for (const provider of ['generateRaw', 'connection-manager', 'fetch']) {
  tableFillProvider = provider;
  const noOpResult = await requestVirtualTurn(`contract-generate-explicit-noop-${provider}`, {
    generationId: `gen-explicit-noop-${provider}`,
  });
  assert.equal(noOpResult.ok, true,
    `contract: explicit empty table operations are a successful database no-op through ${provider}`);
  assert.equal(noOpResult.result.databaseCommitted, true,
    'contract: a verified no-op satisfies the database phase without inventing a mutation');
  assert.equal(noOpResult.result.diagnostics.databaseNoOp, true,
    'contract: callers can distinguish a verified no-op from a durable table mutation');
  assert.equal(noOpResult.result.diagnostics.databaseOutcome, 'verified_noop');
  assert.equal(noOpResult.result.diagnostics.tableChanged, false);
  assert.equal(noOpResult.result.diagnostics.storageFrameChanged, false);
  assert.equal(noOpResult.result.diagnostics.tableFillCaptureRestored, true,
    'contract: the temporary response capture is restored before the virtual turn returns');
  assert.equal(
    JSON.stringify(noOpResult.result.diagnostics.tableFillResponses),
    JSON.stringify([{ source: provider, validEnvelope: true, operationCount: 0 }]),
  );
  assert.equal(noOpResult.result.assistantPluginData, undefined,
    'contract: an empty operation log cannot fabricate assistant storageFrame data');
  assert.equal(noOpResult.result.tableSnapshot.tables.story.revision, 2,
    'contract: a verified no-op returns the unchanged authoritative table snapshot');
  assert.equal(tavernHelper.generateRaw, originalGenerateRaw,
    'contract: main-API capture is restored after a no-op turn');
  assert.equal(connectionManagerService.sendRequest, originalConnectionManagerSendRequest,
    'contract: Connection Manager capture is restored after a no-op turn');
  assert.equal(runtimeWindow.fetch, originalRuntimeFetch,
    'contract: fetch capture is restored after a no-op turn');
}

tableFillProvider = 'generateRaw';
tableFillResponse = '{"format":"table_edit_ops_v1","ops":[{"op":"insert","sheet":"纪要表","row":{"概览":"changed"}}]}';
const nonEmptyWithoutCommit = await requestVirtualTurn('contract-generate-nonempty-without-commit', {
  generationId: 'gen-nonempty-without-commit',
});
assert.equal(nonEmptyWithoutCommit.ok, false,
  'contract: non-empty operations without a storageFrame or changed table export still fail closed');

tableFillResponse = '{"format":"table_edit_ops_v1","ops":[]}';
databaseMode = 'operation-log-rejected-table-change';
const emptyWithTableChange = await requestVirtualTurn('contract-generate-empty-with-table-change', {
  generationId: 'gen-empty-with-table-change',
});
assert.equal(emptyWithTableChange.ok, false,
  'contract: an explicit empty operation response cannot authorize a changed runtime table');
assert.equal(tableRevision, 2,
  'contract: a rejected empty-operation table mutation is rolled back to the before-turn snapshot');

databaseMode = 'operation-log-rejected';
tableFillResponse = 'not valid table JSON';
const unparseableWithoutCommit = await requestVirtualTurn('contract-generate-unparseable-without-commit', {
  generationId: 'gen-unparseable-without-commit',
});
assert.equal(unparseableWithoutCommit.ok, false,
  'contract: an unparseable fill response cannot use the no-op exception');
assert.equal(tavernHelper.generateRaw, originalGenerateRaw,
  'contract: main-API capture is restored after the failure path');
assert.equal(connectionManagerService.sendRequest, originalConnectionManagerSendRequest,
  'contract: Connection Manager capture is restored after the failure path');
assert.equal(runtimeWindow.fetch, originalRuntimeFetch,
  'contract: fetch capture is restored after the failure path');

databaseMode = 'default-table-edit';
tableFillPrompt = '使用默认模板输出 <content><tableEdit>insertRow(...)</tableEdit></content>';
tableFillResponse = '<thought>默认模板推理</thought>\n<content>\n<tableEdit>\ninsertRow(0, {"0":"结城理"})\n</tableEdit>\n</content>';
runtimeTableDataOverride = {};
const restoreCallsBeforeDefaultHydration = restoreCalls;
const defaultDslResult = await requestVirtualTurn('contract-generate-default-table-edit', {
  generationId: 'gen-default-table-edit',
});
assert.equal(defaultDslResult.ok, true,
  'contract: shujuku default <tableEdit> output commits through the native parser path');
assert.equal(defaultDslResult.result.databaseCommitted, true);
assert.equal(defaultDslResult.result.diagnostics.runtimeTablesHydrated, true,
  'contract: a default tableEdit turn hydrates missing runtime tables from the active guide');
assert.equal(defaultDslResult.result.diagnostics.runtimeHydrationMergedSheetCount > 0, true,
  'contract: guide hydration restores at least one missing sheet before native group_fill parsing');
assert.equal(restoreCalls > restoreCallsBeforeDefaultHydration, true,
  'contract: guide hydration uses the runtime restore API instead of inventing a storage frame');
assert.equal(defaultDslResult.result.diagnostics.tableFillResponses.length, 0,
  'contract: strict JSON no-op capture does not redefine the default <tableEdit> contract');
assert.deepEqual(sillyTavern.chatMetadata, originalHostChatMetadataSnapshot,
  'contract: the isolationKey remap never persists into host chat metadata');
assert.equal(tavernHelper.generateRaw, originalGenerateRaw,
  'contract: main-API capture is restored after the default DSL path');
assert.equal(connectionManagerService.sendRequest, originalConnectionManagerSendRequest,
  'contract: Connection Manager capture is restored after the default DSL path');
assert.equal(runtimeWindow.fetch, originalRuntimeFetch,
  'contract: fetch capture is restored after the default DSL path');
runtimeTableDataOverride = null;

databaseMode = 'operation-log-rejected';
runtimeTableDataOverride = {};
const restoreCallsBeforeHydrationFailure = restoreCalls;
const rejectedHydratedDefault = await requestVirtualTurn('contract-default-table-edit-hydration-rollback', {
  generationId: 'gen-default-table-edit-hydration-rollback',
});
assert.equal(rejectedHydratedDefault.ok, false,
  'contract: an upstream operation-log rejection remains a failed turn after guide hydration');
assert.deepEqual(runtimeTableDataOverride, {},
  'contract: a failed hydrated turn restores the exact pre-hydration runtime snapshot');
assert.equal(restoreCalls >= restoreCallsBeforeHydrationFailure + 2, true,
  'contract: failed guide hydration performs both temporary restore and rollback');
runtimeTableDataOverride = null;

databaseMode = 'native';
tableFillPrompt = 'Return only {"format":"table_edit_ops_v1","ops":[]}';
tableFillResponse = '{"format":"table_edit_ops_v1","ops":[]}';

for (const saveMode of ['awaited', 'detached']) {
  qrfMode = 'immediate';
  planningSaveMode = saveMode;
  const saveResult = await requestVirtualTurn(`contract-generate-planning-save-${saveMode}`);
  assert.equal(saveResult.ok, true,
    `contract: the ${saveMode} planning save path preserves the qrf -> projection ->正文 order`);
  assert.equal(saveResult.result.diagnostics.planningSaveCalls, 1,
    `contract: the ${saveMode} planning save path is observed exactly once`);
}
planningSaveMode = 'none';

qrfMode = 'stale-round';
const rerollResult = await requestVirtualTurn('contract-generate-reroll-clears-old-planning', {
  currentPluginData: {
    qrf_plot: 'OLD_QRF_SENTINEL',
    qrf_plot_tasks: { old: 'OLD_TASK_SENTINEL' },
    qrf_plot_preset: 'OLD_PRESET_SENTINEL',
    _qrf_from_planning: true,
    _qrf_plot_pending_hash: 'OLD_PENDING_SENTINEL',
    _qrf_plot_round_id: 'OLD_ROUND_SENTINEL',
  },
});
assert.equal(rerollResult.ok, true,
  'contract: reroll clears every previous planning identity before shujuku claims the current user');
assert.equal(rerollResult.result.userPluginData.qrf_plot, 'QRF_NEW_ROUND_SENTINEL');
assert.equal(rerollResult.result.userPluginData._qrf_plot_round_id, undefined,
  'contract: a previous round id cannot leak into the newly planned turn');

qrfMode = 'missing';
const missingQrfResult = await requestVirtualTurn('contract-generate-missing-qrf');
assert.equal(
  missingQrfResult.ok,
  false,
  'contract:正文 cannot cross the planning boundary when the current virtual user has no committed qrf',
);

qrfMode = 'pending';
const pendingOnlyResult = await requestVirtualTurn('contract-generate-pending-only');
assert.equal(
  pendingOnlyResult.ok,
  false,
  'contract: qrf_plot plus a pending save marker cannot release正文 generation',
);

qrfMode = 'preset-only';
const presetOnlyResult = await requestVirtualTurn('contract-generate-preset-only');
assert.equal(presetOnlyResult.ok, false,
  'contract: qrf preset metadata alone cannot release正文 generation');

qrfMode = 'tasks-only';
const tasksOnlyResult = await requestVirtualTurn('contract-generate-tasks-only');
assert.equal(tasksOnlyResult.ok, false,
  'contract: qrf task metadata alone cannot release正文 generation');

qrfMode = 'delayed';
const delayedQrfResult = await requestVirtualTurn('contract-generate-delayed-qrf');
assert.equal(delayedQrfResult.ok, true,
  'contract: the body boundary waits for this turn qrf commit before starting正文 generation');

qrfMode = 'immediate';
const genericNextTurnResult = await requestVirtualTurn('contract-generate-generic-next-turn', { withPlanningContext: false });
assert.equal(genericNextTurnResult.ok, false,
  'contract: a shujuku turn without the current Island User identity fails closed before planning');

qrfMode = 'generation-failure';
const failedBodyResult = await requestVirtualTurn('contract-generate-body-failure');
assert.equal(failedBodyResult.ok, false, 'contract: final generation failures remain explicit relay failures');
assert.match(failedBodyResult.error.message, /BODY_FAILURE_SENTINEL/);
assert.equal(tavernHelper.getCharData, originalGetCharData, 'contract: failure restores the original character reader');
assert.equal(
  tavernHelper.getCharData('current').description,
  baseCharacterDescription,
  'contract: failure cannot leak the appendix into later reads',
);

qrfMode = 'immediate';
const cancelStartedAt = Date.now();
const cancelledResult = await requestVirtualTurn('contract-generate-cancel-during-ack', {
  generationId: 'gen-cancel-during-ack',
  cancelOnProgress: true,
});
assert.equal(cancelledResult.ok, false,
  'contract: cancellation while waiting for planning ACK terminates the active virtual turn');
assert.equal(cancelledResult.error.code, 'SHUJUKU_GENERATION_CANCELLED');
assert.equal(Date.now() - cancelStartedAt < 2_000, true,
  'contract: cancellation rejects immediately instead of waiting for the 30 second ACK timeout');

const afterCancelStartedAt = Date.now();
const afterCancelResult = await requestVirtualTurn('contract-generate-after-cancel', {
  generationId: 'gen-after-cancel',
});
assert.equal(afterCancelResult.ok, true,
  'contract: a cancelled ACK waiter releases the serialized bridge queue for the next turn');
assert.equal(Date.now() - afterCancelStartedAt < 2_000, true,
  'contract: the next turn is not delayed by the cancelled ACK waiter');

console.info('[shujuku-v2-virtual-relay] contracts passed, including explicit no-op paths');
