import { extractTaggedReply, getPromptMessageText } from '../message-format';
import type { UiMessage } from '../types';
import type { FactAnchor, KeyFact, KeyFactCategory, SummaryEntry, SummaryStore } from './types';
import { KEY_FACT_CATEGORY_LABEL, KEY_FACT_CATEGORY_MAP } from './types';

// 小摘要：每累积 5 条新消息触发一次。
export const MINOR_THRESHOLD = 5;
// 大摘要：每累积 4 条小摘要触发一次。
const MAJOR_THRESHOLD = 4;
// 全局压缩：每累积 4 条大摘要触发一次。
const GLOBAL_THRESHOLD = 4;

// ── 阈值判断 ──

/** 是否应运行小摘要：未暂停且新消息数达到阈值。 */
export function shouldRunMinorSummary(store: SummaryStore, messageCount: number): boolean {
  if (store.autoPaused) return false;
  return messageCount - store.lastSummarizedIndex >= MINOR_THRESHOLD;
}

/** 是否应运行大摘要：小摘要条数达到阈值。 */
export function shouldRunMajorSummary(store: SummaryStore): boolean {
  return store.minor.length >= MAJOR_THRESHOLD;
}

/** 是否应运行全局压缩：大摘要条数达到阈值。 */
export function shouldRunGlobalCompression(store: SummaryStore): boolean {
  return store.major.length >= GLOBAL_THRESHOLD;
}

// ── Prompt 构建 ──

type OrderedPrompt = { role: 'system' | 'user' | 'assistant'; content: string };

const CHINESE_AUDIT_LANGUAGE_RULE =
  '- 全程使用中文：最终标签内容、审计说明、思考标题、reasoning_content 或任何可见/可记录的推理过程都必须用中文，不要输出英文段落。';

/** 将消息列表格式化为 [说话人]\n内容 的文本块，供摘要 prompt 使用。 */
function formatMessagesForSummary(messages: UiMessage[]): string {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const text = getPromptMessageText(m);
      if (!text.trim()) return '';
      const speaker = m.speaker || (m.role === 'assistant' ? 'Assistant' : 'User');
      return `[${speaker}]\n${text.trim()}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** 把 factAnchor 渲染成 prompt 可读的状态快照文本。 */
function renderFactAnchor(anchor: FactAnchor | null | undefined): string {
  if (!anchor) return '';
  const affinities = anchor.affinities.length
    ? anchor.affinities.map(a => `${a.name}: ${a.value}（${a.stage}）`).join('、')
    : '无';
  const mainEvents = anchor.mainEvents.length ? anchor.mainEvents.map(e => `${e.id}:${e.status}`).join('；') : '无';
  return [
    '【状态快照（绝对事实，不得改写）】',
    `- 当前时间：${anchor.time || '未知'}`,
    `- 当前地点：${anchor.location || '未知'}`,
    `- 当前主线事件：${anchor.currentMainEventId || '无'}`,
    `- 主线事件进度：${mainEvents}`,
    `- 角色好感度：${affinities}`,
  ].join('\n');
}

/** 把 pinnedFacts 渲染成 prompt 可读的事实清单。 */
function renderPinnedFacts(facts: KeyFact[]): string {
  const active = facts.filter(f => !f.superseded);
  if (!active.length) return '';
  const grouped = new Map<KeyFactCategory, KeyFact[]>();
  for (const fact of active) {
    if (!grouped.has(fact.category)) grouped.set(fact.category, []);
    grouped.get(fact.category)!.push(fact);
  }
  const lines: string[] = ['【关键事实清单（必须保留，不得省略或改写）】'];
  for (const [category, items] of grouped) {
    const label = KEY_FACT_CATEGORY_LABEL[category] ?? category;
    for (const f of items) {
      lines.push(`- [${label}] ${f.subject}：${f.content}`);
    }
  }
  return lines.join('\n');
}

/** 构建小摘要 prompt：对一段对话片段做约 100 字的剧情记录，同时抽取结构化关键事实。 */
export function buildMinorSummaryPrompt(messages: UiMessage[], anchor?: FactAnchor | null): OrderedPrompt[] {
  const formatted = formatMessagesForSummary(messages);
  const anchorBlock = renderFactAnchor(anchor);
  return [
    {
      role: 'system',
      content: [
        '你是一个精确的剧情记录员。请对以下对话片段进行摘要并抽取关键事实。',
        '',
        '严格规则：',
        '- 禁止推断、臆测、心理补完；只记录正文明确出现的言行与状态变化。',
        '- 每条摘要和关键事实必须能在正文里找到直接依据，不准添加原文没有的角色、动作或情绪。',
        '- 禁止不必要的总结和升华，忠实记录角色的言行举止和情感变化。',
        '- 纯中文输出。',
        CHINESE_AUDIT_LANGUAGE_RULE,
        '',
        '输出三部分：',
        '1. <summary> 标签：用约 100 字概括本段对话的剧情，附上时间和地点。',
        '2. <key_facts> 标签：按下方格式逐行列出新产生的关键事实。没有则输出空标签。',
        '3. <state_delta> 标签：只记录本段对话明确产生的变量变化。没有变化则输出空标签。',
        '',
        '<key_facts> 行格式：`[类别] 主体 | 内容`（类别限定：承诺、秘密、关系、物品、事件、地点、设定）。',
        '<state_delta> 可用字段（每行一个 key:value，只写变化字段，未变化省略）：',
        '  时间:YYYY-MM-DD HH:mm（必须完整，禁止 `4月16日` 或缺 HH:mm 的格式）',
        '  地点:新地点',
        '  好感度.角色名:±N（多角色分别输出；例：好感度.加藤惠:+1）',
        '  五维.能力名:±N（知识/魅力/灵巧/体贴/勇气；例：五维.体贴:+1）',
        '  着装.部位:描述（旧单目标格式；主场景没有明确对象时不要输出）',
        '  当前事件:事件ID（设置当前主线事件；清空用 当前事件:无）',
        '  主线事件.事件ID:状态（未触发/进行中/已结束/跳过/延后）',
        '  事件:本轮剧情=简短概括',
        '  物品+名称:数量:描述（获得物品；例：物品+蛋包饭券:1:英梨梨要求的交换条件）',
        '  物品-名称（失去或使用物品；例：物品-塑料袋）',
        '<state_delta> 规则：没有全局默认变量目标；只更新正文里明确出现或直接受影响的角色。多角色同时在场时，分别输出 好感度.角色名:±N。不要把某个角色的审计或关系规则套给其他角色。',
        '示例：',
        '<summary>',
        '4月15日 放学后 / 美术室：User 请英梨梨帮忙检查稿子，她勉强答应但要求下周一请吃蛋包饭作为交换……',
        '',
        '时间：2012-04-15 16:30 ~ 17:40',
        '地点：私立丰之崎学园/美术室',
        '</summary>',
        '<key_facts>',
        '[承诺] User → 英梨梨 | 下周一请她吃蛋包饭',
        '[关系] User 与 英梨梨 | 两人首次单独在美术室交流，氛围缓和',
        '[物品] 蛋包饭券 | User 答应下周一请英梨梨吃蛋包饭',
        '</key_facts>',
        '<state_delta>',
        '时间:2012-04-15 16:30',
        '地点:私立丰之崎学园-美术室',
        '好感度.英梨梨:+1',
        '事件:本轮剧情=User 请英梨梨帮忙检查稿子，英梨梨提出下周一请吃蛋包饭作为交换。',
        '物品+蛋包饭券:1:英梨梨要求的交换条件',
        '</state_delta>',
        anchorBlock,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: `请对以下对话进行摘要：\n\n${formatted}`,
    },
  ];
}

/** 构建大摘要 prompt：将多条小摘要合并为按时间线组织的总结。 */
export function buildMajorSummaryPrompt(
  minors: SummaryEntry[],
  anchor?: FactAnchor | null,
  pinnedFacts: KeyFact[] = [],
): OrderedPrompt[] {
  const formatted = minors
    .map((entry, i) => `[片段${i + 1} | 消息 ${entry.range[0]}-${entry.range[1]}]\n${entry.text}`)
    .join('\n\n');
  const anchorBlock = renderFactAnchor(anchor);
  const pinnedBlock = renderPinnedFacts(pinnedFacts);

  return [
    {
      role: 'system',
      content: [
        '你是一个精确的剧情记录员。请对以下多段摘要进行全面梳理，制作简明扼要的总结。',
        '',
        '总结应当遵循以下原则：',
        '- 按时间顺序或逻辑顺序组织信息，并明确给出具体时间节点',
        '- 保留关键事件和重要细节，省略冗余描述',
        '- 直接陈述事实，避免主观评价',
        '- 使用简洁清晰的语言，避免过度修饰',
        '- 突出事件发展脉络和关键转折点',
        '- 不回避任何敏感内容，保证记录完全还原前文',
        '- 事件及时间线必须精确记录时间推进',
        '- 严禁引入小摘要和关键事实清单中没有的新内容',
        CHINESE_AUDIT_LANGUAGE_RULE,
        '',
        '总结必须使用 <summary> 标签包裹，格式：',
        '<summary>',
        '【事件及时间线】',
        '• I.{主线事件I}: {简要描述}',
        '  - 1.{支线事件}: {描述}',
        '  - 2.{支线事件}: {描述}',
        '• II.{主线事件II}: {简要描述}',
        '',
        '【成长线】',
        '• {人物名}: {性格变化、关系进展}',
        '</summary>',
        anchorBlock,
        pinnedBlock,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: `请对以下摘要进行总结：\n\n${formatted}`,
    },
  ];
}

/** 构建全局压缩 prompt：将已有全局摘要与新增大摘要合并，控制在 600 字以内。 */
export function buildGlobalCompressionPrompt(
  oldGlobal: string | null,
  majors: SummaryEntry[],
  anchor?: FactAnchor | null,
  pinnedFacts: KeyFact[] = [],
): OrderedPrompt[] {
  const majorFormatted = majors
    .map((entry, i) => `[总结${i + 1} | 消息 ${entry.range[0]}-${entry.range[1]}]\n${entry.text}`)
    .join('\n\n');

  const contextBlock = oldGlobal ? `已有全局摘要：\n${oldGlobal}\n\n新增总结：\n${majorFormatted}` : majorFormatted;
  const anchorBlock = renderFactAnchor(anchor);
  const pinnedBlock = renderPinnedFacts(pinnedFacts);

  return [
    {
      role: 'system',
      content: [
        '你是一个精确的剧情记录员。请将已有的全局摘要与新增的总结合并，制作一份更新后的全局摘要。',
        '',
        '总结应当遵循以下原则：',
        '- 按时间顺序或逻辑顺序组织信息，并明确给出具体时间节点',
        '- 保留关键事件和重要细节，省略冗余描述',
        '- 直接陈述事实，避免主观评价',
        '- 使用简洁清晰的语言，避免过度修饰',
        '- 不回避任何敏感内容，保证记录完全还原前文',
        '- 全局摘要应控制在 600 字以内',
        '- 关键事实已另行存储在事实清单中，你只需给出时间线叙事，不要重复列举事实，但叙事中要提及它们的影响',
        '- 严禁引入原摘要和事实清单中没有的新内容',
        CHINESE_AUDIT_LANGUAGE_RULE,
        '',
        '总结必须使用 <summary> 标签包裹，格式：',
        '<summary>',
        '【事件及时间线】',
        '• I.{主线事件}: {简要描述}',
        '',
        '【成长线】',
        '• {人物名}: {性格变化、关系进展}',
        '</summary>',
        anchorBlock,
        pinnedBlock,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: `请合并以下内容为全局摘要：\n\n${contextBlock}`,
    },
  ];
}

// ── 结果解析 ──

/** 从 AI 回复中提取 <summary> 标签内的文本；找不到标签时回退到裁剪原文。 */
export function parseSummaryResult(text: string): string {
  const tagged = extractTaggedReply(text, 'summary', false);
  if (tagged) return tagged;
  // 后备逻辑：找不到标签时返回裁剪后的原文，小模型有时会漏掉标签。
  return text.trim();
}

/** 从 AI 回复中提取 <key_facts> 块，解析每行 `[类别] 主体 | 内容` 格式。 */
export function parseKeyFactsFromSummary(raw: string): Array<Pick<KeyFact, 'category' | 'subject' | 'content'>> {
  const tagged = extractTaggedReply(raw, 'key_facts', false);
  if (!tagged) return [];
  const facts: Array<Pick<KeyFact, 'category' | 'subject' | 'content'>> = [];
  for (const rawLine of tagged.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^[-•*]?\s*[\[【]\s*([^\]】]+?)\s*[\]】]\s*(.+?)\s*[|｜]\s*(.+)$/);
    if (!match) continue;
    const categoryKey = match[1].trim();
    const subject = match[2].trim();
    const content = match[3].trim();
    if (!subject || !content) continue;
    const category = KEY_FACT_CATEGORY_MAP[categoryKey] ?? KEY_FACT_CATEGORY_MAP[categoryKey.toLowerCase()];
    if (!category) continue;
    facts.push({ category, subject, content });
  }
  return facts;
}

// ── 摘要上下文构建器位于 message-format.ts，避免循环依赖 ──
