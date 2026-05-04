import { getRelationshipGuidance, getRelationshipMiniPersona } from './relationship';
import type { SummaryStore } from './summary/types';
import type { PhoneChatMessage, PlayerProfile, PlayerStats, StatusData, TargetStatus, UiMessage } from './types';
import { getActiveTarget } from './types';

export const PRIMARY_VISIBLE_TAG = 'content';
// 兼容用户自定义预设里要求的中文正文标签，避免模型输出 <正文> 时被当成未知标签吞掉。
export const FALLBACK_VISIBLE_TAGS = ['正文', 'context'];

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
      /<\/?(?:think|content|正文|context|tucao|current_event|progress|roleplay_options)\b[^>]*>/i,
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

export function extractPhoneChatReply(text: string) {
  return extractTaggedReply(String(text ?? ''), 'message', false) || extractContextReply(String(text ?? '')) || '';
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

// 摘要完成后至少保留最近几条原始消息，防止模型丢失近期对话细节。
const SUMMARY_KEEP_RECENT = 6;

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

function buildPhoneChatHistory(messages: PhoneChatMessage[]) {
  const lines = messages
    .slice(-12)
    .filter(message => message.text.trim())
    .map(message => `[${message.speaker}]\n${message.text.trim()}`);

  return lines.length ? ['手机聊天记录：', ...lines].join('\n\n') : '';
}

function buildRecentEventsContext(statusData: StatusData) {
  const lines = Object.entries(statusData.world.recentEvents)
    .slice(0, 3)
    .map(([name, description]) => `- ${name}：${description}`);

  return lines.length ? ['正文近期事件：', ...lines].join('\n') : '';
}

function buildMainEventsContext(statusData: StatusData) {
  const lines = Object.entries(statusData.world.mainEvents ?? {})
    .slice(0, 8)
    .map(([id, status]) => `- ${id}：${status}`);

  return lines.length ? ['主线事件状态：', ...lines].join('\n') : '';
}

function statRank(value: number) {
  const score = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  if (score >= 80) return 'Rank 5 极致';
  if (score >= 60) return 'Rank 4 优秀';
  if (score >= 40) return 'Rank 3 熟练';
  if (score >= 20) return 'Rank 2 可用';
  return 'Rank 1 初学';
}

function normalizeStatKey(raw: string): keyof PlayerStats | null {
  const key = String(raw ?? '').trim().toLowerCase();
  if (/^(知识|知識|knowledge|know)$/.test(key)) return 'knowledge';
  if (/^(魅力|charm)$/.test(key)) return 'charm';
  if (/^(灵巧|靈巧|技巧|手艺|手藝|proficiency|dexterity|craft)$/.test(key)) return 'proficiency';
  if (/^(体贴|體貼|温柔|kindness|care)$/.test(key)) return 'kindness';
  if (/^(勇气|勇氣|courage|guts|bravery)$/.test(key)) return 'courage';
  return null;
}

function buildPlayerStatsText(playerProfile?: PlayerProfile | null) {
  const stats = playerProfile?.stats;
  if (!stats) return '';

  return [
    '玩家P5五维与数值判定系统：',
    `- 知识 knowledge: ${stats.knowledge}（${statRank(stats.knowledge)}）`,
    `- 魅力 charm: ${stats.charm}（${statRank(stats.charm)}）`,
    `- 灵巧 proficiency: ${stats.proficiency}（${statRank(stats.proficiency)}）`,
    `- 体贴 kindness: ${stats.kindness}（${statRank(stats.kindness)}）`,
    `- 勇气 courage: ${stats.courage}（${statRank(stats.courage)}）`,
    '基础阈值：0-19 只能尝试且容易出错；20+ 可处理简单行动；40+ 可处理普通行动；60+ 可处理困难行动；80+ 可处理高压、公开或剧情关键行动。',
    '维度用途：知识用于推理、学业、设定理解、识破矛盾；魅力用于公开圆场、说服、维持体面；灵巧用于绘画/手工/设备操作、隐藏痕迹、转移注意；体贴用于读懂压力、保护隐私、不过界；勇气用于正面承担风险、直球表态、打破僵局。',
    '复合判定：行动涉及多种能力时，优先看最相关的主维度，再用副维度修正结果。例如公开替角色圆谎看魅力，保护秘密看体贴，处理证据看灵巧，正面顶住压力看勇气，识破话中破绽看知识。',
    '结果规则：低于阈值不是强制失败，而是只能部分成功或产生代价，如尴尬、误会、耗时、暴露风险上升、对方警戒。高于阈值 20 点以上可获得额外收益，如更自然、更隐蔽、更少代价或让对方更容易接受。',
    '边界规则：五维只决定行动质量、风险和角色反应，不直接等于好感度；好感度仍由角色是否被理解、尊重、帮助、冒犯或越界来判断。高数值不能强迫角色违背性格，也不能跳过必要剧情铺垫。',
  ].join('\n');
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
  const relationshipGuidance = getRelationshipGuidance(target);
  const playerProfile = options?.playerProfile;
  const playerProfileText = playerProfile?.name
    ? [
        `Player name: ${playerProfile.name}`,
        playerProfile.className ? `Player class: ${playerProfile.className}` : '',
        playerProfile.personality ? `Player personality: ${playerProfile.personality}` : '',
        playerProfile.appearance ? `Player appearance: ${playerProfile.appearance}` : '',
        buildPlayerStatsText(playerProfile),
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const hasSummary = summaryStore && (summaryStore.global || summaryStore.major.length || summaryStore.minor.length);
  const summaryContext = hasSummary ? buildSummaryContextInline(summaryStore) : '';
  const mainEventsContext = buildMainEventsContext(statusData);
  // 取 lastSummarizedIndex 和「总消息数 - 保留窗口」中较小的那个，
  // 保证即使全部消息都已被摘要，最近几条原文仍会出现在 prompt 中。
  const historyStartIndex = hasSummary
    ? Math.min(summaryStore.lastSummarizedIndex, Math.max(0, uiMessages.length - SUMMARY_KEEP_RECENT))
    : 0;
  const conversationHistory = buildConversationHistory(uiMessages, historyStartIndex);

  const parts = [
    `You are continuing the diary-style chat for ${targetName}.`,
    `Visible reply text must be wrapped in <${PRIMARY_VISIBLE_TAG}>...</${PRIMARY_VISIBLE_TAG}>.`,
    'You may use <context>...</context> for hidden reasoning/context, but keep the visible reply only inside the visible tag.',
    'Avoid markdown tables unless the user explicitly asks for them.',
    'Keep the response focused, natural, and consistent with the current scene.',
    `Current location: ${statusData.world.currentLocation}`,
    mainEventsContext,
    `Current relationship stage: ${target?.stage ?? ''}`,
    relationshipGuidance ? `Relationship behavior guidance: ${relationshipGuidance}` : '',
    topEvent ? `Latest event: ${topEvent[0]} - ${topEvent[1]}` : '',
    playerProfileText,
    summaryContext,
    conversationHistory,
    userInput ? `Current user input: ${userInput}` : '',
  ];

  // 只有没有副 API 处理变量时，才要求主 API 输出 <progress>。
  if (!options?.skipProgress) {
    parts.push(buildProgressInstruction(statusData));
  }

  return parts.filter(Boolean).join('\n');
}

export function buildPhoneChatPrompt(input: {
  statusData: StatusData;
  target: TargetStatus;
  history: PhoneChatMessage[];
  userInput: string;
  playerProfile?: PlayerProfile | null;
  skipProgress?: boolean;
  triggerEvent?: string;
}) {
  const { statusData, target, history, userInput, playerProfile, skipProgress = false, triggerEvent } = input;
  const miniPersona = getRelationshipMiniPersona(target);
  const relationshipGuidance = getRelationshipGuidance(target);
  const recentEventsContext = buildRecentEventsContext(statusData);
  const mainEventsContext = buildMainEventsContext(statusData);
  const playerProfileText = playerProfile?.name
    ? [
        `玩家姓名：${playerProfile.name}`,
        playerProfile.className ? `玩家班级：${playerProfile.className}` : '',
        playerProfile.personality ? `玩家性格：${playerProfile.personality}` : '',
        playerProfile.appearance ? `玩家外貌：${playerProfile.appearance}` : '',
        buildPlayerStatsText(playerProfile),
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const parts = [
    `你正在扮演 ${target.name}，通过手机消息和玩家聊天。`,
    `可见回复必须写在 <message>...</message> 中，只输出 ${target.name} 发出的手机消息。`,
    '语气要像即时通讯，不要写旁白、舞台说明或第三人称叙述。',
    '可以短一些，自然一些；除非玩家要求，不要一次发长篇。',
    miniPersona,
    `当前时间：${statusData.world.currentTime}`,
    `当前位置：${statusData.world.currentLocation}`,
    mainEventsContext,
    `当前关系：${target.stage} · 好感度 ${target.affinity}`,
    relationshipGuidance ? `当前关系反应：${relationshipGuidance}` : '',
    playerProfileText,
    recentEventsContext,
    buildPhoneChatHistory(history),
    triggerEvent ? `这条消息的触发事件：${triggerEvent}` : '',
    triggerEvent ? `请基于触发事件主动发一条手机消息：${userInput}` : `玩家刚发来的消息：${userInput}`,
  ];

  if (!skipProgress) {
    parts.push(buildProgressInstruction(statusData, target));
  }

  return parts.filter(Boolean).join('\n');
}

// ── Progress instruction & prompt builders ──

function buildProgressInstruction(statusData: StatusData, target = getActiveTarget(statusData)): string {
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
    'Always evaluate affinity after a long scene. If the active target has a clear emotional reaction to User, output 好感度 even when the change is small.',
    '普通友好互动通常 +1；明显关心、理解、协助、保护通常 +2 到 +4；冒犯、越界、揭短、冷落通常 -1 到 -6。只有完全无互动或关系没有变化时才省略好感度。',
    'Available fields:',
    '  时间:new_time          — Update if time has advanced (format: YYYY-MM-DD HH:mm)',
    '  地点:new_location      — Update if characters moved to a new location',
    '  好感度:±N              — Affinity change (e.g. 好感度:+3 or 好感度:-5), range 0-100',
    '  五维.能力名:±N          — Player P5 stat change (能力名: 知识/魅力/灵巧/体贴/勇气；e.g. 五维.体贴:+1)',
    '  着装.部位:描述          — Update outfit for a body part (e.g. 着装.上装:换上了黑色卫衣)',
    '  主线事件.事件ID:状态     — Update main plot event status (未触发/进行中/已结束/跳过/延后)',
    '  事件名:event_description — Add/replace a notable recent event (can have multiple)',
    '  物品+物品名:数量:描述    — Item gained (e.g. 物品+匕首:1:从地上捡到的)',
    '  物品-物品名              — Item lost/used',
    '',
    'Example:',
    '<progress>',
    '时间:2012-03-31 08:30',
    '地点:东京·侦探坡',
    '好感度:+2',
    '五维.体贴:+1',
    '着装.上装:私立丰之崎学园的制服衬衫',
    '早晨外出:两人决定去便利店买早餐。',
    '物品+塑料袋:1:装着零食的便利店袋子',
    '主线事件.SAE_01-1:已结束',
    '</progress>',
    '',
    `Current state snapshot:`,
    `  时间: ${statusData.world.currentTime}`,
    `  地点: ${statusData.world.currentLocation}`,
    `  主线事件: ${Object.entries(statusData.world.mainEvents ?? {}).map(([id, status]) => `${id}:${status}`).join('；') || '无'}`,
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
        `  主线事件: ${Object.entries(statusData.world.mainEvents ?? {}).map(([id, status]) => `${id}:${status}`).join('；') || '无'}`,
        `  当前攻略对象: ${target?.name ?? '无'}`,
        `  好感度: ${target?.affinity ?? 0} (${target?.stage ?? ''})`,
        `  着装: ${outfitList || '无'}`,
        `  物品: ${inventoryList}`,
        '',
        '好感度判断规则：',
        '  阅读完整正文，不要只看最后一句。只要当前攻略对象对 User 产生明确情绪反应，就评估好感度。',
        '  普通友好互动通常 +1；明显关心、理解、协助、保护通常 +2 到 +4；冒犯、越界、揭短、冷落通常 -1 到 -6。',
        '  不要因为变化很小就省略好感度；只有完全无互动、纯环境描写、或关系没有任何变化时，才不输出好感度。',
        '',
        '请用 <progress> 标签输出变化的字段，每行一个 key:value。如果没有任何变化，输出空的 <progress></progress>。',
        '可用字段：',
        '  时间:YYYY-MM-DD HH:mm',
        '  地点:新地点',
        '  好感度:±N（增减值，如 +3 或 -5）',
        '  五维.能力名:±N（知识/魅力/灵巧/体贴/勇气，例如 五维.勇气:+1）',
        '  着装.部位:描述',
        '  主线事件.事件ID:状态（未触发/进行中/已结束/跳过/延后）',
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

export function buildPhoneProgressPrompt(input: {
  statusData: StatusData;
  target: TargetStatus;
  messages: PhoneChatMessage[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  const { statusData, target, messages } = input;
  const formatted = messages
    .slice(-8)
    .map(message => `[${message.speaker}]\n${message.text.trim()}`)
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      role: 'system' as const,
      content: [
        '你是一个精确的手机聊天状态追踪器。根据手机聊天内容，判断变量是否需要更新。',
        '手机聊天默认只影响好感度、近期事务和必要的时间推进。',
        '只要玩家的消息让聊天对象产生了明确情绪反应，就应评估好感度变化：普通友好互动通常 +0到+1，明显关心/理解/帮忙通常 +2，冒犯、越界、揭短或骚扰通常 -1 到 -6。',
        '不要因为数值很小就省略好感度；只有完全寒暄、无效输入或关系没有任何变化时，才输出空的 <progress></progress>。',
        '只有聊天明确导致现实行动时，才允许更新地点、着装或物品。',
        '',
        '当前状态：',
        `  时间: ${statusData.world.currentTime}`,
        `  地点: ${statusData.world.currentLocation}`,
        `  主线事件: ${Object.entries(statusData.world.mainEvents ?? {}).map(([id, status]) => `${id}:${status}`).join('；') || '无'}`,
        `  聊天对象: ${target.name}`,
        `  好感度: ${target.affinity} (${target.stage})`,
        '',
        '请用 <progress> 标签输出变化字段，每行一个 key:value。没有变化就输出空的 <progress></progress>。',
        '可用字段：',
        '  时间:YYYY-MM-DD HH:mm',
        '  地点:新地点',
        '  好感度:±N',
        '  五维.能力名:±N（知识/魅力/灵巧/体贴/勇气）',
        '  着装.部位:描述',
        '  主线事件.事件ID:状态（未触发/进行中/已结束/跳过/延后）',
        '  事件名:事件描述',
        '  物品+名称:数量:描述',
        '  物品-名称',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: `请分析以下手机聊天并输出变量更新：\n\n${formatted}`,
    },
  ];
}

// ── Progress tag parser ──

export type ProgressUpdate = {
  time?: string;
  location?: string;
  affinityDelta?: number;
  statDeltas: Partial<Record<keyof PlayerStats, number>>;
  outfitChanges: Record<string, string>;
  events: Record<string, string>;
  mainEvents: Record<string, string>;
  itemsGained: Array<{ name: string; count: number; description: string }>;
  itemsLost: string[];
};

export function parseProgressUpdate(rawResponse: string): ProgressUpdate | null {
  const tagged = extractTaggedReply(rawResponse, 'progress', false);
  if (!tagged) return null;

  const result: ProgressUpdate = {
    events: {},
    mainEvents: {},
    statDeltas: {},
    outfitChanges: {},
    itemsGained: [],
    itemsLost: [],
  };
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

    // 五维.体贴:+1 / P5.kindness:+1 / stat.knowledge:+1
    const statMatch = trimmed.match(/^(?:五维|P5|p5|stat|stats)[.．]\s*([^:：]+)[:：]\s*([+\-]?\d+)/);
    if (statMatch) {
      const statKey = normalizeStatKey(statMatch[1]);
      if (statKey) {
        result.statDeltas[statKey] = (result.statDeltas[statKey] ?? 0) + (parseInt(statMatch[2], 10) || 0);
        hasAnyField = true;
      }
      continue;
    }

    // 着装.部位:描述
    const outfitMatch = trimmed.match(/^着装[.．]\s*([^:：]+)[:：]\s*(.+)/);
    if (outfitMatch) {
      result.outfitChanges[outfitMatch[1].trim()] = outfitMatch[2].trim();
      hasAnyField = true;
      continue;
    }

    // 主线事件.SAE_01-1:已结束
    const mainEventMatch = trimmed.match(/^主线事件[.．]\s*([^:：]+)[:：]\s*(.+)/);
    if (mainEventMatch) {
      result.mainEvents[mainEventMatch[1].trim()] = mainEventMatch[2].trim();
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

    // 通用事件行：事件名:描述。
    const eventMatch = trimmed.match(/^([^:：]+)[:：]\s*(.+)/);
    if (eventMatch) {
      result.events[eventMatch[1].trim()] = eventMatch[2].trim();
      hasAnyField = true;
    }
  }

  return hasAnyField ? result : null;
}
