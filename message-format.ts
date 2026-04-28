import type { SummaryStore } from './summary/types';
import type { PlayerProfile, StatusData, UiMessage } from './types';
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

function buildConversationHistory(uiMessages: UiMessage[], startIndex = 0) {
  const historyLines = uiMessages
    .slice(startIndex)
    .filter(message => !message.streaming && (message.role === 'user' || message.role === 'assistant'))
    .map(message => {
      const visibleText = (
        message.role === 'assistant' ? getVisibleMessageText(message) || message.text : message.text
      ).trim();
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

function buildSummaryContextInline(store: SummaryStore): string {
  const parts: string[] = [];
  if (store.global) parts.push(`[Story context so far]\n${store.global}`);
  if (store.major.length) parts.push(`[Recent period summaries]\n${store.major.map(e => e.text).join('\n\n')}`);
  if (store.minor.length) parts.push(`[Recent event summaries]\n${store.minor.map(e => e.text).join('\n\n')}`);
  return parts.join('\n\n');
}

export function buildPrompt(
  statusData: StatusData,
  uiMessages: UiMessage[],
  userInput: string,
  summaryStore?: SummaryStore | null,
  options?: { skipProgress?: boolean; playerProfile?: PlayerProfile | null },
) {
  const target = getActiveTarget(statusData);
  const topEvent = Object.entries(statusData.world.recentEvents)[0];
  const targetName = target?.name ?? 'Target';
  const playerProfile = options?.playerProfile;
  const playerProfileText = playerProfile?.name
    ? [
        `Player name: ${playerProfile.name}`,
        playerProfile.personality ? `Player personality: ${playerProfile.personality}` : '',
        playerProfile.appearance ? `Player appearance: ${playerProfile.appearance}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const hasSummary = summaryStore && (summaryStore.global || summaryStore.major.length || summaryStore.minor.length);
  const summaryContext = hasSummary ? buildSummaryContextInline(summaryStore) : '';
  const historyStartIndex = hasSummary ? summaryStore.lastSummarizedIndex : 0;
  const conversationHistory = buildConversationHistory(uiMessages, historyStartIndex);

  const parts = [
    `You are continuing the diary-style chat for ${targetName}.`,
    `Visible reply text must be wrapped in <${PRIMARY_VISIBLE_TAG}>...</${PRIMARY_VISIBLE_TAG}>.`,
    'You may use <context>...</context> for hidden reasoning/context, but keep the visible reply only inside the visible tag.',
    'Avoid markdown tables unless the user explicitly asks for them.',
    'Keep the response focused, natural, and consistent with the current scene.',
    `Current location: ${statusData.world.currentLocation}`,
    `Current relationship stage: ${target?.stage ?? ''}`,
    topEvent ? `Latest event: ${topEvent[0]} - ${topEvent[1]}` : '',
    playerProfileText,
    summaryContext,
    conversationHistory,
    userInput ? `Current user input: ${userInput}` : '',
  ];

  // Only ask main API for <progress> when no secondary API is handling it
  if (!options?.skipProgress) {
    parts.push(buildProgressInstruction(statusData));
  }

  return parts.filter(Boolean).join('\n');
}

// ── Progress instruction & prompt builders ──

function buildProgressInstruction(statusData: StatusData): string {
  const target = getActiveTarget(statusData);
  const inventoryList =
    Object.entries(statusData.player.inventory)
      .map(([name, d]) => `${name}(${d.count})`)
      .join('、') || '无';
  const outfitList = target
    ? Object.entries(target.outfits)
        .map(([k, v]) => `${k}:${v}`)
        .join('；')
    : '';

  return [
    '',
    'After your visible reply, you MUST output a <progress> block to record state changes.',
    'Use key:value format, one per line. Only include fields that changed; omit unchanged fields.',
    'Available fields:',
    '  时间:new_time          — Update if time has advanced (format: YYYY-MM-DD HH:mm)',
    '  地点:new_location      — Update if characters moved to a new location',
    '  好感度:±N              — Affinity change (e.g. 好感度:+3 or 好感度:-5), range 0-100',
    '  着装.部位:描述          — Update outfit for a body part (e.g. 着装.上装:换上了黑色卫衣)',
    '  事件名:event_description — Add/replace a notable recent event (can have multiple)',
    '  物品+物品名:数量:描述    — Item gained (e.g. 物品+匕首:1:从地上捡到的)',
    '  物品-物品名              — Item lost/used',
    '',
    'Example:',
    '<progress>',
    '时间:2012-03-31 08:30',
    '地点:旧城区·便利店',
    '好感度:+2',
    '着装.上装:换上了便利店买的雨衣',
    '深夜外出:两人决定去便利店买夜宵。',
    '物品+塑料袋:1:装着零食的便利店袋子',
    '</progress>',
    '',
    `Current state snapshot:`,
    `  时间: ${statusData.world.currentTime}`,
    `  地点: ${statusData.world.currentLocation}`,
    `  好感度: ${target?.affinity ?? 0} (${target?.stage ?? ''})`,
    `  着装: ${outfitList || '无'}`,
    `  物品: ${inventoryList}`,
  ].join('\n');
}

export function buildProgressPrompt(
  statusData: StatusData,
  recentMessages: UiMessage[],
): Array<{ role: 'system' | 'user'; content: string }> {
  const target = getActiveTarget(statusData);
  const inventoryList =
    Object.entries(statusData.player.inventory)
      .map(([name, d]) => `${name}(${d.count})`)
      .join('、') || '无';
  const outfitList = target
    ? Object.entries(target.outfits)
        .map(([k, v]) => `${k}:${v}`)
        .join('；')
    : '';

  const formatted = recentMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map(m => {
      const text = m.role === 'assistant' ? getVisibleMessageText(m) || m.text : m.text;
      const speaker = m.speaker || (m.role === 'assistant' ? 'Assistant' : 'User');
      return `[${speaker}]\n${text.trim()}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      role: 'system' as const,
      content: [
        '你是一个精确的状态追踪器。根据以下对话内容，分析是否有任何变量需要更新。',
        '',
        '当前状态：',
        `  时间: ${statusData.world.currentTime}`,
        `  地点: ${statusData.world.currentLocation}`,
        `  好感度: ${target?.affinity ?? 0} (${target?.stage ?? ''})`,
        `  着装: ${outfitList || '无'}`,
        `  物品: ${inventoryList}`,
        '',
        '请用 <progress> 标签输出变化的字段，每行一个 key:value。如果没有任何变化，输出空的 <progress></progress>。',
        '可用字段：',
        '  时间:YYYY-MM-DD HH:mm',
        '  地点:新地点',
        '  好感度:±N（增减值，如 +3 或 -5）',
        '  着装.部位:描述',
        '  事件名:事件描述',
        '  物品+名称:数量:描述',
        '  物品-名称',
        '',
        '只输出变化的字段，未变化的省略。',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: `请分析以下对话并输出变量更新：\n\n${formatted}`,
    },
  ];
}

// ── Progress tag parser ──

export type ProgressUpdate = {
  time?: string;
  location?: string;
  affinityDelta?: number;
  outfitChanges: Record<string, string>;
  events: Record<string, string>;
  itemsGained: Array<{ name: string; count: number; description: string }>;
  itemsLost: string[];
};

export function parseProgressUpdate(rawResponse: string): ProgressUpdate | null {
  const tagged = extractTaggedReply(rawResponse, 'progress', false);
  if (!tagged) return null;

  const result: ProgressUpdate = { events: {}, outfitChanges: {}, itemsGained: [], itemsLost: [] };
  let hasAnyField = false;

  for (const line of tagged.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 时间:value
    const timeMatch = trimmed.match(/^时间[:：]\s*(.+)/);
    if (timeMatch) {
      result.time = timeMatch[1].trim();
      hasAnyField = true;
      continue;
    }

    // 地点:value
    const locMatch = trimmed.match(/^地点[:：]\s*(.+)/);
    if (locMatch) {
      result.location = locMatch[1].trim();
      hasAnyField = true;
      continue;
    }

    // 好感度:±N
    const affMatch = trimmed.match(/^好感度[:：]\s*([+\-]?\d+)/);
    if (affMatch) {
      result.affinityDelta = parseInt(affMatch[1], 10) || 0;
      hasAnyField = true;
      continue;
    }

    // 着装.部位:描述
    const outfitMatch = trimmed.match(/^着装[.．]\s*([^:：]+)[:：]\s*(.+)/);
    if (outfitMatch) {
      result.outfitChanges[outfitMatch[1].trim()] = outfitMatch[2].trim();
      hasAnyField = true;
      continue;
    }

    // 物品+name:count:desc
    const gainMatch = trimmed.match(/^物品\+\s*([^:：]+)[:：]\s*(\d+)(?:[:：]\s*(.+))?/);
    if (gainMatch) {
      result.itemsGained.push({
        name: gainMatch[1].trim(),
        count: Math.max(1, parseInt(gainMatch[2], 10) || 1),
        description: gainMatch[3]?.trim() ?? '',
      });
      hasAnyField = true;
      continue;
    }

    // 物品-name
    const loseMatch = trimmed.match(/^物品[-\-]\s*(.+)/);
    if (loseMatch) {
      result.itemsLost.push(loseMatch[1].trim());
      hasAnyField = true;
      continue;
    }

    // Generic event line: eventName:description
    const eventMatch = trimmed.match(/^([^:：]+)[:：]\s*(.+)/);
    if (eventMatch) {
      result.events[eventMatch[1].trim()] = eventMatch[2].trim();
      hasAnyField = true;
    }
  }

  return hasAnyField ? result : null;
}
