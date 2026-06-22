// crypto.randomUUID polyfill: iOS HTTP 环境下不可用，降级到 Math.random
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  // @ts-ignore
  crypto.randomUUID = function (): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };
}

import './styles.css';
import './phone/styles.css';
import './title/styles.css';

import { cancelCurrentGeneration, retryBackgroundProgressUpdate, submitMessage, submitPhoneMessage, type ActionContext } from './actions';
import { clearBackgroundTask } from './background-tasks';
import { setupStreamingHooks } from './actions/streaming';
import { extractContextReply, getReaderMessages, invalidateReaderMessagesCache } from './message-format';
import { bindFloatingPhoneEvents, loadFloatingPhonePosition, syncFloatingPhoneAfterResize } from './phone/floating';
import {
  closePhoneRoute,
  getRouteForTab,
  navigatePhoneBack as navigatePhoneBackRoute,
  navigatePhoneRoute,
  openPhoneRoute,
  resetPhoneRoute as resetPhoneRouteState,
} from './phone/routes';
import {
  CHARACTER_QUICK_SEARCH,
  fetchTrackPicUrl,
  fetchTrackStreamUrl,
  formatPlaybackTime,
  makeCharacterBgmTrack,
  searchMusic,
} from './phone/music';
import { renderApp } from './render';
import { mountRadarChart, unmountRadarChart } from './phone/radar';
import { getCalendarMonthOffset, setCalendarMonthOffset, setCalendarSelectedDate } from './phone/render';
import { updateSummaryTextInMemoryDB } from './memorydatabase/commit-points';
import {
  clearActiveSaveId,
  createManualSave,
  createSave,
  deleteSave,
  exportSaveAsJsonParts,
  getAutosaveBranchSaveId,
  importAllSavesFromJson,
  loadSave,
  normalizePlayerProfile,
  setActiveRunId,
  setActiveSaveId,
  writeAutosave,
} from './state/saves';
import { flushSaveStore, initSaveStore } from './state/save-store';
import {
  clampFocusedMessageIndex,
  createInitialState,
  deleteReaderMessage,
  deserializeMessages,
  normalizeDrawingSettings,
  getReaderMessageByIndex,
  getSourceUserTextForReaderIndex,
  replaceConversationMessages,
  rollbackConversation,
  serializeMessages,
  normalizePhoneMessageStore,
  syncFocusedMessage,
} from './state/store';
import {
  buildFactAnchorFromStatus,
  loadSummaryApiConfig,
  rerollSummaryEntry,
  repairSummaryStore,
  resumeAutoSummary,
  runSummary,
  saveSummaryApiConfig,
} from "./summary";
import type { SummaryApiConfig, SummaryModelOption } from './summary/types';
import { bindCharacterCreationEvents, bindTitleHomeEvents, type TitleCallbacks } from './title/events';
import { renderCharacterCreation, renderTitleHome } from './title/render';
import type { DeepSeekFanLookupState, GameState, NotificationState, StatusData, TabKey, TavernWindow } from './types';
import {
  isPhoneArchiveGoldImpression,
  isPhoneThemeCharacterId,
  PHONE_ARCHIVE_IMPRESSION_GOLD_TAG,
  PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG,
} from './phone/types';
import type { MusicTrack, PhoneCharacterId, PhoneRoute, PhoneThemeCharacterId } from './phone/types';
import { createVariableAdapter, type VariableAdapter } from './variables/adapter';
import { clamp, formatTime, syncMainEvents } from './variables/normalize';
import { loadCharacterWorldbookData, mergeWorldbookTargets } from './worldbook';
import {
  createMemoryDraft,
  createMemoryPatchFromDraft,
  createUserEventMemoryPayload,
  updateMemoryRow,
  expireMemoryRow,
  restoreMemoryRow,
  deleteMemoryRow,
  deleteAllExpiredMemoryRows,
  expireAllUnlockedItems,
  insertMemoryRow,
  type MemoryTableName,
} from './memorydatabase/editor';
import { loadMemoryConfig, saveMemoryConfig, resetMemoryConfig } from './memory-config';
import { getImageGenerationPromptAtAnchor, isImageGenerationPluginAvailable, requestImageGeneration } from './plugins/image-generation';
import { isChatu8PluginAvailable, openChatu8Plugin } from './plugins/chatu8-integration';
import {
  buildFallbackFanGeneratedProfile,
  buildDeepSeekFanGenerationPrompt,
  buildFanProfilePreviewText,
  normalizeDeepSeekFanLookupState,
  normalizeFanGeneratedProfile,
  searchDeepSeekFanCharacter,
} from './plugins/deepseek-web-lookup';
import {
  isEditableTarget,
  isPaperFullscreenToggleShortcut,
  isPaperWorkspaceFullscreen,
  setPaperWorkspaceFullscreen,
  syncPaperFullscreenHost,
  togglePaperWorkspaceFullscreen,
} from './plugins/fullscreen';

const win = window as TavernWindow;
const root = document.querySelector<HTMLDivElement>('#app');

const READER_CONTEXT_MENU_GAP = 12;
const READER_CONTEXT_MENU_WIDTH = 240;
const READER_CONTEXT_MENU_HEIGHT = 176;
const STATUS_CACHE_KEY_PREFIX = 'islandmilfcode:status-cache:v2:';
const DRAWING_ENABLED_KEY_PREFIX = 'islandmilfcode:drawing-enabled:v1:';
const DEEPSEEK_MODE_ENABLED_KEY = 'islandmilfcode-ui:deepseek-mode-enabled:v1';

let flipDirection: 'forward' | 'backward' | '' = '';
let phoneBgmAudio: HTMLAudioElement | null = null;
let phoneBgmResolvedUrl = '';
let restoringSave = false;
let quickReplyDelegationBound = false;

type ReaderBodyScrollSnapshot = {
  readerIndex: number;
  scrollTop: number;
  wasAtBottom: boolean;
};

let readerDragState: {
  pointerId: number;
  startX: number;
  startY: number;
  startedInBody: boolean;
  intentLocked: boolean;
  scrolling: boolean;
  moved: boolean;
} | null = null;

let tucaoDragState: {
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  moved: boolean;
} | null = null;
let tucaoSuppressNextToggleClick = false;

function canFlipReader(direction: 'prev' | 'next') {
  const readerMessages = getReaderMessages(state.uiMessages);
  if (direction === 'prev') return state.focusedMessageIndex > 0;
  return state.focusedMessageIndex < readerMessages.length - 1;
}

function resetReaderCardTransform(reader: HTMLElement) {
  const card = reader.querySelector<HTMLElement>('.reader-card');
  if (!card) return;
  card.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease';
  card.style.transform = '';
  card.style.opacity = '';
}

function captureReaderBodyScroll(): ReaderBodyScrollSnapshot | null {
  const body = root?.querySelector<HTMLElement>('.reader-card__body');
  const card = body?.closest<HTMLElement>('.reader-card[data-reader-index]');
  const readerIndex = Number(card?.dataset.readerIndex);
  if (!body || !Number.isFinite(readerIndex)) return null;
  const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
  return {
    readerIndex,
    scrollTop: body.scrollTop,
    wasAtBottom: distanceFromBottom <= 24,
  };
}

function restoreReaderBodyScroll(snapshot: ReaderBodyScrollSnapshot | null) {
  if (!snapshot) return;
  const body = root?.querySelector<HTMLElement>(
    `.reader-card[data-reader-index="${snapshot.readerIndex}"] .reader-card__body`,
  );
  if (!body) return;
  const restore = () => {
    body.scrollTop = snapshot.wasAtBottom
      ? body.scrollHeight
      : Math.min(snapshot.scrollTop, Math.max(0, body.scrollHeight - body.clientHeight));
  };
  restore();
  window.requestAnimationFrame(restore);
}

function resolveReaderIndex(readerIndex: number, readerId?: string | null) {
  if (readerId) {
    const byId = getReaderMessages(state.uiMessages).findIndex(message => message.id === readerId);
    if (byId >= 0) return byId;
  }
  if (Number.isFinite(readerIndex)) return readerIndex;
  return state.focusedMessageIndex;
}

// ── State & adapter ──

let adapter: VariableAdapter;
const state = createInitialState(loadFloatingPhonePosition());
const eventStops: Array<() => void> = [];
let worldbookRefreshRetryTimer: number | null = null;
let worldbookRefreshRetryToken = 0;

function readDeepSeekModeEnabledPreference() {
  try {
    return localStorage.getItem(DEEPSEEK_MODE_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDeepSeekModeEnabledPreference(enabled: boolean) {
  try {
    localStorage.setItem(DEEPSEEK_MODE_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

state.deepSeekModeEnabled = readDeepSeekModeEnabledPreference();

// ── StatusData localStorage 缓存 ──
// 会话期间以内存里的 state.statusData 作为权威状态。
// 同时写入 localStorage，避免刷新后丢失，且不会被滞后的 MVU 回声覆盖。

function getStatusCacheKey() {
  return state.activeRunId ? `${STATUS_CACHE_KEY_PREFIX}${state.activeRunId}` : null;
}

function cacheStatusData(data: StatusData) {
  const key = getStatusCacheKey();
  if (!key) return;
  syncMainEvents(data, state.plotLibrary);
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* 忽略 */
  }
}

function guardedAdapterSave(data: StatusData) {
  syncMainEvents(data, state.plotLibrary);
  adapter.save(data);
  cacheStatusData(data);
}

function getDrawingEnabledPreferenceKey() {
  return `${DRAWING_ENABLED_KEY_PREFIX}${state.activeRunId ?? 'global'}`;
}

function readDrawingEnabledPreference() {
  try {
    const raw = localStorage.getItem(getDrawingEnabledPreferenceKey());
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* ignore storage failures */
  }
  return null;
}

function writeDrawingEnabledPreference(enabled: boolean) {
  try {
    localStorage.setItem(getDrawingEnabledPreferenceKey(), enabled ? 'true' : 'false');
  } catch {
    /* ignore storage failures */
  }
}

function applyDrawingEnabledPreference() {
  const stored = readDrawingEnabledPreference();
  if (stored == null) {
    writeDrawingEnabledPreference(Boolean(state.drawingSettings.enabled));
    return;
  }
  if (state.drawingSettings.enabled === stored) return;
  state.drawingSettings = normalizeDrawingSettings({
    ...state.drawingSettings,
    enabled: stored,
  });
  state.runtimeFlags.drawingSettings = JSON.parse(JSON.stringify(state.drawingSettings));
}

/** 包装后的 adapter：save() 会同时写入 localStorage 缓存。 */
const guardedAdapter: VariableAdapter = {
  get source() {
    return adapter.source;
  },
  load() {
    return adapter.load();
  },
  save(data: StatusData) {
    guardedAdapterSave(data);
  },
  onUpdate(cb: (data: StatusData) => void) {
    return adapter.onUpdate(cb);
  },
};

// 操作上下文会惰性引用 adapter，adapter 在初始化阶段设置。
const ctx: ActionContext = {
  get state() {
    return state;
  },
  get win() {
    return win;
  },
  get memoryDB() {
    return state.memoryDB;
  },
  get adapter() {
    return guardedAdapter;
  },
  render: () => render(),
  showNotification: (n: NotificationState) => {
    state.notification = n;
    render();
  },
  clearNotification: (shouldRender: boolean) => {
    if (!state.notification) return;
    state.notification = null;
    if (shouldRender) render();
  },
  persistConversation: () => {
    persistToSave();
  },
  closeReaderContextMenu: (shouldRender: boolean) => {
    if (!state.readerContextMenu) return;
    state.readerContextMenu = null;
    if (shouldRender) render();
  },
  get summaryStore() {
    return state.summaryStore;
  },
  get summaryApiConfig() {
    return state.summaryApiConfig;
  },
  onSummaryStoreUpdated: () => {
    persistToSave();
  },
};

// ── Save system ──

function commitDrawingSettingsToRuntimeFlags() {
  state.drawingSettings = normalizeDrawingSettings(state.drawingSettings);
  state.runtimeFlags.drawingSettings = JSON.parse(JSON.stringify(state.drawingSettings));
}

function stripGlobalRuntimeFlags<T extends Record<string, unknown>>(flags: T): T {
  delete flags.deepSeekMode;
  delete flags.deepSeekWebLookup;
  return flags;
}

function syncRuntimeProfile() {
  state.playerProfile = normalizePlayerProfile(state.playerProfile);
  state.runtimeFlags.playerProfile = JSON.parse(JSON.stringify(state.playerProfile));
}

function buildGameState(statusData: StatusData = state.statusData): GameState {
  syncRuntimeProfile();
  commitDrawingSettingsToRuntimeFlags();
  return {
    runId: state.activeRunId ?? crypto.randomUUID(),
    statusData: JSON.parse(JSON.stringify(statusData)),
    currentMessageIndex: Math.max(getReaderMessages(state.uiMessages).length - 1, 0),
    runtimeFlags: {
      ...stripGlobalRuntimeFlags(JSON.parse(JSON.stringify(state.runtimeFlags)) as Record<string, unknown>),
      playerProfile: JSON.parse(JSON.stringify(state.playerProfile)),
      phoneMessages: JSON.parse(JSON.stringify(state.phoneMessages)),
      drawingSettings: JSON.parse(JSON.stringify(state.drawingSettings)),
    },
  };
}

function persistToSave() {
  if (!state.activeRunId || restoringSave) return;
  const saveId = getAutosaveBranchSaveId({
    activeSaveId: state.activeSaveId,
    runId: state.activeRunId,
  });
  const meta = writeAutosave(
    {
      runId: state.activeRunId,
      gameState: buildGameState(),
      chatLog: serializeMessages(state.uiMessages),
      summaryStore: state.summaryStore,
      memoryDB: state.memoryDB,
    },
    saveId,
  );
  if (meta) {
    state.activeSaveId = meta.saveId;
    setActiveSaveId(meta.saveId);
  }
}

async function persistManualSave() {
  if (!state.activeRunId) return;
  const meta = createManualSave({
    runId: state.activeRunId,
    label: '手动存档',
    gameState: buildGameState(),
    chatLog: serializeMessages(state.uiMessages),
    summaryStore: state.summaryStore,
    memoryDB: state.memoryDB,
  });
  state.activeSaveId = meta.saveId;
  setActiveSaveId(meta.saveId);
  // 用户主动存档：等 IndexedDB 落盘完成，避免下一秒刷新就丢。
  await flushSaveStore();
}

async function downloadSaveBackup(saveId: string) {
  if (state.activeRunId && state.activeSaveId === saveId) {
    persistToSave();
  }
  // 导出前确保已入队的写入全部落盘，再去读。
  await flushSaveStore();
  try {
    const blob = new Blob(exportSaveAsJsonParts(saveId), { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `islandmilfcode-save-${saveId}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // setTimeout 让浏览器有机会真正触发下载之后再回收 URL。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    window.alert(`导出失败：${(error as Error).message}`);
  }
}

function savePlayerProfileFromStatusPanel() {
  const getProfileFieldValue = (field: string) =>
    root?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-profile-field="${field}"]`)?.value ?? '';

  const familyName = getProfileFieldValue('familyName');
  const givenName = getProfileFieldValue('givenName');
  const personality = getProfileFieldValue('personality');
  const appearance = getProfileFieldValue('appearance');

  const trimmedFamilyName = familyName.trim();
  const trimmedGivenName = givenName.trim();

  state.playerProfile = {
    ...state.playerProfile,
    familyName: trimmedFamilyName,
    givenName: trimmedGivenName,
    name: trimmedFamilyName + trimmedGivenName,
    personality: personality.trim(),
    appearance: appearance.trim(),
  };
  state.playerProfileEditing = false;
  persistToSave();
  render();
}

function setPlayerProfileEditing(editing: boolean) {
  state.playerProfileEditing = editing;
  render();
}

function rebuildRuntimeAfterRestore() {
  state.draft = '';
  state.generating = false;
  state.currentGenerationId = '';
  state.finalizedGenerationId = '';
  state.notification = null;
  state.readerContextMenu = null;
  state.playerProfileEditing = false;
  resetPhoneRouteState(state);
  state.focusedMessagePage = 0;
}

async function refreshCharacterWorldbookTargets() {
  const { targets, plotLibrary, characterCardLibrary } = await loadCharacterWorldbookData(win);
  const previousPlotEventCount = Object.keys(state.plotLibrary.events).length;
  const previousCardCount = Object.keys(state.characterCardLibrary.cards).length;
  const nextPlotEventCount = Object.keys(plotLibrary.events).length;
  const nextCardCount = Object.keys(characterCardLibrary.cards).length;
  const keepPreviousPlotLibrary = previousPlotEventCount > 0 && nextPlotEventCount === 0;
  const keepPreviousCharacterCards = previousCardCount > 0 && nextCardCount === 0;
  if (keepPreviousPlotLibrary) {
    console.warn('[worldbook] plot events reload returned empty; keeping previous plot library');
  } else {
    state.plotLibrary = plotLibrary;
  }
  if (keepPreviousCharacterCards) {
    console.warn('[worldbook] character cards reload returned empty; keeping previous character card library');
  } else {
    state.characterCardLibrary = characterCardLibrary;
  }

  const previous = JSON.stringify(state.statusData.targets);
  if (targets.length) {
    state.statusData = mergeWorldbookTargets(state.statusData, targets);
  }
  const targetsChanged = JSON.stringify(state.statusData.targets) !== previous;
  const plotChanged = !keepPreviousPlotLibrary && nextPlotEventCount !== previousPlotEventCount;
  const cardsChanged = !keepPreviousCharacterCards && nextCardCount !== previousCardCount;
  if (!targetsChanged && !plotChanged && !cardsChanged) return;

  guardedAdapterSave(state.statusData);
  render();
}

function getDeepSeekFanState(): DeepSeekFanLookupState {
  return normalizeDeepSeekFanLookupState(state.runtimeFlags.deepSeekFanLookup);
}

function setDeepSeekFanState(next: DeepSeekFanLookupState) {
  state.runtimeFlags.deepSeekFanLookup = JSON.parse(JSON.stringify(next));
  persistToSave();
}

function readDeepSeekFanForm(): DeepSeekFanLookupState {
  const current = getDeepSeekFanState();
  const value = (field: string) =>
    root?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field="${field}"]`)?.value ??
    null;
  return normalizeDeepSeekFanLookupState({
    ...current,
    workTitle: value('deepseek-fan-work-title') ?? current.workTitle,
    characterName: value('deepseek-fan-character-name') ?? current.characterName,
    targetRoleId: value('deepseek-fan-target-role') ?? current.targetRoleId,
    worldbookName: value('deepseek-fan-worldbook') ?? current.worldbookName,
    extra: value('deepseek-fan-extra') ?? current.extra,
    searchProvider: value('deepseek-fan-search-provider') ?? current.searchProvider,
    searchApiKey: value('deepseek-fan-search-api-key') ?? current.searchApiKey,
    searchSearxngUrl: value('deepseek-fan-searxng-url') ?? current.searchSearxngUrl,
    searchDdgRegion: value('deepseek-fan-ddg-region') ?? current.searchDdgRegion,
    searchTimeoutMs: Number(value('deepseek-fan-timeout') ?? current.searchTimeoutMs),
    searchMaxResults: Number(value('deepseek-fan-max-results') ?? current.searchMaxResults),
    readerResultCount: Number(value('deepseek-fan-reader-count') ?? current.readerResultCount),
  });
}

function syncDeepSeekFanForm(shouldRender = false) {
  if (!state.deepSeekModeEnabled || state.phoneRoute !== 'app:deepseek-web') return;
  setDeepSeekFanState(readDeepSeekFanForm());
  if (shouldRender) render();
}

function guardDeepSeekFanAction() {
  return state.deepSeekModeEnabled && state.phoneRoute === 'app:deepseek-web';
}

function updateDeepSeekFanState(patch: Partial<DeepSeekFanLookupState>, shouldRender = true) {
  const next = normalizeDeepSeekFanLookupState({
    ...getDeepSeekFanState(),
    ...patch,
    lastUpdatedAt: Date.now(),
  });
  setDeepSeekFanState(next);
  if (shouldRender) render();
  return next;
}

function setDeepSeekWebLookupEnabled(enabled: boolean) {
  if (!state.deepSeekModeEnabled || state.phoneRoute !== 'app:deepseek-web') return;
  const current =
    state.runtimeFlags.deepSeekWebLookup && typeof state.runtimeFlags.deepSeekWebLookup === 'object'
      ? (state.runtimeFlags.deepSeekWebLookup as Record<string, unknown>)
      : {};
  state.runtimeFlags.deepSeekWebLookup = {
    ...current,
    enabled,
    timeoutMs: Number(current.timeoutMs ?? 12000) || 12000,
    maxEvidencePacks: Number(current.maxEvidencePacks ?? 4) || 4,
    searchSource: String(current.searchSource || 'ddg'),
    searchDdgRegion: String(current.searchDdgRegion || 'wt-wt'),
  };
  render();
}

function updateDeepSeekWebLookupSettingsFromControls(shouldRender = false) {
  if (!state.deepSeekModeEnabled || state.phoneRoute !== 'app:deepseek-web') return;
  const value = (field: string) =>
    document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`)?.value?.trim();
  const current =
    state.runtimeFlags.deepSeekWebLookup && typeof state.runtimeFlags.deepSeekWebLookup === 'object'
      ? (state.runtimeFlags.deepSeekWebLookup as Record<string, unknown>)
      : {};
  state.runtimeFlags.deepSeekWebLookup = {
    ...current,
    enabled: Boolean(current.enabled),
    timeoutMs: Number(value('deepseek-web-timeout') ?? current.timeoutMs ?? 12000) || 12000,
    maxEvidencePacks: Number(value('deepseek-web-max-results') ?? current.maxEvidencePacks ?? 4) || 4,
    searchSource: value('deepseek-web-search-source') || current.searchSource || 'ddg',
    searchDdgRegion: value('deepseek-web-ddg-region') || current.searchDdgRegion || 'wt-wt',
  };
  if (shouldRender) render();
}

function normalizeDeepSeekFanActionError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/AuthenticationRequiredError|Authorization header|API key|unauthorized|forbidden/i.test(message)) {
    return fallback;
  }
  return message || fallback;
}

function isAuthenticationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /AuthenticationRequiredError|Authorization header|API key|unauthorized|forbidden/i.test(message);
}

async function runDeepSeekFanSearch() {
  if (!guardDeepSeekFanAction()) return;
  const form = readDeepSeekFanForm();
  updateDeepSeekFanState({ ...form, status: 'searching', error: '' });
  try {
    const result = await searchDeepSeekFanCharacter(form);
    updateDeepSeekFanState({
      status: 'searched',
      error: '',
      searchQuery: result.query,
      searchContext: result.context,
      searchResults: result.results,
    });
  } catch (error) {
    updateDeepSeekFanState({
      status: 'error',
      error: normalizeDeepSeekFanActionError(
        error,
        '搜索服务要求鉴权。普通玩家不需要准备模型 API key；请改用 DDG，或填写自己的 SearXNG 地址。',
      ),
    });
  }
}

async function generateDeepSeekFanProfile() {
  if (!guardDeepSeekFanAction()) return;
  const form = readDeepSeekFanForm();
  updateDeepSeekFanState({ ...form, status: 'generating', error: '' });
  const promptState = normalizeDeepSeekFanLookupState({ ...form, status: 'generating' });
  const prompt = buildDeepSeekFanGenerationPrompt(promptState);
  try {
    const generationId = `deepseek-fan-${crypto.randomUUID()}`;
    const raw =
      typeof win.generateRaw === 'function'
        ? String(
            (await win.generateRaw({
              should_silence: true,
              should_stream: false,
              generation_id: generationId,
              ordered_prompts: [{ role: 'system', content: prompt }],
            })) ?? '',
          )
        : typeof win.generate === 'function'
          ? String(
              (await win.generate({
                should_silence: true,
                should_stream: false,
                generation_id: generationId,
                user_input: prompt,
              })) ?? '',
            )
          : '';
    if (!raw) throw new Error('当前环境没有可用的 generateRaw/generate。');
    const profile = normalizeFanGeneratedProfile(raw, {
      workTitle: form.workTitle,
      characterName: form.characterName,
    });
    if (!profile) throw new Error('生成结果不是可解析的角色 JSON。');
    updateDeepSeekFanState({
      status: 'generated',
      error: '',
      generatedText: raw,
      generatedProfile: profile,
      worldbookEntryText: buildFanProfilePreviewText(profile),
    });
  } catch (error) {
    if (isAuthenticationError(error)) {
      const fallbackProfile = buildFallbackFanGeneratedProfile(form);
      updateDeepSeekFanState({
        status: 'generated',
        error: '生成模型要求 API key，已改用本地保守草稿。搜索资料不会交给模型联网。',
        generatedText: fallbackProfile.content,
        generatedProfile: fallbackProfile,
        worldbookEntryText: buildFanProfilePreviewText(fallbackProfile),
      });
      return;
    }
    updateDeepSeekFanState({
      status: 'error',
      error: normalizeDeepSeekFanActionError(
        error,
        '生成设定需要酒馆当前已有可用模型配置/API key；搜索资料本身不交给模型，也不会接入正文生成。',
      ),
    });
  }
}

function clearWorldbookRefreshRetry() {
  worldbookRefreshRetryToken += 1;
  if (worldbookRefreshRetryTimer !== null) {
    window.clearTimeout(worldbookRefreshRetryTimer);
    worldbookRefreshRetryTimer = null;
  }
}

function scheduleWorldbookRefreshRetry(runId: string | null, attempt = 1) {
  const retryDelays = [800, 1600, 3000, 5000, 8000];
  if (!runId || attempt > retryDelays.length) return;
  if (Object.keys(state.plotLibrary.events).length > 0) return;

  const token = worldbookRefreshRetryToken;
  worldbookRefreshRetryTimer = window.setTimeout(() => {
    worldbookRefreshRetryTimer = null;
    if (token !== worldbookRefreshRetryToken || state.activeRunId !== runId) return;
    void refreshCharacterWorldbookTargets()
      .catch(error => {
        console.warn('[worldbook] delayed refresh failed:', error);
      })
      .finally(() => {
        if (token !== worldbookRefreshRetryToken || state.activeRunId !== runId) return;
        if (Object.keys(state.plotLibrary.events).length === 0) {
          scheduleWorldbookRefreshRetry(runId, attempt + 1);
        }
      });
  }, retryDelays[attempt - 1]);
}

function enterSave(saveId: string) {
  const save = loadSave(saveId);
  if (!save) return;
  restoringSave = true;
  clearWorldbookRefreshRetry();
  state.activeRunId = save.payload.runId;
  state.activeSaveId = saveId;
  setActiveRunId(save.payload.runId);
  setActiveSaveId(saveId);
  state.creatingCharacter = false;
  state.showingSaveList = false;
  const msgs = deserializeMessages(save.payload.chatLog);
  replaceConversationMessages(state, msgs);
  state.statusData = save.payload.gameState.statusData;
  state.playerProfile = normalizePlayerProfile(
    (save.payload.gameState.runtimeFlags?.playerProfile as typeof state.playerProfile | undefined) ?? {
      name: save.meta.playerProfile?.name ?? save.meta.characterName ?? '',
      personality: save.meta.playerProfile?.personality ?? save.meta.personality ?? '',
      appearance: save.meta.playerProfile?.appearance ?? save.meta.appearance ?? '',
      className: save.meta.playerProfile?.className ?? '2年A班',
    },
  );
  state.runtimeFlags = stripGlobalRuntimeFlags(
    JSON.parse(JSON.stringify(save.payload.gameState.runtimeFlags ?? {})) as Record<string, unknown>,
  );
  state.drawingSettings = normalizeDrawingSettings(state.runtimeFlags.drawingSettings);
  commitDrawingSettingsToRuntimeFlags();
  applyDrawingEnabledPreference();
  state.summaryStore = save.payload.summaryStore;
  if (save.payload.memoryDB) {
    state.memoryDB = save.payload.memoryDB;
  }
  state.phoneMessages = normalizePhoneMessageStore(state.runtimeFlags.phoneMessages);
  cacheStatusData(state.statusData);
  guardedAdapterSave(state.statusData);
  rebuildRuntimeAfterRestore();
  render();
  void refreshCharacterWorldbookTargets()
    .catch(error => {
      console.warn('[save-restore] refreshCharacterWorldbookTargets failed:', error);
    })
    .finally(() => {
      restoringSave = false;
      if (Object.keys(state.plotLibrary.events).length === 0) {
        scheduleWorldbookRefreshRetry(state.activeRunId);
      }
    });
}

function returnToTitle() {
  clearWorldbookRefreshRetry();
  if (state.activeRunId) {
    persistToSave();
  }
  state.activeRunId = null;
  state.activeSaveId = null;
  setActiveRunId(null);
  clearActiveSaveId();
  state.creatingCharacter = false;
  state.showingSaveList = false;
  render();
}

// ── UI actions (thin wrappers that stay in index.ts) ──

function openReaderContextMenu(readerIndex: number, clientX: number, clientY: number, readerId?: string | null) {
  const resolvedReaderIndex = resolveReaderIndex(readerIndex, readerId);
  const message = getReaderMessageByIndex(state, resolvedReaderIndex);
  if (!message) return;
  const maxX = Math.max(
    READER_CONTEXT_MENU_GAP,
    window.innerWidth - READER_CONTEXT_MENU_WIDTH - READER_CONTEXT_MENU_GAP,
  );
  const maxY = Math.max(
    READER_CONTEXT_MENU_GAP,
    window.innerHeight - READER_CONTEXT_MENU_HEIGHT - READER_CONTEXT_MENU_GAP,
  );
  state.readerContextMenu = {
    readerIndex: resolvedReaderIndex,
    sourceUserText: getSourceUserTextForReaderIndex(state, resolvedReaderIndex),
    canDeleteMessage: Boolean(message),
    x: clamp(clientX, READER_CONTEXT_MENU_GAP, maxX),
    y: clamp(clientY, READER_CONTEXT_MENU_GAP, maxY),
  };
  render();
}

function openReaderEditor(readerIndex: number, readerId?: string | null) {
  const resolvedReaderIndex = resolveReaderIndex(readerIndex, readerId);
  const message = getReaderMessageByIndex(state, resolvedReaderIndex);
  if (!message) return;
  state.readerEditing = {
    readerIndex: resolvedReaderIndex,
    draft: String(message.rawText || message.text || ''),
  };
  ctx.closeReaderContextMenu(false);
  render();
  window.requestAnimationFrame(() => {
    const textarea = root?.querySelector<HTMLTextAreaElement>('[data-field="reader-edit-draft"]');
    textarea?.focus();
    if (textarea) {
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }
  });
}

function cancelReaderEditor() {
  if (!state.readerEditing) return;
  state.readerEditing = null;
  render();
}

async function saveReaderEditor() {
  const editing = state.readerEditing;
  if (!editing) return;
  const textarea = root?.querySelector<HTMLTextAreaElement>('[data-field="reader-edit-draft"]');
  const nextText = textarea?.value ?? editing.draft;

  const readerMessages = getReaderMessages(state.uiMessages);
  const message = readerMessages[editing.readerIndex];
  if (!message) {
    state.readerEditing = null;
    render();
    return;
  }

  message.rawText = nextText;
  message.text = message.role === 'assistant' ? extractContextReply(nextText) || nextText : nextText;
  invalidateReaderMessagesCache();

  // 同步回酒馆楼层，防止刷新后又被酒馆侧的原文覆盖。
  if (typeof message.tavernMessageId === 'number' && typeof win.setChatMessages === 'function') {
    try {
      await win.setChatMessages([{ message_id: message.tavernMessageId, message: nextText }], { refresh: 'none' });
    } catch (error) {
      console.warn('[reader-edit] setChatMessages failed:', error);
    }
  }

  state.readerEditing = null;
  ctx.persistConversation();
  render();
}

function focusComposer(placeCursorAtEnd = true) {
  window.requestAnimationFrame(() => {
    const textarea =
      root?.querySelector<HTMLTextAreaElement>('.phone-modal.is-open .composer-input') ??
      root?.querySelector<HTMLTextAreaElement>('.composer-input');
    if (!textarea) return;
    textarea.focus();
    if (placeCursorAtEnd) {
      const offset = textarea.value.length;
      textarea.setSelectionRange(offset, offset);
    }
  });
}

function getPaperScrollTarget(workspace: HTMLElement | null | undefined) {
  return workspace?.classList.contains('is-paper-fullscreen') ? workspace : document.scrollingElement;
}

function jumpToComposer(button: HTMLElement) {
  const workspace = button.closest<HTMLElement>('.paper-workspace');
  const textarea = workspace?.querySelector<HTMLTextAreaElement>('.composer-input');
  const scrollTarget = getPaperScrollTarget(workspace);

  // 直达输入框：全屏滚纸面，普通模式滚页面。
  scrollTarget?.scrollTo({ top: scrollTarget.scrollHeight, behavior: 'smooth' });
  window.requestAnimationFrame(() => {
    textarea?.focus();
    const end = textarea?.value.length ?? 0;
    textarea?.setSelectionRange(end, end);
  });
}

function jumpToPaperTop(button: HTMLElement) {
  // 回顶：和直达输入框共用滚动容器判断。
  getPaperScrollTarget(button.closest<HTMLElement>('.paper-workspace'))?.scrollTo({ top: 0, behavior: 'smooth' });
}

function injectComposerDraft(text: string) {
  state.draft = text;
  const textareas = Array.from(root?.querySelectorAll<HTMLTextAreaElement>('.composer-input') ?? []);
  if (!textareas.length) {
    render();
    focusComposer();
    return;
  }

  textareas.forEach(textarea => {
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  focusComposer();
}

function bindQuickReplyDelegation() {
  if (!root || quickReplyDelegationBound) return;
  quickReplyDelegationBound = true;
  root.addEventListener(
    'click',
    event => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-action="select-option"]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();

      const optionText = button.dataset.optionText;
      if (!optionText) return;

      injectComposerDraft(optionText);
    },
    true,
  );
}

function focusMessage(delta: number) {
  const nextIndex = clampFocusedMessageIndex(state, state.focusedMessageIndex + delta);
  if (nextIndex === state.focusedMessageIndex) return;
  flipDirection = delta > 0 ? 'forward' : 'backward';
  ctx.closeReaderContextMenu(false);
  state.focusedMessageIndex = nextIndex;
  state.focusedMessagePage = 0;
  render();
  flipDirection = '';
}

function jumpMessage(index: number) {
  const nextIndex = clampFocusedMessageIndex(state, index);
  if (nextIndex === state.focusedMessageIndex) return;
  flipDirection = nextIndex > state.focusedMessageIndex ? 'forward' : 'backward';
  ctx.closeReaderContextMenu(false);
  state.focusedMessageIndex = nextIndex;
  state.focusedMessagePage = 0;
  render();
  flipDirection = '';
}

async function rollbackToReaderInput(readerIndex: number) {
  const target = await rollbackConversation(state, readerIndex, win);
  if (!target?.sourceUserText) return;
  state.draft = target.sourceUserText;
  guardedAdapterSave(state.statusData);
  ctx.persistConversation();
  ctx.closeReaderContextMenu(false);
  render();
  focusComposer();
}

async function regenerateReaderMessage(readerIndex: number) {
  if (state.generating) return;
  const target = await rollbackConversation(state, readerIndex, win);
  if (!target?.sourceUserText) return;
  state.draft = target.sourceUserText;
  guardedAdapterSave(state.statusData);
  ctx.persistConversation();
  ctx.closeReaderContextMenu(false);
  render();
  await submitMessage(ctx, { text: target.sourceUserText, keepDraft: true, clearDraftOnSuccess: true });
}

async function deleteReaderFloor(readerIndex: number) {
  if (state.generating) return;
  const deletedSourceText = getSourceUserTextForReaderIndex(state, readerIndex).trim();
  const deleted = await deleteReaderMessage(state, readerIndex, win);
  if (!deleted) return;
  if (deletedSourceText && state.draft.trim() === deletedSourceText) {
    state.draft = '';
  }
  guardedAdapterSave(state.statusData);
  ctx.persistConversation();
  ctx.closeReaderContextMenu(false);
  render();
}

function navigatePhone(route: PhoneRoute) {
  syncDrawingSettingsFromMountedControls();
  syncDeepSeekFanForm(false);
  if (route === 'app:deepseek-web' && !state.deepSeekModeEnabled) {
    navigatePhoneRoute(state, 'home', ctx);
    return;
  }
  navigatePhoneRoute(state, route, ctx);
}

function navigatePhoneBack() {
  syncDrawingSettingsFromMountedControls();
  syncDeepSeekFanForm(false);
  if (state.phoneRouteHistory[state.phoneRouteHistory.length - 1] === 'app:deepseek-web' && !state.deepSeekModeEnabled) {
    state.phoneRouteHistory = state.phoneRouteHistory.filter(route => route !== 'app:deepseek-web');
  }
  navigatePhoneBackRoute(state, ctx);
}

function switchTab(tab: TabKey) {
  navigatePhone(getRouteForTab(tab));
}

function openPhone(targetRoute?: PhoneRoute) {
  if (targetRoute === 'app:deepseek-web' && !state.deepSeekModeEnabled) {
    openPhoneRoute(state, ctx, 'home');
    return;
  }
  openPhoneRoute(state, ctx, targetRoute);
}

function closePhone() {
  syncDrawingSettingsFromMountedControls();
  syncDeepSeekFanForm(false);
  closePhoneRoute(state, ctx);
}

function playPhoneCharacterBgm(characterId: PhoneCharacterId, bgmUrl: string | undefined) {
  const nextUrl = bgmUrl?.trim();
  if (!nextUrl) {
    // 中文注释：没有专属 BGM 的角色切换时要停止上一首，避免主题已经换了但音乐还停留在前一个角色。
    phoneBgmAudio?.pause();
    phoneBgmResolvedUrl = '';
    state.musicPlayer.currentTrack = null;
    state.musicPlayer.playing = false;
    state.musicPlayer.currentTime = 0;
    state.musicPlayer.duration = 0;
    return;
  }

  if (!isPhoneThemeCharacterId(characterId)) return;

  // 音频播放必须从用户点击事件里触发，不能放进 render() 这类自动渲染流程里。
  // 这里复用一个 Audio 实例，切换女主时先停掉上一首，避免多首 BGM 同时叠在一起。
  const resolvedUrl = new URL(nextUrl, window.location.href).href;
  if (phoneBgmAudio && phoneBgmResolvedUrl === resolvedUrl && !phoneBgmAudio.paused) {
    // 同一个头像再次点击视为关闭当前 BGM，避免循环音乐一直播放打扰阅读。
    phoneBgmAudio.pause();
    phoneBgmAudio.currentTime = 0;
    state.musicPlayer.playing = false;
    state.musicPlayer.currentTrack = null;
    state.musicPlayer.currentTime = 0;
    state.musicPlayer.duration = 0;
    return;
  }

  if (!phoneBgmAudio || phoneBgmResolvedUrl !== resolvedUrl) {
    phoneBgmAudio?.pause();
    phoneBgmAudio = new Audio(resolvedUrl);
    phoneBgmAudio.loop = true;
    phoneBgmAudio.volume = 0.45;
    phoneBgmAudio.preload = 'auto';
    phoneBgmResolvedUrl = resolvedUrl;
    bindPhoneBgmAudioEvents();
  } else {
    // 当前音乐已经暂停时，再次点击同一头像恢复从头播放。
    phoneBgmAudio.currentTime = 0;
  }

  // 角色 BGM 也作为 currentTrack 显示在 hero 卡上：用户能看到当前在播什么、可以暂停/拖进度。
  state.musicPlayer.currentTrack = makeCharacterBgmTrack(characterId, resolvedUrl);
  state.musicPlayer.queue = [];
  state.musicPlayer.currentTime = 0;
  state.musicPlayer.duration = 0;
  // play() 在浏览器里返回 Promise；如果网络、格式或自动播放策略失败，不影响切换主题。
  void phoneBgmAudio.play().catch(error => {
    console.warn('角色 BGM 播放失败：', error);
  });
}

// phoneBgmAudio 是单例，事件监听只绑一次就够了；切换 src 时不需要重绑。
function bindPhoneBgmAudioEvents() {
  if (!phoneBgmAudio) return;
  phoneBgmAudio.addEventListener('play', () => {
    if (state.musicPlayer.currentTrack) {
      state.musicPlayer.playing = true;
      render();
    }
  });
  phoneBgmAudio.addEventListener('pause', () => {
    if (state.musicPlayer.currentTrack) {
      state.musicPlayer.playing = false;
      render();
    }
  });
  phoneBgmAudio.addEventListener('ended', () => {
    if (!state.musicPlayer.currentTrack) return;
    state.musicPlayer.playing = false;
    void playNextSearchTrack();
  });
  phoneBgmAudio.addEventListener('error', () => {
    if (!state.musicPlayer.currentTrack) return;
    state.musicPlayer.playing = false;
    state.musicPlayer.loadingTrackId = null;
    render();
  });
  // timeupdate/loadedmetadata 不能触发 render：每秒重渲整个手机会丢输入焦点、动画跳变。
  // 这里直接 patch DOM；state 也同步更新，下一次 render 才能复位进度条到正确位置。
  phoneBgmAudio.addEventListener('timeupdate', () => {
    if (!state.musicPlayer.currentTrack || !phoneBgmAudio) return;
    const t = phoneBgmAudio.currentTime || 0;
    state.musicPlayer.currentTime = t;
    if (seekDragging) return;
    const seek = root?.querySelector<HTMLInputElement>('.phone-music-seek');
    if (seek) seek.value = String(t);
    const cur = root?.querySelector<HTMLElement>('[data-music-current-time]');
    if (cur) cur.textContent = formatPlaybackTime(t);
  });
  phoneBgmAudio.addEventListener('loadedmetadata', () => {
    if (!state.musicPlayer.currentTrack || !phoneBgmAudio) return;
    const d = phoneBgmAudio.duration || 0;
    state.musicPlayer.duration = d;
    const seek = root?.querySelector<HTMLInputElement>('.phone-music-seek');
    if (seek) {
      seek.max = String(d);
      seek.disabled = !(d > 0);
    }
    const dur = root?.querySelector<HTMLElement>('[data-music-duration]');
    if (dur) dur.textContent = formatPlaybackTime(d);
  });
}

// 拖动进度条的瞬间不能让 timeupdate 把 slider 拽回去；指针抬起或 change 事件触发后再 seek。
let seekDragging = false;

async function playMusicTrack(track: MusicTrack) {
  // 搜索播放和角色 BGM 共用 phoneBgmAudio：先停角色 BGM 再放新音乐。
  if (state.musicPlayer.loadingTrackId === track.id) return;
  state.musicPlayer.loadingTrackId = track.id;
  render();

  try {
    const [streamUrl, picUrl] = await Promise.all([
      track.streamUrl ? Promise.resolve(track.streamUrl) : fetchTrackStreamUrl(track),
      track.picUrl ? Promise.resolve(track.picUrl) : fetchTrackPicUrl(track),
    ]);
    const enriched: MusicTrack = { ...track, streamUrl, picUrl };

    // 把 phoneBgmAudio 的 src 切到搜索曲目；loop 关掉以便 ended 时跳下一首。
    if (phoneBgmAudio) {
      phoneBgmAudio.pause();
    }
    phoneBgmAudio = new Audio(streamUrl);
    phoneBgmAudio.loop = false;
    phoneBgmAudio.volume = 0.55;
    phoneBgmAudio.preload = 'auto';
    phoneBgmResolvedUrl = new URL(streamUrl, window.location.href).href;
    bindPhoneBgmAudioEvents();

    state.musicPlayer.currentTrack = enriched;
    state.musicPlayer.loadingTrackId = null;
    // 把搜索结果当作可循环的队列：从结果里复制一份，下一首就在结果中循环。
    state.musicPlayer.queue = state.musicPlayer.search.results.slice();
    render();

    await phoneBgmAudio.play();
  } catch (error) {
    state.musicPlayer.loadingTrackId = null;
    state.musicPlayer.playing = false;
    state.musicPlayer.search.error = error instanceof Error ? error.message : '播放失败';
    state.musicPlayer.search.status = 'error';
    render();
  }
}

async function playNextSearchTrack() {
  const queue = state.musicPlayer.queue;
  const current = state.musicPlayer.currentTrack;
  if (!queue.length || !current) return;
  const idx = queue.findIndex(t => t.id === current.id && t.source === current.source);
  const nextIndex = idx >= 0 && idx + 1 < queue.length ? idx + 1 : 0;
  const next = queue[nextIndex];
  if (next) {
    await playMusicTrack(next);
  }
}

function toggleMusicPlayPause() {
  if (!phoneBgmAudio || !state.musicPlayer.currentTrack) return;
  if (phoneBgmAudio.paused) {
    void phoneBgmAudio.play().catch(error => {
      console.warn('音乐恢复播放失败：', error);
    });
  } else {
    phoneBgmAudio.pause();
  }
}

async function submitMusicSearch(query: string) {
  const trimmed = query.trim();
  state.musicPlayer.search.query = trimmed;
  if (!trimmed) {
    state.musicPlayer.search.status = 'idle';
    state.musicPlayer.search.results = [];
    state.musicPlayer.search.error = null;
    render();
    return;
  }

  const requestId = state.musicPlayer.search.requestId + 1;
  state.musicPlayer.search.requestId = requestId;
  state.musicPlayer.search.status = 'loading';
  state.musicPlayer.search.error = null;
  render();

  try {
    const results = await searchMusic(trimmed, state.musicPlayer.search.source);
    if (state.musicPlayer.search.requestId !== requestId) return;
    state.musicPlayer.search.results = results;
    state.musicPlayer.search.status = 'ready';
    render();
  } catch (error) {
    if (state.musicPlayer.search.requestId !== requestId) return;
    state.musicPlayer.search.results = [];
    state.musicPlayer.search.status = 'error';
    state.musicPlayer.search.error = error instanceof Error ? error.message : '搜索失败';
    render();
  }
}

function quickSearchCharacterSong(characterId: PhoneThemeCharacterId) {
  const keyword = CHARACTER_QUICK_SEARCH[characterId];
  if (!keyword) return;
  void submitMusicSearch(keyword);
}

function updateDrawingSettingsFromControls(shouldRender = false) {
  const settings = state.drawingSettings;
  settings.qualityPrompt =
    root?.querySelector<HTMLInputElement>('[data-field="drawing-quality-prompt"]')?.value ?? settings.qualityPrompt;
  settings.negativePrompt =
    root?.querySelector<HTMLInputElement>('[data-field="drawing-negative-prompt"]')?.value ?? settings.negativePrompt;
  settings.manualPrompt =
    root?.querySelector<HTMLTextAreaElement>('[data-field="drawing-manual-prompt"]')?.value ?? settings.manualPrompt;
  settings.width = clamp(
    Number(root?.querySelector<HTMLInputElement>('[data-field="drawing-width"]')?.value ?? settings.width) ||
      settings.width,
    256,
    2048,
  );
  settings.height = clamp(
    Number(root?.querySelector<HTMLInputElement>('[data-field="drawing-height"]')?.value ?? settings.height) ||
      settings.height,
    256,
    2048,
  );
  settings.contextMessageCount = clamp(
    Number(
      root?.querySelector<HTMLInputElement>('[data-field="drawing-context-count"]')?.value ??
        settings.contextMessageCount,
    ) || 0,
    0,
    20,
  );
  settings.systemPrompt =
    root?.querySelector<HTMLTextAreaElement>('[data-field="drawing-system-prompt"]')?.value ?? settings.systemPrompt;

  root?.querySelectorAll<HTMLElement>('[data-drawing-anchor-id]').forEach(row => {
    const id = row.dataset.drawingAnchorId;
    const anchor = settings.characterAnchors.find(item => item.id === id);
    if (!anchor) return;
    anchor.name =
      row.querySelector<HTMLInputElement>('[data-field="drawing-anchor-name"]')?.value.trim() ?? anchor.name;
    anchor.prompt =
      row.querySelector<HTMLTextAreaElement>('[data-field="drawing-anchor-prompt"]')?.value.trim() ?? anchor.prompt;
  });

  state.drawingSettings = normalizeDrawingSettings(settings);
  commitDrawingSettingsToRuntimeFlags();
  persistToSave();
  if (shouldRender) render();
}

function syncDrawingSettingsFromMountedControls() {
  if (state.generating) return;
  if (
    !root?.querySelector(
      '[data-field="drawing-negative-prompt"], [data-field="drawing-quality-prompt"], [data-field="drawing-manual-prompt"]',
    )
  ) {
    return;
  }
  updateDrawingSettingsFromControls(false);
}

function showDrawingPluginMissingNotification() {
  ctx.showNotification({
    kind: 'message',
    title: '未检测到生图插件',
    preview: '请先安装并启用智绘姬/生图插件。',
    targetTab: 'summary',
    timestamp: formatTime(state.statusData.world.currentTime),
    phoneRoute: 'app:drawing',
  });
}

function toggleDrawingEnabled(input: HTMLInputElement) {
  state.drawingSettings.enabled = input.checked;
  writeDrawingEnabledPreference(input.checked);
  persistToSave();
  if (input.checked && !isImageGenerationPluginAvailable(win)) {
    showDrawingPluginMissingNotification();
  }
  render();
}

function addDrawingAnchor() {
  console.log('[addDrawingAnchor] 开始添加角色，当前数量:', state.drawingSettings.characterAnchors.length);
  updateDrawingSettingsFromControls(false);
  const newAnchor = {
    id: crypto.randomUUID(),
    name: '',
    prompt: '',
  };
  state.drawingSettings.characterAnchors = [...state.drawingSettings.characterAnchors, newAnchor];
  console.log(
    '[addDrawingAnchor] 添加完成，新数量:',
    state.drawingSettings.characterAnchors.length,
    '新角色ID:',
    newAnchor.id,
  );
  persistToSave();
  render();
}

async function generateDrawingNow() {
  updateDrawingSettingsFromControls(false);
  if (!isImageGenerationPluginAvailable(win)) {
    showDrawingPluginMissingNotification();
    return;
  }

  const settings = state.drawingSettings;
  const anchorPrompt = settings.characterAnchors
    .map(anchor => [anchor.name.trim(), anchor.prompt.trim()].filter(Boolean).join(': '))
    .filter(Boolean)
    .join(', ');
  const prompt = [
    settings.qualityPrompt.trim(),
    settings.manualPrompt.trim(),
    anchorPrompt,
    settings.systemPrompt.trim(),
  ]
    .filter(Boolean)
    .join(', ');

  if (!prompt.trim()) {
    ctx.showNotification({
      kind: 'message',
      title: '没有生图需求',
      preview: '先写一点本次生图需求。',
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
      phoneRoute: 'app:drawing',
    });
    return;
  }

  ctx.showNotification({
    kind: 'message',
    title: '正在发送给智绘姬',
    preview: '',
    targetTab: 'summary',
    timestamp: formatTime(state.statusData.world.currentTime),
    phoneRoute: 'app:drawing',
  });

  const result = await requestImageGeneration(win, prompt, settings, '', {
    summaryApiConfig: state.summaryApiConfig,
  });
  ctx.showNotification({
    kind: 'message',
    title: result.sent && !result.error ? '生图请求已发送' : '生图失败',
    preview:
      result.error ||
      (result.reason === 'image-plugin-event-api-not-available'
        ? '请先安装并启用智绘姬/生图插件。'
        : result.reason === 'timeout'
          ? '智绘姬生成较慢，请到插件图片面板查看。'
          : ''),
    targetTab: 'summary',
    timestamp: formatTime(state.statusData.world.currentTime),
    phoneRoute: 'app:drawing',
  });
}

async function generateReaderImage(messageId: string, anchorIndex: number) {
  const message = state.uiMessages.find(item => item.id === messageId);
  if (!message || message.role !== 'assistant') return;
  if (!isImageGenerationPluginAvailable(win)) {
    showDrawingPluginMissingNotification();
    return;
  }

  const imagePrompt = getImageGenerationPromptAtAnchor(message.rawText || message.text, anchorIndex);
  if (!imagePrompt) return;
  const rawText = message.rawText || message.text;
  const sceneText = extractContextReply(rawText);

  ctx.showNotification({
    kind: 'message',
    title: '正在发送给智绘姬',
    preview: '',
    targetTab: 'summary',
    timestamp: formatTime(state.statusData.world.currentTime),
  });

  const result = await requestImageGeneration(
    win,
    imagePrompt.prompt,
    state.drawingSettings,
    imagePrompt.change,
    {
      sceneText,
      rawText,
      summaryApiConfig: state.summaryApiConfig,
    },
  );

  if (result.imageData && !result.error) {
    const illustrations = message.illustrations ?? [];
    if (!illustrations.some(illustration => illustration.imageData === result.imageData)) {
      message.illustrations = [
        ...illustrations,
        {
          id: crypto.randomUUID(),
          imageData: result.imageData,
          prompt: result.prompt ?? imagePrompt.prompt,
          anchorIndex,
          rerollContext: {
            prompt: result.prompt ?? imagePrompt.prompt,
            change: imagePrompt.change,
            sceneText,
            rawText,
          },
          createdAt: Date.now(),
        },
      ];
      persistToSave();
    }
  }

  ctx.showNotification({
    kind: 'message',
    title: result.sent && !result.error ? '生图请求已发送' : '生图失败',
    preview:
      result.error ||
      (result.reason === 'timeout' ? '智绘姬生成较慢，请到插件图片面板查看。' : ''),
    targetTab: 'summary',
    timestamp: formatTime(state.statusData.world.currentTime),
  });
  render();
}

function getReaderImageRerollPrompt(messageId: string, illustrationId: string) {
  const message = state.uiMessages.find(item => item.id === messageId);
  if (!message || message.role !== 'assistant') return '';
  const illustration = message.illustrations?.find(item => item.id === illustrationId);
  if (!illustration) return '';

  const rawText = illustration.rerollContext?.rawText || message.rawText || message.text;
  const anchorIndex = Number(illustration.anchorIndex);
  const anchorPrompt = Number.isFinite(anchorIndex)
    ? getImageGenerationPromptAtAnchor(rawText, Math.max(0, Math.floor(anchorIndex)))
    : null;
  return illustration.rerollContext?.prompt || anchorPrompt?.prompt || illustration.prompt || '';
}

function openImageRerollEditor(messageId: string, illustrationId: string) {
  const prompt = getReaderImageRerollPrompt(messageId, illustrationId);
  const message = state.uiMessages.find(item => item.id === messageId);
  const illustration = message?.illustrations?.find(item => item.id === illustrationId);
  const negativePrompt = illustration?.rerollContext?.negativePrompt ?? state.drawingSettings.negativePrompt ?? '';
  state.imageRerollEditing = {
    messageId,
    illustrationId,
    prompt,
    negativePrompt,
  };
  render();
  setTimeout(() => {
    const textarea = root?.querySelector<HTMLTextAreaElement>('[data-field="image-reroll-prompt"]');
    textarea?.focus();
    if (textarea) {
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }
  }, 0);
}

function cancelImageRerollEditor() {
  if (!state.imageRerollEditing) return;
  state.imageRerollEditing = null;
  render();
}

async function saveImageRerollEditor() {
  const editing = state.imageRerollEditing;
  if (!editing) return;
  const prompt =
    root?.querySelector<HTMLTextAreaElement>('[data-field="image-reroll-prompt"]')?.value.trim() ??
    editing.prompt.trim();
  const negativePrompt =
    root?.querySelector<HTMLTextAreaElement>('[data-field="image-reroll-negative-prompt"]')?.value.trim() ??
    editing.negativePrompt.trim();
  if (!prompt) {
    ctx.showNotification({
      kind: 'message',
      title: '重 roll 提示词为空',
      preview: '请先填写这张图要发送给智绘姬的正面提示词。',
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return;
  }
  state.imageRerollEditing = null;
  render();
  await rerollReaderImage(editing.messageId, editing.illustrationId, prompt, negativePrompt);
}

async function rerollReaderImage(
  messageId: string,
  illustrationId: string,
  editedPrompt?: string,
  editedNegativePrompt?: string,
) {
  const message = state.uiMessages.find(item => item.id === messageId);
  if (!message || message.role !== 'assistant') return;
  const illustration = message.illustrations?.find(item => item.id === illustrationId);
  if (!illustration) return;
  if (!isImageGenerationPluginAvailable(win)) {
    showDrawingPluginMissingNotification();
    return;
  }

  const rawText = illustration.rerollContext?.rawText || message.rawText || message.text;
  const anchorIndex = Number(illustration.anchorIndex);
  const anchorPrompt = Number.isFinite(anchorIndex)
    ? getImageGenerationPromptAtAnchor(rawText, Math.max(0, Math.floor(anchorIndex)))
    : null;
  const prompt = editedPrompt?.trim() || illustration.rerollContext?.prompt || anchorPrompt?.prompt || illustration.prompt || '';
  const negativePrompt = editedNegativePrompt?.trim() ?? illustration.rerollContext?.negativePrompt ?? state.drawingSettings.negativePrompt ?? '';
  const change = illustration.rerollContext?.change ?? anchorPrompt?.change ?? '';
  const sceneText = illustration.rerollContext?.sceneText || extractContextReply(rawText);
  const rerollSettings = {
    ...state.drawingSettings,
    negativePrompt,
  };

  ctx.showNotification({
    kind: 'message',
    title: '正在重 roll 图片',
    preview: '',
    targetTab: 'summary',
    timestamp: formatTime(state.statusData.world.currentTime),
  });

  const result = await requestImageGeneration(win, prompt, rerollSettings, change, {
    sceneText,
    rawText,
    generationContext: illustration.rerollContext?.generationContext,
    generationWorldBook: illustration.rerollContext?.generationWorldBook,
    userInput: illustration.rerollContext?.userInput,
    summaryApiConfig: state.summaryApiConfig,
  });

  if (result.imageData && !result.error) {
    message.illustrations = (message.illustrations ?? []).map(item =>
      item.id === illustrationId
        ? {
            ...item,
            imageData: result.imageData ?? item.imageData,
            prompt: result.prompt ?? prompt,
            rerollContext: {
              prompt: result.prompt ?? prompt,
              negativePrompt,
              change,
              sceneText,
              rawText,
              generationContext: illustration.rerollContext?.generationContext,
              generationWorldBook: illustration.rerollContext?.generationWorldBook,
              userInput: illustration.rerollContext?.userInput,
            },
            createdAt: Date.now(),
          }
        : item,
    );
    persistToSave();
  }

  ctx.showNotification({
    kind: 'message',
    title: result.sent && !result.error ? '图片已重 roll' : '重 roll 失败',
    preview:
      result.error ||
      (result.reason === 'timeout' ? '智绘姬生成较慢，请到插件图片面板查看。' : ''),
    targetTab: 'summary',
    timestamp: formatTime(state.statusData.world.currentTime),
  });
  render();
}

function removeDrawingAnchor(anchorId: string) {
  updateDrawingSettingsFromControls(false);
  state.drawingSettings.characterAnchors = state.drawingSettings.characterAnchors.filter(
    anchor => anchor.id !== anchorId,
  );
  persistToSave();
  render();
}

function switchPhoneCharacter(characterId: PhoneCharacterId, bgmUrl?: string) {
  playPhoneCharacterBgm(characterId, bgmUrl);
  if (state.phoneCharacterId === characterId) return;
  state.phoneCharacterId = characterId;
  render();
}

function saveArchiveImpressionLabel(rowId: string, label: string) {
  const row = state.memoryDB.impressions.find(imp => !imp.expired && imp.id === rowId);
  const nextLabel = label.trim();
  if (!row || !nextLabel || nextLabel === row.label) return false;

  row.label = nextLabel;
  row.updatedAt = new Date().toISOString();

  const tags = new Set(row.tags ?? []);
  if (isPhoneArchiveGoldImpression(row)) {
    tags.add(PHONE_ARCHIVE_IMPRESSION_GOLD_TAG);
    tags.add(PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG);
    row.weight = Math.max(Math.abs(row.weight ?? 0), 5);
    row.importance = Math.max(row.importance ?? 0, 5);
  } else {
    tags.delete(PHONE_ARCHIVE_IMPRESSION_GOLD_TAG);
    tags.delete(PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG);
  }
  row.tags = tags.size ? [...tags] : undefined;

  persistToSave();
  return true;
}

function editArchiveImpressionLabel(button: HTMLButtonElement) {
  const rowId = button.dataset.impressionId ?? '';
  const row = state.memoryDB.impressions.find(imp => !imp.expired && imp.id === rowId);
  if (!row || button.parentElement?.querySelector('[data-field="archive-impression-edit"]')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = row.label;
  input.maxLength = 16;
  input.className = `${button.className} archive-impression-chip--editing`;
  input.dataset.field = 'archive-impression-edit';
  input.setAttribute('aria-label', '编辑印象标签');
  input.setAttribute('enterkeyhint', 'done');

  let finished = false;
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    const changed = saveArchiveImpressionLabel(rowId, save ? input.value : row.label);
    if (changed) {
      render();
      return;
    }
    input.replaceWith(button);
  };

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));

  button.replaceWith(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function openPhoneThread(targetId: string) {
  const target = state.statusData.targets.find(item => item.id === targetId);
  if (!target) return;
  if (!state.phoneMessages.threads[target.id]) {
    state.phoneMessages.threads = {
      ...state.phoneMessages.threads,
      [target.id]: {
        targetId: target.id,
        messages: [],
        unread: 0,
        updatedAt: Date.now(),
      },
    };
  }
  state.phoneMessages.activeThreadId = target.id;
  state.phoneMessages.threads[target.id].unread = 0;
  if (state.notification?.targetId === target.id) {
    state.notification = null;
  }
  persistToSave();
  navigatePhone('app:chat');
}

function deletePhoneMessage(targetId: string, messageId: string) {
  if (state.phoneMessages.generating) return;

  const thread = state.phoneMessages.threads[targetId];
  if (!thread) return;

  const nextMessages = thread.messages.filter(message => message.id !== messageId);
  if (nextMessages.length === thread.messages.length) return;

  thread.messages = nextMessages;
  thread.updatedAt = Date.now();
  if (!thread.messages.length) {
    thread.unread = 0;
  } else {
    thread.unread = Math.min(thread.unread, thread.messages.length);
  }

  state.memoryDB.phoneMessages.forEach(row => {
    if (row.messageId === messageId) {
      row.expired = true;
      row.updatedAt = new Date().toISOString();
    }
  });

  if (state.notification?.targetId === targetId) {
    state.notification = null;
  }

  persistToSave();
  render();
}

function openNotification() {
  if (!state.notification) return;
  const notification = state.notification;
  if (notification.targetId) {
    state.phoneMessages.activeThreadId = notification.targetId;
    const thread = state.phoneMessages.threads[notification.targetId];
    if (thread) thread.unread = 0;
  }
  state.notification = null;
  persistToSave();
  openPhone(notification.phoneRoute ?? getRouteForTab(notification.targetTab));
}

function readSummaryApiConfigForm(): SummaryApiConfig {
  const apiurl = root?.querySelector<HTMLInputElement>('[data-field="summary-apiurl"]')?.value.trim() ?? '';
  const key = root?.querySelector<HTMLInputElement>('[data-field="summary-key"]')?.value.trim() ?? '';
  const model = root?.querySelector<HTMLInputElement>('[data-field="summary-model"]')?.value.trim() ?? '';
  const source = root?.querySelector<HTMLInputElement>('[data-field="summary-source"]')?.value.trim() || 'openai';
  return { apiurl, key, model, source };
}

function buildSummaryModelsUrl(apiurl: string): string {
  const url = new URL(apiurl);
  const path = url.pathname.replace(/\/+$/, '');

  if (/\/models$/i.test(path)) {
    return url.toString();
  }

  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path.replace(/\/chat\/completions$/i, '/models');
    return url.toString();
  }

  if (/\/(completions|responses)$/i.test(path)) {
    url.pathname = path.replace(/\/(completions|responses)$/i, '/models');
    return url.toString();
  }

  url.pathname = path ? `${path}/models` : '/v1/models';
  return url.toString();
}

function parseSummaryModelsResponse(payload: unknown): SummaryModelOption[] {
  const rawList =
    payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray(payload)
        ? payload
        : [];
  const byId = new Map<string, SummaryModelOption>();

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { id?: unknown; name?: unknown; owned_by?: unknown; ownedBy?: unknown };
    const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
    if (!id) continue;
    const ownedBy =
      typeof item.owned_by === 'string' ? item.owned_by : typeof item.ownedBy === 'string' ? item.ownedBy : undefined;
    byId.set(id, { id, ...(ownedBy ? { ownedBy } : {}) });
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchSummaryModels() {
  if (state.summaryModelFetch.loading) return;
  const config = readSummaryApiConfigForm();

  if (!config.apiurl) {
    state.summaryModelFetch = {
      loading: false,
      models: [],
      error: 'Please fill API URL first.',
      fetchedAt: null,
    };
    render();
    return;
  }

  state.summaryApiConfig = config;
  state.summaryModelFetch = {
    ...state.summaryModelFetch,
    loading: true,
    error: null,
  };
  render();

  try {
    const response = await fetch(buildSummaryModelsUrl(config.apiurl), {
      headers: {
        ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Fetch models failed: HTTP ${response.status}`);
    }
    const models = parseSummaryModelsResponse(await response.json());
    state.summaryModelFetch = {
      loading: false,
      models,
      error: models.length ? null : 'No models found in response.',
      fetchedAt: Date.now(),
    };
  } catch (error) {
    state.summaryModelFetch = {
      loading: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: null,
    };
  }

  render();
}

// ── Reader drag ──

function bindReaderDragEvents() {
  root?.querySelectorAll<HTMLElement>('.paper-reader').forEach(reader => {
    reader.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('[data-action="jump-message"]')) return;
      if ((event.target as HTMLElement).closest('[data-action="reader-edit"]')) return;
      if ((event.target as HTMLElement).closest('[data-action="reader-actions-open"]')) return;
      if ((event.target as HTMLElement).closest('[data-action="reader-generate-image"]')) return;
      if ((event.target as HTMLElement).closest('[data-action="reader-reroll-image"]')) return;
      if ((event.target as HTMLElement).closest('[data-action="image-reroll-cancel"]')) return;
      if ((event.target as HTMLElement).closest('[data-action="image-reroll-save"]')) return;
      if ((event.target as HTMLElement).closest('[data-field="image-reroll-prompt"]')) return;
      if ((event.target as HTMLElement).closest('[data-field="image-reroll-negative-prompt"]')) return;
      if ((event.target as HTMLElement).closest('[data-action="select-option"]')) return;
      readerDragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedInBody: Boolean((event.target as HTMLElement).closest('.reader-card__body')),
        intentLocked: false,
        scrolling: false,
        moved: false,
      };
      if (!readerDragState.startedInBody) {
        reader.setPointerCapture(event.pointerId);
        readerDragState.intentLocked = true;
      }
    });

    reader.addEventListener('pointermove', event => {
      if (!readerDragState || event.pointerId !== readerDragState.pointerId) return;
      const dx = event.clientX - readerDragState.startX;
      const dy = event.clientY - readerDragState.startY;
      if (readerDragState.scrolling) return;
      if (!readerDragState.intentLocked && readerDragState.startedInBody) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
          readerDragState.scrolling = true;
          return;
        }
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          readerDragState.intentLocked = true;
          reader.setPointerCapture(event.pointerId);
        } else {
          return;
        }
      }
      if (Math.abs(dx) > 6) readerDragState.moved = true;
      if (!readerDragState.moved) return;
      const card = reader.querySelector<HTMLElement>('.reader-card');
      if (!card) return;
      const tryingDirection = dx < 0 ? 'next' : 'prev';
      const canFlip = canFlipReader(tryingDirection);
      if (!canFlip) {
        const resistedOffset = Math.sign(dx) * Math.min(Math.abs(dx), 18) * 0.18;
        card.style.transition = 'none';
        card.style.transform = `perspective(1200px) translateX(${resistedOffset}px)`;
        card.style.opacity = '1';
        return;
      }
      const progress = Math.min(Math.abs(dx) / 160, 1);
      const tilt = dx > 0 ? -6 * progress : 6 * progress;
      card.style.transition = 'none';
      card.style.transform = `perspective(1200px) translateX(${dx * 0.28}px) rotateY(${tilt}deg)`;
      card.style.opacity = String(Math.max(1 - progress * 0.32, 0.6));
    });

    const finishReaderDrag = (event: PointerEvent) => {
      if (!readerDragState || event.pointerId !== readerDragState.pointerId) return;
      if (reader.hasPointerCapture(event.pointerId)) reader.releasePointerCapture(event.pointerId);
      const dx = event.clientX - readerDragState.startX;
      const moved = readerDragState.moved;
      const scrolling = readerDragState.scrolling;
      readerDragState = null;
      if (scrolling) return;
      const THRESHOLD = 60;
      if (moved && Math.abs(dx) >= THRESHOLD) {
        if (dx < 0 && canFlipReader('next')) {
          focusMessage(1);
          return;
        }
        if (dx > 0 && canFlipReader('prev')) {
          focusMessage(-1);
          return;
        }
        resetReaderCardTransform(reader);
      } else {
        resetReaderCardTransform(reader);
      }
    };
    reader.addEventListener('pointerup', finishReaderDrag);
    reader.addEventListener('pointercancel', finishReaderDrag);
  });
}

function getTucaoFloatFlag() {
  const raw =
    typeof state.runtimeFlags.tucaoFloat === 'object' && state.runtimeFlags.tucaoFloat
      ? (state.runtimeFlags.tucaoFloat as Record<string, unknown>)
      : {};
  return {
    x: Math.max(8, Number(raw.x ?? 28) || 28),
    y: Math.max(8, Number(raw.y ?? 92) || 92),
    collapsed: Boolean(raw.collapsed),
  };
}

function setTucaoFloatFlag(next: { x?: number; y?: number; collapsed?: boolean }) {
  const current = getTucaoFloatFlag();
  state.runtimeFlags.tucaoFloat = { ...current, ...next };
}

function bindTucaoFloatEvents() {
  const panel = root?.querySelector<HTMLElement>('[data-tucao-float="true"]');
  if (!panel) return;

  root?.querySelector<HTMLButtonElement>('[data-action="toggle-tucao-float"]')?.addEventListener('click', event => {
    event.stopPropagation();
    if (tucaoSuppressNextToggleClick) {
      tucaoSuppressNextToggleClick = false;
      return;
    }
    const current = getTucaoFloatFlag();
    setTucaoFloatFlag({ collapsed: !current.collapsed });
    persistToSave();
    render();
  });

  const handle = panel.querySelector<HTMLElement>('[data-tucao-drag-handle="true"]');
  handle?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (
      (event.target as HTMLElement).closest('[data-action="toggle-tucao-float"]') &&
      !panel.classList.contains('is-collapsed')
    ) {
      return;
    }
    const current = getTucaoFloatFlag();
    tucaoDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: current.x,
      startTop: current.y,
      moved: false,
    };
    handle.setPointerCapture(event.pointerId);
  });

  handle?.addEventListener('pointermove', event => {
    if (!tucaoDragState || event.pointerId !== tucaoDragState.pointerId) return;
    const dx = event.clientX - tucaoDragState.startX;
    const dy = event.clientY - tucaoDragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) tucaoDragState.moved = true;
    const width = panel.offsetWidth || 300;
    const height = panel.offsetHeight || 44;
    const nextX = clamp(tucaoDragState.startLeft + dx, 8, Math.max(8, window.innerWidth - width - 8));
    const nextY = clamp(tucaoDragState.startTop + dy, 8, Math.max(8, window.innerHeight - height - 8));
    panel.style.left = `${nextX}px`;
    panel.style.top = `${nextY}px`;
  });

  const finishDrag = (event: PointerEvent) => {
    if (!tucaoDragState || event.pointerId !== tucaoDragState.pointerId) return;
    if (handle?.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    const width = panel.offsetWidth || 300;
    const height = panel.offsetHeight || 44;
    const nextX = clamp(
      tucaoDragState.startLeft + event.clientX - tucaoDragState.startX,
      8,
      Math.max(8, window.innerWidth - width - 8),
    );
    const nextY = clamp(
      tucaoDragState.startTop + event.clientY - tucaoDragState.startY,
      8,
      Math.max(8, window.innerHeight - height - 8),
    );
    if (!tucaoDragState.moved && panel.classList.contains('is-collapsed')) {
      tucaoSuppressNextToggleClick = true;
      setTucaoFloatFlag({ collapsed: false });
      tucaoDragState = null;
      persistToSave();
      render();
      return;
    }
    tucaoSuppressNextToggleClick = tucaoDragState.moved;
    setTucaoFloatFlag({ x: nextX, y: nextY });
    tucaoDragState = null;
    persistToSave();
  };

  handle?.addEventListener('pointerup', finishDrag);
  handle?.addEventListener('pointercancel', finishDrag);
}

// ── Context menu ──

function bindReaderContextMenuEvents() {
  root?.querySelectorAll<HTMLElement>('.reader-card').forEach(card => {
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      const readerCard = event.currentTarget as HTMLElement;
      openReaderContextMenu(
        Number(readerCard.dataset.readerIndex ?? state.focusedMessageIndex),
        event.clientX,
        event.clientY,
        readerCard.dataset.readerId,
      );
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="jump-message"]').forEach(button => {
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      openReaderContextMenu(Number(button.dataset.index ?? 0), event.clientX, event.clientY, button.dataset.readerId);
    });
  });
}

// ── Event binding ──

function bindEvents() {
  bindQuickReplyDelegation();

  root?.querySelectorAll<HTMLButtonElement>('[data-action="select-option"]').forEach(button => {
    button.addEventListener('pointerdown', event => {
      event.stopPropagation();
    });
  });

  root?.querySelectorAll<HTMLTextAreaElement>('.composer-input').forEach(textarea => {
    textarea.addEventListener('input', event => {
      state.draft = (event.target as HTMLTextAreaElement).value;
      root?.querySelectorAll<HTMLTextAreaElement>('.composer-input').forEach(other => {
        if (other !== event.target) other.value = state.draft;
      });
    });

    textarea.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void submitMessage(ctx);
      }
    });
  });

  root?.querySelectorAll<HTMLTextAreaElement>('.phone-chat-input').forEach(textarea => {
    textarea.addEventListener('input', event => {
      state.phoneMessages.draft = (event.target as HTMLTextAreaElement).value;
    });
    textarea.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        const targetId = state.phoneMessages.activeThreadId;
        if (targetId) void submitPhoneMessage(ctx, targetId);
      }
    });
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.tab as TabKey));
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-phone-route]').forEach(button => {
    button.addEventListener('click', () => navigatePhone(button.dataset.phoneRoute as PhoneRoute));
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="switch-phone-character"]').forEach(button => {
    button.addEventListener('click', () => {
      const characterId = button.dataset.characterId as PhoneCharacterId | undefined;
      if (characterId) switchPhoneCharacter(characterId, button.dataset.bgmUrl);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="archive-edit-impression"]').forEach(button => {
    button.addEventListener('click', () => {
      editArchiveImpressionLabel(button);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="open-phone-thread"]').forEach(button => {
    button.addEventListener('click', () => {
      const targetId = button.dataset.targetId;
      if (targetId) openPhoneThread(targetId);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="send-phone-message"]').forEach(button => {
    button.addEventListener('click', () => {
      const targetId = button.dataset.targetId ?? state.phoneMessages.activeThreadId;
      if (targetId) void submitPhoneMessage(ctx, targetId);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="delete-phone-message"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const targetId = button.dataset.targetId;
      const messageId = button.dataset.messageId;
      if (targetId && messageId) deletePhoneMessage(targetId, messageId);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="phone-back"]').forEach(button => {
    button.addEventListener('click', () => navigatePhoneBack());
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="focus-message"]').forEach(button => {
    button.addEventListener('click', () => focusMessage(Number(button.dataset.direction ?? 0)));
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="jump-message"]').forEach(button => {
    button.addEventListener('click', () => jumpMessage(Number(button.dataset.index ?? 0)));
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="toggle-paper-fullscreen"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      togglePaperWorkspaceFullscreen(state);
      render();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="jump-to-composer"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      jumpToComposer(button);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="jump-to-paper-top"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      jumpToPaperTop(button);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="reader-edit"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      openReaderEditor(Number(button.dataset.readerIndex ?? state.focusedMessageIndex), button.dataset.readerId);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="reader-actions-open"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const rect = button.getBoundingClientRect();
      openReaderContextMenu(
        Number(button.dataset.readerIndex ?? state.focusedMessageIndex),
        rect.left,
        rect.bottom + READER_CONTEXT_MENU_GAP,
        button.dataset.readerId,
      );
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="reader-generate-image"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const messageId = button.dataset.messageId;
      const anchorIndex = Number(button.dataset.anchorIndex);
      if (messageId && Number.isFinite(anchorIndex)) void generateReaderImage(messageId, anchorIndex);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="reader-reroll-image"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const messageId = button.dataset.messageId;
      const illustrationId = button.dataset.illustrationId;
      if (messageId && illustrationId) openImageRerollEditor(messageId, illustrationId);
    });
  });
  root?.querySelectorAll<HTMLElement>('[data-action="image-reroll-cancel"]').forEach(element => {
    element.addEventListener('click', event => {
      event.stopPropagation();
      cancelImageRerollEditor();
    });
  });
  root?.querySelector<HTMLButtonElement>('[data-action="image-reroll-save"]')?.addEventListener('click', event => {
    event.stopPropagation();
    void saveImageRerollEditor();
  });
  root?.querySelector<HTMLTextAreaElement>('[data-field="image-reroll-prompt"]')?.addEventListener('input', event => {
    if (state.imageRerollEditing) {
      state.imageRerollEditing.prompt = (event.target as HTMLTextAreaElement).value;
    }
  });
  root?.querySelector<HTMLTextAreaElement>('[data-field="image-reroll-negative-prompt"]')?.addEventListener('input', event => {
    if (state.imageRerollEditing) {
      state.imageRerollEditing.negativePrompt = (event.target as HTMLTextAreaElement).value;
    }
  });
  root?.querySelectorAll<HTMLElement>('[data-action="reader-edit-cancel"]').forEach(element => {
    element.addEventListener('click', event => {
      event.stopPropagation();
      cancelReaderEditor();
    });
  });
  root?.querySelector<HTMLButtonElement>('[data-action="reader-edit-save"]')?.addEventListener('click', () => {
    void saveReaderEditor();
  });
  root?.querySelector<HTMLTextAreaElement>('[data-field="reader-edit-draft"]')?.addEventListener('input', event => {
    if (state.readerEditing) {
      state.readerEditing.draft = (event.target as HTMLTextAreaElement).value;
    }
  });

  root?.querySelector<HTMLButtonElement>('[data-action="reader-rollback"]')?.addEventListener('click', () => {
    if (!state.readerContextMenu) return;
    void rollbackToReaderInput(state.readerContextMenu.readerIndex);
  });
  root?.querySelector<HTMLButtonElement>('[data-action="reader-regenerate"]')?.addEventListener('click', () => {
    if (!state.readerContextMenu) return;
    void regenerateReaderMessage(state.readerContextMenu.readerIndex);
  });
  root?.querySelector<HTMLButtonElement>('[data-action="reader-delete"]')?.addEventListener('click', () => {
    if (!state.readerContextMenu) return;
    void deleteReaderFloor(state.readerContextMenu.readerIndex);
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="close-phone"]').forEach(button => {
    button.addEventListener('click', () => closePhone());
  });
  // 日历月份切换
  root?.querySelector<HTMLButtonElement>('[data-action="calendar-prev"]')?.addEventListener('click', () => {
    setCalendarMonthOffset(getCalendarMonthOffset() - 1);
    render();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="calendar-next"]')?.addEventListener('click', () => {
    setCalendarMonthOffset(getCalendarMonthOffset() + 1);
    render();
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="calendar-select-date"]').forEach(button => {
    button.addEventListener('click', () => {
      setCalendarSelectedDate(button.dataset.date || null);
      render();
    });
  });

  // ── Music events ──
  // 搜索表单：阻止默认提交，读输入框值后异步搜索。
  root?.querySelector<HTMLFormElement>('[data-action="music-search-submit"]')?.addEventListener('submit', event => {
    event.preventDefault();
    const input = root?.querySelector<HTMLInputElement>('[data-field="music-search"]');
    void submitMusicSearch(input?.value ?? '');
  });
  // 输入框值同步进 state，避免 render 后丢失光标位置时丢字。
  root?.querySelector<HTMLInputElement>('[data-field="music-search"]')?.addEventListener('input', event => {
    state.musicPlayer.search.query = (event.target as HTMLInputElement).value;
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="music-quick-search"]').forEach(button => {
    button.addEventListener('click', () => {
      const characterId = button.dataset.characterId as PhoneCharacterId | undefined;
      if (isPhoneThemeCharacterId(characterId)) quickSearchCharacterSong(characterId);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="music-play-track"]').forEach(button => {
    button.addEventListener('click', () => {
      const trackId = button.dataset.trackId;
      const track = state.musicPlayer.search.results.find(t => t.id === trackId);
      if (track) void playMusicTrack(track);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="music-toggle-play"]').forEach(button => {
    button.addEventListener('click', () => toggleMusicPlayPause());
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="music-next"]').forEach(button => {
    button.addEventListener('click', () => void playNextSearchTrack());
  });

  root
    ?.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >('[data-field^="deepseek-fan-"]')
    .forEach(input => {
      input.addEventListener('input', () => syncDeepSeekFanForm(false));
      input.addEventListener('change', () => syncDeepSeekFanForm(false));
    });
  root?.querySelector<HTMLButtonElement>('[data-action="deepseek-fan-search"]')?.addEventListener('click', () => {
    void runDeepSeekFanSearch();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="deepseek-fan-generate"]')?.addEventListener('click', () => {
    void generateDeepSeekFanProfile();
  });
  root?.querySelector<HTMLInputElement>('[data-field="deepseek-web-enabled"]')?.addEventListener('change', event => {
    setDeepSeekWebLookupEnabled((event.target as HTMLInputElement).checked);
  });
  root
    ?.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      '[data-field="deepseek-web-search-source"], [data-field="deepseek-web-ddg-region"], [data-field="deepseek-web-timeout"], [data-field="deepseek-web-max-results"]',
    )
    .forEach(input => {
      input.addEventListener('input', () => updateDeepSeekWebLookupSettingsFromControls(false));
      input.addEventListener('change', () => updateDeepSeekWebLookupSettingsFromControls(false));
    });

  root
    ?.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >('[data-field="drawing-quality-prompt"], [data-field="drawing-negative-prompt"], [data-field="drawing-system-prompt"], [data-field="drawing-anchor-name"], [data-field="drawing-anchor-prompt"]')
    .forEach(input => {
      input.addEventListener('input', () => updateDrawingSettingsFromControls(false));
      input.addEventListener('change', () => updateDrawingSettingsFromControls(true));
    });
  root?.querySelector<HTMLInputElement>('[data-field="drawing-enabled"]')?.addEventListener('change', event => {
    toggleDrawingEnabled(event.target as HTMLInputElement);
  });
  root?.querySelector<HTMLInputElement>('[data-field="drawing-context-count"]')?.addEventListener('input', event => {
    updateDrawingSettingsFromControls(false);
    const input = event.target as HTMLInputElement;
    const label = root?.querySelector<HTMLLabelElement>('label[for="drawing-context-count"]');
    if (label) label.textContent = `生图上下文层数: ${input.value}`;
  });
  root?.querySelector<HTMLInputElement>('[data-field="drawing-context-count"]')?.addEventListener('change', () => {
    updateDrawingSettingsFromControls(true);
  });
  root
    ?.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >('[data-field="drawing-manual-prompt"], [data-field="drawing-width"], [data-field="drawing-height"]')
    .forEach(input => {
      input.addEventListener('input', () => updateDrawingSettingsFromControls(false));
      input.addEventListener('change', () => updateDrawingSettingsFromControls(true));
    });
  root?.querySelector<HTMLButtonElement>('[data-action="drawing-generate-now"]')?.addEventListener('click', () => {
    void generateDrawingNow();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="drawing-add-anchor"]')?.addEventListener('click', () => {
    addDrawingAnchor();
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="drawing-remove-anchor"]').forEach(button => {
    button.addEventListener('click', () => {
      const anchorId = button.dataset.anchorId;
      if (anchorId) removeDrawingAnchor(anchorId);
    });
  });

  // 进度条 seek：mousedown/touchstart 期间 timeupdate 不再写回 slider 值，避免抢手感。
  root?.querySelectorAll<HTMLInputElement>('[data-action="music-seek"]').forEach(slider => {
    const onPointerDown = () => {
      seekDragging = true;
    };
    const onPointerUp = () => {
      if (!seekDragging) return;
      seekDragging = false;
      const v = Number(slider.value);
      if (phoneBgmAudio && Number.isFinite(v)) {
        phoneBgmAudio.currentTime = v;
        state.musicPlayer.currentTime = v;
      }
    };
    slider.addEventListener('pointerdown', onPointerDown);
    slider.addEventListener('pointerup', onPointerUp);
    slider.addEventListener('pointercancel', onPointerUp);
    // 拖动过程实时刷新左侧时间数字，提供反馈。
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      const cur = root?.querySelector<HTMLElement>('[data-music-current-time]');
      if (cur && Number.isFinite(v)) cur.textContent = formatPlaybackTime(v);
    });
    // 键盘（左右箭头）也走 change，保证无指针环境下能 seek。
    slider.addEventListener('change', () => {
      if (seekDragging) return;
      const v = Number(slider.value);
      if (phoneBgmAudio && Number.isFinite(v)) {
        phoneBgmAudio.currentTime = v;
        state.musicPlayer.currentTime = v;
      }
    });
  });

  // ── Memory editor events ──
  function renderMemoryKeepScroll() {
    const scrollEl = root?.querySelector<HTMLElement>('.memory-phone-scroll');
    const scrollTop = scrollEl?.scrollTop ?? 0;
    render();
    requestAnimationFrame(() => {
      const scrollEl = root?.querySelector<HTMLElement>('.memory-phone-scroll');
      if (scrollEl) scrollEl.scrollTop = scrollTop;
    });
  }

  // ── Memory config events ──
  root?.querySelector('[data-action="memory-config-save"]')?.addEventListener('click', () => {
    const getInjectionValue = (field: string) =>
      root?.querySelector<HTMLInputElement>(`[data-injection-field="${field}"]`);
    const getTriggerValue = (field: string) => root?.querySelector<HTMLInputElement>(`[data-trigger-field="${field}"]`);

    const { saveFullMemoryConfig } = require('./memory-config');
    saveFullMemoryConfig({
      injection: {
        tokenBudget: parseInt(getInjectionValue('tokenBudget')?.value ?? '15000'),
        minorWindowSize: parseInt(getInjectionValue('minorWindowSize')?.value ?? '8'),
        majorWindowSize: parseInt(getInjectionValue('majorWindowSize')?.value ?? '5'),
        includeFacts: getInjectionValue('includeFacts')?.checked ?? true,
        includeTasks: getInjectionValue('includeTasks')?.checked ?? true,
        includeSecrets: getInjectionValue('includeSecrets')?.checked ?? true,
        includeImpressions: getInjectionValue('includeImpressions')?.checked ?? true,
        includeItems: getInjectionValue('includeItems')?.checked ?? true,
        onlyPromptRelevantItems: getInjectionValue('onlyPromptRelevantItems')?.checked ?? true,
      },
      summaryTrigger: {
        minorThreshold: parseInt(getTriggerValue('minorThreshold')?.value ?? '5'),
        majorThreshold: parseInt(getTriggerValue('majorThreshold')?.value ?? '4'),
        globalThreshold: parseInt(getTriggerValue('globalThreshold')?.value ?? '4'),
      },
    });

    alert('记忆配置已保存');
    render();
  });

  root?.querySelector('[data-action="memory-config-reset"]')?.addEventListener('click', () => {
    if (confirm('确定要重置为默认配置吗？')) {
      resetMemoryConfig();
      alert('已重置为默认配置');
      render();
    }
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-open-table"]').forEach(button => {
    button.addEventListener('click', () => {
      state.memoryEditor.selectedTable = (button.dataset.table ?? 'facts') as MemoryTableName;
      state.memoryEditor.selectedCategory = null;
      state.memoryEditor.expandedRowId = null;
      state.memoryEditor.editingRowId = null;
      state.memoryEditor.creating = false;
      state.memoryEditor.error = null;
      render();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-open-category"]').forEach(button => {
    button.addEventListener('click', () => {
      state.memoryEditor.selectedTable = null;
      state.memoryEditor.selectedCategory = button.dataset.category ?? '';
      state.memoryEditor.expandedRowId = null;
      state.memoryEditor.editingRowId = null;
      state.memoryEditor.creating = false;
      state.memoryEditor.error = null;
      render();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-back-to-home"]').forEach(button => {
    button.addEventListener('click', () => {
      state.memoryEditor.selectedTable = null;
      state.memoryEditor.selectedCategory = null;
      state.memoryEditor.expandedRowId = null;
      state.memoryEditor.editingRowId = null;
      state.memoryEditor.creating = false;
      state.memoryEditor.error = null;
      render();
    });
  });
  root?.querySelector<HTMLButtonElement>('[data-action="memory-open-trash"]')?.addEventListener('click', () => {
    state.memoryEditor.selectedTable = '__trash';
    state.memoryEditor.selectedCategory = null;
    state.memoryEditor.expandedRowId = null;
    state.memoryEditor.editingRowId = null;
    state.memoryEditor.error = null;
    render();
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-toggle-row"]').forEach(button => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId ?? '';
      state.memoryEditor.expandedRowId = state.memoryEditor.expandedRowId === rowId ? null : rowId;
      state.memoryEditor.editingRowId = null;
      state.memoryEditor.error = null;
      renderMemoryKeepScroll();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-edit-row"]').forEach(button => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId ?? '';
      const table = (button.dataset.table ?? state.memoryEditor.selectedTable) as MemoryTableName;
      const rows = (state.memoryDB as unknown as Record<string, unknown[]>)[table];
      const row = Array.isArray(rows) ? rows.find((r: any) => r.id === rowId) : null;
      state.memoryEditor.editingRowId = rowId;
      state.memoryEditor.editingDraft = row ? createMemoryDraft(table, row as any) : '';
      state.memoryEditor.error = null;
      renderMemoryKeepScroll();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-save-edit"]').forEach(button => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId ?? '';
      const table = (button.dataset.table ?? state.memoryEditor.selectedTable) as MemoryTableName;
      try {
        const patch = createMemoryPatchFromDraft(table, state.memoryEditor.editingDraft);
        updateMemoryRow(state.memoryDB, table, rowId, patch);
        state.memoryEditor.editingRowId = null;
        state.memoryEditor.error = null;
        persistToSave();
      } catch (e) {
        state.memoryEditor.error = e instanceof Error ? e.message : String(e);
      }
      renderMemoryKeepScroll();
    });
  });
  root?.querySelectorAll<HTMLElement>('[data-action="memory-cancel-edit"]').forEach(el => {
    el.addEventListener('click', () => {
      state.memoryEditor.editingRowId = null;
      state.memoryEditor.error = null;
      renderMemoryKeepScroll();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-expire-row"]').forEach(button => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId ?? '';
      const table = (button.dataset.table ?? state.memoryEditor.selectedTable) as MemoryTableName;
      const row = table === 'items' ? state.memoryDB.items.find(item => item.id === rowId) : null;
      const expired = expireMemoryRow(state.memoryDB, table, rowId);
      if (expired && row?.name) delete state.statusData.player.inventory[row.name];
      persistToSave();
      renderMemoryKeepScroll();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-restore-row"]').forEach(button => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId ?? '';
      const table = (button.dataset.table ?? state.memoryEditor.selectedTable) as MemoryTableName;
      const row = table === 'items' ? state.memoryDB.items.find(item => item.id === rowId) : null;
      const restored = restoreMemoryRow(state.memoryDB, table, rowId);
      if (restored && row?.name) {
        state.statusData.player.inventory[row.name] = {
          description: row.state || state.statusData.player.inventory[row.name]?.description || '暂无描述',
          count: row.count ?? 1,
        };
      }
      persistToSave();
      renderMemoryKeepScroll();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-toggle-item-lock"]').forEach(button => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId ?? '';
      const item = state.memoryDB.items.find(row => row.id === rowId);
      if (!item) return;
      updateMemoryRow(state.memoryDB, 'items', rowId, { locked: !item.locked });
      state.memoryEditor.error = null;
      persistToSave();
      renderMemoryKeepScroll();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-toggle-item-prompt"]').forEach(button => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId ?? '';
      const item = state.memoryDB.items.find(row => row.id === rowId);
      if (!item) return;
      updateMemoryRow(state.memoryDB, 'items', rowId, { promptRelevant: !item.promptRelevant });
      state.memoryEditor.error = null;
      persistToSave();
      renderMemoryKeepScroll();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="memory-delete-row"]').forEach(button => {
    button.addEventListener('click', () => {
      const rowId = button.dataset.rowId ?? '';
      const table = (button.dataset.table ?? state.memoryEditor.selectedTable) as MemoryTableName;
      if (!rowId) return;
      const row = table === 'items' ? state.memoryDB.items.find(item => item.id === rowId) : null;
      const deleted = deleteMemoryRow(state.memoryDB, table, rowId);
      if (deleted && row?.name) delete state.statusData.player.inventory[row.name];
      state.memoryEditor.expandedRowId = null;
      state.memoryEditor.editingRowId = null;
      state.memoryEditor.error = null;
      persistToSave();
      renderMemoryKeepScroll();
    });
  });
  root?.querySelector<HTMLButtonElement>('[data-action="memory-delete-all-expired"]')?.addEventListener('click', () => {
    if (!confirm('确定要永久删除回收站里的全部记录吗？此操作不可撤销。')) return;
    const expiredItemNames = state.memoryDB.items
      .filter(item => item.expired)
      .map(item => item.name)
      .filter(Boolean);
    const deleted = deleteAllExpiredMemoryRows(state.memoryDB);
    if (!deleted) return;
    for (const name of expiredItemNames) delete state.statusData.player.inventory[name];
    state.memoryEditor.expandedRowId = null;
    state.memoryEditor.editingRowId = null;
    state.memoryEditor.error = null;
    persistToSave();
    renderMemoryKeepScroll();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="memory-expire-all-unlocked-items"]')?.addEventListener('click', () => {
    if (!confirm('确定要删除全部未锁定物品吗？锁定物品会保留。')) return;
    const names = state.memoryDB.items
      .filter(item => !item.expired && !item.locked)
      .map(item => item.name)
      .filter(Boolean);
    const expired = expireAllUnlockedItems(state.memoryDB);
    if (!expired) return;
    for (const name of names) delete state.statusData.player.inventory[name];
    state.memoryEditor.expandedRowId = null;
    state.memoryEditor.editingRowId = null;
    state.memoryEditor.error = null;
    persistToSave();
    renderMemoryKeepScroll();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="memory-new-row"]')?.addEventListener('click', () => {
    state.memoryEditor.creating = true;
    state.memoryEditor.creatingDraft = '';
    state.memoryEditor.error = null;
    renderMemoryKeepScroll();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="memory-save-new"]')?.addEventListener('click', () => {
    try {
      const newId = insertMemoryRow(
        state.memoryDB,
        'facts',
        {
          ...createUserEventMemoryPayload(state.memoryEditor.creatingDraft),
          gameTime: state.statusData.world.currentTime,
          extra: { location: state.statusData.world.currentLocation },
        },
      );
      if (!newId) throw new Error('写入失败');
      state.memoryEditor.creating = false;
      state.memoryEditor.creatingDraft = '';
      state.memoryEditor.expandedRowId = newId;
      state.memoryEditor.error = null;
      persistToSave();
    } catch (e) {
      state.memoryEditor.error = e instanceof Error ? e.message : String(e);
    }
    renderMemoryKeepScroll();
  });
  root?.querySelectorAll<HTMLElement>('[data-action="memory-cancel-new"]').forEach(el => {
    el.addEventListener('click', () => {
      state.memoryEditor.creating = false;
      state.memoryEditor.error = null;
      renderMemoryKeepScroll();
    });
  });
  root?.querySelector<HTMLTextAreaElement>('[data-field="memory-edit-draft"]')?.addEventListener('input', event => {
    state.memoryEditor.editingDraft = (event.target as HTMLTextAreaElement).value;
  });
  root?.querySelector<HTMLTextAreaElement>('[data-field="memory-new-draft"]')?.addEventListener('input', event => {
    state.memoryEditor.creatingDraft = (event.target as HTMLTextAreaElement).value;
  });

  root?.querySelector<HTMLButtonElement>('[data-action="return-to-title"]')?.addEventListener('click', () => {
    returnToTitle();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="manual-save"]')?.addEventListener('click', async () => {
    await persistManualSave();
    render();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="export-save"]')?.addEventListener('click', () => {
    persistToSave();
    if (!state.activeSaveId) {
      window.alert('当前没有可导出的存档。');
      return;
    }
    downloadSaveBackup(state.activeSaveId);
  });
  const importFileInput = root?.querySelector<HTMLInputElement>('[data-field="import-saves-file"]') ?? null;
  root?.querySelector<HTMLButtonElement>('[data-action="import-saves"]')?.addEventListener('click', () => {
    importFileInput?.click();
  });
  importFileInput?.addEventListener('change', async () => {
    const file = importFileInput.files?.[0];
    if (!file) return;
    const ok = window.confirm('导入会覆盖当前 localStorage 里同名存档键，确认继续？');
    if (!ok) {
      importFileInput.value = '';
      return;
    }
    try {
      const text = new TextDecoder('utf-8').decode(await file.arrayBuffer());
      const result = importAllSavesFromJson(text);
      // 等待 IndexedDB 写入全部落盘后再刷新，否则异步写入可能丢失。
      await flushSaveStore();
      window.alert(`导入完成：成功 ${result.imported} 条，跳过 ${result.skipped} 条。即将刷新页面。`);
      location.reload();
    } catch (error) {
      window.alert(`导入失败：${(error as Error).message}`);
    } finally {
      importFileInput.value = '';
    }
  });
  root
    ?.querySelectorAll<HTMLButtonElement>(
      '[data-action="save-player-profile"], [data-action="save-player-profile-edit"]',
    )
    .forEach(button => {
      button.addEventListener('click', () => {
        savePlayerProfileFromStatusPanel();
      });
    });
  root?.querySelector<HTMLButtonElement>('[data-action="edit-player-profile"]')?.addEventListener('click', () => {
    setPlayerProfileEditing(true);
  });
  root
    ?.querySelector<HTMLButtonElement>('[data-action="cancel-player-profile-edit"]')
    ?.addEventListener('click', () => {
      setPlayerProfileEditing(false);
    });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="send"]').forEach(button =>
    button.addEventListener('click', () => {
      if (state.generating) {
        cancelCurrentGeneration(ctx);
        return;
      }
      void submitMessage(ctx);
    }),
  );
  root
    ?.querySelector<HTMLButtonElement>('[data-action="open-notification"]')
    ?.addEventListener('click', () => openNotification());
  root?.querySelectorAll<HTMLButtonElement>('[data-action="retry-background-task"]').forEach(button => {
    button.addEventListener('click', () => {
      const kind = button.dataset.taskKind;
      if (kind === 'progress') {
        void retryBackgroundProgressUpdate(ctx);
      } else if (kind === 'summary') {
        clearBackgroundTask(state, 'summary');
        state.summaryStore.lastError = null;
        state.summaryStore.consecutiveFailures = 0;
        triggerSummary('auto');
      }
    });
  });

  // 摘要操作。
  function triggerSummary(mode: 'auto' | 'minor' | 'major' | 'global') {
    if (state.summarizing) return;
    state.summarizing = true;
    render();
    void runSummaryChain(mode);
  }

  // 一键补救：
  // - 'minor'：循环跑到 pending < 5（吞掉所有未总结对话）
  // - 'major'：循环跑到待大总结的小总结 < 4（消化所有尚未被大总结覆盖的小总结）
  // - 'global'：强制跑一次全局摘要（必要时会先补大摘要）
  // - 'auto'：单次（保留 runSummary 内部的 auto 级联逻辑）
  async function runSummaryChain(mode: 'auto' | 'minor' | 'major' | 'global') {
    const ctxArg = {
      win,
      state,
      summaryStore: state.summaryStore,
      summaryApiConfig: state.summaryApiConfig,
      uiMessages: state.uiMessages,
      onTaskUpdated: () => render(),
      onStoreUpdated: () => {
        persistToSave();
        render();
      },
      memoryDB: state.memoryDB,
      getFactAnchor: () => buildFactAnchorFromStatus(state.statusData),
    };
    try {
    // 在开始摘要前，先运行一次自动修复，清理遗留问题
    try {
      const repairResult = repairSummaryStore(state.summaryStore, state.uiMessages, {
        removeOrphanedMinors: false,
        fixLastSummarizedIndex: true,
        removeOverlapping: true,
      });
      if (repairResult.fixed) {
        console.log('[summary] 自动修复完成:', repairResult.changes);
        persistToSave();
      }
    } catch (error) {
      console.warn('[summary] 自动修复失败:', error);
    }

      const result = await runSummary(ctxArg, mode);
      if (mode === 'minor') {
        let safety = 20;
        while (safety-- > 0) {
          if (countPendingConversations() < 5) break;
          if (state.summaryStore.autoPaused) break;
          await runSummary(ctxArg, 'minor');
        }
      } else if (mode === 'major') {
        let safety = 10;
        while (safety-- > 0) {
          if (!state.summaryStore.minor.length) break;
          if (state.summaryStore.autoPaused) break;
          const beforeMajorCount = state.summaryStore.major.length;
          await runSummary(ctxArg, 'major');
          if (state.summaryStore.major.length === beforeMajorCount) break;
          if (countUnmergedMinorSummaries() < 4) break;
        }
      } else if (mode === 'global') {
        await runSummary(ctxArg, 'global');
      }
      void result;
    } catch (err) {
      console.warn('[triggerSummary] failed:', err);
    } finally {
      state.summarizing = false;
      render();
    }
  }

  function countPendingConversations() {
    const total = state.uiMessages.filter(m => !m.streaming && (m.role === 'user' || m.role === 'assistant')).length;
    return Math.max(0, total - state.summaryStore.lastSummarizedIndex);
  }

  function countUnmergedMinorSummaries() {
    const rangeContains = (outer: [number, number], inner: [number, number]) =>
      inner[0] >= outer[0] && inner[1] <= outer[1];
    return state.summaryStore.minor.filter(
      minor => !state.summaryStore.major.some(major => rangeContains(major.range, minor.range)),
    ).length;
  }

  root
    ?.querySelectorAll<HTMLButtonElement>('[data-action="summary-minor"]')
    .forEach(button => button.addEventListener('click', () => triggerSummary('minor')));
  root
    ?.querySelectorAll<HTMLButtonElement>('[data-action="summary-major"]')
    .forEach(button => button.addEventListener('click', () => triggerSummary('major')));
  root
    ?.querySelectorAll<HTMLButtonElement>('[data-action="summary-global"]')
    .forEach(button => button.addEventListener('click', () => triggerSummary('global')));
  root?.querySelectorAll<HTMLButtonElement>('[data-action="summary-reroll"]').forEach(button => {
    button.addEventListener('click', () => {
      // 触发骰子翻滚动画
      button.classList.add('is-rolling');
      button.addEventListener('animationend', () => button.classList.remove('is-rolling'), { once: true });

      const level = button.dataset.rerollLevel as 'minor' | 'major';
      const index = parseInt(button.dataset.rerollIndex ?? '', 10);
      if (!level || isNaN(index)) return;
      if (state.summarizing) return;
      state.summarizing = true;
      render();
      rerollSummaryEntry(
        {
          win,
          state,
          summaryStore: state.summaryStore,
          summaryApiConfig: state.summaryApiConfig,
          uiMessages: state.uiMessages,
          onTaskUpdated: () => render(),
          onStoreUpdated: () => {
            persistToSave();
            state.summarizing = false;
            render();
          },
          memoryDB: state.memoryDB,
          getFactAnchor: () => buildFactAnchorFromStatus(state.statusData),
        },
        level,
        index,
      ).catch(() => {
        state.summarizing = false;
        render();
      });
    });
  });

  // 摘要编辑功能
  root?.querySelectorAll<HTMLButtonElement>('[data-action="summary-edit"]').forEach(button => {
    button.addEventListener('click', () => {
      const card = button.closest<HTMLElement>('[data-summary-card]');
      if (!card) return;
      root?.querySelectorAll<HTMLElement>('[data-summary-card].is-editing').forEach(openCard => {
        if (openCard !== card) openCard.classList.remove('is-editing');
      });
      card.classList.add('is-editing');
      const field = card.querySelector<HTMLTextAreaElement>('[data-field="summary-edit-text"]');
      if (!field) return;
      requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      });
    });
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="summary-cancel-edit"]').forEach(button => {
    button.addEventListener('click', () => {
      const card = button.closest<HTMLElement>('[data-summary-card]');
      const field = card?.querySelector<HTMLTextAreaElement>('[data-field="summary-edit-text"]');
      const original = card?.querySelector<HTMLElement>('.summary-edit-card__text')?.textContent ?? '';
      if (field) field.value = original;
      card?.classList.remove('is-editing');
    });
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="summary-save-edit"]').forEach(button => {
    button.addEventListener('click', () => {
      const level = button.dataset.editLevel as 'global' | 'minor' | 'major';
      const index = button.dataset.editIndex ? parseInt(button.dataset.editIndex, 10) : -1;
      const card = button.closest<HTMLElement>('[data-summary-card]');
      const field = card?.querySelector<HTMLTextAreaElement>('[data-field="summary-edit-text"]');
      const newText = field?.value.trim() ?? '';

      if (level === 'global') {
        state.summaryStore.global = newText || null;
        updateSummaryTextInMemoryDB(state.memoryDB, 'global', state.summaryStore.global, [
          0,
          Math.max(0, state.summaryStore.lastSummarizedIndex),
        ]);
      } else if (level === 'major' && index >= 0 && index < state.summaryStore.major.length) {
        state.summaryStore.major[index].text = newText;
        updateSummaryTextInMemoryDB(state.memoryDB, 'major', newText, state.summaryStore.major[index].range);
      } else if (level === 'minor' && index >= 0 && index < state.summaryStore.minor.length) {
        state.summaryStore.minor[index].text = newText;
        updateSummaryTextInMemoryDB(state.memoryDB, 'minor', newText, state.summaryStore.minor[index].range);
      } else {
        return;
      }

      persistToSave();
      render();
    });
  });

  root?.querySelector<HTMLButtonElement>('[data-action="summary-retry"]')?.addEventListener('click', () => {
    state.summaryStore.lastError = null;
    state.summaryStore.consecutiveFailures = 0;
    triggerSummary('auto');
  });
  root?.querySelector<HTMLButtonElement>('[data-action="summary-resume"]')?.addEventListener('click', () => {
    resumeAutoSummary(state.summaryStore);
    persistToSave();
    render();
  });
  root?.querySelector<HTMLInputElement>('[data-action="summary-toggle-custom"]')?.addEventListener('change', event => {
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) {
      state.summaryApiConfig = { apiurl: '', key: '', model: '', source: 'openai' };
    } else {
      state.summaryApiConfig = null;
      state.summaryModelFetch = { loading: false, models: [], error: null, fetchedAt: null };
      saveSummaryApiConfig(null);
    }
    render();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="summary-fetch-models"]')?.addEventListener('click', () => {
    void fetchSummaryModels();
  });
  root?.querySelector<HTMLSelectElement>('[data-field="summary-model-select"]')?.addEventListener('change', event => {
    const model = (event.target as HTMLSelectElement).value;
    const input = root?.querySelector<HTMLInputElement>('[data-field="summary-model"]');
    if (input && model) input.value = model;
  });
  root?.querySelector<HTMLButtonElement>('[data-action="summary-save-config"]')?.addEventListener('click', () => {
    const config = readSummaryApiConfigForm();
    state.summaryApiConfig = config;
    saveSummaryApiConfig(config);
    render();
  });

  bindFloatingPhoneEvents(root, state, openPhone);
  bindReaderDragEvents();
  bindTucaoFloatEvents();
  bindReaderContextMenuEvents();
}

// ── Render ──

const titleCallbacks: TitleCallbacks = {
  enterSave,
  returnToTitle,
  startCreating: opts => {
    state.deepSeekModeEnabled = Boolean(opts?.deepSeekMode);
    writeDeepSeekModeEnabledPreference(state.deepSeekModeEnabled);
    state.creatingCharacter = true;
    state.showingSaveList = false;
    render();
  },
  setDeepSeekMode: enabled => {
    state.deepSeekModeEnabled = enabled;
    writeDeepSeekModeEnabledPreference(enabled);
  },
  showSaves: () => {
    state.showingSaveList = true;
    render();
  },
  hideSaves: () => {
    state.showingSaveList = false;
    render();
  },
  createAndEnter: opts => {
    state.deepSeekModeEnabled = opts.deepSeekMode ?? state.deepSeekModeEnabled;
    writeDeepSeekModeEnabledPreference(state.deepSeekModeEnabled);
    const save = createSave(opts);
    enterSave(save.saveId);
  },
  deleteSave: id => {
    deleteSave(id);
    if (state.activeSaveId === id) {
      clearWorldbookRefreshRetry();
      state.activeRunId = null;
      state.activeSaveId = null;
      setActiveRunId(null);
      clearActiveSaveId();
    }
  },
  exportSave: id => {
    downloadSaveBackup(id);
  },
  render: () => render(),
};

// ── Performance: Debounced render scheduler ──

let renderTimer: number | null = null;
let isRenderScheduled = false;

/**
 * 调度一次渲染，使用 requestAnimationFrame 防抖。
 * 高频操作（输入、滚动）时避免每次都立即 render，而是在下一帧统一渲染。
 */
function scheduleRender() {
  if (isRenderScheduled) return;
  isRenderScheduled = true;

  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = requestAnimationFrame(() => {
    render();
    isRenderScheduled = false;
    renderTimer = null;
  });
}

/**
 * 立即执行渲染，不防抖。用于必须同步更新的场景（发送消息、切换存档）。
 */
function renderImmediate() {
  if (renderTimer) {
    cancelAnimationFrame(renderTimer);
    renderTimer = null;
    isRenderScheduled = false;
  }
  render();
}

function render() {
  if (!root) return;
  syncRuntimeProfile();
  applyDrawingEnabledPreference();
  syncDrawingSettingsFromMountedControls();
  const readerBodyScroll = captureReaderBodyScroll();
  if (state.activeRunId) {
    // 游戏界面。
    if (syncMainEvents(state.statusData, state.plotLibrary)) {
      guardedAdapterSave(state.statusData);
      persistToSave();
    }
    syncFocusedMessage(state);
    syncPaperFullscreenHost(isPaperWorkspaceFullscreen(state));
    root.innerHTML = renderApp(state, flipDirection);
    bindEvents();
    restoreReaderBodyScroll(readerBodyScroll);

    // 状态页打开时挂载 P5 雷达图
    const radarEl = root.querySelector<HTMLElement>('#status-radar');
    if (radarEl) {
      const stats = state.playerProfile.stats;
      const statsArray = stats
        ? [stats.knowledge, stats.charm, stats.proficiency, stats.kindness, stats.courage]
        : [60, 60, 60, 60, 60];
      mountRadarChart(radarEl, statsArray, true);
    } else {
      unmountRadarChart();
    }
  } else if (state.creatingCharacter) {
    syncPaperFullscreenHost(false);
    // 角色创建界面。
    root.innerHTML = renderCharacterCreation({ deepSeekMode: state.deepSeekModeEnabled });
    bindCharacterCreationEvents(root, titleCallbacks);
  } else {
    syncPaperFullscreenHost(false);
    // 标题界面。
    root.innerHTML = renderTitleHome({
      showSaves: state.showingSaveList,
      deepSeekMode: state.deepSeekModeEnabled,
    });
    bindTitleHomeEvents(root, titleCallbacks);
  }
}

// ── Global events ──

window.addEventListener('resize', () => {
  syncPaperFullscreenHost(isPaperWorkspaceFullscreen(state));
  ctx.closeReaderContextMenu(false);
  syncFloatingPhoneAfterResize(state);
  const tucao = getTucaoFloatFlag();
  setTucaoFloatFlag({
    x: clamp(tucao.x, 8, Math.max(8, window.innerWidth - 260)),
    y: clamp(tucao.y, 8, Math.max(8, window.innerHeight - 44)),
  });
  // 全屏模式下，安卓虚拟键盘弹出/收起会触发 resize；若此时重渲会替换掉焦点输入框，导致键盘被关闭。
  if (isPaperWorkspaceFullscreen(state) && isEditableTarget(document.activeElement)) {
    return;
  }
  scheduleRender(); // 使用防抖渲染，避免 resize 时卡顿
});

window.addEventListener(
  'pointerdown',
  event => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest('[data-reader-context-menu="true"]')) return;
    ctx.closeReaderContextMenu(true);
  },
  true,
);

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.imageRerollEditing) {
    event.preventDefault();
    cancelImageRerollEditor();
    return;
  }
  if (event.key === 'Escape' && state.readerEditing) {
    event.preventDefault();
    cancelReaderEditor();
    return;
  }
  if (event.key === 'Escape' && state.readerContextMenu) {
    event.preventDefault();
    ctx.closeReaderContextMenu(true);
    return;
  }
  if (event.key === 'Escape' && state.showingSaveList) {
    event.preventDefault();
    state.showingSaveList = false;
    render();
    return;
  }
  if (event.key === 'Escape' && isPaperWorkspaceFullscreen(state)) {
    event.preventDefault();
    setPaperWorkspaceFullscreen(state, false);
    render();
    return;
  }
  if (isPaperFullscreenToggleShortcut(event)) {
    event.preventDefault();
    togglePaperWorkspaceFullscreen(state);
    render();
    return;
  }
  if (event.target instanceof HTMLTextAreaElement) return;
  const keyTarget = event.target instanceof HTMLElement ? event.target : null;
  if (keyTarget?.closest('.reader-card__body') && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault();
    focusMessage(-1);
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    focusMessage(1);
  }
});

// ── Async init ──

async function init() {
  // 必须在任何同步存档读写（render 之前）完成；内部会一次性把 localStorage 旧数据迁到 IndexedDB。
  await initSaveStore();
  adapter = await createVariableAdapter(win);
  state.summaryApiConfig = loadSummaryApiConfig();
  setupStreamingHooks(ctx, eventStops);
  setActiveRunId(null);
  clearActiveSaveId();
  // 页面切到后台 / 关闭前尝试 flush 未落盘的写入。IndexedDB 写本身很快（毫秒级），通常都能完成。
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        syncDrawingSettingsFromMountedControls();
        flushSaveStore().catch(err => console.warn('[init] flush on hidden failed:', err));
      }
    });
    window.addEventListener('beforeunload', () => {
      syncDrawingSettingsFromMountedControls();
    });
  }
  render();
}
init();

// ── Debug interfaces ──

function getDebugGameStateText() {
  return JSON.stringify({
    screen: state.activeRunId ? 'game' : 'title',
    activeRunId: state.activeRunId,
    activeSaveId: state.activeSaveId,
    phoneOpen: state.phoneOpen,
    phoneRoute: state.phoneRoute,
    phoneRouteHistory: state.phoneRouteHistory,
    phoneTab: state.activeTab,
    generating: state.generating,
    focusedMessageIndex: state.focusedMessageIndex,
    draft: state.draft,
    drawingSettings: state.drawingSettings,
    world: state.statusData.world,
    plot: {
      eventCount: Object.keys(state.plotLibrary.events).length,
      currentEventLoaded: Boolean(
        state.statusData.world.currentMainEventId &&
        state.plotLibrary.events[state.statusData.world.currentMainEventId],
      ),
      sources: state.plotLibrary.sourceEntryNames,
    },
    activeTargetId: state.statusData.activeTargetId,
    targets: state.statusData.targets.map(target => ({
      id: target.id,
      name: target.name,
      affinity: target.affinity,
      stage: target.stage,
    })),
    messageCount: state.uiMessages.length,
  });
}

function installDebugGlobals() {
  const debugApi = {
    render_game_to_text: getDebugGameStateText,
    islandmilfcode_debug_state: () => JSON.parse(getDebugGameStateText()),
  };
  Object.assign(window as any, debugApi);
  Object.assign(globalThis as any, debugApi);

  try {
    if (window.parent && window.parent !== window) {
      (window.parent as any).islandmilfcodeFrame = window;
      Object.assign(window.parent as any, debugApi);
    }
  } catch {
    // Cross-origin/sandboxed iframes cannot expose helpers to the parent window.
  }
}

installDebugGlobals();

(window as any).advanceTime = () => {
  if (adapter) {
    const data = adapter.load();
    if (JSON.stringify(data) !== JSON.stringify(state.statusData)) {
      state.statusData = data;
      cacheStatusData(data);
      render();
    }
  }
};
