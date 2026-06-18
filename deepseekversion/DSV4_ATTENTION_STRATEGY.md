# DS V4 注意力适配策略

本文档用于指导未来的 DeepSeek 模式实现。目标不是削弱 DS V4 的长上下文优势，而是把长上下文组织成更容易被压缩注意力命中的结构。

## 论文机制摘要

DeepSeek V4 技术报告描述了混合注意力设计：Compressed Sparse Attention 和 Hierarchical Compressed Attention 交错使用，并保留局部滑动窗口。

对同层卡有用的工程理解如下：

- 最近窗口最适合放当前玩家输入、当前镜头规则、输出格式硬约束和本轮必须遵守的短指令。
- CSA 适合从长上下文中挑选带清晰标签的相关块。角色 ID、事件 ID、来源、标题和别名是重要抓手。
- HCA 更适合承载全局背景、大阶段剧情、长期关系趋势和世界状态。
- 被埋在长散文里的孤立细节容易被压缩淡化；重要事实必须结构化、短句化、带标签。
- 1M 上下文不等于平均注意 1M。长上下文是舞台，不是把所有角色同时推到聚光灯下的理由。

参考资料：

- DeepSeek V4 Technical Report: https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/resolve/main/DeepSeek_V4.pdf
- DeepSeek V4 model card: https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro

## 资料分层

DeepSeek 模式下，同人资料按四层使用。

### 冷档案层

用途：保存完整原作资料、完整 0 层角色卡、长剧情、场景库、同人扩展设定。

规则：

- 可以长，但必须有稳定标题和角色/事件标签。
- 不默认全部注入主模型当前轮 prompt。
- 不作为即时反应依据，除非被热镜头层或证据包层选中。

推荐标题格式：

```text
[CHAR:megumi][角色:加藤惠][资料:完整0层卡][来源:worldbook]
```

### 温索引层

用途：让非当前角色仍然在后台“活着”，避免 DS 在长聊后遗忘，但不让她们抢镜。

每个角色建议 1-3 行：

```text
[CHAR:megumi][后台胶囊]
当前状态：正在参与 blessing software 制作，对 User 的存在感变化保持观察。
路线变化：User 的介入已经高于原作惯性时，优先解释为 User 影响。
禁止：未进入镜头时不得插话、吃醋或产生即时心理反应。
```

规则：

- 全员可以有后台胶囊。
- 胶囊只承载状态和伏笔，不承载完整人设。
- 胶囊不触发完整角色卡加载。

### 热镜头层

用途：当前在场或转场目标的高权重资料。

内容：

- 完整 0 层角色卡。
- 本轮关系指导。
- 当前外貌锚点。
- 当前声线样例。
- 当前剧情事件。
- 本轮禁止串味规则。

规则：

- 只给 `scenePresence.presentIds` 和 `scenePresence.focusIds`。
- 多人修罗场最多优先完整加载 2-3 名实际参与者。
- 未进入热镜头层的角色，即使在摘要或世界背景里被提到，也不得默认即时反应。

### 证据包层

用途：把本地资料、未来联网检索、用户补充设定、同人数据库条目蒸馏成 DS 易命中的短事实。

标准格式：

```text
[EVIDENCE][CHAR:eriri][类型:route_delta][优先级:高]
事实：User 在最近事件中成为英梨梨创作爆发的直接因果来源。
适用：解释英梨梨卸下面具、融入同学、画技爆发或对竞争者动摇时。
禁止推论：不得把成长主因自动归给伦也或原作事件。
来源：memoryDB:route_delta:xxxx
置信度：high
```

规则：

- 重要事实必须有 `CHAR`、类型、来源、置信度。
- 不确定事实要显式写 `置信度: low`，并加 `禁止推论`。
- 证据包只给结论和适用条件，不塞网页原文或长段百科。

### 初登场 Bootstrap 层

用途：补上 `scenePresence` 之前的识别空窗，防止初登场角色因为完整世界书卡尚未注入而被 DS 用模板脸补齐。

当前链路是先做 `scenePresence`，判中 present/focus 后才注入完整 0 层世界书角色卡。初登场时，前置判定还拿不到完整角色卡，因此需要一个很短的 bootstrap 索引帮助识别。

首批高风险角色：

- `CHAR:izumi`：波岛出海。
- `CHAR:sonoko`：町田苑子。
- `CHAR:akane`：红坂朱音 / 高坂茜。

推荐格式：

```text
[BOOTSTRAP][CHAR:izumi][角色:波岛出海][来源:picresource/izumi_phone.jpg]
识别锚点：深红/酒红系双马尾；红粉系眼睛；双侧发饰。
出现入口：波岛/出海/Hashima/Izumi；绘画竞争；后辈；同人创作。
禁止脑补：不得写成金发；不得写成成熟御姐模板；不得无来源补巨乳或固定服装。
```

规则：

- `BOOTSTRAP` 只给 `scenePresence` 或检索副任务，不默认进入主 prompt。
- 它不是完整角色卡，不包含关系阶段、长背景和大段口吻。
- 它用于把“外貌入口、职业入口、别名入口、剧情入口”映射到角色 id。
- 角色被判进 present/focus 后，再注入完整 0 层世界书卡和 `APPEARANCE` guard。
- 没有可靠外貌锚点时，bootstrap 写 `unknown`，并显式禁止脑补发色、胸围、身材、年龄感和服装。

## 标签规范

推荐使用稳定 ASCII 标签，中文说明作为内容：

- `CHAR:megumi`
- `CHAR:eriri`
- `CHAR:utaha`
- `CHAR:izumi`
- `CHAR:michiru`
- `CHAR:sayuri`
- `CHAR:sonoko`
- `CHAR:akane`
- `EVENT:SAE_04-8`
- `SOURCE:worldbook`
- `SOURCE:memoryDB`
- `SOURCE:web-cache`

标签要短、稳定、重复出现。不要每个文档发明一套别名。

## 对现有提示词和世界书的影响

首版不改现有提示词和世界书核心内容。

未来实现时只允许追加适配层：

- 在世界书条目前补 DS 友好标题。
- 在 prompt 中追加温索引和证据包。
- 在 `scenePresence` 前追加初登场 bootstrap 索引，帮助前置判定命中角色。
- 调整 memoryDB 注入预算和排序。
- 强化输出格式护栏。

不允许因为 DeepSeek 模式而重写角色性格、删除原作底盘、改变 User 影响优先规则或让所有角色完整卡常驻。

## 关键原则

DeepSeek V4 的长上下文是优势。适配目标不是缩短世界，而是让每个角色都有后台位置，让当前主角被正确照亮。

普通、安静、不抢戏的角色也必须能被系统记住。加藤惠式的主角感不靠大声，而靠镜头调度、伏笔回收和正确的因果归属。
