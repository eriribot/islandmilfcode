# shujuku V2 operation-log 回归交接

**日期**：2026-08-11  
**交接对象**：Claude（先审查，暂不继续改桥）  
**本轮范围**：记录现场证据与代码状态；不启动真实 SillyTavern 生成，不修改远端 shujuku/shujukuinject。

> **最新纠正（2026-08-12，优先于本文较早结论）**：现场使用的是 shujuku/ACU
> **原生默认填表模板**，`<thought>/<content>/<tableEdit>` 不是非法旧格式，也不是要求替换成
> `table_edit_ops_v1` 的证据。默认模板必须继续走 shujuku 原生 `group_fill` 解析器；桥不应拦截、改写或伪装这类响应。
> 本地桥已升至 `6.3.1`：移除了错误的 `SHUJUKU_LEGACY_DSL_REJECTED` 方向，并在虚拟回合临时把存档 source
> `isolationKey` 下的模板/表指南映射到当前 active key，回合结束恢复宿主 metadata。下一步仅需导入最新桥做一次真人生成；若仍失败，记录实际请求、响应、解析结果和 `saveResult`，不要先替换默认 prompt。

> **6.3.1 根因修正**：远端 `spv8.9.2` 的默认 `<tableEdit>` parser 在 runtime provider 没有 `sheet_*`
> 结构时会返回 `success=true, modifiedKeys=[]`；snapshot 路径随后把空 `operations` 交给 V2，才产生本错误。
> 桥现在从当前 isolation scope 的 guide/template 只补齐缺失表结构，再调用原生 `triggerUpdate`；它不生成伪 operation，失败会恢复 hydration 前快照。

## 现场现象

现场提示：

```text
更新失败: V2 operation log requires explicit operations for source=group_fill;
snapshot diff fallback is not allowed.
```

控制台调用链的末端是：

```text
TableUpdateCommitError: V2 operation log requires explicit operations for source=group_fill; snapshot diff fallback is not allowed.
  -> runCommit
  -> runTableWriteTransaction_ACU
  -> runTableUpdateCommit_ACU
  -> executeCardUpdateCore_ACU
  -> proceedWithCardUpdate_ACU
  -> triggerUpdate
  -> runVirtualGeneration
```

用户给出的远端代码片段：

```js
if (!saveResult.saved) {
  logWarn_ACU(`[TableUpdateCommit] persist failed after runtime update; reload after releasing transaction locks: ${saveResult.error || 'unknown error'}`);
  requiresRuntimeReload = true;
  throw new TableUpdateCommitError_ACU(saveResult.error || `${options.reason}: persist failed`, 'infrastructure');
}
```

这段是持久化失败后的统一包装，不是最初的协议不匹配点。真正需要先查的是 `runCommit` 如何得到 `saveResult`、`source=group_fill` 要求的显式 operation 结构，以及本轮实际使用的填表 prompt/解析入口。

## 新的关键证据

本轮 Chat Completion 的模型响应并不是空响应，而是旧 DSL 文本：

```text
<thought>...</thought>
<content>
<tableEdit>
insertRow(1, {...})
insertRow(2, {...})
insertRow(3, {...})
insertRow(4, {...})
</tableEdit>
</content>
```

响应包含对角色状态、五维数值、剧情进度和纪要表的多条 `insertRow` 意图；但它同时具备以下特征：

- 不是合法的 `table_edit_ops_v1` JSON 根对象；
- 含有 `<thought>`、`<content>`、`<tableEdit>` 围栏；
- 使用数字表号和旧式 `insertRow(sheetIndex, row)` 语法；
- 不能直接作为 V2 `group_fill` 的显式 operation log；
- 因此“模型返回了内容”不能推出“V2 已提交”。

截图原件：

```text
C:\Users\eriri\AppData\Local\Temp\codex-clipboard-254c9e8b-0f97-4d45-a18b-80139c6dd97.png
```

> 注：上面的路径以用户消息中的本地截图为准；若复制时路径有误，以用户消息附件实际路径为准。

## 当前代码状态

### 已完成的桥侧修复

文件：`shujuku/IslandMilfCode数据库转发桥.js`

- 桥版本已升至 `6.1.0`。
- 临时捕获三类填表 API：`generateRaw`、Connection Manager `sendRequest`、`fetch`。
- 只有捕获到合法的 `{"format":"table_edit_ops_v1","ops":[]}`，且同时满足错误文本、表快照不变、虚拟 chat 不变、没有虚拟写入/保存/`storageFrame` 的条件，才把本轮判为 `verified_noop`。
- 非空 operation、无法解析的响应、表发生变化、裸 `false` 或其他错误都会 fail-closed；不会凭空生成 `storageFrame`。
- 该分支的目的只是兼容远端“合法空 operation 仍被错误提交”的回归，**不是**把旧 `<tableEdit>` 转换成 V2 操作。

文件：`shujuku/导入到酒馆中/IslandMilfCode数据库转发桥.json`

- 已由 `scripts/sync-shujuku-role-bridge.mjs` 同步，导入 JSON 的 `content` 与维护源码一致。

文件：`shujuku/导入到酒馆中/acu-form-fill-prompt-fixed.json`

- 当前仓库内的固定提示已经要求严格 JSON：

```json
{"format":"table_edit_ops_v1","ops":[]}
```

- 它明确禁止思维链、Markdown、`<tableEdit>` 围栏，并要求使用实际表名和字段名。

### 已执行的本地证据

```text
node scripts/verify-shujuku-v2-virtual-relay.mjs
-> [shujuku-v2-virtual-relay] contracts passed, including explicit no-op paths

node scripts/sync-shujuku-role-bridge.mjs
-> [shujuku-role-bridge] table and virtual-turn relay source synchronized

node --check shujuku/IslandMilfCode数据库转发桥.js
-> passed

git diff --check -- shujuku/IslandMilfCode数据库转发桥.js scripts/verify-shujuku-v2-virtual-relay.mjs shujuku/adapter.ts
-> no whitespace error in the touched files
```

这些是本地合同/语法证据，不是现场 SillyTavern 验收。真实生成、真实表持久化和刷新回读仍为 `not run`。

## 最可能的根因分叉

当前证据只能把问题收窄到以下两个分叉，不能在没有现场 prompt/请求包的情况下替 Claude 选定一个：

### 分叉 A：现场仍使用旧填表 prompt 或旧导入产物

仓库里的固定 prompt 已是 `table_edit_ops_v1`，但现场返回旧 `<tableEdit>`，最直接的解释是：

- 最新 `acu-form-fill-prompt-fixed.json` 没有导入到当前启用的 ACU route；或
- 当前 `group_fill` 使用了另一份 preset/主槽位 prompt；或
- 现场仍运行旧的酒馆/角色桥产物；或
- 生成请求命中了旧缓存/旧 Connection Manager profile。

### 分叉 B：远端 `spv8.9.2` 的 `group_fill` 仍只接受旧 DSL，但 V2 提交层已切换为 operation-log

如果现场确认请求确实携带了新 prompt，却仍返回旧 DSL，则需直接检查远端 `group_fill` 的 prompt 拼接、响应解析和 commit 入口。此时不是桥的 no-op 判定问题，而是“模型响应格式”和“V2 提交合同”没有切换到同一版本。

## 请 Claude 先做的检查

1. **确认实际 prompt 来源**
   - 在现场记录 `group_fill` 请求的完整 system/user prompt（至少保留格式约束部分）。
   - 确认是否包含 `table_edit_ops_v1`、`ops`、实际 `sheet` 名规则。
   - 记录启用的 preset、主槽位、Connection Manager profile、桥版本和 shujuku 版本。

2. **确认响应到底经过哪个解析器**
   - 在 `runTableUpdateCommit_ACU` / `runCommit` 前记录原始模型响应和解析结果。
   - 区分 `table_edit_ops_v1` 解析器、legacy `<tableEdit>` 解析器、snapshot-diff fallback 三条路径。
   - 确认 `source=group_fill` 对应的 `saveResult.operations`（或等价字段）是否为空、缺失或被丢弃。

3. **确认是否发生了部分写入**
   - 对比触发前后每张表快照和 V2 revision/log；不能只看“表有变化”。
   - 记录 `saveResult.saved`、`saveResult.error`、显式 operations 数量、applied operations 数量和 rollback 结果。
   - 如果旧 DSL 已被部分应用，必须把本轮标为失败/部分失败，不能用 snapshot diff 生成“已提交”结论。

4. **选择一个明确的合同修复方向**
   - 首选：让现场实际启用的 `group_fill` prompt 和解析器都使用同一版 `table_edit_ops_v1`，并先验证一条 `ops:[]` 与一条非空 `ops`。
   - 只有在确认必须兼容 legacy DSL 后，才设计显式、版本化的 legacy-to-ops 转换器；转换时必须解决数字表号、row index、字段名、insert/update 语义和部分成功回滚，不能简单把 `<tableEdit>` 文本当成功。
   - 不要把“`tableChanged === true`”作为 V2 committed 的替代条件。
   - 不要把旧 `<tableEdit>` 响应伪装成空 operation，也不要在失败时伪造 `storageFrame`。

## 验收合同（交给下一轮）

### 机器检查

- 新 prompt 被实际请求使用，原始响应严格匹配 `table_edit_ops_v1`。
- `ops:[]`：远端不再抛出空 operation-log 错误；桥诊断为 `verified_noop`，表和 chat 均不变。
- 非空 `ops`：显式 operation 被远端接受，V2 revision/log 和表快照一致，assistant 绑定当前回合 storage frame。
- 非法/旧 `<tableEdit>`：明确失败并回滚（若已发生部分写入），不得标成 committed。
- 桥临时捕获层在成功、失败和异常路径均恢复。

### 现场检查（当前未执行）

- 导入最新填表 prompt 和 `IslandMilfCode数据库转发桥.json`。
- 记录一次真实 `group_fill` 请求/响应/`saveResult`/V2 log。
- 刷新后确认表快照和当前回合 assistant 的 storage frame 可回读。
- 确认没有新增宿主聊天楼层或把旧 `<tableEdit>` 文本写入真实历史。

## 相关文件

- `shujuku/IslandMilfCode数据库转发桥.js`
- `shujuku/导入到酒馆中/IslandMilfCode数据库转发桥.json`
- `shujuku/导入到酒馆中/acu-form-fill-prompt-fixed.json`
- `scripts/verify-shujuku-v2-virtual-relay.mjs`
- `scripts/sync-shujuku-role-bridge.mjs`
- `shujuku/adapter.ts`
- `docs/shujuku-save-404-root-cause-2026-08-11.md`

**交接结论（旧版，已被上方 2026-08-12 纠正覆盖）**：当前本地桥对“合法空 operation 的远端误报”已有 fail-closed 兼容和合同测试。旧结论曾把默认 `<tableEdit>` 错标成需要替换的 legacy DSL；该判断撤销。现在的现场验收目标是确认 `6.3.1` 桥先用 guide 补齐空 runtime 表结构，再让原生 `group_fill` 产生显式提交并持久化；如果仍出现同一错误，再根据真实 `saveResult.operations` 定位远端提交路径。
