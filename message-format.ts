import { isPlotEventAllowedByRoute, isPlotEventVisibleByRoute } from './plot-routing';
import { buildCharacterDataImportPrompt, stripCharacterDataImportText } from './plugins/character-data-import';
import { buildImageGenerationPrompt, stripImageGenerationTags } from './plugins/image-generation';
import {
  getCharacterAnchorGuidance,
  getRelationshipAddressGuidance,
  getRelationshipAuditGuidance,
  getRelationshipGuidance,
  getRelationshipMiniPersona,
  getTargetCharacterKey,
  hasObsessionAxis,
  hasObsessionAxisByName,
  OBSESSION_TARGET_DISPLAY_NAMES,
} from './relationship';
import type { KeyFact, KeyFactCategory, SummaryStore } from './summary/types';
import { KEY_FACT_CATEGORY_LABEL } from './summary/types';
import type {
  CharacterCardLibrary,
  DrawingSettings,
  PhoneChatMessage,
  PlayerProfile,
  PlayerStats,
  PlotEventCard,
  PlotLibrary,
  ScenePresence,
  StatusData,
  TargetStatus,
  UiMessage,
} from './types';

export const PRIMARY_VISIBLE_TAG = 'content';
// 兼容用户自定义预设里要求的中文正文标签，避免模型输出 <正文> 时被当成未知标签吞掉。
export const FALLBACK_VISIBLE_TAGS = ['正文', 'context'];
const MAIN_EVENT_NOT_STARTED = '未进行';
const MAIN_EVENT_RUNNING = '进行中';
const MAIN_EVENT_FINISHED = '已结束';

/**
 * 清理文本中的占位符，防止 {{user}} / {{char}} 等占位符泄露到 prompt 中。
 * 这些占位符如果来自世界书、旧存档或未替换的模板，会导致 AI 在输出中也使用占位符。
 */
function sanitizePlaceholders(text: string, playerName?: string, charName?: string): string {
  if (!text) return text;
  let result = text;
  // 替换 {{user}} 和 {{User}}
  if (playerName) {
    result = result.replace(/\{\{user\}\}/gi, playerName);
  } else {
    // 如果没有玩家名，至少替换成通用词避免泄露
    result = result.replace(/\{\{user\}\}/gi, '玩家');
  }
  // 替换 {{char}} 和 {{Char}}
  if (charName) {
    result = result.replace(/\{\{char\}\}/gi, charName);
  }
  return result;
}

function stripHtmlCommentBlocks(text: string) {
  if (!text) return text;
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<--![\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/g, '')
    .replace(/<--![\s\S]*$/g, '');
}

/**
 * 清理只应该留在楼层原文/小铅笔里的预设说明。
 * 这里不改 rawText，只在拼 prompt、摘要、状态审计等发给 AI 的文本前调用。
 */
export function sanitizePromptInputText(text: string) {
  if (!text) return '';
  return stripHtmlCommentBlocks(String(text ?? ''))
    .replace(/<Admin\b[^>]*>[\s\S]*?<\/Admin>/gi, '')
    .replace(/<Admin\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/Admin\b[^>]*>/gi, '');
}

// 预设里常见的、会嵌在正文里的元标签。这些不是正文边界，只是吐槽 / 思考 / 指令块。
// 抽正文时需要把它们整体剥掉，否则 <tucao> 包住正文会让可见正文变空。
const META_SUBTAG_NAMES = [
  'tucao',
  'progress',
  'state_delta',
  'current_event',
  'roleplay_options',
  'konatan_planning',
  'konatan_chat',
  'thinking',
  'think',
  'imgthink',
  'options',
  'story_progress',
];

export function isFrontendHtmlShell(text: string) {
  const raw = String(text ?? '')
    .trim()
    .replace(/^\[[^\]\n]{1,48}\]\s*\n/, '')
    .trim();
  if (!raw) return false;
  if (!/^(?:<!doctype\s+html\b|<html\b|<head\b|<meta\b|<script\b)/i.test(raw)) return false;
  return (
    /<div\s+id=(["'])app\1/i.test(raw) ||
    /<title>[^<]*islandmilfcode/i.test(raw) ||
    /islandmilfcode/i.test(raw) ||
    /webpack-internal:\/\/\/\.\/src\/islandmilfcode/i.test(raw)
  );
}

function stripMetaSubtags(text: string) {
  if (!text) return text;
  let result = text;
  for (const tag of META_SUBTAG_NAMES) {
    // 先剥闭合的 <tag>...</tag>，再清理孤立的开/闭标签（AI 截断时常见）。
    const closed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\b[^>]*>`, 'gi');
    result = result.replace(closed, '');
    const orphan = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    result = result.replace(orphan, '');
  }
  return result;
}

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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasClosingTagAfter(text: string, tagName: string, index: number) {
  return new RegExp(`<\\/${escapeRegExp(tagName)}\\b[^>]*>`, 'i').test(text.slice(index));
}

function findNextSectionBoundary(text: string) {
  const sectionNames = [PRIMARY_VISIBLE_TAG, ...FALLBACK_VISIBLE_TAGS].map(escapeRegExp).join('|');
  const sectionTag = new RegExp(`<\\/?(${sectionNames})\\b[^>]*>`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = sectionTag.exec(text))) {
    const tagText = match[0];
    const tagName = match[1] ?? '';

    if (tagText.startsWith('</')) {
      return match.index;
    }

    // 孤立的 <content> 常会出现在截断正文里；只有后面还能闭合时才把它当成下一段正文。
    if (hasClosingTagAfter(text, tagName, sectionTag.lastIndex)) {
      return match.index;
    }
  }

  return -1;
}

function findClosedTaggedBody(raw: string, tagName: string) {
  const tag = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = tag.exec(raw))) {
    if (match[0].startsWith('</')) continue;

    const bodyStart = tag.lastIndex;
    const next = tag.exec(raw);
    if (!next) return null;

    if (next[0].startsWith('</')) {
      return raw.slice(bodyStart, next.index);
    }

    tag.lastIndex = next.index;
  }

  return null;
}

function findAllClosedTaggedBodies(raw: string, tagName: string) {
  const bodies: Array<{ body: string; start: number; end: number }> = [];
  const tag = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = tag.exec(raw))) {
    if (match[0].startsWith('</')) continue;

    const bodyStart = tag.lastIndex;
    const next = tag.exec(raw);
    if (!next) break;

    if (next[0].startsWith('</')) {
      bodies.push({
        body: raw.slice(bodyStart, next.index),
        start: match.index,
        end: tag.lastIndex,
      });
      continue;
    }

    tag.lastIndex = next.index;
  }

  return bodies;
}

export function extractTaggedReply(raw: string, tagName: string, streaming: boolean) {
  const closedBody = findClosedTaggedBody(raw, tagName);
  if (closedBody != null) {
    return dedupeAdjacentReply(stripMetaSubtags(closedBody));
  }

  if (streaming) {
    const openedTag = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*)$`, 'i');
    const openedMatch = raw.match(openedTag);
    if (openedMatch) {
      return dedupeAdjacentReply(stripMetaSubtags((openedMatch[1] ?? '').replace(/<[^>]*$/, '')));
    }
  }

  const openTag = new RegExp(`<${tagName}\\b[^>]*>`, 'i');
  const openMatch = raw.match(openTag);
  if (openMatch?.index != null) {
    const afterOpen = raw.slice(openMatch.index + openMatch[0].length);
    // tucao / progress 等是正文内部的元标签，不能当成章节边界截断正文。
    const nextSectionIndex = findNextSectionBoundary(afterOpen);
    const visible = nextSectionIndex >= 0 ? afterOpen.slice(0, nextSectionIndex) : afterOpen;
    return dedupeAdjacentReply(stripMetaSubtags(visible));
  }

  return '';
}

export function extractTucaoBlocks(text: string, { streaming = false }: { streaming?: boolean } = {}) {
  const raw = String(text ?? '');
  if (!raw) return [];

  const blocks: string[] = [];
  const closedTag = /<tucao\b[^>]*>([\s\S]*?)<\/tucao>/gi;
  let match: RegExpExecArray | null;

  while ((match = closedTag.exec(raw))) {
    const body = sanitizeVisibleReply((match[1] ?? '').trim());
    if (body) blocks.push(body);
  }

  if (streaming) {
    const opens = Array.from(raw.matchAll(/<tucao\b[^>]*>/gi));
    const closes = Array.from(raw.matchAll(/<\/tucao>/gi));
    const lastOpen = opens[opens.length - 1];
    const lastClose = closes[closes.length - 1];

    if (lastOpen?.index != null && (!lastClose?.index || lastOpen.index > lastClose.index)) {
      const start = lastOpen.index + lastOpen[0].length;
      const body = sanitizeVisibleReply(
        raw
          .slice(start)
          .replace(/<[^>]*$/, '')
          .trim(),
      );
      if (body && blocks[blocks.length - 1] !== body) blocks.push(body);
    }
  }

  return blocks;
}

export function extractOptionsBlock(text: string, { streaming = false }: { streaming?: boolean } = {}) {
  const raw = String(text ?? '');
  if (!raw) return [];

  const options: string[] = [];
  const closedTag = /<options\b[^>]*>([\s\S]*?)<\/options>/gi;
  const match = closedTag.exec(raw);

  if (match) {
    const content = (match[1] ?? '').trim();
    // 解析每个选项，格式：>选项一：[内容]
    const lines = content
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const optionMatch = line.match(/^>(?:选项[一二三四]：)?\s*\[?(.+?)\]?$/);
      if (optionMatch) {
        options.push(optionMatch[1].trim());
      }
    }
  }

  // 流式模式下处理未闭合的标签
  if (streaming && options.length === 0) {
    const opens = Array.from(raw.matchAll(/<options\b[^>]*>/gi));
    const closes = Array.from(raw.matchAll(/<\/options>/gi));
    const lastOpen = opens[opens.length - 1];
    const lastClose = closes[closes.length - 1];

    if (lastOpen?.index != null && (!lastClose?.index || lastOpen.index > lastClose.index)) {
      const start = lastOpen.index + lastOpen[0].length;
      const content = raw
        .slice(start)
        .replace(/<[^>]*$/, '')
        .trim();
      const lines = content
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        const optionMatch = line.match(/^>(?:选项[一二三四]：)?\s*\[?(.+?)\]?$/);
        if (optionMatch) {
          options.push(optionMatch[1].trim());
        }
      }
    }
  }

  return options;
}

export function extractContextReply(text: string, { streaming = false }: { streaming?: boolean } = {}) {
  const raw = stripHtmlCommentBlocks(stripImageGenerationTags(stripCharacterDataImportText(String(text ?? ''))));
  return extractContextReplyFromPreparedRaw(raw, { streaming });
}

export function extractContextReplyWithImageGenerationTags(
  text: string,
  { streaming = false }: { streaming?: boolean } = {},
) {
  const raw = stripHtmlCommentBlocks(stripCharacterDataImportText(String(text ?? '')));
  const closedBodies = findAllClosedTaggedBodies(raw, PRIMARY_VISIBLE_TAG);
  if (closedBodies.length > 1) {
    let result = '';
    let cursor = 0;
    for (const item of closedBodies) {
      result += raw.slice(cursor, item.start).replace(new RegExp(`<\\/?${PRIMARY_VISIBLE_TAG}\\b[^>]*>`, 'gi'), '');
      result += item.body;
      cursor = item.end;
    }
    result += raw.slice(cursor).replace(new RegExp(`<\\/?${PRIMARY_VISIBLE_TAG}\\b[^>]*>`, 'gi'), '');
    return dedupeAdjacentReply(stripMetaSubtags(result));
  }
  return extractContextReplyFromPreparedRaw(raw, { streaming });
}

function extractContextReplyFromPreparedRaw(raw: string, { streaming = false }: { streaming?: boolean } = {}) {
  if (!raw) {
    return '';
  }
  if (isFrontendHtmlShell(raw)) {
    return '';
  }

  for (const tagName of [PRIMARY_VISIBLE_TAG, ...FALLBACK_VISIBLE_TAGS]) {
    const tagged = extractTaggedReply(raw, tagName, streaming);
    if (tagged) {
      return tagged;
    }
  }

  // 标签完全丢失时的兜底：先剥掉元标签（tucao / progress / 思考块等），
  // 再看看剩下的是不是可展示的纯文本。之前直接因为残留标签返回空会吞整层。
  const stripped = stripMetaSubtags(raw);
  const strippedWithoutCodeBlocks = stripped.replace(/```[\s\S]*?```/g, '');
  if (/<\/?[a-zA-Z][^>]*>/i.test(strippedWithoutCodeBlocks)) {
    return '';
  }

  return dedupeAdjacentReply(stripped);
}

export function extractPhoneChatReply(text: string) {
  return extractTaggedReply(String(text ?? ''), 'message', false) || extractContextReply(String(text ?? '')) || '';
}

export function getVisibleMessageText(message: UiMessage) {
  if (message.role !== 'assistant') {
    return message.text;
  }

  return extractContextReply(message.rawText || message.text) || '';
}

export function getPromptMessageText(message: UiMessage) {
  if (message.role !== 'assistant') {
    return sanitizePromptInputText(message.text);
  }

  const visible = getVisibleMessageText(message);
  if (visible) return sanitizePromptInputText(visible);

  const raw = String(message.rawText || message.text || '');
  if (isFrontendHtmlShell(raw)) return '';

  return sanitizePromptInputText(String(message.text || ''));
}

// ── Reader message cache for performance ──

let cachedReaderMessages: UiMessage[] = [];
let cachedSourceMessages: UiMessage[] | null = null;
let cachedSourceLength = 0;

export function getReaderMessages(messages: UiMessage[], forceRebuild = false) {
  // 如果消息数组本身没变化，返回缓存。不能只看 length：
  // 存档恢复/分区重建可能换了一整组同长度消息，旧缓存会让 readerIndex 指到旧楼层。
  if (
    !forceRebuild &&
    messages === cachedSourceMessages &&
    messages.length === cachedSourceLength &&
    messages.length > 0
  ) {
    return cachedReaderMessages;
  }

  // 如果同一个数组只是新增消息（最常见场景：记录新对话），增量添加
  if (
    !forceRebuild &&
    messages === cachedSourceMessages &&
    messages.length > cachedSourceLength &&
    cachedSourceLength > 0
  ) {
    const newMessages = messages.slice(cachedSourceLength);
    const filtered = newMessages.filter(message => {
      if (message.role === 'system') return false;
      if (message.role === 'user') return Boolean(message.text.trim());
      if (isFrontendHtmlShell(message.rawText || message.text)) return false;
      // assistant: 流式中或有任何原文都保留，让掉标签的楼层也能被翻到并走编辑入口恢复。
      return message.streaming || Boolean(message.text.trim());
    });
    cachedReaderMessages.push(...filtered);
    cachedSourceMessages = messages;
    cachedSourceLength = messages.length;
    return cachedReaderMessages;
  }

  // 删除/编辑消息时或首次加载时，完全重建
  cachedReaderMessages = messages.filter(message => {
    if (message.role === 'system') return false;
    if (message.role === 'user') return Boolean(message.text.trim());
    if (isFrontendHtmlShell(message.rawText || message.text)) return false;
    // assistant: 流式中或有任何原文都保留，让掉标签的楼层也能被翻到并走编辑入口恢复。
    return message.streaming || Boolean(message.text.trim());
  });
  cachedSourceMessages = messages;
  cachedSourceLength = messages.length;
  return cachedReaderMessages;
}

/**
 * 清空 reader 消息缓存，在删除/编辑消息后调用。
 */
export function invalidateReaderMessagesCache() {
  cachedReaderMessages = [];
  cachedSourceMessages = null;
  cachedSourceLength = 0;
}

// 摘要完成后至少保留最近几条原始消息，防止模型丢失近期对话细节。
const SUMMARY_KEEP_RECENT = 6;

function buildConversationHistory(uiMessages: UiMessage[], startIndex = 0) {
  const historyLines = uiMessages
    .slice(startIndex)
    // 中文注释：主 API 的历史窗口只保留已经生成的正文。历史 user 输入不是当前指令，
    // 且有效行动应已被上一轮 assistant 正文吸收；继续注入会污染当前楼层判断。
    .filter(message => !message.streaming && message.role === 'assistant')
    .map(message => {
      const visibleText = getPromptMessageText(message).trim();
      if (!visibleText) return '';
      const speaker = (message.speaker || (message.role === 'assistant' ? 'Assistant' : 'User')).trim();
      return `[${message.role}:${speaker}]\n${visibleText}`;
    })
    .filter(Boolean);

  if (!historyLines.length) {
    return '';
  }

  return ['历史正文记录（仅供场景连续性参考；不包含历史玩家输入，当前玩家输入见下方独立字段）：', ...historyLines].join(
    '\n\n',
  );
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
    .filter(([name, description]) => name !== '初始记录' && String(description ?? '').trim())
    .slice(0, 3)
    .map(([name, description]) => `- ${name}：${description}`);

  return lines.length ? ['正文近期事件：', ...lines].join('\n') : '';
}

function buildMainEventsContext(statusData: StatusData) {
  const currentId = statusData.world.currentMainEventId;
  // 中文注释：提示词只列正在进行的主线，避免未进行事件把上下文刷屏。
  const lines = Object.entries(statusData.world.mainEvents ?? {})
    .filter(([, status]) => normalizeMainEventStatus(status) === MAIN_EVENT_RUNNING)
    .slice(0, 8)
    .map(([id, status]) => `- ${id}：${status}`);

  return [
    currentId
      ? `当前主线事件：${currentId}（${statusData.world.mainEvents?.[currentId] ?? '状态未知'}）`
      : '当前主线事件：无',
    ...(lines.length ? ['主线事件状态：', ...lines] : []),
  ].join('\n');
}

function normalizeMainEventStatus(status: string | undefined): string {
  const value = String(status ?? '').trim();
  if (value === MAIN_EVENT_RUNNING) return MAIN_EVENT_RUNNING;
  if (value === MAIN_EVENT_FINISHED || value === '跳过' || value === '延后' || value === '已完成') {
    return MAIN_EVENT_FINISHED;
  }
  return MAIN_EVENT_NOT_STARTED;
}

function buildPlotEventReference(event: PlotEventCard | undefined, label: string) {
  if (!event) return '';
  return `- ${label}: ${event.id} ${event.title}${event.summary ? `：${event.summary}` : ''}`;
}

function getDatePart(value: string) {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

function diffDays(fromIso: string, toIso: string): number | null {
  const a = new Date(`${fromIso}T00:00:00`);
  const b = new Date(`${toIso}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function formatScheduleDateRange(schedule: PlotEventCard['schedule']) {
  if (!schedule?.date) return '';
  const endDate = schedule.endDate && schedule.endDate > schedule.date ? `~${schedule.endDate}` : '';
  return `${schedule.date}${endDate}`;
}

function formatEventIndexLine(event: PlotEventCard) {
  const parts = [`- ${event.id}`];
  const scheduleDate = formatScheduleDateRange(event.schedule);
  if (scheduleDate) parts.push(scheduleDate);
  if (event.schedule?.timeSegments?.length) parts.push(event.schedule.timeSegments.join('/'));
  if (event.schedule?.locations?.length) parts.push(event.schedule.locations.join('、'));
  if (event.title) parts.push(event.title);
  return parts.join(' · ');
}

function buildPlotWhitelist(plotLibrary: PlotLibrary, statusData?: StatusData) {
  const mainEvents = statusData?.world.mainEvents ?? {};
  const currentId = statusData?.world.currentMainEventId ?? '';
  const currentDate = getDatePart(statusData?.world.currentTime ?? '');
  const all = Object.values(plotLibrary.events).filter(event => {
    if (!statusData) return true;
    if (event.id === currentId) return true;
    if (!isPlotEventVisibleByRoute(event.id, statusData)) return false;

    const status = normalizeMainEventStatus(mainEvents[event.id]);
    if (status === MAIN_EVENT_FINISHED) return false;

    const eventEndDate = event.schedule?.endDate ?? event.schedule?.date ?? '';
    if (currentDate && eventEndDate && eventEndDate < currentDate && status !== MAIN_EVENT_RUNNING) {
      return false;
    }

    return true;
  });
  if (!all.length) return '';
  const lines = all
    .slice()
    .sort((a, b) => {
      const da = a.schedule?.date ?? '';
      const db = b.schedule?.date ?? '';
      return da.localeCompare(db) || a.id.localeCompare(b.id);
    })
    .map(formatEventIndexLine);
  return [
    '合法主线事件 ID 白名单（仅限下列未结束/可接续 ID 可出现在 <progress> 的 当前事件 / 主线事件 字段里）：',
    ...lines,
    '硬约束：已结束事件不要再写入 <progress> 的 当前事件 / 主线事件 字段；禁止使用白名单之外的任何事件 ID；禁止自造新的卷号/新的事件编号；不确定时把 当前事件 留空，不要发明 ID。',
  ].join('\n');
}

function pickNextUpcomingEvent(statusData: StatusData, plotLibrary: PlotLibrary): PlotEventCard | null {
  const mainEvents = statusData.world.mainEvents ?? {};
  const currentDate = getDatePart(statusData.world.currentTime);
  const candidates = Object.values(plotLibrary.events)
    .filter(event => Boolean(event.schedule?.date))
    .filter(event => isPlotEventAllowedByRoute(event.id, statusData))
    .filter(event => normalizeMainEventStatus(mainEvents[event.id]) === MAIN_EVENT_NOT_STARTED)
    .filter(event => !currentDate || (event.schedule!.endDate ?? event.schedule!.date) >= currentDate)
    .sort((a, b) => a.schedule!.date.localeCompare(b.schedule!.date) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

// 把事件卡 JSON 压缩成给 AI 写正文用的精简版本。
// 砍掉:触发控制 / 结束控制 / 触发变量 / 关键情节的 id 数组 — 这些是事件系统的元数据,AI 不需要。
// 保留:标题 / 阶段摘要 / 阶段背景 / 关键人物 / 场景修饰(前2) / 人物状态(认知+心态+对白气质) / User介入参考(前4) / 关系变量引导(前4) / 叙事重点(前3)。
function compressPlotCardContent(rawContent: string): string {
  if (!rawContent) return '';
  let parsed: Record<string, unknown> | null = null;
  try {
    const obj = JSON.parse(rawContent);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj as Record<string, unknown>;
  } catch {
    // 不是 JSON,原样返回(可能是手写的纯文本剧情卡)
    return rawContent;
  }
  if (!parsed) return rawContent;

  const lines: string[] = [];
  const pushIf = (label: string, value: unknown, max?: number) => {
    if (!value) return;
    if (Array.isArray(value)) {
      const items = value
        .map(v => String(v ?? '').trim())
        .filter(Boolean)
        .slice(0, max ?? 9999);
      if (items.length) lines.push(`${label}:`, ...items.map(s => `  - ${s}`));
    } else if (typeof value === 'string' && value.trim()) {
      lines.push(`${label}: ${value.trim()}`);
    }
  };

  pushIf('阶段摘要', parsed['阶段摘要'] ?? parsed['summary']);
  pushIf('阶段背景', parsed['阶段背景'], 3);
  pushIf('关键人物', parsed['关键人物']);
  pushIf('关键地点', parsed['关键地点']);
  pushIf('场景修饰', parsed['场景修饰'], 3);

  // 人物状态:每个人保留 认知(前2) + 心态 + 对白气质
  const charState = parsed['人物状态'];
  if (charState && typeof charState === 'object' && !Array.isArray(charState)) {
    lines.push('人物状态:');
    for (const [name, raw] of Object.entries(charState as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const detail = raw as Record<string, unknown>;
      lines.push(`  ${name}:`);
      const cog = detail['认知'];
      if (Array.isArray(cog) && cog.length) {
        const top = cog
          .slice(0, 2)
          .map(c => String(c ?? '').trim())
          .filter(Boolean);
        if (top.length) lines.push(`    认知: ${top.join('; ')}`);
      }
      if (detail['心态']) lines.push(`    心态: ${String(detail['心态']).trim()}`);
      if (detail['对白气质']) lines.push(`    对白气质: ${String(detail['对白气质']).trim()}`);
    }
  }

  pushIf('关系变量引导', parsed['关系变量引导'], 4);
  pushIf('User介入参考', parsed['User介入参考'], 4);

  // 关键情节:只取描述,不传 id 数组
  const plot = parsed['关键情节'];
  if (Array.isArray(plot) && plot.length) {
    const descs = plot
      .map(p => (p && typeof p === 'object' ? String((p as Record<string, unknown>)['描述'] ?? '').trim() : ''))
      .filter(Boolean);
    if (descs.length) {
      lines.push('关键情节流向:');
      for (const d of descs) lines.push(`  - ${d}`);
    }
  }

  pushIf('叙事重点', parsed['叙事重点'], 3);

  return lines.join('\n');
}

// 把卷级写作协议压缩成 prompt 友好的几行。每类只取前 2 条,避免重复堆叠。
function buildVolumeWritingProtocol(plotLibrary: PlotLibrary | null | undefined, volumeId: string | undefined): string {
  if (!plotLibrary?.writingProtocols || !volumeId) return '';
  const proto = plotLibrary.writingProtocols[volumeId];
  if (!proto) return '';
  const sections: string[] = [];
  const pickTop = (label: string, items?: string[]) => {
    if (!items?.length) return;
    const top = items.slice(0, 3);
    sections.push(`${label}: ${top.join(' / ')}`);
  };
  pickTop('作品调性', proto.作品调性);
  pickTop('叙事风格', proto.叙事风格);
  pickTop('对白原则', proto.对白原则);
  pickTop('场景原则', proto.场景原则);
  if (!sections.length) return '';
  return ['本卷写作协议(优先级高于通用文风指令):', ...sections.map(s => `- ${s}`)].join('\n');
}

function buildCurrentPlotContext(statusData: StatusData, plotLibrary?: PlotLibrary | null) {
  if (!plotLibrary || !Object.keys(plotLibrary.events).length) return '';
  const whitelist = buildPlotWhitelist(plotLibrary, statusData);
  const currentId = statusData.world.currentMainEventId;
  const currentEvent = currentId ? plotLibrary.events[currentId] : undefined;

  // 空档期：当前没有进行中主线。直接告诉 AI 下一个主线在哪天哪里，空档期不要触发新主线、不要自造 ID。
  if (!currentEvent) {
    const upcoming = pickNextUpcomingEvent(statusData, plotLibrary);
    const currentDate = getDatePart(statusData.world.currentTime);
    const gapLines: string[] = ['当前没有进行中的主线事件：处于剧情空档期。'];

    if (upcoming?.schedule?.date) {
      const daysUntil = currentDate ? diffDays(currentDate, upcoming.schedule.date) : null;
      const scheduleDate = formatScheduleDateRange(upcoming.schedule);
      gapLines.push(
        `下一个主线事件：${upcoming.id} ${upcoming.title}`,
        `触发日期：${scheduleDate}${daysUntil != null ? `（距离当前日期约 ${daysUntil} 天）` : ''}`,
        upcoming.schedule.timeSegments?.length
          ? `建议时间片段：${upcoming.schedule.timeSegments.join('/')}（仅供叙事参考）`
          : '',
        upcoming.schedule.locations?.length
          ? `建议地点：${upcoming.schedule.locations.join('、')}（仅供叙事参考）`
          : '',
        upcoming.summary ? `阶段摘要：${upcoming.summary}` : '',
      );
    } else {
      gapLines.push('下一个主线事件：暂无规划。');
    }

    gapLines.push(
      '空档期叙事规则：',
      '- 只写日常、校园、社团、手机等非主线情节；不要演出任何未来主线的关键节点。',
      '- 事件触发只看日期：当前日期等于触发日期当天即可在 <progress> 中把该事件标记为 进行中；时间片段和地点只是建议场景，不是硬性触发条件。',
      '- 不得在 <progress> 中把未到触发日期的事件标记为 进行中，也不得设为 当前事件。',
      '- 不得自造新的事件 ID、卷号或编号；白名单之外的 ID 都会被系统丢弃。',
      '- 如果 User 的行动看起来要跳过下一个主线，用 <progress> 把该事件标记为 跳过 或 延后，而不是捏造新主线。',
      '',
      whitelist,
    );

    return gapLines.filter(Boolean).join('\n');
  }

  const previous = currentEvent.previousIds
    .map((id, index) => buildPlotEventReference(plotLibrary.events[id], index === 0 ? '前置事件' : '其他前置'))
    .filter(Boolean);
  const next = currentEvent.nextIds
    .map((id, index) => buildPlotEventReference(plotLibrary.events[id], index === 0 ? '后续路标' : '其他后续'))
    .filter(Boolean);

  return [
    '当前主线剧情卡：',
    `事件ID: ${currentEvent.id}`,
    `标题: ${currentEvent.title}`,
    currentEvent.volumeId ? `卷ID: ${currentEvent.volumeId}` : '',
    currentEvent.summary ? `阶段摘要: ${currentEvent.summary}` : '',
    previous.length ? previous.join('\n') : '',
    next.length ? next.join('\n') : '',
    '',
    buildVolumeWritingProtocol(plotLibrary, currentEvent.volumeId),
    '',
    '剧情卡内容：',
    compressPlotCardContent(currentEvent.content),
    '',
    '使用规则：只把当前剧情卡作为本轮场景参考；前置和后续只用于衔接判断，不要提前演出后续事件。若 User 行动使当前事件无法自然继续，请在 <state_delta> 中把当前事件标记为 跳过 或 延后，并给出可接回的近期事件记录。',
    '',
    whitelist,
  ]
    .filter(Boolean)
    .join('\n');
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
  const key = String(raw ?? '')
    .trim()
    .toLowerCase();
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
  ].join('\n');
}

function buildTargetStateList(statusData: StatusData) {
  if (!statusData.targets.length) return '无';
  return statusData.targets
    .map(target => {
      const aliases = [target.alias, target.meta?.worldbookEntryName]
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
        .join('、');
      const className = String(target.meta?.className ?? '').trim();
      const classSegment = className ? `；班级/身份=${className}` : '';
      const obsessionSegment = hasObsessionAxis(target)
        ? `；执念度（旧情/对伦也）=${target.obsession}（${target.obsessionStage}）`
        : '';
      const updateKeys = hasObsessionAxis(target)
        ? `好感度.${target.name}:±N / 执念度.${target.name}:±N`
        : `好感度.${target.name}:±N`;
      // 亲密档案摘要：默认使用贞操闩锁；小百合是既婚人妻专例，不显示/补写“完璧”语义。
      const adultMarriedIntimacy = target.meta?.intimacyStatusMode === 'adult-married';
      const virginity = target.meta?.virginity === 'lost' ? '已失去' : '完璧';
      const rawCounters = target.meta?.bodyCounters as Record<string, number> | undefined;
      const counterEntries = rawCounters
        ? Object.entries(rawCounters)
            .filter(([, v]) => Number(v) > 0)
            .map(([k, v]) => `${k}${v}`)
            .join('/')
        : '';
      const sexSegment = adultMarriedIntimacy
        ? `；亲密轴=${counterEntries ? '小百合背德关系已成立（已发生关系）' : '小百合既婚边界（尚未越界）'}（不使用贞操/完璧闩锁，不输出贞操字段）${counterEntries ? `；计数=${counterEntries}` : ''}`
        : `；贞操=${virginity}${counterEntries ? `；计数=${counterEntries}` : ''}`;
      return `- id=${target.id}；姓名=${target.name}${aliases ? `；别名/线索=${aliases}` : ''}${classSegment}；好感度（对 user）=${target.affinity}（${target.stage}）${obsessionSegment}${sexSegment}；更新键=${updateKeys}`;
    })
    .join('\n');
}

function buildAffinityUpdateExamples(statusData: StatusData) {
  const examples = statusData.targets
    .map(target => target.name || target.id)
    .filter(Boolean)
    .slice(0, 3)
    .map((name, index) => `好感度.${name}:${index === 1 ? '+2' : '+1'}`);
  return examples.length ? examples.join(' / ') : '好感度.角色名:+1';
}

function buildObsessionUpdateExamples(statusData: StatusData) {
  const examples = statusData.targets
    .filter(target => hasObsessionAxis(target))
    .map(target => target.name || target.id)
    .filter(Boolean)
    .slice(0, 3)
    .map((name, index) => `执念度.${name}:${index === 1 ? '+1' : '-1'}`);
  return examples.length ? examples.join(' / ') : '执念度.英梨梨:-1';
}

function normalizeForMentionMatch(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function getTargetMentionTerms(target: TargetStatus) {
  return [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .flatMap(value => String(value ?? '').split(/[、,，/／\s]+/))
    .map(value => value.trim())
    .filter(value => value.length >= 2);
}

function isTargetMentioned(target: TargetStatus, text: string) {
  const normalized = normalizeForMentionMatch(text);
  if (!normalized) return false;
  return getTargetMentionTerms(target).some(term => normalized.includes(term.toLowerCase()));
}

function getSceneGuidanceTargetIds(scenePresence?: ScenePresence | null) {
  if (!scenePresence) return null;
  // 中文注释：完整关系指导只给“镜头内可即时反应”的角色，以及玩家当前动作正在追向/寻找的转场目标。
  return new Set([...(scenePresence.presentIds ?? []), ...(scenePresence.focusIds ?? [])].filter(Boolean));
}

function buildScenePresenceContext(statusData: StatusData, scenePresence?: ScenePresence | null) {
  if (!scenePresence) return '';
  const targetById = new Map(statusData.targets.map(target => [target.id, target]));
  const nameList = (ids: string[]) =>
    ids
      .map(id => targetById.get(id)?.name ?? id)
      .filter(Boolean)
      .join('、') || '无';
  const guidedIds = new Set([...(scenePresence.presentIds ?? []), ...(scenePresence.focusIds ?? [])]);
  const unguidedNames =
    statusData.targets
      .filter(target => !guidedIds.has(target.id))
      .map(target => target.name)
      .join('、') || '无';

  const evidenceLines = Object.entries(scenePresence.evidence ?? {})
    .map(([id, reason]) => {
      const name = targetById.get(id)?.name ?? id;
      const text = String(reason ?? '').trim();
      return text ? `- ${name}: ${text}` : '';
    })
    .filter(Boolean);

  return [
    '[镜头判定]',
    '判定来源：生成正文前的独立在场人物判定；第一次输入没有历史正文时，只看玩家当前输入。',
    `明确在场：${nameList(scenePresence.presentIds ?? [])}`,
    `转场目标：${nameList(scenePresence.focusIds ?? [])}`,
    `明确不在场：${nameList(scenePresence.absentIds ?? [])}`,
    `不确定/仅被提及：${nameList(scenePresence.uncertainIds ?? [])}`,
    `本轮不注入完整关系指导：${unguidedNames}`,
    evidenceLines.length ? ['判定依据：', ...evidenceLines].join('\n') : '',
    '镜头规则：只有明确在场和转场目标可以应用完整关系指导、局部审计、即时台词/动作/心理反应；明确不在场或不确定角色不得默认插话、旁听、吃醋或产生即时反应。',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRelationshipGuidanceList(
  statusData: StatusData,
  playerProfile?: PlayerProfile | null,
  scenePresence?: ScenePresence | null,
) {
  const allowedIds = getSceneGuidanceTargetIds(scenePresence);
  const lines = statusData.targets
    .filter(target => !allowedIds || allowedIds.has(target.id))
    .map(target => {
      const guidance = getRelationshipGuidance(target);
      const address = getRelationshipAddressGuidance({ target, playerProfile });
      const anchor = getCharacterAnchorGuidance({ target, playerProfile });
      if (!guidance && !address && !anchor) return '';
      return [
        `[${target.name}]`,
        anchor ? `身份锚点：${anchor}` : '',
        guidance ? `关系反应：${guidance}` : '',
        address ? `称呼：${address}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n\n') : '';
}

function buildLocalCharacterAuditList(
  statusData: StatusData,
  contextText: string,
  scenePresence?: ScenePresence | null,
) {
  const allowedIds = getSceneGuidanceTargetIds(scenePresence);
  const lines = statusData.targets
    // 中文注释：有镜头判定时，局部审计只跟随判定结果；没有判定时保留旧的文本命中兜底。
    .filter(target => (allowedIds ? allowedIds.has(target.id) : isTargetMentioned(target, contextText)))
    .map(target => {
      const audit = getRelationshipAuditGuidance(target);
      if (!audit) return '';
      return [
        `[${target.name}]`,
        '仅当本轮场景实际描写该角色的台词、动作、沉默或即时反应时应用；不得改变当前场景焦点，不得影响其他角色。',
        audit,
      ].join('\n');
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n\n') : '';
}

// 按 scenePresence 把世界书 0 层角色卡的原文注入 prompt。
// 调用前提：用户已经把对应世界书条目 disable，关掉 SillyTavern 自身的关键词触发，
// 角色卡内容只能由 TS 这一侧根据 present + focus 主动加载，避免每轮 5 张卡常驻。
// 没有 scenePresence 或 allowedIds 为空时返回空字符串：宁可少一张卡，也不要再回到"全员常驻"。
function buildActiveCharacterCards(
  statusData: StatusData,
  scenePresence: ScenePresence | null | undefined,
  characterCardLibrary: CharacterCardLibrary | null | undefined,
  options: { targetIds?: string[] } = {},
) {
  if (!characterCardLibrary || !Object.keys(characterCardLibrary.cards).length) return '';

  // targetIds 优先级最高：手机聊天等单对象场景直接指定要注入的角色，绕过 scenePresence 判定。
  const explicit = (options.targetIds ?? []).filter(Boolean);
  const allowedIds: Set<string> | null = explicit.length ? new Set(explicit) : getSceneGuidanceTargetIds(scenePresence);
  if (!allowedIds || !allowedIds.size) return '';

  const blocks: string[] = [];
  const seenKeys = new Set<string>();
  for (const target of statusData.targets) {
    if (!allowedIds.has(target.id)) continue;
    const key = getTargetCharacterKey(target);
    if (!key) continue;
    if (seenKeys.has(key)) continue;
    const card = characterCardLibrary.cards[key];
    if (!card) continue;
    seenKeys.add(key);
    // 中文注释：原文整段注入，不做压缩；条目头加一个清晰的边界，避免世界书原文里没有标题时和上下文糊在一起。
    blocks.push(`[角色 0 层卡 · ${card.name}]\n${card.content}`);
  }

  if (!blocks.length) return '';
  return [
    '【在场角色 0 层卡】下列条目仅本轮镜头内角色的完整档案；未列出的角色不要直接复刻其原作行为模板。',
    ...blocks,
  ].join('\n\n');
}

function buildPinnedKeyFactsInline(facts: KeyFact[] | undefined): string {
  if (!facts || !facts.length) return '';
  const active = facts.filter(f => !f.superseded);
  if (!active.length) return '';
  const grouped = new Map<KeyFactCategory, KeyFact[]>();
  for (const fact of active) {
    if (!grouped.has(fact.category)) grouped.set(fact.category, []);
    grouped.get(fact.category)!.push(fact);
  }
  const lines: string[] = ['[Pinned key facts — 权威事实层，优先级高于下方摘要。如与摘要冲突，以此为准。]'];
  for (const [category, items] of grouped) {
    const label = KEY_FACT_CATEGORY_LABEL[category] ?? category;
    for (const f of items) {
      lines.push(`- [${label}] ${f.subject}：${f.content}`);
    }
  }
  return lines.join('\n');
}

function buildSummaryContextInline(
  store: SummaryStore | null,
  memoryDB?: import('./memorydatabase/types').IslandMemoryDB | null,
  context?: {
    currentTime: string;
    currentLocation: string;
    currentTargetIds: string[];
    currentMainEventId?: string;
    recentUserInput?: string;
    tokenBudget?: number;
  },
): string {
  // 优先使用 memoryDB 的结构化注入（新系统）
  if (memoryDB && context) {
    const { buildMemoryPromptInjection } = require('./memorydatabase/prompt-injection');
    return buildMemoryPromptInjection(memoryDB, context);
  }

  // 降级到旧的 SummaryStore（兼容旧存档或 memoryDB 未启用时）
  if (!store) return '';

  const parts: string[] = [];
  const pinned = buildPinnedKeyFactsInline(store.keyFacts);
  if (pinned) parts.push(pinned);
  if (store.global) parts.push(`【至今剧情背景】\n${store.global}`);
  if (store.major.length) parts.push(`【近期阶段总结】\n${store.major.map(e => e.text).join('\n\n')}`);
  if (store.minor.length) parts.push(`【近期事件总结】\n${store.minor.map(e => e.text).join('\n\n')}`);
  return parts.join('\n\n');
}

// 只识别"明确要求跨时段/跨日推进"的强信号。
// 模糊的时段词(下午/晚上/傍晚/清晨 等)和"N点"不再触发 intent,避免正文没推时间却被逼着输出一个时间字段。
const TIME_ADVANCE_INTENT_REGEX =
  /(推进到|跳到|快进到|时间推进|时间跳到|次日|翌日|第二天|第二日|明天|后天|\d+\s*天后|\d+\s*天之后|\d+\s*小时后|\d+\s*小时之后|\d{1,2}\s*月\s*\d{1,2}\s*日)/;

export function detectTimeAdvanceIntent(userInput: string): boolean {
  if (!userInput) return false;
  return TIME_ADVANCE_INTENT_REGEX.test(userInput);
}

export function buildPrompt(
  statusData: StatusData,
  uiMessages: UiMessage[],
  userInput: string,
  summaryStore?: SummaryStore | null,
  options?: {
    skipProgress?: boolean;
    playerProfile?: PlayerProfile | null;
    plotLibrary?: PlotLibrary | null;
    characterCardLibrary?: CharacterCardLibrary | null;
    suppressPhoneMessageContent?: boolean;
    phoneMessageTargetName?: string;
    suppressUserInputLine?: boolean;
    scenePresence?: ScenePresence | null;
    memoryDB?: import('./memorydatabase/types').IslandMemoryDB | null;
    drawingSettings?: DrawingSettings | null;
  },
) {
  const cleanUserInput = sanitizePromptInputText(userInput);
  const topEvent = Object.entries(statusData.world.recentEvents)
    .find(([name, description]) => name !== '初始记录' && String(description ?? '').trim());
  const playerProfile = options?.playerProfile;
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

  const hasSummary =
    summaryStore &&
    (summaryStore.global ||
      summaryStore.major.length ||
      summaryStore.minor.length ||
      summaryStore.keyFacts.some(f => !f.superseded));

  // 构建记忆注入上下文
  const memoryContext = options?.memoryDB
    ? {
        currentTime: statusData.world.currentTime,
        currentLocation: statusData.world.currentLocation,
        currentTargetIds: options.scenePresence?.presentIds || statusData.targets.map(t => t.id),
        currentMainEventId: statusData.world.currentMainEventId,
        recentUserInput: cleanUserInput,
        config: (() => {
          try {
            // 从 localStorage 读取用户配置
            const { loadMemoryConfig } = require('./memory-config');
            return loadMemoryConfig();
          } catch {
            // 降级到默认配置
            return {
              tokenBudget: 15000,
              minorWindowSize: 8,
              majorWindowSize: 5,
              includeFacts: true,
              includeTasks: true,
              includeSecrets: true,
              includeImpressions: true,
            };
          }
        })(),
      }
    : undefined;

  const summaryContext =
    options?.memoryDB && memoryContext
      ? buildSummaryContextInline(summaryStore, options.memoryDB, memoryContext)
      : hasSummary
        ? buildSummaryContextInline(summaryStore)
        : '';
  const mainEventsContext = buildMainEventsContext(statusData);
  const plotContext = buildCurrentPlotContext(statusData, options?.plotLibrary);
  // 取 lastSummarizedIndex 和「总消息数 - 保留窗口」中较小的那个，
  // 保证即使全部消息都已被摘要，最近几条原文仍会出现在 prompt 中。
  const historyStartIndex = hasSummary
    ? Math.min(summaryStore.lastSummarizedIndex, Math.max(0, uiMessages.length - SUMMARY_KEEP_RECENT))
    : 0;
  const conversationHistory = buildConversationHistory(uiMessages, historyStartIndex);
  const scenePresenceContext = buildScenePresenceContext(statusData, options?.scenePresence);
  const relationshipGuidanceList = buildRelationshipGuidanceList(statusData, playerProfile, options?.scenePresence);
  const activeCharacterCards = buildActiveCharacterCards(
    statusData,
    options?.scenePresence,
    options?.characterCardLibrary,
  );
  const recentSceneContext = uiMessages
    .slice(-4)
    .filter(message => message.role === 'assistant')
    .map(message => getPromptMessageText(message))
    .filter(Boolean)
    .join('\n');
  // 审计协议只跟“当前可见场景/本轮输入”绑定，不能用剧情卡、事件名或地点命中。
  // 否则世界书里反复出现某角色名时，会让局部审计变成每轮全局常驻规则。
  const localAuditContext = [recentSceneContext, cleanUserInput].filter(Boolean).join('\n');
  const localAuditGuidance = buildLocalCharacterAuditList(statusData, localAuditContext, options?.scenePresence);
  const phoneMessageBoundary = options?.suppressPhoneMessageContent
    ? [
        '手机消息边界：',
        `玩家当前输入包含发送手机消息的指令${options.phoneMessageTargetName ? `，对象是${options.phoneMessageTargetName}` : ''}。`,
        '在正文可见场景中，可以描写玩家拿出手机、打开聊天、打字或准备发送。',
        '不要在正文里写出手机消息的具体内容。',
        '不要在正文里写出或暗示收信人已经回复。',
        '独立的手机系统会在正文结束后生成实际发送内容和收信人回复。',
      ].join('\n')
    : '';
  const saenaiDialogueInstruction = [
    '最终输出格式硬规则：Saenai 对话头像触发',
    '如果可见正文里出现以下五名角色的面对面台词，必须在该台词同一行最前面加 @saenai:角色名。',
    '五名角色：加藤惠、英梨梨、霞之丘诗羽、波岛出海、冰堂美智留。',
    '角色名必须原样复制这五个名字之一；不要写泽村英梨梨/加藤恵/霞诗子等别名。',
    '安艺伦也、玩家、旁白、手机消息和其他角色禁止使用 @saenai。',
    '禁止输出未带 @saenai 的五名角色独立引号对白。凡是这五名角色说出的「台词」，都必须写成 @saenai:角色名「台词」。',
    '不要把 @saenai 单独放一行；不要拆成两行；不要在 @saenai 和「台词」之间换行。',
    '声线、表情、动作描写可以跟在闭引号后面，但仍在同一行。',
    '改写对照：',
    '错误： 「因为学姐代入了自己嘛。」加藤惠的声音波澜不惊。',
    '正确： @saenai:加藤惠「因为学姐代入了自己嘛。」加藤惠的声音波澜不惊。',
    '错误： 「谁、谁管你要去哪里找谁啊！」她压着声音。',
    '正确： @saenai:英梨梨「谁、谁管你要去哪里找谁啊！」她压着声音。',
    '错误： @saenai:加藤惠「而且，什么叫『最幸福的女主角',
    '正确： @saenai:加藤惠「而且，什么叫『最幸福的女主角』啊，这种设定放在现实里也太夸张了吧。」',
    '正确示例：',
    '@saenai:加藤惠「因为学姐代入了自己嘛。」加藤惠的声音波澜不惊。',
    '正确示例：',
    '@saenai:英梨梨「去这么久，你掉进贩卖机里了吗？」',
  ].join('\n');

  const parts = [
    '你正在续写当前的日记式场景。',
    `可见正文必须包在 <${PRIMARY_VISIBLE_TAG}>...</${PRIMARY_VISIBLE_TAG}> 中。`,
    '可以使用 <context>...</context> 保存隐藏上下文，但可见正文只能放在可见标签里。',
    '除非用户明确要求，否则不要使用 Markdown 表格。',
    '保持回复聚焦、自然，并与当前场景一致。',
    '这是多角色场景系统。没有全局默认变量目标；镜头焦点只由当前正文、玩家输入、剧情卡和明确在场角色决定。',
    `当前位置：${statusData.world.currentLocation}`,
    mainEventsContext,
    scenePresenceContext,
    activeCharacterCards,
    relationshipGuidanceList
      ? `角色局部关系指导：每一块只在描写对应角色时生效，禁止把某个角色的指导当成全局思考方式。\n${relationshipGuidanceList}`
      : '',
    playerProfileText,
    phoneMessageBoundary,
    buildCharacterDataImportPrompt(options?.drawingSettings),
    buildImageGenerationPrompt(options?.drawingSettings),
    plotContext,
    summaryContext,
    conversationHistory,
    cleanUserInput && !options?.suppressUserInputLine ? `玩家当前输入：${cleanUserInput}` : '',
    localAuditGuidance
      ? `角色局部条件审计：只在指定角色实际在场、发言、行动或立刻反应时应用。不要输出审计过程。\n${localAuditGuidance}`
      : '',
    saenaiDialogueInstruction,
  ];

  // 只有没有副 API 处理变量时，才要求主 API 输出 <progress>。
  if (!options?.skipProgress) {
    parts.push(buildProgressInstruction(statusData));
    if (detectTimeAdvanceIntent(cleanUserInput)) {
      parts.push(
        '玩家当前输入要求推进时间。如果你的正文确实描写了时间流逝或场景切换到新时段，请在 <progress> 中输出完整的 `时间:YYYY-MM-DD HH:mm`（HH:mm 由你根据剧情合理判断）。如果正文实际上没有推进时间（例如只是对话中提到了时间词），则不要输出时间字段。禁止使用 `4月16日` 或缺时分的格式。',
      );
    }
  }

  return parts.filter(Boolean).join('\n');
}

export function buildPhoneChatPrompt(input: {
  statusData: StatusData;
  target: TargetStatus;
  history: PhoneChatMessage[];
  userInput: string;
  summaryStore?: SummaryStore | null;
  playerProfile?: PlayerProfile | null;
  plotLibrary?: PlotLibrary | null;
  characterCardLibrary?: CharacterCardLibrary | null;
  skipProgress?: boolean;
  triggerEvent?: string;
  forceMessage?: boolean;
}) {
  const {
    statusData,
    target,
    history,
    userInput,
    summaryStore,
    playerProfile,
    skipProgress = false,
    triggerEvent,
    forceMessage = false,
  } = input;
  const cleanUserInput = sanitizePromptInputText(userInput);

  // 清理占位符，防止泄露到 prompt
  const playerName = playerProfile?.name || '玩家';
  const cleanPlayerName = sanitizePlaceholders(playerName, playerName, target.name);
  const cleanTargetName = sanitizePlaceholders(target.name, cleanPlayerName, target.name);

  const miniPersona = getRelationshipMiniPersona(target);
  const relationshipGuidance = getRelationshipGuidance(target);
  const addressGuidance = getRelationshipAddressGuidance({ target, playerProfile });
  const anchorGuidance = getCharacterAnchorGuidance({ target, playerProfile });
  const recentEventsContext = buildRecentEventsContext(statusData);
  const mainEventsContext = buildMainEventsContext(statusData);
  // 手机聊天天然只有一个聊天对象，绕过 scenePresence 直接指定 targetIds 注入这一张完整卡。
  const activeCharacterCards = buildActiveCharacterCards(statusData, null, input.characterCardLibrary, {
    targetIds: [target.id],
  });
  const hasSummary =
    summaryStore &&
    (summaryStore.global ||
      summaryStore.major.length ||
      summaryStore.minor.length ||
      summaryStore.keyFacts.some(f => !f.superseded));
  const summaryContext = hasSummary ? buildSummaryContextInline(summaryStore) : '';
  const plotContext = buildCurrentPlotContext(statusData, input.plotLibrary);
  const playerProfileText = playerProfile?.name
    ? [
        `玩家姓名：${cleanPlayerName}`,
        playerProfile.className ? `玩家班级：${sanitizePlaceholders(playerProfile.className, cleanPlayerName)}` : '',
        playerProfile.personality
          ? `玩家性格：${sanitizePlaceholders(playerProfile.personality, cleanPlayerName)}`
          : '',
        playerProfile.appearance ? `玩家外貌：${sanitizePlaceholders(playerProfile.appearance, cleanPlayerName)}` : '',
        buildPlayerStatsText(playerProfile),
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const parts = [
    `你正在扮演 ${cleanTargetName}，通过手机消息和玩家聊天。`,
    `可见回复必须写在 <message>...</message> 中，只输出 ${cleanTargetName} 发出的手机消息。`,
    '语气要像即时通讯，不要写旁白、舞台说明或第三人称叙述。',
    '可以短一些，自然一些；除非玩家要求，不要一次发长篇。',
    '记住不在场的时候好感度是不会变化的，只有当玩家的消息让你产生了明确情绪反应时才评估好感度变化。',
    miniPersona,
    `当前时间：${statusData.world.currentTime}`,
    `当前位置：${statusData.world.currentLocation}`,
    mainEventsContext,
    activeCharacterCards,
    anchorGuidance ? `身份锚点（原作关系 + 班级换算 + 情感现状）：\n${anchorGuidance}` : '',
    `当前关系：${target.stage} · 好感度 ${target.affinity} · 执念 ${target.obsession}（${target.obsessionStage}）`,
    relationshipGuidance ? `当前关系反应：${relationshipGuidance}` : '',
    addressGuidance ? `称呼规则：${addressGuidance}` : '',
    playerProfileText,
    plotContext ? `当前正文主线参考：\n${plotContext}` : '',
    summaryContext ? `此前正文记忆与长期摘要：\n${summaryContext}` : '',
    recentEventsContext,
    buildPhoneChatHistory(history),
    triggerEvent ? `这条消息的触发事件：${triggerEvent}` : '',
    forceMessage
      ? '正文已经明确写到玩家收到了你发来的手机消息。必须补全这条消息，输出非空的 <message>...</message>；不要输出空 message。'
      : '',
    triggerEvent
      ? forceMessage
        ? `请根据触发事件补全这条已经发出的手机消息：${cleanUserInput}`
        : `请基于触发事件判断主动发一条手机消息：${cleanUserInput}`
      : `玩家刚发来的消息：${cleanUserInput}`,
  ];

  if (!skipProgress) {
    parts.push(buildProgressInstruction(statusData, target));
    if (detectTimeAdvanceIntent(cleanUserInput)) {
      parts.push(
        '玩家当前输入要求推进时间。如果手机聊天内容确实推进了时间，请在 <progress> 中输出完整的 `时间:YYYY-MM-DD HH:mm`（HH:mm 由你根据剧情合理判断）。如果只是聊天提及时间词、并未真的让剧情时间向前走，则不要输出时间字段。禁止使用 `4月16日` 或缺时分的格式。',
      );
    }
  }

  return parts.filter(Boolean).join('\n');
}

// ── Progress instruction & prompt builders ──

function buildProgressInstruction(statusData: StatusData, target?: TargetStatus | null): string {
  const inventoryList =
    Object.entries(statusData.player.inventory)
      .map(([name, d]) => `${name}(${d.count})`)
      .join('、') || '无';
  const outfitList = target
    ? Object.entries(target.outfits)
        .map(([k, v]) => `${k}:${v}`)
        .join('；')
    : '';
  const targetList = buildTargetStateList(statusData);
  const affinityExamples = buildAffinityUpdateExamples(statusData);
  const obsessionExamples = buildObsessionUpdateExamples(statusData);

  return [
    '',
    '在可见正文之后，必须输出一个 <progress> 块记录变量变化。',
    '使用 key:value 格式，每行一个字段。只写发生变化的字段，未变化字段省略。',
    `长场景结束后必须评估好感度；若本轮触发伦也/旧线/创作伤口，也要评估执念度（仅限 ${OBSESSION_TARGET_DISPLAY_NAMES}，名单外角色禁止输出执念度字段）。多人场景中，所有在场并明确对 User 有反应的角色都要分别评估好感度。`,
    '普通友好互动通常 +1；明显关心、理解、协助、保护通常 +2 到 +4；冒犯、越界、揭短、冷落通常 -1 到 -6。只有角色不在场、完全无互动、或关系没有变化时才省略该角色好感度。',
    `执念度专指角色对伦也这条旧线的牵引强度；只对 ${OBSESSION_TARGET_DISPLAY_NAMES} 五人有效，不要把它当成对 User 的关系温度。其他在场角色（红坂朱音、丸户、伦也本人或任何 NPC）一律不输出执念度字段。`,
    '亲密/背德轴判断规则：',
    '  默认角色使用“贞操”闩锁：只有角色列表显示“贞操=完璧”时，才允许在明确发生破除后输出 贞操.角色名:已失去。',
    '  泽村小百合是特殊的既婚人妻档案，不使用“贞操/完璧/处女”语义，也不输出贞操字段。',
    '  泽村小百合若正文明确发生亲密行为，只输出对应 X次数.泽村小百合:+N；系统会根据计数自动派生“背德关系已成立（已发生关系）”。',
    // '  红坂朱音、町田苑子以后即使作为成人角色加入，也不要默认套用小百合规则；是否使用贞操闩锁由角色列表里的亲密轴状态决定。',
    '  不要输出“背德.角色名”“关系.角色名:背德”这类未定义字段；背德状态由小百合的亲密计数派生。',
    '可用字段：',
    '  时间:YYYY-MM-DD HH:mm   — 仅当正文确实描写了时间流逝（进入次日/深夜，或明确跨过一个时段）时才输出，必须完整 YYYY-MM-DD HH:mm。正文未真正推进时间时整行省略；禁止使用 `4月16日`、`2012-04-16`（缺 HH:mm）、`明天` 这种非完整格式，也禁止仅凭玩家输入里的时间词就自行补一个新时间。',
    '  地点:新地点            — 角色实际移动到新地点时更新',
    target
      ? `  好感度:±N              — 旧格式好感变化，仅用于当前明确单对象：${target.name}`
      : '  好感度:±N              — 主场景禁用旧格式；必须改用 好感度.角色名或id:±N',
    `  好感度.角色名或id:±N    — 指定角色好感变化；多人场景必须从下方"可更新角色列表"的更新键复制角色名或 id（例：${affinityExamples}）`,
    `  执念度.角色名或id:±N    — 仅限白名单（${OBSESSION_TARGET_DISPLAY_NAMES}），语义是角色对伦也旧线/锚点的牵引（例：${obsessionExamples}）。名单外角色（包括红坂朱音、泽村小百合、町田苑子、伦也本人）禁止输出。`,
    '  五维.能力名:±N          — 玩家五维变化（能力名: 知识/魅力/灵巧/体贴/勇气；例：五维.体贴:+1）',
    target
      ? `  着装.部位:描述          — 更新当前明确对象 ${target.name} 的某个部位着装（例：着装.上装:换上了黑色卫衣）`
      : '  着装.部位:描述          — 主场景禁用旧单目标着装格式；没有明确对象时不要输出',
    '  贞操.角色名:已失去       — 仅适用于角色列表显示“贞操=完璧”的角色；泽村小百合禁用此字段；正文明确发生破除时输出，单向不可逆，禁止写回"完璧/处女"。',
    '  X次数.角色名:+N          — 亲密接触硬统计（X=接吻次数/口交次数/乳交次数/性交次数/被内射次数/肛交次数，特殊玩法可自定义如 足交次数）；正文明确发生时累加。泽村小百合发生关系时也只写此字段，由系统派生背德关系；不统计经验人数/伴侣数。',
    '  当前事件:事件ID          — 当有事件进行中时，每轮都必须输出该字段（例：当前事件:SAE_01-2）；事件结束时才输出 当前事件:无 清空',
    '  主线事件.事件ID:状态     — 更新主线事件状态（未触发/进行中/已结束/跳过/延后）',
    '  事件名:事件描述         — 添加或替换近期重要事件，可有多条',
    '  物品+物品名:数量:描述    — 获得物品（例：物品+匕首:1:从地上捡到的）',
    '  物品-物品名              — 失去或使用物品',
    '',
    '示例：',
    '<progress>',
    '时间:2012-03-31 08:30',
    '地点:东京·侦探坡',
    affinityExamples.split(' / ')[0] ?? '好感度.角色名:+1',
    obsessionExamples.split(' / ')[0] ?? '执念度.角色名:-1',
    '五维.体贴:+1',
    '着装.上装:私立丰之崎学园的制服衬衫',
    '早晨外出:两人决定去便利店买早餐。',
    '物品+塑料袋:1:装着零食的便利店袋子',
    '当前事件:SAE_01-1',
    '主线事件.SAE_01-1:进行中',
    '</progress>',
    '',
    `当前状态快照：`,
    `  时间: ${statusData.world.currentTime}`,
    `  地点: ${statusData.world.currentLocation}`,
    `  当前事件: ${statusData.world.currentMainEventId || '无'}`,
    `  主线事件: ${
      Object.entries(statusData.world.mainEvents ?? {})
        .map(([id, status]) => `${id}:${status}`)
        .join('；') || '无'
    }`,
    target
      ? `  当前明确变量对象: ${target.name}；好感度: ${target.affinity} (${target.stage})；执念度: ${target.obsession} (${target.obsessionStage})`
      : '  全局默认变量目标: 无；好感度/执念度更新必须显式写角色名或 id',
    `  可更新角色列表:\n${targetList}`,
    `  着装: ${outfitList || '无'}`,
    `  物品: ${inventoryList}`,
  ].join('\n');
}

function buildStateDeltaInstruction(statusData: StatusData): string {
  const targetList = buildTargetStateList(statusData);
  const affinityExamples = buildAffinityUpdateExamples(statusData);
  const obsessionExamples = buildObsessionUpdateExamples(statusData);
  return [
    '',
    '在你按预设规则输出完所有内容后,在消息最末尾追加一个 <state_delta> 块(独立于预设要求的任何标签):',
    '只记录本轮正文明确发生的变量变化；没有全局默认变量目标，角色变量必须显式指定角色名或 id。',
    '<state_delta>',
    '时间:YYYY-MM-DD HH:mm',
    '地点:当前所处具体地点',
    `好感度.角色名:±N（必须从下方“可更新角色”的更新键复制角色名；例如 ${affinityExamples}）`,
    `执念度.角色名:±N（例：${obsessionExamples}）`,
    '五维.能力名:±N',
    '贞操.角色名:已失去（仅适用于角色列表显示“贞操=完璧”的角色；泽村小百合禁用此字段）',
    'X次数.角色名:+N（亲密接触硬统计，X 接吻次数/口交次数/乳交次数/性交次数/被内射次数/肛交次数，特殊玩法可自定义如 足交次数；正文明确发生时累加。泽村小百合发生关系时也只写此字段，由系统派生背德关系；不统计经验人数）',
    '主线事件.事件ID:状态',
    '当前事件:事件ID',
    '</state_delta>',
    '只输出变化字段,未变化的整行省略。此块仅机器读取,与预设要求的任何标签互不影响。',
    `当前时间: ${statusData.world.currentTime}`,
    `当前地点: ${statusData.world.currentLocation}`,
    `当前事件: ${statusData.world.currentMainEventId || '无'}`,
    '全局默认变量目标: 无；好感度/执念度更新必须显式写角色名或 id',
    `可更新角色:\n${targetList}`,
  ].join('\n');
}

export function buildProgressPrompt(
  statusData: StatusData,
  turnMessages: UiMessage[],
  options?: { includePhoneMessages?: boolean },
): Array<{ role: 'system' | 'user'; content: string }> {
  const inventoryList =
    Object.entries(statusData.player.inventory)
      .map(([name, d]) => `${name}(${d.count})`)
      .join('、') || '无';
  const targetList = buildTargetStateList(statusData);
  const affinityExamples = buildAffinityUpdateExamples(statusData);
  const obsessionExamples = buildObsessionUpdateExamples(statusData);

  const recentUserMessage = [...turnMessages].reverse().find(m => m.role === 'user');
  const timeIntentNote =
    recentUserMessage && detectTimeAdvanceIntent(getPromptMessageText(recentUserMessage))
      ? '玩家最近输入提到推进时间。以正文实际描写为准：只有当对话正文确实跨过了一个时段或日期时或玩家提到今天,明天加时间段这里需要思考具时间，才输出完整 `时间:YYYY-MM-DD HH:mm` 字段；正文没有真正推进时间时，整行省略，禁止凭玩家输入里的时间词自行补齐一个新时间。'
      : '';

  const formatted = turnMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const text = getPromptMessageText(m);
      if (!text.trim()) return '';
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
        '全程使用中文：所有标签内容、思考标题、reasoning_content / 推理过程 / chain-of-thought 等任何可见或可记录的思考输出都必须用中文。禁止用英文进行内部推理或思考过渡，禁止出现 "Let me think / I will / The user wants / Step 1" 这类英文段落。中文以外的推理内容会被视为格式错误。',
        '',
        '当前状态：',
        `  时间: ${statusData.world.currentTime}`,
        `  地点: ${statusData.world.currentLocation}`,
        `  当前事件: ${statusData.world.currentMainEventId || '无'}`,
        `  主线事件: ${
          Object.entries(statusData.world.mainEvents ?? {})
            .map(([id, status]) => `${id}:${status}`)
            .join('；') || '无'
        }`,
        '  全局默认变量目标: 无（主场景不再使用旧单目标兜底）',
        `  可更新角色列表:\n${targetList}`,
        '  着装: 主场景不使用默认对象；只有正文明确涉及某角色服装时才记录',
        `  物品: ${inventoryList}`,
        '',
        '好感度判断规则：',
        '  变量更新只能依据本轮最新正文；不要沿用更早对话里的互动、在场或反应。',
        '  好感度只能看本轮最新正文中明确在场并对 User 产生情绪反应的角色；旧消息里出现过的角色，本轮正文没出现就不更新。',
        '  阅读本轮完整正文，不要只看最后一句。多人在场时，分别判断每个明确在场且对 User 产生情绪反应的角色。',
        '  普通友好互动或者逗乐大家的行动通常 +1；明显关心、理解、协助、保护通常 +2 到 +4,重大事件的可靠+8；冒犯、越界、揭短、冷落通常 -1 到 -6。',
        '  不要因为变化很小就省略好感度；只有角色不在场、完全无互动、纯环境描写、或关系没有任何变化时，才不输出该角色好感度。',
        '执念度判断规则（与好感度独立的对伦也旧情度，对伦也旧线的牵挂,对伦也的好感度）：',
        `  作用范围：仅限 ${OBSESSION_TARGET_DISPLAY_NAMES} 五人。其他角色（红坂朱音、丸户、伦也本人或任何 NPC）禁止输出执念度字段。`,
        '  执念度表示角色对伦也这条旧线的牵引强度(可以简单理解为对伦也的好感度)；它不是对 User 的好感度。',
        '  允许扣减的四个通道：',
        '    (a) 伦也直接出现并做出负面/低情商/失约/抛弃她的行为：-3 ~ -8；',
        '    (b) 对比戏：同回合既有伦也负面行为又有 user 正面行为：-3 ~ -8（同时好感度 +2 ~ +5）；',
        '    (c) 替代位：伦也虽未出场，user 替伦也完成她原本期待他做的事（陪改稿/陪打游戏/听她吐槽工作/重要时刻陪伴）：-1 ~ -3；',
        '    (d) 吐露旧事：女主主动在 user 面前提起伦也旧事或心结（不分正负），视为对 user 开放心防：-1 ~ -2。',
        '  允许涨高的通道：伦也直接打动她、回到她身边、或 user 做了让她想起伦也某个缺点反而美化伦也的事：+1 ~ +5。',
        '  只有当本轮正文明确触发伦也、初恋、青梅位置、核心读者、创作伤口、原作锚点，或角色与 user 暧昧推进时，才输出执念度变化。',
        '  伦也低情商、失约、回避或伤害性操作通常减少执念度，幅度可按冲击强弱在 -1 到 -10 间自行判断。',
        '  动态门槛：旧情度 >= 70 时变化幅度可以更鲜明；< 30 时已是稳定关系，不要频繁微调；< 10 时除非伦也强行介入，否则保持不变。',
        '  数值幅度：日常 ±1~2、明确事件 ±3~5、重大冲击 ±6~8。',
        '  好感度与执念度可以同时变化，且不要求同向，但禁止无脑同步 ±1。',
        '亲密/背德轴判断规则：',
        '  默认角色使用“贞操”闩锁：只有角色列表显示“贞操=完璧”时，才允许在明确发生破除后输出 贞操.角色名:已失去。',
        '  泽村小百合是特殊的既婚人妻档案，不使用“贞操/完璧/处女”语义，也不输出贞操字段。',
        '  泽村小百合若正文明确发生亲密行为，只输出对应 X次数.泽村小百合:+N；系统会根据计数自动派生“背德关系已成立（已发生关系）”。',
        // '  红坂朱音、町田苑子以后即使作为成人角色加入，也不要默认套用小百合规则；是否使用贞操闩锁由角色列表里的亲密轴状态决定。',
        '  不要输出“背德.角色名”“关系.角色名:背德”这类未定义字段；背德状态由小百合的亲密计数派生。',
        timeIntentNote ? `\n时间推进提醒：${timeIntentNote}` : '',
        '',
        '请用 <progress> 标签输出变化的字段，每行一个 key:value。如果没有任何变化，输出空的 <progress></progress>。',
        '可用字段：',
        '  时间:YYYY-MM-DD HH:mm（必须完整；禁止使用 `4月16日`、`明天` 或缺 HH:mm 的格式）',
        '  地点:新地点',
        '  好感度:±N（主场景禁用旧格式；必须使用 好感度.角色名:±N）',
        `  好感度.角色名或id:±N（多人场景必须用这个格式，并从“可更新角色列表”的更新键复制角色名；例如 ${affinityExamples}）`,
        `  执念度.角色名或id:±N（多人场景必须显式指定角色；例如 ${obsessionExamples}）`,
        '  五维.能力名:±N（知识/魅力/灵巧/体贴/勇气，例如 五维.勇气:+1）',
        '  着装.部位:描述（主场景禁用旧单目标着装格式；没有明确对象时不要输出）',
        '  贞操.角色名:已失去（仅适用于角色列表显示“贞操=完璧”的角色；泽村小百合禁用此字段）',
        '  X次数.角色名:+N（亲密接触硬统计，X 如 接吻次数/口交次数/乳交次数/性交次数/被内射次数/肛交次数，特殊玩法可自定义如 足交次数；正文明确发生时累加。泽村小百合发生关系时也只写此字段，由系统派生背德关系；不统计经验人数）',
        '  当前事件:事件ID（手机状态页显示的唯一当前主线事件；清空用 当前事件:无）',
        '  主线事件.事件ID:状态（未触发/进行中/已结束）',
        '  ※ 正在进行的当前事件在事件日期/持续至当天通常必须保持进行中；只有当前日期已经晚于该事件日期窗口，或当前剧情卡的可接续事件已被路由解锁并可在当前日期激活时，才允许写 主线事件.事件ID:已结束 并同轮写 当前事件:无。否则省略主线事件字段。',
        '  事件名:事件描述',
        '  物品+名称:数量:描述',
        '  物品-名称',
        '',
        '只输出变化的字段，未变化的省略。',
        options?.includePhoneMessages
          ? [
              '',
              '── 手机消息提取 ──',
              '在判断变量之外，请同时检查"最新正文"里是否出现攻略对象用手机/LINE/短信/私聊给玩家发消息。如有，按下方格式补充输出 <phone_messages> 标签，没有就输出空标签。',
              '提取规则：',
              '  1. 只提取 incoming：攻略对象发给玩家。',
              '  2. target_id 必须是"可更新角色列表"里出现过的 id；不能猜测归属。',
              '  3. 如果正文只写"她/对方/手机弹出消息"等无法确定具体联系人，跳过这条不输出。',
              '  4. message 优先用正文里明确写出的消息文本（引号、【】、冒号后的内容）；若只是概括，可用一句自然的手机文本重构；若内容不明确，跳过。',
              '  5. 只提取手机/LINE/短信/私聊等远程消息；面对面对话、旁白、心理活动、系统通知、普通叙述不要输出。',
              '  6. 非攻略对象（伦也、红坂朱音、丸户等）发来的消息不要输出，因为它们不会落到攻略对象的 thread。',
              '  7. 玩家发出的消息、玩家反馈、玩家输入、括号里的操作意图不要输出；玩家主动发短信只由手机发送指令处理。',
              '  8. 可输出多条按正文顺序。没有可提取的消息时输出空的 <phone_messages></phone_messages>。',
              '',
              '输出格式（在 <progress> 后面追加）：',
              '<phone_messages>',
              'direction: incoming',
              'target_id: 联系人id',
              'message: 消息正文',
              '---',
              'direction: incoming',
              'target_id: 联系人id',
              'message: 消息正文',
              '</phone_messages>',
            ].join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user' as const,
      content: `请分析以下本轮对话并输出变量更新：\n\n${formatted}`,
    },
  ];
}

export function buildPhoneProgressPrompt(input: {
  statusData: StatusData;
  target: TargetStatus;
  messages: PhoneChatMessage[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  const { statusData, target, messages } = input;

  // 清理角色名中的占位符，防止泄露到 prompt
  const playerName = '玩家'; // 手机进度分析不需要具体玩家名
  const cleanTargetName = sanitizePlaceholders(target.name, playerName, target.name);

  const formatted = messages
    .slice(-8)
    .map(message => `[${sanitizePlaceholders(message.speaker, playerName, cleanTargetName)}]\n${message.text.trim()}`)
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      role: 'system' as const,
      content: [
        '你是一个精确的手机聊天状态追踪器。根据手机聊天内容，判断变量是否需要更新。',
        '全程使用中文：所有标签内容、思考标题、reasoning_content / 推理过程 / chain-of-thought 等任何可见或可记录的思考输出都必须用中文。禁止用英文进行内部推理或思考过渡，禁止出现 "Let me think / I will / The user wants / Step 1" 这类英文段落。中文以外的推理内容会被视为格式错误。',
        '手机聊天默认只影响好感度、近期事务和必要的时间推进。',
        '只要玩家的消息让聊天对象产生了明确情绪反应，就应评估好感度变化：普通友好互动通常 +0到+1，明显关心/理解/帮忙通常 +2，冒犯、越界、揭短或骚扰通常 -1 到 -6。',
        '不要因为数值很小就省略好感度；只有完全寒暄、无效输入或关系没有任何变化时，才输出空的 <progress></progress>。',
        '只有聊天明确导致现实行动时，才允许更新地点、着装或物品。',
        '',
        '当前状态：',
        `  时间: ${statusData.world.currentTime}`,
        `  地点: ${statusData.world.currentLocation}`,
        `  当前事件: ${statusData.world.currentMainEventId || '无'}`,
        `  主线事件: ${
          Object.entries(statusData.world.mainEvents ?? {})
            .map(([id, status]) => `${id}:${status}`)
            .join('；') || '无'
        }`,
        `  聊天对象: ${cleanTargetName}`,
        `  好感度: ${target.affinity} (${target.stage})`,
        hasObsessionAxis(target) ? `  执念度: ${target.obsession} (${target.obsessionStage})` : '',
        '',
        '请用 <progress> 标签输出变化字段，每行一个 key:value。没有变化就输出空的 <progress></progress>。',
        '可用字段：',
        '  时间:YYYY-MM-DD HH:mm',
        '  地点:新地点',
        `  好感度:±N（只更新当前聊天对象：${cleanTargetName}）`,
        `  好感度.${cleanTargetName}:±N（也可显式写当前聊天对象；例如 好感度.${cleanTargetName}:+1）`,
        hasObsessionAxis(target)
          ? `  执念度:±N（旧情度，对伦也旧线的牵挂；只更新当前聊天对象：${cleanTargetName}）`
          : '',
        hasObsessionAxis(target)
          ? `  执念度.${cleanTargetName}:±N（也可显式写当前聊天对象；例如 执念度.${cleanTargetName}:-1）`
          : '',
        hasObsessionAxis(target)
          ? '  ※ 好感度与执念度（旧情度）是独立两条轴：好感对 user，执念对伦也。允许扣减执念的通道：伦也直接负面 / 对比戏 / user 替代位（user 替伦也完成她期待的事）/ 主动吐露旧事。日常戏只动其一；对比或替代位场景才允许同回合双动；禁止无脑同步 ±1。日常 ±1~2，明确事件 ±3~5，重大冲击 ±6~8。'
          : '',
        '  五维.能力名:±N（知识/魅力/灵巧/体贴/勇气）',
        '  着装.部位:描述',
        '  当前事件:事件ID（手机状态页显示的唯一当前主线事件；清空用 当前事件:无）',
        '  主线事件.事件ID:状态（未触发/进行中/已结束/跳过/延后）',
        '  ※ 正在进行的当前事件在事件日期/持续至当天通常必须保持进行中；只有当前日期已经晚于该事件日期窗口，或当前剧情卡的可接续事件已被路由解锁并可在当前日期激活时，才允许写 主线事件.事件ID:已结束/跳过/延后 并同轮写 当前事件:无。否则省略主线事件字段。',
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
  currentMainEventId?: string;
  affinityDelta?: number;
  affinityDeltas: Array<{ target: string; delta: number }>;
  obsessionDelta?: number;
  obsessionDeltas: Array<{ target: string; delta: number }>;
  statDeltas: Partial<Record<keyof PlayerStats, number>>;
  outfitChanges: Record<string, string>;
  events: Record<string, string>;
  mainEvents: Record<string, string>;
  itemsGained: Array<{ name: string; count: number; description: string }>;
  itemsLost: string[];
  /** 贞操破除标记：单向闩锁，正文明确发生时由 AI 写 `贞操.角色名:已失去`。 */
  virginityFlags: Array<{ target: string }>;
  /** 身体开发计数器增量：开放字段名（性交次数/足交次数等），单调累加。 */
  intimacyCounters: Array<{ field: string; target: string; delta: number }>;
};

function createEmptyProgressUpdate(): ProgressUpdate {
  return {
    affinityDeltas: [],
    obsessionDeltas: [],
    events: {},
    mainEvents: {},
    statDeltas: {},
    outfitChanges: {},
    itemsGained: [],
    itemsLost: [],
    virginityFlags: [],
    intimacyCounters: [],
  };
}

// 小此预设输出的 <progress> 格式特征:PG.1 / 时间推进:A → B / 主线任务进度:xxx / 概括:xxx
// 这种格式如果用我们原来的通用 parser 会把 PG.1 / 时间推进 / 概括 全部塞进 events,污染 recentEvents
function isKonatanProgressFormat(body: string): boolean {
  if (/^\s*PG\.?\s*\d/im.test(body)) return true;
  if (/时间推进\s*[:：][^\n]*[→>]/.test(body)) return true;
  if (/主线任务进度\s*[:：]/.test(body)) return true;
  return false;
}

// 从小此格式里抢救能提取的字段:时间、地点、事件ID、概括作为 recentEvent 描述
function parseKonatanFallback(body: string): ProgressUpdate | null {
  const result = createEmptyProgressUpdate();
  let hasAnyField = false;

  // 时间推进:A → B → 抽 B;退而求其次抽 A
  const timeAdvance = body.match(/时间推进\s*[:：]\s*([^\n]+)/);
  if (timeAdvance) {
    const raw = timeAdvance[1].trim();
    const arrowMatch = raw.match(/[→>]\s*(.+)$/);
    const value = (arrowMatch ? arrowMatch[1] : raw).trim();
    if (value) {
      result.time = value;
      hasAnyField = true;
    }
  }

  // 地点:xxx
  const loc = body.match(/(?:^|\n)\s*地点\s*[:：]\s*([^\n]+)/);
  if (loc) {
    result.location = loc[1].trim();
    hasAnyField = true;
  }

  // 主线任务进度里抽事件 ID(SAE_01-4 这种)
  const taskProg = body.match(/主线任务进度\s*[:：]\s*([^\n]+)/);
  if (taskProg) {
    const eventId = taskProg[1].match(/[A-Z]+_\d+[-_]?\d+[A-Za-z]*/)?.[0];
    if (eventId) {
      result.currentMainEventId = eventId;
      result.mainEvents[eventId] = '进行中';
      hasAnyField = true;
    }
  }

  // 事件:xxx 和 概括:xxx → 作为 recentEvents 描述
  const eventDesc = body.match(/(?:^|\n)\s*事件\s*[:：]\s*([^\n]+)/);
  if (eventDesc) {
    result.events['本轮事件'] = eventDesc[1].trim();
    hasAnyField = true;
  }
  const summary = body.match(/概括\s*[:：]\s*([^\n]+)/);
  if (summary) {
    result.events['本轮剧情'] = summary[1].trim();
    hasAnyField = true;
  }

  return hasAnyField ? result : null;
}

function parseStateBody(body: string): ProgressUpdate | null {
  const result = createEmptyProgressUpdate();
  let hasAnyField = false;

  for (const line of body.split('\n')) {
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

    // 当前事件:SAE_01-2 / 当前主线事件:无
    const currentEventMatch = trimmed.match(/^当前(?:主线)?事件[:：]\s*(.+)/);
    if (currentEventMatch) {
      const value = currentEventMatch[1].trim();
      result.currentMainEventId = /^(无|none|null|clear|-)$/.test(value) ? '' : value;
      hasAnyField = true;
      continue;
    }

    // 好感度.角色名或id:±N / 好感度变化:角色名或id:±N
    const targetedAffMatch =
      trimmed.match(/^好感度[.．]\s*([^:：]+)[:：]\s*([+\-]?\d+)/) ??
      trimmed.match(/^好感度变化[:：]\s*([^:：]+)[:：]\s*([+\-]?\d+)/);
    if (targetedAffMatch) {
      result.affinityDeltas.push({
        target: targetedAffMatch[1].trim(),
        delta: parseInt(targetedAffMatch[2], 10) || 0,
      });
      hasAnyField = true;
      continue;
    }

    // 执念度.角色名或id:±N / 执念度变化:角色名或id:±N
    const targetedObsMatch =
      trimmed.match(/^执念度[.．]\s*([^:：]+)[:：]\s*([+\-]?\d+)/) ??
      trimmed.match(/^执念度变化[:：]\s*([^:：]+)[:：]\s*([+\-]?\d+)/);
    if (targetedObsMatch) {
      const obsTarget = targetedObsMatch[1].trim();
      if (!hasObsessionAxisByName(obsTarget)) {
        // 防御：AI 偶尔会写"执念度.红坂朱音:+1"等名单外角色，丢弃避免污染数据。
        console.warn('[parseProgressUpdate] 丢弃非白名单 obsession 字段:', obsTarget);
        hasAnyField = true;
        continue;
      }
      result.obsessionDeltas.push({
        target: obsTarget,
        delta: parseInt(targetedObsMatch[2], 10) || 0,
      });
      hasAnyField = true;
      continue;
    }

    // 角色名或id.好感度:±N
    const prefixedAffMatch = trimmed.match(/^([^:：.．]+)[.．]\s*好感度[:：]\s*([+\-]?\d+)/);
    if (prefixedAffMatch) {
      result.affinityDeltas.push({
        target: prefixedAffMatch[1].trim(),
        delta: parseInt(prefixedAffMatch[2], 10) || 0,
      });
      hasAnyField = true;
      continue;
    }

    // 角色名或id.执念度:±N
    const prefixedObsMatch = trimmed.match(/^([^:：.．]+)[.．]\s*执念度[:：]\s*([+\-]?\d+)/);
    if (prefixedObsMatch) {
      const obsTarget = prefixedObsMatch[1].trim();
      if (!hasObsessionAxisByName(obsTarget)) {
        console.warn('[parseProgressUpdate] 丢弃非白名单 obsession 字段:', obsTarget);
        hasAnyField = true;
        continue;
      }
      result.obsessionDeltas.push({
        target: obsTarget,
        delta: parseInt(prefixedObsMatch[2], 10) || 0,
      });
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

    const obsMatch = trimmed.match(/^执念度[:：]\s*([+\-]?\d+)/);
    if (obsMatch) {
      result.obsessionDelta = parseInt(obsMatch[1], 10) || 0;
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

    // 贞操.角色名:已失去 —— 单向闩锁，只接受"破除"语义，不接受复位。
    const virginityMatch = trimmed.match(/^贞操[.．]\s*([^:：]+)[:：]\s*(.+)/);
    if (virginityMatch) {
      const value = virginityMatch[2].trim();
      // 仅当语义明确为"已破除"时记录；写"完璧/处女/intact"等复位语义一律忽略（前向不可回退）。
      if (/已?失去|破除|非处女|lost|broken/i.test(value)) {
        result.virginityFlags.push({ target: virginityMatch[1].trim() });
        hasAnyField = true;
      }
      continue;
    }

    // 性交次数.角色名:+N / 足交次数.角色名:+N（开放字段，仅接受"X次数"后缀）。
    // 设计意图是加深依恋感而非征服式统计，经验人数（伴侣数）不在此列，旧存档残留也不再解析。
    const counterMatch = trimmed.match(/^([一-鿿]{1,8}次数)[.．]\s*([^:：]+)[:：]\s*([+\-]?\d+)/);
    if (counterMatch) {
      const delta = parseInt(counterMatch[3], 10) || 0;
      if (delta > 0) {
        result.intimacyCounters.push({
          field: counterMatch[1].trim(),
          target: counterMatch[2].trim(),
          delta,
        });
        hasAnyField = true;
      }
      continue;
    }

    // 事件:本轮剧情=描述 / 事件.本轮剧情:描述
    const namedEventMatch =
      trimmed.match(/^事件[.．]\s*([^:：=＝]+)[:：=＝]\s*(.+)/) ?? trimmed.match(/^事件[:：]\s*([^=＝]+)[=＝]\s*(.+)/);
    if (namedEventMatch) {
      result.events[namedEventMatch[1].trim()] = namedEventMatch[2].trim();
      hasAnyField = true;
      continue;
    }

    // 主线事件.SAE_01-1:已结束 / 主线事件:SAE_01-1=已结束
    const mainEventMatch =
      trimmed.match(/^主线事件[.．]\s*([^:：=＝]+)[:：=＝]\s*(.+)/) ??
      trimmed.match(/^主线事件[:：]\s*([^=＝]+)[=＝]\s*(.+)/);
    if (mainEventMatch) {
      result.mainEvents[mainEventMatch[1].trim()] = mainEventMatch[2].trim();
      if (mainEventMatch[2].trim() === '进行中') {
        result.currentMainEventId = mainEventMatch[1].trim();
      }
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

export function parseProgressUpdate(rawResponse: string): ProgressUpdate | null {
  // 优先级 1:新格式 <state_delta>(我们自己的标签,不与任何预设冲突)
  const stateDelta = extractTaggedReply(rawResponse, 'state_delta', false);
  if (stateDelta) {
    const parsed = parseStateBody(stateDelta);
    if (parsed) return parsed;
  }

  // 优先级 2:传统 <progress> 标签,但要检测格式来源
  const tagged = extractTaggedReply(rawResponse, 'progress', false);
  if (!tagged) return null;

  // 小此预设格式 → 走 fallback 只抢救时间/地点/事件,不做字段误映射
  if (isKonatanProgressFormat(tagged)) {
    console.warn('[progress] detected preset-specific progress format, using fallback parser');
    return parseKonatanFallback(tagged);
  }

  // 标准格式 → 正常解析
  return parseStateBody(tagged);
}
