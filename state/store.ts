import { getReaderMessages } from '../message-format';
import type { AppState, FloatingPhonePosition, TavernWindow, UiMessage } from '../types';
import { clamp, defaultStatusData, normalizeStatusData } from '../variables/normalize';

export const ANTIML_MESSAGE_MARKER = 'islandmilfcode';
export const ANTIML_CHATLOG_KEY = 'chatlog';

type PersistedConversation = {
  version: 1;
  messages: Array<Pick<UiMessage, 'role' | 'speaker' | 'text'>>;
};

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

function isMarkedAntimlMessage(message: NonNullable<ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number]>) {
  return message?.data?.antiml_source === ANTIML_MESSAGE_MARKER;
}

function isLegacyAntimlMessage(message: NonNullable<ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number]>) {
  return message?.is_hidden === true && (message?.role === 'user' || message?.role === 'assistant');
}

function getChatVariableOption() {
  return {
    type: 'chat' as const,
  };
}

function serializeConversation(messages: UiMessage[]): PersistedConversation {
  return {
    version: 1,
    messages: messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => ({
        role: message.role,
        speaker: String(message.speaker || (message.role === 'assistant' ? 'Assistant' : 'User')),
        text: String(message.text ?? ''),
      })),
  };
}

function deserializeConversation(raw: unknown): UiMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const messages = Array.isArray((raw as PersistedConversation).messages)
    ? (raw as PersistedConversation).messages
    : Array.isArray(raw)
      ? raw
      : [];

  return messages
    .filter((message): message is Pick<UiMessage, 'role' | 'speaker' | 'text'> => {
      if (!message || typeof message !== 'object') return false;
      const role = (message as UiMessage).role;
      return (role === 'user' || role === 'assistant') && typeof (message as UiMessage).text === 'string';
    })
    .map(message => ({
      id: crypto.randomUUID(),
      role: message.role,
      speaker: String(message.speaker || (message.role === 'assistant' ? 'Assistant' : 'User')),
      text: String(message.text ?? ''),
    }));
}

export function createInitialState(floatingPhone: FloatingPhonePosition): AppState {
  return {
    activeTab: 'summary',
    phoneOpen: false,
    floatingPhone,
    focusedMessageIndex: 0,
    focusedMessagePage: 0,
    draft: '',
    generating: false,
    currentGenerationId: '',
    finalizedGenerationId: '',
    uiMessages: [createSystemMessage()],
    statusData: normalizeStatusData(defaultStatusData),
    notification: null,
    readerContextMenu: null,
  };
}

export function replaceConversationMessages(state: AppState, messages: UiMessage[]) {
  state.uiMessages = [createSystemMessage(), ...messages];
  syncFocusedMessage(state, { keepLatest: true });
}

export function loadMessagesFromVariables(win: TavernWindow): UiMessage[] | null {
  try {
    const variables = win.getVariables?.(getChatVariableOption()) ?? {};
    if (!(ANTIML_CHATLOG_KEY in variables)) {
      return null;
    }
    return deserializeConversation(variables[ANTIML_CHATLOG_KEY]);
  } catch {
    return null;
  }
}

export function saveMessagesToVariables(win: TavernWindow, messages: UiMessage[]) {
  try {
    win.updateVariablesWith?.(variables => {
      variables[ANTIML_CHATLOG_KEY] = serializeConversation(messages);
      return variables;
    }, getChatVariableOption());
  } catch {
    // ignore outside Tavern
  }
}

export async function clearLegacyMessagesFromChat(messages: UiMessage[], win?: TavernWindow) {
  const removedMessageIds = messages
    .map(message => message.tavernMessageId)
    .filter((messageId): messageId is number => typeof messageId === 'number');

  if (!removedMessageIds.length || typeof win?.deleteChatMessages !== 'function') {
    return;
  }

  try {
    await win.deleteChatMessages(removedMessageIds, { refresh: 'all' });
  } catch {
    // ignore outside Tavern or deletion failures
  }
}

export async function loadConversationHistory(win: TavernWindow): Promise<UiMessage[]> {
  const variableMessages = loadMessagesFromVariables(win);
  if (variableMessages) {
    return variableMessages;
  }

  const legacyMessages = await loadMessagesFromChat(win);
  if (!legacyMessages.length) {
    return [];
  }

  saveMessagesToVariables(win, legacyMessages);
  await clearLegacyMessagesFromChat(legacyMessages, win);
  return legacyMessages.map(({ tavernMessageId, ...message }) => message);
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
        Boolean(message) && typeof message.message_id === 'number' && isMarkedAntimlMessage(message),
    );

    const selectedMessages = markedMessages.length
      ? markedMessages
      : allMessages.filter(
          (message): message is NonNullable<typeof message> =>
            Boolean(message) && typeof message.message_id === 'number' && isLegacyAntimlMessage(message),
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

  state.uiMessages = state.uiMessages.slice(0, Math.max(1, target.sourceUserIndex));
  state.focusedMessageIndex = Math.max(getReaderMessages(state.uiMessages).length - 1, 0);
  state.focusedMessagePage = 0;
  state.currentGenerationId = '';
  state.finalizedGenerationId = '';
  state.notification = null;

  return target;
}

export function pushMessage(state: AppState, message: UiMessage) {
  state.uiMessages = [...state.uiMessages, message];
  syncFocusedMessage(state, { keepLatest: true });
  return message;
}
