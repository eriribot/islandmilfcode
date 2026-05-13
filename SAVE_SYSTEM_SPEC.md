        1 # IslandMemoryDB 方案评估与优化计划
        2
        3 ## Context
        4
        5 当前项目每轮 prompt 注入约 5,500-13,000 tokens，存在三个核心问题：
        6 1. **全量注入** — 5个角色的关系指导全部注入，不管是否在场（浪费 1500-3000 tokens）
        7 2. **摘要无筛选** — global + 所有 major + 所有 minor 全部拼接注入
        8 3. **缺少结构化印象** — AI 只能从自由文本"回忆"角色对玩家的态度，容易幻觉
        9
       10 用户提出的 IslandMemoryDB 方案方向正确，但部分模块与现有系统重复。本计划给出"复用现有 + 增量增强"的优化
          路径。
       11
       12 ---
       13
       14 ## 一、方案评估
       15
       16 ### 合理的部分
       17
       18 | 模块 | 评价 |
       19 |------|------|
       20 | `facts` | 方向对，但现有 KeyFact 已实现 80%。缺的是"锁定不可覆盖"和"按相关性筛选" |
       21 | `relationTags` | **必要且缺失**。现有只有硬编码 stage 文本，没有动态关系描述 |
       22 | `impressionTags` | **必要且缺失**。系统完全没有"角色对玩家的印象"维度 |
       23 | `tasks` | 合理。KeyFact[promise] 只是文本，没有状态机(pending/done/expired) |
       24 | `presence` | **必要**。现有 `isTargetMentioned` 只做文本匹配，太弱 |
       25
       26 ### 冗余/应复用的部分
       27
       28 | 模块 | 问题 |
       29 |------|------|
       30 | `episodeLog` | 与 SummaryStore 三级摘要完全重复，不需要 |
       31 | `facts` 如果独立重建 | 与 KeyFact 重复，应增强而非另起 |
       32
       33 ### 核心结论
       34
       35 **不要新建独立的 IslandMemoryDB 模块**。现有 SummaryStore + StatusData 的存储管道已成熟（SavePayload →
          MVU/localStorage），新增数据挂在同一管道上即可。
       36
       37 ---
       38
       39 ## 二、推荐架构
       40
       41 ```
       42 现有系统增强（不新建独立DB）
       43 ├─ KeyFact (增强)         → 加 locked/priority/relatedTargets 字段
       44 ├─ RelationTag (新增)     → 动态关系标签，互斥覆盖
       45 ├─ ImpressionTag (新增)   → 角色对玩家的印象标签+权重
       46 ├─ TaskMemory (新增)      → 从 KeyFact[promise] 升级，加状态机
       47 ├─ PresenceEngine (新增)  → 基于地点+文本+事件的在场推断
       48 └─ SummaryStore (保留)    → 不变，裁剪注入量即可
       49 ```
       50
       51 ---
       52
       53 ## 三、数据结构
       54
       55 新建文件 `memory/types.ts`：
       56
       57 ```typescript
       58 export type RelationTag = {
       59   id: string;
       60   targetId: string;
       61   label: string;              // "同伴候补"、"创作伙伴"
       62   exclusiveGroup?: string;    // 同组只保留最新
       63   sourceRange: [number, number];
       64   createdAt: string;
       65   superseded?: boolean;
       66 };
       67
       68 export type ImpressionTag = {
       69   id: string;
       70   targetId: string;
       71   label: string;              // "守口如瓶"、"说话轻浮"
       72   weight: number;             // -5 到 +5
       73   sourceRange: [number, number];
       74   createdAt: string;
       75 };
       76
       77 export type TaskMemoryStatus = 'pending' | 'done' | 'expired' | 'archived';
       78
       79 export type TaskMemory = {
       80   id: string;
       81   targetId: string;
       82   content: string;
       83   trigger?: string;
       84   deadline?: string;          // 游戏内时间
       85   status: TaskMemoryStatus;
       86   sourceRange: [number, number];
       87   createdAt: string;
       88   resolvedAt?: string;
       89 };
       90
       91 export type PresenceEntry = {
       92   targetId: string;
       93   reason: 'text_mention' | 'location_match' | 'event_participant' | 'explicit';
       94   confidence: number;         // 0-1
       95 };
       96
       97 export type PresenceState = {
       98   current: PresenceEntry[];
       99   previous: PresenceEntry[];
      100 };
      101
      102 export type MemoryStore = {
      103   relationTags: RelationTag[];
      104   impressionTags: ImpressionTag[];
      105   tasks: TaskMemory[];
      106   presence: PresenceState;
      107 };
      108 ```
      109
      110 KeyFact 增强（修改 `summary/types.ts`）：
      111 ```typescript
      112 export type KeyFact = {
      113   // ...现有字段不变
      114   locked?: boolean;           // 锁定后不被 supersede
      115   priority?: number;          // 1-5，默认3
      116   relatedTargets?: string[];  // 关联角色，用于按在场筛选
      117 };
      118 ```
      119
      120 ---
      121
      122 ## 四、注入策略（核心省 token 点）
      123
      124 ### 优化后的 prompt 注入格式
      125
      126 ```
      127 [在场角色记忆]
      128
      129 [英梨梨] 好感度:45 试探靠近
      130 - 关系：同伴候补
      131 - 印象：守口如瓶(+2)；偶尔说话轻浮(-1)
      132 - 待办：User答应下周一请她吃蛋包饭 [截止:2012-04-22]
      133 - 事实：User知道她的柏木英理身份，未公开泄露
      134
      135 [加藤惠] 好感度:32 试探靠近
      136 - 关系：普通同学
      137 - 印象：还算有礼貌(+1)
      138
      139 [不在场角色概况]
      140 - 霞之丘诗羽：好感度15，关系=观察样本
      141 - 波岛出海：好感度8
      142 - 冰堂美智留：好感度12
      143 ```
      144
      145 ### 注入规则
      146
      147 1. **在场角色**（由 PresenceEngine 判定）：注入完整 stage reaction + 结构化标签
      148 2. **不在场角色**：只输出一行（名字+好感度+关系标签）
      149 3. **KeyFact**：按 priority 降序，只注入 top-10 且 relatedTargets 包含在场角色的
      150 4. **摘要**：只注入 global + 最新 1 条 major（minor 不注入，信息已被 major 吸收）
      151
      152 ---
      153
      154 ## 五、Token 预算对比
      155
      156 | 模块 | 优化前 | 优化后 | 节省 |
      157 |------|--------|--------|------|
      158 | 关系指导（5角色全量） | 2000-4000 | 400-1200（1-2在场） | ~60% |
      159 | 摘要（全量） | 1500-4000 | 400-800（global+1 major） | ~70% |
      160 | KeyFact（全量） | 300-800 | 200-400（top-10筛选） | ~40% |
      161 | 结构化标签（新增） | 0 | 200-400 | +200-400 |
      162 | 不在场角色摘要（新增） | 0 | 100-200 | +100-200 |
      163 | **总计** | **6400-15000** | **4200-10000** | **~35%** |
      164
      165 ---
      166
      167 ## 六、读写时机
      168
      169 | 数据 | 写入时机 | 写入方式 |
      170 |------|---------|---------|
      171 | RelationTag | 小摘要生成时 | 扩展摘要 prompt，解析 `<relation_tags>` |
      172 | ImpressionTag | 小摘要生成时 | 扩展摘要 prompt，解析 `<impression_tags>` |
      173 | TaskMemory | 小摘要时 + state_delta 解析 | KeyFact[promise]自动升级；AI 通过 `任务完成:xxx` 标记 |
      174 | PresenceState | 每轮生成前（同步） | 确定性算法：location匹配 + 文本提及 + 剧情卡参与者 |
      175 | KeyFact 增强字段 | 小摘要时 | 扩展提取逻辑 |
      176
      177 ---
      178
      179 ## 七、实现优先级
      180
      181 ### P0 — 立即收益，改动最小（预计省 2000-3000 tokens/轮）
      182
      183 1. **PresenceEngine + 按在场筛选注入**
      184    - 修改 `message-format.ts` 的 `buildRelationshipGuidanceList`
      185    - 在场角色：完整指导；不在场：一行摘要
      186    - 文件：`message-format.ts`
      187
      188 2. **摘要注入裁剪**
      189    - `buildSummaryContextInline` 改为 global + 最新1条 major
      190    - 文件：`message-format.ts`
      191
      192 ### P1 — 中等收益，新增数据结构
      193
      194 3. **MemoryStore 数据结构 + 存储管道**
      195    - 新建 `memory/types.ts`
      196    - 挂载到 SavePayload（与 summaryStore 同级）
      197    - 文件：新建 `memory/types.ts`, 修改 `types.ts`, `state/saves.ts`
      198
      199 4. **ImpressionTag + RelationTag 提取**
      200    - 扩展 `buildMinorSummaryPrompt` 增加提取指令
      201    - 新增解析逻辑
      202    - 文件：`summary/engine.ts`, `summary/run.ts`, 新建 `memory/engine.ts`
      203
      204 5. **TaskMemory 状态机**
      205    - 从 KeyFact[promise] 自动迁移
      206    - state_delta 增加 `任务完成:xxx` 解析
      207    - 文件：`message-format.ts`, `memory/engine.ts`
      208
      209 ### P2 — 长期优化
      210
      211 6. **KeyFact 增强（priority + relatedTargets + 限量注入）**
      212 7. **PresenceEngine 高级推断（location + 剧情卡参与者）**
      213
      214 ---
      215
      216 ## 八、关键设计决策
      217
      218 1. **在场判断必须是确定性的** — 不让 AI 判断谁在场，用 location + 文本提及 + 剧情卡做确定性推断
      219 2. **硬编码关系指导保留** — relationship.ts 的 stage reaction 是精调的行为锚点，动态标签是补充层不是替
          代层
      220 3. **提取搭载副 API** — 不额外调 API，在已有的小摘要流程中扩展 prompt 和解析
      221 4. **向后兼容** — MemoryStore 全部 optional，旧存档走 `createDefaultMemoryStore()` 兜底
      222
      223 ---
      224
      225 ## 九、验证方式
      226
      227 1. 对比优化前后同一场景的 prompt 长度（字符数/token 数）
      228 2. 跑 3-5 轮对话，观察 AI 是否仍能正确引用不在场角色的信息（通过 KeyFact）
      229 3. 检查在场判断准确率：手动标注 10 轮对话的在场角色，对比引擎输出
      230 4. 观察 ImpressionTag 提取质量：是否能从对话中正确提取印象变化
      231
      232 ---
      233
      234 ## 关键文件清单
      235
      236 - `message-format.ts` — prompt 构建主逻辑，P0 改动集中在此
      237 - `summary/engine.ts` — 摘要 prompt 构建，P1 扩展提取指令
      238 - `summary/run.ts` — 摘要执行+解析，P1 增加标签解析
      239 - `summary/types.ts` — KeyFact 类型增强
      240 - `types.ts` — AppState/StatusData 类型
      241 - `relationship.ts` — 关系指导（保留，不大改）
      242 - 新建 `memory/types.ts` — MemoryStore 数据结构
      243 - 新建 `memory/engine.ts` — 标签提取+在场推断逻辑
  ⎿  3 PostToolUse hooks ran

                                                                                        09:05 PM claude-opus-4-7
● 计划已写好。核心结论：

  不要另建独立的 IslandMemoryDB — 你的 6 个模块中，episodeLog 与现有 SummaryStore 重复，facts 与 KeyFact 重复。其余 4
  个（relationTags、impressionTags、tasks、presence）确实是缺失的，应作为增量挂载到现有存储管道上。

  最大的省 token 收益来自 P0（改动最小）：

- 在场角色筛选注入（不在场的只给一行摘要）→ 省 60% 关系指导 token
- 摘要裁剪（只注入 global + 最新 major）→ 省 70% 摘要 token

  结构化标签（印象/关系/任务）是 P1，收益在于减少幻觉 — AI 看到明确的 守口如瓶(+2) 比从 3000 字摘要中"回忆"稳定得多。
