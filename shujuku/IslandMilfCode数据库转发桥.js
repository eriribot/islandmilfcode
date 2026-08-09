(() => {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const BRIDGE_VERSION = '5.2.0';
  const REQUEST_EVENT = 'islandmilfcode:shujuku-relay:request:v1';
  const RESPONSE_EVENT = 'islandmilfcode:shujuku-relay:response:v1';
  const RUNTIME_KEY = '__islandmilfcodeShujukuRoleBridgeV1__';
  const BACKEND = 'shujuku-role-bridge';
  const MAX_CACHE_ENTRIES = 128;
  const SHUJUKU_FRAME_SELECTOR = 'iframe[id^="TH-script--"]';
  const PLANNING_RESULT_KEYS = ['qrf_plot', 'qrf_plot_tasks', 'qrf_plot_preset'];
  const QRF_KEYS = [...PLANNING_RESULT_KEYS, '_qrf_from_planning', '_qrf_plot_pending_hash'];
  const QRF_POLL_ATTEMPTS = 22;
  const QRF_POLL_INTERVAL_MS = 100;
  const PLUGIN_KEY_PATTERN = /^(?:TavernDB_ACU_|qrf_|_qrf_|_plot_)/;
  const ACTIONS = new Set([
    'probe',
    'exportTableAsJson',
    'restoreTableAsJson',
    'importTableAsJson',
    'generateVirtual',
  ]);

  class BridgeError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'BridgeError';
      this.code = code;
    }
  }

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function isObjectLike(value) {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
  }

  function assertToken(value, label, maximumLength = 512) {
    if (
      typeof value !== 'string'
      || !value
      || value !== value.trim()
      || value.length > maximumLength
      || /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new BridgeError('INVALID_REQUEST', `${label} 必须是非空、无控制字符的字符串`);
    }
    return value;
  }

  function assertKeys(value, label, required, optional = []) {
    if (!isRecord(value)) throw new BridgeError('INVALID_REQUEST', `${label} 必须是对象`);
    const allowed = new Set([...required, ...optional]);
    const unknown = Object.keys(value).find(key => !allowed.has(key));
    if (unknown) throw new BridgeError('INVALID_REQUEST', `${label} 含有未知字段 ${unknown}`);
    const missing = required.find(key => !Object.prototype.hasOwnProperty.call(value, key));
    if (missing) throw new BridgeError('INVALID_REQUEST', `${label} 缺少字段 ${missing}`);
    return value;
  }

  function cloneJson(value, label) {
    let encoded;
    try {
      encoded = JSON.stringify(value, (_key, item) => {
        if (
          typeof item === 'undefined'
          || typeof item === 'function'
          || typeof item === 'symbol'
          || typeof item === 'bigint'
          || (typeof item === 'number' && !Number.isFinite(item))
        ) {
          throw new TypeError('包含非 JSON 值');
        }
        return item;
      });
    } catch (error) {
      throw new BridgeError(
        'INVALID_REQUEST',
        `${label} 必须可完整序列化为 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (encoded === undefined) throw new BridgeError('INVALID_REQUEST', `${label} 不能是 undefined`);
    return JSON.parse(encoded);
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }

  function fingerprint(value, label) {
    return JSON.stringify(canonicalize(cloneJson(value, label)));
  }

  async function sha256Value(value) {
    if (!globalThis.crypto?.subtle) return `json:${fingerprint(value, 'hash')}`;
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(cloneJson(value, 'hash'))));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function reachableScopes() {
    const result = [];
    const append = (scope, source) => {
      if (!scope || result.some(item => item.scope === scope)) return;
      result.push({ scope, source });
    };
    append(globalThis, 'globalThis');
    try { append(globalThis.parent, 'parent'); } catch { /* inaccessible */ }
    try { append(globalThis.top, 'top'); } catch { /* inaccessible */ }
    return result;
  }

  function findApi() {
    for (const candidate of reachableScopes()) {
      try {
        const api = candidate.scope?.AutoCardUpdaterAPI;
        if (isObjectLike(api)) return { api, source: candidate.source };
      } catch {
        // Continue through the same-origin scopes.
      }
    }
    return null;
  }

  function cloneIfJson(value) {
    try { return cloneJson(value, 'shujuku 虚拟消息字段'); } catch { return undefined; }
  }

  function extractPluginData(message) {
    if (!isObjectLike(message)) return undefined;
    const result = {};
    for (const [key, value] of Object.entries(message)) {
      if (PLUGIN_KEY_PATTERN.test(key) && value !== undefined) {
        const cloned = cloneIfJson(value);
        if (cloned !== undefined) result[key] = cloned;
      }
    }
    for (const key of ['extra', 'data']) {
      const value = message[key];
      if (!isRecord(value) || !Object.keys(value).length) continue;
      const cloned = cloneIfJson(value);
      if (cloned !== undefined) result[key] = cloned;
    }
    return Object.keys(result).length ? result : undefined;
  }

  function applyPluginData(target, pluginData) {
    if (!isRecord(pluginData)) return target;
    for (const [key, value] of Object.entries(pluginData)) {
      const cloned = cloneIfJson(value);
      if (cloned !== undefined) target[key] = cloned;
    }
    return target;
  }

  function readQrf(message) {
    if (!isObjectLike(message)) return undefined;
    const result = {};
    const read = value => {
      if (!isRecord(value)) return;
      for (const key of QRF_KEYS) {
        if (value[key] === undefined) continue;
        const cloned = cloneIfJson(value[key]);
        if (cloned !== undefined) result[key] = cloned;
      }
    };
    read(message);
    read(message.extra);
    read(message.data);
    return Object.keys(result).length ? result : undefined;
  }

  function hasPlanningResult(qrf) {
    if (!isRecord(qrf)) return false;
    return PLANNING_RESULT_KEYS.some(key => {
      const value = qrf[key];
      if (typeof value === 'string') return Boolean(value.trim());
      if (Array.isArray(value)) return value.length > 0;
      if (isRecord(value)) return Object.keys(value).length > 0;
      return value !== undefined && value !== null;
    });
  }

  function readPlannedText(message, originalInput) {
    if (!isObjectLike(message)) return undefined;
    const candidates = [message.mes, message.message, message.extra?.mes, message.data?.mes]
      .map(value => String(value ?? '').trim())
      .filter(Boolean);
    const input = String(originalInput ?? '').trim();
    return candidates.find(value => value && value !== input);
  }

  function readPlannedTextFromOptions(options, originalInput) {
    if (!isObjectLike(options)) return undefined;
    const candidates = [
      ['user_input', options.user_input],
      ['injects', options.injects?.[0]?.content],
      ['prompt', options.prompt],
    ];
    const input = String(originalInput ?? '').trim();
    for (const [, value] of candidates) {
      const text = String(value ?? '').trim();
      if (text && text !== input) return text;
    }
    return undefined;
  }

  function clearPlanningEvidence(message) {
    if (!isObjectLike(message)) return;
    for (const key of QRF_KEYS) delete message[key];
    for (const containerKey of ['extra', 'data']) {
      const container = message[containerKey];
      if (!isRecord(container)) continue;
      for (const key of QRF_KEYS) delete container[key];
    }
  }

  function normalizeGeneratedResult(value) {
    if (typeof value === 'string') return value;
    if (isRecord(value) && typeof value.content === 'string') return value.content;
    return String(value ?? '');
  }

  function patchRuntimeProperty(target, key, value, restores, label) {
    if (!target) throw new BridgeError('SHUJUKU_RUNTIME_UNAVAILABLE', `缺少 ${label}`);
    const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    try {
      if (!descriptor || descriptor.configurable) {
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          writable: true,
          value,
        });
      } else if (descriptor.writable || descriptor.set) {
        target[key] = value;
      } else {
        throw new Error('属性不可写');
      }
    } catch (error) {
      throw new BridgeError(
        'SHUJUKU_RUNTIME_PATCH_FAILED',
        `${label} 替换失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (target[key] !== value) throw new BridgeError('SHUJUKU_RUNTIME_PATCH_FAILED', `${label} 替换后回读不一致`);
    restores.push(() => {
      if (hadOwn && descriptor) Object.defineProperty(target, key, descriptor);
      else if (hadOwn) target[key] = descriptor?.value;
      else delete target[key];
    });
  }

  function normalizeVirtualIds(chat) {
    chat.forEach((message, index) => {
      message.message_id = index;
      message.role = message.is_user ? 'user' : 'assistant';
      if (typeof message.mes !== 'string') message.mes = String(message.message ?? '');
      message.message = message.mes;
    });
  }

  function selectVirtualMessages(chat, range, options = {}) {
    let selected = chat;
    if (typeof range === 'number') selected = chat.slice(range, range + 1);
    else if (typeof range === 'string') {
      const text = range.trim();
      if (text === '{{lastMessageId}}' || text === 'latest') selected = chat.slice(-1);
      else {
        const match = text.match(/^(\d+)(?:-(\d+|\{\{lastMessageId\}\}))?$/);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] === '{{lastMessageId}}' ? chat.length - 1 : Number(match[2] ?? match[1]);
          selected = chat.slice(start, end + 1);
        }
      }
    }
    if (options?.role === 'user') selected = selected.filter(message => message.is_user);
    if (options?.role === 'assistant') selected = selected.filter(message => !message.is_user);
    return selected;
  }

  function applyVirtualUpdates(chat, updates) {
    for (const update of Array.isArray(updates) ? updates : []) {
      const id = Number(update?.message_id);
      const target = chat[id];
      if (!target) continue;
      for (const [key, value] of Object.entries(update)) {
        if (key === 'message_id') continue;
        target[key] = cloneIfJson(value) ?? value;
      }
      if (update.message !== undefined) target.mes = String(update.message);
      if (update.mes !== undefined) target.message = String(update.mes);
    }
    normalizeVirtualIds(chat);
  }

  function toVirtualMessage(message, messageId) {
    const text = String(message.rawText || message.text || '');
    return applyPluginData({
      message_id: messageId,
      role: message.role === 'user' ? 'user' : 'assistant',
      is_user: message.role === 'user',
      is_system: false,
      name: String(message.name || (message.role === 'user' ? '用户' : '助手')),
      mes: text,
      message: text,
      send_date: Date.now(),
      extra: {},
      data: {},
      ...(message.current === true ? { _islandmilfcode_current_turn: true } : {}),
    }, message.pluginData);
  }

  function buildVirtualChat(input) {
    const rootText = String(input.rootText || '[开局]').trim() || '[开局]';
    const chat = [{
      message_id: 0,
      role: 'assistant',
      is_user: false,
      is_system: false,
      name: 'IslandMilfCode',
      mes: rootText,
      message: rootText,
      send_date: 0,
      extra: {},
      data: {},
    }];
    for (const message of input.messages) {
      chat.push(toVirtualMessage(message, chat.length));
    }
    const currentUsers = chat.filter(message => message.is_user && message._islandmilfcode_current_turn === true);
    if (currentUsers.length !== 1) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual 必须标记且仅标记一个当前 user');
    }
    if (chat[chat.length - 1] !== currentUsers[0]) {
      throw new BridgeError('INVALID_REQUEST', '当前 user 必须位于虚拟时间线末尾');
    }
    normalizeVirtualIds(chat);
    return chat;
  }

  function findShujukuRuntime() {
    const localWindow = globalThis.window || globalThis;
    const hostWindow = localWindow?.parent || localWindow;
    const apiRuntime = findApi();
    const api = apiRuntime?.api;
    const document = hostWindow?.document;
    if (!api || !document || typeof document.querySelectorAll !== 'function') return null;
    for (const frame of document.querySelectorAll(SHUJUKU_FRAME_SELECTOR)) {
      try {
        const runtimeWindow = frame.contentWindow;
        const tavernHelper = runtimeWindow?.TavernHelper;
        const sillyTavern = runtimeWindow?.SillyTavern;
        if (!runtimeWindow || !tavernHelper || !sillyTavern || typeof tavernHelper.generate !== 'function') continue;
        const v2Api = Object.prototype.hasOwnProperty.call(runtimeWindow, 'AutoCardUpdaterV2API')
          ? runtimeWindow.AutoCardUpdaterV2API
          : null;
        const runtimeKind = v2Api && typeof v2Api.open === 'function'
          ? 'v2'
          : typeof runtimeWindow.original_TavernHelper_generate_ACU === 'function' ? 'legacy' : null;
        if (!runtimeKind) continue;
        if (typeof api.triggerUpdate !== 'function') continue;
        return {
          api,
          frame,
          runtimeWindow,
          tavernHelper,
          sillyTavern,
          runtimeKind,
        };
      } catch {
        // Ignore cross-origin or half-initialized frames.
      }
    }
    return null;
  }

  function findIsolationKey(value, depth = 0, seen = new Set()) {
    if (depth > 8) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
      try { return findIsolationKey(JSON.parse(trimmed), depth + 1, seen); } catch { return null; }
    }
    if (!isObjectLike(value) || seen.has(value)) return null;
    seen.add(value);
    for (const key of ['activeIsolationCode', 'activeIsolationKey']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    for (const child of Object.values(value)) {
      const found = findIsolationKey(child, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  function readActiveIsolationKey() {
    for (const candidate of reachableScopes()) {
      try {
        const settings = candidate.scope?.SillyTavern?.getContext?.()?.extensionSettings;
        const found = findIsolationKey(settings);
        if (found) return found;
      } catch {
        // Continue through the remaining same-origin scopes.
      }
    }
    return null;
  }

  function capabilitiesOf(api) {
    const canImport = typeof api?.importTableAsJson === 'function';
    const virtualRuntime = findShujukuRuntime();
    return {
      exportTableAsJson: typeof api?.exportTableAsJson === 'function',
      restoreTableAsJson: typeof api?.restoreTableAsJson === 'function' || canImport,
      importTableAsJson: canImport,
      triggerUpdate: typeof api?.triggerUpdate === 'function',
      generateVirtual: Boolean(virtualRuntime && virtualRuntime.api === api),
      manualUpdate: typeof api?.manualUpdate === 'function',
    };
  }

  function probeRuntime() {
    const runtime = findApi();
    const capabilities = capabilitiesOf(runtime?.api);
    const missing = ['exportTableAsJson', 'restoreTableAsJson', 'triggerUpdate', 'generateVirtual']
      .filter(name => capabilities[name] !== true);
    return {
      bridgeVersion: BRIDGE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      apiAvailable: Boolean(runtime),
      runtimeSource: runtime?.source ?? null,
      activeIsolationKey: readActiveIsolationKey(),
      capabilities,
      missingTableCapabilities: missing,
      tableRelayReady: Boolean(runtime && missing.length === 0),
      runtimeReason: runtime
        ? missing.length ? `AutoCardUpdaterAPI 缺少表操作：${missing.join(',')}` : null
        : '未找到 AutoCardUpdaterAPI',
    };
  }

  async function invokeApi(method, ...args) {
    const runtime = findApi();
    const fn = runtime?.api?.[method];
    if (typeof fn !== 'function') throw new BridgeError('SHUJUKU_API_UNAVAILABLE', `AutoCardUpdaterAPI.${method} 不可用`);
    return fn.call(runtime.api, ...args);
  }

  function parseVirtualInput(inputJson) {
    if (typeof inputJson !== 'string' || !inputJson.trim()) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.inputJson 必须是非空字符串');
    }
    let input;
    try { input = JSON.parse(inputJson); } catch (error) {
      throw new BridgeError('INVALID_REQUEST', `generateVirtual.inputJson 无效：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(input)) throw new BridgeError('INVALID_REQUEST', 'generateVirtual.inputJson 顶层必须是对象');
    assertKeys(
      input,
      'generateVirtual input',
      ['messages', 'userInput', 'generationId'],
      ['rootText', 'systemPrompt', 'mode'],
    );
    if (inputJson.length > 2_000_000) throw new BridgeError('INVALID_REQUEST', 'generateVirtual.inputJson 过大');
    if (!Array.isArray(input.messages) || input.messages.length > 256) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.messages 必须是不超过 256 条的数组');
    }
    for (const [index, message] of input.messages.entries()) {
      assertKeys(message, `generateVirtual.messages[${index}]`, ['role', 'text'], ['name', 'rawText', 'pluginData', 'current']);
      if (message.role !== 'user' && message.role !== 'assistant') {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.messages[${index}].role 无效`);
      }
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 200_000) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.messages[${index}].text 无效`);
      }
      if (message.rawText !== undefined && (typeof message.rawText !== 'string' || message.rawText.length > 200_000)) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.messages[${index}].rawText 无效`);
      }
      if (message.name !== undefined && (typeof message.name !== 'string' || message.name.length > 512)) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.messages[${index}].name 无效`);
      }
      if (message.current !== undefined && typeof message.current !== 'boolean') {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.messages[${index}].current 无效`);
      }
      if (message.pluginData !== undefined) cloneJson(message.pluginData, `generateVirtual.messages[${index}].pluginData`);
    }
    if (input.rootText !== undefined && (typeof input.rootText !== 'string' || input.rootText.length > 200_000)) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.rootText 无效');
    }
    if (input.systemPrompt !== undefined && (typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 500_000)) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.systemPrompt 无效');
    }
    if (typeof input.userInput !== 'string' || !input.userInput.trim() || input.userInput.length > 200_000) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.userInput 必须是非空字符串');
    }
    if (typeof input.generationId !== 'string' || !input.generationId.trim() || input.generationId.length > 512) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.generationId 必须是非空字符串');
    }
    if (input.mode !== undefined && input.mode !== 'turn' && input.mode !== 'opening') {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.mode 无效');
    }
    return cloneJson(input, 'generateVirtual input');
  }

  function findLastUser(chat, input) {
    const marked = chat.filter(message => message?.is_user && message?._islandmilfcode_current_turn === true);
    if (marked.length > 1) throw new BridgeError('INVALID_REQUEST', '虚拟时间线含有多个当前 user');
    if (marked.length === 1) return marked[0];
    for (let index = chat.length - 1; index >= 0; index -= 1) {
      if (chat[index]?.is_user && String(chat[index].mes ?? '').trim() === String(input.userInput).trim()) {
        return chat[index];
      }
    }
    return null;
  }

  function findCurrentAssistant(chat, user, minimumIndex = 0) {
    if (!user) return null;
    const userIndex = chat.indexOf(user);
    const candidates = chat
      .slice(Math.max(userIndex + 1, minimumIndex))
      .filter(message => !message?.is_user && !message?._qrf_from_planning && !message?.extra?._qrf_from_planning);
    return candidates[candidates.length - 1] || null;
  }

  function refreshCurrentTurn(chat, input, assistantMessageId, minimumIndex = 0) {
    const user = findLastUser(chat, input);
    const assistant = chat.find(message => Number(message?.message_id) === assistantMessageId)
      || findCurrentAssistant(chat, user, minimumIndex);
    return { user, assistant };
  }

  async function runVirtualGeneration(input) {
    const runtime = findShujukuRuntime();
    if (!runtime) throw new BridgeError('SHUJUKU_RUNTIME_UNAVAILABLE', '未找到带包装 generate 的 shujuku 运行时');
    const chat = buildVirtualChat(input);
    const isolationKey = readActiveIsolationKey();
    const restores = [];
    const diagnostics = {
      runtimeKind: runtime.runtimeKind,
      frameId: runtime.frame?.id || null,
      virtualWrites: 0,
      virtualCreates: 0,
      virtualDeletes: 0,
      planningSaveCalls: 0,
      databaseSaveCalls: 0,
      databaseSaveBaseline: 0,
      triggerCalled: false,
      adapterRestored: false,
    };
    const getMessages = (range, options) => selectVirtualMessages(chat, range, options);
    const setMessages = async updates => {
      diagnostics.virtualWrites += Array.isArray(updates) ? updates.length : 0;
      applyVirtualUpdates(chat, updates);
    };
    const createMessages = async inputs => {
      for (const inputMessage of Array.isArray(inputs) ? inputs : []) {
        const isUser = inputMessage?.role === 'user';
        const text = String(inputMessage?.message ?? inputMessage?.mes ?? '');
        chat.push({
          ...cloneJson(inputMessage, 'virtual create message'),
          message_id: chat.length,
          role: isUser ? 'user' : 'assistant',
          is_user: isUser,
          is_system: false,
          mes: text,
          message: text,
          extra: inputMessage?.extra && isRecord(inputMessage.extra) ? cloneJson(inputMessage.extra) : {},
          data: inputMessage?.data && isRecord(inputMessage.data) ? cloneJson(inputMessage.data) : {},
        });
        diagnostics.virtualCreates += 1;
      }
      normalizeVirtualIds(chat);
    };
    const deleteMessages = async ids => {
      const deleteIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))]
        .filter(id => Number.isInteger(id) && id > 0)
        .sort((a, b) => b - a);
      for (const id of deleteIds) {
        if (chat[id]) {
          chat.splice(id, 1);
          diagnostics.virtualDeletes += 1;
        }
      }
      normalizeVirtualIds(chat);
    };
    const saveChat = async () => {
      if (diagnostics.triggerCalled) diagnostics.databaseSaveCalls += 1;
      else diagnostics.planningSaveCalls += 1;
    };
    let virtualUser;
    let virtualAssistant;
    let rawText = '';
    let triggerResult;
    let result;
    try {
      patchRuntimeProperty(runtime.sillyTavern, 'chat', chat, restores, 'SillyTavern.chat');
      patchRuntimeProperty(runtime.sillyTavern, 'saveChat', saveChat, restores, 'SillyTavern.saveChat');
      patchRuntimeProperty(runtime.sillyTavern, 'setChatMessages', setMessages, restores, 'SillyTavern.setChatMessages');
      patchRuntimeProperty(
        runtime.sillyTavern,
        'deleteLastMessage',
        async () => deleteMessages([chat.length - 1]),
        restores,
        'SillyTavern.deleteLastMessage',
      );
      patchRuntimeProperty(runtime.tavernHelper, 'getChatMessages', getMessages, restores, 'TavernHelper.getChatMessages');
      patchRuntimeProperty(runtime.tavernHelper, 'getLastMessageId', () => chat.length - 1, restores, 'TavernHelper.getLastMessageId');
      patchRuntimeProperty(runtime.tavernHelper, 'setChatMessages', setMessages, restores, 'TavernHelper.setChatMessages');
      patchRuntimeProperty(runtime.tavernHelper, 'createChatMessages', createMessages, restores, 'TavernHelper.createChatMessages');
      patchRuntimeProperty(runtime.tavernHelper, 'deleteChatMessages', deleteMessages, restores, 'TavernHelper.deleteChatMessages');

      virtualUser = findLastUser(chat, input);
      if (!virtualUser) throw new BridgeError('INVALID_REQUEST', '虚拟时间线缺少当前 user');
      clearPlanningEvidence(virtualUser);
      const historyPrompts = [];
      if (String(input.systemPrompt || '').trim()) {
        historyPrompts.push({ role: 'system', content: String(input.systemPrompt).trim() });
      }
      for (const message of chat.slice(1, -1)) {
        if (!message?.mes || message._qrf_from_planning) continue;
        historyPrompts.push({ role: message.is_user ? 'user' : 'assistant', content: String(message.mes) });
      }
      const options = {
        user_input: String(input.userInput),
        should_stream: false,
        should_silence: true,
        generation_id: String(input.generationId),
        max_chat_history: 0,
        overrides: { chat_history: { prompts: historyPrompts, with_depth_entries: true } },
      };
      const assistantStartIndex = chat.length;
      rawText = normalizeGeneratedResult(await runtime.tavernHelper.generate.call(runtime.tavernHelper, options));
      if (!rawText.trim()) throw new BridgeError('SHUJUKU_GENERATION_EMPTY', 'shujuku 包装 generate 返回空正文');
      virtualUser = findLastUser(chat, input) || virtualUser;
      const plannedTextFromOptions = readPlannedTextFromOptions(options, input.userInput);
      let qrf;
      let plannedText;
      let userPluginData;
      // Planning writers may finish after generate returns. Wait only on this
      // turn's virtual user before assistant append and database triggering.
      for (let attempt = 0; attempt < QRF_POLL_ATTEMPTS; attempt += 1) {
        virtualUser = findLastUser(chat, input) || virtualUser;
        userPluginData = extractPluginData(virtualUser);
        qrf = readQrf(virtualUser);
        plannedText = plannedTextFromOptions || readPlannedText(virtualUser, input.userInput);
        if (hasPlanningResult(qrf)) break;
        if (attempt + 1 < QRF_POLL_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, QRF_POLL_INTERVAL_MS));
        }
      }
      virtualAssistant = findCurrentAssistant(chat, virtualUser, assistantStartIndex);
      if (!virtualAssistant) {
        await createMessages([{ role: 'assistant', message: rawText, name: '助手' }]);
        virtualAssistant = findCurrentAssistant(chat, virtualUser, assistantStartIndex) || chat[chat.length - 1];
      } else {
        virtualAssistant.mes = rawText;
        virtualAssistant.message = rawText;
      }
      normalizeVirtualIds(chat);
      const virtualAssistantMessageId = Number(virtualAssistant?.message_id);
      const beforeStorageFrame = findStorageFrame(virtualAssistant, isolationKey);
      const beforeTables = typeof runtime.api.exportTableAsJson === 'function'
        ? cloneJson(await runtime.api.exportTableAsJson.call(runtime.api), 'shujuku 触发前表快照')
        : undefined;
      diagnostics.databaseSaveBaseline = diagnostics.databaseSaveCalls;
      diagnostics.triggerCalled = true;
      triggerResult = await runtime.api.triggerUpdate.call(runtime.api);
      let assistantPluginData;
      let afterStorageFrame;
      // Database writers can finish after triggerUpdate returns; keep both
      // evidence reads bound to this turn's virtual user/assistant pair.
      for (let attempt = 0; attempt < QRF_POLL_ATTEMPTS; attempt += 1) {
        const currentTurn = refreshCurrentTurn(chat, input, virtualAssistantMessageId, assistantStartIndex);
        virtualUser = currentTurn.user || virtualUser;
        virtualAssistant = currentTurn.assistant || virtualAssistant;
        assistantPluginData = extractPluginData(virtualAssistant);
        userPluginData = extractPluginData(virtualUser);
        qrf = readQrf(virtualUser);
        plannedText = plannedTextFromOptions || readPlannedText(virtualUser, input.userInput);
        afterStorageFrame = findStorageFrame(virtualAssistant, isolationKey);
        if (afterStorageFrame) break;
        if (attempt + 1 < QRF_POLL_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, QRF_POLL_INTERVAL_MS));
        }
      }
      const tables = typeof runtime.api.exportTableAsJson === 'function'
        ? cloneJson(await runtime.api.exportTableAsJson.call(runtime.api), 'shujuku 表快照')
        : undefined;
      const currentTurn = refreshCurrentTurn(chat, input, virtualAssistantMessageId, assistantStartIndex);
      virtualUser = currentTurn.user || virtualUser;
      virtualAssistant = currentTurn.assistant || virtualAssistant;
      assistantPluginData = extractPluginData(virtualAssistant);
      userPluginData = extractPluginData(virtualUser);
      afterStorageFrame = findStorageFrame(virtualAssistant, isolationKey) || afterStorageFrame;
      const storageFrameChanged = Boolean(
        afterStorageFrame
        && (!beforeStorageFrame
          || fingerprint(beforeStorageFrame.storageFrame, 'storage frame before')
            !== fingerprint(afterStorageFrame.storageFrame, 'storage frame after')),
      );
      const databaseCommitted = Boolean(
        triggerResult !== false
        && !(isRecord(triggerResult)
          && (triggerResult.success === false
            || triggerResult.ok === false
            || triggerResult.error !== undefined && triggerResult.error !== null))
        && diagnostics.databaseSaveCalls > diagnostics.databaseSaveBaseline
        && assistantPluginData
        && afterStorageFrame
        && storageFrameChanged
        && tables && isRecord(tables),
      );
      // plannedText may only reflect the wrapper rewriting generation options.
      // The current virtual user's qrf fields are the planning commit evidence.
      const planningObserved = hasPlanningResult(qrf);
      result = {
        rawText,
        ...(plannedText ? { plannedText } : {}),
        ...(userPluginData ? { userPluginData } : {}),
        ...(assistantPluginData ? { assistantPluginData } : {}),
        ...(tables && isRecord(tables)
          ? {
              tableSnapshot: {
                capturedAt: new Date().toISOString(),
                tableHash: await sha256Value(tables),
                tables,
              },
            }
          : {}),
        planningObserved,
        databaseCommitted,
        diagnostics: {
          ...diagnostics,
          qrfKeys: qrf ? Object.keys(qrf) : [],
          triggerResult: triggerResult === undefined ? null : triggerResult,
          databaseSaveBaseline: diagnostics.databaseSaveBaseline,
          databaseSaveCallsAfterTrigger: diagnostics.databaseSaveCalls,
          virtualChatLength: chat.length,
          databaseStorageObserved: Boolean(assistantPluginData && afterStorageFrame),
          storageFrameLocation: afterStorageFrame?.location ?? null,
          isolationKey,
          storageFrameChanged,
          tableChanged: beforeTables && tables
            ? fingerprint(beforeTables, 'table before') !== fingerprint(tables, 'table after')
            : null,
        },
      };
    } finally {
      let restoreError;
      for (const restore of restores.reverse()) {
        try { restore(); } catch (error) { restoreError ??= error; }
      }
      diagnostics.adapterRestored = !restoreError;
      if (restoreError) {
        throw new BridgeError(
          'SHUJUKU_RUNTIME_RESTORE_FAILED',
          `shujuku 虚拟 runtime 恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
    }
    if (result) {
      result.diagnostics = { ...result.diagnostics, adapterRestored: diagnostics.adapterRestored };
    }
    return result;
  }

  function findStorageFrame(value, isolationKey, seen = new Set(), depth = 0) {
    if (depth > 8 || value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
      try { return findStorageFrame(JSON.parse(text), isolationKey, seen, depth + 1); } catch { return null; }
    }
    if (!isObjectLike(value) || seen.has(value)) return null;
    seen.add(value);
    if (isolationKey && isRecord(value.TavernDB_ACU_IsolatedData)) {
      const slot = value.TavernDB_ACU_IsolatedData[isolationKey];
      if (isRecord(slot) && isRecord(slot.storageFrame)) {
        return {
          storageFrame: cloneIfJson(slot.storageFrame),
          location: `TavernDB_ACU_IsolatedData.${isolationKey}.storageFrame`,
        };
      }
    }
    if (!isolationKey && isRecord(value.storageFrame)) {
      return { storageFrame: cloneIfJson(value.storageFrame), location: 'storageFrame' };
    }
    for (const [key, child] of Object.entries(value)) {
      const found = findStorageFrame(child, isolationKey, seen, depth + 1);
      if (found) return { ...found, location: `${key}.${found.location}` };
    }
    return null;
  }

  function assertEnvelope(value) {
    if (!isRecord(value)) throw new BridgeError('INVALID_REQUEST', 'request 必须是对象');
    if (value.protocolVersion !== PROTOCOL_VERSION) {
      throw new BridgeError('PROTOCOL_MISMATCH', `协议版本必须是 ${PROTOCOL_VERSION}`);
    }
    const requestId = assertToken(value.requestId, 'request.requestId');
    const action = assertToken(value.action, 'request.action', 64);
    if (!ACTIONS.has(action)) throw new BridgeError('UNSUPPORTED_ACTION', `不支持的操作：${action}`);
    if (action === 'probe' || action === 'exportTableAsJson') {
      assertKeys(value, `${action} request`, ['protocolVersion', 'requestId', 'action']);
      return { protocolVersion: PROTOCOL_VERSION, requestId, action, payload: {} };
    }
    if (action === 'generateVirtual') {
      assertKeys(value, `${action} request`, ['protocolVersion', 'requestId', 'action', 'inputJson']);
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        action,
        payload: { input: parseVirtualInput(value.inputJson) },
      };
    }
    assertKeys(value, `${action} request`, ['protocolVersion', 'requestId', 'action', 'tableJson']);
    if (typeof value.tableJson !== 'string' || !value.tableJson) {
      throw new BridgeError('INVALID_REQUEST', 'tableJson 必须是非空 JSON 字符串');
    }
    try {
      if (!isRecord(JSON.parse(value.tableJson))) throw new TypeError('顶层必须是对象');
    } catch (error) {
      throw new BridgeError('INVALID_REQUEST', `tableJson 无效：${error instanceof Error ? error.message : String(error)}`);
    }
    return { protocolVersion: PROTOCOL_VERSION, requestId, action, payload: { tableJson: value.tableJson } };
  }

  const requestCalls = new Map();
  let operationQueue = Promise.resolve();
  let stopped = false;

  function trimCache(cache) {
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  async function dispatch(request) {
    if (request.action === 'probe') return probeRuntime();
    if (stopped) throw new BridgeError('BRIDGE_RELOADED', '角色脚本桥已停止');
    if (request.action === 'exportTableAsJson') {
      return { tables: cloneJson(await invokeApi('exportTableAsJson'), 'exportTableAsJson 返回值') };
    }
    if (request.action === 'generateVirtual') return runVirtualGeneration(request.payload.input);
    const fallback = request.action === 'restoreTableAsJson'
      && typeof findApi()?.api?.restoreTableAsJson !== 'function';
    const method = fallback ? 'importTableAsJson' : request.action;
    const value = await invokeApi(method, request.payload.tableJson, { persist: false, mode: 'restore' });
    if (value === false) throw new BridgeError('SHUJUKU_RESTORE_REJECTED', `AutoCardUpdaterAPI.${method} 返回 false`);
    return {
      applied: true,
      method,
      value: value === undefined ? null : cloneJson(value, `${method} 返回值`),
    };
  }

  function serialize(request) {
    if (request.action === 'probe') return dispatch(request);
    const operation = operationQueue.catch(() => undefined).then(() => dispatch(request));
    operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function errorDetails(error) {
    return {
      code: typeof error?.code === 'string' ? error.code : 'SHUJUKU_BRIDGE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  async function buildResponse(rawRequest) {
    try {
      const request = assertEnvelope(rawRequest);
      const result = await serialize(request);
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        action: request.action,
        backend: BACKEND,
        ok: true,
        result: result === undefined ? null : cloneJson(result, `${request.action} result`),
      };
    } catch (error) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: typeof rawRequest?.requestId === 'string' ? rawRequest.requestId : '',
        action: typeof rawRequest?.action === 'string' ? rawRequest.action : '',
        backend: BACKEND,
        ok: false,
        error: errorDetails(error),
      };
    }
  }

  async function emitResponse(response) {
    try { await eventEmit(RESPONSE_EVENT, response); } catch (error) {
      console.warn('[IslandMilfCode shujuku bridge] response emit failed:', error);
    }
  }

  async function handleRequest(rawRequest) {
    let requestFingerprint;
    try { requestFingerprint = fingerprint(rawRequest, 'request'); } catch {
      await emitResponse(await buildResponse(rawRequest));
      return;
    }
    const requestId = rawRequest?.requestId;
    const existing = requestCalls.get(requestId);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        await emitResponse({
          protocolVersion: PROTOCOL_VERSION,
          requestId: typeof requestId === 'string' ? requestId : '',
          action: typeof rawRequest?.action === 'string' ? rawRequest.action : '',
          backend: BACKEND,
          ok: false,
          error: errorDetails(new BridgeError('REQUEST_ID_CONFLICT', '同一 requestId 收到了不同请求')),
        });
        return;
      }
      await emitResponse(await existing.promise);
      return;
    }
    const promise = buildResponse(rawRequest);
    if (typeof requestId === 'string') {
      requestCalls.set(requestId, { fingerprint: requestFingerprint, promise });
      trimCache(requestCalls);
    }
    await emitResponse(await promise);
  }

  if (typeof eventOn !== 'function' || typeof eventEmit !== 'function') {
    console.warn('[IslandMilfCode shujuku bridge] 酒馆助手事件接口不可用，角色脚本桥未启动');
    return;
  }

  try {
    try { globalThis[RUNTIME_KEY]?.stop?.(); } catch { /* stale bridge cleanup */ }
    const subscription = eventOn(REQUEST_EVENT, rawRequest => {
      if (!isRecord(rawRequest) || typeof rawRequest.requestId !== 'string' || typeof rawRequest.action !== 'string') return;
      void handleRequest(rawRequest);
    });
    globalThis[RUNTIME_KEY] = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        subscription?.stop?.();
      },
    };
    console.info(`[IslandMilfCode shujuku bridge] v${BRIDGE_VERSION} table relay started`);
  } catch (error) {
    console.warn('[IslandMilfCode shujuku bridge] 初始化失败:', error);
  }
})();
