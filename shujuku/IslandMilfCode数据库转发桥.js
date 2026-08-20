(() => {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const BRIDGE_VERSION = '6.3.1';
  const REQUEST_EVENT = 'islandmilfcode:shujuku-relay:request:v1';
  const RESPONSE_EVENT = 'islandmilfcode:shujuku-relay:response:v1';
  const PROGRESS_ACK_EVENT = 'islandmilfcode:shujuku-relay:progress-ack:v1';
  const CANCEL_EVENT = 'islandmilfcode:shujuku-relay:cancel:v1';
  const RUNTIME_KEY = '__islandmilfcodeShujukuRoleBridgeV1__';
  const BACKEND = 'shujuku-role-bridge';
  const CLIENT_BACKEND = 'islandmilfcode';
  const MAX_CACHE_ENTRIES = 128;
  const MAX_VIRTUAL_MESSAGES = 4096;
  const MAX_PROMPT_MESSAGES = 1024;
  const MAX_VIRTUAL_INPUT_LENGTH = 32_000_000;
  const SHUJUKU_FRAME_SELECTOR = 'iframe[id^="TH-script--"]';
  // qrf_plot is the upstream planning commit. Tasks and preset are optional
  // metadata and must never open the正文 gate by themselves.
  const PLANNING_RESULT_KEYS = ['qrf_plot'];
  const QRF_KEYS = [
    'qrf_plot',
    'qrf_plot_tasks',
    'qrf_plot_preset',
    '_qrf_from_planning',
    '_qrf_plot_pending_hash',
    '_qrf_plot_round_id',
  ];
  const QRF_POLL_ATTEMPTS = 22;
  const QRF_POLL_INTERVAL_MS = 100;
  const DATABASE_POLL_ATTEMPTS = 60;
  const DATABASE_POLL_INTERVAL_MS = 100;
  const BRIDGE_STORAGE_FRAME_VERSION = 2;
  const PLUGIN_KEY_PATTERN = /^(?:TavernDB_ACU_|qrf_|_qrf_|_plot_)/;
  const PLANNING_CONTEXT_PLUGIN_KEY = '_islandmilfcode_planning_context_v1';
  const BODY_CONTEXT_TAG = 'island_runtime_body_context';
  const TABLE_FILL_FORMAT = 'table_edit_ops_v1';
  const EMPTY_OPERATION_LOG_ERROR = 'V2 operation log requires explicit operations for source=group_fill; snapshot diff fallback is not allowed.';
  const CHAT_SCOPED_CONFIG_FIELD = 'TavernDB_ACU_ScopedConfig';
  const CHAT_SHEET_GUIDE_FIELD = 'TavernDB_ACU_InternalSheetGuide';
  const MAX_PLANNING_CONTEXT_LENGTH = 100_000;
  const MAX_BODY_CONTEXT_LENGTH = 120_000;
  const PROGRESS_ACK_TIMEOUT_MS = 30_000;
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

  function takePlanningContext(message) {
    if (!isObjectLike(message)) return {
      requested: false,
      content: null,
      userIdentity: null,
      reason: 'missing-current-user',
    };
    const candidates = [message, message.extra, message.data].filter(isRecord);
    let raw;
    for (const candidate of candidates) {
      if (raw === undefined && Object.prototype.hasOwnProperty.call(candidate, PLANNING_CONTEXT_PLUGIN_KEY)) {
        raw = candidate[PLANNING_CONTEXT_PLUGIN_KEY];
      }
      delete candidate[PLANNING_CONTEXT_PLUGIN_KEY];
    }
    if (raw === undefined) return { requested: false, content: null, userIdentity: null, reason: 'missing-payload' };
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.content !== 'string') {
      return { requested: true, content: null, userIdentity: null, reason: 'invalid-payload' };
    }
    const content = raw.content.trim();
    if (!content) return { requested: true, content: null, userIdentity: null, reason: 'empty-payload' };
    if (content.length > MAX_PLANNING_CONTEXT_LENGTH) {
      return { requested: true, content: null, userIdentity: null, reason: 'payload-too-large' };
    }
    const identity = isRecord(raw.userIdentity)
      && typeof raw.userIdentity.name === 'string'
      && typeof raw.userIdentity.persona === 'string'
      ? {
          name: raw.userIdentity.name.trim() || '用户',
          persona: raw.userIdentity.persona.trim(),
        }
      : null;
    return { requested: true, content, userIdentity: identity, reason: null };
  }

  // ACU resolves $U from the host runtime (name1/persona_description), not
  // from the Island UI state. Overlay every supported host view for the
  // duration of this virtual turn so table filling cannot inherit the card's
  // default protagonist. The original objects/functions are restored by the
  // common `restores` stack on both success and failure.
  function installUserIdentityOverlay(runtime, identity, restores, diagnostics) {
    if (!isRecord(identity) || !String(identity.name ?? '').trim()) return null;
    const name = String(identity.name).trim();
    const persona = String(identity.persona ?? '').trim();
    diagnostics.userIdentityOverlayReads = 0;
    const tavernTargets = [];
    for (const target of [runtime.sillyTavern, runtime.hostSillyTavern]) {
      if (isObjectLike(target) && !tavernTargets.includes(target)) tavernTargets.push(target);
    }
    const patchIfPossible = (target, key, value, label) => {
      if (!target) return false;
      try {
        patchRuntimeProperty(target, key, value, restores, label);
        return true;
      } catch {
        return false;
      }
    };
    let patched = 0;
    for (const [index, target] of tavernTargets.entries()) {
      const scope = index === 0 ? 'iframe' : 'host';
      if (patchIfPossible(target, 'name1', name, `${scope}.SillyTavern.name1`)) patched += 1;
      if (patchIfPossible(target, 'persona_description', persona, `${scope}.SillyTavern.persona_description`)) patched += 1;
      const powerUserSettings = target.powerUserSettings;
      if (isRecord(powerUserSettings)) {
        const overlaySettings = { ...powerUserSettings, persona_description: persona };
        if (patchIfPossible(target, 'powerUserSettings', overlaySettings, `${scope}.SillyTavern.powerUserSettings`)) patched += 1;
      }
    }
    if (patchIfPossible(runtime.runtimeWindow, 'name1', name, 'runtime.name1')) patched += 1;
    if (patchIfPossible(runtime.hostWindow, 'name1', name, 'host.runtime.name1')) patched += 1;

    for (const [index, target] of [runtime.runtimeWindow, runtime.hostWindow].entries()) {
      const powerUser = target?.power_user;
      if (isRecord(powerUser)) {
        const overlayPowerUser = { ...powerUser, persona_description: persona };
        if (patchIfPossible(target, 'power_user', overlayPowerUser, `${index === 0 ? 'runtime' : 'host.runtime'}.power_user`)) patched += 1;
      }
    }

    for (const [index, target] of tavernTargets.entries()) {
      const originalGetContext = target.getContext;
      if (typeof originalGetContext !== 'function') continue;
      const scope = index === 0 ? 'iframe' : 'host';
      const overlayGetContext = function (...args) {
        diagnostics.userIdentityOverlayReads += 1;
        const context = originalGetContext.apply(this, args);
        const base = isRecord(context) ? context : {};
        const settings = isRecord(base.powerUserSettings) ? base.powerUserSettings : {};
        return {
          ...base,
          name1: name,
          persona_description: persona,
          powerUserSettings: { ...settings, persona_description: persona },
        };
      };
      if (patchIfPossible(target, 'getContext', overlayGetContext, `${scope}.SillyTavern.getContext user identity`)) patched += 1;
    }
    diagnostics.userIdentityOverlayInstalled = patched > 0;
    return patched > 0 ? { name, persona } : null;
  }

  function appendRuntimeContext(description, tag, content) {
    const base = String(description ?? '').trimEnd();
    const appendix = `<${tag}>\n${content}\n</${tag}>`;
    return base ? `${base}\n\n${appendix}` : appendix;
  }

  // The Island appendix is a body-authority projection.  It must not be
  // installed while shujuku is producing qrf planning: opening turns have no
  // Island preflight yet, and the shujuku preset is the planning authority.
  // Install the appendix only around the wrapped host call that emits the
  // actual正文, then restore the character reader immediately afterwards.
  async function installBodyContextBoundary(
    runtime,
    restores,
    diagnostics,
    ensurePlanningProjection,
    userIdentity,
  ) {
    const getCharData = runtime.tavernHelper?.getCharData;
    const originalBodyGenerate = runtime.runtimeWindow?.original_TavernHelper_generate_ACU;
    if (typeof getCharData !== 'function') {
      diagnostics.planningContextSkipReason = 'get-char-data-unavailable';
      return null;
    }
    if (typeof originalBodyGenerate !== 'function') {
      diagnostics.planningContextSkipReason = 'body-boundary-unavailable';
      return null;
    }
    let wrapperSource = '';
    try { wrapperSource = Function.prototype.toString.call(runtime.tavernHelper.generate); } catch { /* unavailable */ }
    if (!wrapperSource.includes('original_TavernHelper_generate_ACU')) {
      diagnostics.planningContextSkipReason = 'body-boundary-unconfirmed';
      return null;
    }

    let baseCharacter;
    try { baseCharacter = getCharData.call(runtime.tavernHelper, 'current'); } catch { /* unavailable */ }
    if (!isRecord(baseCharacter)) {
      diagnostics.planningContextSkipReason = 'current-character-unavailable';
      return null;
    }

    let bodyContext = '';
    let planningProjectionStarted = false;
    let planningCheckpointAcknowledged = false;
    let projectionSettled = false;
    let resolveProjectionReady;
    let rejectProjectionReady;
    const projectionReady = new Promise((resolve, reject) => {
      resolveProjectionReady = resolve;
      rejectProjectionReady = reject;
    });
    projectionReady.catch(() => undefined);
    let restoreBoundary;
    try {
      const boundaryWrapper = async function (...args) {
        // The native wrapper rewrites this call's options after planning, but
        // its deferred save may miss the virtual chat. The body boundary is
        // the synchronous commit point: persist that real planning result,
        // publish/ACK it, then allow the正文 API to run.
        if (!planningCheckpointAcknowledged && typeof ensurePlanningProjection === 'function') {
          planningProjectionStarted = true;
          await ensurePlanningProjection(args[0]);
        }
        if (!planningProjectionStarted) {
          throw new BridgeError(
            'SHUJUKU_PLANNING_CHECKPOINT_MISSED',
            'shujuku 尚未提交当前回合的 qrf 规划，拒绝越过正文生成边界。',
          );
        }
        if (!planningCheckpointAcknowledged) await projectionReady;
        if (!planningCheckpointAcknowledged || !bodyContext) {
          throw new BridgeError(
            'SHUJUKU_BODY_CONTEXT_EMPTY',
            '正文主 API 未收到已确认的 Island 正文上下文。',
          );
        }
        const localRestores = [];
        try {
          const overlayGetCharData = function (...charArgs) {
            const character = getCharData.apply(this, charArgs);
            const target = charArgs.length ? charArgs[0] : 'current';
            if (target !== 'current' || !isRecord(character)) return character;
            diagnostics.bodyContextVisibleReads += 1;
            const description = character.description || character.data?.description || '';
            return {
              ...character,
              description: appendRuntimeContext(description, BODY_CONTEXT_TAG, bodyContext),
            };
          };
          patchRuntimeProperty(
            runtime.tavernHelper,
            'getCharData',
            overlayGetCharData,
            localRestores,
            'TavernHelper.getCharData body overlay',
          );
          const probe = runtime.tavernHelper.getCharData('current');
          if (!isRecord(probe) || !String(probe.description ?? '').includes(`<${BODY_CONTEXT_TAG}>`)) {
            throw new BridgeError('SHUJUKU_BODY_CONTEXT_UNAVAILABLE', '正文主 API 的角色上下文覆盖回读不一致。');
          }
          diagnostics.bodyContextInjected = true;
          diagnostics.bodyContextBoundaryObserved = true;
          diagnostics.bodyContextVisibleReads = 0;
          // Tavern Helper documents `overrides.char_description` as the
          // prompt-level authority for the character description.  Pass the
          // acknowledged projection through that boundary as well as the
          // temporary reader overlay.  The latter is still needed by
          // triggerUpdate and by runtimes that resolve character data lazily;
          // the former makes正文 generation independent of an incidental
          // getCharData read.
          const originalOptions = args[0];
          if (!isRecord(originalOptions)) {
            throw new BridgeError(
              'SHUJUKU_BODY_CONTEXT_UNAVAILABLE',
              '正文主 API 调用缺少可覆盖的 generate options。',
            );
          }
          const baseDescription = baseCharacter.description || baseCharacter.data?.description || '';
          const bodyDescription = appendRuntimeContext(baseDescription, BODY_CONTEXT_TAG, bodyContext);
          const originalOverrides = isRecord(originalOptions.overrides)
            ? originalOptions.overrides
            : {};
          const bodyOverrides = {
            ...originalOverrides,
            char_description: bodyDescription,
            ...(isRecord(userIdentity) && String(userIdentity.persona ?? '').trim()
              ? { persona_description: String(userIdentity.persona).trim() }
              : {}),
          };
          const bodyOptions = {
            ...originalOptions,
            overrides: bodyOverrides,
          };
          const bodyArgs = [bodyOptions, ...args.slice(1)];
          diagnostics.bodyPromptOverrideInjected = true;
          diagnostics.bodyPromptOverridePassed = true;
          diagnostics.bodyPromptOverrideLength = bodyDescription.length;
          diagnostics.bodyGenerationStartedAt = Date.now();
          const result = await originalBodyGenerate.apply(this, bodyArgs);
          return result;
        } finally {
          let restoreError;
          for (const restore of localRestores.reverse()) {
            try { restore(); } catch (error) { restoreError ??= error; }
          }
          diagnostics.bodyContextRestoredAfterBody = !restoreError;
          if (restoreError) {
            throw new BridgeError(
              'SHUJUKU_BODY_CONTEXT_RESTORE_FAILED',
              `正文主 API 上下文恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            );
          }
        }
      };
      restoreBoundary = patchRuntimeProperty(
        runtime.runtimeWindow,
        'original_TavernHelper_generate_ACU',
        boundaryWrapper,
        restores,
        'original_TavernHelper_generate_ACU planning boundary',
      );
    } catch {
      diagnostics.planningContextSkipReason = 'body-boundary-install-failed';
      return null;
    }

    diagnostics.bodyContextBoundaryInstalled = true;
    diagnostics.planningContextSkipReason = null;
    return {
      beginPlanningProjection() {
        planningProjectionStarted = true;
      },
      acknowledgePlanningProjection(acknowledgement) {
        if (!isRecord(acknowledgement) || acknowledgement.projectionCommitted !== true) {
          throw new BridgeError('SHUJUKU_PLANNING_PROJECTION_UNCOMMITTED', 'Island 规划投影未确认提交。');
        }
        const rawBodyContext = String(acknowledgement.bodyContext ?? '').trim();
        if (!rawBodyContext) {
          throw new BridgeError('SHUJUKU_BODY_CONTEXT_EMPTY', 'Island 规划投影没有返回角色与剧情正文上下文。');
        }
        if (rawBodyContext.length > MAX_BODY_CONTEXT_LENGTH) {
          throw new BridgeError('SHUJUKU_BODY_CONTEXT_TOO_LARGE', 'Island 正文附录超过允许长度。');
        }
        bodyContext = rawBodyContext;
        planningCheckpointAcknowledged = true;
        projectionSettled = true;
        resolveProjectionReady?.(true);
        diagnostics.planningProjectionAcknowledged = true;
        diagnostics.bodyContextLength = bodyContext.length;
        return bodyContext;
      },
      rejectPlanningProjection(error) {
        if (projectionSettled) return;
        projectionSettled = true;
        rejectProjectionReady?.(error instanceof Error
          ? error
          : new BridgeError('SHUJUKU_PLANNING_NOT_OBSERVED', 'shujuku 当前虚拟 user 没有已提交的 qrf 规划。'));
      },
      restore() {
        if (!projectionSettled) {
          projectionSettled = true;
          rejectProjectionReady?.(new BridgeError('SHUJUKU_PLANNING_CONTEXT_CANCELLED', 'Island 规划投影已取消。'));
        }
        restoreBoundary?.();
      },
    };
  }

  async function withTriggerBodyContext(runtime, bodyContext, diagnostics, operation) {
    const content = String(bodyContext ?? '').trim();
    if (!content) throw new BridgeError('SHUJUKU_BODY_CONTEXT_EMPTY', '填表阶段缺少已确认的正文上下文。');
    const getCharData = runtime.tavernHelper?.getCharData;
    if (typeof getCharData !== 'function') {
      throw new BridgeError('SHUJUKU_TRIGGER_CONTEXT_UNAVAILABLE', '填表阶段无法覆盖当前角色资料。');
    }
    const localRestores = [];
    try {
      const overlayGetCharData = function (...args) {
        const character = getCharData.apply(this, args);
        const target = args.length ? args[0] : 'current';
        if (target !== 'current' || !isRecord(character)) return character;
        diagnostics.triggerBodyContextVisibleReads += 1;
        const description = character.description || character.data?.description || '';
        return {
          ...character,
          description: appendRuntimeContext(description, BODY_CONTEXT_TAG, content),
        };
      };
      patchRuntimeProperty(
        runtime.tavernHelper,
        'getCharData',
        overlayGetCharData,
        localRestores,
        'TavernHelper.getCharData trigger body overlay',
      );
      const probe = runtime.tavernHelper.getCharData('current');
      if (!isRecord(probe) || !String(probe.description ?? '').includes(`<${BODY_CONTEXT_TAG}>`)) {
        throw new BridgeError('SHUJUKU_TRIGGER_CONTEXT_UNAVAILABLE', '填表正文上下文覆盖回读不一致。');
      }
      diagnostics.triggerBodyContextVisibleReads = 0;
      diagnostics.triggerBodyContextInjected = true;
      return await operation();
    } finally {
      let restoreError;
      for (const restore of localRestores.reverse()) {
        try { restore(); } catch (error) { restoreError ??= error; }
      }
        diagnostics.triggerBodyContextRestored = !restoreError;
        diagnostics.bodyContextRestoredAfterTrigger = !restoreError;
      if (restoreError) {
        throw new BridgeError(
          'SHUJUKU_TRIGGER_CONTEXT_RESTORE_FAILED',
          `填表正文上下文恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
    }
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
    // The upstream writer removes this marker only after host save succeeds.
    // Seeing qrf_plot while it remains means the current round is still
    // pending and must not cross into正文 generation.
    if (Object.prototype.hasOwnProperty.call(qrf, '_qrf_plot_pending_hash')
      && qrf._qrf_plot_pending_hash !== undefined
      && qrf._qrf_plot_pending_hash !== null) return false;
    const value = qrf[PLANNING_RESULT_KEYS[0]];
    return typeof value === 'string' && Boolean(value.trim());
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

  function isPlanningText(value) {
    const text = String(value ?? '').trim();
    return /<kirihime_review(?:\s[^>]*)?>[\s\S]*<\/kirihime_review>/i.test(text);
  }

  function commitPlanningText(message, plannedText, generationId) {
    if (!isObjectLike(message) || !isPlanningText(plannedText)) return false;
    for (const target of [message, message.extra, message.data]) {
      if (!isRecord(target)) continue;
      delete target.qrf_plot;
      delete target._qrf_plot_pending_hash;
      delete target._qrf_plot_round_id;
    }
    message.qrf_plot = String(plannedText).trim();
    message._qrf_plot_round_id = String(generationId);
    return true;
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

  function valueContainsText(value, needle, seen = new Set(), depth = 0) {
    if (typeof value === 'string') return value.includes(needle);
    if (depth > 8 || !isObjectLike(value) || seen.has(value)) return false;
    seen.add(value);
    for (const child of Object.values(value)) {
      if (valueContainsText(child, needle, seen, depth + 1)) return true;
    }
    return false;
  }

  function collectModelResponseTexts(value, output, seen = new Set(), depth = 0) {
    if (typeof value === 'string') {
      output.push(value);
      return;
    }
    if (depth > 8 || !isObjectLike(value) || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) collectModelResponseTexts(item, output, seen, depth + 1);
      return;
    }
    for (const key of ['content', 'text', 'output_text']) {
      if (typeof value[key] === 'string') output.push(value[key]);
    }
    for (const key of ['message', 'delta', 'result', 'choices', 'data', 'response', 'output']) {
      if (value[key] !== undefined) collectModelResponseTexts(value[key], output, seen, depth + 1);
    }
  }

  function responseTextCandidates(value) {
    const candidates = [];
    collectModelResponseTexts(value, candidates);
    if (typeof value !== 'string') return [...new Set(candidates)];

    const raw = value.trim();
    if (!raw) return [];
    try {
      collectModelResponseTexts(JSON.parse(raw), candidates);
    } catch {
      // A streaming backend returns one JSON payload per data line.
    }
    const streamFragments = [];
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*data:\s*(.+?)\s*$/);
      if (!match || match[1] === '[DONE]') continue;
      try {
        const fragments = [];
        collectModelResponseTexts(JSON.parse(match[1]), fragments);
        candidates.push(...fragments);
        streamFragments.push(...fragments);
      } catch {
        // Invalid stream payload cannot become no-op evidence.
      }
    }
    if (streamFragments.length) candidates.push(streamFragments.join(''));
    return [...new Set(candidates)];
  }

  function inspectTableFillResponse(value) {
    const candidates = responseTextCandidates(value);
    for (const candidate of candidates) {
      let parsed;
      try { parsed = JSON.parse(String(candidate).trim()); } catch { continue; }
      if (!isRecord(parsed) || parsed.format !== TABLE_FILL_FORMAT || !Array.isArray(parsed.ops)) continue;
      const keys = Object.keys(parsed).sort();
      if (keys.length !== 2 || keys[0] !== 'format' || keys[1] !== 'ops') continue;
      return { validEnvelope: true, operationCount: parsed.ops.length };
    }
    return { validEnvelope: false, operationCount: null };
  }

  function installTableFillResponseCapture(runtime, capture, restores, diagnostics) {
    const patchedTargets = [];
    const providers = [];
    const alreadyPatched = (target, key) => patchedTargets.some(item => item.target === target && item.key === key);
    const record = (source, response) => {
      const inspected = inspectTableFillResponse(response);
      capture.responses.push({ source, ...inspected });
      return inspected;
    };
    const patchProvider = (target, key, source, kind) => {
      if (!isObjectLike(target) || alreadyPatched(target, key)) return;
      const original = target[key];
      if (typeof original !== 'function') return;
      const wrapped = async function (...args) {
        const requestMatched = valueContainsText(args, TABLE_FILL_FORMAT);
        try {
          const response = await original.apply(this, args);
          if (kind === 'fetch') {
            if (requestMatched) {
              try {
                const raw = await response?.clone?.().text?.();
                record(source, typeof raw === 'string' ? raw : '');
              } catch {
                capture.responses.push({ source, validEnvelope: false, operationCount: null });
              }
            }
          } else {
            const inspected = inspectTableFillResponse(response);
            if (requestMatched || inspected.validEnvelope) capture.responses.push({ source, ...inspected });
          }
          return response;
        } catch (error) {
          if (requestMatched) {
            capture.responses.push({ source, validEnvelope: false, operationCount: null });
          }
          throw error;
        }
      };
      try {
        patchRuntimeProperty(target, key, wrapped, restores, `${source} table-fill response capture`);
        patchedTargets.push({ target, key });
        providers.push(source);
      } catch {
        // A provider that cannot be observed simply cannot authorize no-op.
      }
    };

    for (const target of [
      runtime.tavernHelper,
      runtime.runtimeWindow?.TavernHelper,
      runtime.runtimeWindow?.TavernHelper_API_ACU,
    ]) {
      patchProvider(target, 'generateRaw', 'generateRaw', 'direct');
    }
    const serviceCandidates = [];
    for (const target of [
      runtime.sillyTavern,
      runtime.hostSillyTavern,
      runtime.runtimeWindow?.SillyTavern_API_ACU,
    ]) {
      try {
        const service = target?.ConnectionManagerRequestService;
        if (isObjectLike(service) && !serviceCandidates.includes(service)) serviceCandidates.push(service);
      } catch { /* unavailable */ }
      try {
        const service = target?.getContext?.()?.ConnectionManagerRequestService;
        if (isObjectLike(service) && !serviceCandidates.includes(service)) serviceCandidates.push(service);
      } catch { /* unavailable */ }
    }
    for (const service of serviceCandidates) {
      patchProvider(service, 'sendRequest', 'connection-manager', 'direct');
    }
    for (const target of [runtime.runtimeWindow, runtime.hostWindow]) {
      patchProvider(target, 'fetch', 'fetch', 'fetch');
    }
    diagnostics.tableFillCaptureInstalled = providers.length > 0;
    diagnostics.tableFillCaptureProviders = [...new Set(providers)];
  }

  function isExplicitTableFillNoOp(capture) {
    return capture.responses.length > 0
      && capture.responses.every(item => item.validEnvelope === true && item.operationCount === 0);
  }

  function isExpectedEmptyOperationLogFailure(result, error) {
    const message = error instanceof Error
      ? error.message
      : isRecord(result) && typeof result.error === 'string' ? result.error : '';
    return message.includes(EMPTY_OPERATION_LOG_ERROR);
  }

  function patchRuntimeProperty(target, key, value, restores, label) {
    if (!target) throw new BridgeError('SHUJUKU_RUNTIME_UNAVAILABLE', `缺少 ${label}`);
    const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    let restored = false;
    const restore = () => {
      if (restored) return;
      if (hadOwn && descriptor) Object.defineProperty(target, key, descriptor);
      else if (hadOwn) target[key] = descriptor?.value;
      else delete target[key];
      restored = true;
    };
    restores.push(restore);
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
      if (target[key] !== value) throw new Error('替换后回读不一致');
    } catch (error) {
      let rollbackError;
      try { restore(); } catch (restoreFailure) { rollbackError = restoreFailure; }
      throw new BridgeError(
        'SHUJUKU_RUNTIME_PATCH_FAILED',
        `${label} 替换失败：${error instanceof Error ? error.message : String(error)}${
          rollbackError
            ? `；回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
            : ''
        }`,
      );
    }
    return restore;
  }

  // In extension mode shujuku's SillyTavern API is a Proxy whose getters read
  // `parent.SillyTavern.getContext()` on every access. Patching only the
  // iframe's flat `chat` property therefore leaves triggerUpdate() looking at
  // the real host chat. Overlay both getContext views and the direct API
  // aliases so every shujuku read/write in this virtual turn shares one array.
  function installVirtualChatOverlay(runtime, chat, handlers, restores, diagnostics) {
    const targets = [];
    for (const target of [
      runtime.sillyTavern,
      runtime.hostSillyTavern,
      runtime.runtimeWindow?.SillyTavern_API_ACU,
    ]) {
      if (isObjectLike(target) && !targets.includes(target)) targets.push(target);
    }
    const directKeys = [
      ['chat', chat],
      ['saveChat', handlers.saveChat],
      ['setChatMessages', handlers.setMessages],
      ['createChatMessages', handlers.createMessages],
      ['deleteChatMessages', handlers.deleteMessages],
      ['deleteLastMessage', handlers.deleteLastMessage],
      ['getChatMessages', handlers.getMessages],
      ['getLastMessageId', handlers.getLastMessageId],
      ['chatMetadata', handlers.chatMetadata],
      ['updateChatMetadata', handlers.updateChatMetadata],
    ];
    let installed = 0;
    const patchIfPossible = (target, key, value, label) => {
      if (value === undefined || value === null || !target) return;
      try {
        patchRuntimeProperty(target, key, value, restores, label);
        installed += 1;
      } catch {
        // A host proxy may expose a non-writable alias; the context wrapper
        // below is the authoritative path in that case.
      }
    };
    for (const [index, target] of targets.entries()) {
      const scope = index === 0 ? 'iframe' : index === 1 ? 'host' : 'runtime-api';
      for (const [key, value] of directKeys) {
        patchIfPossible(target, key, value, `${scope}.SillyTavern.${key}`);
      }
      const originalGetContext = target.getContext;
      if (typeof originalGetContext !== 'function') continue;
      const overlayGetContext = function (...args) {
        diagnostics.virtualContextOverlayReads += 1;
        const context = originalGetContext.apply(this, args);
        const base = isRecord(context) ? context : {};
        return {
          ...base,
          ...Object.fromEntries(directKeys.filter(([, value]) => value !== undefined)),
        };
      };
      patchIfPossible(target, 'getContext', overlayGetContext, `${scope}.SillyTavern.getContext virtual chat`);
    }
    diagnostics.virtualChatOverlayInstalled = installed > 0;
    diagnostics.virtualChatOverlayTargets = targets.length;
    return installed > 0;
  }

  function readRecordContainer(value) {
    if (isRecord(value)) return cloneIfJson(value);
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? cloneIfJson(parsed) : null;
    } catch {
      return null;
    }
  }

  function readRuntimeChatMetadata(runtime) {
    for (const target of [
      runtime.hostSillyTavern,
      runtime.sillyTavern,
      runtime.runtimeWindow?.SillyTavern_API_ACU,
    ]) {
      try {
        const direct = readRecordContainer(target?.chatMetadata);
        if (direct) return direct;
      } catch { /* continue */ }
      try {
        const context = target?.getContext?.();
        const fromContext = readRecordContainer(context?.chatMetadata);
        if (fromContext) return fromContext;
      } catch { /* continue */ }
    }
    return {};
  }

  function readIsolationSlot(owner, field, branch, isolationKey) {
    if (!isRecord(owner)) return undefined;
    const container = readRecordContainer(owner[field]);
    const slots = container?.[branch];
    if (!isRecord(slots) || !Object.prototype.hasOwnProperty.call(slots, isolationKey)) return undefined;
    return cloneIfJson(slots[isolationKey]);
  }

  function writeIsolationSlot(owner, field, branch, isolationKey, value) {
    if (!isRecord(owner) || value === undefined) return false;
    const container = readRecordContainer(owner[field]) || {};
    const slots = isRecord(container[branch]) ? cloneIfJson(container[branch]) : {};
    slots[isolationKey] = cloneIfJson(value);
    container[branch] = slots;
    owner[field] = container;
    return true;
  }

  function normalizeTemplateScopeSlot(value, targetIsolationKey) {
    if (!isRecord(value)) return value;
    return { ...value, isolationKey: targetIsolationKey };
  }

  function extractSheetGuideData(value, depth = 0) {
    if (depth > 4 || value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const parsed = readRecordContainer(value);
      return parsed ? extractSheetGuideData(parsed, depth + 1) : null;
    }
    if (!isRecord(value)) return null;
    for (const nested of [value.data, value.guideData, value.templateObj]) {
      const nestedResult = extractSheetGuideData(nested, depth + 1);
      if (nestedResult) return nestedResult;
    }
    const guide = {};
    for (const [key, sheet] of Object.entries(value)) {
      if (!key.startsWith('sheet_') || !isRecord(sheet)) continue;
      guide[key] = cloneIfJson(sheet);
    }
    return Object.keys(guide).length ? guide : null;
  }

  function mergeMissingGuideSheets(baseTables, guideData) {
    const tables = isRecord(baseTables) ? cloneJson(baseTables, 'shujuku runtime table base') : {};
    const guide = extractSheetGuideData(guideData) || {};
    let changed = false;
    let mergedSheetCount = 0;
    for (const [sheetKey, guideSheet] of Object.entries(guide)) {
      if (!isRecord(guideSheet)) continue;
      const current = tables[sheetKey];
      if (!isRecord(current)) {
        tables[sheetKey] = cloneJson(guideSheet, `shujuku guide sheet ${sheetKey}`);
        changed = true;
        mergedSheetCount += 1;
        continue;
      }
      // Preserve live rows. Only restore structure that is absent so a stale
      // guide cannot overwrite a valid V2 replay or an earlier user edit.
      let sheetChanged = false;
      for (const key of ['uid', 'name', 'revision', 'seedRows', 'content']) {
        const missingStructure = current[key] === undefined
          || key === 'name' && !String(current[key] ?? '').trim()
          || key === 'content' && (!Array.isArray(current[key]) || current[key].length === 0);
        if (!missingStructure || guideSheet[key] === undefined) continue;
        current[key] = cloneJson(guideSheet[key], `shujuku guide field ${sheetKey}.${key}`);
        changed = true;
        sheetChanged = true;
      }
      if (sheetChanged) mergedSheetCount += 1;
    }
    return { tables, changed, guideSheetCount: Object.keys(guide).length, mergedSheetCount };
  }

  function buildIsolationScopeOverlay(runtime, root, handoff, activeIsolationKey, diagnostics) {
    const sourceIsolationKey = String(handoff.sourceIsolationKey);
    const targetIsolationKey = String(handoff.targetIsolationKey);
    if (targetIsolationKey !== String(activeIsolationKey || '')) {
      throw new BridgeError(
        'SHUJUKU_ISOLATION_HANDOFF_STALE',
        `虚拟回合目标 isolationKey(${targetIsolationKey}) 与 shujuku 当前 key(${activeIsolationKey || '空'}) 不一致。`,
      );
    }
    diagnostics.sourceIsolationKey = sourceIsolationKey;
    diagnostics.targetIsolationKey = targetIsolationKey;
    diagnostics.templateScopeRemapped = false;
    diagnostics.sheetGuideRemapped = false;
    diagnostics.virtualMetadataWrites = 0;
    const chatMetadata = readRuntimeChatMetadata(runtime);
    const mappings = [
      {
        field: CHAT_SCOPED_CONFIG_FIELD,
        branch: 'template',
        diagnostic: 'templateScopeRemapped',
        normalize: normalizeTemplateScopeSlot,
      },
      {
        field: CHAT_SHEET_GUIDE_FIELD,
        branch: 'tags',
        diagnostic: 'sheetGuideRemapped',
        normalize: value => value,
      },
    ];
    for (const mapping of mappings) {
      const metadataSlot = readIsolationSlot(
        chatMetadata,
        mapping.field,
        mapping.branch,
        sourceIsolationKey,
      );
      const rootSlot = readIsolationSlot(root, mapping.field, mapping.branch, sourceIsolationKey);
      const sourceSlot = metadataSlot !== undefined ? metadataSlot : rootSlot;
      if (sourceSlot === undefined) continue;
      const targetSlot = mapping.normalize(sourceSlot, targetIsolationKey);
      writeIsolationSlot(chatMetadata, mapping.field, mapping.branch, targetIsolationKey, targetSlot);
      writeIsolationSlot(root, mapping.field, mapping.branch, targetIsolationKey, targetSlot);
      diagnostics[mapping.diagnostic] = true;
    }
    const guideSlot = readIsolationSlot(
      chatMetadata,
      CHAT_SHEET_GUIDE_FIELD,
      'tags',
      targetIsolationKey,
    ) ?? readIsolationSlot(root, CHAT_SHEET_GUIDE_FIELD, 'tags', targetIsolationKey);
    const templateSlot = readIsolationSlot(
      chatMetadata,
      CHAT_SCOPED_CONFIG_FIELD,
      'template',
      targetIsolationKey,
    ) ?? readIsolationSlot(root, CHAT_SCOPED_CONFIG_FIELD, 'template', targetIsolationKey);
    const guideData = extractSheetGuideData(guideSlot) || extractSheetGuideData(templateSlot);
    diagnostics.guideSheetCount = guideData ? Object.keys(guideData).length : 0;
    const updateChatMetadata = async patch => {
      if (!isRecord(patch)) return;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete chatMetadata[key];
        else chatMetadata[key] = cloneIfJson(value) ?? value;
      }
      diagnostics.virtualMetadataWrites += 1;
    };
    diagnostics.hostChatMetadataIsolated = true;
    return { chatMetadata, updateChatMetadata, guideData };
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
        if (
          key === 'message_id'
          || key === '_islandmilfcode_logical_id'
          || key === '_islandmilfcode_exchange_id'
          || key === '_islandmilfcode_floor_index'
        ) continue;
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
      _islandmilfcode_logical_id: message.logicalId ?? `${message.role}-${messageId}`,
      _islandmilfcode_exchange_id: message.exchangeId ?? null,
      _islandmilfcode_floor_index: message.floorIndex ?? null,
    }, message.pluginData);
  }

  function buildVirtualChat(input) {
    const rootMessage = input.rootMessage;
    const rootText = rootMessage && typeof rootMessage.text === 'string' && rootMessage.text.trim()
      ? rootMessage.text
      : '';
    const rootPlaceholder = !rootText || rootText === '[开局]';
    const rootLogicalId = rootMessage?.logicalId ?? 'root-assistant';
    const rootExchangeId = rootMessage?.exchangeId ?? null;
    const root = applyPluginData({
      message_id: 0,
      role: 'assistant',
      is_user: false,
      is_system: false,
      name: rootMessage?.name || 'IslandMilfCode',
      mes: rootText,
      message: rootText,
      send_date: 0,
      extra: {},
      data: {},
      _islandmilfcode_root_placeholder: rootPlaceholder,
      _islandmilfcode_logical_id: rootLogicalId,
      _islandmilfcode_exchange_id: rootExchangeId,
      _islandmilfcode_floor_index: null,
    }, rootMessage?.pluginData);
    const chat = [root];
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
        const runtimeHostWindow = runtimeWindow?.parent || hostWindow;
        const hostSillyTavern = runtimeHostWindow?.SillyTavern;
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
          hostWindow: runtimeHostWindow,
          tavernHelper,
          sillyTavern,
          hostSillyTavern,
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
      fullTimelinePromptSplit: true,
      stableAssistantTarget: true,
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

  async function restoreRuntimeTables(api, tables) {
    const method = typeof api?.restoreTableAsJson === 'function'
      ? 'restoreTableAsJson'
      : typeof api?.importTableAsJson === 'function' ? 'importTableAsJson' : null;
    if (!method) throw new BridgeError('SHUJUKU_RESTORE_UNAVAILABLE', 'shujuku 缺少失败回滚接口。');
    const value = await api[method].call(api, JSON.stringify(tables), { persist: false, mode: 'restore' });
    if (value === false) throw new BridgeError('SHUJUKU_RESTORE_REJECTED', `AutoCardUpdaterAPI.${method} 返回 false`);
  }

  function parseVirtualInput(inputJson) {
    if (typeof inputJson !== 'string' || !inputJson.trim()) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.inputJson 必须是非空字符串');
    }
    if (inputJson.length > MAX_VIRTUAL_INPUT_LENGTH) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.inputJson 过大');
    }
    let input;
    try { input = JSON.parse(inputJson); } catch (error) {
      throw new BridgeError('INVALID_REQUEST', `generateVirtual.inputJson 无效：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(input)) throw new BridgeError('INVALID_REQUEST', 'generateVirtual.inputJson 顶层必须是对象');
    assertKeys(
      input,
      'generateVirtual input',
      ['messages', 'promptMessages', 'assistantTarget', 'userInput', 'generationId'],
      ['rootMessage', 'systemPrompt', 'mode', 'isolationKeyHandoff'],
    );
    if (!Array.isArray(input.messages) || input.messages.length > MAX_VIRTUAL_MESSAGES) {
      throw new BridgeError('INVALID_REQUEST', `generateVirtual.messages 必须是不超过 ${MAX_VIRTUAL_MESSAGES} 条的数组`);
    }
    for (const [index, message] of input.messages.entries()) {
      assertKeys(
        message,
        `generateVirtual.messages[${index}]`,
        ['role', 'text', 'logicalId', 'exchangeId', 'floorIndex'],
        ['name', 'rawText', 'pluginData', 'current'],
      );
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
      assertToken(message.logicalId, `generateVirtual.messages[${index}].logicalId`);
      assertToken(message.exchangeId, `generateVirtual.messages[${index}].exchangeId`);
      if (!Number.isInteger(message.floorIndex) || message.floorIndex < 0) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.messages[${index}].floorIndex 无效`);
      }
    }
    if (!Array.isArray(input.promptMessages) || input.promptMessages.length > MAX_PROMPT_MESSAGES) {
      throw new BridgeError('INVALID_REQUEST', `generateVirtual.promptMessages 必须是不超过 ${MAX_PROMPT_MESSAGES} 条的数组`);
    }
    for (const [index, message] of input.promptMessages.entries()) {
      assertKeys(
        message,
        `generateVirtual.promptMessages[${index}]`,
        ['role', 'text', 'logicalId', 'exchangeId', 'floorIndex'],
        ['name', 'rawText', 'pluginData'],
      );
      if (message.role !== 'user' && message.role !== 'assistant') {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.promptMessages[${index}].role 无效`);
      }
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 200_000) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.promptMessages[${index}].text 无效`);
      }
      if (message.rawText !== undefined && (typeof message.rawText !== 'string' || message.rawText.length > 200_000)) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.promptMessages[${index}].rawText 无效`);
      }
      if (message.name !== undefined && (typeof message.name !== 'string' || message.name.length > 512)) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.promptMessages[${index}].name 无效`);
      }
      if (message.pluginData !== undefined) {
        cloneJson(message.pluginData, `generateVirtual.promptMessages[${index}].pluginData`);
      }
      assertToken(message.logicalId, `generateVirtual.promptMessages[${index}].logicalId`);
      assertToken(message.exchangeId, `generateVirtual.promptMessages[${index}].exchangeId`);
      if (!Number.isInteger(message.floorIndex) || message.floorIndex < 0) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.promptMessages[${index}].floorIndex 无效`);
      }
    }
    if (input.rootMessage !== undefined) {
      if (input.rootMessage !== null) {
        assertKeys(
          input.rootMessage,
          'generateVirtual.rootMessage',
          ['role', 'text', 'logicalId', 'exchangeId', 'floorIndex'],
          ['name', 'rawText', 'pluginData'],
        );
        if (input.rootMessage.role !== 'assistant') {
          throw new BridgeError('INVALID_REQUEST', 'generateVirtual.rootMessage.role 必须是 assistant');
        }
        if (typeof input.rootMessage.text !== 'string' || input.rootMessage.text.length > 200_000) {
          throw new BridgeError('INVALID_REQUEST', 'generateVirtual.rootMessage.text 无效');
        }
        assertToken(input.rootMessage.logicalId, 'generateVirtual.rootMessage.logicalId');
        if (input.rootMessage.exchangeId !== null || input.rootMessage.floorIndex !== null) {
          throw new BridgeError('INVALID_REQUEST', 'generateVirtual.rootMessage 必须使用 null exchangeId/floorIndex');
        }
      }
    }
    assertKeys(input.assistantTarget, 'generateVirtual.assistantTarget', ['logicalId', 'exchangeId', 'floorIndex'], ['name']);
    assertToken(input.assistantTarget.logicalId, 'generateVirtual.assistantTarget.logicalId');
    assertToken(input.assistantTarget.exchangeId, 'generateVirtual.assistantTarget.exchangeId');
    if (!Number.isInteger(input.assistantTarget.floorIndex) || input.assistantTarget.floorIndex < 0) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.assistantTarget.floorIndex 无效');
    }
    if (input.assistantTarget.name !== undefined && (typeof input.assistantTarget.name !== 'string' || input.assistantTarget.name.length > 512)) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.assistantTarget.name 无效');
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
    assertKeys(
      input.isolationKeyHandoff,
      'generateVirtual.isolationKeyHandoff',
      ['sourceIsolationKey', 'targetIsolationKey'],
    );
    assertToken(input.isolationKeyHandoff.sourceIsolationKey, 'generateVirtual.isolationKeyHandoff.sourceIsolationKey');
    assertToken(input.isolationKeyHandoff.targetIsolationKey, 'generateVirtual.isolationKeyHandoff.targetIsolationKey');
    const logicalIds = new Set();
    if (input.rootMessage) logicalIds.add(input.rootMessage.logicalId);
    for (const message of input.messages) {
      if (logicalIds.has(message.logicalId)) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual 含有重复 logicalId ${message.logicalId}`);
      }
      logicalIds.add(message.logicalId);
    }
    if (logicalIds.has(input.assistantTarget.logicalId)) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.assistantTarget.logicalId 已存在于历史时间线');
    }
    const currentUsers = input.messages.filter(message => message.role === 'user' && message.current === true);
    if (currentUsers.length !== 1 || input.messages.at(-1) !== currentUsers[0]) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual 必须把唯一当前 user 放在完整时间线末尾');
    }
    if (
      currentUsers[0].exchangeId !== input.assistantTarget.exchangeId
      || currentUsers[0].floorIndex !== input.assistantTarget.floorIndex
    ) {
      throw new BridgeError('INVALID_REQUEST', 'generateVirtual.assistantTarget 与当前 user 的 exchange/floor 不一致');
    }
    const fullById = new Map(input.messages.map(message => [message.logicalId, message]));
    const promptIds = new Set();
    for (const message of input.promptMessages) {
      if (promptIds.has(message.logicalId)) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.promptMessages 含有重复 logicalId ${message.logicalId}`);
      }
      promptIds.add(message.logicalId);
      const full = fullById.get(message.logicalId);
      if (
        !full
        || full.role !== message.role
        || full.text !== message.text
        || full.rawText !== message.rawText
        || full.exchangeId !== message.exchangeId
        || full.floorIndex !== message.floorIndex
      ) {
        throw new BridgeError('INVALID_REQUEST', `generateVirtual.promptMessages[${message.logicalId}] 不属于完整时间线`);
      }
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

  async function runVirtualGeneration(input, publishProgress) {
    const runtime = findShujukuRuntime();
    if (!runtime) throw new BridgeError('SHUJUKU_RUNTIME_UNAVAILABLE', '未找到带包装 generate 的 shujuku 运行时');
    const chat = buildVirtualChat(input);
    const initialVirtualUser = findLastUser(chat, input);
    const planningContext = takePlanningContext(initialVirtualUser);
    if (!planningContext.requested || !planningContext.content || !planningContext.userIdentity) {
      throw new BridgeError(
        'SHUJUKU_PLANNING_CONTEXT_INVALID',
        `Island 规划身份附录无效：${planningContext.reason ?? 'missing-user-identity'}`,
      );
    }
    const generationId = String(input.generationId);
    if (activeGenerationControllers.has(generationId)) {
      throw new BridgeError('SHUJUKU_GENERATION_DUPLICATE', `shujuku 虚拟回合已存在：${generationId}`);
    }
    const controller = { cancelled: cancelledGenerationIds.has(generationId) };
    if (controller.cancelled || cancelledGenerationIds.has(generationId)) {
      cancelledGenerationIds.delete(generationId);
      throw new BridgeError('SHUJUKU_GENERATION_CANCELLED', `shujuku 虚拟回合已取消：${generationId}`);
    }
    activeGenerationControllers.set(generationId, controller);
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
      planningProgressSent: false,
      planningProgressBeforeGenerationReturn: false,
      planningCommittedFromBodyOptions: false,
      planningContextRequested: planningContext.requested,
      planningContextInjected: false,
      planningContextVisibleReads: 0,
      qrfObservedAt: null,
      planningPublishedAt: null,
      projectionAcknowledgedAt: null,
      bodyGenerationStartedAt: null,
      hostSaveRequestedAt: null,
      bodyContextBoundaryInstalled: false,
      bodyContextBoundaryObserved: false,
      bodyContextVisibleReads: 0,
      bodyContextInjected: false,
      bodyPromptOverrideInjected: false,
      // This records that the documented override was passed to Tavern's
      // body API. It does not claim that the final prompt builder consumed it;
      // that requires a real prompt-capture run.
      bodyPromptOverridePassed: false,
      bodyPromptOverrideLength: 0,
      bodyContextRestoredAfterBody: false,
      bodyContextLength: 0,
      triggerBodyContextVisibleReads: 0,
      triggerBodyContextInjected: false,
      triggerBodyContextRestored: false,
      bodyContextRestoredAfterTrigger: false,
      tableFillCaptureInstalled: false,
      tableFillCaptureProviders: [],
      tableFillCaptureRestored: false,
      staleStorageFrameObserved: false,
      bridgeStorageFrameMaterialized: false,
      planningProjectionAcknowledged: false,
      planningContextRestoredBeforeBody: false,
      planningContextRestoredBeforeTrigger: false,
      planningContextSkipReason: planningContext.reason,
      rootPlaceholderExcluded: Boolean(chat[0]?._islandmilfcode_root_placeholder),
      excludedRootPlaceholder: Boolean(chat[0]?._islandmilfcode_root_placeholder),
      bodyMessageIndex: null,
      bodyMessageText: '',
      bodyText: '',
      userIdentityOverlayInstalled: false,
      userIdentityOverlayReads: 0,
      virtualChatOverlayInstalled: false,
      virtualChatOverlayTargets: 0,
      virtualContextOverlayReads: 0,
      guideSheetCount: 0,
      runtimeTablesBeforeHydrationCount: null,
      runtimeTablesAfterHydrationCount: null,
      runtimeTablesHydrated: false,
      runtimeHydrationMergedSheetCount: 0,
      adapterRestored: false,
      generationCancelled: false,
    };
    const isolationScopeOverlay = buildIsolationScopeOverlay(
      runtime,
      chat[0],
      input.isolationKeyHandoff,
      isolationKey,
      diagnostics,
    );
    const getMessages = (range, options) => selectVirtualMessages(chat, range, options);
    const setMessages = async updates => {
      diagnostics.virtualWrites += Array.isArray(updates) ? updates.length : 0;
      applyVirtualUpdates(chat, updates);
    };
    let assistantTargetClaimed = false;
    const createMessages = async inputs => {
      for (const inputMessage of Array.isArray(inputs) ? inputs : []) {
        const isUser = inputMessage?.role === 'user';
        const text = String(inputMessage?.message ?? inputMessage?.mes ?? '');
        const useAssistantTarget = !isUser && !assistantTargetClaimed;
        if (useAssistantTarget) assistantTargetClaimed = true;
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
          _islandmilfcode_logical_id: useAssistantTarget
            ? input.assistantTarget.logicalId
            : inputMessage?._islandmilfcode_logical_id ?? `virtual-${generationId}-${chat.length}`,
          _islandmilfcode_exchange_id: useAssistantTarget
            ? input.assistantTarget.exchangeId
            : inputMessage?._islandmilfcode_exchange_id ?? null,
          _islandmilfcode_floor_index: useAssistantTarget
            ? input.assistantTarget.floorIndex
            : inputMessage?._islandmilfcode_floor_index ?? null,
        });
        diagnostics.virtualCreates += 1;
      }
      normalizeVirtualIds(chat);
    };
    const deleteLastMessage = async () => deleteMessages([chat.length - 1]);
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
    let virtualUser;
    let virtualAssistant;
    let rawText = '';
    let triggerResult;
    let triggerError;
    let result;
    let beforeTables;
    let rollbackTables;
    let tableMutationAttempted = false;
    let generationOptions;
    let planningProgressSent = false;
    let planningOverlay;
    let bodyContextForTrigger = '';
    let userIdentityOverlay;
    let planningPublicationPromise;
    const publishPlanningReady = async () => {
      if (planningProgressSent) return true;
      if (typeof publishProgress !== 'function') return false;
      if (planningPublicationPromise) return planningPublicationPromise;
      planningPublicationPromise = (async () => {
        assertGenerationActive(generationId, controller);
        virtualUser = findLastUser(chat, input) || virtualUser;
        const qrf = readQrf(virtualUser);
        if (!hasPlanningResult(qrf)) return false;
        const plannedText = generationOptions
          ? readPlannedTextFromOptions(generationOptions, input.userInput) || readPlannedText(virtualUser, input.userInput)
          : readPlannedText(virtualUser, input.userInput);
        if (!plannedText) return false;
        diagnostics.qrfObservedAt = diagnostics.qrfObservedAt || Date.now();
        const userPluginData = extractPluginData(virtualUser);
        diagnostics.planningPublishedAt = Date.now();
        const acknowledgement = await publishProgress('planning', {
          plannedText,
          ...(userPluginData ? { userPluginData } : {}),
          planningObserved: true,
        });
        if (planningOverlay) {
          bodyContextForTrigger = planningOverlay.acknowledgePlanningProjection(acknowledgement) || '';
        }
        diagnostics.projectionAcknowledgedAt = Date.now();
        planningProgressSent = true;
        diagnostics.planningProgressSent = true;
        diagnostics.planningProgressBeforeGenerationReturn = !rawText;
        return true;
      })();
      try {
        return await planningPublicationPromise;
      } finally {
        planningPublicationPromise = null;
      }
    };
    const ensurePlanningProjection = async bodyOptions => {
      planningOverlay?.beginPlanningProjection();
      assertGenerationActive(generationId, controller);
      const boundaryOptions = isObjectLike(bodyOptions) ? bodyOptions : generationOptions;
      const plannedText = readPlannedTextFromOptions(boundaryOptions, input.userInput);
      virtualUser = findLastUser(chat, input) || virtualUser;
      if (!hasPlanningResult(readQrf(virtualUser)) && isPlanningText(plannedText)) {
        diagnostics.planningCommittedFromBodyOptions = commitPlanningText(
          virtualUser,
          plannedText,
          generationId,
        );
      }
      for (let attempt = 0; attempt < QRF_POLL_ATTEMPTS; attempt += 1) {
        if (await publishPlanningReady()) return true;
        if (attempt + 1 < QRF_POLL_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, QRF_POLL_INTERVAL_MS));
        }
      }
      const error = new BridgeError(
        'SHUJUKU_PLANNING_NOT_OBSERVED',
        'shujuku 当前虚拟 user 没有已提交的 qrf 规划。',
      );
      planningOverlay?.rejectPlanningProjection(error);
      throw error;
    };
    const saveChat = async () => {
      if (diagnostics.triggerCalled) {
        diagnostics.databaseSaveCalls += 1;
        return;
      }
      diagnostics.planningSaveCalls += 1;
      diagnostics.hostSaveRequestedAt = diagnostics.hostSaveRequestedAt || Date.now();
      planningOverlay?.beginPlanningProjection();
      try {
        await publishPlanningReady();
      } catch (error) {
        planningOverlay?.rejectPlanningProjection(error);
        throw error;
      }
    };
    try {
      if (!installVirtualChatOverlay(
        runtime,
        chat,
        {
          saveChat,
          setMessages,
          createMessages,
          deleteMessages,
          deleteLastMessage,
          getMessages,
          getLastMessageId: () => chat.length - 1,
          chatMetadata: isolationScopeOverlay?.chatMetadata,
          updateChatMetadata: isolationScopeOverlay?.updateChatMetadata,
        },
        restores,
        diagnostics,
      )) {
        throw new BridgeError('SHUJUKU_VIRTUAL_CHAT_OVERLAY_FAILED', '无法把 shujuku 的宿主/iframe chat 入口统一到虚拟时间线。');
      }
      patchRuntimeProperty(runtime.tavernHelper, 'getChatMessages', getMessages, restores, 'TavernHelper.getChatMessages');
      patchRuntimeProperty(runtime.tavernHelper, 'getLastMessageId', () => chat.length - 1, restores, 'TavernHelper.getLastMessageId');
      patchRuntimeProperty(runtime.tavernHelper, 'setChatMessages', setMessages, restores, 'TavernHelper.setChatMessages');
      patchRuntimeProperty(runtime.tavernHelper, 'createChatMessages', createMessages, restores, 'TavernHelper.createChatMessages');
      patchRuntimeProperty(runtime.tavernHelper, 'deleteChatMessages', deleteMessages, restores, 'TavernHelper.deleteChatMessages');

      virtualUser = findLastUser(chat, input);
      if (!virtualUser) throw new BridgeError('INVALID_REQUEST', '虚拟时间线缺少当前 user');
      clearPlanningEvidence(virtualUser);
      userIdentityOverlay = installUserIdentityOverlay(
        runtime,
        planningContext.userIdentity,
        restores,
        diagnostics,
      );
      if (!userIdentityOverlay) {
        throw new BridgeError('SHUJUKU_USER_IDENTITY_UNAVAILABLE', '无法把当前 Island User 身份覆盖到 shujuku runtime。');
      }
      planningOverlay = await installBodyContextBoundary(
        runtime,
        restores,
        diagnostics,
        ensurePlanningProjection,
        planningContext.userIdentity,
      );
      if (!planningOverlay) {
        throw new BridgeError(
          'SHUJUKU_BODY_CONTEXT_UNAVAILABLE',
          `Island 正文主 API 上下文边界无法安装：${diagnostics.planningContextSkipReason ?? 'unknown'}`,
        );
      }
      // `$U` carries the current Island player during planning.  Character
      // card/plot authority is intentionally absent until qrf `present` has
      // been committed and acknowledged at the body boundary.
      diagnostics.planningContextRestoredBeforeBody = true;
      const historyPrompts = [];
      if (String(input.systemPrompt || '').trim()) {
        historyPrompts.push({ role: 'system', content: String(input.systemPrompt).trim() });
      }
      for (const message of input.promptMessages) {
        const content = String(message.rawText || message.text || '');
        if (!content) continue;
        historyPrompts.push({ role: message.role, content });
      }
      const options = {
        user_input: String(input.userInput),
        should_stream: false,
        should_silence: true,
        generation_id: String(input.generationId),
        max_chat_history: 0,
        overrides: { chat_history: { prompts: historyPrompts, with_depth_entries: true } },
      };
      generationOptions = options;
      const assistantStartIndex = chat.length;
      assertGenerationActive(generationId, controller);
      rawText = normalizeGeneratedResult(await runtime.tavernHelper.generate.call(runtime.tavernHelper, options));
      if (planningOverlay && !diagnostics.bodyContextBoundaryObserved) {
        planningOverlay.restore();
        diagnostics.planningContextSkipReason = 'body-boundary-not-observed';
        throw new BridgeError(
          'SHUJUKU_PLANNING_CONTEXT_BOUNDARY_MISSED',
          'shujuku 正文生成边界未经过已验证入口；本轮拒绝复用可能看过规划附录的正文。',
        );
      }
      planningOverlay?.restore();
      diagnostics.planningContextRestoredBeforeTrigger = Boolean(
        diagnostics.planningContextRestoredBeforeBody && diagnostics.bodyContextRestoredAfterBody,
      );
      if (!rawText.trim()) throw new BridgeError('SHUJUKU_GENERATION_EMPTY', 'shujuku 包装 generate 返回空正文');
      assertGenerationActive(generationId, controller);
      virtualUser = findLastUser(chat, input) || virtualUser;
      const plannedTextFromOptions = readPlannedTextFromOptions(options, input.userInput);
      let qrf;
      let plannedText;
      let userPluginData;
      // Planning writers may finish after generate returns. Wait only on this
      // turn's virtual user before assistant append and database triggering.
      for (let attempt = 0; attempt < QRF_POLL_ATTEMPTS; attempt += 1) {
        assertGenerationActive(generationId, controller);
        virtualUser = findLastUser(chat, input) || virtualUser;
        userPluginData = extractPluginData(virtualUser);
        qrf = readQrf(virtualUser);
        plannedText = plannedTextFromOptions || readPlannedText(virtualUser, input.userInput);
        if (hasPlanningResult(qrf)) break;
        if (attempt + 1 < QRF_POLL_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, QRF_POLL_INTERVAL_MS));
        }
      }
      await publishPlanningReady();
      // Reacquire after the publication/save boundary. The upstream writer
      // may replace the virtual user or clear its pending marker during the
      // awaited commit, so the pre-publication reference is not evidence.
      virtualUser = findLastUser(chat, input) || virtualUser;
      userPluginData = extractPluginData(virtualUser);
      qrf = readQrf(virtualUser);
      plannedText = plannedTextFromOptions || readPlannedText(virtualUser, input.userInput);
      if (!hasPlanningResult(qrf)) {
        throw new BridgeError('SHUJUKU_PLANNING_NOT_OBSERVED', 'shujuku 当前虚拟 user 没有已提交的 qrf 规划。');
      }
      assertGenerationActive(generationId, controller);
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
      diagnostics.bodyMessageIndex = Number.isInteger(virtualAssistantMessageId)
        ? virtualAssistantMessageId
        : null;
      diagnostics.bodyMessageText = String(virtualAssistant?.mes ?? virtualAssistant?.message ?? '').trim();
      diagnostics.bodyText = diagnostics.bodyMessageText;
      if (!diagnostics.bodyMessageText || /^(?:\[开局\]|开局)$/.test(diagnostics.bodyMessageText)) {
        throw new BridgeError('SHUJUKU_BODY_MESSAGE_INVALID', 'shujuku 没有可供填表的真实 assistant 正文。');
      }
      const beforeStorageFrame = findStorageFrame(virtualAssistant, isolationKey);
      const runtimeTablesBeforeHydration = typeof runtime.api.exportTableAsJson === 'function'
        ? cloneJson(await runtime.api.exportTableAsJson.call(runtime.api), 'shujuku 触发前表快照')
        : undefined;
      rollbackTables = runtimeTablesBeforeHydration;
      const hydration = mergeMissingGuideSheets(
        runtimeTablesBeforeHydration,
        isolationScopeOverlay?.guideData,
      );
      beforeTables = hydration.tables;
      diagnostics.runtimeTablesBeforeHydrationCount = runtimeTablesBeforeHydration && isRecord(runtimeTablesBeforeHydration)
        ? Object.keys(runtimeTablesBeforeHydration).filter(key => key.startsWith('sheet_')).length
        : 0;
      diagnostics.runtimeTablesAfterHydrationCount = Object.keys(beforeTables).filter(key => key.startsWith('sheet_')).length;
      diagnostics.runtimeHydrationMergedSheetCount = hydration.mergedSheetCount;
      if (hydration.changed) {
        tableMutationAttempted = true;
        await restoreRuntimeTables(runtime.api, beforeTables);
        diagnostics.runtimeTablesHydrated = true;
      }
      diagnostics.databaseSaveBaseline = diagnostics.databaseSaveCalls;
      diagnostics.triggerCalled = true;
      const beforeTriggerChatFingerprint = fingerprint(chat, 'virtual chat before table trigger');
      const beforeTriggerMutationCounts = {
        writes: diagnostics.virtualWrites,
        creates: diagnostics.virtualCreates,
        deletes: diagnostics.virtualDeletes,
      };
      const tableFillCapture = { responses: [] };
      try {
        triggerResult = await withTriggerBodyContext(
          runtime,
          bodyContextForTrigger,
          diagnostics,
          async () => {
            tableMutationAttempted = true;
            assertGenerationActive(generationId, controller);
            const captureRestores = [];
            let operationResult;
            let operationError;
            let captureRestoreError;
            try {
              installTableFillResponseCapture(runtime, tableFillCapture, captureRestores, diagnostics);
              operationResult = await runtime.api.triggerUpdate.call(runtime.api);
            } catch (error) {
              operationError = error;
            } finally {
              for (const restore of captureRestores.reverse()) {
                try { restore(); } catch (error) { captureRestoreError ??= error; }
              }
              diagnostics.tableFillCaptureRestored = !captureRestoreError;
            }
            if (captureRestoreError) {
              throw new BridgeError(
                'SHUJUKU_TABLE_CAPTURE_RESTORE_FAILED',
                `填表响应捕获恢复失败：${captureRestoreError instanceof Error ? captureRestoreError.message : String(captureRestoreError)}`,
              );
            }
            if (operationError) throw operationError;
            return operationResult;
          },
        );
      } catch (error) {
        triggerError = error;
      }
      const triggerSucceeded = Boolean(
        !triggerError
        && triggerResult !== false
        && !(isRecord(triggerResult)
          && (triggerResult.success === false
            || triggerResult.ok === false
            || triggerResult.error !== undefined && triggerResult.error !== null)),
      );
      const explicitTableFillNoOp = isExplicitTableFillNoOp(tableFillCapture);
      const expectedEmptyOperationLogFailure = isExpectedEmptyOperationLogFailure(triggerResult, triggerError);
      const noOpCandidate = !triggerSucceeded
        && expectedEmptyOperationLogFailure
        && explicitTableFillNoOp;

      if (triggerError && !noOpCandidate) throw triggerError;
      let assistantPluginData;
      let afterStorageFrame;
      let storageFrameSource = null;
      let storageFrameCandidateIndex = null;
      // Database writers can finish after triggerUpdate returns; keep every
      // evidence read bound to this turn's virtual user/assistant pair. The
      // longer window is intentional: V2 may await a host-save boundary after
      // triggerUpdate has already returned its success value.
      const databasePollAttempts = triggerSucceeded ? DATABASE_POLL_ATTEMPTS : 1;
      for (let attempt = 0; attempt < databasePollAttempts; attempt += 1) {
        assertGenerationActive(generationId, controller);
        const currentTurn = refreshCurrentTurn(chat, input, virtualAssistantMessageId, assistantStartIndex);
        virtualUser = currentTurn.user || virtualUser;
        virtualAssistant = currentTurn.assistant || virtualAssistant;
        assistantPluginData = extractPluginData(virtualAssistant);
        userPluginData = extractPluginData(virtualUser);
        qrf = readQrf(virtualUser);
        plannedText = plannedTextFromOptions || readPlannedText(virtualUser, input.userInput);
        const frameEvidence = findStorageFrameForTurn(
          chat,
          virtualAssistantMessageId,
          isolationKey,
          assistantStartIndex,
          diagnostics.bodyMessageText,
        );
        if (frameEvidence) {
          const frameChanged = !beforeStorageFrame
            || fingerprint(beforeStorageFrame.storageFrame, 'storage frame before poll')
              !== fingerprint(frameEvidence.storageFrame, 'storage frame poll');
          if (frameChanged) {
            afterStorageFrame = frameEvidence;
            storageFrameSource = 'native';
            storageFrameCandidateIndex = frameEvidence.messageIndex;
            if (frameEvidence.message && frameEvidence.message !== virtualAssistant) {
              virtualAssistant = frameEvidence.message;
            }
            break;
          }
          // A frame that was already present before triggerUpdate is not a
          // commit for this turn. Keep polling so an async native save can
          // publish the replacement frame; the bridge-export fallback below
          // handles runtimes that never expose one.
          diagnostics.staleStorageFrameObserved = true;
        }
        if (attempt + 1 < databasePollAttempts) {
          await new Promise(resolve => setTimeout(resolve, DATABASE_POLL_INTERVAL_MS));
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
      const finalFrameEvidence = findStorageFrameForTurn(
        chat,
        virtualAssistantMessageId,
        isolationKey,
        assistantStartIndex,
        diagnostics.bodyMessageText,
      );
      if (finalFrameEvidence) {
        const frameChanged = !beforeStorageFrame
          || fingerprint(beforeStorageFrame.storageFrame, 'storage frame before final read')
            !== fingerprint(finalFrameEvidence.storageFrame, 'storage frame final read');
        if (frameChanged) {
          afterStorageFrame = finalFrameEvidence;
          storageFrameSource = 'native';
          storageFrameCandidateIndex = finalFrameEvidence.messageIndex;
          if (finalFrameEvidence.message && finalFrameEvidence.message !== virtualAssistant) {
            virtualAssistant = finalFrameEvidence.message;
          }
        } else {
          diagnostics.staleStorageFrameObserved = true;
        }
      }
      const tableChanged = beforeTables && tables
        ? fingerprint(beforeTables, 'table before') !== fingerprint(tables, 'table after')
        : false;
      const databaseSaveObserved = diagnostics.databaseSaveCalls > diagnostics.databaseSaveBaseline;

      // In plugin mode shujuku can retain a pre-trigger frame or call a
      // saveChat reference that the overlay cannot observe. An awaited,
      // successful trigger plus a changed post-trigger export is still the
      // authoritative V2 runtime commit. Bind that export to this assistant
      // as a bridge-owned checkpoint instead of restoring the old tables.
      if (!afterStorageFrame
        && triggerSucceeded
        && tableChanged
        && tables
        && isRecord(tables)) {
        const bridgeFrame = buildBridgeStorageFrame(tables, beforeTables, generationId, isolationKey);
        if (attachStorageFrameToAssistant(virtualAssistant, isolationKey, bridgeFrame)) {
          afterStorageFrame = findStorageFrameForTurn(
            chat,
            virtualAssistantMessageId,
            isolationKey,
            assistantStartIndex,
            diagnostics.bodyMessageText,
          ) || {
            storageFrame: bridgeFrame,
            location: `TavernDB_ACU_IsolatedData.${isolationKey ?? ''}.storageFrame`,
            message: virtualAssistant,
            messageIndex: Number(virtualAssistant?.message_id),
          };
          storageFrameSource = 'bridge-export';
          storageFrameCandidateIndex = afterStorageFrame.messageIndex ?? null;
          diagnostics.bridgeStorageFrameMaterialized = true;
        }
      }

      // If shujuku replaced the message object during its async save, copy the
      // frame from the same-turn candidate onto the currently paired assistant
      // so the logical handoff has one stable storage owner.
      if (afterStorageFrame?.message && afterStorageFrame.message !== virtualAssistant) {
        attachStorageFrameToAssistant(virtualAssistant, isolationKey, afterStorageFrame.storageFrame);
        afterStorageFrame = findStorageFrame(virtualAssistant, isolationKey) || afterStorageFrame;
      }
      assistantPluginData = extractPluginData(virtualAssistant);
      const storageFrameChanged = Boolean(
        afterStorageFrame
        && (!beforeStorageFrame
          || fingerprint(beforeStorageFrame.storageFrame, 'storage frame before')
            !== fingerprint(afterStorageFrame.storageFrame, 'storage frame after')),
      );
      const durableDatabaseCommit = Boolean(
        triggerSucceeded
        && diagnostics.triggerBodyContextVisibleReads > 0
        && assistantPluginData
        && afterStorageFrame
        && storageFrameChanged
        && tables && isRecord(tables),
      );
      const triggerChatUnchanged = beforeTriggerChatFingerprint
        === fingerprint(chat, 'virtual chat after table trigger');
      const triggerMutationCountsUnchanged = diagnostics.virtualWrites === beforeTriggerMutationCounts.writes
        && diagnostics.virtualCreates === beforeTriggerMutationCounts.creates
        && diagnostics.virtualDeletes === beforeTriggerMutationCounts.deletes;
      const databaseNoOp = Boolean(
        noOpCandidate
        && diagnostics.tableFillCaptureRestored
        && diagnostics.triggerBodyContextVisibleReads > 0
        && beforeTables && tables && isRecord(beforeTables) && isRecord(tables)
        && !tableChanged
        && !databaseSaveObserved
        && !afterStorageFrame
        && !storageFrameChanged
        && triggerChatUnchanged
        && triggerMutationCountsUnchanged,
      );
      const databaseCommitted = durableDatabaseCommit || databaseNoOp;
      // plannedText may only reflect the wrapper rewriting generation options.
      // The current virtual user's qrf fields are the planning commit evidence.
      const planningObserved = hasPlanningResult(qrf);
      if (!planningObserved) {
        throw new BridgeError('SHUJUKU_PLANNING_NOT_OBSERVED', 'shujuku 规划证据在正文后回读时消失。');
      }
      if (!databaseCommitted) {
        throw new BridgeError('SHUJUKU_DATABASE_NOT_COMMITTED', 'shujuku 表更新没有形成当前回合的数据库提交证据。');
      }
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
          triggerError: triggerError instanceof Error ? triggerError.message : null,
          databaseSaveBaseline: diagnostics.databaseSaveBaseline,
          databaseSaveCallsAfterTrigger: diagnostics.databaseSaveCalls,
          virtualChatLength: chat.length,
          completeTimelineInputLength: input.messages.length,
          promptTimelineInputLength: input.promptMessages.length,
          assistantLogicalId: virtualAssistant?._islandmilfcode_logical_id ?? null,
          assistantExchangeId: virtualAssistant?._islandmilfcode_exchange_id ?? null,
          assistantFloorIndex: virtualAssistant?._islandmilfcode_floor_index ?? null,
          databaseStorageObserved: Boolean(assistantPluginData && afterStorageFrame),
          storageFrameLocation: afterStorageFrame?.location ?? null,
          storageFrameSource,
          storageFrameCandidateIndex,
          nativeStorageFrameObserved: storageFrameSource === 'native',
          databasePollAttempts,
          isolationKey,
          storageFrameChanged,
          tableChanged: beforeTables && tables ? tableChanged : null,
          databaseSaveObserved,
          databaseNoOp,
          databaseOutcome: databaseNoOp ? 'verified_noop' : 'committed',
          expectedEmptyOperationLogFailure,
          explicitTableFillNoOp,
          tableFillResponses: cloneJson(tableFillCapture.responses, 'table fill response diagnostics'),
          triggerChatUnchanged,
          triggerMutationCountsUnchanged,
        },
      };
    } catch (error) {
      diagnostics.generationCancelled = controller.cancelled || cancelledGenerationIds.has(generationId);
      const rollbackTarget = rollbackTables ?? beforeTables;
      if (tableMutationAttempted && rollbackTarget && isRecord(rollbackTarget)) {
        diagnostics.tableRollbackAttempted = true;
        try {
          await restoreRuntimeTables(runtime.api, rollbackTarget);
          const restoredTables = typeof runtime.api.exportTableAsJson === 'function'
            ? await runtime.api.exportTableAsJson.call(runtime.api)
            : rollbackTarget;
          diagnostics.tableRollbackSucceeded = fingerprint(rollbackTarget, 'table rollback before')
            === fingerprint(restoredTables, 'table rollback after');
          if (!diagnostics.tableRollbackSucceeded) {
            throw new BridgeError('SHUJUKU_ROLLBACK_MISMATCH', 'shujuku 失败回滚后的表快照不一致。');
          }
        } catch (rollbackError) {
          diagnostics.tableRollbackSucceeded = false;
          throw new BridgeError(
            'SHUJUKU_ROLLBACK_FAILED',
            `shujuku 回合失败且轮前表恢复失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            { cause: error },
          );
        }
      }
      throw error;
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
      if (activeGenerationControllers.get(generationId) === controller) {
        activeGenerationControllers.delete(generationId);
      }
      cancelledGenerationIds.delete(generationId);
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

  function findStorageFrameForTurn(chat, assistantMessageId, isolationKey, minimumIndex, bodyText) {
    if (!Array.isArray(chat)) return null;
    const expectedText = String(bodyText ?? '').trim();
    for (let index = Math.max(0, Number(minimumIndex) || 0); index < chat.length; index += 1) {
      const message = chat[index];
      if (!message || message.is_user) continue;
      const sameId = Number(message.message_id) === Number(assistantMessageId);
      const sameBody = expectedText && String(message.mes ?? message.message ?? '').trim() === expectedText;
      if (!sameId && !sameBody) continue;
      const found = findStorageFrame(message, isolationKey);
      if (found) return { ...found, message, messageIndex: index };
    }
    return null;
  }

  function buildBridgeStorageFrame(tables, beforeTables, generationId, isolationKey) {
    const createdAt = Date.now();
    const afterData = cloneJson(tables, 'bridge storage frame tables');
    const beforeHash = beforeTables && isRecord(beforeTables)
      ? fingerprint(beforeTables, 'bridge storage frame before tables')
      : null;
    return {
      version: BRIDGE_STORAGE_FRAME_VERSION,
      headRevision: `bridge:${String(generationId)}:${createdAt.toString(36)}`,
      checkpoint: {
        kind: 'full',
        reason: 'island_virtual_export_snapshot',
        createdAt,
        data: afterData,
        context: {
          generationId: String(generationId),
          isolationKey: isolationKey ?? null,
          source: 'AutoCardUpdaterAPI.exportTableAsJson',
          ...(beforeHash ? { beforeHash } : {}),
        },
      },
      logEntries: [],
      _island_bridge_snapshot: true,
    };
  }

  function attachStorageFrameToAssistant(message, isolationKey, storageFrame) {
    if (!isObjectLike(message) || !isRecord(storageFrame)) return false;
    let isolated = message.TavernDB_ACU_IsolatedData;
    if (typeof isolated === 'string') {
      try { isolated = JSON.parse(isolated); } catch { isolated = {}; }
    }
    if (!isRecord(isolated)) isolated = {};
    const key = isolationKey ?? '';
    const previous = isRecord(isolated[key]) ? isolated[key] : {};
    isolated[key] = {
      ...previous,
      _acu_storage_version: BRIDGE_STORAGE_FRAME_VERSION,
      storageFrame: cloneJson(storageFrame, 'bridge assistant storage frame'),
    };
    message.TavernDB_ACU_IsolatedData = isolated;
    return true;
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
  const activeGenerationControllers = new Map();
  const cancelledGenerationIds = new Set();

  function trimCache(cache) {
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  function assertGenerationActive(generationId, controller) {
    if (stopped || controller?.cancelled || cancelledGenerationIds.has(generationId)) {
      throw new BridgeError('SHUJUKU_GENERATION_CANCELLED', `shujuku 虚拟回合已取消：${generationId}`);
    }
  }

  function waitForProgressAcknowledgement(requestId, action, phase, generationId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let subscription;
      let cancelSubscription;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription?.stop?.();
        cancelSubscription?.stop?.();
        callback(value);
      };
      const timer = setTimeout(() => {
        finish(reject, new BridgeError('SHUJUKU_PROGRESS_ACK_TIMEOUT', 'Island 规划投影确认超时。'));
      }, PROGRESS_ACK_TIMEOUT_MS);
      const cancelled = () => finish(
        reject,
        new BridgeError('SHUJUKU_GENERATION_CANCELLED', `shujuku 虚拟回合已取消：${generationId}`),
      );
      cancelSubscription = eventOn(CANCEL_EVENT, response => {
        if (!isRecord(response) || response.generationId !== generationId) return;
        if (response.requestId !== undefined && response.requestId !== requestId) return;
        cancelled();
      });
      subscription = eventOn(PROGRESS_ACK_EVENT, response => {
        if (!isRecord(response)
          || response.protocolVersion !== PROTOCOL_VERSION
          || response.requestId !== requestId
          || response.action !== action
          || response.phase !== phase
          || (response.backend !== CLIENT_BACKEND && response.backend !== BACKEND)) return;
        if (cancelledGenerationIds.has(generationId)) {
          finish(reject, new BridgeError('SHUJUKU_GENERATION_CANCELLED', `shujuku 虚拟回合已取消：${generationId}`));
          return;
        }
        if (response.ok !== true) {
          const error = isRecord(response.error) ? response.error.message : '规划投影未确认';
          finish(reject, new BridgeError('SHUJUKU_PLANNING_PROJECTION_FAILED', String(error)));
          return;
        }
        finish(resolve, isRecord(response.result) ? cloneJson(response.result, 'planning progress acknowledgement') : {});
      });
      // Cancellation can arrive before the ACK waiter is installed (for
      // example when the Island side cancels while the operation queue is
      // draining). Fail immediately instead of waiting for the 30s timer.
      if (cancelledGenerationIds.has(generationId)) cancelled();
    });
  }

  async function dispatch(request) {
    if (request.action === 'probe') return probeRuntime();
    if (stopped) throw new BridgeError('BRIDGE_RELOADED', '角色脚本桥已停止');
    if (request.action === 'exportTableAsJson') {
      return { tables: cloneJson(await invokeApi('exportTableAsJson'), 'exportTableAsJson 返回值') };
    }
    if (request.action === 'generateVirtual') {
      const generationId = String(request.payload.input.generationId);
      return runVirtualGeneration(request.payload.input, async (phase, result) => {
        const acknowledgement = waitForProgressAcknowledgement(
          request.requestId,
          request.action,
          phase,
          generationId,
        );
        await emitResponse({
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          backend: BACKEND,
          ok: true,
          progress: true,
          phase,
          result: cloneJson(result, `${request.action} ${phase} progress`),
        }, true);
        return acknowledgement;
      });
    }
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

  async function emitResponse(response, strict = false) {
    try { await eventEmit(RESPONSE_EVENT, response); } catch (error) {
      console.warn('[IslandMilfCode shujuku bridge] response emit failed:', error);
      if (strict) throw error;
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
    const cancelSubscription = eventOn(CANCEL_EVENT, rawCancellation => {
      if (!isRecord(rawCancellation) || typeof rawCancellation.generationId !== 'string') return;
      const generationId = rawCancellation.generationId.trim();
      if (!generationId) return;
      cancelledGenerationIds.add(generationId);
      const controller = activeGenerationControllers.get(generationId);
      if (controller) controller.cancelled = true;
    });
    globalThis[RUNTIME_KEY] = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        subscription?.stop?.();
        cancelSubscription?.stop?.();
        for (const [generationId, controller] of activeGenerationControllers) {
          controller.cancelled = true;
          cancelledGenerationIds.add(generationId);
        }
      },
    };
    console.info(`[IslandMilfCode shujuku bridge] v${BRIDGE_VERSION} table relay started`);
  } catch (error) {
    console.warn('[IslandMilfCode shujuku bridge] 初始化失败:', error);
  }
})();
