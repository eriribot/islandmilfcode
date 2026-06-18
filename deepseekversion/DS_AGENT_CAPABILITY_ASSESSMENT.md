# DeepSeek Agent 程度评估与联网策略修正

本文只做评估，不代表已经完成实现。结论偏保守：当前项目里不应把 DeepSeek 当成高自治 agent 使用，而应把它压在“受控副任务 + 证据包化 + 主 prompt 严格护栏”的位置。

## 当前观察

在本项目链路里，DeepSeek 的糟糕表现主要不是单点能力不足，而是几个问题叠在一起：

- 长上下文里会抓错焦点：旧世界书、后续原作事实、摘要、当前镜头事实混在一起时，容易把未来事件倒灌到当前线。
- scenePresence 前置空窗明显：角色未判进 `present/focus` 前，完整 0 层卡不会注入；DS 会用泛化印象或模板脸补外貌。
- 时间线事实不稳定：例如 2012-04-05 二年级分班、2013-02 红坂朱音挖黑金二人组、《恋爱节拍器》2011 完结，这类事实如果不放进判定层，DS 很容易按“印象里的原作状态”写。
- 缓存命中结构差：当前 prompt 很多动态块靠前，导致只有一段稳定前缀命中，后面大块输入仍然 miss。
- 工具调用不是模型真的联网：DS 只会提出工具意图，执行、搜索、过滤、蒸馏都必须由外部代码或 SillyTavern 工具链完成。

因此，DS 不适合承担“自己判断何时搜索、自己搜索、自己消化、自己写入事实”的完整 agent 闭环。

## 建议的 Agent 等级

### 不建议：高自治 agent

不要让 DS 自己决定并执行完整流程：

```text
发现问题 -> 搜索网页 -> 读网页 -> 判断权威 -> 写入长期记忆 -> 主动改剧情
```

风险：

- 搜索目标会漂移。
- 网页原文会污染正文风格。
- 低置信事实被写成强 canon。
- 与已经发生的蝴蝶效应冲突时，DS 会强行回轨。
- 成本和缓存命中不可控。

### 建议：低自治工具使用者

只让 DS 输出受限 JSON 或短证据需求：

```text
need_search: true/false
intent: canon_timeline | appearance | design_small_detail | first_appearance_bootstrap
queryHint: 短查询
uncertaintyReason: 为什么本地资料不够
```

真正执行由代码做：

```text
门控 -> 调用 ST WebSearch/VisitLinks 或已有工具结果 -> 去重 -> 蒸馏证据包 -> 注入 scenePresence
```

DS 的职责只保留：

- 判断当前轮是否真的需要证据。
- 在证据包已经给出时，按证据包纠偏。
- 在 `plotImpact` 中承认被玩家行为造成的新因果。

## HideWebSearch 的真实价值

之前需要修正一个理解：`PigmentTokyo/Extension-HideWebSearch` 本身并不联网，也不做搜索聚合。

它做的是：

- 监听 SillyTavern 渲染事件。
- 读取 `chat[mesId]`。
- 检查 `msg.extra.tool_invocations`。
- 识别 `WebSearch` / `VisitLinks` 工具楼层。
- 折叠或隐藏这些楼层。

也就是说，联网和聚合来自 SillyTavern / 模型工具调用链；HideWebSearch 只是 UI 层清理器。

这个插件对我们的启发是：不需要让用户安装 Docker 或本地 sidecar，也不一定要在 `dist/index.html` 里直接联网。更适合的路径是复用 SillyTavern 已经完成的 WebSearch / VisitLinks 结果：

```text
SillyTavern WebSearch / VisitLinks
  ↓
工具结果楼层写入 chat / extra.tool_invocations
  ↓
扩展读取这些结果楼层
  ↓
抽取标题、链接、摘要、访问片段
  ↓
蒸馏为 evidence pack
  ↓
islandmilfcode scenePresence 读取 evidence pack
```

这样用户只需要已有的酒馆联网工具，不需要 Docker、Node sidecar 或额外本地服务。

## 联网策略修正

旧文档里“本地 Node sidecar”仍然是可选方案，但不应作为优先方案。

优先级应改为：

1. 本地资料：世界书、0 层卡、`picresource`、memoryDB、最近正文。
2. 固定世界状态事实：分班日期、作品完结状态、红坂朱音事件时间点等。
3. SillyTavern 已有 WebSearch / VisitLinks 工具结果。
4. 浏览器可直接访问的远端搜索 API。
5. 本地 sidecar，仅作为高级用户方案。

推荐首版不是“主动联网插件”，而是“ST 工具结果收集器”。

## 证据包定位

联网结果不能进入主正文长 prompt，必须先变成短证据包：

```text
[CANON_FACT][来源:st-websearch:url-hash][置信度:medium]
事实：2012-04-05 才开二年级分班。
必须遵守：当前时间早于 2012-04-05 时，不使用 2年B班/2年G班判断同班或座位。
禁止推论：不得把分班后状态倒灌到分班前。
适用：scenePresence 的班级消歧、focus/absent 判定、时间线纠偏。
```

证据包只给：

- `scenePresence`
- `appearanceGuards`
- `plotImpact`
- 初登场 bootstrap

不直接给主 API 当百科资料，更不写入永久 memoryDB，除非用户确认。

## 与缓存命中的关系

DS 缓存命中要求稳定前缀。联网证据包天然是动态内容，不应放在 prompt 前部。

正确位置：

```text
稳定规则
稳定角色目录
稳定世界书/角色卡索引
动态 scenePresence
动态 evidence pack
动态最近正文
玩家输入
```

如果 evidence pack 放太前，会进一步打碎缓存命中。它必须靠近 scenePresence 和本轮任务尾部。

## 当前项目建议

短期只做三件事：

1. 把分班、作品完结、红坂朱音事件这类时间线事实放在 `scenePresence` 世界状态事实层，而不是关系锚点层。
2. 把 HideWebSearch 的思路改造成“ST WebSearch 结果收集器”，不要求用户安装 Docker。
3. 把 DS 降级为受控副任务模型：输出 JSON、吃证据包、做镜头判定，不让它直接管理事实权威。

中期再考虑：

- 把稳定规则和动态上下文重排，提高 DS cache 命中。
- 为初登场角色维护本地 bootstrap catalog，减少联网次数。
- 对 ST WebSearch 结果做本地缓存，缓存键为 `intent + characterId + normalizedQuery`。

## 一句话结论

DeepSeek 在这里更像一个需要扶手的副任务模型，不像可靠的 autonomous agent。它可以做“读证据包后的判定”，不该做“自由联网后的事实裁决”。最现实的联网方案是复用 SillyTavern 已有 WebSearch / VisitLinks 工具结果，再由我们把结果压缩成短证据包喂给 `scenePresence`。
