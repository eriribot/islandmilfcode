import {
  getRelationshipAddressGuidance,
  getRelationshipAuditGuidance,
  getRelationshipGuidance,
  getRelationshipMiniPersona,
} from './relationship';
import type { KeyFact, KeyFactCategory, SummaryStore } from './summary/types';
import { KEY_FACT_CATEGORY_LABEL } from './summary/types';
import type {
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

export function extractTaggedReply(raw: string, tagName: string, streaming: boolean) {
  const closedTag = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const closedMatch = raw.match(closedTag);
  if (closedMatch) {
    return dedupeAdjacentReply(stripMetaSubtags(closedMatch[1] ?? ''));
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
    const nextSectionIndex = afterOpen.search(
      /<\/?(?:content|正文|context|progress|current_event|roleplay_options)\b[^>]*>/i,
    );
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

export function extractContextReply(text: string, { streaming = false }: { streaming?: boolean } = {}) {
  const raw = String(text ?? '');
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
    return message.text;
  }

  const visible = getVisibleMessageText(message);
  if (visible) return visible;

  const raw = String(message.rawText || message.text || '');
  if (isFrontendHtmlShell(raw)) return '';

  return String(message.text || '');
}

export function getReaderMessages(messages: UiMessage[]) {
  return messages.filter(message => {
    if (message.role === 'system') return false;
    if (message.role === 'user') return Boolean(message.text.trim());
    if (isFrontendHtmlShell(message.rawText || message.text)) return false;
    // assistant: 流式中或有任何原文都保留，让掉标签的楼层也能被翻到并走编辑入口恢复。
    return message.streaming || Boolean(message.text.trim());
  });
}

// 摘要完成后至少保留最近几条原始消息，防止模型丢失近期对话细节。
const SUMMARY_KEEP_RECENT = 6;

function buildConversationHistory(uiMessages: UiMessage[], startIndex = 0) {
  const historyLines = uiMessages
    .slice(startIndex)
    .filter(message => !message.streaming && (message.role === 'user' || message.role === 'assistant'))
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

function buildPlotWhitelist(plotLibrary: PlotLibrary) {
  const all = Object.values(plotLibrary.events);
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
    '合法主线事件 ID 白名单（仅限下列 ID 可出现在 <progress> 的 当前事件 / 主线事件 字段里）：',
    ...lines,
    '硬约束：禁止在 <progress> 里使用白名单之外的任何事件 ID；禁止自造新的卷号/新的事件编号；不确定时把 当前事件 留空，不要发明 ID。',
  ].join('\n');
}

function pickNextUpcomingEvent(statusData: StatusData, plotLibrary: PlotLibrary): PlotEventCard | null {
  const mainEvents = statusData.world.mainEvents ?? {};
  const currentDate = getDatePart(statusData.world.currentTime);
  const candidates = Object.values(plotLibrary.events)
    .filter(event => Boolean(event.schedule?.date))
    .filter(event => normalizeMainEventStatus(mainEvents[event.id]) === MAIN_EVENT_NOT_STARTED)
    .filter(event => !currentDate || (event.schedule!.endDate ?? event.schedule!.date) >= currentDate)
    .sort((a, b) => a.schedule!.date.localeCompare(b.schedule!.date) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

// 把事件卡 JSON 压缩成给 AI 写正文用的精简版本。
// 砍掉:触发控制 / 结束控制 / 触发变量 / User介入参考 / 关键情节的 id 数组 — 这些是事件系统的元数据,AI 不需要。
// 保留:标题 / 阶段摘要 / 阶段背景 / 关键人物 / 场景修饰(前2) / 人物状态(认知+心态+对白气质) / 叙事重点(前3)。
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
        .slice(0, max ?? 999);
      if (items.length) lines.push(`${label}:`, ...items.map(s => `  - ${s}`));
    } else if (typeof value === 'string' && value.trim()) {
      lines.push(`${label}: ${value.trim()}`);
    }
  };

  pushIf('阶段摘要', parsed['阶段摘要'] ?? parsed['summary']);
  pushIf('阶段背景', parsed['阶段背景'], 3);
  pushIf('关键人物', parsed['关键人物']);
  pushIf('关键地点', parsed['关键地点']);
  pushIf('场景修饰', parsed['场景修饰'], 2);

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
    const top = items.slice(0, 2);
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
  const whitelist = buildPlotWhitelist(plotLibrary);
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
    '基础阈值：0-19 只能尝试且容易出错；20+ 可处理简单行动；40+ 可处理普通行动；60+ 可处理困难行动；80+ 可处理高压、公开或剧情关键行动。',
    '维度用途：知识用于推理、学业、设定理解、识破矛盾；魅力用于公开圆场、说服、维持体面；灵巧用于绘画/手工/设备操作、隐藏痕迹、转移注意；体贴用于读懂压力、保护隐私、不过界；勇气用于正面承担风险、直球表态、打破僵局。',
    '复合判定：行动涉及多种能力时，优先看最相关的主维度，再用副维度修正结果。例如公开替角色圆谎看魅力，保护秘密看体贴，处理证据看灵巧，正面顶住压力看勇气，识破话中破绽看知识。',
    '结果规则：低于阈值不是强制失败，而是只能部分成功或产生代价，如尴尬、误会、耗时、暴露风险上升、对方警戒。高于阈值 20 点以上可获得额外收益，如更自然、更隐蔽、更少代价或让对方更容易接受。',
    '边界规则：五维只决定行动质量、风险和角色反应，不直接等于好感度；好感度仍由角色是否被理解、尊重、帮助、冒犯或越界来判断。高数值不能强迫角色违背性格，也不能跳过必要剧情铺垫。',
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
      return `- id=${target.id}；姓名=${target.name}${aliases ? `；别名/线索=${aliases}` : ''}${classSegment}；好感度=${target.affinity}（${target.stage}）；更新键=好感度.${target.name}:±N`;
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
      if (!guidance && !address) return '';
      return [`[${target.name}]`, guidance ? `关系反应：${guidance}` : '', address ? `称呼：${address}` : '']
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

function buildSummaryContextInline(store: SummaryStore): string {
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
    suppressPhoneMessageContent?: boolean;
    phoneMessageTargetName?: string;
    suppressUserInputLine?: boolean;
    scenePresence?: ScenePresence | null;
  },
) {
  const topEvent = Object.entries(statusData.world.recentEvents)[0];
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
  const summaryContext = hasSummary ? buildSummaryContextInline(summaryStore) : '';
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
  const recentSceneContext = uiMessages
    .slice(-4)
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => getPromptMessageText(message))
    .filter(Boolean)
    .join('\n');
  // 审计协议只跟“当前可见场景/本轮输入”绑定，不能用剧情卡、事件名或地点命中。
  // 否则世界书里反复出现某角色名时，会让局部审计变成每轮全局常驻规则。
  const localAuditContext = [recentSceneContext, userInput].filter(Boolean).join('\n');
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
    relationshipGuidanceList
      ? `角色局部关系指导：每一块只在描写对应角色时生效，禁止把某个角色的指导当成全局思考方式。\n${relationshipGuidanceList}`
      : '',
    topEvent ? `最新事件：${topEvent[0]} - ${topEvent[1]}` : '',
    playerProfileText,
    phoneMessageBoundary,
    plotContext,
    summaryContext,
    conversationHistory,
    userInput && !options?.suppressUserInputLine ? `玩家当前输入：${userInput}` : '',
    localAuditGuidance
      ? `角色局部条件审计：只在指定角色实际在场、发言、行动或立刻反应时应用。不要输出审计过程。\n${localAuditGuidance}`
      : '',
  ];

  // 只有没有副 API 处理变量时，才要求主 API 输出 <progress>。
  if (!options?.skipProgress) {
    parts.push(buildProgressInstruction(statusData));
    if (detectTimeAdvanceIntent(userInput)) {
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
  const miniPersona = getRelationshipMiniPersona(target);
  const relationshipGuidance = getRelationshipGuidance(target);
  const addressGuidance = getRelationshipAddressGuidance({ target, playerProfile });
  const recentEventsContext = buildRecentEventsContext(statusData);
  const mainEventsContext = buildMainEventsContext(statusData);
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
    '记住不在场的时候好感度是不会变化的，只有当玩家的消息让你产生了明确情绪反应时才评估好感度变化。',
    miniPersona,
    `当前时间：${statusData.world.currentTime}`,
    `当前位置：${statusData.world.currentLocation}`,
    mainEventsContext,
    `当前关系：${target.stage} · 好感度 ${target.affinity}`,
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
        ? `请根据触发事件补全这条已经发出的手机消息：${userInput}`
        : `请基于触发事件判断主动发一条手机消息：${userInput}`
      : `玩家刚发来的消息：${userInput}`,
  ];

  if (!skipProgress) {
    parts.push(buildProgressInstruction(statusData, target));
    if (detectTimeAdvanceIntent(userInput)) {
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

  return [
    '',
    '在可见正文之后，必须输出一个 <progress> 块记录变量变化。',
    '使用 key:value 格式，每行一个字段。只写发生变化的字段，未变化字段省略。',
    '长场景结束后必须评估好感度。多人场景中，所有在场并明确对 User 有反应的角色都要分别评估。',
    '普通友好互动通常 +1；明显关心、理解、协助、保护通常 +2 到 +4；冒犯、越界、揭短、冷落通常 -1 到 -6。只有角色不在场、完全无互动、或关系没有变化时才省略该角色好感度。',
    '可用字段：',
    '  时间:YYYY-MM-DD HH:mm   — 仅当正文确实描写了时间流逝（进入次日/深夜，或明确跨过一个时段）时才输出，必须完整 YYYY-MM-DD HH:mm。正文未真正推进时间时整行省略；禁止使用 `4月16日`、`2012-04-16`（缺 HH:mm）、`明天` 这种非完整格式，也禁止仅凭玩家输入里的时间词就自行补一个新时间。',
    '  地点:新地点            — 角色实际移动到新地点时更新',
    target
      ? `  好感度:±N              — 旧格式好感变化，仅用于当前明确单对象：${target.name}`
      : '  好感度:±N              — 主场景禁用旧格式；必须改用 好感度.角色名或id:±N',
    `  好感度.角色名或id:±N    — 指定角色好感变化；多人场景必须从下方“可更新角色列表”的更新键复制角色名或 id（例：${affinityExamples}）`,
    '  五维.能力名:±N          — 玩家五维变化（能力名: 知识/魅力/灵巧/体贴/勇气；例：五维.体贴:+1）',
    target
      ? `  着装.部位:描述          — 更新当前明确对象 ${target.name} 的某个部位着装（例：着装.上装:换上了黑色卫衣）`
      : '  着装.部位:描述          — 主场景禁用旧单目标着装格式；没有明确对象时不要输出',
    '  当前事件:事件ID          — 设置手机状态页显示的唯一当前主线事件（例：当前事件:SAE_01-2；清空用 当前事件:无）',
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
      ? `  当前明确变量对象: ${target.name}；好感度: ${target.affinity} (${target.stage})`
      : '  全局默认变量目标: 无；好感度更新必须显式写角色名或 id',
    `  可更新角色列表:\n${targetList}`,
    `  着装: ${outfitList || '无'}`,
    `  物品: ${inventoryList}`,
  ].join('\n');
}

function buildStateDeltaInstruction(statusData: StatusData): string {
  const targetList = buildTargetStateList(statusData);
  const affinityExamples = buildAffinityUpdateExamples(statusData);
  return [
    '',
    '在你按预设规则输出完所有内容后,在消息最末尾追加一个 <state_delta> 块(独立于预设要求的任何标签):',
    '只记录本轮正文明确发生的变量变化；没有全局默认变量目标，角色变量必须显式指定角色名或 id。',
    '<state_delta>',
    '时间:YYYY-MM-DD HH:mm',
    '地点:当前所处具体地点',
    `好感度.角色名:±N（必须从下方“可更新角色”的更新键复制角色名；例如 ${affinityExamples}）`,
    '五维.能力名:±N',
    '主线事件.事件ID:状态',
    '当前事件:事件ID',
    '</state_delta>',
    '只输出变化字段,未变化的整行省略。此块仅机器读取,与预设要求的任何标签互不影响。',
    `当前时间: ${statusData.world.currentTime}`,
    `当前地点: ${statusData.world.currentLocation}`,
    `当前事件: ${statusData.world.currentMainEventId || '无'}`,
    '全局默认变量目标: 无；好感度更新必须显式写角色名或 id',
    `可更新角色:\n${targetList}`,
  ].join('\n');
}

export function buildProgressPrompt(
  statusData: StatusData,
  turnMessages: UiMessage[],
): Array<{ role: 'system' | 'user'; content: string }> {
  const inventoryList =
    Object.entries(statusData.player.inventory)
      .map(([name, d]) => `${name}(${d.count})`)
      .join('、') || '无';
  const targetList = buildTargetStateList(statusData);
  const affinityExamples = buildAffinityUpdateExamples(statusData);

  const recentUserMessage = [...turnMessages].reverse().find(m => m.role === 'user');
  const timeIntentNote =
    recentUserMessage && detectTimeAdvanceIntent(recentUserMessage.text)
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
        timeIntentNote ? `\n时间推进提醒：${timeIntentNote}` : '',
        '',
        '请用 <progress> 标签输出变化的字段，每行一个 key:value。如果没有任何变化，输出空的 <progress></progress>。',
        '可用字段：',
        '  时间:YYYY-MM-DD HH:mm（必须完整；禁止使用 `4月16日`、`明天` 或缺 HH:mm 的格式）',
        '  地点:新地点',
        '  好感度:±N（主场景禁用旧格式；必须使用 好感度.角色名:±N）',
        `  好感度.角色名或id:±N（多人场景必须用这个格式，并从“可更新角色列表”的更新键复制角色名；例如 ${affinityExamples}）`,
        '  五维.能力名:±N（知识/魅力/灵巧/体贴/勇气，例如 五维.勇气:+1）',
        '  着装.部位:描述（主场景禁用旧单目标着装格式；没有明确对象时不要输出）',
        '  当前事件:事件ID（手机状态页显示的唯一当前主线事件；清空用 当前事件:无）',
        '  主线事件.事件ID:状态（未触发/进行中/已结束）',
        '  事件名:事件描述',
        '  物品+名称:数量:描述',
        '  物品-名称',
        '',
        '只输出变化的字段，未变化的省略。',
      ].join('\n'),
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
        `  当前事件: ${statusData.world.currentMainEventId || '无'}`,
        `  主线事件: ${
          Object.entries(statusData.world.mainEvents ?? {})
            .map(([id, status]) => `${id}:${status}`)
            .join('；') || '无'
        }`,
        `  聊天对象: ${target.name}`,
        `  好感度: ${target.affinity} (${target.stage})`,
        '',
        '请用 <progress> 标签输出变化字段，每行一个 key:value。没有变化就输出空的 <progress></progress>。',
        '可用字段：',
        '  时间:YYYY-MM-DD HH:mm',
        '  地点:新地点',
        `  好感度:±N（只更新当前聊天对象：${target.name}）`,
        `  好感度.${target.name}:±N（也可显式写当前聊天对象；例如 好感度.${target.name}:+1）`,
        '  五维.能力名:±N（知识/魅力/灵巧/体贴/勇气）',
        '  着装.部位:描述',
        '  当前事件:事件ID（手机状态页显示的唯一当前主线事件；清空用 当前事件:无）',
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
  currentMainEventId?: string;
  affinityDelta?: number;
  affinityDeltas: Array<{ target: string; delta: number }>;
  statDeltas: Partial<Record<keyof PlayerStats, number>>;
  outfitChanges: Record<string, string>;
  events: Record<string, string>;
  mainEvents: Record<string, string>;
  itemsGained: Array<{ name: string; count: number; description: string }>;
  itemsLost: string[];
};

function createEmptyProgressUpdate(): ProgressUpdate {
  return {
    affinityDeltas: [],
    events: {},
    mainEvents: {},
    statDeltas: {},
    outfitChanges: {},
    itemsGained: [],
    itemsLost: [],
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
