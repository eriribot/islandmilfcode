import type { StatusData, UiMessage } from './types';
import { getActiveTarget } from './types';

export const PRIMARY_VISIBLE_TAG = 'content';
export const FALLBACK_VISIBLE_TAGS = ['context'];

export function sanitizeVisibleReply(text: string) {
  return text.replace(/^\s*(?:assistant|ai|reply|response)\s*[:：]\s*/i, '').trim();
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

export function buildPrompt(statusData: StatusData, userInput: string) {
  const target = getActiveTarget(statusData);
  const topEvent = Object.entries(statusData.world.recentEvents)[0];
  const targetName = target?.name ?? '角色';
  return [
    `你正在扮演${targetName}，请结合当前酒馆预设生成回复。`,
    '要求：',
    `1. 可见正文必须且只能放在 <${PRIMARY_VISIBLE_TAG}>...</${PRIMARY_VISIBLE_TAG}> 里。`,
    '2. 不要输出 <context>，也不要同时输出多份可见正文。',
    '3. 正文不要 markdown、不要角色名前缀、不要解释。',
    '4. 2~4 句，语气带有轻度依赖与夜间私聊感。',
    '5. 结合当前地点、依存度阶段、近期事务。',
    `当前地点：${statusData.world.currentLocation}`,
    `当前阶段：${target?.stage ?? ''}`,
    topEvent ? `当前最重要事务：${topEvent[0]}：${topEvent[1]}` : '',
    `玩家输入：${userInput}`,
  ]
    .filter(Boolean)
    .join('\n');
}
