# 艾尔登特经验库

## 目的

经验库保存已经在项目里证明有用的做法、检查项和防线。

不要迷信模板。只有当前任务真的需要保护这些规则时，才使用对应经验。

## 经验 001：艾尔登特审查门

适用：

- 任务边界不清楚。
- 涉及 UI 流程、prompt、路线、数据库、同层接通或自动化。
- 用户要求一步一确认。

做法：

- 先说清楚本轮能直接做什么、什么必须审查。
- 只在批准范围内改文件。
- 改完发出艾尔登特审查邀请。
- 没有人工审查表，不开下一轮。

命中标准：

- 人知道这轮改了什么。
- 高风险动作没有被偷偷执行。
- 自动化没有绕过审查。

## 经验 002：消息污染防线

适用：

- 摘要系统。
- 回溯 / 重新生成。
- 导入导出。
- prompt 历史拼装。

不能破坏：

- `lastSummarizedIndex` 只前进。
- 唯一允许回退的情况：它超过实际消息总数。
- 摘要覆盖范围缩小，不代表旧消息可以重新进 prompt。

检查：

- 有没有无条件设置 `lastSummarizedIndex = maxCovered + 1`。
- 有没有区分“摘要为空”和“消息不存在”。
- 回退前有没有检查 `conversationCount`。

## 经验 003：代码做裁判，世界书说话

适用：

- 多角色 AIRP。
- 世界书角色卡很长。
- 关键词容易误触发完整角色卡。
- 当前场景只需要少数角色完整上下文。

不能破坏：

- TypeScript 状态层判断当前需要哪些卡。
- 世界书保存完整角色资料。
- 控制器按 `activeCardIds` 加载条目。
- `relationship.ts` 只补短关系叠层，不塞完整角色卡。

命中标准：

- 角色不抢戏。
- prompt 不被常驻卡压爆。
- User 已建立的事实能压过原著惯性。

## 经验 004：同层操作必须回到真实宿主楼层

适用：

- 同层卡。
- shujuku / ACU / qrf_plot。
- `bridgeapi_shujuku`。
- iframe UI 需要触发宿主生成或数据库更新。

不能破坏：

- 宿主聊天楼层是权威。
- hidden real user / assistant 楼层承载原生链路。
- UI 本地状态不能冒充宿主成功。
- 成功以后要从宿主状态回读。

命中标准：

- 宿主楼层真的变化。
- 世界书和数据库链路真的触发。
- 失败时人能看到失败原因。

## 经验 005：模块边界

适用：

- `index.ts` 继续膨胀。
- UI、状态、变量、prompt、动作、渲染互相串层。
- 新功能越来越难验证。

边界：

- `index.ts`：入口装配、初始化、生命周期、渲染调度。
- `state` / `store`：本地状态。
- `variables` / `adapter`：变量读取和写回。
- `prompt` / `message-format`：正文抽取、清洗、prompt 拼装。
- `actions`：发送、流式生成、通知、回溯、重新生成。
- `render`：状态到 HTML。

命中标准：

- 改一层不用理解全仓。
- 测试能针对单一职责写。
- 入口文件不继续变成业务黑洞。

## 经验 006：审查记录

适用：

- 任务跨文件。
- 修复杂 bug。
- 新增协议。
- 接入新模块。

记录：

```text
任务：
模块：
接通点：
使用经验：
改了哪些文件：
跑了哪些验证：
没碰什么：
已知风险：
审查邀请：
```

命中标准：

- 下一轮 AI 能恢复上下文。
- 已执行、已检查、仍是假设的内容分得清。
- 人的审查能变成具体修复清单。

## 经验 007：同层样式不要污染宿主

适用：

- Tavern Helper iframe / 同层 UI 把样式带进宿主。
- 头像或右侧角色图消失、变成 `0x0`。
- 图片资源已经加载，但布局塌了。

不能破坏：

- iframe 内部样式不能默认进入宿主。
- 只有卡片自己的命名空间样式可以带出去。
- 宿主头像和角色图不属于同层 UI 控制范围。
- 图片资源已加载但尺寸为 `0x0` 时，优先查 CSS / 布局。

检查：

- 检查被带到宿主的 style 是否包含 `html`、`body`、`*`、`#app` 等全局选择器。
- 拒绝宿主头像、角色图相关选择器和路径。
- 拒绝坏的占位 CSS，例如 `@import url("字体链接")`。
- 确认卡片自己的 scoped 样式还在。

命中标准：

- 同层 UI 样式仍正常。
- 宿主头像和右侧角色图不被改写。
- ACU / dice / shujuku 固定前端仍可见。
- hidden bridge floors 仍保留在真实宿主 chat 中。

## 经验 008：watch 内联产物不要使用 eval source map

适用：

- `pnpm watch` / development webpack 产物会被 Tavern Helper 或 SillyTavern 当作 HTML / script 加载。
- 使用 `HtmlInlineScriptWebpackPlugin`、`HTMLInlineCSSWebpackPlugin` 或同类内联插件。
- 浏览器或宿主报 `Uncaught SyntaxError: Unexpected token ':'`，但 TypeScript / webpack 编译本身通过。

不能破坏：

- 被宿主加载的最终 HTML / JS 里不能出现 `eval(`、`sourceMappingURL=data:`、`sourceURL=webpack-internal` 这类 eval sourcemap 标记。
- watch 产物需要使用外置 source map，例如 `source-map` 或 `cheap-module-source-map`，不能使用 `eval-*` / `inline-*` devtool。
- 构建通过不等于宿主可执行；必须检查最终 `dist/**/*.html` 或 `dist/**/*.js`。

检查：

- `pnpm build:dev` 后检查目标产物中 `eval(`、`sourceMappingURL=data:`、`sourceURL=webpack-internal` 数量应为 0。
- 抽取内联 `<script>` 后用 JS 语法检查确认脚本本体可解析。
- 若仍报 `Unexpected token ':'`，优先看宿主加载链路是否把 source map、TS 源码或 CSS 当脚本执行。

命中标准：

- watch 输出不再携带 eval sourcemap。
- HTML 内联脚本仍保留可调试的外置 `.map`。
- 宿主重新加载不再在 TypeScript 类型标注或 sourcemap 片段处报语法错误。

## 经验 009：生产 HTML 进正则替换前要避开 `$` replacement 元字符

适用：

- `pnpm build` 产出的 `dist/index.html` 会被整段塞进 SillyTavern / Tavern Helper 的正则替换“替换为”字段。
- 浏览器报 `Uncaught SyntaxError: Unexpected token ':'`，报错片段像 `:()=>c});const a={...}`，但抽出原始内联 `<script>` 直接做 JS 语法检查是通过的。
- webpack / Terser 生产压缩产物里出现 `$1`、`$4`、`$&`、``$` ``、`$'`、`$$` 或 `$<name>`。

不能破坏：

- 发布链路里的整段 HTML 不能被 JS `String.prototype.replace` 的替换字符串语义改写。
- webpack export 名不能被压缩成 `$4:()=>...` 这类会被当作捕获组引用的属性名。
- 源码里的正则替换不要写 `'$1'` / `'\\$&'` / `'$$'` 这类字面量；改用回调或 `String.fromCharCode(36)` 运行时构造。

检查：

- `pnpm build` 后抽取目标 `dist/**/*.html` 的内联 `<script>`，先对原始脚本做 `node --check`。
- 再用 JS 模拟 `replace(/X/, html)`，抽取替换后的 `<script>` 做 `node --check`；这个检查能复现正则“替换为”吞 `$n` 的问题。
- 扫描最终 HTML 中 `$` 后跟数字、`&`、反引号、单引号、`$`、`<` 的序列；正常产物不应出现这些 replacement 特殊序列。

命中标准：

- v07 等模块导出附近应显示真实导出名，例如 `buildPlotMachinePromptBlock:()=>...`，不能再出现 `$4:()=>...`。
- 正则替换模拟后的脚本仍可解析。
- 生产包贴入酒馆正则替换后不再因 `$n` 被吞而在对象字面量内部报 `Unexpected token ':'`。

## 经验升级规则

一条经验进入这里，至少满足两项：

- 解决过真实故障。
- 保护了明确规则。
- 能在不同任务复用。
- 有可执行检查项。
- 能降低人的审查成本。
