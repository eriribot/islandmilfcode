import { getReaderMessages, isFrontendHtmlShell } from '../message-format';
import { createDefaultSummaryStore, deserializeSummaryStore, type SummaryStore } from '../summary/types';
import { hydrateSummaryStoreFromMemoryDB } from '../memorydatabase/migrate';
import type { FloatingPhonePosition } from '../phone/types';
import type {
  AppState,
  DrawingSettings,
  PersistedMessage,
  PhoneMessageStore,
  PlotLibrary,
  RollbackSnapshot,
  TavernWindow,
  UiMessage,
} from '../types';
import { clamp, defaultStatusData, normalizeStatusData } from '../variables/normalize';
import { createDefaultMusicPlayerState } from '../phone/music';
import { createDefaultMemoryDB } from '../memorydatabase/defaults';
import { createDefaultMemoryEditorState } from '../memorydatabase/editor';
import { normalizeMemoryDB } from '../memorydatabase/normalize';
import type { IslandMemoryDB, MemoryBaseRow } from '../memorydatabase/types';
import { createEmptyCharacterCardLibrary } from '../worldbook';

export const MESSAGE_MARKER = 'islandmilfcode';
const PROFILE_KEYS = {
  role: ['gen', 'der'].join('') as keyof NonNullable<RollbackSnapshot['playerProfile']>,
};
const PROFILE_DEFAULTS = {
  role: String.fromCharCode(0x7500 + 55),
};

const MEMORY_ROW_TABLES = [
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

function applyProfileDefaults<T extends Record<string, unknown>>(profile: T): T {
  return {
    ...profile,
    [PROFILE_KEYS.role]: PROFILE_DEFAULTS.role,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createSystemMessage(): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    speaker: 'system',
    text: '',
  };
}

function createEmptyPlotLibrary(): PlotLibrary {
  return {
    events: {},
    sourceEntryNames: [],
    loadedAt: 0,
  };
}

export function createDefaultPhoneMessageStore(): PhoneMessageStore {
  return {
    activeThreadId: null,
    draft: '',
    generating: false,
    threads: {},
  };
}

export function normalizePhoneMessageStore(input: unknown): PhoneMessageStore {
  const fallback = createDefaultPhoneMessageStore();
  const raw = typeof input === 'object' && input ? (input as Partial<PhoneMessageStore>) : {};
  const rawThreads = typeof raw.threads === 'object' && raw.threads ? raw.threads : {};
  const threads: PhoneMessageStore['threads'] = {};

  for (const [targetId, thread] of Object.entries(rawThreads)) {
    if (!thread || typeof thread !== 'object') continue;
    const rawThread = thread as Partial<PhoneMessageStore['threads'][string]>;
    const messages = Array.isArray(rawThread.messages)
      ? rawThread.messages
          .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
          .map(message => {
            const rawMessage = message as Record<string, unknown>;
            const floorIndex = Number(rawMessage.floorIndex);
            return {
              id: String(message.id || crypto.randomUUID()),
              role: message.role,
              speaker: String(message.speaker || (message.role === 'assistant' ? '角色' : '我')),
              text: String(message.text ?? ''),
              timestamp: String(message.timestamp || ''),
              ...(Number.isFinite(floorIndex) && floorIndex >= 0 ? { floorIndex: Math.floor(floorIndex) } : {}),
              ...(message.statusSnapshot
                ? { statusSnapshot: normalizeRollbackSnapshot(message.statusSnapshot, { includeSideWindows: false }) }
                : {}),
            };
          })
      : [];

    threads[targetId] = {
      targetId: String(rawThread.targetId || targetId),
      messages,
      unread: Math.max(0, Number(rawThread.unread ?? 0) || 0),
      updatedAt: Number(rawThread.updatedAt ?? 0) || 0,
    };
  }

  const activeThreadId =
    raw.activeThreadId && threads[String(raw.activeThreadId)] ? String(raw.activeThreadId) : fallback.activeThreadId;

  return {
    activeThreadId,
    draft: String(raw.draft ?? ''),
    generating: Boolean(raw.generating),
    threads,
  };
}

function isStatusDataLike(input: unknown): input is Partial<RollbackSnapshot['statusData']> {
  if (!input || typeof input !== 'object') return false;
  const raw = input as Record<string, unknown>;
  return Boolean(raw.world || raw.targets || raw.player);
}

function clonePhoneMessagesForSnapshot(input: unknown): PhoneMessageStore {
  const store = normalizePhoneMessageStore(input);
  const threads: PhoneMessageStore['threads'] = {};

  for (const [targetId, thread] of Object.entries(store.threads)) {
    threads[targetId] = {
      ...thread,
      messages: thread.messages.map(message => {
        const { statusSnapshot: _statusSnapshot, ...plainMessage } = message;
        return plainMessage;
      }),
    };
  }

  return {
    ...store,
    generating: false,
    threads,
  };
}

function cloneMemoryDBForSnapshot(input: unknown) {
  const raw = typeof input === 'object' && input ? (input as { runId?: unknown }) : {};
  const runId = typeof raw.runId === 'string' ? raw.runId : '';
  const normalized = normalizeMemoryDB(input, runId);
  return normalized ? cloneJson(normalized) : undefined;
}

function normalizeRollbackSnapshot(input: unknown, options: { includeSideWindows?: boolean } = {}): RollbackSnapshot {
  const { includeSideWindows = true } = options;

  // 兼容旧存档：过去 statusSnapshot 直接就是 StatusData，没有包裹手机和总结窗口。
  if (isStatusDataLike(input)) {
    return {
      statusData: normalizeStatusData(input),
    };
  }

  const raw = typeof input === 'object' && input ? (input as Partial<RollbackSnapshot>) : {};
  const snapshot: RollbackSnapshot = {
    statusData: normalizeStatusData(raw.statusData ?? defaultStatusData),
  };

  if (raw.playerProfile && typeof raw.playerProfile === 'object') {
    snapshot.playerProfile = applyProfileDefaults(cloneJson(raw.playerProfile as RollbackSnapshot['playerProfile']));
  }
  if (raw.drawingSettings) {
    snapshot.drawingSettings = normalizeDrawingSettings(raw.drawingSettings);
  }

  if (includeSideWindows) {
    if (raw.phoneMessages) {
      snapshot.phoneMessages = clonePhoneMessagesForSnapshot(raw.phoneMessages);
    }
    if (raw.summaryStore) {
      snapshot.summaryStore = deserializeSummaryStore(raw.summaryStore);
    }
    if (raw.memoryDB) {
      snapshot.memoryDB = cloneMemoryDBForSnapshot(raw.memoryDB);
    }
  }

  return snapshot;
}

export function createRollbackSnapshot(
  state: Pick<AppState, 'statusData' | 'playerProfile' | 'drawingSettings' | 'phoneMessages' | 'summaryStore' | 'memoryDB'>,
) {
  return {
    statusData: cloneJson(state.statusData),
    playerProfile: applyProfileDefaults(cloneJson(state.playerProfile)),
    drawingSettings: normalizeDrawingSettings(state.drawingSettings),
    phoneMessages: clonePhoneMessagesForSnapshot(state.phoneMessages),
    summaryStore: deserializeSummaryStore(state.summaryStore),
    memoryDB: cloneMemoryDBForSnapshot(state.memoryDB),
  };
}

export function createDefaultDrawingSettings(): DrawingSettings {
  return {
    enabled: false,
    qualityPrompt: 'masterpiece, best quality, anime style, light novel illustration',
    negativePrompt: 'lowres, bad quality, worst quality, jpeg artifacts, very displeasing',
    contextMessageCount: 0,
    width: 832,
    height: 1216,
    manualPrompt: '',
    characterAnchors: [],
    systemPrompt: '',
  };
}

export function normalizeDrawingSettings(input: unknown): DrawingSettings {
  const fallback = createDefaultDrawingSettings();
  const raw = typeof input === 'object' && input ? (input as Partial<DrawingSettings>) : {};
  const anchors = Array.isArray(raw.characterAnchors)
    ? raw.characterAnchors
        .map(anchor => ({
          id: String(anchor?.id || crypto.randomUUID()),
          name: String(anchor?.name ?? '').trim(),
          prompt: String(anchor?.prompt ?? '').trim(),
        }))
        // 保留所有角色，包括新添加的空角色，以便用户可以填写
    : [];

    return {
      enabled: Boolean(raw.enabled),
      qualityPrompt: String(raw.qualityPrompt ?? fallback.qualityPrompt),
      negativePrompt: String(raw.negativePrompt ?? fallback.negativePrompt),
      contextMessageCount: Math.max(0, Math.min(20, Math.round(Number(raw.contextMessageCount ?? 0) || 0))),
      width: Math.max(256, Math.min(2048, Math.round(Number(raw.width ?? fallback.width) || fallback.width))),
      height: Math.max(256, Math.min(2048, Math.round(Number(raw.height ?? fallback.height) || fallback.height))),
      manualPrompt: String(raw.manualPrompt ?? ''),
      characterAnchors: anchors,
      systemPrompt: String(raw.systemPrompt ?? ''),
    };
  }

function restoreRollbackSnapshot(state: AppState, snapshot: RollbackSnapshot) {
  state.statusData = cloneJson(snapshot.statusData);
  if (snapshot.playerProfile) {
    state.playerProfile = applyProfileDefaults(cloneJson(snapshot.playerProfile));
  }
  if (snapshot.drawingSettings) {
    state.drawingSettings = normalizeDrawingSettings(snapshot.drawingSettings);
    state.runtimeFlags.drawingSettings = cloneJson(state.drawingSettings);
  }
  if (snapshot.phoneMessages) {
    state.phoneMessages = clonePhoneMessagesForSnapshot(snapshot.phoneMessages);
  }
  if (snapshot.summaryStore) {
    state.summaryStore = deserializeSummaryStore(snapshot.summaryStore);
  }
  if (snapshot.memoryDB) {
    state.memoryDB = cloneMemoryDBForSnapshot(snapshot.memoryDB) ?? state.memoryDB;
  }
}

function prunePhoneMessagesAfterFloor(state: AppState, floorIndex: number) {
  const removedIds = new Set<string>();
  const threads: PhoneMessageStore['threads'] = {};

  for (const [targetId, thread] of Object.entries(state.phoneMessages.threads)) {
    const messages = thread.messages.filter(message => {
      if (typeof message.floorIndex !== 'number') return true;
      const keep = message.floorIndex <= floorIndex;
      if (!keep) removedIds.add(message.id);
      return keep;
    });

    threads[targetId] = {
      ...thread,
      messages,
      unread: messages.length ? Math.min(thread.unread, messages.length) : 0,
      updatedAt: messages.length ? thread.updatedAt : Date.now(),
    };
  }

  state.phoneMessages = {
    ...state.phoneMessages,
    threads,
  };

  if (removedIds.size) {
    const updatedAt = new Date().toISOString();
    state.memoryDB.phoneMessages.forEach(row => {
      if (removedIds.has(row.messageId)) {
        row.expired = true;
        row.updatedAt = updatedAt;
      }
    });
  }
}

function countRollbackConversationMessages(state: Pick<AppState, 'uiMessages'>) {
  return state.uiMessages.filter(message => message.role === 'user' || message.role === 'assistant').length;
}

function countConversationMessagesBeforeUiIndex(state: Pick<AppState, 'uiMessages'>, uiIndex: number) {
  return state.uiMessages
    .slice(0, Math.max(0, uiIndex))
    .filter(message => !message.streaming && (message.role === 'user' || message.role === 'assistant')).length;
}

function isRangePastConversation(range: unknown, conversationCount: number) {
  if (!Array.isArray(range) || range.length < 2) return false;
  const end = Number(range[1]);
  return Number.isFinite(end) && end >= conversationCount;
}

function isRangePastRollbackBoundary(range: unknown, conversationCount: number, readerMessageCount: number) {
  if (!Array.isArray(range) || range.length < 2) return false;
  const end = Number(range[1]);
  if (!Number.isFinite(end)) return false;
  return end >= conversationCount || end >= readerMessageCount;
}

function pruneSummaryStoreAfterConversationCount(state: AppState, conversationCount: number, readerMessageCount: number) {
  state.summaryStore.minor = state.summaryStore.minor.filter(
    entry => !isRangePastRollbackBoundary(entry.range, conversationCount, readerMessageCount),
  );
  state.summaryStore.major = state.summaryStore.major.filter(
    entry => !isRangePastRollbackBoundary(entry.range, conversationCount, readerMessageCount),
  );
  state.summaryStore.keyFacts = state.summaryStore.keyFacts.filter(
    fact => !isRangePastRollbackBoundary(fact.sourceRange, conversationCount, readerMessageCount),
  );
  if (state.summaryStore.global && state.summaryStore.lastSummarizedIndex > Math.min(conversationCount, readerMessageCount)) {
    state.summaryStore.global = null;
  }
  state.summaryStore.lastSummarizedIndex = Math.min(
    state.summaryStore.lastSummarizedIndex,
    conversationCount,
    readerMessageCount,
  );
}

function pruneMemoryRowsAfterConversationCount(state: AppState, conversationCount: number, readerMessageCount: number) {
  const updatedAt = new Date().toISOString();
  for (const tableName of MEMORY_ROW_TABLES) {
    const table = state.memoryDB[tableName] as MemoryBaseRow[];
    for (const row of table) {
      if (row.expired) continue;
      const summaryRange = 'range' in row ? (row as { range?: unknown }).range : undefined;
      if (
        isRangePastRollbackBoundary(row.sourceRange, conversationCount, readerMessageCount) ||
        isRangePastRollbackBoundary(summaryRange, conversationCount, readerMessageCount)
      ) {
        row.expired = true;
        row.updatedAt = updatedAt;
      }
    }
  }

  if (state.memoryDB.extensions) {
    for (const table of Object.values(state.memoryDB.extensions)) {
      for (const row of table) {
        if (row.expired) continue;
        if (isRangePastRollbackBoundary(row.sourceRange, conversationCount, readerMessageCount)) {
          row.expired = true;
          row.updatedAt = updatedAt;
        }
      }
    }
  }

  state.memoryDB.lastProcessedIndex = Math.min(state.memoryDB.lastProcessedIndex, conversationCount, readerMessageCount);
}

function mergeSummaryEntries<T extends { range: [number, number]; text: string }>(
  current: T[],
  previous: T[],
  conversationCount: number,
  readerMessageCount: number,
) {
  const seen = new Set(current.map(entry => `${entry.range[0]}:${entry.range[1]}:${entry.text}`));
  const merged = [...current];
  for (const entry of previous) {
    if (isRangePastRollbackBoundary(entry.range, conversationCount, readerMessageCount)) continue;
    const key = `${entry.range[0]}:${entry.range[1]}:${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cloneJson(entry));
  }
  return merged.sort((a, b) => a.range[0] - b.range[0]);
}

function mergeSummaryStoreAfterSnapshotRestore(
  state: AppState,
  previous: SummaryStore | null | undefined,
  conversationCount: number,
  readerMessageCount: number,
) {
  if (!previous) return;
  state.summaryStore.minor = mergeSummaryEntries(state.summaryStore.minor, previous.minor, conversationCount, readerMessageCount);
  state.summaryStore.major = mergeSummaryEntries(state.summaryStore.major, previous.major, conversationCount, readerMessageCount);

  const factIds = new Set(state.summaryStore.keyFacts.map(fact => fact.id));
  for (const fact of previous.keyFacts) {
    if (isRangePastRollbackBoundary(fact.sourceRange, conversationCount, readerMessageCount)) continue;
    if (factIds.has(fact.id)) continue;
    factIds.add(fact.id);
    state.summaryStore.keyFacts.push(cloneJson(fact));
  }

  if (!state.summaryStore.global && previous.global && previous.lastSummarizedIndex <= Math.min(conversationCount, readerMessageCount)) {
    state.summaryStore.global = previous.global;
  }
  state.summaryStore.lastSummarizedIndex = Math.min(
    Math.max(state.summaryStore.lastSummarizedIndex, previous.lastSummarizedIndex),
    conversationCount,
    readerMessageCount,
  );
}

function rowSurvivesRollback(row: MemoryBaseRow, conversationCount: number, readerMessageCount: number) {
  const summaryRange = 'range' in row ? (row as { range?: unknown }).range : undefined;
  if (row.sourceRange || summaryRange) {
    return !isRangePastRollbackBoundary(row.sourceRange, conversationCount, readerMessageCount) &&
      !isRangePastRollbackBoundary(summaryRange, conversationCount, readerMessageCount);
  }
  return false;
}

function mergeMemoryDBAfterSnapshotRestore(
  state: AppState,
  previous: IslandMemoryDB | null | undefined,
  conversationCount: number,
  readerMessageCount: number,
) {
  if (!previous) return;

  for (const tableName of MEMORY_ROW_TABLES) {
    const currentTable = state.memoryDB[tableName] as MemoryBaseRow[];
    const previousTable = previous[tableName] as MemoryBaseRow[];
    const ids = new Set(currentTable.map(row => row.id));
    for (const row of previousTable) {
      if (!rowSurvivesRollback(row, conversationCount, readerMessageCount)) continue;
      if (ids.has(row.id)) continue;
      ids.add(row.id);
      currentTable.push(cloneJson(row));
    }
  }

  if (previous.extensions) {
    state.memoryDB.extensions ??= {};
    for (const [tableName, previousTable] of Object.entries(previous.extensions)) {
      const currentTable = (state.memoryDB.extensions[tableName] ??= []);
      const ids = new Set(currentTable.map(row => row.id));
      for (const row of previousTable) {
        if (!rowSurvivesRollback(row, conversationCount, readerMessageCount)) continue;
        if (ids.has(row.id)) continue;
        ids.add(row.id);
        currentTable.push(cloneJson(row));
      }
    }
  }

  state.memoryDB.lastProcessedIndex = Math.min(
    Math.max(state.memoryDB.lastProcessedIndex, previous.lastProcessedIndex),
    conversationCount,
    readerMessageCount,
  );
}

function pruneMemoryAndSummariesAfterRollback(
  state: AppState,
  previousSummaryStore?: SummaryStore | null,
  previousMemoryDB?: IslandMemoryDB | null,
  pruneFromConversationIndex?: number,
) {
  const conversationCount = countRollbackConversationMessages(state);
  const readerMessageCount = getReaderMessages(state.uiMessages, true).filter(
    message => !message.streaming && (message.role === 'user' || message.role === 'assistant'),
  ).length;
  const pruneThreshold = Math.max(
    0,
    Math.min(conversationCount, readerMessageCount, Math.floor(pruneFromConversationIndex ?? conversationCount)),
  );
  mergeSummaryStoreAfterSnapshotRestore(state, previousSummaryStore, pruneThreshold, readerMessageCount);
  mergeMemoryDBAfterSnapshotRestore(state, previousMemoryDB, pruneThreshold, readerMessageCount);
  pruneSummaryStoreAfterConversationCount(state, pruneThreshold, readerMessageCount);
  pruneMemoryRowsAfterConversationCount(state, pruneThreshold, readerMessageCount);

  const hydrated = hydrateSummaryStoreFromMemoryDB(state.memoryDB);
  state.summaryStore.global = hydrated.global;
  state.summaryStore.major = hydrated.major;
  state.summaryStore.minor = hydrated.minor;
  state.summaryStore.keyFacts = hydrated.keyFacts.filter(
    fact => !isRangePastRollbackBoundary(fact.sourceRange, conversationCount, readerMessageCount),
  );
  state.summaryStore.lastSummarizedIndex = Math.min(state.summaryStore.lastSummarizedIndex, conversationCount, readerMessageCount);
}

function mapChatMessageToUiMessage(
  message: NonNullable<ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number]>,
): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: message.role,
    speaker: message.name || message.role,
    text: String(message.message ?? ''),
    rawText: String(message.message ?? ''),
    tavernMessageId: message.message_id,
  };
}

function isMarkedMessage(message: NonNullable<ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number]>) {
  return message?.data?.islandmilfcode_source === MESSAGE_MARKER;
}

function isLegacyHiddenMessage(message: NonNullable<ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number]>) {
  return message?.is_hidden === true && (message?.role === 'user' || message?.role === 'assistant');
}

/** 将界面消息序列化为存档槽里的 PersistedMessage[]。 */
export function serializeMessages(messages: UiMessage[]): PersistedMessage[] {
  return messages
    .filter(
      (message): message is UiMessage & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant',
    )
    .map(message => {
      const base: PersistedMessage = {
        role: message.role,
        speaker: String(message.speaker || (message.role === 'assistant' ? 'Assistant' : 'User')),
        text: String(message.text ?? ''),
      };
      if (message.rawText) {
        base.rawText = String(message.rawText);
      }
      if (message.illustrations?.length) {
        base.illustrations = message.illustrations.map(illustration => ({
          id: String(illustration.id || crypto.randomUUID()),
          imageData: String(illustration.imageData || ''),
          prompt: illustration.prompt ? String(illustration.prompt) : undefined,
          createdAt: Number(illustration.createdAt) || Date.now(),
        })).filter(illustration => illustration.imageData);
      }
      if (message.statusSnapshot) {
        base.statusSnapshot = normalizeRollbackSnapshot(message.statusSnapshot, { includeSideWindows: false });
      }
      return base;
    });
}

/** 将存档槽里的 PersistedMessage[] 反序列化为界面消息。 */
export function deserializeMessages(messages: PersistedMessage[]): UiMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(msg => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.text === 'string')
    .map(msg => {
      const ui: UiMessage = {
        id: crypto.randomUUID(),
        role: msg.role,
        speaker: String(msg.speaker || (msg.role === 'assistant' ? 'Assistant' : 'User')),
        text: String(msg.text ?? ''),
        rawText: msg.rawText ? String(msg.rawText) : undefined,
        illustrations: Array.isArray(msg.illustrations)
          ? msg.illustrations
              .map(illustration => ({
                id: String(illustration.id || crypto.randomUUID()),
                imageData: String(illustration.imageData || ''),
                prompt: illustration.prompt ? String(illustration.prompt) : undefined,
                createdAt: Number(illustration.createdAt) || Date.now(),
              }))
              .filter(illustration => illustration.imageData)
          : undefined,
      };
      if (msg.statusSnapshot) {
        ui.statusSnapshot = normalizeRollbackSnapshot(msg.statusSnapshot, { includeSideWindows: false });
      }
      return ui;
    });
}

export function createInitialState(floatingPhone: FloatingPhonePosition): AppState {
  return {
    activeRunId: null,
    activeSaveId: null,
    creatingCharacter: false,
    showingSaveList: false,
    playerProfile: {
      name: '',
      [PROFILE_KEYS.role]: PROFILE_DEFAULTS.role,
      personality: '',
      appearance: '',
    },
    playerProfileEditing: false,
    activeTab: 'summary',
    phoneOpen: false,
    phoneRoute: 'home',
    phoneRouteHistory: [],
    phoneCharacterId: 'megumi',
    phoneMessages: createDefaultPhoneMessageStore(),
    floatingPhone,
    focusedMessageIndex: 0,
    focusedMessagePage: 0,
    draft: '',
    generating: false,
    currentGenerationId: '',
    finalizedGenerationId: '',
    runtimeFlags: {},
    plotLibrary: createEmptyPlotLibrary(),
    characterCardLibrary: createEmptyCharacterCardLibrary(),
    uiMessages: [createSystemMessage()],
    statusData: normalizeStatusData(defaultStatusData),
    musicPlayer: createDefaultMusicPlayerState(),
    drawingSettings: createDefaultDrawingSettings(),
    notification: null,
    backgroundTasks: [],
    readerContextMenu: null,
    readerEditing: null,
    summaryStore: createDefaultSummaryStore(),
    summaryApiConfig: null,
    summaryModelFetch: {
      loading: false,
      models: [],
      error: null,
      fetchedAt: null,
    },
    summarizing: false,
    memoryDB: createDefaultMemoryDB(''),
    memoryEditor: createDefaultMemoryEditorState(),
  };
}

export function replaceConversationMessages(state: AppState, messages: UiMessage[]) {
  state.uiMessages = [createSystemMessage(), ...messages];
  syncFocusedMessage(state, { keepLatest: true });
}

export async function loadMessagesFromChat(win: TavernWindow): Promise<UiMessage[]> {
  if (typeof win.getChatMessages !== 'function') {
    return [];
  }

  try {
    const allMessages = win.getChatMessages('0-{{lastMessageId}}', {
      hide_state: 'all',
      include_swipes: false,
    });

    if (!Array.isArray(allMessages) || !allMessages.length) {
      return [];
    }

    const markedMessages = allMessages.filter(
      (message): message is NonNullable<typeof message> =>
        Boolean(message) && typeof message.message_id === 'number' && isMarkedMessage(message),
    );

    const selectedMessages = markedMessages.length
      ? markedMessages
      : allMessages.filter(
          (message): message is NonNullable<typeof message> =>
            Boolean(message) && typeof message.message_id === 'number' && isLegacyHiddenMessage(message),
        );

    if (!selectedMessages.length) {
      return [];
    }

    return selectedMessages
      .filter(message => !isFrontendHtmlShell(String(message.message ?? '')))
      .map(message => mapChatMessageToUiMessage(message));
  } catch {
    return [];
  }
}

export function clampFocusedMessageIndex(state: AppState, index: number) {
  return clamp(index, 0, Math.max(getReaderMessages(state.uiMessages).length - 1, 0));
}

export function syncFocusedMessage(state: AppState, options: { keepLatest?: boolean } = {}) {
  const { keepLatest = false } = options;
  const readerMessages = getReaderMessages(state.uiMessages);

  state.focusedMessageIndex = keepLatest
    ? Math.max(readerMessages.length - 1, 0)
    : clampFocusedMessageIndex(state, state.focusedMessageIndex);
  state.focusedMessagePage = 0;
}

export function getReaderMessageByIndex(state: AppState, index: number) {
  return getReaderMessages(state.uiMessages)[index] ?? null;
}

export function getRollbackTargetForReaderIndex(state: AppState, index: number) {
  const targetMessage = getReaderMessageByIndex(state, index);
  if (!targetMessage) return null;

  const targetUiIndex = state.uiMessages.findIndex(message => message.id === targetMessage.id);
  if (targetUiIndex < 0) return null;

  if (targetMessage.role === 'user') {
    return {
      sourceUserText: targetMessage.text.trim(),
      sourceUserIndex: targetUiIndex,
    };
  }

  for (let cursor = targetUiIndex - 1; cursor >= 0; cursor -= 1) {
    const candidate = state.uiMessages[cursor];
    if (candidate?.role === 'user') {
      return {
        sourceUserText: candidate.text.trim(),
        sourceUserIndex: cursor,
      };
    }
  }

  return null;
}

export function getSourceUserTextForReaderIndex(state: AppState, index: number) {
  return getRollbackTargetForReaderIndex(state, index)?.sourceUserText ?? '';
}

export async function rollbackConversation(state: AppState, readerIndex: number, win?: TavernWindow) {
  const target = getRollbackTargetForReaderIndex(state, readerIndex);
  if (!target) return null;
  const previousSummaryStore = cloneJson(state.summaryStore);
  const previousMemoryDB = cloneJson(state.memoryDB);
  const rollbackConversationIndex = countConversationMessagesBeforeUiIndex(state, target.sourceUserIndex);

  const removedMessageIds = state.uiMessages
    .slice(target.sourceUserIndex)
    .map(message => message.tavernMessageId)
    .filter((messageId): messageId is number => typeof messageId === 'number');

  if (removedMessageIds.length && typeof win?.deleteChatMessages === 'function') {
    try {
      await win.deleteChatMessages(removedMessageIds, { refresh: 'all' });
    } catch {
      // 不在 Tavern 内或删除失败时直接忽略。
    }
  }

  // 优先恢复源用户消息自身的快照，再回退到更早的消息快照。
  for (let i = target.sourceUserIndex; i >= 0; i--) {
    const msg = state.uiMessages[i];
    if (msg?.statusSnapshot) {
      restoreRollbackSnapshot(state, normalizeRollbackSnapshot(msg.statusSnapshot));
      break;
    }
  }

  state.uiMessages = state.uiMessages.slice(0, Math.max(1, target.sourceUserIndex));
  state.focusedMessageIndex = Math.max(getReaderMessages(state.uiMessages).length - 1, 0);
  state.focusedMessagePage = 0;
  prunePhoneMessagesAfterFloor(state, state.focusedMessageIndex);
  pruneMemoryAndSummariesAfterRollback(state, previousSummaryStore, previousMemoryDB, rollbackConversationIndex);
  state.currentGenerationId = '';
  state.finalizedGenerationId = '';
  state.notification = null;

  return target;
}

export async function deleteReaderMessage(state: AppState, readerIndex: number, win?: TavernWindow) {
  const targetMessage = getReaderMessageByIndex(state, readerIndex);
  if (!targetMessage) return false;
  const previousSummaryStore = cloneJson(state.summaryStore);
  const previousMemoryDB = cloneJson(state.memoryDB);

  const targetUiIndex = state.uiMessages.findIndex(message => message.id === targetMessage.id);
  if (targetUiIndex < 0) return false;
  const deletedConversationIndex = countConversationMessagesBeforeUiIndex(state, targetUiIndex);

  if (typeof targetMessage.tavernMessageId === 'number' && typeof win?.deleteChatMessages === 'function') {
    try {
      await win.deleteChatMessages([targetMessage.tavernMessageId], { refresh: 'all' });
    } catch {
      // 不在 Tavern 内或删除失败时直接忽略。
    }
  }

  for (let i = targetUiIndex - 1; i >= 0; i -= 1) {
    const msg = state.uiMessages[i];
    if (msg?.statusSnapshot) {
      restoreRollbackSnapshot(state, normalizeRollbackSnapshot(msg.statusSnapshot));
      break;
    }
  }

  state.uiMessages = state.uiMessages.filter(message => message.id !== targetMessage.id);
  syncFocusedMessage(state);
  prunePhoneMessagesAfterFloor(state, state.focusedMessageIndex);
  pruneMemoryAndSummariesAfterRollback(state, previousSummaryStore, previousMemoryDB, deletedConversationIndex);
  state.currentGenerationId = '';
  state.finalizedGenerationId = '';
  state.notification = null;

  return true;
}

export function pushMessage(state: AppState, message: UiMessage) {
  state.uiMessages = [...state.uiMessages, message];
  syncFocusedMessage(state, { keepLatest: true });
  return message;
}
