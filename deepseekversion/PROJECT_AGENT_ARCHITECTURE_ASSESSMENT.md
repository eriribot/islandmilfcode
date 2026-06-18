# 项目代码 Agent 化程度评估

本文评估的是 `islandmilfcode` 这套项目代码本身的 agent 程度，而不是 DeepSeek 模型本身。核心判断：项目已经有明显 agent 思维，但还没有形成完整 agent 架构。对 DeepSeek 这类同人卡扮演不稳定的模型来说，提高质量的关键不是相信模型，而是继续把更多判断、检索、路由、审计、回写做成代码驱动的 agent 外骨骼。

## 总体结论

当前代码大约处在“半 agent 编排层”阶段。

它已经不是普通 prompt 拼接器：

- 有前置判定：`scenePresence` 先判断 present / focus / absent / uncertain。
- 有任务拆分：主 API 写正文，副 API 做 scenePresence、progress、summary、phone。
- 有结构化状态：`statusData`、`summaryStore`、`memoryDB`、phone threads。
- 有后处理回写：`parseProgressUpdate` 后提交变量、memoryDB、手机消息。
- 有失败降级：副任务失败时不阻塞主流程，部分任务可以回落。
- 有局部审计：关系指导、appearance guards、plotImpact、butterfly effects。

但它还不是强 agent：

- 缺少统一 planner。
- 缺少显式任务图和状态机。
- `recallPlan` 目前只让模型输出，代码没有真正执行召回计划。
- 联网/证据包尚未形成闭环。
- 缺少质量评分器和重试策略。
- prompt 缓存友好度不足，动态内容过早破坏 DS cache。
- 大量“判断”仍靠模型在长 prompt 中自觉遵守，而不是代码硬门控。

一句话：现在是“agent 思维写进 prompt 和流程里”，还不是“代码作为 agent 主体驱动弱模型”。

## 现有 Agent 能力拆解

### 1. 感知层：已有，但分散

已有感知来源：

- 最近正文：`getPromptMessageText`、reader messages。
- 用户当前输入：`sanitizePromptInputText`。
- 世界状态：`statusData.world`。
- 镜头判定：`detectScenePresence`。
- 角色卡：`characterCardLibrary`。
- 长期记忆：`memoryDB` 和 `summaryStore`。
- 手机线程：phone message store。
- 路线事件：`plotLibrary`、mainEvents。

问题：

- 感知结果没有统一的“本轮工作内存”对象。
- scenePresence、summary、memory、plot、phone 各自产生片段，最后靠 prompt 拼接揉在一起。
- 当事实冲突时，主要依靠文字规则告诉模型“谁优先”，代码层没有统一仲裁器。

建议：

```text
TurnContext
  worldSnapshot
  scenePresence
  activeCharacters
  routeState
  memoryRecall
  evidencePacks
  userIntent
  riskFlags
```

每轮先生成一个显式 `TurnContext`，后续所有 prompt 都从它取值。

### 2. 计划层：雏形存在，但未执行

`scenePresence` prompt 里已经要求输出：

- `plotImpact`
- `recallPlan`
- `userVariableImpact`
- `mustRecall`
- `mustSuppress`

这很有 agent 味道，本质上已经在让副模型做“页边计划”。

问题是代码目前主要消费：

- present/focus/absent/uncertain
- timeProposal
- plotImpact
- appearanceGuards

但 `recallPlan` 没有进入真正执行链。也就是说，模型写了“应该召回什么”，但代码没有按它去 memoryDB / 世界书 / WebSearch 拉证据。

建议：

```text
scenePresence.recallPlan
  ↓
代码过滤和限流
  ↓
memoryDB query / worldbook search / ST WebSearch result cache
  ↓
evidencePacks
  ↓
二次 scenePresence 或主 prompt 动态尾部
```

这一步是从“像 agent 的 prompt”变成“真的 agent 执行器”的关键。

### 3. 工具层：本地工具多，外部工具弱

已有工具：

- secondary API 调用。
- summary engine。
- progress parser。
- memoryDB commit。
- phone action detector。
- image generation plugin event。
- character data import plugin event。

不足：

- 没有统一 tool registry。
- 工具调用没有通用 schema、超时、重试、可信度、缓存策略。
- WebSearch 结果目前没有作为工具源进入 islandmilfcode。
- HideWebSearch 只能证明 ST 的 tool result 在 `chat` 里可读，但项目还没消费它。

建议：

```ts
type AgentToolResult = {
  tool: 'memory' | 'worldbook' | 'websearch' | 'summary' | 'scene_presence';
  confidence: 'low' | 'medium' | 'high';
  source: string;
  evidence: string[];
  expiresAt?: number;
};
```

所有外部信息先变成 `AgentToolResult`，再变成 prompt 证据包。

### 4. 行动层：强于普通卡，但缺少重试

已有行动：

- 主生成。
- progress 合并变量。
- phone 消息发送/回复。
- summary 更新。
- memoryDB 写入。
- image request emit。

这些已经是“行动”，不是纯聊天。

不足：

- 主生成质量差时没有自动修复回路。
- 格式错误主要靠 parser 兜底，没有“重写本楼层”的 agent 纠错。
- scenePresence 错判后，主 API 可能已经拿错卡；没有判定置信度低时的二次判定。

建议增加：

```text
preflight confidence low
  -> 再跑一次更窄 scenePresence

main output missing content tag / wrong speaker / canon conflict
  -> 自动 repair prompt
  -> 保留原 raw 作为 debug
```

对 DS 尤其重要，因为它常见问题不是“不会写”，而是“写错焦点/错时间线/漏格式”。

## 为什么 DS 同人卡扮演必须靠 Agent 外骨骼

同人卡扮演的难点不是单轮文采，而是约束密度：

- 当前时间线。
- 原作事实。
- 用户造成的新因果。
- present/focus 镜头边界。
- 角色声线。
- 好感/执念变量。
- 世界书卡片注入时机。
- 长期记忆与近期正文冲突。
- NSFW/关系状态/贞操/次数等变量闩锁。

弱模型会把这些混在一起，用“最像原作的印象”补齐。DS 在长上下文下尤其容易出现：

- 把未来 canon 写到当前时间。
- 把原作关系错配给 user。
- 把不在场角色写成即时反应。
- 初登场角色模板脸。
- 根据摘要/世界书抢走当前镜头。
- 输出格式漂移。

所以质量提升不能只靠“更详细 prompt”。正确方向是：

```text
代码先判定事实与镜头
代码只注入允许出现的角色卡
代码召回必要记忆
代码把搜索结果压成证据包
代码解析并回写变量
代码检查输出错误
模型只负责在窄边界内写正文
```

也就是：模型不是导演，代码 agent 才是导演；模型只是演员和文案生成器。

## 当前 Agent 化评分

粗略评分：

| 能力 | 当前程度 | 说明 |
|---|---:|---|
| 感知 | 7/10 | 数据源多，但缺统一 TurnContext |
| 计划 | 4/10 | prompt 有 recallPlan，代码未执行 |
| 工具 | 5/10 | 内部工具多，外部工具/registry 不足 |
| 行动 | 7/10 | 能生成、回写、发手机、摘要 |
| 反思/审计 | 5/10 | 有局部审计和 parser 防御，缺自动修复 |
| 记忆 | 7/10 | summary + memoryDB 已成型，召回策略仍需 agent 化 |
| 缓存友好 | 3/10 | 动态内容靠前，DS cache 浪费明显 |
| 面向弱模型的约束力 | 6/10 | 规则多，但仍有太多靠模型自觉 |

综合：约 6/10。已经明显超过普通 SillyTavern 卡，但还没到“强 agent 外骨骼”。

## 优先改造路线

### 第一阶段：把现有 agent 思维落成执行闭环

1. 定义 `TurnContext`。
2. 消费 `recallPlan.mustRecall / mustSuppress`。
3. 把 memoryDB / worldbook / ST WebSearch 结果统一成 `evidencePacks`。
4. evidencePacks 只进 scenePresence 和动态尾部，不进稳定前缀。

### 第二阶段：给弱模型加自动纠错

1. 输出标签缺失 -> repair。
2. speaker 头像规则错误 -> repair。
3. 不在场角色插话 -> repair 或截断重写。
4. canon 时间线冲突 -> 用证据包重写本楼层。

### 第三阶段：缓存结构重排

1. 稳定规则前置。
2. 动态 scenePresence / evidence / user input 后置。
3. 长世界书和角色目录顺序固定。
4. 各副任务 prompt 分离稳定前缀，减少每轮 miss。

## 对联网插件的重新定位

联网插件不是“给 DS 一个搜索能力”。

它应该是 agent 工具层的一部分：

```text
DS 或代码发现 canon 不确定
  ↓
触发 ST WebSearch / 读取已有 WebSearch 楼层
  ↓
代码蒸馏为 evidencePacks
  ↓
scenePresence/repair 使用 evidencePacks
```

重点不是搜索，而是“证据进入哪个决策点”。

如果证据直接进主正文，会污染扮演；如果进入 scenePresence 和 repair，才是 agent 驱动质量。

## 结论

项目现在真正有价值的不是某个 prompt，而是已经形成的 agent 编排雏形：前置判定、选择性角色卡注入、变量回写、摘要记忆、手机子系统、plotImpact 和局部审计。

但面对 DS 这种同人卡扮演不稳定的模型，这还不够。下一步应该把“agent 思维”从 prompt 描述升级成代码执行闭环：计划可执行、工具有 registry、证据有 schema、输出可审计可修复。只有这样，DS 才能被驱使在窄轨道里产出稳定质量。
