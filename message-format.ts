import type { StatusData, UiMessage } from './types';
import { getActiveTarget } from './types';

export const PRIMARY_VISIBLE_TAG = 'content';
export const FALLBACK_VISIBLE_TAGS = ['context'];

export function sanitizeVisibleReply(text: string) {
  return text.replace(/^\s*(?:assistant|ai|reply|response)\s*[:：\-\s]*/i, '').trim();
}

function dedupeAdjacentReply(text: string) {
  const normalized = sanitizeVisibleReply(text);
  if (!normalized) return '';

  const parts = normalized
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length === 2 && parts[0] === parts[1]) {
    return parts[0];
  }

  return normalized;
}

export function extractTaggedReply(raw: string, tagName: string, streaming: boolean) {
  const closedTag = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const closedMatch = raw.match(closedTag);
  if (closedMatch) {
    return dedupeAdjacentReply(closedMatch[1] ?? '');
  }

  if (streaming) {
    const openedTag = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*)$`, 'i');
    const openedMatch = raw.match(openedTag);
    if (openedMatch) {
      return dedupeAdjacentReply((openedMatch[1] ?? '').replace(/<[^>]*$/, ''));
    }
  }

  const openTag = new RegExp(`<${tagName}\\b[^>]*>`, 'i');
  const openMatch = raw.match(openTag);
  if (openMatch?.index != null) {
    const afterOpen = raw.slice(openMatch.index + openMatch[0].length);
    const nextSectionIndex = afterOpen.search(
      /<\/?(?:think|content|context|tucao|current_event|progress|roleplay_options)\b[^>]*>/i,
    );
    const visible = nextSectionIndex >= 0 ? afterOpen.slice(0, nextSectionIndex) : afterOpen;
    return dedupeAdjacentReply(visible);
  }

  return '';
}

export function extractContextReply(text: string, { streaming = false }: { streaming?: boolean } = {}) {
  const raw = String(text ?? '');
  if (!raw) {
    return '';
  }

  for (const tagName of [PRIMARY_VISIBLE_TAG, ...FALLBACK_VISIBLE_TAGS]) {
    const tagged = extractTaggedReply(raw, tagName, streaming);
    if (tagged) {
      return tagged;
    }
  }

  if (/<\/?[a-zA-Z][^>]*>/i.test(raw)) {
    return '';
  }

  return dedupeAdjacentReply(raw);
}

export function getVisibleMessageText(message: UiMessage) {
  if (message.role !== 'assistant') {
    return message.text;
  }

  return extractContextReply(message.text) || '';
}

export function getReaderMessages(messages: UiMessage[]) {
  return messages.filter(
    message =>
      message.role !== 'system' &&
      (message.role !== 'assistant' || message.streaming || Boolean(getVisibleMessageText(message))) &&
      Boolean(getVisibleMessageText(message) || message.streaming),
  );
}

function buildConversationHistory(uiMessages: UiMessage[]) {
  const historyLines = uiMessages
    .filter(message => !message.streaming && (message.role === 'user' || message.role === 'assistant'))
    .map(message => {
      const visibleText = (message.role === 'assistant' ? getVisibleMessageText(message) || message.text : message.text).trim();
      if (!visibleText) return '';
      const speaker = (message.speaker || (message.role === 'assistant' ? 'Assistant' : 'User')).trim();
      return `[${message.role}:${speaker}]\n${visibleText}`;
    })
    .filter(Boolean);

  if (!historyLines.length) {
    return '';
  }

  return ['Conversation history:', ...historyLines].join('\n\n');
}

export function buildPrompt(statusData: StatusData, uiMessages: UiMessage[], userInput: string) {
  const target = getActiveTarget(statusData);
  const topEvent = Object.entries(statusData.world.recentEvents)[0];
  const targetName = target?.name ?? 'Target';
  const conversationHistory = buildConversationHistory(uiMessages);

  return [
    `You are continuing the diary-style chat for ${targetName}.`,
    `Visible reply text must be wrapped in <${PRIMARY_VISIBLE_TAG}>...</${PRIMARY_VISIBLE_TAG}>.`,
    'You may use <context>...</context> for hidden reasoning/context, but keep the visible reply only inside the visible tag.',
    'Avoid markdown tables unless the user explicitly asks for them.',
    'Keep the response focused, natural, and consistent with the current scene.',
    `Current location: ${statusData.world.currentLocation}`,
    `Current relationship stage: ${target?.stage ?? ''}`,
    topEvent ? `Latest event: ${topEvent[0]} - ${topEvent[1]}` : '',
    conversationHistory,
    userInput ? `Current user input: ${userInput}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
