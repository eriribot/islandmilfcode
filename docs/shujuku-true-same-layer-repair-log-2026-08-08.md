# shujuku 真同层修复失败链路与终止记录（2026-08-08）

## 结论

本轮修复终止。用户现场验收仍然失败，当前实现不得标记为已修复、可用或已接通。

最重要的终止原因是：当前 `shujuku/adapter.ts` 仍然依赖隐藏的 `TH-script--*` iframe，并在其中替换或模拟 `SillyTavern`、`TavernHelper`、`getContext()`、聊天读写和 `saveChat`。用户明确判定这种实现是伪同层，不能继续采用。后续不得再通过扩大 iframe 补丁、增加更多代理 API 或增加等待时间来包装成真同层。

当前工作区保留了本轮尝试过的源码修改，目的是保留失败现场；这些修改不是可交付方案。若以后重新开始，应先重新设计接线边界，再决定删除或替换这些尝试，不能以它们为成功基线继续叠补丁。

## 用户要求的真实合同

1. SillyTavern 宿主聊天始终只有真实 `#0`。
2. user、assistant、qrf 和数据库提交属于 `#0` 内的逻辑时间线，不能创建、隐藏或删除真实 `#1/#2` 来冒充同层。
3. 不允许依赖隐藏脚本 iframe 模拟宿主聊天链路；这种做法即使保持 `chat.length === 1`，也不算用户要求的真同层。
4. 正文、qrf、shujuku 原生表提交和单 `#0` 拓扑是四条独立证据，任何一条都不能替代另一条。
5. 填表必须由 shujuku 自己的 AI 插件根据当前原生表预设完成，Island 不创建自有表、不伪造表、不把审核面板显示当作提交结果。
6. 正文必须先显示并持久化，再允许 shujuku 原生填表完成；不能正文尚未生成就开始填表。
7. “完整审核”必须审核本轮真实 qrf、正文和原生表提交，不能展示旧表或静态内容冒充本轮审核。
8. 未完成 shujuku committed handoff，或用户关闭 shujuku 时，正文和重 roll 必须走原 Island 模型。
9. 重 roll 必须保留正确的路线语义，不能被旧存档快照中的 shujuku compatibility 反向覆盖。

## 现场失败链路

用户截图和 Chrome 现场曾出现以下顺序：

```text
assistant:generated
shujuku:assistant-visible-before-table
assistant:visible-before-table
qrf-wait:start
qrf-wait:failed
exchange:failed
exchange:session-restored
shujuku:post-processing-failed
submit:generate-returned
shujuku:assistant-committed
submit:main-success-before-phone
```

这条链明确失败：qrf 已失败，后面却仍然把 assistant 标为 shujuku committed，并继续记录主正文成功。手机因此一边显示“正文已保存，填表失败”，另一边又可能显示旧审核/旧表状态，造成假成功。

后续源码尝试阻止了 `qrf-wait:failed` 之后继续进入 `assistant-committed` 和 `main-success`，但用户再次现场验收后整体问题仍未解决，因此只能记为局部控制流修正，不能记为修复成功。

## 已确认不能再走的方法

### 1. 隐藏脚本 iframe 虚拟宿主

失败做法：在 `TH-script--数据库本体--*` 等隐藏 iframe 中构造 `virtualChat`，再替换 iframe 或宿主的 `SillyTavern/TavernHelper` API，让 shujuku 以为自己在读写普通聊天。

失败原因：这仍是 iframe 内的模拟链路，不是 `#0` 自身的原生同层能力。补丁范围从 iframe 扩展到 host 也不会改变这个事实。用户已经明确拒绝此架构。

结论：禁止继续扩展 `openVirtualSession()`、`patchRuntimeProperty()` 或更多 iframe 代理来尝试修好真同层。

### 2. 只补丁 iframe API，或同时补丁 iframe 与 host API

失败做法：先只替换 iframe 中的 `getChatMessages/setChatMessages/saveChat`，失败后再把 host 的同名 API 一起替换。

失败原因：两种做法都没有建立真实的 `#0` 原生提交语义，只扩大了全局污染和恢复失败的风险。API 恢复成功只能证明补丁撤销，不能证明 qrf、正文或数据库提交成功。

### 3. 使用已经被补丁的 `getContext()` 做拓扑证明

失败做法：通过虚拟 context 读取 `chat.length`，再把结果当作宿主只有 `#0` 的证据。

失败原因：被测对象和证明对象是同一个补丁，属于自证。拓扑只能由补丁前捕获的真实宿主 context 证明；即便真实宿主仍为一个 `#0`，也不能证明隐藏 iframe 内的虚拟聊天是真同层。

### 4. 只依赖 `automatic_trigger`

失败做法：外层 shujuku 生成和内层宿主生成只靠切换 `automatic_trigger` 来避免重复规划或提前填表。

失败原因：`automatic_trigger` 不能同时定义规划、正文、qrf writer 和数据库填表四条生命周期，也不能证明异步 writer 写到了本轮逻辑 user。现场仍出现 qrf 缺失和生命周期错误。

### 5. 给真实 Generate 参数注入 `quiet_prompt`

失败做法：把内部标记放进真实 Generate options，希望阻止 shujuku 在内层生成时重复触发。

失败原因：真实 `quiet_prompt` 会改变生成提示或被插件解释为静默生成，可能直接抑制本轮规划，且内部标记存在进入正文提示的风险。此方法不能再用。

后续尝试仅在宿主 `generation_started` 事件元数据上临时增加标记，但这仍依赖 iframe/事件代理，未能得到用户验收，也不是可继续使用的真同层方案。

### 6. 把 `js_generation_started` 当作宿主 `generation_started`

现场源码已确认：

```text
JS-Slash-Runner: js_generation_started(generationId)
SillyTavern:     generation_started(type, params, dryRun)
```

两者参数布局不同。不能对 `js_generation_started` 的第二个参数写 `quiet_prompt`，因为它根本没有该参数。简单把事件名加入同一处理集合会制造错误元数据。

### 7. 只轮询顶层 `qrf_plot*`

失败做法：只读取虚拟 user 顶层的 `qrf_plot`、`qrf_plot_tasks`、`qrf_plot_preset`。

失败原因：不同插件版本可能经 `extra` 或 `data` 提交字段，顶层轮询会漏报。

本轮又尝试兼容顶层、`extra`、`data` 并把字段归一到当前逻辑 user，但用户现场仍判定整体失败；因此这只能记为未被接受的兼容尝试，不能作为新基线。未来不能继续用“再支持一个容器”代替架构修复。

### 8. 依靠 hash、owner token 和 canonical user 路由修复 qrf

失败做法：给本轮虚拟 user 增加 input hash 和 owner token，将复制或替换后的 user 合并回 canonical user，并丢弃外来 qrf。

失败原因：这些标记只能约束虚拟对象归属，无法把隐藏 iframe 的虚拟写入变成真实 `#0` 原生提交。现场仍然出现“本轮虚拟 user 未产生 qrf”。

### 9. 增加等待次数或等待时间

失败做法：延长 qrf polling，等待 deferred writer。

失败原因：对象、事件或架构接错时，等待更久只会更晚失败，不会产生正确 qrf。不得把超时调整当作根因修复。

### 10. 把审核面板或旧表当作本轮 qrf/数据库证据

失败做法：看到 shujuku“完整审核”面板、已有原生表内容或表摘要，就宣布本轮已经规划或填表。

失败原因：面板可能显示旧状态；qrf 失败时旧表仍可见。审核 UI 不是 qrf writer 回执，也不是本轮数据库 `storageFrame/saveChat` 回执。用户已明确指出这是“假审核”。

### 11. Island 自己造表或自行填表

失败做法：Island 维护一套自己的表结构、表内容或审核数据。

失败原因：用户要求使用 shujuku 自带原生表和预设，由 shujuku AI 插件填表。Island 自造表改变了数据权威，不能继续。

### 12. 正文生成前触发原生填表

失败做法：把数据库更新挂在生成开始/结束事件上，导致正文尚未完整显示和持久化就开始填表。

失败原因：生命周期顺序错误，表插件读不到本轮最终 assistant 正文，且用户可见行为与提交状态不一致。

### 13. qrf 失败后仍标记 committed/main-success

失败做法：正文已生成就把整个 shujuku 回合标为成功，即使 qrf 或表提交失败。

失败原因：正文落盘、qrf、数据库提交是独立结果。正文存在不能升级为 shujuku committed。该控制流已在源码中尝试收紧，但整个架构仍未通过验收。

### 14. 重 roll 复用旧 user 的 `plannedText/qrf_*`

失败做法：重生成时仅替换 user 正文，不清除上次的规划字段。

失败原因：本轮 qrf 即使没有生成，旧规划仍会显示为本轮结果，形成假审核。本轮源码尝试清除顶层以及 `extra/data` 中的旧 qrf，但未获得最终现场验收。

### 15. 重 roll 后让旧 compatibility 快照恢复路线

失败做法：repository 中删除 shujuku compatibility，但 `restoreFloorStateSnapshot()` 又把目标楼层的旧 route 写回 `state.runtimeFlags`。

失败原因：这会导致用户关闭 shujuku 后，重 roll 仍走 shujuku；原 Island 模型按钮因此看起来也被修坏。本轮源码尝试在恢复快照后立即应用显式 `shujukuCompatibilityOverride: null`，但未进行用户最终验收。

### 16. 自动把 `needs_review` 恢复成 committed

失败做法：只要运行时再次可见或表快照存在，就把未确认连接自动提升为 committed。

失败原因：会绕过 handoff、隔离码、分支和表哈希等真实边界，把旧状态当新连接。必须保持 Island fallback，不能自动升级。

### 17. 只改源码或 dist，不确认当前 blob

失败做法：源码或 `dist/islandmilfcode/index.html` 已更新，就认为 Chrome 当前页面也执行了新代码。

失败原因：JS-Slash-Runner 运行的是已注入 blob。现场曾确认 dist 已含新标记，但当前 `TH-message--0--0` 仍执行旧 blob，因此旧日志持续出现。源码时间戳、dist 字符串和页面执行版本必须分别记录。

本轮结束前没有刷新页面，也没有触发新的生成验收，因为用户要求写文档后结束。

## DICE 独立错误

现场还出现：

```text
[DICE] 自动转换后保存数据失败：
保存 "主角信息表" 的正则转换结果失败：
找不到该表的历史数据楼层
```

该错误说明 DICE/表扩展仍在寻找真实历史楼层，与“宿主只有一个真实 `#0`”的合同冲突。它不是 qrf 成功证据、不是 shujuku 原生表提交证据，也不能由 Island 审核面板掩盖。通过隐藏虚拟楼层满足它同样属于伪同层，不可采用。

## 本轮源码尝试（均未通过最终验收）

- `actions/index.ts`
  - 区分“正文已落盘”和“shujuku 完整提交”。
  - qrf/填表失败时尝试保留正文，但停止 accepted callback、assistant committed 和后续成功状态。
  - 重用 user 时清除旧 `plannedText` 及顶层、`extra/data` 中的 qrf 证据。
- `index.ts`
  - 将 `shujukuCompatibilityOverride: null` 传给重 roll 归档截断。
  - 恢复楼层快照后再次应用显式 route override。
- `state/archive-repository.ts`
  - 支持截断时显式删除或替换 shujuku compatibility。
- `shujuku/adapter.ts`
  - 尝试区分正文显示、qrf 等待和表提交。
  - 尝试 patch iframe 与 host API、绑定 canonical user、捕获 saveChat、兼容嵌套 qrf、记录 set/create/delete/save 形状。
  - 这些尝试仍建立在隐藏脚本 iframe 虚拟会话上，因此整体方案被用户拒绝。

## 以后重新开始时的禁止项

1. 不得从当前隐藏 iframe 虚拟会话继续加补丁。
2. 不得用更多代理 API、更多 hash、更多轮询或更多 console 日志冒充架构修复。
3. 不得创建真实隐藏 `#1/#2` 退回 v1 桥楼层。
4. 不得用旧审核表、表摘要或 UI 文案宣告本轮成功。
5. 不得让 Island 自建表替代 shujuku 原生表。
6. 不得在正文落盘前开始原生填表。
7. 不得在 qrf/表失败后记录 assistant committed 或 main success。
8. 不得在未 committed handoff 时阻断原 Island 模型。
9. 不得仅凭源码/dist 更新声称浏览器已运行新包。
10. 如果 shujuku 的原生能力只能存在于隐藏 userscript iframe，必须直接报告它与用户要求的真同层合同不兼容，不能再模拟成兼容。

## 验证状态

- 用户现场验收：**失败**。
- Chrome 现场检查：**执行过**，确认单真实 `#0`、旧 blob、qrf 失败后假成功日志及 DICE 历史楼层错误。
- 最新源码的完整生成链验收：**未运行**；用户要求终止。
- 单元测试：**未运行**。
- 验证脚本：**未运行**。
- 手动 build：**未运行**；已有 watch 进程曾自动更新 dist。
- lint：**未运行**。
- typecheck：**未运行**。

最终状态：任务按用户要求终止，当前代码不得作为成功修复交付。
