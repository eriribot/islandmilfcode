# Arsenal

## 目的

Arsenal 是 SRW Harness 的武器库。这里保存已经在实战中证明有用的打法、检查项和防线。

武器不是模板崇拜。每次使用前，AI 必须说明为什么当前任务适合这把武器。

## 武器 001：驾驶舱批准门

适用场景：

- 任务边界不完全清楚。
- 涉及剧情、角色、协议、数据结构、宿主楼层或自动化。
- 用户强调手操批准。

打法：

- 先分 A/B/C 级。
- A 级直接小步执行。
- B 级草拟方案，等待驾驶员批准。
- C 级停火等待明确指令。

命中标准：

- 驾驶员知道 AI 接下来会改什么。
- 高风险动作没有被默认执行。
- 自动化没有绕过人类发射键。

## 武器 002：消息污染防线

适用场景：

- 摘要系统。
- 回溯、重生成、导入导出。
- prompt 历史上下文拼装。

核心不变量：

- `lastSummarizedIndex` 只增不减。
- 唯一允许回退的情况是它超过实际消息总数。
- 摘要覆盖范围缩小，不代表历史消息可以重新进入 prompt。

故障表现：

- 旧消息重复进入 prompt。
- 生成编号继续增长，但上下文回到旧楼层。
- 导入存档后历史污染新对话。

检查项：

- 是否存在把 `lastSummarizedIndex` 设为 `maxCovered + 1` 的无条件逻辑。
- 是否区分“摘要空洞”和“消息不存在”。
- 是否在回退前检查 `conversationCount`。

## 武器 003：代码做裁判，世界书说话

适用场景：

- 多角色 AIRP。
- 世界书角色卡过长。
- 关键词误触发完整角色卡。
- 当前场景只需要部分角色完整上下文。

核心不变量：

- TS 状态层判断当前需要哪些卡。
- 世界书保存完整角色资料。
- 控制器根据 `activeCardIds` 加载条目。
- `relationship.ts` 只追加短关系叠层，不承载完整角色卡。

打法：

- 用事件、地点、activeTarget、实际说话角色和手机路由计算 `activeCardIds`。
- 只加载实际参与对话或行动的 2-3 张完整卡。
- 被提及、回忆、背景关系不拉起完整卡。

命中标准：

- 角色不抢戏。
- prompt 不被常驻 0 层卡压爆。
- User 影响能覆盖原著惯性。

## 武器 004：同层桥接真实楼层

适用场景：

- 同层卡。
- shujuku / ACU / qrf_plot。
- bridgeapi_shujuku。
- iframe UI 需要触发宿主生成和数据库更新。

核心不变量：

- 宿主真实聊天楼层是权威。
- hidden real user / assistant floors 承载原生链路。
- `SillyTavern.getContext().chat` 或等价宿主上下文是最终检查对象。
- UI 内部状态不能冒充宿主成功。

打法：

- UI 动作先转成真实宿主动作。
- 使用 hidden floor 保留原生规划和世界书扫描。
- `/trigger await=true` 等待生成完成。
- 成功后从宿主状态回读，而不是只信本地状态。

命中标准：

- 宿主楼层真实变化。
- 世界书和数据库链路触发。
- 失败时驾驶员能看到失败原因。

## 武器 005：模块分层

适用场景：

- `index.ts` 继续膨胀。
- UI、状态、变量、提示词、动作互相串层。
- 新功能越加越难验证。

核心分层：

- `index.ts`：入口装配、初始化、生命周期、渲染调度。
- `state` / `store`：本地状态。
- `variables` / `adapter`：变量读取和写回。
- `prompt` / `message-format`：正文抽取、清洗、提示词拼装。
- `actions`：发送、流式生成、通知、回溯、重新生成。
- `render`：状态到界面。

打法：

- 新功能先归类到现有职责层。
- 页面层不直接操作底层变量。
- 渲染层不触发生成请求。
- 提示词层不写 DOM。

命中标准：

- 改一层不会被迫理解全仓。
- 测试可以针对职责层写。
- 入口文件不再成为业务黑洞。

## 武器 006：战斗记录

适用场景：

- 任务跨文件。
- 修复复杂 bug。
- 新增协议。
- 接入新机体。

记录格式：

```text
任务：
主机体：
接驳点：
使用武器：
已执行：
已验证：
未触碰：
残余风险：
可沉淀：
```

命中标准：

- 下一次接手能快速恢复上下文。
- 已执行、已检查、仍是假设不会混在一起。
- 新打法能进入 Arsenal。

## 武器 007：同层样式隔离与宿主 CSS 防污染

适用场景：

- Tavern Helper iframe / testcard 同层 UI 会把样式 teleport 到 SillyTavern 宿主。
- 图片、头像、右侧角色图在 UI 挂载前可见，挂载后消失或变成 `0x0`。
- 关闭宿主预隐藏脚本后问题仍存在，说明根因不是预隐藏 JS。
- 控制台出现 stylesheet MIME 错误、坏字体链接、头像路径或角色图路径相关噪声。

遇到过的真实故障：

- V1.5 预隐藏方向一度误判为“继续改宿主导入脚本”。
- 驾驶员关闭导入脚本后，图片问题仍复现。
- Chrome 探针显示图片资源已加载，`naturalWidth` / `naturalHeight` 正常，但元素 `rect.width` / `rect.height` 为 `0`。
- 同层 UI 的 `teleportInlineStyles()` 曾经按 `paper-` / `reader-` / `DangGui` 等宽泛关键词复制 iframe 内所有 `<style>` 到宿主 `head`。
- 这会把 iframe 内的全局 reset、头像规则、角色图规则、坏 `@import url("字体链接")` 或其他卡的样式污染到 SillyTavern 宿主。

核心不变量：

- iframe 内部样式不能默认进入宿主。
- 只有 testcard 自己的命名空间样式可以 teleport。
- 宿主的 `.user_avatar`、`.char_avatar`、右侧角色图、`#avatar_load_preview`、`#right-nav-panel` 不属于同层 UI 的控制面。
- 不隐藏 `.acu-dice-ui-root.acu-mode-fixed`。
- 不隐藏 `#acu-nav-bar`。
- 资源已加载但尺寸为 `0x0` 时，优先查 CSS / layout，而不是先查图片路径。

成功打法：

- 先用驾驶员开关排除法判断根因是否仍存在：关闭宿主预隐藏脚本后仍复现，则停止继续改预隐藏脚本。
- 用 Chrome MCP 读真实宿主 DOM：
  - `style[data-testcard-true-same-layer-style]` 数量和内容。
  - 是否包含 `html,body`、`body`、`*`、`#app`、`.user_avatar`、`.char_avatar`、`User Avatars`、`/characters/`、`avatar_load_preview`、`avatar_div`、`right-nav`。
  - 图片元素的 `currentSrc`、`naturalWidth`、`naturalHeight`、`getBoundingClientRect()`、`display`、`visibility`。
- 修复 `teleportInlineStyles()`：
  - 拒绝全局 selector：`html/body/*/#app`。
  - 拒绝宿主图片和头像 selector / 路径。
  - 拒绝 `@import url("字体链接")` 这类占位符坏 CSS。
  - 只允许 Vue scoped 的 testcard 样式，例如 `.TestCardSameLayerHost[data-v-*]`、`.paper-workspace[data-v-*]`、带 `data-v-*` 的 reader / journal / DangGui / section-tab / washi / composer。
  - 非 scoped 例外必须逐个点名，例如 `.StreamingMessage--mark`。
- 如果 watch 自动更新 `dist/testcard/index.html`，只确认 dist 已同步，不额外手动改构建产物。

检查项：

- `rg` 确认源码和 dist 中都存在新的样式过滤规则。
- 单文件 TS transpile 或等价语法检查通过。
- 项目级 `tsc --noEmit` 若失败，必须区分本次文件错误和既有仓库错误。
- Chrome MCP 中 `style[data-testcard-true-same-layer-style]` 不应再包含宿主全局 reset、头像、角色图或坏字体占位符。
- 右侧图片如果仍 `0x0`，继续查宿主面板折叠状态、主题 CSS 和 SillyTavern 自定义 CSS，不再把它归咎于同层桥接写入链路。

命中标准：

- 同层 UI 样式仍能加载。
- 宿主头像和右侧角色图不再被 testcard teleport 的 CSS 改写。
- ACU / dice / shujuku 固定前端仍可见。
- hidden bridge floors 仍保留在真实宿主 chat 中，不因 UI 修复被删除。
- 复盘能明确写出“资源缺失”和“CSS 尺寸归零”之间的证据差异。

## 武器升级规则

一条经验进入 Arsenal 前，必须满足至少两个条件：

- 它解决过真实故障。
- 它保护了明确不变量。
- 它能被不同任务复用。
- 它有可执行检查项。
- 它能降低驾驶员判断成本。

不满足条件的经验只写进普通复盘，不升级为武器。
