# shujuku v2 问题与约束边界（2026-08-09）

状态：`reported-next-window`

本文件是下一窗口的唯一问题边界，不是实现方案，也不是已修复声明。旧的直连逻辑回合方案、mock 合同和 harness/v1 楼层经验都不能作为 v2 的默认答案。

## 1. 已确认事实

- `[已检查]` 权威参考只使用：
  - `E:\web\最简单同层\tavern_helper_template-main\src\shujuku-main\API_DOCUMENTATION.md`
  - `E:\web\最简单同层\tavern_helper_template-main\src\shujuku-main\syntax-reference.md`
- `[已检查]` 真实 `AutoCardUpdaterAPI` 文档提供表快照导出/导入/恢复、`triggerUpdate`、`manualUpdate` 和表格 CRUD 等接口。
- `[已检查]` 先前接入依赖的三个“规划/更新/取消逻辑回合”接口不在真实文档和公开 API 中。
- `[已执行]` 当前项目已删除上述三个自造接口的桥 action、adapter 调用链、提交入口调用和对应 mock 验证脚本。
- `[已执行]` 角色桥现在只承担文档中真实存在的表快照探测、导出、恢复和导入转发。
- `[已执行]` 正文提交不再因为缺少三个自造接口而自动取消 shujuku 路线或在生成前卡死。
- `[未执行]` 真实酒馆中的 shujuku 规划、qrf 写回、数据库提交、重 roll 和开关持久化均未验收。

## 2. 当前问题

1. 重 roll 后的时间基线仍需现场复现，具体步骤、回滚目标和期望时间必须当场记录，不能从旧测试推断。
2. 回溯后没有看到本轮 shujuku 剧情规划 prompt 或调用证据，流程随后卡住。
3. 设置页显示“已连接”且路线已选中，但用户报告点击行为异常。必须分别记录“用户请求值、持久化值、连接探测结果、实际提交路线”，不能把其中一个值代替另外三个。
4. 删除错误接口后，当前正文只能证明 `generateRaw` 返回并写入了逻辑 assistant；它不能证明 shujuku 已规划或已提交数据库。

## 3. v2 真同层硬边界

1. SillyTavern 宿主聊天只有一个真实 `#0`。
2. user、assistant、qrf、正文和数据库证据属于 `#0` 内的逻辑时间线；不得创建、隐藏或删除真实 `#1/#2` 来替代它。
3. 不得用 CSS 隐藏楼层、`is_hidden`、`is_system` 或真实 host user/assistant 桥楼层冒充 v2 同层。
4. 可以在 shujuku 调用窗口内把卡侧维护的临时 `chat[]` 转发给 shujuku，让它运行自己的规划、qrf 和填表逻辑；但不得把这套转发 runtime 宣称为宿主原生楼层或原生 `chat[0]` 提交。
5. 当前目标不是宿主持久化，而是 shujuku 是否真正消费这套虚拟 `chat[]` 并执行自己的逻辑；结果由卡侧自己的存储承接。
6. harness 或 same-layer skill 中要求真实 user/assistant 楼层的 v1 模式不适用于本项目 v2；这里只能借用“三种结果必须分开取证”的原则。

## 4. 路线与数据权威

- Island 路线：Island 管理剧情记忆与提示词；现有硬状态、手机、存档和重 roll 规则继续生效。
- shujuku 路线：目标是由 shujuku 原生规划、召回和填表；Island 只保留游戏硬状态。这个目标当前没有完成接线证据。
- `shujuku 剧情路线` 的用户请求值不得因为缺少自造能力而自动反勾选或改成 Island。
- 连接状态是探测结果，不是开关值。UI 必须把“已请求”“已连接”“需复核”分开表达。
- 实际提交路线必须在每轮生成开始时记录，不能从设置页标签反推。
- 旧存档、回溯快照和重 roll 恢复不得静默覆盖用户当前的路线选择；精确优先级需在下一窗口结合现场行为确定。

## 5. 三条独立证据

| 结果 | 本轮有效证据 | 不能作为证据 |
| --- | --- | --- |
| 剧情规划/qrf | 当前逻辑 user 对应的本轮 prompt、调用和 qrf 写回 | 旧 qrf、表摘要、设置页“已连接” |
| 正文 | 当前逻辑 assistant 的完整可见正文及持久化读回 | 规划成功、旧 assistant、流式占位 |
| 数据库提交 | shujuku 本轮原生更新回执、storageFrame/表快照及同轮身份 | 仅脚本加载、仅表已存在、审核面板文案 |

任何一条成功都不能升级另外两条为成功。尤其不能用正文生成成功伪造规划或数据库提交。

## 6. 允许与禁止

允许：

- 使用真实公开 API 做表快照探测、导出和恢复。
- 保留 `AbortController`、generation id、`stopGenerationById` 等真实生成取消机制。
- 在不声称 shujuku 成功的前提下保存已经生成的正文。
- 用真实浏览器现场证据记录 prompt、事件、逻辑消息 ID、表快照和时间。

禁止：

- 再增加不存在的 public API、headless logical-turn API 或对应 mock。
- 用普通生成结果补造 qrf、storageFrame、table hash 或“完整审核”。
- 用旧表、旧 qrf、旧快照或静态 UI 文案宣称本轮成功。
- 为通过测试而修改真实 shujuku 参考源码或重新创建本地 `shujuku-main` 副本。
- 把自动测试通过写成真实酒馆验收通过。

## 7. 下一窗口复现顺序

1. 记录刷新后的路线请求值、持久化值、探测结果和 UI 文案。
2. 从原始提交入口记录本轮实际路线与 generation id。
3. 沿 prompt 路由查找 shujuku 原生规划 prompt、调用开始、调用结束和 qrf 写回。
4. 只在正文完整持久化后检查 shujuku 原生数据库更新生命周期。
5. 对同一回合执行重 roll，记录目标 user 的回滚前时间、快照时间、恢复后时间和新正文时间。
6. 分别验证关闭路线、开启路线、刷新和回溯，不合并成一个“按钮正常”结论。

## 8. 现场证据

- 脚本加载与“已连接”界面：`C:\Users\eriri\AppData\Local\Temp\codex-clipboard-eeba7441-6e21-4401-8e68-991cc0426119.png`
- 接通点前重 roll 被停止：`C:\Users\eriri\AppData\Local\Temp\codex-clipboard-8396fcd4-4523-467e-93f4-8a611fcb5449.png`
- 回溯后卡住与文件请求错误：`C:\Users\eriri\AppData\Local\Temp\codex-clipboard-da9c0dff-8947-4feb-b203-9b0b1ea0c27c.png`
- 正文被错误逻辑回合链阻断：`C:\Users\eriri\AppData\Local\Temp\codex-clipboard-a775c9fd-b16a-42a1-9a65-37a6b654666f.png`

## 9. 本轮停止点

本轮只清除不存在的接口、同步角色桥 JSON 并锁定约束。真实 shujuku 接线、重 roll 时间修复和路线开关现场修复留到下一窗口；在取得真实运行证据前不再设计替代协议。

## 10. 本轮调研补充：`chat[0]` 虚拟转发方案的判定

本节采用当前卡的实际验收口径：不要求 shujuku 把数据原生写入宿主 `chat[0]`，也不要求创建真实 user/assistant 楼层；只要求 shujuku 在一条由卡侧维护的临时 `chat[]` 上执行自己的规划、qrf 和表格逻辑，结果再由卡侧自己的状态存储接住。

### 10.1 参考项目为什么算成功

`E:\web\最简单同层\tavern_helper_template-main\src`（排除 `src\shujuku-main`）的 `same-layer-bridge\bridge.js` 已有完整链路：

1. `buildVirtualTimeline()` 把真实 `#0` 的开场文本和卡侧逻辑 user/assistant 组装成临时数组。
2. `openShujukuVirtualSession()` 在 shujuku 调用窗口内，把 shujuku runtime 看到的 `SillyTavern.chat`、读写消息接口和 `saveChat` 接到这份数组；`saveChat` 只被观察和拦截，不要求宿主落盘。
3. 通过 shujuku 已包装的 `TavernHelper.generate()`（非流式、静默）运行规划/生成。规划结果从当前虚拟 user 读取 `qrf_plot*`，而不是由卡侧手写。
4. 生成正文后把当前逻辑 assistant 追加到同一虚拟数组，再调用 shujuku 的 `triggerUpdate()`，让它按自己的逻辑从完整 `chat[]` 填表；表帧/表快照随后复制进卡侧自己的逻辑状态。
5. 关闭会话并恢复 API 后，UI 只显示卡侧状态。宿主是否有真实 `#1/#2` 或 shujuku 是否原生持久化，不是这条适配链的必要条件。

因此，按本节口径，这不是“伪造 shujuku 结果”：shujuku 的规划、qrf writer 和填表函数确实在它自己的运行时里执行，只是输入/输出边界由卡侧提供临时数组和自己的存储。只有把它宣传成“宿主原生楼层提交”时，才是超出事实的说法。

### 10.2 当前 `islandmilfcode` 为什么是假接通

当前卡的 shujuku 路线仍在 `actions\index.ts` 中直接调用 `win.generateRaw()`；同一处调试记录明确写入 `planning: 'not-run'` 和 `tableCommit: 'not-run'`。这只能得到一段正文，不能让 shujuku 规划或填表。

当前 `shujuku\IslandMilfCode数据库转发桥.js` / `shujuku\adapter.ts` 也只是表快照的 `probe`、导出、恢复/导入转发。它没有把生成调用接到 shujuku 包装器，没有建立临时 `chat[]`，也没有在本轮正文后调用 shujuku 的 `triggerUpdate()`。所以点击后看起来是 shujuku 路线，实际仍是 Island 的原生 `generateRaw` 路径；这是“路线标签成功、shujuku 逻辑未运行”的假成功。

### 10.3 目标链路（不含宿主持久层）

```text
卡侧自己的逻辑状态
  -> 临时 virtual chat[]（#0 开场 + 历史逻辑消息 + 当前 user）
  -> shujuku 包装 generate（规划/qrf）
  -> 当前 virtual assistant
  -> shujuku triggerUpdate（按自身逻辑填表）
  -> 读取 qrf/正文/表结果
  -> 写回卡侧自己的存储
```

本轮只确认上述架构差异，不宣称真实酒馆现场已经跑通；下一步若实现，只需把当前卡的 `generateRaw` 分支接到这条虚拟数组链，不能继续把“表快照转发桥”当成完整 shujuku 接通。
