# V07 手机、路线与游戏开发初版交接 v0.2

> 生成时间：2026-07-11（Asia/Shanghai）
> 工作目录：`E:\web\tavern_helper_template-main\src\islandmilfcode`
> Git 分支：`main`
> 当前提交：`b2f0770f29070d9b7ef0ac82cdc20dd4a4edd866`
> 工作树：dirty，包含本轮 UI 源码改动、验证脚本、文档和未跟踪 `artifacts/`
> 本文定位：给新 Codex 对话直接接手的事实交接，不是“已经全部完成”的宣传稿

## 1. 新对话先做什么

按以下顺序执行，顺序不能颠倒：

1. 完整阅读本文。
2. 完整阅读用户已经填写的 `docs/v07-game-development-human-review-form-v0.2.md`。
3. 从填写结果中提取三项：下一轮允许修的问题、下一轮禁止碰的内容、下一轮完成标准。
4. 如果涉及正文、酒馆 API、状态写入或插件，再补充提取：允许改变的链路、禁止改变的链路、必须提供的运行证据。
5. 三项范围没有整理清楚前，不修改代码。
6. 没有填写后的人工审查表，不开启下一轮。

用户明确要求：玩家测试步骤必须写普通中文。尤其是进入路线的测试，不要让用户输入程序字段，也不要用内部英文名解释操作。

本轮已经停止继续加功能，只交付审查表和交接文档。

## 2. 这轮真正要解决的事

用户反馈过三个直接可见的问题：

1. 最新 push 后，webpack 单文件贴进酒馆正则时再次出现 `Invalid or unexpected token`，坏文本形如 `&¤tDate>=machine.promptWindow.start...`。
2. 手机桌面图标超过一页后无限向下延长，第三排显示不全；改分页后又出现轻点应用打不开。
3. 游戏开发页面按钮大小不协调，部分提示像开发者黑话，不像玩家能直接理解的话。

随后用户要求：初版收口时不能缺人工审查表和交接文档；路线必须提供可直接粘贴到“继续书写”的中文实例；用户会在新对话提交填写结果。

## 3. 当前结论，一句话版

手机分页、应用轻点修复、路线确认、路线结果保存、游戏开发页和六天固定结算已经有代码和自动检查；但“自然正文让企划页自动满足条件”和“已选路线 / 六天计划影响后续小说正文”尚未接通，整条流程不能标为正式可用。

## 4. 当前接通状态

| 范围 | 当前状态 | 证据口径 |
| --- | --- | --- |
| 手机桌面两页九宫格 | 已实现，最新构建待用户最终页面确认 | 12 项合同通过；真实 DOM 曾测量；最新全文替换后的正式页面仍需人工确认 |
| 手机应用轻点 | 源码已修复，最新构建待人工确认 | 真实 Chrome 定位为过早接管滑动；现改为横向移动达到 36px 才接管 |
| 路线条件齐全后的企划页展示 | 已接入真实状态读取 | 手机读取 memoryDB 中的第七卷状态并统一计算 |
| 玩家在企划页亲自确认路线 | 已接入真实状态写入 | 确认时校验日期和条件，写入自有存档，已选后锁定 |
| 游戏开发项目和六天计划 | 已接入真实状态读写 | 状态保存在自有存档；六天排满后按固定数值结算 |
| 自然正文自动更新路线条件 | **未可靠接通** | 正常正文后的状态整理没有要求输出第七卷路线条件；严格审查器只在仿真和本地预览调用 |
| 已选路线影响后续小说正文 | **未接通** | 正文生成没有读取已选路线结果 |
| 六天开发计划生成对应小说正文 | **未接通** | 周计划文本只保存在游戏开发状态中，没有送入主 AI |
| 酒馆外层真实消息 / shujuku / ACU 链 | 本功能按现有独立手帐流程保持隔离 | 手机操作不应创建外层楼层；尚未做本轮最终人工复验 |
| 整体正式可用 | **不能宣称** | 需要填写后的人工审查表，且正文前后两处断点仍在 |

艾尔登特准确表述：

> 路线选择、项目和周计划已接入真实自有存档的读取与写入；酒馆外层楼层按设计保持隔离；自然正文识别路线条件、路线选择驱动后续正文、周计划驱动正文均未接通。当前是候选初版，等待人工审查，不是正式流程。

## 5. 主要实现

### 5.1 webpack / 酒馆正则安全

`scripts/verify-host-bundle-safety.mjs` 会检查最终 HTML：

- 作为 JavaScript `String.replace` 的替换内容时，是否因 `$1`、`$&` 等形式被再次解释。
- 旧式 HTML 实体前缀是否会把正常代码误解成实体并产生 `¤`。
- 是否出现 Unicode replacement character。
- 内联脚本在原始、正则替换模拟、旧实体解码模拟三种情况下是否仍能解析。
- 第七卷模块导出名是否保持完整，没有变成 webpack 的危险短名。

最新产物检查中，以上风险计数全部为 0。这个检查证明产物本身没有已知坏字符，但用户仍需确认酒馆正则编辑器里确实全文覆盖了最新产物，而不是旧构建或局部覆盖。

### 5.2 手机桌面分页

相关文件：

- `phone/home-pagination.ts`
- `phone/render.ts`
- `phone/styles.css`
- `index.ts`
- `scripts/verify-phone-home-pagination.ts`

当前行为：

- 每页固定 3 × 3，共 9 个应用。
- 第二页承载音乐、画图、联网（功能开启时）和设置。
- 顶部人物区域和底部 Dock 不随九宫格横滑。
- 两个页点可以点击。
- 手机壳尺寸变化时，图标随壳宽缩放。
- 只有横向移动达到 36px 才接管手势；普通轻点继续交给应用按钮。

真实 DOM 测量记录：

- 修复前每行约 87.5px，单个图标块约 97px，第三排必然被裁。
- 修复后临时测量每行约 91.5px，图标块约 81.8px，不再裁切。
- 真实 Chrome 已证明应用路由本身可以打开；旧版轻点失败是分页容器过早抓取指针造成的。

边界：这些是真实定位和最新源码修复证据，但用户用 12:19:31 产物全文覆盖后的最终页面，仍需要审查表确认。

### 5.3 第七卷路线

主要文件：

- `plot-state-machine/v07.ts`
- `plot-state-machine/resolver.ts`
- `plot-state-machine/choice.ts`
- `plot-state-machine/memory.ts`
- `plot-state-machine/routing-context.ts`
- `phone/render.ts`
- `index.ts`

玩家看到的五个方向：

1. 和英梨梨、诗羽一起留下。
2. 自己留下继续创作。
3. 加入朱音的团队。
4. 自己离开并独立创作。
5. 和伙伴们一起离开。

路线条件最早从以下日期开始记录：

- `2013-02-25`：朱音压力、正式邀请、理解朱音、准备独立创作等。
- `2013-02-26`：第二作初稿、支持英梨梨挑战更高目标、认可诗羽作者身份。
- `2013-03-01`：惠进入共同企划并获得纠正、争论和制衡权。
- `2013-03-04`：英梨梨与诗羽共同反击、玩家得知此事、留下或离开的实际行动。

最终路线只能在 `2013-03-04` 至 `2013-03-31` 由玩家在手机“企划”页亲自确认。自由输入只能推动剧情事实，不能代替最后点击。

确认后的实际写入链：

```text
手机企划页
→ index.ts 的路线确认点击处理
→ confirmPlotRouteChoice() 再检查日期、条件和是否已经选过
→ commitPlotRouteChoice() 写入 memoryDB
→ persistConversation() 保存到自有存档
→ 手机和游戏开发页从同一处回读
```

路线一旦确认，同一存档不能直接改选。完整测试五条路线时必须使用五份独立副本。

### 5.4 游戏开发页

主要文件：

- `game-development/index.ts`
- `phone/render.ts`
- `phone/styles.css`
- `index.ts`

当前流程：

```text
尚未确认路线
→ 开发页锁定

已经确认路线
→ 填写游戏名、类型、主题、平台
→ 建立项目
→ 安排周一至周五的开发行动
→ 安排周末休整或约会
→ 六天排满后完成本周
→ 按固定规则改变项目数值
→ 保存上一周记录并进入下一周
```

项目和周计划保存在 memoryDB 的 `route:v07 / gameDevelopment.v1.state`。结算由 TypeScript 固定规则完成，AI 不负责重算数值。

不同路线会开放少量不同的行动；合作对象从当前角色状态读取，不按路线硬塞固定员工。

当前缺口：`[GAME_DEVELOPMENT_WEEK]` 文本虽然会生成并保存在 `lastSubmission.context`，但全仓没有把它送入下一次正文生成的调用。

## 6. 两个必须优先面对的真实断点

### 6.1 正文无法可靠推动企划页

正常主正文调用在 `actions/index.ts` 中固定使用 `skipProgress: true`，所以主 AI 不负责输出状态变化。正文完成后会另调 `buildProgressPrompt()` 做普通状态整理。

问题在于：

- `message-format.ts` 的 `buildProgressPrompt()` 可用字段中没有第七卷路线条件。
- 旧的 `buildStateDeltaInstruction()` 有相关字段说明，但当前正常正文流程不发送它。
- 严格的 `buildPlotFlagProposalPrompts()` 与 `reviewPlotFlagProposal()` 有日期和逐字证据检查，但目前只由 `scripts/simulate-v07-routing.ts` 和 `gamedevelop-preview/main.ts` 调用，正常生产正文流程没有调用。
- 解析器仍能识别某些路线字段，不等于模型会被可靠要求输出这些字段。

因此，过去把路线条件直接写进测试存档，只证明了后半段：

```text
条件已经存在
→ 企划页显示可选
→ 玩家确认
→ 开发页开放
```

它没有证明前半段：

```text
玩家输入自然剧情
→ AI 正文写出实际结果
→ 系统识别正文
→ 企划页更新
```

人工审查表第 3 节的正反例就是专门验证这个断点。若正例正文写对而企划页不更新，应把“接入严格正文证据检查”列入下一轮，而不是继续调 UI。

### 6.2 选定路线和周计划尚未进入正文

主正文的记忆注入可以读到已经存在的路线条件，但当前没有把玩家最终确认的路线作为正文上下文传入。游戏开发页生成的六天计划文本也只保存在本地状态。

所以当前只能验收：

```text
企划页确认路线
→ 结果保存
→ 开发页开放
→ 项目和六天计划保存、固定结算
```

当前不能验收或宣称：

```text
确认路线
→ 下一段小说自动进入该路线

完成六天计划
→ AI 自动写出这一周的开发剧情
```

## 7. 已执行验证

### 7.1 最新生产构建

`[历史已执行]` 最新源码构建使用：

```powershell
pnpm build
```

结果：通过，只有已有的 bundle 体积警告。产物：

```text
E:\web\tavern_helper_template-main\dist\islandmilfcode\index.html
LastWriteTime: 2026-07-11 12:19:31
Length: 1,108,082 bytes
```

本轮只新增文档，没有再改生产源码，也没有运行 `watch`。

### 7.2 手机分页合同

`[本次已执行]` 当前 PowerShell 环境可复现命令：

```powershell
node -e "process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'CommonJS',moduleResolution:'node'});require('ts-node/register/transpile-only');require('./src/islandmilfcode/scripts/verify-phone-home-pagination.ts')"
```

工作目录：`E:\web\tavern_helper_template-main`

结果：

```text
[phone-home-pagination] 12 contracts passed
```

这些合同保护每页 9 个、顺序不丢失不重复、越界页码回到合法范围、开启第 13 个应用时仍为两页。

### 7.3 第七卷路线仿真

`[本次已执行]`：

```powershell
node -e "process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'CommonJS',moduleResolution:'node'});require('ts-node/register/transpile-only');require('./src/islandmilfcode/scripts/simulate-v07-routing.ts')"
```

结果：

```text
v07 simulation passed: 78 assertions
```

它验证日期边界、错误证据拒绝、条件隔离、手动确认、确认后锁定等纯规则。它不验证真实正文会调用严格审查器。

### 7.4 酒馆正则 / 单文件安全

`[本次已执行]`：

```powershell
node src\islandmilfcode\scripts\verify-host-bundle-safety.mjs
```

结果：`ok: true`，一个内联脚本；原始和正则替换模拟后的字符长度均为 `997250`。以下计数全部为 0：

- `evalCount`
- `inlineSourceMap`
- `webpackInternalSourceUrl`
- `dollarExport`
- `emptyExport`
- `replacementSpecial`
- `legacyEntityPrefix`
- `currencySign`
- `replacementChar`

`hasFullPlotExport: true`。

### 7.5 工作树格式

`[本次已执行]`：

```powershell
git diff --check
```

结果：通过，无空白错误；仅提示当前 Git 设置未来可能把 LF 转为 CRLF。

### 7.6 当前失效的便捷命令

`[本次已执行并失败]`：

```powershell
pnpm simulate:v07-routing
pnpm exec ts-node --version
```

在当前终端均报：

```text
'ts-node' is not recognized as an internal or external command
```

`node_modules/.bin/ts-node.CMD` 实际存在，但当前 pnpm 命令没有正确解析它。上面 7.2、7.3 的 `node -e` 命令已经实际通过，可作为新对话的复现入口。不要在未获得下一轮范围前顺手修改 `package.json`。

## 8. 真实页面验证状态

已完成过的真实 Chrome 侦察：

- 页面为 `http://127.0.0.1:8000/`。
- 旧版第三排裁切的像素原因已测量。
- 应用路由本身可以打开。
- 旧版普通点击失败与分页容器过早接管指针一致。

仍待用户确认：

1. 最新 `12:19:31` 产物是否已经全文覆盖酒馆正则“替换为”。
2. 正式页面上第一页第三排是否完整。
3. 两页横滑、页点、固定 Dock 是否正常。
4. 轻点消息、企划、开发、设置是否都能打开。
5. 游戏开发按钮在实际手机壳中是否大小合适。

这些项目已全部写入 v0.2 人工审查表。自动截图和临时 DOM 修改不能代替用户对最新正式页面的验收。

## 9. 测试存档与恢复边界

用于此前仿真的目标存档：

```text
autosave_89cd6e7f-8be5-4ed3-a3f3-6f1c7cbbc979
```

未修改的恢复来源：

```text
6d5d6985-eed4-4f08-9413-a372ef06b7fc
```

`artifacts/v07-phone-pagination-ground-truth.md` 记录的已执行恢复结果：

- 时间：`2012-12-07 18:00`
- 当前事件：`SAE_06-1`
- 243 条聊天记录
- 45 条属性
- 无临时路线选择
- 无临时游戏开发状态
- 酒馆外层当时仍为 1 条消息

重要限制：恢复后为了 UI 测试又打开过这个存档。宿主第 0 条消息可能重新出现 `stat_data`，存档更新时间也可能改变。新对话如果要宣称“已经完全恢复”，必须重新只读核对，测试完成后再清理。

严禁解析、导入或把下面文件当恢复源：

```text
artifacts/live-save-baseline-before-v07-simulation.json
```

该文件约 32MB，曾被浏览器工具截断，不是可信备份。只使用明确标记的未修改 IndexedDB 存档来源。

## 10. 当前工作树

本交接写入前的 `git status --short`：

```text
 M game-development/index.ts
 M humanpending.md
 M index.ts
 M phone/render.ts
 M phone/styles.css
 M progress.md
 M state/store.ts
 M types.ts
?? artifacts/
?? phone/home-pagination.ts
?? scripts/verify-phone-home-pagination.ts
```

本轮随后新增：

```text
docs/v07-game-development-human-review-form-v0.2.md
docs/v07-game-development-handoff-v0.2.md
```

注意：

- 不要回退任何已有 dirty 改动。
- `artifacts/` 包含大截图、截断文件和过程证据，不要整目录 stage 或提交。
- 提交前必须逐文件确认范围。
- 本轮没有创建 commit，也没有 push。

## 11. 文件导航

人工验收入口：

- `docs/v07-game-development-human-review-form-v0.2.md`

本交接覆盖并更新以下两份历史文档的当前状态，但历史设计仍可查：

- `docs/v07-game-development-architecture-handoff-v0.1.md`
- `docs/v07-game-development-difficulty-and-tavern-simulation-handoff-v0.1.md`

关键源码：

- `actions/index.ts`：主正文、正文后状态整理、手机消息和持久化调用。
- `message-format.ts`：主正文 prompt、普通状态整理 prompt 和解析器。
- `plot-state-machine/`：第七卷条件、日期、路线计算、确认和存储。
- `phone/render.ts`：手机桌面、企划页和开发页 HTML。
- `phone/styles.css`：手机布局、分页、路线页和开发页样式。
- `phone/home-pagination.ts`：纯分页规则。
- `game-development/index.ts`：项目、六天计划、固定结算和存储。
- `scripts/simulate-v07-routing.ts`：严格路线事实和确认规则仿真。
- `scripts/verify-phone-home-pagination.ts`：手机分页合同。
- `scripts/verify-host-bundle-safety.mjs`：酒馆正则与 webpack 单文件安全。

## 12. 下一轮最可能的正确范围

这只是根据源码得出的候选，不是自动授权。必须以用户填写后的审查表为准。

如果人工正例正文写出了实际结果，但企划页没有更新，下一轮应优先处理：

1. 把严格的正文证据检查接到正常正文完成后的流程。
2. 只依据本轮新生成正文判断，不把玩家一句路线意图当成事实。
3. 日期不允许时不写入。
4. 失败必须可见，不能静默当成功。
5. 用真实酒馆 API 正反例证明企划页更新正确。

这一修复不应顺带改：

- 五条路线的产品含义。
- 路线最终必须由玩家在企划页亲自确认的规则。
- 手机分页视觉。
- 游戏开发数值。
- 酒馆外层楼层隔离策略。
- shujuku / ACU / 数据库钩子。

如果人工审查认为“选定路线后下一段正文必须立即承认路线”，这应单独成为下一轮范围，并明确允许修改正文上下文组装。不要和路线事实识别在同一次修复里偷偷合并。

## 13. 仍需人工决定

1. “和伙伴们一起离开”默认包含谁。审查表暂按惠、英梨梨、诗羽、美智留逐人确认。
2. 路线确认后，下一段正文应立即进入路线剧情，还是等一个正式事件开始。
3. 六天计划应在点击完成本周后立即生成一段正文，还是等玩家回到主界面再触发。
4. 当前 UI 文字和按钮大小是否已经达到可用标准。
5. `pnpm simulate:v07-routing` 的便捷入口是否值得下一轮单独修复。

## 14. 艾尔登特审查门

本轮结束状态：等待用户填写 `docs/v07-game-development-human-review-form-v0.2.md`，并在新对话提交。

新对话收到表后，先整理：

```text
下一轮允许修的问题：
下一轮禁止碰的内容：
下一轮完成标准：
```

涉及正文或酒馆链路时，再整理：

```text
下一轮允许改变的链路：
下一轮禁止改变的链路：
必须提供的运行时证据：
```

没有人工审查表，不开下一轮。
