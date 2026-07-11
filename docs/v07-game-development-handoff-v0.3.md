# V07 正文路线更新新窗口交接 v0.3

> 生成时间：2026-07-11（Asia/Shanghai）
> 工作目录：`E:\web\tavern_helper_template-main\src\islandmilfcode`
> Git 分支：`main`
> 基准提交：`b2f0770f29070d9b7ef0ac82cdc20dd4a4edd866`
> 状态：人工正反例已经完成，正文到企划页的真实断点已经复现；下一轮范围已经冻结

## 1. 新窗口只需先读这三个文件

1. `docs/v07-game-development-human-review-result-v0.2.md`
2. `docs/v07-game-development-next-loop-contract-v0.1.md`
3. `docs/v07-game-development-handoff-v0.3.md`

旧对话不需要重新粘贴。历史架构细节需要时再查：

- `docs/v07-game-development-handoff-v0.2.md`
- `docs/v07-game-development-architecture-handoff-v0.1.md`
- `docs/v07-game-development-difficulty-and-tavern-simulation-handoff-v0.1.md`

## 2. 用户已经给出的人工结论

### 反例通过

在 `2013-03-04`，玩家只表达“以后也许自己做游戏”，同时明确没有退出、没有交接。

结果：手机企划页“自己离开并独立创作”保持 `0/2`，没有自动替玩家选路线。

### 正例失败

玩家随后回退上一楼层，以短输入要求正文实际写出：

- 伦也的失误导致社团分崩离析。
- 玩家把文件、钥匙、USB 和账号权限交接给伦也。
- 玩家正式退出 blessing software。
- 玩家登记新社团并支付首笔开发费用。
- 没有其他人跟随玩家离开。

生成结果和结构化记录都明确承认以上行动已经完成，但手机企划页仍显示 `0/2`。

因此人工结论不是“疑似失败”，而是：

> 正文已经写出实际结果，但正常状态整理没有把第七卷路线条件写入企划页读取的状态。

### 同轮附加失败

状态整理擅自输出：

```text
主线事件.SAE_08-1:进行中
```

玩家没有要求进入第八卷，当前项目也没有获准的 `SAE_08-1` 定义。这说明主线事件写入缺少最终白名单保护。

## 3. 当前准确接通状态

| 范围 | 状态 |
| --- | --- |
| 手机企划页读取路线状态 | 已接入真实自有存档读取 |
| 条件预先存在后的路线确认和保存 | 已接入真实自有存档写入 |
| 自然正文自动更新路线进度 | 未接通，人工正例已证明失败 |
| 已选路线驱动后续小说正文 | 未接通，本轮禁止顺带处理 |
| 六天计划驱动小说正文 | 未接通，本轮禁止顺带处理 |
| 手机分页和应用轻点 | 已有修复与自动检查，本轮禁止顺带修改 |
| 整体正式流程 | 不可用，人工判定阻塞 |

## 4. 根因定位

正常正文流程：

```text
actions/index.ts 生成主正文
→ 主正文固定 skipProgress: true
→ 正文完成后调用 buildProgressPrompt()
→ 普通状态整理更新时间、关系、物品和事件
```

断点：

- `buildProgressPrompt()` 没有要求模型检查第七卷路线条件。
- 旧的 `buildStateDeltaInstruction()` 虽有路线字段，但正常正文流程不使用它。
- 严格的 `buildPlotFlagProposalPrompts()` 和 `reviewPlotFlagProposal()` 已存在，但只在仿真和本地预览中调用。
- 所以正文能写对、摘要能记对、物品能更新，路线进度仍不变。

不得采用的伪修复：

- 只把路线字段文字塞进普通 progress prompt，让模型自由口胡。
- 直接从玩家输入判断路线成立。
- 从摘要或 key facts 反推本轮路线事实。
- 用测试脚本直接写 memoryDB 后宣称真实正文已接通。

下一轮应复用现有严格审查器，并确保它只审查本轮新生成的可见正文。

## 5. 下一轮范围

唯一主目标：接通“本轮正文 → 严格证据检查 → 路线事实保存 → 企划页刷新”。

同一范围允许增加主线事件最终白名单保护，拒绝 `SAE_08-1`。

详细允许、禁止和完成标准以此文件为唯一合同：

```text
docs/v07-game-development-next-loop-contract-v0.1.md
```

不要在新窗口重新扩大需求，也不要先继续调 UI。

## 6. 当前主要文件

生产流程：

- `actions/index.ts`
- `message-format.ts`
- `plot-state-machine/proposal-prompt.ts`
- `plot-state-machine/proposal.ts`
- `plot-state-machine/memory.ts`
- `plot-state-machine/resolver.ts`
- `plot-state-machine/routing-context.ts`
- `plot-state-machine/v07.ts`
- `phone/render.ts`

验证：

- `scripts/simulate-v07-routing.ts`
- `scripts/verify-phone-home-pagination.ts`
- `scripts/verify-host-bundle-safety.mjs`

审查证据：

- `C:\Users\eriri\AppData\Local\Temp\QQ_1783748407460.png`
- `C:\Users\eriri\AppData\Local\Temp\QQ_1783748831425.png`

临时目录中的截图可能被系统清理；关键文字证据已经抄入人工审查结果，不依赖截图长期存在。

## 7. 已有自动验证基线

以下是上一轮已经执行的基线：

- 手机分页：`12 contracts passed`
- V07 路线仿真：`78 assertions`
- webpack / 酒馆正则安全：所有危险字符计数为 0
- `git diff --check`：通过
- 最新生产构建：`2026-07-11 12:19:31`，`1,108,082 bytes`

当前 PowerShell 环境中，`pnpm simulate:v07-routing` 会报找不到 `ts-node`。实际通过的仿真命令是：

```powershell
node -e "process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'CommonJS',moduleResolution:'node'});require('ts-node/register/transpile-only');require('./src/islandmilfcode/scripts/simulate-v07-routing.ts')"
```

手机分页合同：

```powershell
node -e "process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'CommonJS',moduleResolution:'node'});require('ts-node/register/transpile-only');require('./src/islandmilfcode/scripts/verify-phone-home-pagination.ts')"
```

酒馆正则安全：

```powershell
node src\islandmilfcode\scripts\verify-host-bundle-safety.mjs
```

工作目录均为：

```text
E:\web\tavern_helper_template-main
```

不要运行 `watch`。

## 8. 构建和真实页面测试规则

修改生产代码后：

```text
pnpm build
→ 读取 dist/islandmilfcode/index.html
→ 全文覆盖酒馆正则“替换为”
→ 保存正则
→ 让页面重新渲染
→ 在 http://127.0.0.1:8000/ 重跑正反例
```

用户已经允许使用酒馆当前 API 做路线连通测试，并允许使用可回退的测试存档。

真实测试必须记录：

- 玩家输入。
- 主 AI 可见正文关键句。
- 严格路线检查输出和接受/拒绝原因。
- 企划页截图。
- 刷新后的路线状态。
- 控制台错误。
- 酒馆外层楼层数前后对比。

## 9. 存档注意

本次正例把测试状态推进到 `2013-03-04`，并产生了错误的 `SAE_08-1` 状态。不要把当前测试状态当干净基线。

此前已知未修改恢复来源：

```text
6d5d6985-eed4-4f08-9413-a372ef06b7fc
```

此前用于仿真的目标存档：

```text
autosave_89cd6e7f-8be5-4ed3-a3f3-6f1c7cbbc979
```

禁止使用：

```text
artifacts/live-save-baseline-before-v07-simulation.json
```

该文件曾被截断，不是可信恢复源。新窗口开始真实测试前，先确认用户当前使用的是哪份可回退副本；不要直接覆盖唯一正式存档。

## 10. 工作树注意

当前工作树原本已经有未提交修改，主要包括：

- `game-development/index.ts`
- `index.ts`
- `phone/render.ts`
- `phone/styles.css`
- `state/store.ts`
- `types.ts`
- `humanpending.md`
- `progress.md`
- 新增 `phone/home-pagination.ts`
- 新增 `scripts/verify-phone-home-pagination.ts`
- 新增本轮文档

规则：

- 不回退现有用户或前序修改。
- 不整目录 stage `artifacts/`。
- 不解析 32MB 的截断存档文件。
- 本轮没有 commit，也没有 push。

## 11. 新窗口开场文字

用户可以直接发送：

```text
继续 islandmilfcode 的 V07 正文路线更新修复。

先完整读取：
1. E:\web\tavern_helper_template-main\src\islandmilfcode\docs\v07-game-development-human-review-result-v0.2.md
2. E:\web\tavern_helper_template-main\src\islandmilfcode\docs\v07-game-development-next-loop-contract-v0.1.md
3. E:\web\tavern_helper_template-main\src\islandmilfcode\docs\v07-game-development-handoff-v0.3.md

上一轮人工审查已经完成：反例通过，正例正文写对但企划页仍为 0/2，同时错误开启 SAE_08-1。严格按下一轮范围说明修复，不要 watch，不要顺带修改手机分页、游戏开发数值、宿主楼层或插件链。完成后重新 build，并在 8000 页面使用真实酒馆 API 重跑同一正反例。
```

## 12. 艾尔登特状态

上一轮人工审查表已经由用户实际测试结果补全，下一轮允许开始，但只能在冻结合同内行动。

下一轮修改完成后必须重新发出人工审查邀请。没有新的人工审查表，不开再下一轮。
