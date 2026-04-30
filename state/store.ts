import { getReaderMessages } from '../message-format';
import { createDefaultSummaryStore } from '../summary/types';
import type { FloatingPhonePosition } from '../phone/types';
import type { AppState, PersistedMessage, TavernWindow, UiMessage } from '../types';
import { clamp, defaultStatusData, normalizeStatusData } from '../variables/normalize';
import { getDefaultWeatherState } from '../phone/weather';

export const MESSAGE_MARKER = 'islandmilfcode';

function createSystemMessage(): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    speaker: 'system',
    text: '',
  };
}

function mapChatMessageToUiMessage(
  message: NonNullable<ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number]>,
): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: message.role,
    speaker: message.name || message.role,
    text: String(message.message ?? ''),
    tavernMessageId: message.message_id,
  };
}

function isMarkedMessage(message: NonNullable<ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number]>) {
  return message?.data?.islandmilfcode_source === MESSAGE_MARKER;
}

function isLegacyHiddenMessage(message: NonNullable<ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number]>) {
  return message?.is_hidden === true && (message?.role === 'user' || message?.role === 'assistant');
}

/** Serialize uiMessages to PersistedMessage[] for save slots. */
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
      if (message.statusSnapshot) {
        base.statusSnapshot = message.statusSnapshot;
      }
      return base;
    });
}

/** Deserialize PersistedMessage[] from a save slot into UiMessage[]. */
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
      };
      if (msg.statusSnapshot) {
        ui.statusSnapshot = msg.statusSnapshot;
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
    activeTab: 'summary',
    phoneOpen: false,
    phoneRoute: 'home',
    phoneRouteHistory: [],
    floatingPhone,
    focusedMessageIndex: 0,
    focusedMessagePage: 0,
    draft: '',
    generating: false,
    currentGenerationId: '',
    finalizedGenerationId: '',
    uiMessages: [createSystemMessage()],
    statusData: normalizeStatusData(defaultStatusData),
    weather: getDefaultWeatherState(),
    notification: null,
    readerContextMenu: null,
    summaryStore: createDefaultSummaryStore(),
    summaryApiConfig: null,
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
      // ignore outside Tavern or deletion failures
    }
  }

  // Restore the snapshot at the source user message itself first,
  // then fall back to earlier messages.
  for (let i = target.sourceUserIndex; i >= 0; i--) {
    const msg = state.uiMessages[i];
    if (msg?.statusSnapshot) {
      state.statusData = JSON.parse(JSON.stringify(msg.statusSnapshot));
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
      // ignore outside Tavern or deletion failures
    }
  }

  for (let i = targetUiIndex - 1; i >= 0; i -= 1) {
    const msg = state.uiMessages[i];
    if (msg?.statusSnapshot) {
      state.statusData = JSON.parse(JSON.stringify(msg.statusSnapshot));
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
