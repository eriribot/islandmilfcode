# shujuku v2 兼容方案

> 状态：接入中；2026-08-06 已完成第 1 批“类型合同 + 消息 codec 往返”和第 2 批“旧记忆保护 + archive compatibility 持久化”，尚未接入 shujuku 运行时、生成链或数据库写入。  
> 目标：让安装 shujuku 的玩家和未安装 shujuku 的玩家都能正常玩，同时避免旧 Island 记忆库和 shujuku 同时抢着讲同一段剧情。  
> 当前基线：Island 仓库提交 `48692254ddf4baaa719d4445d25e5fbdf63349c1`。  
> 证据标记：`[已检查]` 表示已读本地源码或参考合同；`[待实机]` 表示必须在真实酒馆环境确认；`[假设]` 表示本方案暂定的接口或字段名。

## 0. 先说结论

这次兼容不做“两个记忆库一起往提示词里塞内容”。那样看起来两边都保留了，实际会出现重复、冲突、回档串线和同一事实被改成两个版本的问题。

最终只保留两条清晰路线：

- **Island 路线**：不开 shujuku，Island 自己管理剧情记忆、摘要和召回。没有插件的人继续按现有方式玩。
- **shujuku 路线**：打开开关后，shujuku 管理剧情记忆、规划和表格召回；Island 只管理游戏规则和硬状态。Island 的剧情记忆不再进入下一轮提示词。

切换不是即时拔线，而是在一个完整回合结束后进行。旧存档默认留在 Island 路线；经过观察期并完成一次有 hash 的交接后，才允许把 shujuku 设为该存档的唯一剧情记忆来源。

## 1. 已锁定的 v2 基线

### 1.1 宿主只有真实 `#0`

`#0` 是导入角色卡后真实聊天中的 `chat[0]`，不是另造的测试宿主，也不是隐藏的楼层。v2 永远满足：

- `chat.length === 1`；
- `getLastMessageId() === 0`；
- 不创建真实 `#1/#2`；
- 不使用 `is_hidden`、`is_system` 或 CSS 隐藏桥接楼层来假装同层；
- UI、逻辑 user/assistant、qrf、正文和数据库快照都保存在 `#0` 的状态变量中；
- qrf、正文和 storageFrame 分别绑定到具体逻辑消息/swipe，不能只挂在 `#0` 当前顶层字段上；
- 刷新、导出再导入和换档后，仍由 `#0` 恢复完整逻辑时间线。

生成时才在 shujuku 运行时里构造临时虚拟时间线。该时间线用于让 shujuku 原生规划、世界书扫描和表格更新看到完整上下文；窗口关闭后逐项恢复宿主 API，不把临时楼层写回酒馆。

### 1.2 明确废弃的 v1 做法

旧的“创建真实 user/assistant 楼层，再用 CSS 隐藏”的 v1 方案不再是实现依据。`same-layer-bridge` skill 的 v1 协议仍可用来理解 qrf、正文和 storageFrame 必须分开取证，但不能照搬其 `#1/#2` 楼层结构。

不要把下面这些做法带回 v2：

- 真实 user/assistant 桥接楼层；
- 用楼层相邻关系代替稳定的逻辑消息 ID；
- 生成完再删楼层；
- 让 `chat[0]` 同时承载代码、qrf、正文和数据库帧，伪装成一个复合消息；
- 只看到 assistant 文本或表格变化，就宣称规划或数据库提交成功。

### 1.3 三条独立证据

每一轮都要分别留下以下证据：

| 证据 | 来源 | 能证明什么 | 不能替代什么 |
| --- | --- | --- | --- |
| qrf / `plannedText` | 当前逻辑 user 对应的 `pluginData` | shujuku 规划已经写回本轮输入 | 不能证明正文完成或数据库提交 |
| 正文 | 当前逻辑 assistant 的 `text/rawText` | 本轮可见剧情已经完成 | 不能证明 qrf 或表格已保存 |
| `TavernDB_ACU_IsolatedData.storageFrame` | 当前逻辑 assistant 对应的插件数据及快照 hash | shujuku 结构化提交有落盘证据 | 不能只用运行时表变化代替 |

## 2. 两条数据路线

| 路线 | 开关 | 谁负责剧情记忆 | 谁负责硬状态 | shujuku 行为 | 失败处理 |
| --- | --- | --- | --- | --- | --- |
| Island | 关 | Island `summaryStore + memoryDB`，由 `message-format.ts` 注入 | Island：时间、地点、数值、路线、手机、物品机制、存档 | 调用次数必须为 0 | 继续当前 Island 流程 |
| 观察期 | 测试态 | Island 仍是唯一提示词和发言来源 | Island | shujuku 只做 shadow 记录和对账，关闭自动召回/写回 | shujuku 失败只记影子错误，不影响游玩 |
| shujuku | 开 | shujuku 表格、规划和世界书召回 | Island 硬状态仍是唯一规则来源 | 每轮建立临时虚拟时间线，非流式静默生成，再提交表格 | 插件不可用、隔离失败或 hash 冲突时 fail-closed，阻止正文生成，不自动退回另一条路线 |

观察期不是第三条永久用户路线。它只是交接前的测试窗口。

### 2.1 所有权边界

Island 路线开启 shujuku 后，以下 Island 数据仍然有效：

- 当前故事时间、地点、角色数值和关系数值；
- 路线开关、事件日期闸门和 route flags；
- 手机消息、背包和物品消耗规则；
- 存档、分支、重 roll、回档和导出格式；
- progress/status 的确定性解析和安全过滤。

以下内容在 shujuku 路线不能再由 Island 注入下一轮剧情提示词：

- `memoryDB` 的摘要、facts、events、tasks、secrets、impressions；
- `summaryStore` 的剧情摘要和回忆召回；
- Island 的剧情 recall plan 文本。

这不是把 `progress` 或数值更新一并关掉，而是把“硬状态写入”和“剧情记忆召回”拆成两个出口。shujuku 路线只允许 progress 白名单提交时间、地点、数值、物品、路线和手机等硬状态；facts、events、summary、impressions 等叙事字段不得继续写入 Island 记忆。剧情背景只由 shujuku 提供。

### 2.2 每轮流程

**Island 路线**

```text
输入
  -> Island buildPrompt（含 Island memoryDB/summary）
  -> TavernHelper.generate / generateRaw
  -> 解析正文、progress、状态变化
  -> Island summary/memory 写回
  -> 保存 #0 状态
```

**shujuku 路线**

```text
#0 逻辑输入
  -> 构造临时虚拟时间线（#0 根 + 历史逻辑消息 + 当前虚拟 user）
  -> 暂时替换 shujuku iframe 的 chat/read/write/save API
  -> should_stream=false、should_silence=true 的原生规划
  -> 当前虚拟 user 产生 qrf / plannedText
  -> 原始输入走 user_input，历史和机制走 overrides.chat_history.prompts
  -> 返回正文，追加逻辑 assistant 到 #0 状态
  -> triggerUpdate()，读取 storageFrame 和表快照
  -> 恢复所有 API，按 saveId + branchId 写回 #0
```

关键点：shujuku 的生成包装器在 `should_stream=true` 时可能跳过剧情规划，所以 shujuku 路线强制使用非流式静默请求。

## 3. 路线开关与插件状态

### 3.1 开关存放位置

开关必须按存档保存，而不是沿用现有全局 `deepSeekModeEnabled` 的 localStorage 偏好。DeepSeek 只作为 UI 交互的比喻，不是实现依赖。

建议在存档元数据加入以下字段（名称可在实现时微调）。用户路线和交接阶段分开保存，观察期不是第三条永久路线：

```ts
type NarrativeRoute = 'island' | 'shujuku';
type HandoffPhase = 'none' | 'observing' | 'pending' | 'committed' | 'needs_review' | 'conflict';

type ShujukuCompatibilityState = {
  route: NarrativeRoute;
  handoffPhase: HandoffPhase;
  pluginVersion?: string;
  capabilityHash?: string;
  isolationKey?: string;
  handoffId?: string;
  branchId: string;
  lastTableHash?: string;
};
```

规则：

1. 新存档和旧存档默认 `route: 'island'`。
2. 只能在没有进行中的生成、且当前 assistant 回合已完整提交时切换。
3. `island -> shujuku` 必须经过观察期或明确的旧记忆交接；切换前先备份 Island 存档和 shujuku 表快照。
4. `shujuku -> island` 只在完整回合边界允许。默认恢复最后一个已确认的 Island checkpoint 并创建新 branch；若要保留切换后的剧情，必须先做显式受控回交，不能悄悄合并。
5. route、route history、pluginVersion、isolationKey、handoffId 和 branchId 必须与当前 `saveId` 一起保存和校验；回档到切换前时也要恢复当时路线。stale operation 不能写入另一个存档或分支。
6. 每轮生成前快速复核插件版本和 capability hash，不能只相信存档里上次记录的可用状态。

### 3.2 插件不可用时怎么做

- 开关关：不探测、不调用 shujuku，Island 正常生成。
- 观察期：shujuku 不可用时只记 `shadow_unavailable`，Island 仍正常生成。
- 开关开：缺少运行时、API、隔离码、storageFrame 或恢复失败时停止在 `needs_review`，不生成一段可能已经失去记忆的正文，也不悄悄切回 Island。

观察期的 shadow 记录写入 `compatibility.shadowSnapshot`/适配层诊断日志（或同一 save 的隔离 shadow 表），不进入普通世界书、不进入最终 prompt，也不改变用户可见剧情。只有连续取得完整三证据的回合才计入 20 回合通过数。

## 4. 旧记忆交接

### 4.1 迁移边界

可迁移：

- 未过期、未被 superseded 的摘要；
- 当前仍成立的 facts、events、promises；
- 已向玩家公开且仍有用的关系、物品和阶段结果；
- 有明确来源范围的历史事实。

不迁移：

- `expired`、`superseded` 和回收站行；
- 只有当前硬状态意义、会随回合变化的值（这类值仍由 Island 负责）；
- 没有可靠日期或时间范围的内容。不能为了让表格看起来完整而补“昨天/今天”；
- 未向玩家公开的秘密。秘密只能进入带权限或明确条件的 gated recall，不能直接变成普通世界书条目；
- 无法证明来源的重复摘要。

迁移前先做规范化：固定字段排序、统一换行和空白、保留 `sourceRange`，得到 `sourceHash`。同一行必须有 `runId`、`saveId`、`branchId`、`mappingVersion` 和 `cutoffFloor`。

### 4.2 两张自定义表

一张表无法同时做到“每轮都看见的前情”和“只在关键词出现时召回的细节”，因此拆成两张。

#### `Island旧档前情`

用途：旧库交接后的紧凑前情，作为常驻背景，不放可变当前状态。

建议字段：

| 字段 | 含义 |
| --- | --- |
| `memory_id` | 稳定 ID，跨重试不变 |
| `run_id` / `save_id` / `branch_id` | 存档和分支隔离 |
| `cutoff_floor` | 迁移截止的逻辑回合 |
| `story_time` | 只有来源可靠时才填写 |
| `content` | 一条短而完整的过去事实 |
| `source_range` | Island 原摘要/事实的来源范围 |
| `source_hash` | 规范化内容 hash |
| `mapping_version` | 映射规则版本 |
| `status` | `active` / `expired` / `superseded` |

这张表的 `updateFrequency=0`，关闭 AI 自动填表并设置 `prevent_recursion=true`；正式交接后以常驻世界书背景投影。当前地点、当前数值、背包数量等必须从 Island 硬状态读取，不要复制进这张表。

#### `Island旧档记忆索引`

用途：关键词触发的历史细节，按行拆分，避免每轮把全部旧记录塞进上下文。

建议字段：

| 字段 | 含义 |
| --- | --- |
| `memory_id` | 与前情表或来源表稳定关联 |
| `kind` | `fact` / `event` / `promise` / `secret` / `relationship` |
| `keywords` | 触发词，使用明确的逗号或 JSON 数组格式 |
| `subject` | 角色、地点、物品或事件主体 |
| `content` | 召回时使用的历史描述 |
| `story_time` | 有可靠证据才填 |
| `source_range` | 来源回合范围 |
| `visibility` | `public` / `gated` |
| `source_hash` / `mapping_version` | 交接对账字段 |
| `status` | `active` / `expired` / `superseded` |

同样设置 `updateFrequency=0`、关闭 AI 自动填表并设置 `prevent_recursion=true`，由桥接代码独占写入。`secret + visibility=gated` 不进入普通世界书召回，只有满足条件的适配层才可以查询。

这些限制只作用于两张 Island 旧档桥接表。shujuku 自己用于切换后新剧情的原生表仍按插件规则更新，不能把 `updateFrequency=0` 误用成“整个插件禁止写入”。

### 4.3 写入和恢复

- 增量写入使用 `insertRow`、`updateRow` 或参数化 SQL，并在写入后重新导出表格计算 `tableHash`。
- `importTableAsJson()` 是覆盖式全量替换，只能用于同一存档的完整恢复（例如刷新、读档、导出重导），不能每轮调用。
- 恢复时必须 `persist:false`，避免把运行时恢复误记成新的剧情回合。
- 不直接修改导出的 JSON `content` 数组；按 shujuku API 写入，避免 SQLite/native 两种模式的提交语义分叉。
- 表级逻辑唯一键建议为 `(save_id, branch_id, memory_id)`；交接级逻辑唯一键为 `(handoff_id, memory_id)`。当前 shujuku CRUD 没有可确认的复合唯一约束，桥接层必须先查询，再决定 `insertRow` 或 `updateRow`。

### 4.4 交接单与幂等

每次交接都生成一个可重放的 envelope：

```json
{
  "handoffId": "runId:saveId:branchId:timelineAnchor:cutoffFloor:mappingVersion",
  "runId": "...",
  "saveId": "...",
  "branchId": "...",
  "timelineAnchor": "logical-assistant-id",
  "cutoffFloor": 12,
  "mappingVersion": "island-memory-v2",
  "sourceHash": "sha256:...",
  "tableHash": "sha256:...",
  "status": "pending"
}
```

重试规则固定为：

- 相同 `handoffId` + 相同 `sourceHash`：视为同一提交，重复执行是 no-op；
- 相同 `handoffId` + 不同 `sourceHash`：立即进入 `conflict`，停止并保留原数据，禁止覆盖；
- 没有记录：先写 Island 存档中的 `pending` 交接单，再写 shujuku，核对行数、范围和 hash 后升级为 `committed`；
- 浏览器在中途崩溃：下次启动读取 `pending`，先比较 hash，再决定继续或冲突，不重新盲写。

`sourceHash` 使用固定字段排序、固定换行、排除生成时间戳的规范化载荷；`tableHash` 只覆盖桥接层管理的 `Island旧档前情` 和 `Island旧档记忆索引`，不能被 shujuku 其他原生表的正常变化触发冲突。

## 5. 需要修改的代码位置

以下是实现顺序和职责，不是“看到文件就全部重构”。

| 模块 | 当前检查位置 | 需要做的事 |
| --- | --- | --- |
| 类型合同 | `types.ts:81-112, 572-614, 628-670` | 增加 `NarrativeRoute`、`ShujukuCompatibilityState`、handoff envelope、pluginData、`plannedText`、qrf 和 `TavernDB_ACU_IsolatedData.storageFrame` 的可持久化类型；保留未知扩展的受控容器。不要让插件字段落到 `any` 后失去校验。 |
| 消息存取 | `state/store.ts:260-305, 810-843` | serialize/deserialize 做白名单 round-trip；保留 `plannedText`、`qrf_plot*`、pluginData 和嵌套 storageFrame。`state/store.ts:602-807, 972-1124` 的裁剪、回档、重 roll 要以 `saveId + branchId + sourceRange` 为边界，不能按数组邻接猜。 |
| 旧存档迁移 | `state/saves.ts:853-945, 1125-1199`；`state/save-migration.ts:259-293, 549-705` | 修复“空的 memoryDB 盖掉有效 summaryStore”的保护边界：先比较非空活跃内容、版本和 hash，再决定迁移或回退；读取失败时保留原 payload，禁止把空视图写回。旧 v1 的真实 user/assistant 桥层只作为历史数据，不创建新宿主楼层。 |
| Archive | `state/archive-backend.ts:16-23, 57-151`；`state/archive-repository.ts:959-1000, 1179-1210, 1613+, 1801+, 1874+, 1982+` | 在现有 `compatibility` 块或其独立 hash 对象中保存 shujuku 快照、pluginVersion、capabilityHash、handoff journal 和 branchId；复用 `previousRootHash`、pending/retry/conflict 状态。不要把大表快照复制到每个逻辑消息。fork/import/export/rollback 必须明确复制或清理 shujuku snapshot。 |
| Prompt 分层 | `message-format.ts:1339-1516`；`memorydatabase/prompt-injection.ts:100-143` | 拆成“硬状态/机制提示”和“剧情记忆提示”两个函数。`route=island` 才调用 Island memory injection；`route=shujuku` 完全跳过剧情 memoryDB/summary 注入，只保留时间、地点、数值、路线和规则。 |
| 摘要与动作 | `summary/run.ts:259-461, 483+`；`actions/index.ts:1415, 1811-1865, 2001-2224` | Island 路线保持摘要、progress 和正文链；shujuku 路线禁止 Island 剧情摘要继续进入 prompt，但仍执行硬状态解析和安全过滤。观察期的 summary 结果只影子对账，不能双写成第二个剧情权威。 |
| 新增 shujuku 适配层 | 新增 `shujuku/types.ts`、`runtime.ts`、`virtual-session.ts`、`generate.ts`、`handoff.ts` | 统一 capability 检测、临时虚拟时间线、API patch/restore、非流式生成参数、qrf/storageFrame 取证、表快照 hash、幂等交接和 fail-closed。所有 patch 必须 `try/finally` 恢复，异常和取消也要恢复。 |
| 路线 UI/入口 | `title/render.ts:136-142, 197-209, 406`；`title/events.ts:7-27, 89-99, 178-185`；`index.ts:392-408, 4651-4682` | 复用现有标题页的开关 UI 接线方式，但新增 per-save route；不要复用全局 DeepSeek localStorage。显示插件版本、能力状态、handoff 状态和冲突原因。切换按钮只在完整回合边界可用。 |
| 测试 | 新增独立 `shujuku/` 合同测试和桥接检查脚本 | 覆盖成功、插件缺失、API 失败、重试、hash 冲突、刷新、导出重导、换档、分支、回档、重 roll、取消和并发 stale operation。测试必须断言用户结果，不只断言函数被调用。 |

## 6. 参考代码与网络案例

### 6.1 公开网络参考

- [StageDog/tavern_helper_template](https://github.com/StageDog/tavern_helper_template)：卡片目录、第一条消息和 inline bootstrap 的模板基线。
- [Island 当前基线提交](https://github.com/eriribot/islandmilfcode/tree/48692254ddf4baaa719d4445d25e5fbdf63349c1)：本方案的 Island 代码参考点。
- [SillyTavern chats.js](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/src/endpoints/chats.js)：聊天持久化、导出和读取边界的案例。

### 6.2 本地同层实验参考

- [StageDog v2 `#0` 合同](<E:\web\最简单同层\tavern_helper_template-main\src\same-layer-test\HANDOFF.md>)：当前单 `#0` + 虚拟时间线合同。
- [真同层实验桥](<E:\web\最简单同层\tavern_helper_template-main\src\same-layer-bridge\bridge.js>)：观察期实现参考，不是 Island 生产代码。
  - `buildVirtualTimeline`：649-677，`#0` 根和逻辑消息投影到虚拟 chat；
  - `openShujukuVirtualSession`：1063-1248，临时替换 shujuku 运行时 API；
  - `restoreDatabaseRuntimeFromFloor0`：1251-1267，从 `#0` 恢复表快照，`persist:false`；
  - `projectActiveSaveToShujuku`：1270 起，按存档隔离码恢复表和世界书；
  - `commitShujukuDatabase`：1638 起，`triggerUpdate`、表 hash、storageFrame 和提交状态；
  - `runExchange`：1794 起，逻辑消息、虚拟 session 和生成参数；
  - 生成参数约 1907-1921：`user_input` 放原始输入，`should_stream:false`、`should_silence:true`、`max_chat_history:0`，历史放 `overrides.chat_history.prompts`。

### 6.3 shujuku 本地源码参考

正式本地源码是 `E:\web\tavern_helper_template-main\shujuku-main`，包名 `acu-star-database-iii`、版本 `1.1.0`、`private: true`。另有同层实验副本 `E:\web\最简单同层\tavern_helper_template-main\src\shujuku-main`。两者都只作为本地源码参考；目前没有找到可确认的上游仓库地址，不能虚构 GitHub 链接。

- `shujuku-main/src/presentation/bootstrap/api-groups/table-crud-api.ts`：`updateRow` / `insertRow` 的参数解析、native/SQLite 提交和 row index 规则；
- `shujuku-main/src/service/table/update-scheduler.ts`：`updateFrequency=0` 时跳过自动更新；
- `shujuku-main/src/service/table/table-import-service.ts`：`importTableAsJson` 的覆盖式全量替换，`persist:false` 只恢复运行时；
- `shujuku-main/src/service/worldbook/injection-engine-custom.ts`：自定义表格转世界书、`prevent_recursion` 和 gated recall 需要在实机确认；
- `shujuku-main/syntax-reference.md`：CRUD、`exportTableAsJson`、`importTableAsJson`、`triggerUpdate` 以及 rowIndex 从 1 开始的限制；
- `shujuku-main/docs/03-new-service-tech-doc.md`：native/SQLite 双模式和 CRUD 的事务提交边界。

## 7. 交接、回档和分支规则

### 7.1 交接状态机

```text
island
  -> observation (Island 唯一提示词，shujuku shadow)
  -> handoff_pending
  -> handoff_committed
  -> shujuku (shujuku 唯一剧情记忆)
```

任意一步出现 hash 不一致、分支锚点不一致、插件版本不兼容或恢复失败，都进入 `needs_review/conflict`。不要用“尽量恢复”掩盖不一致。

### 7.2 回档、重 roll、换档

- `branchId` 是剧情记忆隔离的第一条件；不能用楼层号或 `sourceRange` 单独做身份。`timelineAnchor` 必须是稳定的逻辑回合/assistant 身份，不得只用可复用的数组下标。
- 回档到旧节点时，先根据 Island 的实际 head 生成新 branch；原分支未提交的 handoff 全部作废或标记旧分支。
- shujuku 表行必须带 branchId。切支时切到对应 snapshot 或把旧分支行标为过期，不能把未来分支事实带进新分支。
- 每次产生不同正文的重 roll 都创建新的 `branchId`，先恢复到该回合生成前的 shujuku snapshot，再写新 assistant 和 storageFrame；旧分支保留为只读历史。
- 换档先关闭当前 virtual session，再按目标 save 的 route、isolationKey、snapshot 恢复；禁止复用上一个 save 的运行时表。
- 刷新、导出重导和浏览器崩溃恢复都先读 `#0` 的 handoff 状态与 tableHash，再决定是否恢复 shujuku；hash 不符就停在 `needs_review`。
- `operationToken` 失效时丢弃返回值，不能写到已切换的 save 或 branch；finally 中必须恢复所有被 patch 的函数。

没有受控回交时，`shujuku -> island` 不能无提示继续，因为最后一个 Island checkpoint 不包含切换后的剧情。受控回交只迁移已公开、可验证的历史摘要；gated secret 和 shujuku 内部规划不能直接灌进 Island。

### 7.3 存档兼容保护

`state/saves.ts:853-945` 当前在 `memoryDB` 可解析时优先使用它，再 hydrate 回 `summaryStore`。第 2 批已增加以下保护：

1. 先判断 `memoryDB` 是否只有结构、没有活跃内容；
2. 对比旧 `summaryStore` 的非空内容、版本和 hash；
3. 如果新库为空而旧摘要非空，保留旧摘要并进入迁移警告，不把空视图写回；
4. 只有两边都通过校验，才发布新的 summary/memory 组合；
5. 读取异常保留原 payload 和备份，不能静默降级成空记忆。

第 2 批已执行并通过本地合同测试；真实旧档回放仍标为 `[待实机]`。

这是已落地的保护规则；自动合同不替代真实旧档回放，后者仍需 `[待实机]` 确认。

### 7.4 回合提交边界

一个完整回合的逻辑正文、Island 硬状态、qrf、shujuku 表快照和 handoff journal 共享同一个 `generationId + saveId + branchId` 提交边界：

- 全部核对成功后才推进 `cutoffFloor`；
- 中途失败时保留可恢复的 `pending/failed` 记录，不让下一轮把半截结果当成已完成历史；
- 迟到响应、取消请求和重复回调先校验 operation token，再决定是否丢弃；
- 同一 save/branch 同时只允许一个 generation/handoff 写入；
- 日志记录 route、pluginVersion、handoffId、hash、错误码和重试次数，但不记录 gated secret 或整段剧情正文。

多标签页或多运行实例不能只靠内存 `operationToken`：提交前还要比较存档 revision/CAS token，旧 revision 的结果必须拒绝发布。

半提交恢复矩阵：

| 失败点 | 保留什么 | 下次启动动作 |
| --- | --- | --- |
| Island pending 写失败 | 原存档和 shujuku 不变 | 重试前重新生成 envelope，不能直接写表 |
| shujuku 写到一半 | `pending` + 旧 tableHash | 查询逻辑唯一键，补齐或回滚本批，不盲目再插 |
| 表写成功但 storageFrame 保存失败 | shujuku snapshot + `captured_without_frame` | 暂停正文路线，先把 frame 绑定到同一逻辑 assistant 或恢复旧 snapshot |
| storageFrame 成功但 Island committed 发布失败 | frame、tableHash 和 pending journal | 用同 handoffId/hash 继续发布；不同 hash 进入 conflict |

## 8. 20 回合观察期

观察期建议覆盖 20 个取得完整三证据的成功回合，Island 仍是唯一影响提示词和正文的系统。shujuku 每轮只做关闭自动召回的 shadow 记录，记录规范化事件、候选事实、关键词、表 hash 和错误，不写入玩家可见剧情。插件缺失、shadow 失败或证据不完整的回合只记录故障，不计入 20 回合。

至少包含：

- 4 回合普通对话和摘要边界；
- 2 回合换地点；
- 3 回合关系或好感变化；
- 2 回合物品/背包变化；
- 2 回合任务或路线 flag 变化；
- 1 次刷新后继续；
- 1 次保存、关闭、读档后继续；
- 1 次导出再导入；
- 1 次当前回合重 roll；
- 其余回合用于连续摘要、取消和重复输入压力。

每轮对账指标：

- 漏记、重复、错误过期的行数；
- Island prompt 来源计数必须仍为唯一；
- shadow 事件规范化 hash 和表 hash；
- 刷新/读档后的 table hash 是否一致；
- qrf、正文、storageFrame 三种证据是否分别出现；
- 是否有未关闭的 virtual session、streaming assistant 或 pending handoff。

人工通过门槛：20 回合中没有未解释的跨分支记忆、没有重复交接写入、没有普通召回泄露 gated secret，且刷新、读档、重 roll 后 hash 与 branch 都能对上。观察期不是永久路线，未通过就保持 Island。

## 9. 合同测试与验收清单

### 9.1 路线和宿主拓扑

- [ ] 开关关闭时 shujuku 调用、virtual session 和快照写入次数严格为零。
- [ ] 开关开启时，Island 剧情记忆不进入提示词；硬状态仍可读写。
- [ ] `chat.length === 1` 且 `getLastMessageId() === 0`，生成前、中、后、刷新后都成立。
- [ ] 不存在真实 `#1/#2`、hidden bridge floor 或完成后删除临时楼层的实现。
- [ ] virtual session 异常、取消、刷新和超时后，所有被替换的 host/helper API 都已恢复。

### 9.2 消息字段和三条证据

- [ ] `plannedText`、qrf、pluginData 和 nested `TavernDB_ACU_IsolatedData.storageFrame` serialize/deserialize 往返不丢。
- [ ] qrf 证据来自当前虚拟 user，并持久化到对应逻辑 user；不是旧消息扫描或 assistant 文本标签。
- [ ] 正文证据来自当前逻辑 assistant。
- [ ] 数据库证据同时有 storageFrame、被拦截的保存调用和恢复成功；只有运行时表变化时不能标记 committed。
- [ ] qrf、正文和数据库提交分别有状态和日志，不互相代替。

### 9.3 交接、重试和冲突

- [ ] 同一 `handoffId` + 同一 hash 重试是 no-op，不重复插入；`tableHash` 只覆盖桥接层管理的两张旧档表。
- [ ] 同一 `handoffId` + 不同 hash 进入 conflict，停止且不覆盖原数据。
- [ ] handoff 在浏览器崩溃后从 pending 继续，不重复写入。
- [ ] 插件版本、能力 hash、隔离码或存档 schema 不兼容时 fail-closed。
- [ ] malformed/unknown save schema 不会降级覆盖有效旧存档。
- [ ] 桥接层查询逻辑唯一键后决定 `insertRow` 或 `updateRow`；不假设 shujuku 自带复合唯一约束。

### 9.4 刷新、换档、分支和重 roll

- [ ] 刷新后从 `#0` 恢复逻辑消息、route、handoff 和 shujuku table snapshot。
- [ ] 导出重导后 hash、saveId、runId 和 branchId 一致。
- [ ] 换档不会带入上一个存档的表或剧情记忆。
- [ ] 回档/重 roll 后旧分支的 active memory 不会进入新分支 prompt。
- [ ] 异常回合不会留下 streaming assistant、半个 handoff 或未关闭 virtual session。
- [ ] `secret` 的 gated 行不会出现在普通 worldbook recall。
- [ ] native 和 SQLite 两种模式对同一交接输入得到相同的逻辑行、hash、重试和回档结果。

### 9.5 20 回合观察证据

- [ ] 观察期至少 20 个完整回合，并覆盖换地点、关系、物品、任务、刷新、保存读档和重 roll。
- [ ] 每轮保存 `exchangeId`、逻辑消息 ID、branchId、qrf 状态、正文状态、db 状态、tableHash 和错误。
- [ ] 对账报告能解释所有漏记、重复、过期和冲突行。
- [ ] prompt spy 检查最终请求：shujuku 路线没有 Island summary/facts/events 等叙事段，但硬状态段仍存在。
- [ ] 失败注入覆盖规划前、qrf 后、正文后、`triggerUpdate()` 中、storageFrame 后和最终保存前；每个点都证明没有半条逻辑消息、重复表行或未恢复 API patch。

## 10. 待实机确认的问题

以下内容不能靠静态源码或本方案猜定：

- [待实机] 真实 shujuku runtime 暴露的 API 名称、iframe 注入时序和 hot reload 生命周期；
- [待实机] `TavernHelper.generate` 在当前版本是否按上述参数触发原生世界书扫描；
- [待实机] native 与 SQLite 模式的中文表名/列名映射、rowIndex 和事务回写语义；
- [待实机] storageFrame 的真实保存位置、读回格式和 `#0` 插件字段是否按 swipe 独立持久化；
- [待实机] `importTableAsJson({ persist:false })` 在刷新、换档和导出重导中的实际副作用；
- [待实机] 同 handoffId/hash 的幂等性是否需要桥接层额外去重；
- [待实机] 分支切换、删除逻辑消息和重 roll 时 shujuku 是否留下未预期的持久写入；
- [待实机] gated secret 的 worldbook 保护策略和 `prevent_recursion` 组合；
- [待实机] SillyTavern 当前 host 的 `chat[0]`、`getLastMessageId()` 和刷新/导入行为是否始终满足单 `#0` 合同。

## 11. 本轮不做的事和下一步

本轮不修改 shujuku 源码、SQL、外部正则或生产生成链，也不把观察期当成第三条永久路线；已完成的范围仅限 Island 侧兼容持久化和合同验证。

下一窗口按以下顺序实现：

1. [已完成] 类型和消息 codec 的 round-trip 合同测试；
2. [已完成] `state/saves.ts` 的空记忆保护和 archive compatibility/handoff 持久化；
3. [未开始] `shujuku/` 适配层的 capability、虚拟 session、非流式生成和独立证据；
4. [未开始] per-save 开关、20 回合观察工具和真实酒馆验收。

第 1 批证明 `exchangeId`、`plannedText`、`qrf_plot*`、未知 `pluginData` 扩展和嵌套
`TavernDB_ACU_IsolatedData.storageFrame` 能通过消息 codec 与 v2→v3 迁移保持绑定。第 2 批证明空
`memoryDB` 不会覆盖有效 legacy summary，且 route/branch/handoff/table checkpoint 能跨 archive
操作保持一致。接通标签仍是“不涉及接通”：没有探测插件、没有创建虚拟 session、没有触发生成，也没有
读写真实 shujuku 表。
