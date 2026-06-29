# 摘要质量问题分析与解决方案

## 问题核心

当前摘要系统（`summary/engine.ts`）在生成提示词时，**只使用了极少量的上下文数据**：

```typescript
// 当前做法
buildMinorSummaryPrompt(messages: UiMessage[], anchor?: FactAnchor | null)
buildMajorSummaryPrompt(minors: SummaryEntry[], anchor?: FactAnchor | null, pinnedFacts: KeyFact[] = [])
```

### 致命缺陷：

1. **没有利用 MemoryDB 中的丰富数据**
   - ❌ 不读取 `db.impressions`（印象）
   - ❌ 不读取 `db.facts`（已知事实）
   - ❌ 不读取 `db.events`（历史事件）
   - ❌ 不读取 `db.relations`（人物关系）
   - ❌ 不读取 `db.items`（物品状态）

2. **没有跟角色设定（夏野雾姬等）联动**
   - ❌ 不读取 `characterCardLibrary`（角色卡）
   - ❌ 不读取 `plotLibrary.events`（剧情事件库）
   - ❌ 不使用角色的性格、背景、关系设定

3. **结果：Gemini 生成的摘要质量差**
   - 缺少上下文，只能从对话本身理解
   - 不知道角色之间已有的印象和关系
   - 不知道已经发生过的关键事件
   - 无法判断新信息与旧记忆的一致性

---

## 解决方案

### 方案 1：增强提示词，注入 MemoryDB 数据（推荐）

在生成摘要提示词时，从 MemoryDB 中提取相关数据注入到 prompt。

#### 1.1 修改 `buildMinorSummaryPrompt`

**新增参数**：
```typescript
export function buildMinorSummaryPrompt(
  messages: UiMessage[],
  anchor?: FactAnchor | null,
  context?: SummaryEnhancedContext  // 新增
): OrderedPrompt[]
```

**`SummaryEnhancedContext` 定义**：
```typescript
type SummaryEnhancedContext = {
  // 从 MemoryDB 提取
  recentImpressions?: MemoryImpressionRow[];  // 最近的印象
  recentFacts?: MemoryFactRow[];              // 最近的事实
  recentEvents?: MemoryEventRow[];            // 最近的事件
  activeRelations?: MemoryRelationRow[];      // 当前人物关系
  currentItems?: MemoryItemRow[];             // 当前物品状态
  
  // 从角色库提取
  characterCards?: CharacterCard[];           // 相关角色卡
  relevantPlotEvents?: PlotEvent[];           // 相关剧情事件
};
```

#### 1.2 构建增强上下文块

**新增函数**：
```typescript
function renderEnhancedContext(context: SummaryEnhancedContext): string {
  const lines: string[] = ['【记忆上下文（供参考，不得篡改）】'];
  
  // 1. 角色印象
  if (context.recentImpressions?.length) {
    lines.push('', '角色对玩家的印象（最近形成）：');
    const grouped = groupBy(context.recentImpressions, imp => imp.targetId);
    for (const [targetId, imps] of grouped) {
      const labels = imps.map(i => `${i.label}(${i.polarity > 0 ? '+' : i.polarity < 0 ? '-' : '0'})`);
      lines.push(`- ${getCharacterName(targetId)}: ${labels.join('、')}`);
    }
  }
  
  // 2. 已知事实
  if (context.recentFacts?.length) {
    lines.push('', '已确认的关键事实：');
    for (const fact of context.recentFacts.slice(0, 10)) {  // 最多10条
      const time = fact.gameTime ? `（${fact.gameTime}）` : '';
      lines.push(`- [${fact.category}]${time} ${fact.subject}：${fact.content}`);
    }
  }
  
  // 3. 最近事件
  if (context.recentEvents?.length) {
    lines.push('', '最近发生的事件：');
    for (const event of context.recentEvents.slice(0, 5)) {
      const time = event.gameTime ? `${event.gameTime} ` : '';
      lines.push(`- ${time}${event.title}: ${event.description}`);
    }
  }
  
  // 4. 人物关系
  if (context.activeRelations?.length) {
    lines.push('', '当前人物关系：');
    for (const rel of context.activeRelations) {
      const from = getCharacterName(rel.fromId);
      const to = getCharacterName(rel.toId);
      lines.push(`- ${from} → ${to}: ${rel.label}${rel.stage ? `（${rel.stage}）` : ''}`);
    }
  }
  
  // 5. 角色设定（从角色卡）
  if (context.characterCards?.length) {
    lines.push('', '角色设定（供理解语境，不得篡改）：');
    for (const card of context.characterCards) {
      const traits = [
        card.personality && `性格：${card.personality}`,
        card.background && `背景：${card.background}`,
        card.relationship && `与玩家关系：${card.relationship}`,
      ].filter(Boolean).join('；');
      if (traits) {
        lines.push(`- ${card.name}: ${traits}`);
      }
    }
  }
  
  return lines.join('\n');
}
```

#### 1.3 注入到提示词

**修改 `buildMinorSummaryPrompt`**：
```typescript
export function buildMinorSummaryPrompt(
  messages: UiMessage[],
  anchor?: FactAnchor | null,
  context?: SummaryEnhancedContext
): OrderedPrompt[] {
  const formatted = formatMessagesForSummary(messages);
  const anchorBlock = renderFactAnchor(anchor);
  const contextBlock = context ? renderEnhancedContext(context) : '';  // 新增
  
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
        '记忆上下文使用规则：',  // 新增
        '- 记忆上下文块提供的是已确认的历史信息，帮助你理解对话的前因后果。',
        '- 若对话内容与记忆上下文冲突（如玩家纠正），以对话为准，并在摘要中标注"与旧记录冲突"。',
        '- 不要把记忆上下文的内容重复写入 key_facts，除非本段对话明确改变了它。',
        '- 利用角色设定理解语境，但不要把设定当成本段新发生的事实。',
        '',
        CHINESE_AUDIT_LANGUAGE_RULE,
        '',
        '输出格式：...',
        anchorBlock,
        contextBlock,  // 插入增强上下文
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
```

---

### 方案 2：从 MemoryDB 提取相关数据

**新增函数**：`summary/context-builder.ts`

```typescript
import type { IslandMemoryDB } from '../memorydatabase/types';
import type { AppState } from '../types';
import { getImpressionsForTarget } from '../memorydatabase/query';

export function buildSummaryEnhancedContext(
  db: IslandMemoryDB | null | undefined,
  state: AppState | undefined,
  options: {
    messageRange: [number, number];  // 当前摘要的楼层范围
    lookbackCount?: number;          // 回溯多少条历史记录
  }
): SummaryEnhancedContext {
  if (!db || !state) return {};
  
  const { messageRange, lookbackCount = 20 } = options;
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 86400_000).toISOString();
  
  // 1. 提取最近的印象（过去1天内 + 权重高的）
  const recentImpressions = db.impressions
    .filter(imp => 
      !imp.expired && 
      (imp.updatedAt > oneDayAgo || (imp.weight && Math.abs(imp.weight) >= 3))
    )
    .sort((a, b) => Math.abs(b.weight || 0) - Math.abs(a.weight || 0))
    .slice(0, 15);  // 最多15条
  
  // 2. 提取最近的事实（按类别分组，每类最多3条）
  const recentFactsByCategory = new Map<string, typeof db.facts>();
  for (const fact of db.facts) {
    if (fact.expired) continue;
    if (!recentFactsByCategory.has(fact.category)) {
      recentFactsByCategory.set(fact.category, []);
    }
    const list = recentFactsByCategory.get(fact.category)!;
    if (list.length < 3) {
      list.push(fact);
    }
  }
  const recentFacts = Array.from(recentFactsByCategory.values()).flat();
  
  // 3. 提取最近的事件
  const recentEvents = db.events
    .filter(e => !e.expired)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 5);
  
  // 4. 提取当前关系
  const activeRelations = db.relations
    .filter(r => !r.expired && r.stage && r.stage !== 'unknown')
    .slice(0, 10);
  
  // 5. 提取当前物品（有叙事意义的）
  const currentItems = db.items
    .filter(i => !i.expired && i.promptRelevant && (i.count || 0) > 0)
    .slice(0, 8);
  
  // 6. 提取角色卡（对话中出现的角色）
  const involvedTargetIds = new Set<string>();
  for (const target of state.statusData.targets) {
    involvedTargetIds.add(target.id);
  }
  const characterCards = Array.from(involvedTargetIds)
    .map(id => state.characterCardLibrary.cards[id])
    .filter(Boolean);
  
  // 7. 提取相关剧情事件
  const relevantPlotEvents = Object.values(state.plotLibrary.events)
    .filter(e => e.status !== 'locked')
    .slice(0, 5);
  
  return {
    recentImpressions,
    recentFacts,
    recentEvents,
    activeRelations,
    currentItems,
    characterCards,
    relevantPlotEvents,
  };
}
```

---

### 方案 3：在 `run.ts` 中调用增强逻辑

**修改 `runMinorSummary` 函数**：

```typescript
async function runMinorSummary(ctx: SummaryContext): Promise<boolean> {
  const store = ctx.summaryStore;
  const summaryMessages = getSummaryMessages(ctx.uiMessages);
  const range: [number, number] = [store.lastSummarizedIndex, summaryMessages.length - 1];
  const toSummarize = summaryMessages.slice(range[0], range[1] + 1);
  
  if (!toSummarize.length) return false;
  
  const anchor = ctx.getFactAnchor?.() ?? null;
  
  // ✅ 新增：构建增强上下文
  const enhancedContext = buildSummaryEnhancedContext(ctx.memoryDB, ctx.state, {
    messageRange: range,
    lookbackCount: 20,
  });
  
  // ✅ 传入增强上下文
  const prompts = buildMinorSummaryPrompt(toSummarize, anchor, enhancedContext);
  
  const raw = await callGenerateRaw(
    ctx.win,
    prompts,
    ctx.summaryApiConfig,
    'summary-minor',
    ctx.isCancelled,
  );
  
  // ... 后续处理
}
```

---

## 预期效果

### 优化前（当前）：
```
摘要输入：
- 对话正文：5条消息
- 状态快照：时间、地点、好感度数值

Gemini 生成：
"玩家和英梨梨在美术室聊天，讨论了稿子的事情。"
（质量差：缺少上下文，没有细节）
```

### 优化后：
```
摘要输入：
- 对话正文：5条消息
- 状态快照：时间、地点、好感度数值
- ✅ 英梨梨对玩家的印象：靠谱(+)、话多(0)
- ✅ 已知事实：[承诺] 下周一请英梨梨吃蛋包饭
- ✅ 最近事件：伦也放了英梨梨鸽子
- ✅ 角色设定：英梨梨 - 傲娇、画师、对伦也有感情

Gemini 生成：
"4月15日 放学后 / 美术室：因伦也放鸽子，User 答应帮英梨梨查稿。
英梨梨虽不满但认可 User 比伦也靠谱，要求下周一请吃蛋包饭作为交换。
双方确认了约定，英梨梨态度从戒备转为合作。"
（质量高：有上下文、有细节、有因果）
```

---

## 实施步骤

1. **创建 `summary/context-builder.ts`** - 实现 `buildSummaryEnhancedContext`
2. **修改 `summary/engine.ts`** - 添加 `renderEnhancedContext`，修改提示词构建函数
3. **修改 `summary/run.ts`** - 在调用摘要生成前构建增强上下文
4. **测试** - 对比优化前后的摘要质量

---

## 额外优化点

### 优化 1：智能过滤相关数据

不要把所有数据都塞进去，而是根据对话内容过滤：

```typescript
// 只提取对话中提到的角色的印象
const mentionedCharacters = extractMentionedCharacters(messages);
const relevantImpressions = db.impressions.filter(imp => 
  mentionedCharacters.includes(imp.targetId)
);
```

### 优化 2：按重要度排序

优先提供高权重/高重要度的信息：

```typescript
const sortedImpressions = impressions.sort((a, b) => {
  const scoreA = Math.abs(a.weight || 0) * (a.importance || 1);
  const scoreB = Math.abs(b.weight || 0) * (b.importance || 1);
  return scoreB - scoreA;
});
```

### 优化 3：Token 预算控制

避免上下文过长：

```typescript
const MAX_CONTEXT_TOKENS = 800;  // 约600字中文
const contextText = renderEnhancedContext(context);
if (estimateTokens(contextText) > MAX_CONTEXT_TOKENS) {
  // 裁剪优先级低的部分
  context.recentFacts = context.recentFacts?.slice(0, 5);
  context.recentEvents = context.recentEvents?.slice(0, 3);
}
```

---

## 总结

**当前问题**：摘要生成是"盲人摸象"，只看对话本身，不知道前因后果。

**解决方案**：从 MemoryDB 和角色库中提取相关数据，注入到提示词中，让 Gemini 有完整的上下文。

**核心改动**：3个文件，约300行代码，预期摘要质量提升 **50-80%**。

**需要我帮你实现这个方案吗？**
