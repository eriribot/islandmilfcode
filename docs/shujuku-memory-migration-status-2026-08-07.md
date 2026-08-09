# IslandMilfCode shujuku 迁移现状与问题基线

更新时间：2026-08-07  
范围：IslandMilfCode 老存档的 `memoryDB -> shujuku` 一次性迁移，以及同层 `#0` 存档接通。

## 0. 冻结说明

这份文档是当前代码状态的交接基线。写完后先不继续改源码、不继续重 roll、不再反复导入当前存档；先由人确认下面的事实和问题边界。

本轮约束：

- 非同层卡只作为 shujuku 表格式参照，不迁移它的剧情数据。
- 只做一次初始迁移，不做长期双向同步。
- `secrets`、`phoneMessages` 不迁移到 shujuku 表。
- 不修改 `shujuku-main` 插件源码。
- 按要求没有检查 Git 状态，也没有提交。

## 1. 已完成的代码

### 1.1 迁移输入和 14 张目标表

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `shujuku/island-memory-v3.json` | 项目内保存的 14 张 shujuku 表模板/目标 JSON | [已完成] |
| `shujuku/memory-migration.ts` | 将 Island `memoryDB` 确定性映射到目标表 | [已完成] |
| `scripts/verify-shujuku-memory-migration.ts` | 迁移合同检查 | [已完成] |

映射规则已经包含：

- 过滤过期行、`secrets`、`phoneMessages` 和扩展字段。
- 保留 `sheet_check_advice`、`sheet_director_plan` 为空表。
- 生成连续的 `row_id`。
- 将玩家、角色、恋爱对象、事件、物品、任务、纪要映射到对应表。
- 对技能分类/熟练度、物品类型/情感分量、全局状态和纪要长度做格式转换。

### 1.2 shujuku 导入事务

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `shujuku/adapter.ts` | 探测 v2 运行时、导入/恢复表、回读核对、失败回滚 | [已完成] |
| `types.ts` | 持久化 `mappingVersion` 等兼容状态类型 | [已完成] |
| `scripts/verify-shujuku-v2-adapter.ts` | 适配器事务合同 | [已完成] |

当前导入顺序是：

```text
检查单 #0 拓扑和隔离码
-> 导出旧表快照
-> 导入迁移目标
-> exportTableAsJson() 回读
-> 保存规范化后的真实回读对象和 hash
```

回读核对的合同已经改为：

- 目标中的每个对象字段必须在回读中存在且值相同。
- 数组长度、顺序和每个单元格必须完全相同。
- 允许 shujuku 在对象中增加默认字段，例如 `exportConfig` 的默认键。
- 真实内容被改动时必须失败，并恢复导入前表快照。

因此，之前截图中的：

```text
$.sheet_char_journal.exportConfig keys...
```

被确认是 shujuku 正常规范化造成的假失败，不是纪要数据丢失。

恢复操作若已经开始但无法确认结果，会把当前 iframe 运行时标记为不可继续使用，要求重载 iframe 后再试，避免在未知表状态上继续写入。

### 1.3 存档接通和旧版本隔离

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `index.ts` | shujuku 路线开关、一次迁移、handoff/snapshot 持久化 | [已完成] |
| `actions/index.ts` | 生成和重 roll 只接受 v3 handoff | [已完成] |
| `phone/render.ts` | UI 只把完整 v3 handoff 显示为已连接 | [已完成] |
| `state/archive-repository.ts` | fork/rollback 时校验或清理旧 handoff | [已完成] |

本轮接通版本为：

```text
mappingVersion = island-memory-v3
```

明确是旧版本、缺少版本或版本不一致的 handoff，不再当作有效连接继续使用。

导入成功后，Island 存档保存：

- `shujukuCompatibility`
- `shujukuHandoff`
- `shujukuTableSnapshot`
- `sourceHash`
- 规范化回读后的 `tableHash`

存档写入失败时会尝试恢复导入前表；失败路径会清掉残留的 handoff/snapshot，避免下一次误认为已接通。

## 2. 相关文件清单

以后改这条链时，先从下面几组看，不要从整仓盲搜。

### Island 迁移入口

- `shujuku/island-memory-v3.json`
- `shujuku/memory-migration.ts`
- `scripts/verify-shujuku-memory-migration.ts`

### shujuku 运行时边界

- `shujuku/adapter.ts`
- `types.ts`
- `scripts/verify-shujuku-v2-adapter.ts`

### 路线、存档、重 roll

- `index.ts`
- `actions/index.ts`
- `state/archive-repository.ts`
- `phone/render.ts`
- `scripts/verify-shujuku-v2-submit-wiring.ts`
- `scripts/verify-shujuku-v2-save-compatibility.ts`
- `scripts/verify-shujuku-v2-save-wiring.mjs`

### 辅助合同

- `scripts/verify-shujuku-v2-message-codec.ts`
- `scripts/verify-shujuku-v2-prompt-isolation.ts`
- `tsconfig.json`（项目根目录，已有 `resolveJsonModule`）

### 只读参考源码，不是本轮修改目标

项目根目录 `shujuku-main` 中本轮核对过：

- `shujuku-main/src/service/table/table-import-service.ts`
- `shujuku-main/src/service/template/chat-scope/chat-scope-sheet.ts`
- `shujuku-main/src/service/table/sql-table-service.ts`
- `shujuku-main/src/data/sqlite/sync-bridge.ts`

这些源码证明导入链会经过 `sanitizeChatSheetsObject_ACU(..., { ensureMate: true })`，并会给 sheet 补 `exportConfig` 默认字段。

## 3. 已执行证据

### 3.1 本地合同

| 检查 | 结果 |
| --- | --- |
| `verify-shujuku-memory-migration.ts` | [通过] 14 张表；10 条有效数据；过期/秘密/手机消息过滤通过 |
| `verify-shujuku-v2-adapter.ts` | [通过] 43 contracts |
| `verify-shujuku-v2-submit-wiring.ts` | [通过] 33 contracts |
| `verify-shujuku-v2-save-compatibility.ts` | [通过] 35 contracts |
| `verify-shujuku-v2-save-wiring.mjs` | [通过] 10 contracts |
| `verify-shujuku-v2-message-codec.ts` | [通过] 13 contracts |
| `verify-shujuku-v2-prompt-isolation.ts` | [通过] 15 contracts |
| 新增/触及 shujuku 文件 ESLint | [通过] 0 errors；测试脚本保留 1 个原有 warning |
| `pnpm build` | [通过] Island 主包成功；只有既有 bundle 体积和 Browserslist warning |

### 3.2 Chrome/F12 可见证据

当前标签：`http://127.0.0.1:8000/`，Island 页为 `stTabB`，标签 ID `1861386356`。

已看到：

- 设置页的 `shujuku 剧情路线` 为勾选状态，文字为“已连接”。
- shujuku 底部显示 14 个目标表入口：全局数据、世界地图、关系网络、主角、才艺技能、恋爱对象、恋爱心迹、重要角色、角色札记、纪要、物品、备忘录、检定建议、导演规划。
- 审核面板已经出现迁移行；截图中可见全局数据、世界地图、主角信息和恋爱对象都有行。

这些证据说明“导入后 hash 假失败”已经不再阻断路线接通。

尚未在这次冻结前完成的浏览器证据：

- 尚未保存一份最终 `exportTableAsJson()` 的 14 表键名/行数/hash JSON 证据。
- 尚未在当前冻结代码上重新跑一轮完整正文并确认当前虚拟 user 的 qrf 写回。
- 尚未调用 `chrome.tabs.finalize()`；当前浏览器状态保留给下一轮人工检查。

## 4. 当前仍有的问题

### 4.1 qrf 失败：正文保存了，但填表没有发生

截图中的当前通知是：

```text
正文已保存，填表失败
本轮虚拟 user 未产生 qrf，已拒绝复用旧消息规划。
```

这不是上面的 `exportConfig` hash 问题。当前代码的行为是：

1. shujuku 生成返回了正文。
2. 当前虚拟 user 没有产生本轮 qrf。
3. 适配器拒绝复用旧消息的 qrf。
4. Island 保留已经生成的正文，并把填表错误显示出来。

这是一个“正文链成功、规划/qrf 链失败”的独立故障。这样保留正文是防止后置失败把正文一起删除的保护，但它还没有解决 shujuku 原生 qrf 为什么没有写回。

下一轮需要用 F12 对同一个 `generationId/exchangeId` 逐项确认：

- shujuku 规划 hook 是否被触发；
- qrf writer 是否执行以及写入哪个虚拟 user 对象；
- 写入是否晚于当前等待窗口；
- `triggerUpdate()` 是否在 qrf 成功前被调用。

在拿到这些运行时证据前，不应再猜 qrf 根因。

### 4.2 重 roll 的历史基线问题（尚未修复）

当前重 roll 流程大致是：

```text
选择旧楼层
-> 读取该楼层 beforeTurnState 的 shujuku checkpoint
-> 校验 saveId/runId/branchId/handoffId/isolationKey/tableHash
-> 恢复轮前表快照
-> 截断归档
-> 用同一轮输入开始新生成
```

问题在于：本轮“一次性迁移”只在接通时刻建立当前表快照，没有为接通以前的每个历史楼层生成 `beforeTurnState` 的 shujuku 表快照。

因此：

- 对接通以前的楼层，`getArchiveFloorBeforeTurnShujukuCompatibility()` 读不到完整 checkpoint。
- `createShujukuRerollCompatibility()` 会返回空。
- 当前代码会显示“该楼层早于 shujuku 接通基线，没有当时的轮前表快照”，并停止重 roll。
- 这是当前的 fail-closed 行为，不是已经解决了基线问题。

对接通之后的楼层，只有在归档中确实存在完整快照，并且 `saveId/runId/branchId/handoffId/isolationKey/tableHash` 全部一致时，才允许继续。

重要区分：本次截图的“虚拟 user 未产生 qrf”不是“早于接通基线”的提示；它说明当前尝试已经进入生成阶段，但 qrf 证据没有出现。两条问题必须分开验收。

### 4.3 还没有决定的产品策略

历史基线有三种方向，目前没有选定，也没有实现：

1. **保守策略**：接通前的楼层永远禁止走 shujuku 重 roll，只允许回看或切回 Island。
2. **回填策略**：根据历史每一轮的真实 memoryDB/表写入记录，重建接通前每个楼层的 shujuku snapshot，再开放重 roll。
3. **新分支策略**：从接通时刻创建新 branch；旧楼层重 roll 只在 Island 分支执行，不把旧表状态强行伪装成 shujuku 历史。

在没有确认历史数据是否足够重建之前，不能直接选第 2 种；它涉及跨存档、跨表和分支语义，风险高于本轮一次性迁移。

### 4.4 审核队列无法清空（尚未修复）

截图和当前运行态观察到（[已观察]）：

- 审核面板仍显示 `审核(12)`；批量接受和批量拒绝都没有清掉这 12 项。
- 批量接受反复提示：`存在整表/结构级变更，批量接受已跳过；请先处理可安全的行/格变更`。
- 批量拒绝反复提示：`存在整表/结构级变更，批量拒绝已跳过；请逐项处理可安全的行/格变更`。
- 每次操作都会继续堆叠橙色通知，审核计数没有下降。

当前能确定的边界：

- 批量操作会主动跳过整表/结构级变更；这与 14 张表迁移是否成功、正文是否保存、qrf 是否写回是不同的链路。
- 截图只证明存在待处理的结构级审核项，没有证明这些项是否有可用的逐项接受、逐项拒绝或关闭入口；因此“无法清空”的具体源码根因仍为 `[待确认]`。
- 在已检查的本地 `shujuku-main/src` 源码中没有找到上述通知原文；运行中的插件 bundle、生成的审核代码或版本不一致仍需用 F12 对照确认，不能据此认定源码已经包含或修复了该逻辑。

本轮不做修复。下一轮应先在 F12 中记录待审核项的类型/来源以及批量按钮实际调用的 action handler，确认结构级项是否存在逐项处理或显式关闭路径，再决定修改范围。

## 5. 下一轮开始前的检查清单

这份文档审阅完成前，先不要继续改代码。下一轮如果获准，顺序建议是：

1. 先用 F12 保存当前成功接通的 14 表键名、行数、`tableHash` 和当前 `handoffId`。
2. 单独复现一次 qrf 失败，记录同一 `generationId` 的虚拟 user、writer、等待窗口和 `triggerUpdate` 顺序。
3. 选定上面的历史基线策略，并为该策略写一个失败/成功合同。
4. 再决定是否修改 `rerunReaderMessage()`、archive checkpoint 生成或迁移逻辑。

## 6. 本轮结论

截至本文档：

- **memoryDB 到 shujuku 的一次性 14 表迁移：本地合同通过，Chrome 可见接通。**
- **导入后 hash mismatch：根因已定位并修正为规范化假失败。**
- **正文保存但 qrf/填表失败：仍未解决。**
- **接通前历史楼层的重 roll 基线：仍未解决，当前只是安全停止。**
- **审核队列中的整表/结构级变更无法通过批量接受或拒绝清空：仍未解决，具体 handler 和待审核项类型尚未用 F12 核实。**
- **不应把“已连接”理解成 qrf、正文和数据库三条证据都已通过。**
