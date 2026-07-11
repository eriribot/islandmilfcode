# V07 路线架构、未完成项与开发优先级交接（精简版）

> 接手对象：5.6 sol
>
> 修订依据：2026-07-11 人工补充路线语义与 5.6 sol 代码评审。
>
> 当前权限：只改 Markdown；不修改生产代码、prompt、memoryDB 或宿主链。

## 0. 结论

当前提交 `c32f654` 可以保留为本地 UI 和纯函数实验，但路线触发不能验收。

正确模型不是“三条路线等于三个单一结局”，而是三个路线家族：

- `stay` 留下家族：黑金留下、User 一个人留下。
- `akane` 朱音家族：当前先保留一个主变体。
- `solo` 单飞家族：User 自己跑路、除伦也外其他人都跑路。

因此权威状态必须同时保存：

```text
routeFamily: stay | akane | solo
routeVariant:
  stay_blackgold
  stay_user_only
  akane_core
  solo_user_exit
  solo_group_exit_except_tomoya
```

`routeFamily` 决定共享玩法 profile，`routeVariant` 决定人员、事件和叙事差异。不能再用一个 `stay/solo` 字符串吞掉家族内差异。

## 1. 五个路线变体

| 家族 | 变体 ID | 产品含义 | 当前状态 |
| --- | --- | --- | --- |
| 留下 | `stay_blackgold` | User 留下，英梨梨与诗羽也选择留下或继续共同创作 | 当前五项 stay flag 接近此分支，但条件仍不完整 |
| 留下 | `stay_user_only` | User 一个人留下，黑金没有作为固定同伴留下 | 当前没有独立 flag、resolver 条件或进入脚本 |
| 朱音 | `akane_core` | User 进入朱音的高压创作环境 | 当前只有两个 eligibility flag，条件偏薄 |
| 单飞 | `solo_user_exit` | User 自己离开现有体系，独立推进 | 当前 `solo_route_open` 只能粗略表达，容易被一句话触发 |
| 单飞 | `solo_group_exit_except_tomoya` | 除伦也外，其他相关创作者一起离开原体系 | 当前没有独立 flag、人员快照或进入脚本 |

多人是否“留下/跑路”必须来自已确认剧情事实和路线选择，不能由 route 名自动推导固定员工。

## 2. 防止玩家最后口胡路线

### 2.1 唯一权威流程

```text
完整且校验通过的 assistant 正文
    -> 路线事实提案
    -> 事件专属确定性校验
    -> 原子写入事实 + fact receipt
    -> resolver 计算 family/variant eligibility
    -> 玩家点击专用路线按钮
    -> 写入 choice receipt + eligibility basis hash
    -> PlotRoutingContext 只读加载 choice
    -> 下游事件窗口激活 route session
    -> 周计划从 session 派生 routeFamily/routeVariant
    -> 主 AI 接收只读路线与行动上下文
```

### 2.2 自由输入的权限

玩家输入以下内容都只能算叙事意图：

```text
我要走朱音线
我改成单飞
路线确认：留下线
所有人都别管伦也了，跟我走
```

它们不得直接修改：

- 路线事实。
- `routeFamily`。
- `routeVariant`。
- choice receipt。
- session 激活状态。
- 周计划 route profile。

最终 choice 只能来自带稳定 route family/variant ID 的专用按钮。生产实现不得解析自由文本中的“路线确认：X”。

### 2.3 `grounded` 事实规则

“我想走某线”不能等于路线已开放。承诺类事实至少满足两项：

1. 完整 assistant 正文中出现明确意图。
2. 同一事件出现实际后果、他人回应、资源交接、拒绝/接受邀约或关系变化。
3. 事件路由产生确定性 outcome receipt。

只有口头宣言而没有后果时，只能记录 `intent_seen`，不能写 `*_grounded=yes`。

## 3. 建议 eligibility

以下是下一轮领域模型建议，最终文案仍需人工确认。

### 3.1 `stay_blackgold`

建议要求：

- `megumi_coplanner`。
- `second_project_seed_ready`。
- `blackgold_counterwill`。
- `eriri_high_battlefield_supported`。
- `utaha_author_pride_supported`。
- `user_knows_counterwill`。
- `akane_repulsed`。

现有 stay 条件缺最后两项，可能在 User 不知情或朱音冲突尚未结束时提前开放。

### 3.2 `stay_user_only`

需要新增独立事实，不能复用黑金留下条件：

- `user_stay_commitment_grounded`。
- `blackgold_not_staying_confirmed`。
- 当前项目/组织仍允许 User 留下。

英梨梨、诗羽是否成为临时合作对象由后续正文决定，不自动成为员工。

### 3.3 `akane_core`

建议要求：

- `akane_pressure_seen`。
- `akane_formal_offer_seen`。
- `akane_route_open`。

当前代码缺正式邀约事实，只凭“看见压力 + 非扁平对话”过于容易开放。

### 3.4 `solo_user_exit`

建议要求：

- `solo_route_open`，只表示独立意图已进入视野。
- 新增 `user_exit_commitment_grounded`，表示 User 已采取有后果的离开行动。

一句“我要单飞”最多只能满足第一项，不能满足第二项。

### 3.5 `solo_group_exit_except_tomoya`

建议要求：

- `solo_route_open`。
- `group_exit_without_tomoya_grounded`。
- 一份参与者快照，明确谁已确认离开、谁只是临时合作、谁未表态。

不能只用“除了伦也大家都走了”一句旁白完成该分支。

## 4. 5.6 sol 新发现的问题

### P0：生产 choice 链不存在

- `confirmPlotRouteChoice()` 没有生产调用者。
- `plotRoute.v07.choice` 没有生产持久化读写。
- `PlotRoutingContext` 和 route session 桥尚未实现。

### P0：本地周计划绕过路线 choice

- 周计划可独立切换 `solo/akane`。
- 提交只检查六个行动是否填满。
- 没有检查 choice、eligibility、variant 或 session。

### P0：证据存在不代表语义成立

当前 validator 只检查引文长度和是否为正文子串。已执行反例：

```text
正文：User说今天天气不错。
提案：solo_route_open = yes
结果：accepted
```

因此必须增加事件专属语义规则或人工审查门，不能只信 AI 分类。

### P1：事实失效后旧 choice 可被替换

当前 resolver 在旧 choice 不再 eligible 时把它降为 `rejectedChoice`，随后允许选择别线。正确行为应是 `needs_review`，只有显式回滚 choice receipt 才能重选。

### P1：`SAE_07-8` 绕过日期上界

当前 prompt gate 遇到 `SAE_07-8` 就直接开放，不检查 `2013-03-31` 上界。事件 ID 和日期窗必须同时成立。

### P1：旧同层文档只覆盖单飞和朱音

旧版本没有 `stay_blackgold`、`stay_user_only` 和完整五变体仿真，本精简版以本节路线模型为准。

## 5. 保留的架构边界

| 领域 | 负责 | 不负责 |
| --- | --- | --- |
| `plot-state-machine` | 路线事实、family/variant eligibility、choice guard | 项目积分、周计划、正文写作 |
| choice store | choice receipt、basis hash、锁定与显式回滚 | 推断剧情事实 |
| `PlotRoutingContext` | 把合法 choice 只读送入事件发现 | 保存第二份 choice |
| route session | 日期窗、允许 family/variant、行动 profile | 决定玩家 choice |
| game-development | 项目、六日周计划、结算、重试、回滚 | 修改路线事实和 choice |
| 主 AI | 按冻结上下文写正文 | 选路线、换 variant、重算积分 |
| secondary AI | 提出带证据候选 | 直接写权威状态 |

## 6. 当前未完成项

- [x] 三个 route family 的纯 resolver/choice guard 实验。
- [x] 本地路线判断页和周计划 UI 原型。
- [x] 一周五个工作日加一个周末的产品方向。
- [ ] 五个 route variant 的类型和 eligibility。
- [ ] 事件专属语义证据校验。
- [ ] 删除 legacy `plotFlags` 接受路径。
- [ ] choice receipt 的原子持久化、basis hash 和回滚。
- [ ] `PlotRoutingContext` 生产桥。
- [ ] route session 的真实开始/结束事件与日期。
- [ ] 周计划 route profile 从 choice 派生，删除独立路线切换。
- [ ] GameDevelopmentState 的存档、读档、幂等和回滚。
- [ ] weekly action context 的生产 prompt 接入。
- [ ] 真实 SillyTavern、宿主楼层、数据库和插件日志验收。

## 7. 最简酒馆同层仿真

同层 Markdown 只能验证交互，不是安全边界。模板压缩为一块：

```markdown
## 【V07 路线判断】

当前 family/variant eligibility：
- stay / stay_blackgold：未满足｜可选
- stay / stay_user_only：未满足｜可选
- akane / akane_core：未满足｜可选
- solo / solo_user_exit：未满足｜可选
- solo / solo_group_exit_except_tomoya：未满足｜可选

权威 choice：尚未确认
口头路线意图：仅作剧情参考，不改变权威状态
下一步：在专用路线按钮中选择一个当前可选 variant
```

同层仿真中可以由人手工模拟按钮结果，但验收记录必须注明“人工模拟”，不能把文本命令当成生产 choice。

## 8. 开发难度与推荐顺序

难度采用 1～5 级，5 为跨状态、回滚、AI 与宿主链的最高难度。

| 推荐顺序 | 工作 | 难度 | 为什么排这里 |
| ---: | --- | ---: | --- |
| 1 | `RouteFamily/RouteVariant` 类型、五变体 resolver 和纯合同测试 | 2/5 | 边界清楚、无副作用，是所有后续工作的根 |
| 2 | 五变体酒馆同层 fixture | 1/5 | 可与第 1 项并行，用来确认产品语义，但不算接通 |
| 3 | strict plot-facts writer、事件专属语义校验、删除 legacy 接受路径 | 4/5 | 决定口胡和 AI 误判能否污染 eligibility |
| 4 | choice receipt、basis hash、锁定、显式回滚 | 4/5 | 决定玩家选线后能否稳定且不可静默换线 |
| 5 | `PlotRoutingContext` 与 route session 激活 | 5/5 | 跨 memoryDB、事件路由和日期窗，是第一处正式接通 |
| 6 | GameDevelopmentState、六日周计划、存档/幂等/回滚 | 5/5 | 跨状态 schema 和 Reader 回滚 |
| 7 | weekly prompt、独立 secondary、真实宿主 E2E | 5/5 | 最后接 AI 和宿主，失败面最大 |
| 8 | 生产 UI 整理 | 3/5 | UI 必须消费权威状态，不能先于 1～6 项定型 |

最先可以开发的是第 1 项：五变体纯领域模型和合同测试。不要先继续扩本地 UI。

## 9. 第一轮建议合同

允许修改：

- `plot-state-machine/types.ts`。
- `plot-state-machine/v07.ts`。
- `plot-state-machine/resolver.ts`。
- 纯仿真/合同测试。

本轮目标：

- 引入 `routeFamily + routeVariant`。
- 五个变体都有明确 missing facts。
- 多个变体可以同时 eligible，但 resolver 不自动选择。
- 自由文本不参与 choice API。
- 已存在 choice 即使 basis 失效也保持锁定并返回 `needs_review`。

本轮禁止：

- 接 production prompt。
- 写 memoryDB。
- 改手机企划页或周计划 UI。
- 接宿主楼层或插件。

## 10. 必须通过的反口胡测试

1. 所有 flag 为空，玩家说“我要走朱音线”——choice 仍为 `null`。
2. 正文只有“今天天气不错”，AI 提议 `solo_route_open=yes`——整批拒绝。
3. 只出现“我要单飞”，`solo_user_exit` 仍缺 `user_exit_commitment_grounded`。
4. `stay_blackgold` eligible 不应自动让 `stay_user_only` eligible。
5. `solo_user_exit` eligible 不应自动让“除伦也外都跑路”eligible。
6. 玩家锁定 `stay_user_only` 后再说“改走朱音”——choice 不变。
7. choice basis 回滚——session 进入 `needs_review`，不能自动换线。
8. 日期超过上界但事件仍是 `SAE_07-8`——route prompt 为空。
9. 周计划 route family/variant 与 choice 不一致——禁止进入和提交。
10. 刷新、重试和重复点击——同一个 choice receipt 只提交一次。

## 11. 仍需人工确认

- `stay_user_only` 的准确剧情条件和组织状态。
- “除伦也外都跑路”的参与角色范围和逐人确认规则。
- 朱音线是否还有后续 variant。
- 五个 variant 各自的 session 日期窗。
- 留下家族是否共享单飞/朱音的游戏开发玩法。
- 合作与周末目标的合法角色列表。
- 项目完成后的发布、销量、评价和结局规则。

在这些问题确认前，可以先完成第 1 项纯领域模型，但不能伪造生产事件和人员归属。

## 12. 旧版和新版架构评估

### 12.1 对比

| 维度 | 旧版：三个单一 route ID | 新版：三个 family + 五个 variant |
| --- | --- | --- |
| 实现复杂度 | 低 | 中等 |
| 手机展示 | 天然适合三张卡/三条进度 | 需要 family 聚合，点开显示 variant |
| 路线语义 | 会把“黑金留下/User 独留”“User 跑/全员跑”压成同一个结果 | 能准确表示人员与剧情差异 |
| 员工与目标 | 容易按 route 名自动塞固定人员 | variant 可保存进入时参与者快照 |
| choice/回滚 | 只锁一个字符串，简单但信息不足 | receipt 需同时锁 family、variant、basis hash |
| 后续扩展 | 增加分支时会不断给单一 route 加特殊判断 | 新 variant 可以在家族内扩展 |
| 防口胡 | 单一 flag 很容易被一句宣言打开 | 可把 intent 与 grounded outcome 分开 |

### 12.2 评审结论

采用混合方案：

- **领域内核用新版**：`routeFamily + routeVariant` 是权威状态。
- **手机首屏保持旧版简洁**：只显示“留下 / 朱音 / 单飞”三条 family 进度。
- 点击 family 后再显示该 family 下的 variant、缺项和证据。

不能为了手机只想显示三条进度，就退回三个单一 route ID。UI 可以聚合，领域状态不能丢信息。

## 13. 手机企划页的三线进度条

### 13.1 页面职责

进度条表示“路线准备度”，不表示：

- 玩家最终选择概率。
- 好感度。
- 路线已经激活。
- AI 可以自动替玩家选线。

手机企划页只读统一 resolver 的结果，不能像当前 `phone/render.ts` 一样自行复制日期门和计算规则。

### 13.2 首屏布局

```text
企划 / 第七卷路线

留下    ██████░░░░  5/7  收集条件
朱音    ████████░░  2/3  收集条件
单飞    ██████████  条件齐全 · 等待确认窗

当前日期：2013-03-02
路线确认窗：2013-03-04 ～ 2013-03-31
```

三条进度对应 family。family 内有多个 variant 时：

```text
familyProgress = max(该 family 下所有 variantProgress)
```

进度条旁必须显示最佳 variant 的精确完成数，不能只给模糊百分比。例如：

```text
留下 5/7
最佳准备：黑金留下 5/7
另一分支：User 独留 1/3
```

不同 variant 的条件数不同，所以百分比只用于视觉长度，`已满足/总条件` 才是权威说明。

### 13.3 展开内容

点击“留下”后显示：

- `stay_blackgold`：已满足条件、缺项、最近证据。
- `stay_user_only`：已满足条件、缺项、最近证据。
- 当前日期门和 choice 按钮状态。

朱音和单飞同理。玩家默认只看友好名称；稳定 ID 放在调试信息或小字中。

### 13.4 路线进度状态

每条 family 必须有离散状态，不能只靠 0～100 数字：

| 状态 | 含义 | choice 按钮 |
| --- | --- | --- |
| `locked` | 尚未到第七卷/路线发现窗口 | 隐藏 |
| `gathering` | 条件尚未满足 | 禁用 |
| `prequalified` | 条件提前满足，但确认窗未开放 | 禁用，显示等待日期 |
| `ready` | 至少一个 variant 条件齐全且确认窗开放 | 开放对应 variant 按钮 |
| `chosen` | choice receipt 已提交 | 仅显示已锁定 |
| `needs_review` | choice basis 失效或回滚不一致 | 全部禁用 |
| `expired` | 确认窗结束且没有 choice | 禁用，显示已错过 |

一旦 `chosen`，其他路线可以保留最终准备度作为历史，但必须变暗且不可选择。

### 13.5 数据来源

手机页只消费一个只读 view model：

```text
RoutePlanningViewModel
  evaluationTime
  choiceWindow
  families[]
    familyId
    state
    bestVariantId
    satisfiedCount
    requiredCount
    variants[]
      variantId
      state
      satisfiedFacts
      missingFacts
      evidenceSummary
  choiceReceipt
  needsReviewReason
```

render 层不得直接读 memoryDB 后重新计算 eligibility，也不得用 `currentEventId.startsWith('SAE_07-')` 自己解锁。

## 14. 玩家提前解决问题的处理

### 14.1 事实提前完成不等于路线提前激活

玩家可能在设计日期前就解决某个问题。系统应该承认玩家做到了，但分开处理“观察到”和“正式生效”：

```text
observed evidence
    -> pending fact candidate
    -> 显示在手机进度中：已提前满足，等待生效
    -> 到 effectiveAt/event gate 时重新校验
    -> 仍成立则晋升 active fact
    -> resolver 重新计算 readiness
```

不能采用两种极端：

- 直接丢弃提前完成的成果，让玩家感觉系统不承认自由行动。
- 条件一满足就自动选线或启动 session，破坏路线节奏。

### 14.2 `prequalified` 规则

如果 variant 条件已经齐全，但 choice window 尚未开放：

- family 进度条可以达到 100%。
- 状态显示 `prequalified`，文案为“条件已提前完成，等待 2013-03-04 确认”。
- choice 按钮保持禁用。
- 不写 choice receipt。
- 不激活 route session。
- 不向主 AI 注入“已经进入该路线”。

到确认窗开放时，系统重新读取当前事实；仍满足才进入 `ready`，但依然等待玩家点击。

### 14.3 提前事实被后续剧情推翻

`pending` 事实允许被后续正文否定或过期。手机页应显示“曾提前满足，现已失效”，不能暗中保留 100%。

已经晋升为 active 且参与 choice basis 的事实，若因显式回滚失效：

- choice 不自动换线。
- session 进入 `needs_review`。
- 手机三条路线全部禁用，显示需要回滚 choice 或恢复依据。

### 14.4 防止提前口胡刷进度

单句“我已经解决了”“大家都跟我走”只能成为 `intent_seen`，不能增加 family 准备度。进度条只统计：

- 事件专属 validator 接受的 active fact。
- 或有完整证据与后果、等待生效的 pending fact。

普通自由文本、AI 自述和未落 receipt 的 Markdown 块都不能推动进度条。

## 15. 手机进度条的开发难度与时机

- 本地静态三条进度 UI：`1/5`，只适合确认视觉。
- `RoutePlanningViewModel` 和 family/variant 聚合：`3/5`。
- pending/active、提前完成、生效与回滚展示：`4/5`。
- choice receipt 与 `needs_review` 联动：`4/5`。

生产手机进度条应排在“五变体 resolver、严格事实 writer、choice receipt”之后，排在 route session 和游戏开发 UI 之前。否则手机页会再次复制一套不可靠的路线算法。

## 16. 2026-07-11 三线生产入口实施记录

> 本节是后续代码实施记录，更新本文前面“生产 choice 链不存在”的历史状态。此次只接“进入三条线”这一段，不接游戏开发 session、周计划或 AI 结算。

### 16.1 已接通的实际链

```text
手机企划页三 family（留下 / 朱音 / 单飞）
    -> 展开五个稳定 variant
    -> 专用 variant 确认按钮
    -> confirmPlotRouteChoice() 校验手动来源、日期窗、eligibility 和锁定
    -> 生成 family + variant + confirmedAt + basisHash receipt
    -> commitPlotRouteChoice() 写入 memoryDB attributes
    -> ctx.persistConversation() 进入现有存档序列化
    -> buildPlotRoutingContext() 从同一权威存储只读回读
```

自由输入没有接入 choice API。玩家说“我要走某线”不会调用上述提交函数。

### 16.2 修改和新增文件

| 文件 | 类型 | 本轮内容 |
| --- | --- | --- |
| `plot-state-machine/types.ts` | 修改 | 新增 `PlotRouteFamilyId`、五个 `PlotRouteVariantId`、`PlotRouteChoiceReceipt`、`choiceState/needs_review` 类型；choice commit 改为 JSON receipt。 |
| `plot-state-machine/v07.ts` | 修改 | 三 family 下登记五 variant；补齐黑金留下、User 独留、朱音核心、User 单飞、集体单飞的独立 required facts。 |
| `plot-state-machine/resolver.ts` | 修改 | 按 variant 计算 satisfied/missing facts；生成 deterministic FNV-1a basis hash；解析 receipt；依据失效时保持 choice 锁定并返回 `needs_review`。 |
| `plot-state-machine/choice.ts` | 修改 | 手动确认成功时生成 family/variant receipt；拒绝 AI 来源、窗外、缺条件和覆盖已锁定 choice。 |
| `plot-state-machine/memory.ts` | 修改 | 新增 choice receipt 的 memoryDB 写入与当前活跃 receipt 回读。 |
| `plot-state-machine/routing-context.ts` | **新增** | 新增只读 `PlotRoutingContext` 构建器，统一读取 flags、choice receipt 和 resolver 结果；不复制 choice 到 `StatusData`。 |
| `plot-state-machine/index.ts` | 修改 | 导出新增 family/variant、receipt、memory 和 routing context API。 |
| `phone/render.ts` | 修改 | 真实手机企划页新增三 family 进度、五 variant 缺项、choice 状态、basis hash 和专用确认按钮；页面消费统一 routing context/resolver。 |
| `phone/styles.css` | 修改 | 新增三线入口、variant、进度条、锁定和 `needs_review` 展示样式。 |
| `index.ts` | 修改 | 绑定 `confirm-v07-route` 生产点击事件；校验后写 memoryDB、立即持久化并显示结果通知。 |
| `gamedevelop-preview/main.ts` | 修改 | 本地预览同步改为保存 receipt 对象，避免把 JSON commit value 误当 route ID；仍不写生产 memoryDB。 |
| `scripts/simulate-v07-routing.ts` | 修改 | 合同从旧三 route ID 升级到三 family / 五 variant；加入 basis receipt、variant 隔离和失效 choice 不可替换断言。 |

### 16.3 本轮明确未做

- 没有为三条线虚构 route session 开始/结束事件或日期。
- 没有把 choice 注入普通主 AI prompt、周计划或游戏开发结算。
- 没有实现 strict v07 fact writer、事件专属语义验证和旧 `plotFlags` 路径删除。
- 没有实现 choice 显式回滚 UI、clone 事务或 `plotCommitReceipts` 可逆提交账本。
- `PlotRoutingContext` 已能从生产存储构建，但尚未传入 `syncMainEvents()` 激活后续 session；当前 `剧情第七卷.json` 到 `SAE_07-8` 为止，没有获批的下游 session 可激活。

### 16.4 核对状态

- `[已执行-静态]` 全项目 `rg` 核对旧 `stay/akane/solo` choice 调用与新 API 使用点。
- `[已执行-静态]` `git diff --check` 通过，无空白错误。
- `[按用户要求未执行]` build、安全脚本和真实宿主验证由人工自行完成。
- `[未执行]` 更新后的 `scripts/simulate-v07-routing.ts` 本轮未运行，因此只能记录为已改合同，不能记录为测试通过。

## 17. 2026-07-11 phone 游戏开发画面实装记录

> 本节更新第 16.3 节“没有接游戏开发状态”的实施前边界。此次新增的是实际 phone 页面、独立状态和确定性周结算；仍没有把周计划发送给主 AI，也没有虚构 route session 事件或日期。

### 17.1 玩家实际入口

手机首页新增“开发”应用：

```text
phone 首页 / 开发
    -> 未选路线：锁定页，跳转企划页
    -> choice needs_review：锁定页，显示复核原因
    -> 合法 choice：读取 route family/variant
    -> 未建项目：填写游戏名、类型、主题、平台
    -> 已建项目：项目指标 + 五个工作日 + 一个周末
    -> 每日选择行动、可选合作对象、填写意图
    -> 六格排满后提交
    -> 确定性结算 project deltas
    -> 保存上周冻结上下文并进入下一周
```

开发页没有路线切换控件。路线只来自 `plotRoute.v07.choice` receipt；`needs_review` 时页面整体锁定。

### 17.2 新增和修改文件

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `game-development/index.ts` | **新增** | `GameDevelopmentState`、项目 schema、三 family 共用行动域、variant 专属行动、六日 slot、项目建立、slot 编辑、周 readiness、确定性结算、提交上下文及 memoryDB JSON 读写。 |
| `phone/types.ts` | 修改 | 新增真实路由 `app:game-development`。 |
| `phone/render.ts` | 修改 | 手机首页新增“开发”图标；新增锁定页、项目建立页、项目仪表、十项指标、六日 tabs、行动卡、动态角色目标、意图输入、行动清单、提交按钮和上周上下文。 |
| `phone/styles.css` | 修改 | 新增游戏开发页在手机尺寸下的卡片、指标、日程、行动、表单、锁定态和提交态样式。 |
| `index.ts` | 修改 | 新增项目建立、日期选择、行动选择、合作对象、意图保存和周提交事件；每次有效变更写 memoryDB 并调用 `ctx.persistConversation()`。 |

### 17.3 状态与规则

- 权威存储：`memoryDB.attributes`，`targetId=route:v07`，`key=gameDevelopment.v1.state`，`valueType=json`。
- 项目未建立前只显示项目资料表单，不显示可结算周计划。
- 项目建立后固定为五个工作日开发 slot 加一个周末休整/约会 slot。
- 通用行动：写剧本、画原画、写代码、制作管理、Debug、宣传试玩。
- variant/family 行动：`stay_blackgold` 才有黑金冲刺，`akane_core` 才有朱音高压审查，solo family 才有独立原型。
- 合作对象从当前 `StatusData.targets` 动态读取，不按 route 名自动塞固定员工。
- 六格未排满不能提交；提交时再次验证每个行动属于当前 route 和 slot kind。
- 提交后按确定性 deltas 更新项目指标、保存 `[GAME_DEVELOPMENT_WEEK]` 上下文、周数加一并清空下一周草稿。
- 开发行动不会写 v07 route facts，不会改变 choice receipt。

### 17.4 UTF-8 与核对记录

- `[已执行]` 对 Unicode replacement character（`U+FFFD`）执行固定字符串检索，在 TypeScript、CSS、Markdown、JSON 中零命中。上一轮输出里的该符号是搜索表达式本身，不是文件命中。
- `[已执行]` 使用抛异常模式的 .NET `UTF8Encoding(false, true)` 严格解码相关文件，全部为合法 UTF-8。
- `[已执行-静态]` `git diff --check` 通过。
- `[按用户要求未执行]` webpack/build、安全脚本、浏览器交互和真实 SillyTavern 验证由人工完成。

### 17.5 仍未接入

- 上周生成的 `[GAME_DEVELOPMENT_WEEK]` 只保存在状态中用于审计和后续接入，当前不会自动发给主 AI。
- 没有创建宿主楼层、调用 `/trigger`、发送 secondary 或改动通用 progress。
- 没有获批的 route session 日期，所以页面以合法 choice 作为 UI 开放条件，不宣称剧情 session 已激活。
- 没有完成 Reader 回滚 ledger、actionInstanceId 跨回滚幂等或 clone 事务；这些仍属于后续状态工程。
