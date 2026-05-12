import { getReaderMessages } from '../message-format';
import { createDefaultSummaryStore, deserializeSummaryStore } from '../summary/types';
import type { FloatingPhonePosition } from '../phone/types';
import type {
  AppState,
  PersistedMessage,
  PhoneMessageStore,
  PlotLibrary,
  RollbackSnapshot,
  TavernWindow,
  UiMessage,
} from '../types';
import { clamp, defaultStatusData, normalizeStatusData } from '../variables/normalize';
import { getDefaultWeatherState } from '../phone/weather';

export const MESSAGE_MARKER = 'islandmilfcode';

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
          .map(message => ({
            id: String(message.id || crypto.randomUUID()),
            role: message.role,
            speaker: String(message.speaker || (message.role === 'assistant' ? '角色' : '我')),
            text: String(message.text ?? ''),
            timestamp: String(message.timestamp || ''),
            ...(message.statusSnapshot
              ? { statusSnapshot: normalizeRollbackSnapshot(message.statusSnapshot, { includeSideWindows: false }) }
              : {}),
          }))
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

  if (includeSideWindows) {
    if (raw.phoneMessages) {
      snapshot.phoneMessages = clonePhoneMessagesForSnapshot(raw.phoneMessages);
    }
    if (raw.summaryStore) {
      snapshot.summaryStore = deserializeSummaryStore(raw.summaryStore);
    }
  }

  return snapshot;
}

export function createRollbackSnapshot(state: Pick<AppState, 'statusData' | 'phoneMessages' | 'summaryStore'>) {
  return {
    statusData: cloneJson(state.statusData),
    phoneMessages: clonePhoneMessagesForSnapshot(state.phoneMessages),
    summaryStore: deserializeSummaryStore(cloneJson(state.summaryStore)),
  };
}

function restoreRollbackSnapshot(state: AppState, snapshot: RollbackSnapshot) {
  state.statusData = cloneJson(snapshot.statusData);
  if (snapshot.phoneMessages) {
    state.phoneMessages = clonePhoneMessagesForSnapshot(snapshot.phoneMessages);
  }
  if (snapshot.summaryStore) {
    state.summaryStore = deserializeSummaryStore(snapshot.summaryStore);
  }
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
      if (message.statusSnapshot) {
        base.statusSnapshot = normalizeRollbackSnapshot(message.statusSnapshot);
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
      };
      if (msg.statusSnapshot) {
        ui.statusSnapshot = normalizeRollbackSnapshot(msg.statusSnapshot);
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
    uiMessages: [createSystemMessage()],
    statusData: normalizeStatusData(defaultStatusData),
    weather: getDefaultWeatherState(),
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

    return selectedMessages.map(message => mapChatMessageToUiMessage(message));
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

  const removedMessageIds = state.uiMessages
    .slice(target.sourceUserIndex)
    .map(message => message.tavernMessageId)
    .filter((messageId): messageId is number => typeof messageId === 'number');

  if (removedMessageIds.length && typeof win?.deleteChatMessages === 'function') {
    try {
      await win.deleteChatMessages(removedMessageIds, { refresh: 'none' });
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
  state.currentGenerationId = '';
  state.finalizedGenerationId = '';
  state.notification = null;

  return target;
}

export async function deleteReaderMessage(state: AppState, readerIndex: number, win?: TavernWindow) {
  const targetMessage = getReaderMessageByIndex(state, readerIndex);
  if (!targetMessage) return false;

  const targetUiIndex = state.uiMessages.findIndex(message => message.id === targetMessage.id);
  if (targetUiIndex < 0) return false;

  if (typeof targetMessage.tavernMessageId === 'number' && typeof win?.deleteChatMessages === 'function') {
    try {
      await win.deleteChatMessages([targetMessage.tavernMessageId], { refresh: 'none' });
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
