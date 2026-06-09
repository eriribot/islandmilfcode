import { extractTaggedReply, getPromptMessageText } from '../message-format';
import type { UiMessage } from '../types';
import type { FactAnchor, KeyFact, KeyFactCategory, SummaryEntry, SummaryStore } from './types';
import { KEY_FACT_CATEGORY_LABEL, KEY_FACT_CATEGORY_MAP } from './types';
import { loadSummaryTriggerConfig } from '../memory-config';
import { selectPhoneArchiveImpressions } from '../phone/types';

// 默认阈值（当 localStorage 无配置时使用）
export const MINOR_THRESHOLD = 5;
const MAJOR_THRESHOLD = 4;
const GLOBAL_THRESHOLD = 4;

// ── 阈值判断 ──

/** 是否应运行小摘要：未暂停且新消息数达到阈值。 */
export function shouldRunMinorSummary(store: SummaryStore, messageCount: number): boolean {
  if (store.autoPaused) return false;
  const config = loadSummaryTriggerConfig();
  const threshold = config.minorThreshold ?? MINOR_THRESHOLD;
  return messageCount - store.lastSummarizedIndex >= threshold;
}

/** 是否应运行大摘要：小摘要条数达到阈值。 */
export function shouldRunMajorSummary(store: SummaryStore): boolean {
  const config = loadSummaryTriggerConfig();
  const threshold = config.majorThreshold ?? MAJOR_THRESHOLD;
  return store.minor.length >= threshold;
}

/** 是否应运行全局压缩：大摘要条数达到阈值。 */
export function shouldRunGlobalCompression(store: SummaryStore): boolean {
  const config = loadSummaryTriggerConfig();
  const threshold = config.globalThreshold ?? GLOBAL_THRESHOLD;
  return store.major.length >= threshold;
}

// ── Prompt 构建 ──

type OrderedPrompt = { role: 'system' | 'user' | 'assistant'; content: string };

const CHINESE_AUDIT_LANGUAGE_RULE =
  '- 全程使用中文：最终标签内容、审计说明、思考标题、reasoning_content / 推理过程 / chain-of-thought 等任何可见或可记录的思考输出都必须用中文。禁止用英文进行内部推理或思考过渡，禁止出现 "Let me think / I will / The user wants / Step 1" 这类英文段落。中文以外的推理内容会被视为格式错误。';

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
  const obsessions = anchor.obsessions?.length
    ? anchor.obsessions.map(o => `${o.name}: ${o.value}（${o.stage}）`).join('、')
    : '无';
  const mainEvents = anchor.mainEvents.length ? anchor.mainEvents.map(e => `${e.id}:${e.status}`).join('；') : '无';
  const lines = [
    '【状态快照（绝对事实，不得改写）】',
    `- 当前时间：${anchor.time || '未知'}`,
    `- 当前地点：${anchor.location || '未知'}`,
    `- 当前主线事件：${anchor.currentMainEventId || '无'}`,
    `- 主线事件进度：${mainEvents}`,
    `- 角色好感度（对 User）：${affinities}`,
    `- 角色执念度（对伦也旧线）：${obsessions}`,
  ];

  // 性状态：少女档案显示贞操闩锁；成人已婚档案只显示边界模式和计数器。
  if (anchor.sexStatus) {
    const s = anchor.sexStatus;
    if (s.mode === 'adult-married') {
      const status = s.counters.length ? '背德关系已成立（已发生关系）' : '既婚边界（尚未越界）';
      lines.push(`- ${s.name} 亲密状态：${status}（不使用贞操/完璧闩锁，禁止输出贞操字段）`);
    } else {
      lines.push(`- ${s.name} 贞操状态：${s.virginity === 'lost' ? '已失去（不可逆，禁止改写回完璧/处女）' : '完璧'}`);
    }
    if (s.counters.length) {
      const countersText = s.counters.map(c => `${c.field}${c.value}`).join(' / ');
      lines.push(`- ${s.name} 身体开发记录（硬统计，仅供前后一致，禁止主动提及、强调或据此渲染）：${countersText}`);
    }
  }

  return lines.join('\n');
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
        '输出两部分：',
        '1. <summary> 标签：用约 100 字概括本段对话的剧情，附上时间和地点。',
        '2. <key_facts> 标签：按下方格式逐行列出新产生的关键事实。没有则输出空标签。',
        '',
        '<key_facts> 行格式：`[类别] 主体 | 内容`（类别限定：承诺、秘密、关系、物品、事件、地点、设定）。',
        '  ⚠ [关系] 类别特殊规则：只记录本段新形成或明显改变的核心印象，不要复述已有印象；内容必须是简短标签（2~10字），不要写完整句子。',
        '  格式：`[关系] A → B | 标签 | 极性`，表示 A 对 B 形成的印象。极性取 + / - / 0（正面好感 / 负面反感 / 中性观察），省略时按中性处理。一条只写一个标签，多个印象分多行。',
        '  数量限制：每段最多 6 条 [关系] 印象，其中最多 3 条正面、2 条中性、1 条负面；同义标签只保留最准确的一条。恋人/交往/伴侣/后宫/结婚/婚约/结缘这类关系闩锁若正文明确成立，必须保留为单条标签，不要再派生一串相似情绪标签。',
        '  示例：`[关系] 英梨梨 → User | 幽默 | +`、`[关系] 英梨梨 → User | 太爱多管闲事 | -`、`[关系] 加藤惠 → User | 话多 | 0`。',
        '示例：',
        '<summary>',
        '4月15日 放学后 / 美术室：user帮英梨梨因为伦也放鸽子遗留下的查稿子，她勉强答应但要求下周一请吃蛋包饭作为交换……',
        '',
        '时间：2012-04-15 16:30 ~ 17:40',
        '地点：私立丰之崎学园/美术室',
        '</summary>',
        '<key_facts>',
        '[承诺] User → 英梨梨 | 下周一请她吃蛋包饭',
        '[关系] 英梨梨 → User | 还算靠谱 | +',
        '[物品] 蛋包饭券 | User 答应下周一请英梨梨吃蛋包饭',
        '</key_facts>',
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
    let content = match[3].trim();
    if (!subject || !content) continue;
    const category = KEY_FACT_CATEGORY_MAP[categoryKey] ?? KEY_FACT_CATEGORY_MAP[categoryKey.toLowerCase()];
    if (!category) continue;
    // 关系行的内容尾部可能带极性标记（`标签 | +`），facts 表只存标签本身，极性归 impressions 表用。
    if (category === 'relation') content = content.split(/[|｜]/)[0].trim();
    if (!content) continue;
    facts.push({ category, subject, content });
  }
  return facts;
}

/** 印象抽取结果：source 是持有印象的角色名，subject 是印象对象（通常 User），label 是简短印象标签，polarity 是情感极性。 */
export type ParsedImpression = {
  source: string;
  subject: string;
  label: string;
  polarity: -1 | 0 | 1;
};

/** 把 `标签 | 极性` 尾部的极性标记拆出来；无标记按中性。兼容 +/正、-/负、0/中。 */
function splitLabelPolarity(rawTail: string): { label: string; polarity: -1 | 0 | 1 } {
  const segs = rawTail
    .split(/[|｜]/)
    .map(s => s.trim())
    .filter(Boolean);
  if (segs.length >= 2) {
    const mark = segs[segs.length - 1];
    if (/^[+＋]$|正|positive/i.test(mark)) return { label: segs.slice(0, -1).join(' ').trim(), polarity: 1 };
    if (/^[-－—]$|负|negative/i.test(mark)) return { label: segs.slice(0, -1).join(' ').trim(), polarity: -1 };
    if (/^0$|中性?|neutral/i.test(mark)) return { label: segs.slice(0, -1).join(' ').trim(), polarity: 0 };
  }
  // 没有可识别的极性段：整段当标签，按中性。
  return { label: rawTail.trim(), polarity: 0 };
}

/**
 * 从 <key_facts> 块里抽取 [关系] 行，保留 `A → B | 标签 | 极性` 的 A/B/极性拆分。
 * parseKeyFactsFromSummary 把 A→B 压成单 subject 进 facts 表，这里专门为 impressions 表保留方向与极性。
 * source(A) 的名→id 归一由调用方（run.ts）处理，本函数只负责拆字段。
 */
export function parseImpressionsFromSummary(raw: string): ParsedImpression[] {
  const tagged = extractTaggedReply(raw, 'key_facts', false);
  if (!tagged) return [];
  const impressions: ParsedImpression[] = [];
  for (const rawLine of tagged.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // 仅处理关系类别行：`[关系] A → B | 标签 | 极性`
    const match = line.match(/^[-•*]?\s*[\[【]\s*([^\]】]+?)\s*[\]】]\s*(.+?)\s*[|｜]\s*(.+)$/);
    if (!match) continue;
    const category = KEY_FACT_CATEGORY_MAP[match[1].trim()] ?? KEY_FACT_CATEGORY_MAP[match[1].trim().toLowerCase()];
    if (category !== 'relation') continue;
    const { label, polarity } = splitLabelPolarity(match[3].trim());
    // 拆 subject 里的 "A → B"（兼容 →/->/＞ 等箭头与"对/与"连接词）。
    const subjectRaw = match[2].trim();
    const arrowMatch = subjectRaw.match(/^(.+?)\s*(?:→|->|＞|对|与)\s*(.+)$/);
    if (!arrowMatch) continue;
    const source = arrowMatch[1].trim();
    const subject = arrowMatch[2].trim();
    if (!source || !subject || !label) continue;
    impressions.push({ source, subject, label, polarity });
  }
  return selectPhoneArchiveImpressions(impressions);
}
