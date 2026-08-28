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

import {
  cancelCurrentGeneration,
  cancelPhoneMessageGeneration,
  beginTimelineMutationFence,
  invalidateAsyncActions,
  isTimelineMutationFenced,
  retryBackgroundProgressUpdate,
  submitMessage,
  submitPhoneMessage,
  type ActionContext,
} from './actions';
import { generateOpeningScene } from './actions/opening';
import { clearBackgroundTask } from './background-tasks';
import { setupStreamingHooks } from './actions/streaming';
import { setupHostLifecycle } from './actions/host-lifecycle';
import {
  extractContextReply,
  getReaderMessages,
  getSummaryMessages,
  invalidateReaderMessagesCache,
} from './message-format';
import { bindFloatingPhoneEvents, loadFloatingPhonePosition, syncFloatingPhoneAfterResize } from './phone/floating';
import { bindPhoneAvatarFallbacks } from './phone/avatars';
import { clampPhoneHomePageToCount } from './phone/home-pagination';
import { bindPhoneRelationshipEvents } from './phone/relationships';
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
import { getDebugGameStateText, installDebugGlobals } from './index/debug';
import {
  canFlipReader,
  captureReaderBodyScroll,
  resetReaderCardTransform,
  resolveReaderIndex,
  restoreReaderBodyScroll,
} from './index/reader-ui';
import { buildSummaryModelsUrl, parseSummaryModelsResponse } from './index/summary-models';
import { createGameDevelopmentController, type GameDevelopmentController } from './index/game-development';
import { bindComposerEditor } from './index/composer-editor';
import { mountRadarChart, unmountRadarChart } from './phone/radar';
import {
  getCalendarMonthOffset,
  getCalendarOpenEventId,
  setCalendarMonthOffset,
  setCalendarOpenEventId,
  setCalendarSelectedDate,
  getV07FamilyLabel,
} from './phone/render';
import { updateSummaryTextInMemoryDB } from './memorydatabase/commit-points';
import { isGameDevelopmentRouteChoice } from './game-development';
import {
  buildPlotRoutingContext,
  commitPlotRouteChoice,
  confirmPlotRouteChoice,
  getPlotMachine,
  readActivePlotRouteChoice,
  setPlotRouteReviewEnabled,
} from './plot-state-machine';
import { isV07RouteChoiceRequired } from './plot-state-machine/choice';
import {
  clearActiveSaveId,
  createManualSave,
  createSave,
  deleteSave,
  exportSaveAsJsonParts,
  exportSaveAsJsonPartsWithAssets,
  getAutosaveBranchSaveId,
  importAllSavesFromJson,
  isStoredSaveReadOnly,
  listSaves,
  loadSaveAsync,
  normalizePlayerProfile,
  recoverMissingSaveIndexFromPayloads,
  resolveMemoryDBForLoad,
  setActiveRunId,
  setActiveSaveId,
  writeAutosave,
  type SingleSaveBackupPayload,
} from './state/saves';
import {
  deleteTavernArchiveSave,
  installArchiveBridgeSync,
  listTavernFileBackups,
  persistArchiveSaveToTavernFiles,
  readTavernFileBackup,
  writeTavernFileBackup,
} from './state/tavern-file-backup';
import { flushSaveStore, getSaveStoreDiagnostics, initSaveStore } from './state/save-store';
import {
  applyArchiveShujukuCompatibilityToRuntimeFlags,
  commitRuntimeArchive,
  deleteArchiveFloorMessage,
  deserializeArchiveFloorMessages,
  deleteArchiveSave,
  exportPortableArchive,
  exportReadonlyFutureArchive,
  flushArchiveRepository,
  forkArchiveSave,
  getArchiveFloor,
  getArchiveFloorAfterTurnShujukuBaseline,
  getArchiveFloorBeforeTurnShujukuBaseline,
  getArchiveMessageWindow,
  getArchiveMessageRange,
  getArchiveDiagnostics,
  getArchiveMetaSync,
  hasArchiveSaveSync,
  importPortableArchive,
  initArchiveRepository,
  loadArchiveAuxiliaryState,
  openArchiveSave,
  replaceArchiveFloorMessage,
  truncateArchiveAfterFloor,
  truncateArchiveFromAssistant,
  type ArchiveFloorShujukuBaseline,
  type ArchiveRollbackReceipt,
  type PortableArchiveBackup,
} from './state/archive-repository';
import { hashArchiveValue } from './state/archive-hash';
import {
  exportImageAssetsForIds,
  flushImageAssetStore,
  hydrateImageAssetElements,
  initImageAssetStore,
  restoreImageAssetFromBackup,
  saveImageDataUrlAsAsset,
} from './state/image-assets';
import {
  clampFocusedMessageIndex,
  createInitialState,
  deleteReaderMessage,
  deserializeMessages,
  normalizeDrawingSettings,
  getReaderMessageByIndex,
  getSourceUserTextForReaderIndex,
  hasAuthoritativeFloorStatusData,
  replaceConversationMessages,
  restoreFloorStateSnapshot,
  rollbackConversation,
  rollbackAfterCompletedReaderMessage,
  serializeMessages,
  normalizePhoneMessageStore,
  syncFocusedMessage,
} from './state/store';
import {
  createCompleteMessageWindow,
  getGlobalReaderMessageCount,
  getGlobalSummaryMessageCount,
  isMessageWindowAtHead,
  toGlobalReaderIndex,
  updateMessageWindowAfterCommit,
} from './state/message-window';
import {
  buildFactAnchorFromStatus,
  createDefaultSummaryStore,
  loadSummaryApiConfig,
  rerollSummaryEntry,
  repairSummaryStore,
  resumeAutoSummary,
  runSummary,
  saveSummaryApiConfig,
} from './summary';
import { createDefaultMemoryDB } from './memorydatabase/defaults';
import { normalizeMemoryDB } from './memorydatabase/normalize';
import type { SummaryApiConfig } from './summary/types';
import { bindCharacterCreationEvents, bindTitleHomeEvents, type TitleCallbacks } from './title/events';
import { renderCharacterCreation, renderTitleHome } from './title/render';
import type {
  ArchiveShujukuCompatibility,
  DeepSeekFanLookupState,
  GameState,
  NarrativeRoute,
  NotificationState,
  OpeningMode,
  ShujukuCompatibilityState,
  ShujukuHandoffEnvelope,
  ShujukuTableSnapshot,
  StatusData,
  TabKey,
  TavernWindow,
  UiMessage,
} from './types';
import {
  inspectCommittedShujukuBinding,
  probeShujukuRuntime,
  restoreShujukuTablesForHandoff,
  runShujukuTablesHandoffTransaction,
  SHUJUKU_NATIVE_HANDOFF_VERSION,
} from './shujuku/adapter';
import {
  isPhoneArchiveGoldImpression,
  isPhoneThemeCharacterId,
  PHONE_ARCHIVE_IMPRESSION_GOLD_TAG,
  PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG,
} from './phone/types';
import type { MusicTrack, PhoneCharacterId, PhoneRoute, PhoneThemeCharacterId } from './phone/types';
import { createVariableAdapter, type VariableAdapter } from './variables/adapter';
import { protectTargetAffinityReset } from './variables/runtime-guard';
import { HostTimelineAdapter } from './state/host-timeline-adapter';
import { clamp, formatTime, syncMainEvents } from './variables/normalize';
import { normalizeStatusData } from './variables/legacy';
import { syncSchoolCalendarState } from './school-calendar';
import {
  ensureBundledV07PlotEvents,
  getCurrentCharacterWorldbookBinding,
  loadCharacterWorldbookData,
  mergeWorldbookTargets,
} from './worldbook';
import type { CharacterWorldbookLoadStatus } from './worldbook';
import {
  cacheMatchesWorldbookBinding,
  mergePartialWorldbookData,
  markRecentWorldbookCacheStale,
  readRecentWorldbookCache,
  writeWorldbookSuccessCache,
} from './state/worldbook-cache';
import { ISLANDMILFCODE_VERSION, SAVE_DATA_SCHEMA_VERSION } from './version';
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
import { getIndexStats } from './memorydatabase/indexes';
import type { IslandMemoryDB, MemoryBaseRow } from './memorydatabase/types';
import { loadMemoryConfig, saveMemoryConfig, resetMemoryConfig } from './memory-config';
import {
  getImageGenerationPromptAtAnchor,
  isImageGenerationPluginAvailable,
  requestImageGeneration,
} from './plugins/image-generation';
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
import { waitForHostTimelineWrites } from './actions/host-commit-guard';

const win = window as TavernWindow;
const hostTimeline = new HostTimelineAdapter(win);
const root = document.querySelector<HTMLDivElement>('#app');

const READER_CONTEXT_MENU_GAP = 12;
const READER_CONTEXT_MENU_WIDTH = 240;
const READER_CONTEXT_MENU_HEIGHT = 220;
const STATUS_CACHE_KEY_PREFIX = 'islandmilfcode:status-cache:v2:';
const DRAWING_ENABLED_KEY_PREFIX = 'islandmilfcode:drawing-enabled:v1:';
const DEEPSEEK_MODE_ENABLED_KEY = 'islandmilfcode-ui:deepseek-mode-enabled:v1';

let flipDirection: 'forward' | 'backward' | '' = '';
let worldbookRefreshSequence = 0;
let phoneBgmAudio: HTMLAudioElement | null = null;
let phoneBgmResolvedUrl = '';
let restoringSave = false;
let restoringSaveOwner = 0;
let suppressRenderPersistence = false;
let saveLoadSequence = 0;
let readerMutationSequence = 0;
let readerWindowLoadSequence = 0;
const imageRerollSequenceByKey = new Map<string, number>();
let playerAvatarSequence = 0;
let quickReplyDelegationBound = false;
let calendarEventDelegationBound = false;

async function withTimelineMutation<T>(operation: () => Promise<T>, owner?: symbol): Promise<T> {
  const release = beginTimelineMutationFence(owner);
  try {
    return await operation();
  } finally {
    release();
  }
}

let v07DdlAutoOpened = false;

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

let backgroundTaskDragState: {
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  moved: boolean;
} | null = null;

function compactCalendarLookupText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, '').trim();
}

function resolveCalendarEventIdFromRow(row: HTMLElement) {
  if (row.dataset.eventId) return row.dataset.eventId;

  const titleText = row.querySelector<HTMLElement>('.phone-calendar-event__top strong')?.textContent?.trim();
  const titleKey = compactCalendarLookupText(titleText);
  if (!titleKey) return null;

  const events = Object.values(state.plotLibrary.events);
  const exact = events.find(event => compactCalendarLookupText(event.title) === titleKey);
  if (exact) return exact.id;

  const rowText = compactCalendarLookupText(row.textContent);
  return (
    events.find(event => {
      const eventTitle = compactCalendarLookupText(event.title);
      return eventTitle && (rowText.includes(eventTitle) || eventTitle.includes(titleKey));
    })?.id ?? null
  );
}
function openCalendarEventRow(row: HTMLElement, event: Event) {
  const eventId = resolveCalendarEventIdFromRow(row);
  if (!eventId) return;
  event.preventDefault();
  setCalendarOpenEventId(eventId);
  render();
}

function bindCalendarEventDelegation() {
  if (!root || calendarEventDelegationBound) return;
  calendarEventDelegationBound = true;
  root.addEventListener('click', event => {
    if (!(event.target instanceof HTMLElement)) return;

    const closeButton = event.target.closest<HTMLElement>('[data-action="calendar-close-event"]');
    if (closeButton) {
      event.preventDefault();
      setCalendarOpenEventId(null);
      render();
      return;
    }

    const row = event.target.closest<HTMLElement>('.phone-calendar-event, [data-action="calendar-open-event"]');
    if (row) openCalendarEventRow(row, event);
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof HTMLElement)) return;
    const row = event.target.closest<HTMLElement>('.phone-calendar-event, [data-action="calendar-open-event"]');
    if (row) openCalendarEventRow(row, event);
  });
}

function setPaperTheme(theme: string | undefined) {
  const nextTheme = theme === 'eye-care' || theme === 'night' ? theme : 'classic';
  if (state.runtimeFlags.paperTheme === nextTheme) return;
  state.runtimeFlags.paperTheme = nextTheme;
  persistToSave();
  render();
}

// ── State & adapter ──

let adapter: VariableAdapter;
const state = createInitialState(loadFloatingPhonePosition());
const eventStops: Array<() => void> = [];
let worldbookRefreshRetryTimer: number | null = null;
let worldbookRefreshRetryToken = 0;
let lastWorldbookRefreshStatus: CharacterWorldbookLoadStatus | 'cached' = 'cached';
const AUTOSAVE_DEBOUNCE_MS = 400;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

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
  syncSchoolCalendarState({
    currentTime: data.world.currentTime,
    playerProfile: state.playerProfile,
    statusData: data,
  });
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* 忽略 */
  }
}

function guardedAdapterSave(data: StatusData) {
  syncMainEvents(data, state.plotLibrary);
  syncSchoolCalendarState({
    currentTime: data.world.currentTime,
    playerProfile: state.playerProfile,
    statusData: data,
  });
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
    return protectTargetAffinityReset(adapter.load(), state.statusData, 'guarded-adapter-load');
  },
  save(data: StatusData) {
    guardedAdapterSave(data);
  },
  onUpdate(cb: (data: StatusData) => void) {
    return adapter.onUpdate(data => cb(protectTargetAffinityReset(data, state.statusData, 'guarded-adapter-update')));
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
  hostTimeline,
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
  persistConversationImmediately: () => persistToSaveImmediately(),
  persistIncompleteConversationImmediately: () => persistToSaveImmediately({ allowIncomplete: true }),
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
    currentMessageIndex: Math.max(getGlobalReaderMessageCount(state) - 1, 0),
    runtimeFlags: {
      ...stripGlobalRuntimeFlags(JSON.parse(JSON.stringify(state.runtimeFlags)) as Record<string, unknown>),
      playerProfile: JSON.parse(JSON.stringify(state.playerProfile)),
      phoneMessages: JSON.parse(JSON.stringify(state.phoneMessages)),
      drawingSettings: JSON.parse(JSON.stringify(state.drawingSettings)),
    },
  };
}

function captureRuntimeSaveState() {
  // Capture the current run's object references before entering the archive
  // queue. Loading another save replaces these roots, so a delayed commit can
  // never serialize the newly opened run under the old saveId.
  return {
    statusData: JSON.parse(JSON.stringify(state.statusData)) as typeof state.statusData,
    playerProfile: JSON.parse(JSON.stringify(state.playerProfile)) as typeof state.playerProfile,
    phoneMessages: JSON.parse(JSON.stringify(state.phoneMessages)) as typeof state.phoneMessages,
    drawingSettings: JSON.parse(JSON.stringify(state.drawingSettings)) as typeof state.drawingSettings,
    summaryStore: JSON.parse(JSON.stringify(state.summaryStore)) as typeof state.summaryStore,
    memoryDB: JSON.parse(JSON.stringify(state.memoryDB)) as typeof state.memoryDB,
    // Message arrays are replaced on append/truncate. Holding this run-local
    // array avoids serializing the entire history just to enter the queue;
    // commitRuntimeArchive serializes only the current tail chunk.
    uiMessages: state.uiMessages,
    messageWindow: { ...state.messageWindow },
  };
}

function hasIncompleteExchange(messages = state.uiMessages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === 'system') continue;
    return message.streaming || message.role === 'user';
  }
  return false;
}

function writeCurrentAutosave(options: { allowIncomplete?: boolean } = {}) {
  if (!state.activeRunId || restoringSave) return;
  if (hasIncompleteExchange() && !options.allowIncomplete) return;
  const runId = state.activeRunId;
  const saveId = getAutosaveBranchSaveId({
    activeSaveId: state.activeSaveId,
    runId,
  });
  const sourceSaveId = state.activeSaveId;
  const loadToken = saveLoadSequence;
  const canPromoteAutosave = () => saveLoadSequence === loadToken
    && state.activeRunId === runId
    && (state.activeSaveId === sourceSaveId || state.activeSaveId === saveId);
  const gameState = buildGameState();
  const runtimeState = captureRuntimeSaveState();
  const existingMeta = getArchiveMetaSync(saveId) ?? listSaves().find(item => item.saveId === saveId);
  const operation = (async () => {
    try {
      if (
        sourceSaveId &&
        sourceSaveId !== saveId &&
        hasArchiveSaveSync(sourceSaveId) &&
        !hasArchiveSaveSync(saveId)
      ) {
        await forkArchiveSave({ sourceSaveId, saveId, label: 'Autosave' });
      }
      const receipt = await commitRuntimeArchive({
        saveId,
        runId,
        kind: 'autosave',
        label: 'Autosave',
        gameState,
        state: runtimeState,
        existingMeta,
      });
      if (canPromoteAutosave() && receipt.shujukuCompatibility !== undefined) {
        applyArchiveShujukuCompatibilityToRuntimeFlags(state.runtimeFlags, receipt.shujukuCompatibility);
      }
      if (canPromoteAutosave()) updateMessageWindowAfterCommit(state, receipt);
      delete state.runtimeFlags.hostTimelineHealth;
      if (canPromoteAutosave()) {
        state.activeSaveId = saveId;
        setActiveSaveId(saveId);
      }
    } catch (error) {
      console.warn('[archive] autosave failed:', error);
      state.runtimeFlags.hostTimelineHealth = {
        status: 'index-behind-host',
        at: new Date().toISOString(),
        detail: error instanceof Error ? error.message : String(error),
      };
      if (runtimeState.messageWindow.startMessage > 0) return;
      const meta = writeAutosave(
        {
          runId,
          gameState,
          chatLog: serializeMessages(runtimeState.uiMessages),
          summaryStore: runtimeState.summaryStore,
          memoryDB: runtimeState.memoryDB,
        },
        saveId,
      );
      if (meta && canPromoteAutosave()) {
        state.activeSaveId = meta.saveId;
        setActiveSaveId(meta.saveId);
      }
    }
  })();
  void operation.catch(error => console.warn('[archive] autosave fallback failed; gameplay continues:', error));
  return operation;
}

function persistToSave() {
  if (!state.activeRunId || restoringSave) return;
  if (hasIncompleteExchange()) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void writeCurrentAutosave();
  }, AUTOSAVE_DEBOUNCE_MS);
}

function flushPendingAutosave(options: { allowIncomplete?: boolean } = {}) {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  return writeCurrentAutosave(options);
}

async function persistToSaveImmediately(options: { allowIncomplete?: boolean } = {}) {
  if (!state.activeRunId || restoringSave) return;
  if (hasIncompleteExchange() && !options.allowIncomplete) {
    throw new Error('当前正文回合尚未完成，存档进度未推进。');
  }
  await flushPendingAutosave(options);
  const auxiliaryFlushes = await Promise.allSettled([flushArchiveRepository(), flushSaveStore()]);
  auxiliaryFlushes.forEach(result => {
    if (result.status === 'rejected') {
      console.warn('[archive] auxiliary immediate-save flush deferred; gameplay continues:', result.reason);
    }
  });
}

const gameDevelopmentController: GameDevelopmentController = createGameDevelopmentController({
  getState: () => state,
  getRoot: () => root,
  render: () => render(),
  persist: () => persistToSave(),
  persistImmediately: () => persistToSaveImmediately(),
  submitMainMessage: async options => {
    if (restoringSave || isTimelineMutationFenced(options.timelineMutationOwner)) {
      throw new Error('当前正在切换或修改正文时间线，游戏开发回合没有发送。');
    }
    if (!(await ensureHeadMessageWindow())) {
      throw new Error('最新楼层暂时无法读取，游戏开发回合没有发送。');
    }
    await submitMessage(ctx, options);
  },
  notify: notification => ctx.showNotification(notification),
  focusComposer: () => focusComposer(),
});

async function persistManualSave() {
  if (!state.activeRunId) return;
  if (hasIncompleteExchange()) {
    window.alert('当前正文回合尚未完成，暂时不能创建手动存档。');
    return;
  }
  const requestLoadToken = saveLoadSequence;
  const requestedRunId = state.activeRunId;
  await Promise.resolve(flushPendingAutosave()).catch(error => {
    console.warn('[archive] pre-fork autosave deferred; manual save will use the newest available root:', error);
  });
  if (requestLoadToken !== saveLoadSequence || state.activeRunId !== requestedRunId) return;
  const runId = state.activeRunId;
  if (!runId) return;
  const sourceSaveId = state.activeSaveId;
  const gameState = buildGameState();
  const runtimeState = captureRuntimeSaveState();
  let manualSaveId = '';
  let manualShujukuCompatibility: ArchiveShujukuCompatibility | null | undefined;
  try {
    const forked = sourceSaveId ? await forkArchiveSave({ sourceSaveId, label: 'Manual save' }) : null;
    if (!forked) throw new Error('No active v3 root to fork');
    manualSaveId = forked.saveId;
    manualShujukuCompatibility = forked.shujukuCompatibility;
  } catch (error) {
    if (runtimeState.messageWindow.startMessage > 0) {
      console.warn('[archive] manual fork unavailable while reading cold history; preserving the complete source root:', error);
      window.alert('当前正在查看旧楼层，完整手动存档暂时无法创建；原存档没有被改动。请回到最新楼层后重试。');
      return;
    }
    console.warn('[archive] manual fork unavailable; using legacy manual save:', error);
    const legacyMeta = createManualSave({
      runId,
      label: 'Manual save',
      gameState,
      chatLog: serializeMessages(runtimeState.uiMessages),
      summaryStore: runtimeState.summaryStore,
      memoryDB: runtimeState.memoryDB,
    });
    manualSaveId = legacyMeta.saveId;
  }
  const auxiliaryFlushes = await Promise.allSettled([
    flushImageAssetStore(),
    flushArchiveRepository(),
    flushSaveStore(),
  ]);
  auxiliaryFlushes.forEach(result => {
    if (result.status === 'rejected') {
      console.warn('[archive] manual-save auxiliary flush deferred; the created save remains available:', result.reason);
    }
  });
  if (state.activeRunId === runId && state.activeSaveId === sourceSaveId) {
    state.activeSaveId = manualSaveId;
    setActiveSaveId(manualSaveId);
    if (manualShujukuCompatibility !== undefined) {
      applyArchiveShujukuCompatibilityToRuntimeFlags(state.runtimeFlags, manualShujukuCompatibility);
    }
  }
}

async function exportLegacySavePartsPlayerFirst(saveId: string) {
  try {
    return await exportSaveAsJsonPartsWithAssets(saveId);
  } catch (error) {
    console.warn('[archive] legacy image attachment export failed; exporting playable core save:', error);
    return exportSaveAsJsonParts(saveId);
  }
}

async function downloadSaveBackup(saveId: string) {
  try {
    const requestedLoadToken = saveLoadSequence;
    const requestedRunId = state.activeSaveId === saveId ? state.activeRunId : '';
    let resolvedSaveId = saveId;
    if (state.activeRunId && state.activeSaveId === saveId) {
      await Promise.resolve(flushPendingAutosave()).catch(error => {
        console.warn('[archive] export is using the newest readable checkpoint after autosave delay:', error);
      });
      // Flushing a manual slot can promote the live branch to its autosave.
      // Export the branch the player is actually playing after that promotion.
      if (requestedLoadToken === saveLoadSequence && state.activeRunId === requestedRunId) {
        resolvedSaveId = state.activeSaveId ?? saveId;
      }
    }
    await flushArchiveRepository().catch(error => {
      console.warn('[archive] pending archive flush did not settle before export; reading newest available root:', error);
    });
    const auxiliaryFlushes = await Promise.allSettled([flushImageAssetStore(), flushSaveStore()]);
    let imagesIncomplete = auxiliaryFlushes[0]?.status === 'rejected';
    auxiliaryFlushes.forEach(result => {
      if (result.status === 'rejected') {
        console.warn('[archive] auxiliary export flush failed; exporting readable core data:', result.reason);
      }
    });
    let blob: Blob;
    let archiveWarnings: string[] = [];
    let exportedFutureReadonly = false;
    if (hasArchiveSaveSync(resolvedSaveId)) {
      const archive = await exportPortableArchive(resolvedSaveId).catch(async error => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/newer archive schema|read-only in this build|metadata uses a newer/i.test(message)) throw error;
        return exportReadonlyFutureArchive(resolvedSaveId);
      });
      const assetIds = new Set<string>();
      if (archive.kind === 'archive-v3') {
        if (archive.meta.playerProfile.avatarAssetId) assetIds.add(archive.meta.playerProfile.avatarAssetId);
        archive.floors.forEach(floor => floor.imageAssetIds.forEach(id => assetIds.add(id)));
      } else {
        exportedFutureReadonly = true;
        archive.referencedImageAssetIds.forEach(id => assetIds.add(id));
        archiveWarnings = archive.warnings;
      }
      const imageAssets = await exportImageAssetsForIds(assetIds).catch(error => {
        imagesIncomplete = true;
        console.warn('[archive] image export degraded to core save:', error);
        return [];
      });
      if (imageAssets.length < assetIds.size) imagesIncomplete = true;
      blob = new Blob([JSON.stringify({ ...archive, imageAssets })], { type: 'application/json;charset=utf-8' });
    } else {
      blob = new Blob(await exportLegacySavePartsPlayerFirst(resolvedSaveId), { type: 'application/json;charset=utf-8' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `islandmilfcode-save-${resolvedSaveId}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // setTimeout 让浏览器有机会真正触发下载之后再回收 URL。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const exportNotices: string[] = [];
    if (exportedFutureReadonly) exportNotices.push('未来版存档已导出为只读救援包，当前版本不会打开或写回它。');
    if (archiveWarnings.length) exportNotices.push(archiveWarnings.join('；'));
    if (imagesIncomplete) exportNotices.push('部分图片仍在写入、缺失或读取失败，图片附件可能不完整。');
    if (exportNotices.length) {
      window.alert(exportNotices.join('\n'));
    }
  } catch (error) {
    window.alert(`导出失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createCurrentSingleSaveBackup(saveId: string): Promise<SingleSaveBackupPayload> {
  const flushes = await Promise.allSettled([flushImageAssetStore(), flushSaveStore()]);
  flushes.forEach(item => {
    if (item.status === 'rejected') console.warn('[archive] legacy local-backup flush deferred:', item.reason);
  });
  const json = (await exportLegacySavePartsPlayerFirst(saveId)).join('');
  return JSON.parse(json) as SingleSaveBackupPayload;
}

async function persistSaveToTavernFiles(saveId: string) {
  const requestedLoadToken = saveLoadSequence;
  const requestedRunId = state.activeSaveId === saveId ? state.activeRunId : '';
  let resolvedSaveId = saveId;
  if (state.activeRunId && state.activeSaveId === saveId && autosaveTimer) {
    await Promise.resolve(flushPendingAutosave()).catch(error => {
      console.warn('[archive] local backup is using the newest readable checkpoint after autosave delay:', error);
    });
    if (requestedLoadToken === saveLoadSequence && state.activeRunId === requestedRunId) {
      resolvedSaveId = state.activeSaveId ?? saveId;
    }
  }
  if (hasArchiveSaveSync(resolvedSaveId)) {
    return persistArchiveSaveToTavernFiles(resolvedSaveId);
  }
  return writeTavernFileBackup(await createCurrentSingleSaveBackup(resolvedSaveId));
}

function formatTavernBackupTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

async function restoreSaveFromTavernFiles() {
  try {
    const backups = await listTavernFileBackups();
    if (!backups.length) {
      window.alert('SillyTavern 本机数据目录中还没有可恢复的备份。');
      return;
    }
    const choices = backups
      .map((item, index) => `${index + 1}. ${item.playerName} · ${item.label} · ${formatTavernBackupTime(item.updatedAt)}`)
      .join('\n');
    const rawChoice = window.prompt(`输入要恢复的序号：\n\n${choices}`, '1');
    if (rawChoice === null) return;
    const selected = backups[Number(rawChoice) - 1];
    if (!selected) {
      window.alert('序号无效，没有恢复任何存档。');
      return;
    }
    if (selected.storage === 'archive-v3') {
      await enterSave(selected.saveId, { archiveSource: 'local' });
      return;
    }
    const result = importAllSavesFromJson(JSON.stringify(await readTavernFileBackup(
          selected.saveId,
          selected.storage === 'legacy-v1' ? 'legacy-v1' : 'bundle-v2',
        )));
    const flushes = await Promise.allSettled([flushImageAssetStore(), flushArchiveRepository(), flushSaveStore()]);
    const deferred = flushes.filter(item => item.status === 'rejected').length;
    flushes.forEach(item => {
      if (item.status === 'rejected') console.warn('[archive] restored backup auxiliary flush deferred:', item.reason);
    });
    window.alert(
      `已从 SillyTavern 本机数据目录恢复 ${result.imported} 个存档。`
      + (deferred ? ' 部分附件仍在后台落盘，正文存档已保留。' : '')
      + ' 即将刷新页面。',
    );
    location.reload();
  } catch (error) {
    window.alert(`恢复本机备份失败：${(error as Error).message}`);
  }
}

function applyPlayerProfileDraftFromStatusPanel() {
  if (!state.playerProfileEditing) return;
  const familyNameField = root?.querySelector<HTMLInputElement>('[data-profile-field="familyName"]');
  if (!familyNameField) return;
  const getValue = (field: string) =>
    root?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-profile-field="${field}"]`)?.value ?? '';
  const familyName = familyNameField.value.trim();
  const givenName = getValue('givenName').trim();
  state.playerProfile = {
    ...state.playerProfile,
    familyName,
    givenName,
    name: familyName + givenName,
    personality: getValue('personality').trim(),
    appearance: getValue('appearance').trim(),
  };
}

function readImageFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取头像图片失败。'));
    reader.readAsDataURL(file);
  });
}

function getSupportedAvatarMimeType(file: File): string {
  const normalizedMimeType = file.type.toLowerCase();
  if (['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(normalizedMimeType)) {
    return normalizedMimeType === 'image/jpg' ? 'image/jpeg' : normalizedMimeType;
  }
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return ({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  } as Record<string, string>)[extension] ?? '';
}

async function setPlayerAvatarFromFile(file: File) {
  const avatarToken = ++playerAvatarSequence;
  const loadToken = saveLoadSequence;
  const saveId = state.activeSaveId;
  const runId = state.activeRunId;
  const isCurrent = () => avatarToken === playerAvatarSequence
    && loadToken === saveLoadSequence
    && state.activeSaveId === saveId
    && state.activeRunId === runId;
  const mimeType = getSupportedAvatarMimeType(file);
  if (!mimeType) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片。');
  if (file.size > 8 * 1024 * 1024) throw new Error('头像图片不能超过 8 MB。');
  applyPlayerProfileDraftFromStatusPanel();
  const rawDataUrl = await readImageFileAsDataUrl(file);
  if (!isCurrent()) return;
  const imageDataUrl = /^data:image\//i.test(rawDataUrl)
    ? rawDataUrl
    : rawDataUrl.replace(/^data:[^;,]*/i, `data:${mimeType}`);
  const assetId = await saveImageDataUrlAsAsset(imageDataUrl, { prompt: '玩家聊天头像' });
  if (!isCurrent()) return;
  state.playerProfile.avatarAssetId = assetId;
  syncRuntimeProfile();
  persistToSave();
  render();
}

function savePlayerProfileFromStatusPanel() {
  applyPlayerProfileDraftFromStatusPanel();
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

async function hydrateRecentWorldbookCache(isCurrent: () => boolean = () => true) {
  const binding = getCurrentCharacterWorldbookBinding(win);
  const cached = await readRecentWorldbookCache('current').catch(() => null);
  if (!isCurrent()) return false;
  if (!cached) return false;
  if (!cacheMatchesWorldbookBinding(cached, binding)) return false;
  state.plotLibrary = ensureBundledV07PlotEvents(cached.data.plotLibrary);
  state.characterCardLibrary = cached.data.characterCardLibrary;
  if (cached.data.targets.length) {
    state.statusData = mergeWorldbookTargets(state.statusData, cached.data.targets);
  }
  lastWorldbookRefreshStatus = 'cached';
  return true;
}

async function refreshCharacterWorldbookTargets() {
  const requestId = ++worldbookRefreshSequence;
  const runId = state.activeRunId;
  const hostBinding = getCurrentCharacterWorldbookBinding(win);
  const previousNotice = typeof state.runtimeFlags.worldbookCacheNotice === 'string'
    ? state.runtimeFlags.worldbookCacheNotice
    : '';
  const result = await loadCharacterWorldbookData(win);
  const cached = await readRecentWorldbookCache(result.binding.characterKey).catch(() => null);
  if (requestId !== worldbookRefreshSequence || state.activeRunId !== runId) return;
  const matchingCached = cached && cacheMatchesWorldbookBinding(cached, hostBinding) ? cached : null;
  lastWorldbookRefreshStatus = result.status;
  const fresh = {
    targets: result.targets,
    plotLibrary: result.plotLibrary,
    characterCardLibrary: result.characterCardLibrary,
  };
  const data = result.status === 'success' || result.status === 'legitimate-empty'
    ? fresh
    : result.status === 'partial-failure'
      ? mergePartialWorldbookData(fresh, matchingCached?.data ?? null)
      : matchingCached?.data ?? {
          targets: [],
          plotLibrary: state.plotLibrary,
          characterCardLibrary: state.characterCardLibrary,
        };
  if (result.status === 'success' || result.status === 'legitimate-empty') {
    delete state.runtimeFlags.worldbookCacheNotice;
    void writeWorldbookSuccessCache(result).catch(error => console.warn('[worldbook] cache write failed:', error));
  } else {
    const detail = result.errors.map(item => item.worldbookName ? `${item.worldbookName}: ${item.message}` : item.message).join('; ');
    state.runtimeFlags.worldbookCacheNotice = matchingCached
      ? `世界书刷新失败，日历和角色目录正在使用最近一次成功缓存。${detail ? ` ${detail}` : ''}`
      : `世界书刷新失败，保留当前目录。${detail ? ` ${detail}` : ''}`;
    console.warn('[worldbook] non-blocking refresh fallback:', result.status, detail);
  }
  const { targets, characterCardLibrary } = data;
  const plotLibrary = ensureBundledV07PlotEvents(data.plotLibrary);
  const previousPlotSignature = JSON.stringify({
    events: state.plotLibrary.events,
    sourceEntryNames: state.plotLibrary.sourceEntryNames,
    writingProtocols: state.plotLibrary.writingProtocols,
  });
  const previousCardSignature = JSON.stringify(state.characterCardLibrary.cards);
  const nextPlotSignature = JSON.stringify({
    events: plotLibrary.events,
    sourceEntryNames: plotLibrary.sourceEntryNames,
    writingProtocols: plotLibrary.writingProtocols,
  });
  const nextCardSignature = JSON.stringify(characterCardLibrary.cards);
  state.plotLibrary = plotLibrary;
  state.characterCardLibrary = characterCardLibrary;

  const previous = JSON.stringify(state.statusData.targets);
  if (targets.length) {
    state.statusData = mergeWorldbookTargets(state.statusData, targets);
  }
  const schoolCalendarChanged = syncSchoolCalendarState({
    currentTime: state.statusData.world.currentTime,
    playerProfile: state.playerProfile,
    statusData: state.statusData,
  });
  const targetsChanged = JSON.stringify(state.statusData.targets) !== previous;
  const plotChanged = nextPlotSignature !== previousPlotSignature;
  const cardsChanged = nextCardSignature !== previousCardSignature;
  const nextNotice = typeof state.runtimeFlags.worldbookCacheNotice === 'string'
    ? state.runtimeFlags.worldbookCacheNotice
    : '';
  const noticeChanged = nextNotice !== previousNotice;
  if (!targetsChanged && !plotChanged && !cardsChanged && !schoolCalendarChanged && !noticeChanged) return;

  if (targetsChanged || schoolCalendarChanged) guardedAdapterSave(state.statusData);
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
  if (lastWorldbookRefreshStatus === 'success' || lastWorldbookRefreshStatus === 'legitimate-empty') return;

  const token = worldbookRefreshRetryToken;
  worldbookRefreshRetryTimer = window.setTimeout(
    () => {
      worldbookRefreshRetryTimer = null;
      if (token !== worldbookRefreshRetryToken || state.activeRunId !== runId) return;
      void refreshCharacterWorldbookTargets()
        .catch(error => {
          console.warn('[worldbook] delayed refresh failed:', error);
        })
        .finally(() => {
          if (token !== worldbookRefreshRetryToken || state.activeRunId !== runId) return;
          if (lastWorldbookRefreshStatus !== 'success' && lastWorldbookRefreshStatus !== 'legitimate-empty') {
            scheduleWorldbookRefreshRetry(runId, attempt + 1);
          }
        });
    },
    retryDelays[attempt - 1],
  );
}

function getMemoryDBTableCounts(memoryDB: IslandMemoryDB) {
  const tableNames = [
    'entities',
    'events',
    'facts',
    'relations',
    'impressions',
    'tasks',
    'secrets',
    'items',
    'phoneMessages',
    'summaries',
    'attributes',
    'worldState',
  ] as const;
  const counts: Record<string, { active: number; expired: number; total: number }> = {};
  for (const tableName of tableNames) {
    const rows = memoryDB[tableName] as MemoryBaseRow[];
    let active = 0;
    let expired = 0;
    for (const row of rows) {
      if (row.expired) expired += 1;
      else active += 1;
    }
    counts[tableName] = { active, expired, total: rows.length };
  }
  return counts;
}

async function restoreLoadedShujukuTableSnapshot(input: {
  loadToken: number;
  saveId: string;
  runId: string;
}): Promise<string> {
  const isCurrent = () => input.loadToken === saveLoadSequence
    && state.activeSaveId === input.saveId
    && state.activeRunId === input.runId;
  if (!isCurrent()) return '';
  const inspected = inspectCommittedShujukuBinding(state.runtimeFlags, {
    saveId: input.saveId,
    runId: input.runId,
  });
  if (inspected.kind !== 'active') return '';
  try {
    await restoreShujukuTablesForHandoff(
      win,
      inspected.binding.compatibility.isolationKey,
      inspected.binding.tableSnapshot,
    );
    if (!isCurrent()) return '';
    console.info('[shujuku:lifecycle] restored saved table snapshot', {
      saveId: input.saveId,
      handoffId: inspected.binding.handoff.handoffId,
      tableHash: inspected.binding.tableSnapshot.tableHash,
    });
    return '';
  } catch (error) {
    if (!isCurrent()) return '';
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('[shujuku:lifecycle] saved table snapshot restore deferred:', error);
    return `shujuku 表快照暂未恢复：${detail}。发送正文前会再次校准。`;
  }
}

async function enterSave(saveId: string, options: { openingMode?: OpeningMode; archiveSource?: 'local' } = {}) {
  return withTimelineMutation(async () => {
  await waitForHostTimelineWrites();
  const loadToken = ++saveLoadSequence;
  imageRerollSequenceByKey.clear();
  let archive = null as Awaited<ReturnType<typeof openArchiveSave>>;
  try {
    archive = await openArchiveSave(saveId, {
      loadMessageWindow: true,
      source: options.archiveSource,
      loadAuxiliaryState: false,
    });
  } catch (error) {
    if (loadToken !== saveLoadSequence) return;
    const message = error instanceof Error ? error.message : String(error);
    if (/host locator/i.test(message)) {
      window.alert(`这个存档的 host locator 无法验证，已阻止进入。\n\n${message}`);
      return;
    }
    if (/newer archive schema|read-only in this build/i.test(message)) {
      window.alert('这个存档来自更高版本。当前版本不会打开或覆盖它；你仍可从存档列表导出只读救援包。');
      return;
    }
    console.warn('[archive] v3 root could not be opened; trying retained legacy data:', error);
  }
  if (loadToken !== saveLoadSequence) return;
  let legacy = null as Awaited<ReturnType<typeof loadSaveAsync>>;
  if (!archive) {
    try {
      legacy = await loadSaveAsync(saveId);
    } catch (error) {
      if (loadToken !== saveLoadSequence) return;
      const message = error instanceof Error ? error.message : String(error);
      window.alert(
        /host locator/i.test(message)
          ? `这个存档的 host locator 无法验证，已阻止进入。\n\n${message}`
          : `这个存档无法读取，已阻止进入。\n\n${message}`,
      );
      return;
    }
    if (loadToken !== saveLoadSequence) return;
    // ponytail: keep legacy data as the read source; convert only on an explicit write.
  }
  if (!archive && !legacy) {
    if (await isStoredSaveReadOnly(saveId).catch(() => false)) {
      if (loadToken !== saveLoadSequence) return;
      window.alert('这个存档使用当前版本不认识的数据结构，已按原样保留；可以导出备份，但不会进入或覆盖。');
    }
    return;
  }

  let loadedMessages: UiMessage[] = [];
  try {
    loadedMessages = legacy ? deserializeMessages(legacy.payload.chatLog) : [];
  } catch (error) {
    if (loadToken !== saveLoadSequence) return;
    window.alert(`这个存档的 host locator 无法验证，已阻止进入。\n\n${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  let recoveryNotice = archive?.meta.health === 'degraded'
    ? archive.meta.migrationWarnings?.slice(-1)[0] ?? '当前 root 不可读，已回退到上一个可玩版本。'
    : '';
  if (archive) {
    try {
      if (!archive.messageWindow) throw new Error('Archive reader window is unavailable');
      loadedMessages = deserializeArchiveFloorMessages(archive.messageWindow.floors);
    } catch (error) {
      if (loadToken !== saveLoadSequence) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/host locator/i.test(message)) {
        window.alert(`这个存档的 host locator 无法验证，已阻止进入。\n\n${message}`);
        return;
      }
      console.warn('[archive] head window hydrate failed; trying playable recovery sources:', error);
      try {
        legacy = legacy ?? await loadSaveAsync(saveId);
      } catch (legacyError) {
        if (loadToken !== saveLoadSequence) return;
        const legacyMessage = legacyError instanceof Error ? legacyError.message : String(legacyError);
        window.alert(
          /host locator/i.test(legacyMessage)
            ? `这个存档的 host locator 无法验证，已阻止进入。\n\n${legacyMessage}`
            : `这个存档无法读取，已阻止进入。\n\n${legacyMessage}`,
        );
        return;
      }
      if (loadToken !== saveLoadSequence) return;
      if (legacy) {
        archive = null;
        try {
          loadedMessages = deserializeMessages(legacy.payload.chatLog);
        } catch (decodeError) {
          if (loadToken !== saveLoadSequence) return;
          window.alert(`这个存档的 host locator 无法验证，已阻止进入。\n\n${decodeError instanceof Error ? decodeError.message : String(decodeError)}`);
          return;
        }
        recoveryNotice = 'v3 楼层不完整，已改用保留的旧版存档继续游戏。';
      } else {
        const recent = await getArchiveMessageWindow(saveId).catch(() => null);
        if (loadToken !== saveLoadSequence) return;
        try {
          loadedMessages = deserializeArchiveFloorMessages(recent?.floors ?? []);
        } catch (decodeError) {
          if (loadToken !== saveLoadSequence) return;
          window.alert(`这个存档的 host locator 无法验证，已阻止进入。\n\n${decodeError instanceof Error ? decodeError.message : String(decodeError)}`);
          return;
        }
        recoveryNotice = recent?.floors.length
          ? '部分楼层读取失败，已载入最近可读楼层；你可以继续游戏并立即导出备份。'
          : '历史楼层暂时不可读，已载入角色状态；你可以继续游戏并立即导出备份。';
      }
    }
  }
  if (loadToken !== saveLoadSequence || (!archive && !legacy)) return;

  const gameState = archive?.state.gameState ?? legacy!.payload.gameState;
  const meta = archive?.meta ?? legacy!.meta;
  const summaryStore = archive
    ? archive.summary?.summaryStore ?? createDefaultSummaryStore()
    : legacy?.payload.summaryStore ?? createDefaultSummaryStore();
  const memoryDB = archive
    ? resolveMemoryDBForLoad(archive.memory?.memoryDB, summaryStore, gameState.runId)
    : normalizeMemoryDB(legacy?.payload.memoryDB, gameState.runId) ?? createDefaultMemoryDB(gameState.runId);
  const shouldGenerateOpening = options.openingMode === 'ai'
    && (archive ? archive.root.floorCount === 0 : loadedMessages.length === 0);
  const enteringRunId = gameState.runId;
  if (loadToken !== saveLoadSequence) return;
  if (state.activeRunId && state.activeSaveId !== saveId) {
    void Promise.resolve(flushPendingAutosave()).catch(error => {
      console.warn('[archive] previous save flush deferred during navigation:', error);
    });
  }
  await invalidateAsyncActions(ctx);
  if (loadToken !== saveLoadSequence) return;
  restoringSave = true;
  restoringSaveOwner = loadToken;
  clearWorldbookRefreshRetry();
  worldbookRefreshSequence += 1;
  state.activeRunId = gameState.runId;
  state.activeSaveId = saveId;
  state.openingGenerationError = null;
  setActiveRunId(gameState.runId);
  setActiveSaveId(saveId);
  state.creatingCharacter = false;
  state.showingSaveList = false;
  replaceConversationMessages(
    state,
    loadedMessages,
    archive?.messageWindow ?? createCompleteMessageWindow(loadedMessages),
  );
  state.statusData = normalizeStatusData(gameState.statusData);
  state.playerProfile = normalizePlayerProfile(
    (gameState.runtimeFlags?.playerProfile as typeof state.playerProfile | undefined) ?? {
      name: meta.playerProfile?.name ?? meta.characterName ?? '',
      personality: meta.playerProfile?.personality ?? meta.personality ?? '',
      appearance: meta.playerProfile?.appearance ?? meta.appearance ?? '',
      className: meta.playerProfile?.className ?? '2年A班',
    },
  );
  state.runtimeFlags = stripGlobalRuntimeFlags(
    JSON.parse(JSON.stringify(gameState.runtimeFlags ?? {})) as Record<string, unknown>,
  );
  delete state.runtimeFlags.hostTimelineBranchId;
  if (recoveryNotice) state.runtimeFlags.saveRecoveryNotice = recoveryNotice;
  state.drawingSettings = normalizeDrawingSettings(state.runtimeFlags.drawingSettings);
  commitDrawingSettingsToRuntimeFlags();
  applyDrawingEnabledPreference();
  state.summaryStore = summaryStore;
  state.memoryDB = memoryDB;
  state.phoneMessages = normalizePhoneMessageStore(state.runtimeFlags.phoneMessages);
  // Worldbook catalogs are derived from the currently bound character, never
  // from the previously opened save. A matching cache may hydrate them below.
  state.plotLibrary = { events: {}, sourceEntryNames: [], loadedAt: 0 };
  state.characterCardLibrary = { cards: {}, loadedAt: 0 };
  cacheStatusData(state.statusData);
  try {
    guardedAdapterSave(state.statusData);
  } catch (error) {
    console.warn('[save-restore] host variable mirror failed; browser save remains playable:', error);
  }
  rebuildRuntimeAfterRestore();
  // Paint the bounded root/state/tail window before fetching the independent
  // summary and memory blocks. Autosave stays fenced by restoringSave until
  // both hashes are validated and installed below.
  suppressRenderPersistence = true;
  render();
  if (archive) {
    try {
      const auxiliary = await loadArchiveAuxiliaryState(archive.root);
      if (loadToken !== saveLoadSequence) return;
      state.summaryStore = auxiliary.summary?.summaryStore ?? createDefaultSummaryStore();
      state.memoryDB = resolveMemoryDBForLoad(
        auxiliary.memory?.memoryDB,
        state.summaryStore,
        gameState.runId,
      );
      if (auxiliary.compatibility?.shujuku) {
        applyArchiveShujukuCompatibilityToRuntimeFlags(
          state.runtimeFlags,
          auxiliary.compatibility.shujuku,
        );
      }
    } catch (error) {
      if (restoringSaveOwner === loadToken) {
        restoringSave = false;
        restoringSaveOwner = 0;
      }
      suppressRenderPersistence = false;
      window.alert(`这个存档的摘要或记忆块无法读取，已阻止进入。\n\n${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  const shujukuRestoreNotice = await restoreLoadedShujukuTableSnapshot({
    loadToken,
    saveId,
    runId: enteringRunId,
  });
  if (loadToken !== saveLoadSequence) {
    if (restoringSaveOwner === loadToken) {
      restoringSave = false;
      restoringSaveOwner = 0;
    }
    return;
  }
  try {
    console.info('[saves:enter]', {
      saveId,
      runId: gameState.runId,
      chatLogCount: loadedMessages.length,
      archiveRevision: archive?.root.revision ?? null,
      indexStats: getIndexStats(state.memoryDB),
      tableCounts: getMemoryDBTableCounts(state.memoryDB),
    });
  } catch (error) {
    console.warn('[saves:enter] diagnostic counters unavailable; restore continues:', error);
  }
  await hydrateRecentWorldbookCache(() => loadToken === saveLoadSequence).catch(error => {
    console.warn('[worldbook] cached catalog hydrate skipped:', error);
    return false;
  });
  if (loadToken !== saveLoadSequence) {
    if (restoringSaveOwner === loadToken) {
      restoringSave = false;
      restoringSaveOwner = 0;
    }
    return;
  }
  restoringSave = false;
  restoringSaveOwner = 0;
  if (recoveryNotice) {
    state.notification = {
      kind: 'status',
      title: '存档已降级恢复',
      preview: recoveryNotice,
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    };
  } else if (shujukuRestoreNotice) {
    state.notification = {
      kind: 'status',
      title: 'shujuku 表快照待恢复',
      preview: shujukuRestoreNotice,
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    };
  }
  render();
  let openingStarted = false;
  const startOpeningIfNeeded = () => {
    if (
      openingStarted ||
      !shouldGenerateOpening ||
      loadToken !== saveLoadSequence ||
      state.activeRunId !== enteringRunId ||
      state.activeSaveId !== saveId ||
      getReaderMessages(state.uiMessages).length !== 0 ||
      state.generating
    ) {
      return;
    }
    openingStarted = true;
    void generateOpeningScene(ctx);
  };
  // A host World Info API can occasionally never settle. Cached/current data
  // is sufficient to let the player start; a late refresh may still update the
  // catalog without holding autosave or the opening scene hostage.
  const openingFallbackTimer = window.setTimeout(() => {
    suppressRenderPersistence = false;
    startOpeningIfNeeded();
  }, 5000);
  void refreshCharacterWorldbookTargets()
    .catch(error => {
      console.warn('[save-restore] refreshCharacterWorldbookTargets failed:', error);
    })
    .finally(() => {
      window.clearTimeout(openingFallbackTimer);
      suppressRenderPersistence = false;
      if (loadToken !== saveLoadSequence || state.activeSaveId !== saveId) return;
      startOpeningIfNeeded();
      if (lastWorldbookRefreshStatus !== 'success' && lastWorldbookRefreshStatus !== 'legitimate-empty') {
        scheduleWorldbookRefreshRetry(enteringRunId);
      }
    });
  });
}

async function returnToTitle() {
  return withTimelineMutation(async () => {
  await waitForHostTimelineWrites();
  const titleLoadToken = ++saveLoadSequence;
  imageRerollSequenceByKey.clear();
  worldbookRefreshSequence += 1;
  if (restoringSaveOwner) restoringSaveOwner = 0;
  restoringSave = false;
  suppressRenderPersistence = false;
  clearWorldbookRefreshRetry();
  await invalidateAsyncActions(ctx);
  if (titleLoadToken !== saveLoadSequence) return;
  // Capture and enqueue the current run before clearing its identity. A plain
  // debounced persist would fire after activeRunId becomes null and silently
  // drop the player's final title-screen transition save.
  const finalSave = state.activeRunId ? flushPendingAutosave() : undefined;
  state.activeRunId = null;
  state.activeSaveId = null;
  state.openingGenerationError = null;
  setActiveRunId(null);
  clearActiveSaveId();
  state.creatingCharacter = false;
  state.showingSaveList = false;
  render();
  void Promise.resolve(finalSave)
    .then(() => Promise.all([flushArchiveRepository(), flushSaveStore()]))
    .catch(error => console.warn('[archive] final save before title deferred:', error));
  });
}

// ── UI actions (thin wrappers that stay in index.ts) ──

function openReaderContextMenu(readerIndex: number, clientX: number, clientY: number, readerId?: string | null) {
  const resolvedReaderIndex = resolveReaderIndex(state, readerIndex, readerId);
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
    canRollbackCompleted: message.role === 'assistant',
    x: clamp(clientX, READER_CONTEXT_MENU_GAP, maxX),
    y: clamp(clientY, READER_CONTEXT_MENU_GAP, maxY),
  };
  render();
}

function openReaderEditor(readerIndex: number, readerId?: string | null) {
  const resolvedReaderIndex = resolveReaderIndex(state, readerIndex, readerId);
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
  return withTimelineMutation(async () => {
  const editing = state.readerEditing;
  if (!editing) return;
  const loadToken = saveLoadSequence;
  const activeSaveId = state.activeSaveId;
  await waitForHostTimelineWrites();
  if (state.readerEditing !== editing) return;
  await invalidateAsyncActions(ctx);
  if (
    state.readerEditing !== editing
    || loadToken !== saveLoadSequence
    || state.activeSaveId !== activeSaveId
  ) return;
  readerMutationSequence += 1;
  const textarea = root?.querySelector<HTMLTextAreaElement>('[data-field="reader-edit-draft"]');
  const nextText = textarea?.value ?? editing.draft;

  const readerMessages = getReaderMessages(state.uiMessages);
  const message = readerMessages[editing.readerIndex];
  if (!message) {
    state.readerEditing = null;
    render();
    return;
  }

  if (!nextText.trim()) {
    state.notification = {
      kind: 'status',
      title: '无法保存空楼层',
      preview: '正文不能为空。',
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    };
    render();
    return;
  }

  const updatedMessage = {
    ...message,
    rawText: nextText,
    text: message.role === 'assistant' ? extractContextReply(nextText) || nextText : nextText,
  };
  state.uiMessages = state.uiMessages.map(item => item.id === message.id ? updatedMessage : item);
  invalidateReaderMessagesCache();
  state.readerEditing = null;
  const saveId = state.activeSaveId;
  const persisted = serializeMessages([updatedMessage])[0];
  const archiveGameState = buildGameState();
  const archiveRuntimeState = captureRuntimeSaveState();
  ctx.persistConversation();
  render();

  if (saveId && persisted && hasArchiveSaveSync(saveId)) {
    await replaceArchiveFloorMessage({
      saveId,
      messageId: updatedMessage.id,
      message: persisted,
      gameState: archiveGameState,
      runtimeState: archiveRuntimeState,
    }).catch(error => console.warn('[archive] edited floor commit deferred:', error));
  }
  });
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

async function loadReaderMessageWindow(
  startFloor: number,
  endFloorExclusive: number,
  focus: 'first' | 'last' | number,
) {
  const saveId = state.activeSaveId;
  if (!saveId || !hasArchiveSaveSync(saveId)) return false;
  const loadToken = saveLoadSequence;
  const windowToken = ++readerWindowLoadSequence;
  const next = await getArchiveMessageWindow(saveId, startFloor, endFloorExclusive).catch(error => {
    console.warn('[archive] reader window load failed:', error);
    return null;
  });
  if (
    !next
    || windowToken !== readerWindowLoadSequence
    || loadToken !== saveLoadSequence
    || state.activeSaveId !== saveId
  ) {
    return false;
  }
  const messages = deserializeArchiveFloorMessages(next.floors);
  replaceConversationMessages(state, messages, next);
  const count = getReaderMessages(state.uiMessages).length;
  state.focusedMessageIndex = typeof focus === 'number'
    ? Math.max(0, Math.min(Math.floor(focus), count - 1))
    : focus === 'first'
      ? 0
      : Math.max(0, count - 1);
  state.focusedMessagePage = 0;
  return true;
}

async function reloadReaderWindowAfterArchiveMutation(
  receipt: { floorCount: number },
  options: { startFloor?: number; focus?: 'first' | 'last' | number } = {},
) {
  const floorCount = Math.max(0, Math.floor(Number(receipt.floorCount) || 0));
  const requestedStart = options.startFloor ?? Math.max(0, floorCount - 16);
  const startFloor = floorCount > 0
    ? Math.max(0, Math.min(Math.floor(requestedStart), floorCount - 1))
    : 0;
  return loadReaderMessageWindow(
    startFloor,
    Math.min(floorCount, startFloor + 16),
    options.focus ?? 'last',
  );
}

async function ensureHeadMessageWindow() {
  if (
    isMessageWindowAtHead(state.messageWindow)
    && state.messageWindow.endFloorExclusive - state.messageWindow.startFloor <= 16
  ) {
    return true;
  }
  return loadReaderMessageWindow(
    Math.max(0, state.messageWindow.totalFloorCount - 16),
    state.messageWindow.totalFloorCount,
    'last',
  );
}

async function focusMessage(delta: number) {
  const nextIndex = clampFocusedMessageIndex(state, state.focusedMessageIndex + delta);
  if (nextIndex === state.focusedMessageIndex) {
    const windowStart = delta < 0
      ? Math.max(0, state.messageWindow.startFloor - 16)
      : state.messageWindow.endFloorExclusive;
    const windowEnd = delta < 0
      ? state.messageWindow.startFloor
      : Math.min(state.messageWindow.totalFloorCount, windowStart + 16);
    const loaded = await loadReaderMessageWindow(windowStart, windowEnd, delta < 0 ? 'last' : 'first');
    if (!loaded) {
      ctx.showNotification({
        kind: 'status',
        title: '这段旧楼层暂时读不到',
        preview: '当前页面和存档没有改变，可以稍后再翻。',
        targetTab: 'summary',
        timestamp: formatTime(state.statusData.world.currentTime),
      });
      render();
      return;
    }
    flipDirection = delta > 0 ? 'forward' : 'backward';
    ctx.closeReaderContextMenu(false);
    render();
    flipDirection = '';
    return;
  }
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

function resolveArchiveFloorIndex(readerIndex: number): number | null {
  const target = getReaderMessageByIndex(state, readerIndex);
  if (!target) return null;
  let nextFloorIndex = state.messageWindow.startFloor;
  let pendingUser = false;
  for (const message of state.uiMessages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      if (pendingUser) nextFloorIndex += 1;
      pendingUser = true;
      if (message.id === target.id) return nextFloorIndex;
      continue;
    }
    const currentFloorIndex = nextFloorIndex;
    if (message.id === target.id) return currentFloorIndex;
    nextFloorIndex += 1;
    pendingUser = false;
  }
  return null;
}

function captureReaderRollbackState() {
  return structuredClone({
    statusData: state.statusData,
    playerProfile: state.playerProfile,
    phoneMessages: state.phoneMessages,
    drawingSettings: state.drawingSettings,
    summaryStore: state.summaryStore,
    memoryDB: state.memoryDB,
    runtimeFlags: state.runtimeFlags,
    uiMessages: state.uiMessages,
    messageWindow: state.messageWindow,
    backgroundTasks: state.backgroundTasks,
    focusedMessageIndex: state.focusedMessageIndex,
    focusedMessagePage: state.focusedMessagePage,
    currentGenerationId: state.currentGenerationId,
    finalizedGenerationId: state.finalizedGenerationId,
    notification: state.notification,
  });
}

function restoreReaderRollbackState(snapshot: ReturnType<typeof captureReaderRollbackState>) {
  state.statusData = snapshot.statusData;
  state.playerProfile = snapshot.playerProfile;
  state.phoneMessages = snapshot.phoneMessages;
  state.drawingSettings = snapshot.drawingSettings;
  state.summaryStore = snapshot.summaryStore;
  state.memoryDB = snapshot.memoryDB;
  state.runtimeFlags = snapshot.runtimeFlags;
  state.uiMessages = snapshot.uiMessages;
  state.messageWindow = snapshot.messageWindow;
  state.backgroundTasks = snapshot.backgroundTasks;
  state.focusedMessageIndex = snapshot.focusedMessageIndex;
  state.focusedMessagePage = snapshot.focusedMessagePage;
  state.currentGenerationId = snapshot.currentGenerationId;
  state.finalizedGenerationId = snapshot.finalizedGenerationId;
  state.notification = snapshot.notification;
}

type ShujukuArchiveCommit = (
  compatibility: ArchiveShujukuCompatibility | null,
) => Promise<ArchiveRollbackReceipt | null>;

async function rollbackReaderInputWithArchive(
  readerIndex: number,
  options: {
    timelineMutationOwner?: symbol;
    shujukuHandoffCutoff?: number;
    shujukuHandoffId?: string;
    shujukuCompatibilityOverride?: ArchiveShujukuCompatibility | null;
    prepareShujukuBaseline?: (
      baseline: ArchiveFloorShujukuBaseline,
      floor: NonNullable<Awaited<ReturnType<typeof getArchiveFloor>>>,
    ) => {
      kind: 'transaction_after_rollback';
      run: (commitArchive: ShujukuArchiveCommit) => Promise<ArchiveRollbackReceipt>;
    } | null;
    onShujukuBaselineUnavailable?: (baseline: ArchiveFloorShujukuBaseline) => void;
    onShujukuCompatibilityRestored?: (compatibility: ArchiveShujukuCompatibility | null) => void;
    onArchiveCommitFailed?: (error: unknown) => void;
    requireAuthoritativeStatusBaseline?: boolean;
  } = {},
) {
  return withTimelineMutation(async () => {
  const requestedLoadToken = saveLoadSequence;
  const requestedSaveId = state.activeSaveId;
  await waitForHostTimelineWrites();
  if (requestedLoadToken !== saveLoadSequence || state.activeSaveId !== requestedSaveId) return null;
  await invalidateAsyncActions(ctx);
  if (requestedLoadToken !== saveLoadSequence || state.activeSaveId !== requestedSaveId) return null;
  const mutationToken = ++readerMutationSequence;
  const loadToken = saveLoadSequence;
  const saveId = state.activeSaveId;
  const isCurrent = () => mutationToken === readerMutationSequence
    && loadToken === saveLoadSequence
    && state.activeSaveId === saveId;
  const floorIndex = saveId && hasArchiveSaveSync(saveId) ? resolveArchiveFloorIndex(readerIndex) : null;
  let floor: Awaited<ReturnType<typeof getArchiveFloor>> = null;
  if (saveId && floorIndex !== null) {
    try {
      floor = await getArchiveFloor(saveId, floorIndex);
    } catch (error) {
      if (options.prepareShujukuBaseline) options.onArchiveCommitFailed?.(error);
      else console.warn('[archive] rollback floor read failed:', error);
      return null;
    }
  }
  if (!isCurrent()) return null;
  if (options.requireAuthoritativeStatusBaseline && floor && !hasAuthoritativeFloorStatusData(floor.beforeTurnState)) {
    options.onArchiveCommitFailed?.(new Error('重 roll 目标缺少权威的轮前时间快照，正文时间线未改变。'));
    return null;
  }
  let shujukuBaselinePreparation: ReturnType<NonNullable<typeof options.prepareShujukuBaseline>> | undefined;
  if (options.prepareShujukuBaseline) {
    if (!saveId || floorIndex === null || !floor) {
      options.onArchiveCommitFailed?.(new Error('重 roll 目标没有可验证的归档楼层。'));
      return null;
    }
    const handoffCutoff = options.shujukuHandoffCutoff;
    if (typeof handoffCutoff !== 'number' || !Number.isInteger(handoffCutoff) || handoffCutoff < 0) {
      options.onArchiveCommitFailed?.(new Error('当前 shujuku handoff 缺少有效的接通消息边界。'));
      return null;
    }
    const handoffId = options.shujukuHandoffId?.trim();
    if (!handoffId) {
      options.onArchiveCommitFailed?.(new Error('当前 shujuku handoff 缺少有效的接通身份。'));
      return null;
    }
    let baseline: ArchiveFloorShujukuBaseline;
    try {
      baseline = await getArchiveFloorBeforeTurnShujukuBaseline(
        saveId,
        floorIndex,
        handoffCutoff,
        handoffId,
      );
    } catch (error) {
      options.onArchiveCommitFailed?.(error);
      return null;
    }
    if (!isCurrent()) return null;
    shujukuBaselinePreparation = options.prepareShujukuBaseline(baseline, floor);
    if (!shujukuBaselinePreparation) {
      options.onShujukuBaselineUnavailable?.(baseline);
      return null;
    }
  }
  const rollbackState = options.prepareShujukuBaseline ? captureReaderRollbackState() : null;
  const target = await rollbackConversation(state, readerIndex, win, hostTimeline, isCurrent);
  if (!target) return null;
  if (!isCurrent()) return null;
  if (floor) {
    try {
      restoreFloorStateSnapshot(state, floor.beforeTurnState);
    } catch (error) {
      console.warn('[archive] exact input snapshot was invalid; keeping local rollback state:', error);
    }
  }
  const hasShujukuCompatibilityOverride = Object.prototype.hasOwnProperty.call(
    options,
    'shujukuCompatibilityOverride',
  );
  if (hasShujukuCompatibilityOverride) {
    applyArchiveShujukuCompatibilityToRuntimeFlags(
      state.runtimeFlags,
      options.shujukuCompatibilityOverride,
    );
  }
  const commitArchive: ShujukuArchiveCommit = async compatibility => {
    if (!isCurrent()) throw new Error('重 roll 事务在归档提交前已失去当前时间线所有权。');
    if (!saveId || floorIndex === null || !hasArchiveSaveSync(saveId)) return null;
    return truncateArchiveFromAssistant({
      saveId,
      floorIndex,
      gameState: buildGameState(),
      runtimeState: captureRuntimeSaveState(),
      shujukuCompatibilityOverride: compatibility,
    });
  };
  let receipt: ArchiveRollbackReceipt | null = null;
  let archiveError: unknown = null;
  if (shujukuBaselinePreparation?.kind === 'transaction_after_rollback') {
    try {
      receipt = await shujukuBaselinePreparation.run(commitArchive);
      if (!receipt) throw new Error('重 roll 归档提交没有返回成功凭据。');
    } catch (error) {
      archiveError = error;
    }
    if (!receipt) {
      if (rollbackState && isCurrent()) restoreReaderRollbackState(rollbackState);
      options.onArchiveCommitFailed?.(
        archiveError ?? new Error('重 roll 归档提交没有返回成功凭据。'),
      );
      return null;
    }
  } else if (saveId && floorIndex !== null && hasArchiveSaveSync(saveId)) {
    receipt = await truncateArchiveFromAssistant({
      saveId,
      floorIndex,
      gameState: buildGameState(),
      runtimeState: captureRuntimeSaveState(),
      ...(options.shujukuCompatibilityOverride !== undefined
        ? { shujukuCompatibilityOverride: options.shujukuCompatibilityOverride }
        : {}),
    }).catch(error => {
      archiveError = error;
      return null;
    });
    if (!receipt && archiveError) {
      // Generic rollback keeps its historical best-effort behavior.
      console.warn('[archive] input rollback commit deferred:', archiveError);
    }
  }
  if (receipt && isCurrent()) {
    options.onShujukuCompatibilityRestored?.(receipt.restoredCompatibility);
    applyArchiveShujukuCompatibilityToRuntimeFlags(state.runtimeFlags, receipt.restoredCompatibility);
    await reloadReaderWindowAfterArchiveMutation(receipt);
  }
  return isCurrent() ? target : null;
  }, options.timelineMutationOwner);
}

async function rollbackToReaderInput(readerIndex: number) {
  const timelineMutationOwner = Symbol('reader-rollback');
  return withTimelineMutation(async () => {
    const rollback = await rollbackReaderInputToCheckpoint(readerIndex, {
      timelineMutationOwner,
      actionLabel: '回溯',
    });
    if (!rollback?.target.sourceUserText) return;
    state.draft = rollback.target.sourceUserText;
    gameDevelopmentController.restoreEditorAfterRollback(rollback.target.sourceUserText);
    guardedAdapterSave(state.statusData);
    ctx.persistConversation();
    ctx.closeReaderContextMenu(false);
    render();
    if (!rollback.routeRestored) {
      ctx.showNotification({
        kind: 'status',
        title: '回溯需复核',
        preview: '归档回执中的 shujuku 表快照未通过身份校验，请刷新后重新接通。',
        targetTab: 'summary',
        timestamp: formatTime(state.statusData.world.currentTime),
      });
    }
    focusComposer();
  }, timelineMutationOwner);
}

function isV07RouteChoiceBlockingMainText(): boolean {
  return isV07RouteChoiceRequired({
    currentTime: state.statusData.world.currentTime,
    currentMainEventId: state.statusData.world.currentMainEventId,
    mainEvents: state.statusData.world.mainEvents,
    hasChoice: Boolean(readActivePlotRouteChoice(state.memoryDB, 'v07')),
  });
}

async function rollbackAfterReaderFloor(readerIndex: number) {
  return withTimelineMutation(async () => {
    const requestedLoadToken = saveLoadSequence;
    const requestedSaveId = state.activeSaveId;
    await waitForHostTimelineWrites();
    if (requestedLoadToken !== saveLoadSequence || state.activeSaveId !== requestedSaveId) return;
    await invalidateAsyncActions(ctx);
    if (requestedLoadToken !== saveLoadSequence || state.activeSaveId !== requestedSaveId) return;
    const mutationToken = ++readerMutationSequence;
    const loadToken = saveLoadSequence;
    const saveId = state.activeSaveId;
    const isCurrent = () => mutationToken === readerMutationSequence
      && loadToken === saveLoadSequence
      && state.activeSaveId === saveId;
    const floorIndex = saveId && hasArchiveSaveSync(saveId) ? resolveArchiveFloorIndex(readerIndex) : null;
    const floor = saveId && floorIndex !== null
      ? await getArchiveFloor(saveId, floorIndex).catch(() => null)
      : null;
    if (!isCurrent()) return;

    const shujukuBindingRead = captureShujukuRerollBinding();
    if (shujukuBindingRead.kind === 'invalid') {
      ctx.showNotification({
        kind: 'status',
        title: '回溯输出已停止',
        preview: `当前 shujuku 连接无法建立安全基线：${shujukuBindingRead.reason}。正文和表格均未改变。`,
        targetTab: 'summary',
        timestamp: formatTime(state.statusData.world.currentTime),
      });
      render();
      return;
    }
    const shujukuBinding = shujukuBindingRead.kind === 'active'
      ? shujukuBindingRead.binding
      : null;
    let shujukuBaseline: ArchiveFloorShujukuBaseline | null = null;
    if (shujukuBinding) {
      if (!saveId || floorIndex === null || !floor?.afterTurnState) {
        ctx.showNotification({
          kind: 'status',
          title: '回溯输出已停止',
          preview: '保留楼层缺少可验证的轮后 shujuku 表快照；正文和表格均未改变。',
          targetTab: 'summary',
          timestamp: formatTime(state.statusData.world.currentTime),
        });
        render();
        return;
      }
      try {
        shujukuBaseline = await getArchiveFloorAfterTurnShujukuBaseline(
          saveId,
          floorIndex,
          shujukuBinding.handoff.cutoffFloor,
          shujukuBinding.handoff.handoffId,
        );
      } catch (error) {
        ctx.showNotification({
          kind: 'status',
          title: '回溯输出已停止',
          preview: `轮后 shujuku 表快照读取失败：${error instanceof Error ? error.message : String(error)}。正文和表格均未改变。`,
          targetTab: 'summary',
          timestamp: formatTime(state.statusData.world.currentTime),
        });
        render();
        return;
      }
      if (shujukuBaseline.kind === 'missing_post_handoff') {
        ctx.showNotification({
          kind: 'status',
          title: '回溯输出已停止',
          preview: '保留楼层位于 shujuku 接通后，但归档缺少当时的轮后表快照；正文和表格均未改变。',
          targetTab: 'summary',
          timestamp: formatTime(state.statusData.world.currentTime),
        });
        render();
        return;
      }
      if (
        shujukuBaseline.kind === 'checkpoint'
        && !createShujukuRerollCompatibility(shujukuBinding, shujukuBaseline.checkpoint)
      ) {
        ctx.showNotification({
          kind: 'status',
          title: '回溯输出已停止',
          preview: '保留楼层的轮后 shujuku 表快照未通过身份校验；正文和表格均未改变。',
          targetTab: 'summary',
          timestamp: formatTime(state.statusData.world.currentTime),
        });
        render();
        return;
      }
    }

    const rollbackState = captureReaderRollbackState();
    const restored = await rollbackAfterCompletedReaderMessage(state, readerIndex, win, hostTimeline, isCurrent);
    if (!restored) return;
    if (!isCurrent()) return;
    if (floor?.afterTurnState) {
      try {
        restoreFloorStateSnapshot(state, floor.afterTurnState);
      } catch (error) {
        console.warn('[archive] exact completed-floor snapshot was invalid; keeping local rollback state:', error);
      }
    }

    let receipt: ArchiveRollbackReceipt | null = null;
    if (saveId && floorIndex !== null && hasArchiveSaveSync(saveId)) {
      const commitArchive: ShujukuArchiveCommit = compatibility => truncateArchiveAfterFloor({
        saveId,
        floorIndex,
        gameState: buildGameState(),
        runtimeState: captureRuntimeSaveState(),
        shujukuCompatibilityOverride: compatibility,
      });
      try {
        if (shujukuBinding && shujukuBaseline?.kind === 'checkpoint') {
          receipt = await commitShujukuRerollCheckpoint({
            binding: shujukuBinding,
            checkpoint: shujukuBaseline.checkpoint,
            commitArchive,
          });
        } else if (shujukuBinding && shujukuBaseline?.kind === 'pre_handoff') {
          receipt = await commitArchive(null);
        } else {
          receipt = await truncateArchiveAfterFloor({
            saveId,
            floorIndex,
            gameState: buildGameState(),
            runtimeState: captureRuntimeSaveState(),
          });
        }
        if (!receipt && shujukuBinding) throw new Error('轮后 shujuku 表恢复没有取得归档提交凭据。');
      } catch (error) {
        if (isCurrent()) restoreReaderRollbackState(rollbackState);
        ctx.showNotification({
          kind: 'status',
          title: '回溯输出失败',
          preview: `${error instanceof Error ? error.message : String(error)}。正文时间线已恢复到操作前状态。`,
          targetTab: 'summary',
          timestamp: formatTime(state.statusData.world.currentTime),
        });
        render();
        return;
      }
      if (receipt && isCurrent()) {
        applyArchiveShujukuCompatibilityToRuntimeFlags(state.runtimeFlags, receipt.restoredCompatibility);
        await reloadReaderWindowAfterArchiveMutation(receipt);
      }
    }
    if (!isCurrent()) return;
    guardedAdapterSave(state.statusData);
    ctx.persistConversation();
    ctx.closeReaderContextMenu(false);
    render();
  });
}

function growComposerInput(textarea: HTMLTextAreaElement) {
  const touchLayout = window.innerWidth <= 700 || window.matchMedia('(pointer: coarse)').matches;
  const previousHeight = textarea.style.height;
  textarea.style.height = 'auto';
  const contentHeight = textarea.scrollHeight;
  const minimumHeight = touchLayout ? 88 : 64;
  const manuallyExpandedHeight = touchLayout ? 0 : Number.parseFloat(previousHeight) || 0;
  textarea.style.height = `${Math.max(minimumHeight, contentHeight, manuallyExpandedHeight)}px`;
  textarea.style.overflowY = 'hidden';
}

function syncComposerSubmitAvailability(textarea: HTMLTextAreaElement) {
  if (!state.runtimeFlags.gameDevelopmentChoiceEdit) return;
  const button = textarea.closest<HTMLElement>('.paper-composer-card')?.querySelector<HTMLButtonElement>('[data-action="send"]');
  if (!button || state.generating) return;
  button.disabled = !textarea.value.trim();
}

async function submitMainMessage(
  options: {
    text?: string;
    keepDraft?: boolean;
    clearDraftOnSuccess?: boolean;
    reuseLatestUserMessage?: boolean;
    timelineMutationOwner?: symbol;
  } = {},
) {
  if (restoringSave || isTimelineMutationFenced(options.timelineMutationOwner)) return;
  if (!(await ensureHeadMessageWindow())) {
    ctx.showNotification({
      kind: 'status',
      title: '最新楼层暂时无法读取',
      preview: '没有发送新内容，旧历史也没有被覆盖。请稍后重试。',
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return;
  }
  if (restoringSave || isTimelineMutationFenced(options.timelineMutationOwner)) return;
  const userInput = (options.text ?? state.draft).trim();
  if (await gameDevelopmentController.submitFromMainDraft(userInput)) return;
  if (isV07RouteChoiceBlockingMainText()) {
    // 中文注释：SAE_07-8 已结束但玩家尚未选线时，DDL 必须先于下一段正文。
    // 这里只阻止新的主正文提交，不伪造 choice，也不阻止玩家查看刚完成的事件楼层。
    openPhone('app:studio');
    ctx.showNotification({
      kind: 'status',
      title: '请先决定最终路线',
      preview: '第七章已经结束，请在企划页从“留下 / 单飞 / 朱音”中亲自选择一条路线。',
      targetTab: 'status',
      phoneRoute: 'app:studio',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return;
  }
  await submitMessage(ctx, options);
}

type ShujukuRerollBinding = {
  compatibility: ShujukuCompatibilityState;
  handoff: ShujukuHandoffEnvelope;
  tableSnapshot: ShujukuTableSnapshot;
};

type ShujukuRerollBindingRead =
  | { kind: 'inactive' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'active'; binding: ShujukuRerollBinding };

function captureShujukuRerollBinding(): ShujukuRerollBindingRead {
  const result = inspectCommittedShujukuBinding(state.runtimeFlags, {
    saveId: state.activeSaveId,
    runId: state.activeRunId,
  });
  if (result.kind !== 'active') return result;
  return {
    kind: 'active',
    binding: JSON.parse(JSON.stringify(result.binding)) as ShujukuRerollBinding,
  };
}

async function createCommittedShujukuHandoff(input: {
  currentCompatibility: Partial<ShujukuCompatibilityState> | null;
  saveId: string;
  runId: string;
  branchId: string;
  timelineAnchor: string;
  cutoffFloor: number;
  isolationKey: string;
  capabilityHash: string;
  tableSnapshot: ShujukuTableSnapshot;
  sourceProjection: unknown;
}): Promise<ArchiveShujukuCompatibility> {
  const mappingVersion = SHUJUKU_NATIVE_HANDOFF_VERSION;
  const handoffId = `${input.runId}:${input.saveId}:${input.branchId}:${input.timelineAnchor}:${input.cutoffFloor}:${mappingVersion}`;
  const sourceHash = (await hashArchiveValue({
    runId: input.runId,
    saveId: input.saveId,
    branchId: input.branchId,
    timelineAnchor: input.timelineAnchor,
    cutoffFloor: input.cutoffFloor,
    mappingVersion,
    source: input.sourceProjection,
    tableHash: input.tableSnapshot.tableHash,
  })).hash;
  const handoff: ShujukuHandoffEnvelope = {
    handoffId,
    runId: input.runId,
    saveId: input.saveId,
    branchId: input.branchId,
    timelineAnchor: input.timelineAnchor,
    cutoffFloor: input.cutoffFloor,
    mappingVersion,
    sourceHash,
    tableHash: input.tableSnapshot.tableHash,
    status: 'committed',
  };
  const compatibility: ShujukuCompatibilityState = {
    ...input.currentCompatibility,
    saveId: input.saveId,
    runId: input.runId,
    route: 'shujuku',
    handoffPhase: 'committed',
    capabilityHash: input.capabilityHash,
    isolationKey: input.isolationKey,
    handoffId,
    branchId: input.branchId,
    lastTableHash: input.tableSnapshot.tableHash,
    mappingVersion,
    lastCheckedAt: new Date().toISOString(),
  };
  delete compatibility.lastError;
  return {
    state: compatibility,
    handoff,
    tableSnapshot: JSON.parse(JSON.stringify(input.tableSnapshot)) as ShujukuTableSnapshot,
  };
}

async function commitShujukuRerollCheckpoint(input: {
  binding: ShujukuRerollBinding;
  checkpoint: ArchiveShujukuCompatibility;
  commitArchive: ShujukuArchiveCommit;
}): Promise<ArchiveRollbackReceipt> {
  const compatibility = createShujukuRerollCompatibility(input.binding, input.checkpoint);
  const snapshot = compatibility?.tableSnapshot;
  const isolationKey = compatibility?.state.isolationKey?.trim();
  if (!compatibility || !snapshot || !isolationKey) {
    throw new Error('归档中的 shujuku 轮前表快照未通过身份校验。');
  }
  return runShujukuTablesHandoffTransaction(
    win,
    isolationKey,
    snapshot.tables,
    async imported => {
      // The transaction already verifies every archived field after restore.
      // shujuku may add export defaults, so its normalized snapshot can have a
      // different hash without changing any archived table content.
      const committedCompatibility: ArchiveShujukuCompatibility = {
        ...compatibility,
        state: {
          ...compatibility.state,
          capabilityHash: imported.capabilityHash,
          lastTableHash: imported.tableSnapshot.tableHash,
          lastCheckedAt: new Date().toISOString(),
        },
        tableSnapshot: imported.tableSnapshot,
      };
      const receipt = await input.commitArchive(committedCompatibility);
      if (!receipt) throw new Error('shujuku 轮前表恢复没有取得归档提交凭据。');
      return receipt;
    },
  );
}

function isExpectedCommittedShujukuCompatibility(
  expected: ArchiveShujukuCompatibility | null,
  actual: ArchiveShujukuCompatibility | null,
): boolean {
  if (!expected || !actual || !expected.handoff || !actual.handoff || !expected.tableSnapshot || !actual.tableSnapshot) {
    return false;
  }
  return expected.state.route === 'shujuku'
    && actual.state.route === 'shujuku'
    && expected.state.handoffPhase === 'committed'
    && actual.state.handoffPhase === 'committed'
    && actual.state.saveId === expected.state.saveId
    && actual.state.runId === expected.state.runId
    && actual.state.branchId === expected.state.branchId
    && actual.state.isolationKey === expected.state.isolationKey
    && actual.state.handoffId === expected.state.handoffId
    && actual.state.mappingVersion === SHUJUKU_NATIVE_HANDOFF_VERSION
    && actual.state.lastTableHash === expected.tableSnapshot.tableHash
    && actual.handoff.handoffId === expected.handoff.handoffId
    && actual.handoff.branchId === expected.handoff.branchId
    && actual.handoff.sourceHash === expected.handoff.sourceHash
    && actual.handoff.cutoffFloor === expected.handoff.cutoffFloor
    && actual.handoff.tableHash === expected.handoff.tableHash
    && actual.tableSnapshot.tableHash === expected.tableSnapshot.tableHash;
}

function isRestoredShujukuRouteValidAfterReroll(
  binding: ShujukuRerollBinding,
  restored: ArchiveShujukuCompatibility | null,
): boolean {
  const expected = createShujukuRerollCompatibility(binding, restored);
  return Boolean(expected && isExpectedCommittedShujukuCompatibility(expected, restored));
}

function createShujukuRerollCompatibility(
  binding: ShujukuRerollBinding,
  checkpoint: ArchiveShujukuCompatibility | null,
): ArchiveShujukuCompatibility | null {
  if (!isValidShujukuRerollCheckpoint(binding, checkpoint)) return null;
  const compatibility: ShujukuCompatibilityState = {
    ...binding.compatibility,
    route: 'shujuku',
    handoffPhase: 'committed',
    lastTableHash: checkpoint.tableSnapshot.tableHash,
  };
  delete compatibility.lastError;
  return {
    state: compatibility,
    handoff: JSON.parse(JSON.stringify(binding.handoff)),
    tableSnapshot: JSON.parse(JSON.stringify(checkpoint.tableSnapshot)),
  };
}

function isValidShujukuRerollCheckpoint(
  binding: ShujukuRerollBinding,
  checkpoint: ArchiveShujukuCompatibility | null,
): checkpoint is ArchiveShujukuCompatibility & { tableSnapshot: ShujukuTableSnapshot } {
  const snapshot = checkpoint?.tableSnapshot;
  const handoff = binding.handoff;
  const checkpointHandoff = checkpoint?.handoff;
  return Boolean(
    checkpoint
    && snapshot
    && typeof snapshot.tableHash === 'string'
    && snapshot.tableHash.trim()
    && snapshot.tables
    && typeof snapshot.tables === 'object'
    && !Array.isArray(snapshot.tables)
    && checkpoint.state.route === 'shujuku'
    && checkpoint.state.handoffPhase === 'committed'
    && checkpoint.state.mappingVersion === SHUJUKU_NATIVE_HANDOFF_VERSION
    && checkpoint.state.handoffId === binding.compatibility.handoffId
    && (checkpoint.state.lastTableHash === undefined
      || checkpoint.state.lastTableHash === snapshot.tableHash)
    && handoff
    && handoff.status === 'committed'
    && typeof binding.compatibility.handoffId === 'string'
    && binding.compatibility.handoffId.trim()
    && handoff.handoffId === binding.compatibility.handoffId
    && handoff.branchId === binding.compatibility.branchId
    && checkpoint.state.branchId === binding.compatibility.branchId
    && checkpointHandoff
    && checkpointHandoff.status === 'committed'
    && checkpointHandoff.mappingVersion === SHUJUKU_NATIVE_HANDOFF_VERSION
    && checkpointHandoff.handoffId === handoff.handoffId
    && checkpointHandoff.branchId === handoff.branchId
    && checkpointHandoff.saveId === handoff.saveId
    && checkpointHandoff.runId === handoff.runId
    && checkpointHandoff.timelineAnchor === handoff.timelineAnchor
    && checkpointHandoff.cutoffFloor === handoff.cutoffFloor
    && checkpointHandoff.sourceHash === handoff.sourceHash
    && checkpointHandoff.tableHash === handoff.tableHash
    && (binding.compatibility.isolationKey === undefined
      || checkpoint.state.isolationKey === binding.compatibility.isolationKey)
    && (binding.compatibility.saveId === undefined
      || (handoff.saveId === binding.compatibility.saveId
        && checkpoint.state.saveId === binding.compatibility.saveId))
    && (binding.compatibility.runId === undefined
      || (handoff.runId === binding.compatibility.runId
        && checkpoint.state.runId === binding.compatibility.runId)),
  );
}

type ReaderInputCheckpointRollback = {
  target: NonNullable<Awaited<ReturnType<typeof rollbackReaderInputWithArchive>>>;
  route: NarrativeRoute;
  restoredShujukuCompatibility: ArchiveShujukuCompatibility | null;
  routeRestored: boolean;
};

async function rollbackReaderInputToCheckpoint(
  readerIndex: number,
  options: {
    timelineMutationOwner: symbol;
    actionLabel: '回溯' | '重 roll';
    requireAuthoritativeStatusBaseline?: boolean;
  },
): Promise<ReaderInputCheckpointRollback | null> {
  const shujukuBindingRead = captureShujukuRerollBinding();
  const stoppedTitle = options.actionLabel === '重 roll' ? '重 roll 已停止' : '回溯已停止';
  if (shujukuBindingRead.kind === 'invalid') {
    ctx.showNotification({
      kind: 'status',
      title: stoppedTitle,
      preview: `当前 shujuku 连接无法建立安全基线：${shujukuBindingRead.reason}。正文时间线未改变。`,
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return null;
  }

  const shujukuRerollBinding = shujukuBindingRead.kind === 'active'
    ? shujukuBindingRead.binding
    : null;
  let rollbackRoute: NarrativeRoute = shujukuRerollBinding ? 'shujuku' : 'island';
  let restoredShujukuCompatibility: ArchiveShujukuCompatibility | null = null;
  let shujukuBaselineFailure = '';
  let rollbackTransactionFailure = '';
  let tableRestoreFailed = false;
  const target = await rollbackReaderInputWithArchive(readerIndex, {
    timelineMutationOwner: options.timelineMutationOwner,
    requireAuthoritativeStatusBaseline: options.requireAuthoritativeStatusBaseline,
    ...(!shujukuRerollBinding ? { shujukuCompatibilityOverride: null } : {}),
    ...(shujukuRerollBinding
      ? {
          shujukuHandoffCutoff: shujukuRerollBinding.handoff.cutoffFloor,
          shujukuHandoffId: shujukuRerollBinding.handoff.handoffId,
          prepareShujukuBaseline: (
            baseline: ArchiveFloorShujukuBaseline,
            floor: NonNullable<Awaited<ReturnType<typeof getArchiveFloor>>>,
          ) => {
            if (baseline.kind === 'pre_handoff') {
              void floor;
              rollbackRoute = 'island';
              return {
                kind: 'transaction_after_rollback' as const,
                run: async (commitArchive: ShujukuArchiveCommit) => {
                  const receipt = await commitArchive(null);
                  if (!receipt) throw new Error('接通点前的 Island 回溯没有取得归档提交凭据。');
                  return receipt;
                },
              };
            }
            if (baseline.kind === 'missing_post_handoff') {
              shujukuBaselineFailure = '该楼层位于 shujuku 接通后，但归档缺少当时的轮前表快照。';
              return null;
            }
            const prepared = createShujukuRerollCompatibility(
              shujukuRerollBinding,
              baseline.checkpoint,
            );
            if (!prepared) {
              shujukuBaselineFailure = '归档中的 shujuku 轮前表快照未通过身份或 hash 校验。';
              return null;
            }
            return {
              kind: 'transaction_after_rollback' as const,
              run: (commitArchive: ShujukuArchiveCommit) => commitShujukuRerollCheckpoint({
                binding: shujukuRerollBinding,
                checkpoint: baseline.checkpoint,
                commitArchive,
              }),
            };
          },
          onShujukuBaselineUnavailable: (baseline: ArchiveFloorShujukuBaseline) => {
            if (shujukuBaselineFailure) return;
            shujukuBaselineFailure = baseline.kind === 'missing_post_handoff'
              ? '该楼层位于 shujuku 接通后，但归档缺少当时的轮前表快照。'
              : '该楼层的 shujuku 轮前表快照无法安全恢复。';
          },
        }
      : {}),
    onArchiveCommitFailed: (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('权威的轮前时间快照')) shujukuBaselineFailure = detail;
      else rollbackTransactionFailure = detail;
      tableRestoreFailed = detail.includes('原表恢复失败');
    },
    onShujukuCompatibilityRestored: compatibility => {
      restoredShujukuCompatibility = compatibility;
    },
  });

  if (!target?.sourceUserText) {
    if (rollbackTransactionFailure || shujukuBaselineFailure) {
      const transactionLabel = options.actionLabel === '重 roll' ? '重生成事务' : '回溯事务';
      ctx.showNotification({
        kind: 'status',
        title: stoppedTitle,
        preview: rollbackTransactionFailure
          ? tableRestoreFailed
            ? `${transactionLabel}失败：${rollbackTransactionFailure}。已停止继续；当前 shujuku 连接不能视为操作前状态，请刷新后重新接通。`
            : `${transactionLabel}失败：${rollbackTransactionFailure}。正文时间线和当前 shujuku 连接已恢复到操作前状态。`
          : `${shujukuBaselineFailure} 正文时间线和当前 shujuku 连接均未改变。`,
        targetTab: 'summary',
        timestamp: formatTime(state.statusData.world.currentTime),
      });
    }
    return null;
  }

  const routeRestored = rollbackRoute === 'island'
    ? restoredShujukuCompatibility === null
    : Boolean(
        shujukuRerollBinding
        && isRestoredShujukuRouteValidAfterReroll(shujukuRerollBinding, restoredShujukuCompatibility),
      );
  return {
    target,
    route: rollbackRoute,
    restoredShujukuCompatibility,
    routeRestored,
  };
}

async function rerunReaderMessage(readerIndex: number) {
  const timelineMutationOwner = Symbol('reader-reroll');
  return withTimelineMutation(async () => {
    const rollback = await rollbackReaderInputToCheckpoint(readerIndex, {
      timelineMutationOwner,
      actionLabel: '重 roll',
      requireAuthoritativeStatusBaseline: true,
    });
    if (!rollback?.target.sourceUserText) return;
    state.draft = rollback.target.sourceUserText;
    guardedAdapterSave(state.statusData);
    ctx.persistConversation();
    ctx.closeReaderContextMenu(false);
    render();
    if (!rollback.routeRestored) {
      ctx.showNotification({
        kind: 'status',
        title: '重 roll 已停止',
        preview: '归档回执中的 shujuku 表快照未通过身份校验，未开始新一轮生成。',
        targetTab: 'summary',
        timestamp: formatTime(state.statusData.world.currentTime),
      });
      return;
    }
    if (await gameDevelopmentController.submitRestoredTurn(rollback.target.sourceUserText, timelineMutationOwner)) {
      return;
    }
    await submitMainMessage({
      text: rollback.target.sourceUserText,
      keepDraft: true,
      clearDraftOnSuccess: true,
      reuseLatestUserMessage: true,
      timelineMutationOwner,
    });
  }, timelineMutationOwner);
}

async function deleteReaderFloor(readerIndex: number) {
  return withTimelineMutation(async () => {
  const requestedLoadToken = saveLoadSequence;
  const requestedSaveId = state.activeSaveId;
  await waitForHostTimelineWrites();
  if (requestedLoadToken !== saveLoadSequence || state.activeSaveId !== requestedSaveId) return;
  const targetMessage = getReaderMessageByIndex(state, readerIndex);
  const targetMessageId = targetMessage?.id ?? '';
  const mutationToken = ++readerMutationSequence;
  const loadToken = saveLoadSequence;
  const saveId = state.activeSaveId;
  const runId = state.activeRunId;
  const isCurrent = () => mutationToken === readerMutationSequence
    && loadToken === saveLoadSequence
    && state.activeSaveId === saveId
    && state.activeRunId === runId;
  await invalidateAsyncActions(ctx);
  if (requestedLoadToken !== saveLoadSequence || state.activeSaveId !== requestedSaveId) return;
  if (!isCurrent()) return;
  const targetRemovedByInvalidation = Boolean(
    targetMessage?.streaming
    && targetMessageId
    && !state.uiMessages.some(message => message.id === targetMessageId),
  );
  const currentReaderIndex = targetMessageId
    ? getReaderMessages(state.uiMessages).findIndex(message => message.id === targetMessageId)
    : readerIndex;
  const deleted = targetRemovedByInvalidation
    ? true
    : currentReaderIndex >= 0 && await deleteReaderMessage(state, currentReaderIndex, win, hostTimeline, isCurrent);
  if (!deleted) return;
  if (!isCurrent()) return;
  if (saveId && targetMessageId && hasArchiveSaveSync(saveId)) {
    const previousWindowStart = state.messageWindow.startFloor;
    const receipt = await deleteArchiveFloorMessage({
      saveId,
      messageId: targetMessageId,
      gameState: buildGameState(),
      runtimeState: captureRuntimeSaveState(),
    }).catch(error => {
      console.warn('[archive] reader text deletion commit deferred:', error);
      return null;
    });
    if (!isCurrent()) return;
    if (receipt) {
      await reloadReaderWindowAfterArchiveMutation(receipt, {
        startFloor: previousWindowStart,
        focus: currentReaderIndex,
      });
      if (!isCurrent()) return;
    }
  }
  ctx.persistConversation();
  ctx.closeReaderContextMenu(false);
  render();
  });
}

function navigatePhone(route: PhoneRoute) {
  syncDrawingSettingsFromMountedControls();
  syncDeepSeekFanForm(false);
  if (route !== 'app:calendar') setCalendarOpenEventId(null);
  if (route === 'app:deepseek-web' && !state.deepSeekModeEnabled) {
    navigatePhoneRoute(state, 'home', ctx);
    return;
  }
  navigatePhoneRoute(state, route, ctx);
}

async function confirmV07RouteChoice(routeFamilyId: string) {
  const machine = getPlotMachine('v07');
  if (!machine) return;
  const routingContext = buildPlotRoutingContext(state.statusData, state.memoryDB);
  const confirmation = confirmPlotRouteChoice({
    machine,
    currentTime: routingContext.evaluationTime,
    flagValues: routingContext.v07.flagValues,
    storedChoice: routingContext.v07.resolution.choiceReceipt,
    routeId: routeFamilyId,
    source: 'manual',
    currentMainEventId: state.statusData.world.currentMainEventId,
    mainEvents: state.statusData.world.mainEvents,
    // 中文注释：确认动作绑定当前时间线最后一个已完成楼层，不绑定玩家正在翻看的 focusedMessageIndex。
    anchorFloorIndex: Math.max(0, getGlobalReaderMessageCount(state) - 1),
  });

  if (confirmation.status === 'rejected') {
    const preview = (() => {
      switch (confirmation.error.code) {
        case 'missing_date':
          return '当前剧情日期无法识别，请先检查剧情时间。';
        case 'missing_anchor':
          return '当前还没有可以绑定路线确认的已完成剧情楼层。';
        case 'ddl_not_reached':
          return '请先完成 2013-03-04 的 SAE_07-8；事件正式结束后会要求你选择路线。';
        case 'outside_choice_window':
          return '当前还没有进入路线选择阶段。';
        case 'unknown_route':
          return '这条路线已经失效，请重新打开企划页。';
        case 'choice_locked':
          return '你已经选择了其他路线，不能再次更改。';
        case 'route_not_eligible':
          return '剧情事实只作参考，不应阻止玩家选择；请重新打开企划页。';
        default:
          return '这次路线选择没有成功，请稍后再试。';
      }
    })();
    ctx.showNotification({
      kind: 'status',
      title: '路线不能确认',
      preview,
      targetTab: 'status',
      phoneRoute: 'app:studio',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return;
  }
  if (confirmation.status === 'unchanged') {
    ctx.showNotification({
      kind: 'status',
      title: '路线已经确认',
      preview: `你已经选择了「${getV07FamilyLabel(confirmation.choice)}」，无需重复确认。`,
      targetTab: 'status',
      phoneRoute: 'app:studio',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return;
  }

  const routeLabel = getV07FamilyLabel(confirmation.choice);
  const confirmed = window.confirm(`确定选择「${routeLabel}」路线吗？确认后将不能更改。`);
  if (!confirmed) return;

  // 中文注释：专用按钮是唯一生产写入口。副 API、自由输入和剧情 flag 都不能生成 choice；
  // 玩家若要换线，只能回退到确认楼层之前，让回退账本正式清除本次 receipt。
  commitPlotRouteChoice(state.memoryDB, confirmation.commit);
  const committedRouting = buildPlotRoutingContext(state.statusData, state.memoryDB);
  await gameDevelopmentController.initializeAfterRouteChoice(
    confirmation.commit.receipt,
    committedRouting.v07.resolution,
  );
  const opensGameDevelopment = isGameDevelopmentRouteChoice(confirmation.commit.receipt);
  ctx.showNotification({
    kind: 'status',
    title: '路线已确认',
    preview: opensGameDevelopment
      ? `已选择「${routeLabel}」路线，对应游戏开发模式现已开放。`
      : `已选择「${routeLabel}」路线。`,
    targetTab: 'status',
    phoneRoute: 'app:studio',
    timestamp: formatTime(state.statusData.world.currentTime),
  });
}

function navigatePhoneBack() {
  syncDrawingSettingsFromMountedControls();
  syncDeepSeekFanForm(false);
  setCalendarOpenEventId(null);
  if (
    state.phoneRouteHistory[state.phoneRouteHistory.length - 1] === 'app:deepseek-web' &&
    !state.deepSeekModeEnabled
  ) {
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
  setCalendarOpenEventId(null);
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
  const loadToken = saveLoadSequence;
  const saveId = state.activeSaveId;
  const runId = state.activeRunId;
  const isCurrent = () => loadToken === saveLoadSequence
    && state.activeSaveId === saveId
    && state.activeRunId === runId;
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
  if (!isCurrent()) return;
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
  const loadToken = saveLoadSequence;
  const saveId = state.activeSaveId;
  const runId = state.activeRunId;
  const isCurrent = () => loadToken === saveLoadSequence
    && state.activeSaveId === saveId
    && state.activeRunId === runId;
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

  const result = await requestImageGeneration(win, imagePrompt.prompt, state.drawingSettings, imagePrompt.change, {
    sceneText,
    rawText,
    summaryApiConfig: state.summaryApiConfig,
  });
  if (!isCurrent()) return;

  if (result.imageData && !result.error) {
    const assetId = await saveImageDataUrlAsAsset(result.imageData, { prompt: result.prompt ?? imagePrompt.prompt });
    if (!isCurrent()) return;
    const liveMessage = state.uiMessages.find(item => item.id === messageId);
    if (!liveMessage || liveMessage.role !== 'assistant' || (liveMessage.rawText || liveMessage.text) !== rawText) return;
    const illustrations = liveMessage.illustrations ?? [];
    if (!illustrations.some(illustration => illustration.assetId === assetId)) {
      const updatedMessage = {
        ...liveMessage,
        illustrations: [
          ...illustrations,
          {
            id: crypto.randomUUID(),
            assetId,
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
        ],
      };
      state.uiMessages = state.uiMessages.map(item => item.id === messageId ? updatedMessage : item);
      const archiveGameState = buildGameState();
      const archiveRuntimeState = captureRuntimeSaveState();
      if (saveId && hasArchiveSaveSync(saveId)) {
        const persisted = serializeMessages([updatedMessage])[0];
        if (persisted) {
          void replaceArchiveFloorMessage({
            saveId,
            messageId: updatedMessage.id,
            message: persisted,
            gameState: archiveGameState,
            runtimeState: archiveRuntimeState,
          }).catch(error => console.warn('[archive] reader image attachment commit deferred:', error));
        }
      }
      persistToSave();
    }
  }

  ctx.showNotification({
    kind: 'message',
    title: result.sent && !result.error ? '生图请求已发送' : '生图失败',
    preview: result.error || (result.reason === 'timeout' ? '智绘姬生成较慢，请到插件图片面板查看。' : ''),
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
  const loadToken = saveLoadSequence;
  const saveId = state.activeSaveId;
  const runId = state.activeRunId;
  const rerollKey = `${saveId ?? ''}\u0000${messageId}\u0000${illustrationId}`;
  const rerollToken = (imageRerollSequenceByKey.get(rerollKey) ?? 0) + 1;
  imageRerollSequenceByKey.set(rerollKey, rerollToken);
  const isCurrent = () => rerollToken === imageRerollSequenceByKey.get(rerollKey)
    && loadToken === saveLoadSequence
    && state.activeSaveId === saveId
    && state.activeRunId === runId;
  const message = state.uiMessages.find(item => item.id === messageId);
  if (!message || message.role !== 'assistant') return;
  const illustration = message.illustrations?.find(item => item.id === illustrationId);
  if (!illustration) return;
  const messageTextAtStart = message.rawText || message.text;
  if (!isImageGenerationPluginAvailable(win)) {
    showDrawingPluginMissingNotification();
    return;
  }

  const rawText = illustration.rerollContext?.rawText || message.rawText || message.text;
  const anchorIndex = Number(illustration.anchorIndex);
  const anchorPrompt = Number.isFinite(anchorIndex)
    ? getImageGenerationPromptAtAnchor(rawText, Math.max(0, Math.floor(anchorIndex)))
    : null;
  const prompt =
    editedPrompt?.trim() || illustration.rerollContext?.prompt || anchorPrompt?.prompt || illustration.prompt || '';
  const negativePrompt =
    editedNegativePrompt?.trim() ??
    illustration.rerollContext?.negativePrompt ??
    state.drawingSettings.negativePrompt ??
    '';
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
  if (!isCurrent()) return;

  if (result.imageData && !result.error) {
    const assetId = await saveImageDataUrlAsAsset(result.imageData, { prompt: result.prompt ?? prompt });
    if (!isCurrent()) return;
    const currentMessage = state.uiMessages.find(item => item.id === messageId);
    if (
      !currentMessage
      || currentMessage.role !== 'assistant'
      || (currentMessage.rawText || currentMessage.text) !== messageTextAtStart
    ) return;
    const currentIllustration = currentMessage.illustrations?.find(item => item.id === illustrationId);
    if (!currentIllustration) return;
    const updatedMessage = {
      ...currentMessage,
      illustrations: (currentMessage.illustrations ?? []).map(item =>
        item.id === illustrationId
          ? {
              ...item,
              assetId,
              imageData: undefined,
              prompt: result.prompt ?? prompt,
              rerollContext: {
                prompt: result.prompt ?? prompt,
                negativePrompt,
                change,
                sceneText,
                rawText,
                generationContext: currentIllustration.rerollContext?.generationContext,
                generationWorldBook: currentIllustration.rerollContext?.generationWorldBook,
                userInput: currentIllustration.rerollContext?.userInput,
              },
              createdAt: Date.now(),
            }
          : item,
      ),
    };
    state.uiMessages = state.uiMessages.map(item => item.id === messageId ? updatedMessage : item);
    const archiveGameState = buildGameState();
    const archiveRuntimeState = captureRuntimeSaveState();
    if (saveId && hasArchiveSaveSync(saveId)) {
      const persisted = serializeMessages([updatedMessage])[0];
      if (persisted) {
        // Image reroll is an isolated assistant replacement. It never restores
        // variables or truncates later text floors.
        void replaceArchiveFloorMessage({
          saveId,
          messageId: updatedMessage.id,
          message: persisted,
          gameState: archiveGameState,
          runtimeState: archiveRuntimeState,
        }).catch(error => console.warn('[archive] image replacement commit deferred:', error));
      }
    }
    persistToSave();
  }

  ctx.showNotification({
    kind: 'message',
    title: result.sent && !result.error ? '图片已重 roll' : '重 roll 失败',
    preview: result.error || (result.reason === 'timeout' ? '智绘姬生成较慢，请到插件图片面板查看。' : ''),
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
      if ((event.target as HTMLElement).closest('[data-action="retry-opening"]')) return;
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
      const canFlip = canFlipReader(state, tryingDirection);
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
      if (dx < 0 && canFlipReader(state, 'next')) {
          resetReaderCardTransform(reader);
          void focusMessage(1);
          return;
        }
      if (dx > 0 && canFlipReader(state, 'prev')) {
          resetReaderCardTransform(reader);
          void focusMessage(-1);
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

function getBackgroundTaskStackFlag() {
  const raw =
    typeof state.runtimeFlags.backgroundTaskStack === 'object' && state.runtimeFlags.backgroundTaskStack
      ? (state.runtimeFlags.backgroundTaskStack as Record<string, unknown>)
      : {};
  return {
    x: Number(raw.x),
    y: Number(raw.y),
  };
}

function setBackgroundTaskStackFlag(next: { x: number; y: number }) {
  state.runtimeFlags.backgroundTaskStack = next;
}

function bindBackgroundTaskDragEvents() {
  const panel = root?.querySelector<HTMLElement>('[data-background-task-stack="true"]');
  if (!panel) return;

  panel.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.background-task__retry')) return;
    const current = getBackgroundTaskStackFlag();
    const rect = panel.getBoundingClientRect();
    backgroundTaskDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: Number.isFinite(current.x) ? current.x : rect.left,
      startTop: Number.isFinite(current.y) ? current.y : rect.top,
      moved: false,
    };
    panel.setPointerCapture(event.pointerId);
    panel.classList.add('is-dragging');
  });

  panel.addEventListener('pointermove', event => {
    if (!backgroundTaskDragState || event.pointerId !== backgroundTaskDragState.pointerId) return;
    const dx = event.clientX - backgroundTaskDragState.startX;
    const dy = event.clientY - backgroundTaskDragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) backgroundTaskDragState.moved = true;
    if (!backgroundTaskDragState.moved) return;
    const gap = window.innerWidth <= 720 ? 12 : 24;
    const width = panel.offsetWidth || 320;
    const height = panel.offsetHeight || 96;
    const nextX = clamp(backgroundTaskDragState.startLeft + dx, gap, Math.max(gap, window.innerWidth - width - gap));
    const nextY = clamp(backgroundTaskDragState.startTop + dy, gap, Math.max(gap, window.innerHeight - height - gap));
    panel.style.left = `${nextX}px`;
    panel.style.top = `${nextY}px`;
  });

  const finishDrag = (event: PointerEvent) => {
    if (!backgroundTaskDragState || event.pointerId !== backgroundTaskDragState.pointerId) return;
    if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    panel.classList.remove('is-dragging');
    const gap = window.innerWidth <= 720 ? 12 : 24;
    const width = panel.offsetWidth || 320;
    const height = panel.offsetHeight || 96;
    const nextX = clamp(
      backgroundTaskDragState.startLeft + event.clientX - backgroundTaskDragState.startX,
      gap,
      Math.max(gap, window.innerWidth - width - gap),
    );
    const nextY = clamp(
      backgroundTaskDragState.startTop + event.clientY - backgroundTaskDragState.startY,
      gap,
      Math.max(gap, window.innerHeight - height - gap),
    );
    if (backgroundTaskDragState.moved) {
      // 中文注释：失败/运行提示栈可被用户拖开，重渲后继续停在用户放下的位置。
      setBackgroundTaskStackFlag({ x: nextX, y: nextY });
      persistToSave();
    }
    backgroundTaskDragState = null;
  };

  panel.addEventListener('pointerup', finishDrag);
  panel.addEventListener('pointercancel', finishDrag);
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

let suppressPhoneHomeAppClickUntil = 0;

function setPhoneHomePage(nextPage: number) {
  const viewport = root?.querySelector<HTMLElement>('[data-phone-home-swipe]');
  if (!viewport) return;
  const pageCount = Number(viewport?.dataset.phoneHomePageCount ?? 1);
  const page = clampPhoneHomePageToCount(nextPage, pageCount);
  const currentPage = clampPhoneHomePageToCount(
    Number(viewport.dataset.phoneHomeActivePage ?? state.phoneHomePage),
    pageCount,
  );
  if (page === currentPage && page === state.phoneHomePage) return;

  state.phoneHomePage = page;
  viewport.dataset.phoneHomeActivePage = String(page);
  viewport.style.setProperty('--phone-home-page', String(page));

  root?.querySelectorAll<HTMLElement>('[data-phone-home-page-panel]').forEach(panel => {
    const isActive = Number(panel.dataset.phoneHomePagePanel ?? -1) === page;
    panel.toggleAttribute('inert', !isActive);
    panel.setAttribute('aria-hidden', String(!isActive));
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="phone-home-page"]').forEach(button => {
    const isActive = Number(button.dataset.phoneHomePage ?? -1) === page;
    button.classList.toggle('is-active', isActive);
    if (isActive) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function bindPhoneHomePaginationEvents() {
  root?.querySelectorAll<HTMLButtonElement>('[data-action="phone-home-page"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      setPhoneHomePage(Number(button.dataset.phoneHomePage ?? 0));
    });
  });

  const viewport = root?.querySelector<HTMLElement>('[data-phone-home-swipe]');
  if (!viewport) return;

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;

  const resetPointer = () => {
    if (pointerId !== null && viewport.hasPointerCapture?.(pointerId)) {
      viewport.releasePointerCapture?.(pointerId);
    }
    pointerId = null;
    startX = 0;
    startY = 0;
  };

  viewport.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
  });

  viewport.addEventListener('pointermove', event => {
    if (pointerId !== event.pointerId) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    const crossedSwipeThreshold = Math.abs(deltaX) >= 36 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
    if (crossedSwipeThreshold && !viewport.hasPointerCapture?.(event.pointerId)) {
      viewport.setPointerCapture?.(event.pointerId);
    }
  });

  viewport.addEventListener('pointerup', event => {
    if (pointerId !== event.pointerId) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    const isHorizontalSwipe = Math.abs(deltaX) >= 36 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
    resetPointer();
    if (!isHorizontalSwipe) return;
    event.preventDefault();
    suppressPhoneHomeAppClickUntil = performance.now() + 400;
    setPhoneHomePage(state.phoneHomePage + (deltaX < 0 ? 1 : -1));
  });

  viewport.addEventListener('pointercancel', resetPointer);
  viewport.addEventListener(
    'click',
    event => {
      if (performance.now() >= suppressPhoneHomeAppClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}

function bindEvents() {
  bindQuickReplyDelegation();
  bindPhoneHomePaginationEvents();
  bindPhoneAvatarFallbacks(root);
  bindPhoneRelationshipEvents(root, render);
  bindComposerEditor({
    root,
    getDraft: () => state.draft,
    setDraft: value => {
      state.draft = value;
    },
    getContextLabel: () => {
      const raw = state.runtimeFlags.gameDevelopmentChoiceEdit;
      if (!raw || typeof raw !== 'object') return '正文或大纲';
      const choice = raw as Record<string, unknown>;
      const phase = choice.phase === 'weekend' ? '周末' : '工作日';
      return `第 ${Number(choice.week) || 1} 周 · ${phase} · ${String(choice.actionLabel ?? '待选择')} · ${String(choice.targetLabel ?? '未选择对象')}`;
    },
    getSubmitLabel: () => (state.runtimeFlags.gameDevelopmentChoiceEdit ? '提交游戏回合' : '记录'),
    isGenerating: () => state.generating,
    submit: () => submitMainMessage(),
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="select-option"]').forEach(button => {
    button.addEventListener('pointerdown', event => {
      event.stopPropagation();
    });
  });

  root?.querySelectorAll<HTMLTextAreaElement>('.composer-input').forEach(textarea => {
    growComposerInput(textarea);
    syncComposerSubmitAvailability(textarea);
    textarea.addEventListener('input', event => {
      const activeTextarea = event.target as HTMLTextAreaElement;
      state.draft = activeTextarea.value;
      growComposerInput(activeTextarea);
      syncComposerSubmitAvailability(activeTextarea);
      root?.querySelectorAll<HTMLTextAreaElement>('.composer-input').forEach(other => {
        if (other !== event.target) {
          other.value = state.draft;
          growComposerInput(other);
          syncComposerSubmitAvailability(other);
        }
      });
    });

    textarea.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void submitMainMessage();
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
  root?.querySelectorAll<HTMLButtonElement>('[data-action="confirm-v07-route"]').forEach(button => {
    button.addEventListener('click', () => {
      const routeFamilyId = button.dataset.routeFamily;
      if (routeFamilyId) void confirmV07RouteChoice(routeFamilyId);
    });
  });
  gameDevelopmentController.bind(root);
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
      if (state.phoneMessages.generating) {
        cancelPhoneMessageGeneration(ctx);
        return;
      }
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
    button.addEventListener('click', () => void focusMessage(Number(button.dataset.direction ?? 0)));
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="jump-message"]').forEach(button => {
    button.addEventListener('click', () => jumpMessage(Number(button.dataset.index ?? 0)));
  });
  root?.querySelector<HTMLButtonElement>('[data-action="retry-opening"]')?.addEventListener('click', event => {
    event.stopPropagation();
    if (!state.generating) void generateOpeningScene(ctx);
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="toggle-paper-fullscreen"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      togglePaperWorkspaceFullscreen(state);
      render();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="set-paper-theme"]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      setPaperTheme(button.dataset.paperTheme);
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
  root
    ?.querySelector<HTMLTextAreaElement>('[data-field="image-reroll-negative-prompt"]')
    ?.addEventListener('input', event => {
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
    const readerIndex = getReaderContextMenuIndex();
    runReaderRetry(readerIndex);
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
    setCalendarOpenEventId(null);
    setCalendarMonthOffset(getCalendarMonthOffset() - 1);
    render();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="calendar-next"]')?.addEventListener('click', () => {
    setCalendarOpenEventId(null);
    setCalendarMonthOffset(getCalendarMonthOffset() + 1);
    render();
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="calendar-select-date"]').forEach(button => {
    button.addEventListener('click', () => {
      setCalendarOpenEventId(null);
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
    ?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field^="deepseek-fan-"]')
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
    ?.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >('[data-field="deepseek-web-search-source"], [data-field="deepseek-web-ddg-region"], [data-field="deepseek-web-timeout"], [data-field="deepseek-web-max-results"]')
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
  root
    ?.querySelector<HTMLButtonElement>('[data-action="memory-expire-all-unlocked-items"]')
    ?.addEventListener('click', () => {
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
      const newId = insertMemoryRow(state.memoryDB, 'facts', {
        ...createUserEventMemoryPayload(state.memoryEditor.creatingDraft),
        gameTime: state.statusData.world.currentTime,
        extra: { location: state.statusData.world.currentLocation },
      });
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
  root
    ?.querySelector<HTMLInputElement>('[data-field="plot-route-review-enabled"]')
    ?.addEventListener('change', event => {
      const enabled = (event.target as HTMLInputElement).checked;
      setPlotRouteReviewEnabled(state.runtimeFlags, enabled);
      if (!enabled) {
        clearBackgroundTask(state, 'plot-review');
        if (state.notification?.title.includes('路线')) state.notification = null;
      }
      persistToSave();
      render();
    });
  root
    ?.querySelector<HTMLInputElement>('[data-field="shujuku-route-enabled"]')
    ?.addEventListener('change', async event => {
      const input = event.currentTarget as HTMLInputElement;
      const runId = state.activeRunId;
      const saveId = state.activeSaveId;
      if (!runId || !saveId || state.generating) {
        render();
        return;
      }

      const rawCompatibility = state.runtimeFlags.shujukuCompatibility;
      const previousHandoff = state.runtimeFlags.shujukuHandoff;
      const previousTableSnapshot = state.runtimeFlags.shujukuTableSnapshot;
      const currentCompatibility = rawCompatibility
        && typeof rawCompatibility === 'object'
        && !Array.isArray(rawCompatibility)
        ? rawCompatibility as Partial<ShujukuCompatibilityState>
        : null;
      const branchId = typeof currentCompatibility?.branchId === 'string' && currentCompatibility.branchId.trim()
        ? currentCompatibility.branchId
        : crypto.randomUUID();
      const previousIsolationKey = typeof currentCompatibility?.isolationKey === 'string'
        ? currentCompatibility.isolationKey.trim()
        : '';
      const releaseTimelineFence = beginTimelineMutationFence();
      input.disabled = true;
      let activeIsolationKey: string | undefined;
      let routeStatePersisted = false;

      try {
        await invalidateAsyncActions(ctx);
        if (state.activeRunId !== runId || state.activeSaveId !== saveId) return;

        if (!input.checked) {
          const islandCompatibility: ShujukuCompatibilityState = {
            ...currentCompatibility,
            saveId,
            runId,
            route: 'island',
            handoffPhase: 'none',
            branchId,
            lastCheckedAt: new Date().toISOString(),
          };
          delete islandCompatibility.handoffId;
          delete islandCompatibility.lastTableHash;
          delete islandCompatibility.lastError;
          state.runtimeFlags.shujukuCompatibility = islandCompatibility;
          delete state.runtimeFlags.shujukuHandoff;
          delete state.runtimeFlags.shujukuTableSnapshot;
          await persistToSaveImmediately({ allowIncomplete: true });
          routeStatePersisted = true;
          ctx.showNotification({
            kind: 'status',
            title: '已切换至 Island 路线',
            preview: '当前存档后续正文将使用 Island 生成链。',
            targetTab: 'summary',
            timestamp: formatTime(state.statusData.world.currentTime),
          });
          return;
        }

        const probe = await probeShujukuRuntime(win);
        if (state.activeRunId !== runId || state.activeSaveId !== saveId) return;
        activeIsolationKey = probe.activeIsolationKey?.trim() || undefined;
        const probeTableSnapshot = probe.tableSnapshot;
        const checkedAt = new Date().toISOString();
        if (!probe.available || !activeIsolationKey || !probeTableSnapshot) {
          const lastError = !probe.available
            ? probe.reason || 'shujuku 运行时不可用。'
            : !activeIsolationKey
              ? '未检测到 shujuku 隔离标识，请先在 shujuku 中启用并应用数据隔离。'
              : 'shujuku 未返回可持久化的轮前表快照，已拒绝建立连接。';
          const reviewCompatibility: ShujukuCompatibilityState = {
            ...currentCompatibility,
            saveId,
            runId,
            route: 'shujuku',
            handoffPhase: 'needs_review',
            branchId,
            ...(probe.capabilityHash ? { capabilityHash: probe.capabilityHash } : {}),
            ...((activeIsolationKey || previousIsolationKey)
              ? { isolationKey: activeIsolationKey || previousIsolationKey }
              : {}),
            lastError,
            lastCheckedAt: checkedAt,
          };
          delete reviewCompatibility.handoffId;
          state.runtimeFlags.shujukuCompatibility = reviewCompatibility;
          delete state.runtimeFlags.shujukuHandoff;
          delete state.runtimeFlags.shujukuTableSnapshot;
          await persistToSaveImmediately({ allowIncomplete: true });
          routeStatePersisted = true;
          ctx.showNotification({
            kind: 'status',
            title: 'shujuku 路线需要复核',
            preview: lastError,
            targetTab: 'summary',
            timestamp: formatTime(state.statusData.world.currentTime),
          });
          return;
        }

        const readerMessages = getReaderMessages(state.uiMessages).filter(message => !message.streaming);
        const timelineAnchor = readerMessages[readerMessages.length - 1]?.id ?? 'floor0';
        const cutoffFloor = getGlobalReaderMessageCount(state);
        const committed = await createCommittedShujukuHandoff({
          currentCompatibility,
          saveId,
          runId,
          branchId,
          timelineAnchor,
          cutoffFloor,
          isolationKey: activeIsolationKey,
          capabilityHash: probe.capabilityHash ?? '',
          tableSnapshot: probeTableSnapshot,
          sourceProjection: { source: 'shujuku-native', capabilityHash: probe.capabilityHash },
        });
        if (state.activeRunId !== runId || state.activeSaveId !== saveId) return;
        state.runtimeFlags.shujukuCompatibility = committed.state;
        state.runtimeFlags.shujukuHandoff = committed.handoff;
        state.runtimeFlags.shujukuTableSnapshot = committed.tableSnapshot;
        await persistToSaveImmediately({ allowIncomplete: true });
        routeStatePersisted = true;

        const connected = inspectCommittedShujukuBinding(state.runtimeFlags, {
          saveId: state.activeSaveId,
          runId: state.activeRunId,
        }).kind === 'active';
        ctx.showNotification({
          kind: 'status',
          title: connected ? 'shujuku 已连接' : 'shujuku 路线需要复核',
          preview: connected
            ? '当前存档后续正文将使用 shujuku 生成与填表链。'
            : '存档分支已变化，请重新打开 shujuku 路线完成绑定。',
          targetTab: 'summary',
          timestamp: formatTime(state.statusData.world.currentTime),
        });
      } catch (error) {
        if (state.activeRunId === runId && state.activeSaveId === saveId) {
          const lastError = error instanceof Error ? error.message : String(error);
          if (!routeStatePersisted) {
            if (input.checked) {
              // A failed shujuku probe must never leave an old committed handoff
              // selecting the nonexistent direct-API path on the next send.
              const fallbackCompatibility: ShujukuCompatibilityState = {
                ...currentCompatibility,
                saveId,
                runId,
                route: 'island',
                handoffPhase: 'none',
                branchId,
                lastError,
                lastCheckedAt: new Date().toISOString(),
              };
              delete fallbackCompatibility.handoffId;
              delete fallbackCompatibility.lastTableHash;
              state.runtimeFlags.shujukuCompatibility = fallbackCompatibility;
              delete state.runtimeFlags.shujukuHandoff;
              delete state.runtimeFlags.shujukuTableSnapshot;
              await persistToSaveImmediately({ allowIncomplete: true });
              routeStatePersisted = true;
            } else {
              if (rawCompatibility === undefined) delete state.runtimeFlags.shujukuCompatibility;
              else state.runtimeFlags.shujukuCompatibility = rawCompatibility;
              if (previousHandoff === undefined) delete state.runtimeFlags.shujukuHandoff;
              else state.runtimeFlags.shujukuHandoff = previousHandoff;
              if (previousTableSnapshot === undefined) delete state.runtimeFlags.shujukuTableSnapshot;
              else state.runtimeFlags.shujukuTableSnapshot = previousTableSnapshot;
            }
          }
          ctx.showNotification({
            kind: 'status',
            title: input.checked ? 'shujuku 连接失败' : 'Island 路线保存失败',
            preview: routeStatePersisted ? lastError : `${lastError}；已恢复切换前状态。`,
            targetTab: 'summary',
            timestamp: formatTime(state.statusData.world.currentTime),
          });
        }
      } finally {
        releaseTimelineFence();
        render();
      }
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
  root?.querySelector<HTMLButtonElement>('[data-action="reader-rollback-completed"]')?.addEventListener('click', () => {
    if (!state.readerContextMenu) return;
    void rollbackAfterReaderFloor(state.readerContextMenu.readerIndex);
  });
  root?.querySelector<HTMLButtonElement>('[data-action="backup-save-to-tavern"]')?.addEventListener('click', async () => {
    persistToSave();
    if (!state.activeSaveId) {
      window.alert('当前没有可备份的存档。');
      return;
    }
    try {
      const entry = await persistSaveToTavernFiles(state.activeSaveId);
      const legacyLocations = [entry.stateFile, entry.messagesFile, entry.assetsFile].filter(Boolean).join('\n');
      const storageLocation = entry.storagePath || legacyLocations || 'SillyTavern 本机数据目录';
      const imageLocation = entry.imageFolders?.length ? `\n图片：${entry.imageFolders.join('、')}` : '';
      window.alert(`本机备份完成：${storageLocation}${imageLocation}`);
    } catch (error) {
      window.alert(`本机备份失败：${(error as Error).message}`);
    }
  });
  root?.querySelector<HTMLButtonElement>('[data-action="restore-tavern-backup"]')?.addEventListener('click', () => {
    void restoreSaveFromTavernFiles();
  });
  const importFileInput = root?.querySelector<HTMLInputElement>('[data-field="import-saves-file"]') ?? null;
  root?.querySelector<HTMLButtonElement>('[data-action="import-saves"]')?.addEventListener('click', () => {
    importFileInput?.click();
  });
  importFileInput?.addEventListener('change', async () => {
    const file = importFileInput.files?.[0];
    if (!file) return;
    const ok = window.confirm('导入会更新浏览器中同名的存档，确认继续？');
    if (!ok) {
      importFileInput.value = '';
      return;
    }
    try {
      const text = new TextDecoder('utf-8').decode(await file.arrayBuffer());
      const parsed = JSON.parse(text) as PortableArchiveBackup & { imageAssets?: Parameters<typeof restoreImageAssetFromBackup>[0][] };
      const result = parsed?.kind === 'archive-v3'
        ? await (async () => {
            await importPortableArchive(parsed);
            await Promise.allSettled((parsed.imageAssets ?? []).map(asset => restoreImageAssetFromBackup(asset)));
            return { imported: 1, skipped: 0 };
          })()
        : importAllSavesFromJson(text);
      const flushes = await Promise.allSettled([flushImageAssetStore(), flushArchiveRepository(), flushSaveStore()]);
      const deferred = flushes.filter(item => item.status === 'rejected').length;
      flushes.forEach(item => {
        if (item.status === 'rejected') console.warn('[archive] imported save auxiliary flush deferred:', item.reason);
      });
      window.alert(
        `导入完成：成功 ${result.imported} 条，跳过 ${result.skipped} 条。`
        + (deferred ? '部分附件仍在后台落盘；正文存档已保留。' : '')
        + '即将刷新页面。',
      );
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
  const playerAvatarFileInput = root?.querySelector<HTMLInputElement>('[data-field="player-avatar-file"]') ?? null;
  root?.querySelector<HTMLButtonElement>('[data-action="choose-player-avatar"]')?.addEventListener('click', () => {
    playerAvatarFileInput?.click();
  });
  playerAvatarFileInput?.addEventListener('change', async () => {
    const file = playerAvatarFileInput.files?.[0];
    if (!file) return;
    try {
      await setPlayerAvatarFromFile(file);
    } catch (error) {
      window.alert(`头像保存失败：${(error as Error).message}`);
    } finally {
      playerAvatarFileInput.value = '';
    }
  });
  root?.querySelector<HTMLButtonElement>('[data-action="remove-player-avatar"]')?.addEventListener('click', () => {
    playerAvatarSequence += 1;
    applyPlayerProfileDraftFromStatusPanel();
    delete state.playerProfile.avatarAssetId;
    syncRuntimeProfile();
    persistToSave();
    render();
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
      void submitMainMessage();
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
      messageStartIndex: state.messageWindow.startMessage,
      totalMessageCount: getGlobalSummaryMessageCount(state),
      loadMessageRange: (startMessage: number, maxMessages: number) => {
        const saveId = state.activeSaveId;
        if (!saveId) return Promise.resolve({ startMessage, totalMessageCount: 0, messages: [] });
        return getArchiveMessageRange(saveId, startMessage, maxMessages);
      },
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
          totalMessageCount: getGlobalSummaryMessageCount(state),
        });
        if (repairResult.fixed) {
          persistToSave();
        }
      } catch (error) {
        console.warn('[summary] 自动修复失败:', error);
      }

      const result = await runSummary(ctxArg, mode);
      if (mode === 'minor') {
        let safety = 20;
        while (safety-- > 0) {
          if (countPendingSummaryFloors() < 5) break;
          if (state.summaryStore.autoPaused) break;
          await runSummary(ctxArg, 'minor');
        }
      } else if (mode === 'major') {
        let safety = 10;
        while (safety-- > 0) {
          if (countUnmergedMinorSummaries() === 0) break;
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

  function countPendingSummaryFloors() {
    const total = getGlobalSummaryMessageCount(state);
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
          messageStartIndex: state.messageWindow.startMessage,
          totalMessageCount: getGlobalSummaryMessageCount(state),
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
          Math.max(0, state.summaryStore.lastSummarizedIndex - 1),
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
  bindBackgroundTaskDragEvents();
  bindReaderContextMenuEvents();
}

function getReaderContextMenuIndex(): number | null {
  const menu = state.readerContextMenu;
  return menu ? menu.readerIndex : null;
}

function runReaderRetry(readerIndex: number | null) {
  if (readerIndex === null) return;
  void rerunReaderMessage(readerIndex);
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
    console.info('[saves:list]', {
      saveCount: listSaves().length,
      ...getSaveStoreDiagnostics(),
    });
    render();
  },
  hideSaves: () => {
    state.showingSaveList = false;
    render();
  },
  createAndEnter: opts => {
    state.deepSeekModeEnabled = opts.deepSeekMode ?? state.deepSeekModeEnabled;
    writeDeepSeekModeEnabledPreference(state.deepSeekModeEnabled);
    const openingMode = opts.openingMode ?? 'manual';
    const save = createSave(opts);
    void enterSave(save.saveId, { openingMode });
  },
  deleteSave: async id => {
    return withTimelineMutation(async () => {
    if (state.activeSaveId === id) await waitForHostTimelineWrites();
    const deleteLoadToken = ++saveLoadSequence;
    readerMutationSequence += 1;
    if (state.activeSaveId === id) await invalidateAsyncActions(ctx);
    if (deleteLoadToken !== saveLoadSequence) return;
    const localDelete = deleteTavernArchiveSave(id);
    deleteSave(id);
    void deleteArchiveSave(id).catch(error => console.warn('[archive] delete pointer failed:', error));
    void localDelete.then(result => {
      console.info('[archive-bridge] 本机删除成功', {
        saveId: id,
        deleted: result.deleted === true,
        alreadyMissing: result.alreadyMissing === true,
        gc: result.gc ?? { status: 'none' },
      });
    }).catch(error => {
      console.warn('[archive-bridge] 本机删除失败，浏览器存档已删除', {
        saveId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (state.activeSaveId === id) {
      clearWorldbookRefreshRetry();
      state.activeRunId = null;
      state.activeSaveId = null;
      setActiveRunId(null);
      clearActiveSaveId();
    }
    });
  },
  exportSave: id => {
    downloadSaveBackup(id);
  },
  restoreTavernBackup: () => {
    void restoreSaveFromTavernFiles();
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
  const readerBodyScroll = captureReaderBodyScroll(root);
  if (state.activeRunId) {
    // 游戏界面。
    if (syncMainEvents(state.statusData, state.plotLibrary)) {
      guardedAdapterSave(state.statusData);
      if (!suppressRenderPersistence) persistToSave();
    }
    const routeChoiceRequired = isV07RouteChoiceBlockingMainText();
    if (routeChoiceRequired && !v07DdlAutoOpened) {
      // 中文注释：事件终态已经进入权威状态后才自动打开一次 DDL。玩家可以关掉手机查看正文，
      // 但 submitMainMessage 仍会阻止下一段正文，直到正式 choice receipt 落盘。
      state.phoneOpen = true;
      state.phoneRoute = 'app:studio';
      v07DdlAutoOpened = true;
    } else if (!routeChoiceRequired) {
      v07DdlAutoOpened = false;
    }
    syncFocusedMessage(state);
    syncPaperFullscreenHost(isPaperWorkspaceFullscreen(state));
    root.innerHTML = renderApp(state, flipDirection);
    bindCalendarEventDelegation();
    bindEvents();
    restoreReaderBodyScroll(root, readerBodyScroll);
    hydrateImageAssetElements(root, `floor:${toGlobalReaderIndex(state, state.focusedMessageIndex)}`);

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
      recoveryNotice:
        typeof state.runtimeFlags.saveRecoveryNotice === 'string' ? state.runtimeFlags.saveRecoveryNotice : undefined,
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
  const activeElement = document.activeElement;
  const isFocusedComposer = activeElement instanceof Element && activeElement.matches('.composer-input');
  // 自动增高会让同层宿主触发 resize；此时重渲会替换正在输入的 textarea 并丢失焦点。
  if (isEditableTarget(activeElement) && (isPaperWorkspaceFullscreen(state) || isFocusedComposer)) {
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
  if (event.key === 'Escape' && getCalendarOpenEventId()) {
    event.preventDefault();
    setCalendarOpenEventId(null);
    render();
    return;
  }
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
    void focusMessage(-1);
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    void focusMessage(1);
  }
});

// ── Async init ──

// ⚠️ 必须在 init() 之前同步启动 predefine.js 劫持，否则 shujuku iframe 可能已经加载完成
import { startPredefineHijack, getHijackDiagnostics } from './shujuku/predefine-hijack';
const stopPredefineHijack = startPredefineHijack();

async function init() {
  // 必须在任何同步存档读写（render 之前）完成；内部会一次性把 localStorage 旧数据迁到 IndexedDB。
  await initSaveStore();
  await initArchiveRepository();
  const saveRecovery = recoverMissingSaveIndexFromPayloads();
  const saveCount = listSaves().length;
  const saveStoreDiagnostics = getSaveStoreDiagnostics();
  console.info('[islandmilfcode:init]', {
    cardVersion: ISLANDMILFCODE_VERSION,
    saveSchemaVersion: SAVE_DATA_SCHEMA_VERSION,
    saveCount,
    payloadCount: saveRecovery.totalPayloads,
    recoveredMissingIndex: saveRecovery.recovered,
    store: saveStoreDiagnostics,
    archive: getArchiveDiagnostics(),
    predefineHijack: getHijackDiagnostics(),
  });
  if (saveRecovery.recovered > 0) {
    state.runtimeFlags.saveRecoveryNotice = `已从本地缓存恢复 ${saveRecovery.recovered} 个存档`;
  } else if (saveStoreDiagnostics.degraded) {
    state.runtimeFlags.saveRecoveryNotice = `浏览器存档暂不可用，当前为内存降级模式：${saveStoreDiagnostics.initError || 'IndexedDB 初始化失败'}`;
  } else if (saveStoreDiagnostics.legacyMigrationPending) {
    state.runtimeFlags.saveRecoveryNotice = '旧浏览器存档尚未全部验证，旧数据已保留并将在下次启动重试';
  }
  await initImageAssetStore();
  adapter = await createVariableAdapter(win);
  state.summaryApiConfig = loadSummaryApiConfig();
  setupStreamingHooks(ctx, eventStops);
  eventStops.push(installArchiveBridgeSync());
  eventStops.push(setupHostLifecycle(win, {
    getActiveSaveId: () => state.activeSaveId,
    getBrowserRevision: () => state.activeSaveId ? getArchiveMetaSync(state.activeSaveId)?.browserRevision ?? 0 : 0,
    getPlotEventCount: () => Object.keys(state.plotLibrary.events).length,
    getMainEventCount: () => Object.keys(state.statusData.world.mainEvents).length,
    onWorldInfoUpdated: async () => {
      await markRecentWorldbookCacheStale('current').catch(() => undefined);
      if (state.activeRunId) await refreshCharacterWorldbookTargets();
    },
    onChatChanged: async () => {
      if (state.activeRunId) await refreshCharacterWorldbookTargets();
    },
  }));
  setActiveRunId(null);
  clearActiveSaveId();
  // 页面切到后台 / 关闭前尝试 flush 未落盘的写入。IndexedDB 写本身很快（毫秒级），通常都能完成。
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        syncDrawingSettingsFromMountedControls();
        if (autosaveTimer) flushPendingAutosave();
        Promise.all([flushImageAssetStore(), flushArchiveRepository(), flushSaveStore()]).catch(err =>
          console.warn('[init] flush on hidden failed:', err),
        );
      }
    });
    window.addEventListener('beforeunload', () => {
      syncDrawingSettingsFromMountedControls();
      if (autosaveTimer) flushPendingAutosave();
      stopPredefineHijack(); // 清理 MutationObserver
    });
  }
  render();
}
init();

// ── Debug interfaces ──

installDebugGlobals(() => getDebugGameStateText(state));

(window as any).advanceTime = () => {
  if (adapter) {
    const data = guardedAdapter.load();
    if (JSON.stringify(data) !== JSON.stringify(state.statusData)) {
      state.statusData = data;
      cacheStatusData(data);
      render();
    }
  }
};
