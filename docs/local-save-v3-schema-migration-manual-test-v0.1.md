# 本地存档 v3 schema 与迁移计划：人工测试说明 v0.1

> **已被取代：** 本说明只保留作早期迁移计划记录。当前玩家验收请使用 [本地存档 v3：玩家手工测试说明 v0.3](./local-save-v3-player-test-v0.3.md)；不要再依据本文件判断当前实现是否通过。

> 本说明对应“版本闸门 + `FloorRecord` 合同 + v2→v3 纯迁移计划”。当前尚未接入 v3 IndexedDB stores、`ArchiveRepository` 或本机分块文件，因此不能据此宣称 v3 存档、回滚或性能链已经可用。

## 1. 测试前保护

1. 只使用复制出的玩家存档，不要拿唯一真实存档做修改。
2. 先从当前正式卡导出一份未改动的单存档 JSON，并复制到工作目录外。
3. 测试 future schema 时必须改 `saveId` 与 `runId`，避免覆盖原存档。
4. 分别记录浏览器、标准 SillyTavern、TT 桌面和 TT 移动端；没有实际运行的平台记 `not run`。

## 2. 当前可以验证的版本闸门

### 2.1 正常 v2 存档不受影响

1. 新建测试存档，选择非默认性别，写入两轮正文并手动保存；至少让一张插图的 `rerollContext.negativePrompt` 存在。
2. 刷新后进入该存档，确认正文、当前时间、地点、角色数值、玩家性别、手机草稿和负面提示词仍在。
3. 在测试副本里把 `runtimeFlags.phoneMessages.generating` 改成 `true` 后重新导入；进入存档后必须为 `false`，不能恢复成旧生成任务。
4. 再导出单存档 JSON，确认 `payload.version` 仍为 `0.43`，没有被提前标成 v3。

预期：正常 v2 继续使用旧聚合格式；当前循环没有启用 v3 repository。

### 2.2 future schema 不被旧 codec 降级

1. 复制一份单存档导出 JSON，将外层 `saveId`、`payload.saveId` 和 `payload.runId` 改成新的测试值。
2. 将 `payload.version` 和 `meta.version` 改成 `99`；另做一份把版本改成无法识别的 `future-x`。
3. 导入测试文件。未来版本存档应进入列表，但不应自动切成当前活动存档。
4. 不进入该存档，立即再次导出它；对比导入前后的 `payload`，要求语义完全相同，未知字段仍在。
5. 执行一次“导出全部存档”，确认 future payload 没有被遗漏，也没有被改写成 `0.43`。
6. 打开控制台；如果旧聚合读取被调用，应看到 `aggregate codec refused a non-legacy payload`，不能看到保存成功或迁移成功提示。

预期：future/unknown 只能列出和原样导出；旧 normalizer、MemoryDB sweep、图片内联迁移和写回均不得执行。

## 3. v2→v3 纯迁移计划检查

`state/save-migration.ts` 导出的 `buildLegacyV2ToV3MigrationPlan(payload)` 是纯规划入口。调用时传单存档 JSON 的 `payload`，只查看返回对象，不把结果写入 IndexedDB。

至少核对以下字段：

- `targetSchemaVersion === 3`、`initialRevision === 1`。
- `floors` 从 0 连续编号；一个正常 user+assistant 回合只生成一个 `FloorRecord`。
- 去掉合成输入后，按 `sourceMessageIndexes` 展开所有楼层，顺序与旧 `chatLog` 完全一致。
- 单独的开场 assistant 正文仍在，且 `provenance.syntheticUserMessage === true`；空合成输入不能冒充真实玩家发言。
- user 快照进入 `beforeTurnState`，assistant 快照进入 `afterTurnState`；来源不足时 `issues` 必须出现 `before-state-fallback` 或 `after-state-fallback`。
- v2 没有正文生成上下文时，每层都有 `generation-context-unavailable`，不得伪造旧 prompt。
- `illustrations[].rerollContext.negativePrompt`、`PlayerProfile.gender`、`activeTargetId`、目标 `meta`、背包、`worldState`、`messageSnapshots`、MemoryDB extensions 都没有丢失。
- `phoneMessages.draft` 保留，`phoneMessages.generating === false`，手机消息 `floorIndex` 已从旧消息索引映射为新业务楼层。
- MemoryDB `_indexes` 不进入计划；运行时 cancel、pending、API key、搜索结果和 debug 字段不进入 `currentState`。
- 未登记的旧 runtime 字段进入 `legacyExtras.runtimeFlags`；已登记的敏感/瞬时字段只在 `excludedRuntimeFlagKeys` 留字段名，不复制值。
- 存在 blocking issue 时 `readyForTransactionalPublish === false`。

建议分别准备四种复制档：正常交替消息、只有开场 assistant、结尾只有 user、含异常/system 消息。最后一种必须保留原始异常记录并阻止发布，而不是静默删除。

## 4. 当前 v2 revision/transaction 屏障的人工测试

这部分只验证现有 v2 聚合存档的提交边界，不代表 v3 分层 repository 已完成。

### 4.1 手动保存以 transaction completion 为准

1. 打开浏览器开发者工具的 Application → IndexedDB → `islandmilfcode`。
2. 进入一个测试档，新增一轮正文后点击“手动存档”。
3. 在 `save-payload` 找到新 `saveId`，记下 `browserRevision`；再打开 `save-index/__index__`，确认同一 `saveId` 的 `browserRevision` 完全相同。
4. 刷新页面并重新进入该档，确认刚才的正文存在；再次保存后，两处 revision 都必须严格增加。
5. 如果浏览器存档写入失败，界面必须显示“浏览器存档失败，未执行本机文件备份”，不能显示或记录本机备份成功。

### 4.2 前后台与双标签旧 revision 不覆盖

1. 用两个标签页打开同一测试档，记录两边当前 revision。
2. 将 B 放到后台，在 A 产生新正文并等待自动保存落盘。
3. 切回 B 触发 visible reload；检查 IndexedDB 和控制台诊断，revision 不得倒退。
4. 在 B 不产生新正文，只反复切换前后台；A 已保存的新 payload 不得被 B 的旧内存镜像覆盖。
5. 最后刷新两个标签页，二者应读取 IndexedDB 中最大的已提交 revision。

### 4.3 localStorage 旧源只在完整验证后清理

1. 先导出测试副本，再在 Application → Local Storage 准备一组 `islandmilfcode:save-index:v2` 与对应的 `islandmilfcode:save-payload:v2:<saveId>`。
2. 正常刷新：对应 payload 和 index 应出现在 IndexedDB，逐项回读一致后旧 key 才消失。
3. 再准备一组故意损坏的 JSON 或与无 revision IDB 记录冲突的数据并刷新：控制台应报告迁移待处理，整组旧 key 必须保留，不能只迁移一半便删除全部旧源。
4. 修复旧数据后再次刷新，迁移应自动重试；不要求先清空 IndexedDB。

### 4.4 IndexedDB 初始化失败不阻断首屏

在可禁用站点存储的浏览器配置或目标 TT 环境中阻止 IndexedDB 后重新载入：卡片仍应完成首次渲染，并显示“浏览器存档暂不可用，当前为内存降级模式”；点击手动保存应明确失败。恢复 IndexedDB 后重新载入，再确认正常存档。

## 5. 后续 repository 接通后再执行的实机测试

以下项目本轮必须记为 `not run`：

- v3 IDB transaction 完成后才显示“浏览器已保存”。
- 第 1000 层直接跳第 50 层且不扫描前 49/950 层。
- 回看旧楼层只回显历史快照，不改变当前权威状态或 revision。
- 回到用户输入、回滚到完成楼层、正文重生成的截断和状态恢复。
- 浏览器存储清空后从本机 v3 分块恢复。
- 桥离线时 `browser-primary` 完整保留历史。
- 标准 SillyTavern、TT 桌面、TT 移动端的首次渲染、自动保存和重启恢复。

## 6. 记录格式

每项只记：`passed / failed / not run`，并附平台、存档副本名称、操作时间和第一条错误。静态代码检查、构建、纯迁移计划、浏览器 IndexedDB、酒馆本地文件和玩家实机结果必须分开记录，不能互相替代。
