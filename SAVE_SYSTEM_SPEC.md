# IslandMemoryDB 表格化存档方案

## Context

当前项目已经有 `statusData`、`summaryStore`、手机消息、剧情库和副 API 分析任务。旧方案把 `SummaryStore` 视为摘要主链，再在旁边增量挂 `MemoryStore`，这个方向不够彻底。

更正后的目标是：**把 summary 集成进 IslandMemoryDB，让 MemoryDB 成为长期记忆的主存储，summary 只是其中一种压缩视图。**

也就是说，不再把记忆理解成“一段段摘要文本”，而是让副 API 和解析器持续填写结构化表格。Prompt 构建时按当前场景检索相关表格行，再临时渲染成上下文。

---

## 一、核心结论

### 旧结论需要废弃

旧结论：

- `episodeLog` 与 `SummaryStore` 重复，所以不需要。
- `facts` 与 `KeyFact` 重复，所以只增强 KeyFact。
- `SummaryStore` 保留不变，只裁剪注入量。

这些判断过于保守。真正应该做的是：

1. `episodeLog` 不删除，而是升级成 `events` 表。
2. `facts` 不依附 `KeyFact`，而是成为 `facts` 表。
3. `minor / major / global summary` 不再是外置主结构，而是进入 `summaries` 表。
4. `SummaryStore.keyFacts` 后续应迁移为 MemoryDB 的结构化表行。
5. `summary` 只负责压缩旧表行和旧对话，不负责承载全部长期记忆。

### 新结论

**IslandMemoryDB 是表格化主存储。**

`summary`、`facts`、`events`、`relations`、`tasks`、`phoneMessages` 等都属于 MemoryDB 的表。系统每轮不是只生成一段摘要，而是把可稳定复用的信息填入对应表格。

---

## 二、总体架构

```text
IslandMemoryDB
├─ entities          角色、玩家、地点、组织等实体
├─ events            已发生事件与剧情节点
├─ facts             稳定事实
├─ relations         角色关系与关系标签
├─ impressions       角色对玩家的印象
├─ tasks             承诺、待办、约定、未完成事项
├─ secrets           秘密、知情范围、泄露状态
├─ items             物品归属、位置、状态
├─ locations         地点状态与地点相关记忆
├─ phoneMessages     手机消息索引
└─ summaries         minor / major / global 压缩视图
```

`statusData` 仍然保留，负责当前状态快照，例如当前时间、地点、好感度、主线事件进度。MemoryDB 负责长期可检索记忆。

---

## 三、表结构草案

新建 `memory/types.ts`，核心类型如下。

```typescript
export type MemorySourceType =
  | 'turn'
  | 'summary'
  | 'progress'
  | 'phone'
  | 'scene-presence'
  | 'manual'
  | 'migration';

export type MemoryConfidence = 'low' | 'medium' | 'high' | 'certain';

export type MemoryBaseRow = {
  id: string;
  sourceType: MemorySourceType;
  sourceId?: string;
  sourceRange?: [number, number];
  confidence: MemoryConfidence;
  importance: number; // 1-5
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  lastSeenAt?: string;
  active: boolean;
  supersededBy?: string;
};
```

### entities

```typescript
export type MemoryEntity = MemoryBaseRow & {
  kind: 'character' | 'player' | 'location' | 'organization' | 'concept';
  entityId: string;
  name: string;
  aliases: string[];
};
```

### events

```typescript
export type MemoryEvent = MemoryBaseRow & {
  title: string;
  content: string;
  time?: string;
  location?: string;
  participants: string[];
  relatedMainEventId?: string;
  outcome?: string;
};
```

### facts

```typescript
export type MemoryFact = MemoryBaseRow & {
  category: 'profile' | 'event' | 'location' | 'item' | 'relation' | 'rule' | 'other';
  subject: string;
  content: string;
  relatedEntityIds: string[];
};
```

### relations

```typescript
export type MemoryRelation = MemoryBaseRow & {
  fromEntityId: string;
  toEntityId: string;
  label: string;
  stage?: string;
  affinity?: number;
  exclusiveGroup?: string;
  reason?: string;
};
```

### impressions

```typescript
export type MemoryImpression = MemoryBaseRow & {
  targetId: string;
  label: string;
  polarity: -1 | 0 | 1;
  weight: number; // -5 到 +5
  reason: string;
};
```

### tasks

```typescript
export type MemoryTaskStatus = 'pending' | 'done' | 'expired' | 'archived';

export type MemoryTask = MemoryBaseRow & {
  ownerId?: string;
  targetId?: string;
  content: string;
  trigger?: string;
  deadline?: string;
  status: MemoryTaskStatus;
  resolvedAt?: string;
};
```

### secrets

```typescript
export type MemorySecret = MemoryBaseRow & {
  subject: string;
  content: string;
  knownBy: string[];
  hiddenFrom: string[];
  risk: 'low' | 'medium' | 'high';
  revealed: boolean;
};
```

### items

```typescript
export type MemoryItem = MemoryBaseRow & {
  name: string;
  ownerId?: string;
  holderId?: string;
  location?: string;
  state?: string;
};
```

### phoneMessages

手机正文仍然可以保留在现有 `phoneMessages.threads` 中。MemoryDB 里只放可检索索引，避免重复塞完整聊天记录。

```typescript
export type MemoryPhoneMessage = MemoryBaseRow & {
  targetId: string;
  role: 'user' | 'assistant';
  messageId: string;
  textPreview: string;
  time?: string;
  linkedEventId?: string;
};
```

### summaries

summary 集成到 MemoryDB，作为压缩视图，而不是外部主存储。

```typescript
export type MemorySummaryLevel = 'minor' | 'major' | 'global';

export type MemorySummary = MemoryBaseRow & {
  level: MemorySummaryLevel;
  range: [number, number];
  text: string;
  coveredRowIds: string[];
  coveredSummaryIds: string[];
};
```

### MemoryDB

```typescript
export type IslandMemoryDB = {
  version: 1;
  entities: MemoryEntity[];
  events: MemoryEvent[];
  facts: MemoryFact[];
  relations: MemoryRelation[];
  impressions: MemoryImpression[];
  tasks: MemoryTask[];
  secrets: MemorySecret[];
  items: MemoryItem[];
  phoneMessages: MemoryPhoneMessage[];
  summaries: MemorySummary[];
  indexes: {
    byEntityId: Record<string, string[]>;
    byTag: Record<string, string[]>;
    bySourceId: Record<string, string[]>;
  };
};
```

---

## 四、summary 如何集成

现有 `SummaryStore`：

```typescript
{
  global,
  major,
  minor,
  keyFacts,
  lastSummarizedIndex
}
```

迁移后：

```text
SummaryStore.global        -> memoryDB.summaries[level=global]
SummaryStore.major[]       -> memoryDB.summaries[level=major]
SummaryStore.minor[]       -> memoryDB.summaries[level=minor]
SummaryStore.keyFacts[]    -> memoryDB.facts / tasks / secrets / relations / items
lastSummarizedIndex        -> memoryDB 元信息或 summary 游标
```

小摘要不再只是生成 `text`，而是一次“填表”：

1. 生成 `MemorySummary(level=minor)`。
2. 从同一轮结果提取 `events / facts / relations / impressions / tasks / secrets / items`。
3. 所有新行记录 `sourceType='summary'` 和 `sourceId=minorSummary.id`。
4. 大摘要和全局摘要只压缩 summary 行与高价值 memory 行，不覆盖原始结构化表。

---

## 五、写入时机

| 数据表 | 写入时机 | 来源 |
|---|---|---|
| `events` | 主回复完成后、小摘要生成时 | progress 分析、summary 提取 |
| `facts` | 小摘要生成时 | 旧 KeyFact 提取升级 |
| `relations` | 小摘要生成时、好感变化时 | summary 提取、progress |
| `impressions` | 小摘要生成时 | summary 提取 |
| `tasks` | 玩家承诺、任务完成、summary 提取时 | phone directive、state_delta、summary |
| `secrets` | 小摘要生成时 | summary 提取 |
| `items` | 物品出现、归属变化时 | summary 提取、progress |
| `phoneMessages` | 手机消息追加时 | phone thread commit |
| `summaries` | minor / major / global 摘要生成时 | summary run |

重要原则：**只把已解析、已提交、可信的结果写入 MemoryDB。不要把副 API 原始 raw 直接存成记忆。**

---

## 六、检索与注入策略

Prompt 构建前执行一次 retrieval：

```text
当前用户输入
+ 当前时间/地点
+ 当前主线事件
+ 当前在场角色
+ 最近手机消息
=> 查询 MemoryDB
=> 生成本轮 memory context
```

### 注入分层

1. **当前场景强相关**
   - 在场角色相关 `relations / impressions / tasks / secrets`
   - 当前地点相关 `events / facts / locations`
   - 当前主线事件相关 `events / summaries`

2. **稳定事实**
   - 高 importance 且 active 的 `facts / secrets / tasks`
   - 不被 `supersededBy` 覆盖

3. **压缩摘要**
   - 最新 global
   - 与当前事件或角色相关的 major
   - 必要时补最近 minor

### 渲染示例

```text
[当前相关记忆]
- 事件：英梨梨在美术教室承认自己就是柏木英理，User承诺不会公开。
- 秘密：英梨梨的柏木英理身份；已知者：User、英梨梨；未公开。
- 关系：User -> 英梨梨：创作伙伴候补，理由：共同处理社团企划。
- 印象：英梨梨认为 User 守口如瓶(+2)，但偶尔说话轻浮(-1)。
- 待办：User 答应下周一请英梨梨吃蛋包饭，状态 pending。

[压缩摘要]
- major：过去几轮围绕社团企划、英梨梨身份暴露和玩家承诺展开。
```

---

## 七、去重与覆盖规则

### 通用规则

1. 同表同主体同内容：视为重复，只更新 `lastSeenAt`。
2. 同表同主体同类别但内容冲突：旧行设置 `supersededBy`。
3. `active=false` 的行默认不参与 prompt 注入。
4. `importance>=4` 的行不会被普通低置信度行覆盖。
5. `confidence='certain'` 的确定性状态优先于 LLM 提取结果。

### 表级规则

- `relations`：同一 `exclusiveGroup` 只保留最新 active 行。
- `tasks`：pending 任务被 done/expired 覆盖，但保留历史。
- `secrets`：`knownBy / hiddenFrom / revealed` 走状态更新，不直接新增重复秘密。
- `phoneMessages`：按 `messageId` 去重。
- `summaries`：只压缩，不覆盖结构化事实。

---

## 八、与现有代码的落点

### 新增文件

- `memory/types.ts`：表结构类型
- `memory/store.ts`：默认值、反序列化、迁移
- `memory/upsert.ts`：去重、覆盖、写入规则
- `memory/retrieve.ts`：检索和评分
- `memory/render.ts`：渲染成 prompt context
- `memory/migrate.ts`：从旧 `SummaryStore` 迁移

### 修改文件

- `types.ts`
  - `SavePayload` 或存档结构增加 `memoryDB`
  - 保留 `summaryStore` 兼容旧存档，后续可降级为迁移来源

- `summary/types.ts`
  - 短期保留现有类型
  - 后续 `SummaryStore` 可逐步变成兼容层

- `summary/run.ts`
  - minor 生成后写入 `memoryDB.summaries`
  - keyFacts 解析结果改为分流写入具体表
  - major/global 生成后写入 `memoryDB.summaries`

- `actions/index.ts`
  - 已集中化的 `commitProgressAnalysis`
  - 已集中化的 `commitPhoneDirectiveAnalysis`
  - 已集中化的 `commitScenePresenceAnalysis`
  - 已集中化的 `commitScenePhoneMessageAnalysis`
  - 这些 commit 点后续是写入 MemoryDB 的最佳入口

- `message-format.ts`
  - `buildPrompt` 从直接拼 `summaryStore` 改为拼 `renderMemoryContext(...)`
  - 保留 statusData 当前状态注入

---

## 九、实现优先级

### P0：建立表结构和迁移壳

1. 新增 `IslandMemoryDB` 类型和默认值。
2. 存档结构增加 `memoryDB?: IslandMemoryDB`。
3. 写 `migrateSummaryStoreToMemoryDB(...)`。
4. 暂时保持 prompt 仍读旧 summary，先保证存档兼容。

### P1：summary 入表

1. minor / major / global 摘要写入 `memoryDB.summaries`。
2. `keyFacts` 分流写入 `facts / tasks / secrets / relations / items`。
3. 建立基础 upsert 和 supersede 规则。

### P2：检索注入

1. 实现 `retrieveRelevantMemory(...)`。
2. `buildPrompt` 注入 MemoryDB 检索结果。
3. 摘要注入从“全量拼接”改为“相关 summaries + 高价值 rows”。

### P3：副 API commit 写表

1. progress commit 写 `events / relations`。
2. phone directive commit 写 `tasks / phoneMessages`。
3. phone scene extract commit 写 `phoneMessages / events`。
4. scene presence 只作为本轮检索条件，不直接写长期记忆，除非有明确地点/事件证据。

---

## 十、验证方式

1. 旧存档迁移后不丢失 `global / major / minor / keyFacts`。
2. 连跑 5 轮对话，MemoryDB 表行稳定增长，不出现大量重复。
3. 同一事实重复出现时只更新 `lastSeenAt`，不刷屏新增。
4. 冲突事实能正确 supersede。
5. Prompt 注入长度下降，同时仍能引用关键承诺、秘密和关系变化。
6. 手机消息不会被重复索引。
7. 中文文档和存档内容保持 UTF-8，不出现乱码。

---

## 十一、关键原则

1. **MemoryDB 是主存储，summary 是表格中的压缩视图。**
2. **先填表，再检索，再渲染 prompt。**
3. **不要把 raw LLM 输出当记忆，只保存 parse/commit 后的结构化结果。**
4. **statusData 管当前状态，MemoryDB 管长期可检索历史。**
5. **summary 不再承担全部长期记忆，只承担压缩和索引辅助。**
