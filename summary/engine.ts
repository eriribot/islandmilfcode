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

/** 是否应运行小摘要：未暂停且新增 Reader 可摘要楼层数达到阈值。 */
export function shouldRunMinorSummary(store: SummaryStore, summaryFloorCount: number): boolean {
  if (store.autoPaused) return false;
  const config = loadSummaryTriggerConfig();
  const threshold = config.minorThreshold ?? MINOR_THRESHOLD;
  return summaryFloorCount - store.lastSummarizedIndex >= threshold;
}

/** 是否应运行大摘要：小摘要条数达到阈值。 */
export function shouldRunMajorSummary(store: SummaryStore): boolean {
  const config = loadSummaryTriggerConfig();
  const threshold = config.majorThreshold ?? MAJOR_THRESHOLD;
  const rangeContains = (outer: [number, number], inner: [number, number]) =>
    inner[0] >= outer[0] && inner[1] <= outer[1];
  const uncoveredMinorCount = store.minor.filter(
    minor => !store.major.some(major => rangeContains(major.range, minor.range)),
  ).length;
  return uncoveredMinorCount >= threshold;
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

const SUMMARY_TEMPORAL_LOCATION_RULES = [
  '时间与地点判定规则（高优先级）：',
  '- 状态快照里的“当前时间/当前地点”是进入本段摘要前的权威起点；摘要只能在正文明确发生时间推进或移动完成时改写它。',
  '- “要去/准备去/回头去/等会去/想去/该回家了/我们走吧/路上/准备出门”只表示意图或过渡，不等于已经抵达；不得把目的地写成当前地点。',
  '- 只有出现明确抵达/进入/已经在某地的叙述，或状态更新字段明确写出地点变化，才允许把地点改成新地点。',
  '- 若正文里的地点提示、标题、UI 状态条、角色台词与状态快照冲突，先按状态快照记录，并在摘要中写“地点冲突/未确认”，不要擅自选一个。',
  '- 没有明确日期推进时，不得把本段事件写成“第二天/翌日/次日/早上/上午”；只能沿用状态快照时间，或写“时间未推进/时间未确认”。',
  '- 摘要里的“时间：”必须来自明确时间证据或状态快照；key_facts 只有明确发生时间时才写时间字段，没有明确发生时间就省略，由系统写入“记录时间”锚点。',
  '- 玩家明确纠正时间或地点时，纠正优先级高于上一轮 assistant 的错误地点/时间标签。',
  '',
  '时间地点反例：',
  '- 错误：正文只说“等会回家/准备回家”，就把地点写成“User家”。',
  '- 错误：上一轮 assistant 的地点条误写“住宅区-安艺伦也家卧室”，但状态快照/玩家纠正显示已回家，摘要仍沿用该错误地点。',
  '- 正确：若只出现“准备回家”，地点保持状态快照地点，并可写“角色提出回家意图，尚未确认抵达”。',
  '- 正确：若玩家说“我不是回家了吗”，摘要应记录“玩家纠正当前位置为家中”，不要继续保存冲突地点。',
].join('\n');

const SUMMARY_SHARED_ACCURACY_RULES = [
  '通用准确性规则：',
  '- 只记录输入中明确出现的信息；不补写动机、心理、因果、时间、地点、物品归属或关系结论。',
  '- assistant 旧回复、状态条、摘要、关键事实清单彼此冲突时，优先级为：玩家明确纠正 > 状态快照/状态更新字段 > 最新正文明确叙述 > 旧摘要/旧回复。',
  '- 玩家输入是当前事实修正的重要证据；若玩家指出“时间不对/地点不对/我不是已经回家了吗”，必须保留纠正，不得继续沿用被纠正内容。',
  '- 原作设定、剧情卡、常识和角色习惯只能帮助理解语境，不能替代本段证据。',
  '- 不要把提议、计划、选项、愿望、猜测、吐槽、系统提示、UI 标签当成已经发生的剧情事实。',
  '- 输出必须短而密，保留会影响后续续写的事实：时间、地点、在场人物、行动结果、承诺、秘密、物品、关系变化、未解决冲突。',
  '- 全程只输出指定标签；不要输出解释、分析过程、道歉、前言或多余代码块。',
].join('\n');

const KEY_FACT_EXTRACTION_RULES = [
  '关键事实抽取规则：',
  '- 只抽取会长期影响后续续写的事实；普通寒暄、临时动作、一次性表情不要写入 key_facts。',
  '- [事件] 写已经发生且会影响后续的剧情节点；未确认发生的计划不要写成事件。',
  '- [物品] 写物品获得、丢失、交付、归属、状态变化；仅被提到但无变化时不要写。',
  '- [地点] 只写稳定地点事实或明确地点变化；地点有冲突时写进 summary 的“未确认/冲突”，不要写入 key_facts。',
  '- [承诺] 写明确约定、交换条件、期限；模糊客套不要写。',
  '- [秘密] 写知情范围明确且后续需要保密的信息。',
  '- [设定] 写角色长期设定、身份、硬约束；不要把临时情绪写成设定。',
  '- [关系] 只写本段新形成或明显改变的核心印象，内容必须是 2~10 字标签，并带极性。',
  '- 同一事实不要重复写；如果只是再次出现旧事实，除非本段改变了它，否则不要输出。',
].join('\n');

const MINOR_SUMMARY_FRAMEWORK = [
  '任务类型：小总结 / 剧情片段事实抽取。',
  '角色：你是严格的剧情书记员，负责把最近几条聊天转成可被长期记忆系统使用的短记录。',
  '输入：你会收到状态快照和一段按说话人标记的聊天。状态快照是本段开始前的权威状态，聊天正文是本段可记录证据。',
  '处理步骤：',
  '1. 先读取状态快照，锁定进入本段前的时间、地点、当前主线事件和关键角色状态。',
  '2. 再逐条读取聊天，只记录明确发生、明确说出、明确纠正或明确更新的内容。',
  '3. 判断本段是否真的发生时间推进、地点变化、物品变化、关系变化或承诺/秘密新增。',
  '4. 若发现时间/地点冲突或玩家纠正，写进 summary 的“未确认/冲突”，不要静默覆盖。',
  '5. 最后抽取 key_facts；没有长期价值就输出空标签。',
  '输出期望：summary 约 100~160 字，重点是事实连续性，不写文学润色。',
].join('\n');

const MAJOR_SUMMARY_FRAMEWORK = [
  '任务类型：大总结 / 多段小总结归并。',
  '角色：你是时间线归档员，负责把多条小总结整理成一个阶段级记录。',
  '输入：你会收到多段小总结、状态快照，以及可能存在的关键事实清单。小总结可能含有局部冲突、未确认转场或旧错误。',
  '处理步骤：',
  '1. 按每段小总结的时间、楼层范围和内容建立时间线，不要改变事件顺序。',
  '2. 合并重复事件，保留最新的玩家纠正和状态快照，不要让旧错误继续扩散。',
  '3. 把明确发生的剧情节点写进“事件及时间线”；把关系/能力/心理阶段变化写进“成长线”。',
  '4. 对地点、时间、事件状态存在冲突或证据不足的内容，单独写进“未确认/冲突”，不要当成事实结论。',
  '5. 只使用输入里已有的信息，不新增角色、不补因果、不替剧情收束。',
  '输出期望：阶段总结要比小总结更压缩，但必须保留具体时间节点、地点依据和关键后果。',
].join('\n');

const GLOBAL_SUMMARY_FRAMEWORK = [
  '任务类型：全局摘要 / 长期记忆压缩。',
  '角色：你是长期剧情档案管理员，负责把已有全局摘要和新增大总结压缩成一份稳定背景。',
  '输入：你会收到旧全局摘要、新增大总结、状态快照和关键事实清单。旧全局摘要可能过时，新增大总结可能包含玩家纠正。',
  '处理步骤：',
  '1. 先识别新增大总结相对旧全局摘要带来的真实变化：时间线推进、关系阶段、任务结果、物品/秘密/承诺变化。',
  '2. 用最新且证据更强的事实覆盖旧错误；如果只是冲突未确认，就保留为“未确认/冲突”，不要写成定论。',
  '3. 删除短期寒暄和镜头细节，保留会影响后续章节的因果、状态、关系、承诺、秘密和未解决压力。',
  '4. 保持时间线顺序，不能把未发生的计划提前写成已发生。',
  '5. 控制在 600 字以内，宁可少写修辞，也要保留可续写的事实锚点。',
  '输出期望：全局摘要应成为后续主 prompt 的长期背景，稳定、短密、可追溯，不制造新剧情。',
].join('\n');

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
      const time = f.gameTime ? `（${f.gameTime}）` : '';
      lines.push(`- [${label}]${time} ${f.subject}：${f.content}`);
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
        MINOR_SUMMARY_FRAMEWORK,
        '',
        SUMMARY_SHARED_ACCURACY_RULES,
        '',
        SUMMARY_TEMPORAL_LOCATION_RULES,
        '',
        KEY_FACT_EXTRACTION_RULES,
        '',
        CHINESE_AUDIT_LANGUAGE_RULE,
        '',
        '输出格式：',
        '1. 必须先输出 <summary>...</summary>。',
        '2. 必须再输出 <key_facts>...</key_facts>。',
        '3. 除这两个标签外，不输出任何其他内容。',
        '',
        '<summary> 内容要求：',
        '- 第一句概括本段已经发生的剧情。',
        '- 必须包含“时间：...”“地点：...”“时间地点依据：...”。',
        '- 若时间或地点不可靠，写“时间：未确认”或“地点：未确认/存在冲突”，并在依据中说明冲突来源。',
        '- 不要写未发生的后续计划；可以写“某人提出/打算/准备...，尚未确认完成”。',
        '',
        '<key_facts> 行格式：明确发生时间可靠时使用 `[类别] 发生时间 | 主体 | 内容`；发生时间不可靠但事实需要保留时必须使用旧格式 `[类别] 主体 | 内容`，系统会自动附加“记录时间”锚点。禁止为了填满格式而猜时间。类别限定：承诺、秘密、关系、物品、事件、地点、设定。',
        '  时间可靠的来源只包括：正文明确日期/时段、状态快照当前时间、或状态更新字段；不能从地点 UI、角色打算、剧情常识推断。',
        '  格式：`[关系] A → B | 标签 | 极性`，表示 A 对 B 形成的印象。极性取 + / - / 0（正面好感 / 负面反感 / 中性观察），省略时按中性处理。一条只写一个标签，多个印象分多行。',
        '  数量限制：每段最多 6 条 [关系] 印象，其中最多 3 条正面、2 条中性、1 条负面；同义标签只保留最准确的一条。恋人/交往/伴侣/后宫/结婚/婚约/结缘这类关系闩锁若正文明确成立，必须保留为单条标签，不要再派生一串相似情绪标签。',
        '  示例：`[关系] 英梨梨 → User | 幽默 | +`、`[关系] 英梨梨 → User | 太爱多管闲事 | -`、`[关系] 加藤惠 → User | 话多 | 0`。',
        '',
        '好例子：',
        '<summary>',
        '4月15日 放学后 / 美术室：user帮英梨梨因为伦也放鸽子遗留下的查稿子，她勉强答应但要求下周一请吃蛋包饭作为交换……',
        '',
        '时间：2012-04-15 16:30 ~ 17:40',
        '地点：私立丰之崎学园/美术室',
        '时间地点依据：正文明确写出放学后在美术室查稿，未出现离开美术室或抵达其他地点。',
        '</summary>',
        '<key_facts>',
        '[承诺] 2012-04-15 17:10 | User → 英梨梨 | 下周一请她吃蛋包饭',
        '[关系] 2012-04-15 17:20 | 英梨梨 → User | 还算靠谱 | +',
        '[物品] 2012-04-15 17:10 | 蛋包饭券 | User 答应下周一请英梨梨吃蛋包饭',
        '</key_facts>',
        '',
        '坏例子（不要这样）：',
        '正文只写“准备回家”，却输出“地点：User家”。正确写法是沿用状态快照地点，并说明“提出回家意图，尚未确认抵达”。',
        '玩家纠正“我不是回家了吗”，却继续沿用上一轮错误地点。正确写法是记录玩家纠正，并把冲突地点标为旧错误。',
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
    .map((entry, i) => `[片段${i + 1} | 楼层 ${entry.range[0] + 1}-${entry.range[1] + 1}]\n${entry.text}`)
    .join('\n\n');
  const anchorBlock = renderFactAnchor(anchor);
  const pinnedBlock = renderPinnedFacts(pinnedFacts);

  return [
    {
      role: 'system',
      content: [
        MAJOR_SUMMARY_FRAMEWORK,
        '',
        SUMMARY_SHARED_ACCURACY_RULES,
        '',
        SUMMARY_TEMPORAL_LOCATION_RULES,
        '',
        CHINESE_AUDIT_LANGUAGE_RULE,
        '',
        '总结必须使用 <summary> 标签包裹，格式：',
        '<summary>',
        '【事件及时间线】',
        '• {时间/时间段}｜{地点或地点未确认}｜{事件标题}: {已经发生的事实、结果、后续影响}',
        '  - {必要细节}: {只保留影响后续的动作/承诺/物品/秘密/关系变化}',
        '• {下一时间节点}: {下一事件}',
        '',
        '【成长线】',
        '• {人物名}: {本阶段明确变化；没有明确变化则省略}',
        '',
        '【未确认/冲突】',
        '• {时间/地点/事件状态冲突}: {冲突来源与保守处理；没有则写“无”}',
        '</summary>',
        '',
        '合并规则：',
        '- 多段小总结重复提到同一事件时，合并为一条，保留最新、最明确、被玩家纠正后的版本。',
        '- 小总结中的“时间地点依据”优先保留；若没有依据，不得在大总结里补猜。',
        '- key_facts 是权威事实层，但若与玩家纠正冲突，以玩家纠正为准。',
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
    .map((entry, i) => `[总结${i + 1} | 楼层 ${entry.range[0] + 1}-${entry.range[1] + 1}]\n${entry.text}`)
    .join('\n\n');

  const contextBlock = oldGlobal ? `已有全局摘要：\n${oldGlobal}\n\n新增总结：\n${majorFormatted}` : majorFormatted;
  const anchorBlock = renderFactAnchor(anchor);
  const pinnedBlock = renderPinnedFacts(pinnedFacts);

  return [
    {
      role: 'system',
      content: [
        GLOBAL_SUMMARY_FRAMEWORK,
        '',
        SUMMARY_SHARED_ACCURACY_RULES,
        '',
        SUMMARY_TEMPORAL_LOCATION_RULES,
        '',
        CHINESE_AUDIT_LANGUAGE_RULE,
        '',
        '总结必须使用 <summary> 标签包裹，格式：',
        '<summary>',
        '【事件及时间线】',
        '• {时间段/日期}: {阶段性事件与结果；只写已发生事实}',
        '',
        '【成长线】',
        '• {人物名}: {长期关系/能力/状态变化}',
        '',
        '【长期锚点】',
        '• 承诺/秘密/物品/未解决压力: {后续必须记住的内容}',
        '',
        '【未确认/冲突】',
        '• {仍未解决的时间/地点/事件冲突；没有则写“无”}',
        '</summary>',
        '',
        '压缩规则：',
        '- 旧全局摘要中被新增大总结或玩家纠正推翻的内容必须删除或改成“旧记录有误/已被纠正”。',
        '- 不要重复列举全部关键事实，只保留对后续剧情有约束力的长期锚点。',
        '- 若 600 字限制不够，优先保留：当前时间线位置、主线事件状态、关系阶段、承诺、秘密、物品归属、未解决冲突。',
        '- 不要为了顺滑叙事补完缺失桥段；缺失就写缺失或省略。',
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
  if (tagged && isValidSummaryText(tagged)) return tagged;
  if (tagged !== null && tagged !== undefined) return '';
  // 后备逻辑：找不到标签时返回裁剪后的原文，小模型有时会漏掉标签。
  const fallback = text.trim();
  return isValidSummaryText(fallback) ? fallback : '';
}

function isValidSummaryText(text: string): boolean {
  const normalized = text
    .replace(/<summary\b[^>]*>|<\/summary>/gi, '')
    .replace(/<key_facts\b[^>]*>[\s\S]*?<\/key_facts>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
  if (!normalized) return false;
  if (/^(?:0|０|零|null|none|无|没有|沒有|空|empty|n\/a|na|undefined)$/i.test(normalized)) return false;
  if (/^[0０\s,，.。;；:：|｜/\\-]+$/.test(normalized)) return false;
  return /[\p{Script=Han}A-Za-z0-9]/u.test(normalized);
}

/** 从 AI 回复中提取 <key_facts> 块，解析 `[类别] 时间 | 主体 | 内容` 或旧格式 `[类别] 主体 | 内容`。 */
export function parseKeyFactsFromSummary(raw: string): Array<Pick<KeyFact, 'category' | 'subject' | 'content' | 'gameTime'>> {
  const tagged = extractTaggedReply(raw, 'key_facts', false);
  if (!tagged) return [];
  const facts: Array<Pick<KeyFact, 'category' | 'subject' | 'content' | 'gameTime'>> = [];
  for (const rawLine of tagged.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^[-•*]?\s*[\[【]\s*([^\]】]+?)\s*[\]】]\s*(.+?)\s*[|｜]\s*(.+)$/);
    if (!match) continue;
    const categoryKey = match[1].trim();
    const segments = [match[2], match[3]]
      .join('|')
      .split(/[|｜]/)
      .map(part => part.trim())
      .filter(Boolean);
    const hasTimePrefix = segments.length >= 3 && looksLikeGameTime(segments[0]);
    const gameTime = hasTimePrefix ? segments[0] : undefined;
    const subject = hasTimePrefix ? segments[1] : match[2].trim();
    let content = hasTimePrefix ? segments.slice(2).join(' | ').trim() : match[3].trim();
    if (!subject || !content) continue;
    const category = KEY_FACT_CATEGORY_MAP[categoryKey] ?? KEY_FACT_CATEGORY_MAP[categoryKey.toLowerCase()];
    if (!category) continue;
    // 关系行的内容尾部可能带极性标记（`标签 | +`），facts 表只存标签本身，极性归 impressions 表用。
    if (category === 'relation') content = content.split(/[|｜]/)[0].trim();
    if (!content) continue;
    facts.push({ category, subject, content, gameTime });
  }
  return facts;
}

function looksLikeGameTime(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(text)) return true;
  if (/^(第\s*)?\d+\s*天/.test(text)) return true;
  if (/(上午|中午|下午|傍晚|晚上|夜晚|深夜|清晨|放学后|午休|课间|凌晨)/.test(text)) return true;
  return false;
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
    const segments = [match[2], match[3]]
      .join('|')
      .split(/[|｜]/)
      .map(part => part.trim())
      .filter(Boolean);
    const hasTimePrefix = segments.length >= 3 && looksLikeGameTime(segments[0]);
    const subjectPart = hasTimePrefix ? segments[1] : match[2].trim();
    const tailPart = hasTimePrefix ? segments.slice(2).join(' | ') : match[3].trim();
    const { label, polarity } = splitLabelPolarity(tailPart);
    // 拆 subject 里的 "A → B"（兼容 →/->/＞ 等箭头与"对/与"连接词）。
    const subjectRaw = subjectPart.trim();
    const arrowMatch = subjectRaw.match(/^(.+?)\s*(?:→|->|＞|对|与)\s*(.+)$/);
    if (!arrowMatch) continue;
    const source = arrowMatch[1].trim();
    const subject = arrowMatch[2].trim();
    if (!source || !subject || !label) continue;
    impressions.push({ source, subject, label, polarity });
  }
  return selectPhoneArchiveImpressions(impressions);
}


