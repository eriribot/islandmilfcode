# shujuku、存档与 404 根因诊断

**日期**：2026-08-11  
**范围**：只读诊断；本轮没有修改代码、删除存档或清理 registry。  
**结论状态**：解析器/虚拟桥/DICE/存档 404 四条链已经分离；仍有两项时间点证据未闭合（见末尾）。

## 结论先行

当前看到的“更新出错但流程继续”和两个固定 404，不是一个根因：

1. **shujuku 填表错误**：模型输出了运行时不认识的 `insertOrReplaceRow`。远端 `spv8.9.2` 解析器只接受 `insertRow`、`updateRow`、`deleteRow`，所以把后续命令吞进第一条 JSON，抛出 `Unexpected non-whitespace character after JSON`。
2. **错误被包装成 committed**：本地虚拟桥在 native `storageFrame` 不可见时，只要 `triggerSucceeded && tableChanged`，就自行生成 `bridge-export` frame，并把本轮标成 `databaseCommitted`。因此“部分命令成功 + 部分命令解析失败”仍会进入 `logical-assistant-saved`。
3. **DICE 历史数据楼层错误**：DICE v6.32 的回写扫描只认旧的 `independentData`/`TavernDB_ACU_Data` 等字段；当前虚拟层把数据放在 V2 `TavernDB_ACU_IsolatedData[isolationKey].storageFrame`。这是格式/拓扑不兼容，不是 HTTP 404。
4. **两个固定 `/user/files` 404**：archive registry 仍保留旧 manual save 的两个 root hash，但对应物理文件已不存在。每次 GC 扫描 live roots 都重复读这两个 URL，得到 404，然后把 GC 置为 `deferred`。这条链不由 shujuku 填表触发，也没有证据显示是本轮 shujuku 删除的。
5. **另有 CDN 404**：`spv8.9.2/index.js` 仍引用旧的 `./data/storage/...` 路径，而仓库实际目录是 `src/data/storage/...`。这是脚本资源加载链，和上面的 JSON 解析错误、archive root 404 都是独立问题。

## 1. shujuku 解析器：直接根因

### 运行时入口

当前数据库 iframe 的实际脚本是：

```text
TH-script--数据库本体--6dbc4d39-1130-4c0f-9f8c-fbe7eff06a68
  -> https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@spv8.9.2/index.js
```

控制台堆栈（已执行）：

```text
parseTableEditCommandLine_ACU (index.js:49501 / 49518)
parseAndApplyTableEditsToData_ACU (index.js:49554)
runTableWriteTransaction_ACU (index.js:39632)
runTableUpdateCommit_ACU (index.js:77055)
triggerUpdate (index.js:103070)
```

本轮实际输入包含：

```text
insertRow(6, {...})
insertOrReplaceRow(12, 1, {...})
insertOrReplaceRow(12, 2, {...})
...
insertOrReplaceRow(12, 5, {...})
```

远端源码检查（已执行）：

```js
/^(insertRow|deleteRow|updateRow)\s*\((.*)\);?$/
/(?:^|;\s*)((?:insertRow|deleteRow|updateRow)\s*\()/g
```

`insertOrReplaceRow` 不在两个正则中。由于第一条 `insertRow` 的 JSON 仍在解析器看来没有结束，后续文本被保留在 `jsonPart` 中，`JSON.parse` 在 `}) insertOrReplaceRow` 处报 trailing content。这正好对应日志中的：

```text
SyntaxError: Unexpected non-whitespace character after JSON
```

### 为什么模型会生成这个命令

当前表的合同互相冲突：

- [shujuku/island-memory-v3.json](../shujuku/island-memory-v3.json) 的 `检定建议表` 要求固定 5 行、`row_id=1..5`，每轮覆盖写入。
- 同一 note 的 `initNode/updateNode` 示例使用 SQL `INSERT OR REPLACE`。
- 当前实际运行的 legacy prompt/DSL 只教 `insertRow/updateRow/deleteRow`，不提供 upsert/replace 命令。

因此模型为了表达“固定行覆盖”自行发明了 `insertOrReplaceRow`。这不是 sanitizer 产生的字符串，也不是本地桥接层的替换：在项目源码、当前 chat JSONL、设置和存档对象中均未找到该字面量的生成代码；它出现在本轮模型输出中。

### 不是“整轮原子失败”

远端 `parseAndApplyTableEditsToData_ACU` 的行为是：

1. `finalCommandLines.forEach(...)` 逐条解析。
2. 单条解析失败时记录错误并 `return`，不抛出终止整个循环。
3. 末尾仍返回：

```js
{ success: true, modifiedKeys, appliedEdits }
```

所以合法命令可能已经写入，坏命令被跳过，外层仍看到 `success: true`。当前捕获的诊断里，`triggerResult` 为：

```json
{
  "success": true,
  "modifiedKeys": [
    "sheet_quan_ju_shu_ju_biao",
    "sheet_zhu_jue_xin_xi_biao"
  ]
}
```

同一兼容性快照中，只有“全局数据表”和“主角信息表”带 `_lastUpdateStats`，而“恋爱心迹表”和“检定建议表”没有被这轮合法命令写入。这是“部分命令落地”的证据；它不能单独证明 10:35 这一轮已经写入磁盘，只能证明当前运行路径具有该行为。

## 2. 虚拟桥为何把失败回合标成 committed

文件：[shujuku/IslandMilfCode数据库转发桥.js](../shujuku/IslandMilfCode数据库转发桥.js)

关键路径：

| 位置 | 行为 |
|---|---|
| 28、1396-1431 | `DATABASE_POLL_ATTEMPTS=60`，轮询当前虚拟 assistant 的 storage frame |
| 1465-1470 | 仅比较触发前后的完整导出，得出 `tableChanged` |
| 1482-1504 | native frame 不可见时，用导出结果构造 `bridge-export` frame |
| 1521-1528 | `databaseCommitted` 只检查 trigger 成功、上下文读取、插件字段、frame 变化和有表对象 |
| 1553-1570 | 把 `databaseCommitted`、`tableChanged`、`storageFrameSource` 写入结果诊断 |

当前回合的实际诊断（已执行）：

```json
{
  "triggerResult": {
    "success": true,
    "modifiedKeys": [
      "sheet_quan_ju_shu_ju_biao",
      "sheet_zhu_jue_xin_xi_biao"
    ]
  },
  "databaseSaveCallsAfterTrigger": 0,
  "storageFrameSource": "bridge-export",
  "nativeStorageFrameObserved": false,
  "databasePollAttempts": 60,
  "storageFrameChanged": true,
  "tableChanged": true,
  "databaseSaveObserved": false
}
```

这解释了日志顺序：先出现 shujuku JSON parse error，随后仍出现 `shujuku:logical-assistant-saved` 和 `tableCommit: committed`。`actions/index.ts:2248-2275` 只依据 `shujukuTurnResult.databaseCommitted` 记录成功并更新 runtime table snapshot，没有独立检查 parser 错误、`appliedEdits` 完整性或目标表覆盖数量。

**根因边界**：parser 负责“坏命令仍可被跳过”；虚拟桥负责“只要有任意导出变化就当成整轮数据库提交”。两者叠加才产生“控制台报错、流程却继续”的表象。

## 3. DICE “找不到历史数据楼层”

控制台顺序（已执行）：

```text
[DICE] 已加载表格数据，包含 14 个工作表
[DICE] 检测到数据更新，应用 3 条规则
[DICE] applyToTable: 成功应用 1 处转换
[DICE] 自动替换完成，共影响 1 处数据
[DICE] 自动转换后保存数据失败：找不到该表的历史数据楼层
```

DICE v6.32 `stable.js` 的回写函数只遍历 assistant 消息里的旧字段：

```text
independentData
TavernDB_ACU_IndependentData
TavernDB_ACU_Data
TavernDB_ACU_SummaryData
```

当前 #0 assistant 的结构化数据实际位于：

```text
TavernDB_ACU_IsolatedData[bcf5f344-51a5-4bec-b4e0-35af69979b0c].storageFrame
```

其中包含 V2 `version/headRevision/checkpoint/logEntries`，没有 DICE 正在查找的 `independentData`。因此 DICE 可以通过 `AutoCardUpdaterAPI.exportTableAsJson()` 读到 14 张表，却找不到可写的旧历史楼层。该错误是 **DICE 与 V2 storageFrame 的格式不兼容**，不是 HTTP 404，也不是 archive registry 的两个缺失 root。

## 4. 两个固定 `/user/files` 404

### 直接证据

registry：

```text
F:\SillyTavern-Launcher\SillyTavern\data\default-user\user\files\islandmilfcode-archive-registry-v3.json
```

当前 registry 仍保留 manual entry：

```text
saveId: 6614a5d5-b210-46f4-a84f-0e88b6604899
root: sha256:105d6e2d5e5b54490dde7a76a53d8a5427f300f589338116d9af5ebbc683fd00
previousRoot: sha256:13322fdb17024923a5a2e02b6b5f3b10cb5e5a9cc04f9094e144edad9b67cd97
```

两份物理 root 文件都不存在。Chrome Network 中反复出现：

```text
GET /user/files/islandmilfcode-v3-root-sha256-13322fdb...json [404]
GET /user/files/islandmilfcode-v3-root-sha256-105d6e2d...json [404]
```

当前 autosave 的 root 文件则能正常读取（200）。因此两个 404 是稳定、可重复的悬空引用，不是随机网络抖动。

### 调用链

文件：[savesolt/IslandMilfCode本机存档桥.js](../savesolt/IslandMilfCode本机存档桥.js)

```text
registry live entries 保留旧 root/previousRoot
  -> readArchiveGraphObject 读取 root（约 1040-1073）
  -> /user/files 返回 404
  -> live graph incomplete（约 1090-1121、1357-1386）
  -> deferArchiveGc（约 1311-1327）
  -> lastGc.status = deferred，tombstone 保留
```

当前 registry 的 `lastGc` 也记录了同一事实：

```text
status: deferred
registryLock: web-locks
blocker: root/sha256:13322fdb... 不存在
```

**结论**：这两个固定 404 来自存档 archive GC 的完整性检查。它们不会改变 shujuku 的 parser 规则，也没有证据表明 shujuku 写表会删除这些 root。shujuku 与存档桥只是在同一个酒馆页面同时运行，日志时间相近造成了“可能互相影响”的观感。

## 5. 另一个 CDN 404（独立链）

入口脚本：

```text
https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@spv8.9.2/index.js
```

该脚本仍引用：

```text
./data/storage/script.js
./data/storage/scripts/extensions.js
```

对照仓库实际目录为 `src/data/storage/...`。因此下面两个资源会返回 404：

```text
https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@spv8.9.2/data/storage/script.js
https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@spv8.9.2/data/storage/scripts/extensions.js
```

入口 `index.js` 本身仍返回 200 并执行到解析器，所以这条 CDN 404 不是本轮 `insertOrReplaceRow` 错误的直接原因；它可能影响设置桥/旧资源加载，需单独处理。

## 6. `_lastUpdateStats` 的独立缺口

文件：[shujuku/adapter.ts](../shujuku/adapter.ts)

- `relayExportTables`（493-501）和 `relayRestoreTables`（504-516）已使用 `applyDurableProjection`。
- `probeShujukuRuntime`（444-460）仍直接把 `tablesResult.tables` 放入 `tableSnapshot`，没有投影。

因此 compatibility probe 路径仍可能把运行时派生字段（例如 `_lastUpdateStats`）写入快照。这解释了早先的 `$.sheet_quan_ju_shu_ju_biao._lastUpdateStats missing` 兼容性问题，但它与本轮 parser/DICE/archive 404 是独立缺口。

## 7. 证据账本

| 断言 | 状态 | 证据 |
|---|---|---|
| `insertOrReplaceRow` 不被 `spv8.9.2` 解析器接受 | **passed（已执行）** | 远端源码正则、当前控制台堆栈 |
| parser 可部分应用并仍返回 success | **passed（已执行/源码）** | `forEach` + 固定 `{success:true}` 返回；`modifiedKeys` 诊断 |
| 虚拟桥可把部分变化包装成 committed | **passed（已执行）** | `bridge-export`、`nativeStorageFrameObserved:false`、`databaseSaveObserved:false` |
| DICE 历史楼层错误源于旧字段查找 | **passed（已执行）** | DICE `stable.js` 函数与 #0 `storageFrame` 结构对照 |
| 两个 `/user/files` 404 来自悬空 root | **passed（已执行）** | registry、物理文件检查、Network 404、GC blocker |
| CDN 两个 404 与 archive 404 是同一请求 | **failed（反证）** | URL、调用链、资源类型完全不同 |
| 旧 manual root 的确切删除时刻 | **not run / unknown** | 当前能证明“引用悬空”，不能从现有 registry 反推出删除者和时间 |
| 10:35 parser 失败命令是否已落盘到最新 autosave | **not run / unknown** | 当前 autosave 时间/快照晚于或早于不同运行片段，缺少该回合唯一 revision 对应关系 |

## 8. 未修改与后续验证边界

本轮未做以下操作：

- 没有修改 `shujuku` prompt、DSL 或 parser。
- 没有打开 strict JSON 开关。
- 没有删除 registry 条目、root 文件或 tombstone。
- 没有重写现有存档。

若后续要修复，必须分别授权并分别验收：

1. **DSL/prompt 合同**：让固定 1~5 行使用运行时真正支持的操作，或让 parser 接受明确版本化的 upsert 合同。
2. **提交判定**：把 parser 的失败/部分成功状态传到桥，禁止仅凭 `tableChanged` 生成 committed。
3. **DICE 兼容**：为 V2 `storageFrame` 提供 DICE 可识别的历史楼层写回路径，或明确停用旧 DICE 自动回写。
4. **archive registry**：先保留旧引用做人工取证，再决定恢复 root、标记失效或清理 registry；不能把 shujuku 修复和存档清理混为一个动作。

---

**文档版本**：v0.1（只读根因报告）  
**证据时间**：2026-08-11  
**工作树状态**：原有用户修改均保留；本次仅新增本文件。
