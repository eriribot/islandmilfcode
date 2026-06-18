# DeepSeek V4 适配模式

本目录记录 DeepSeek V4 / V4-Pro 的同层卡适配方案。首版只做文档，不接 UI，不修改主提示词，不修改世界书，不改生成链路，也不接联网检索脚本。

## 定位

DeepSeek 模式不是重写角色卡，也不是替换现有世界书。它是一层面向 DS V4 注意力机制的上下文适配器：在用户未来手动开启后，调整资料打包方式、格式护栏、记忆预算建议和证据块结构，让 DS 更稳定地抓住当前镜头和长期伏笔。

现有核心架构保持不变：

- `scenePresence` 继续负责判断当前镜头里谁明确在场、谁是转场目标、谁只是被提及。
- `activeCharacterCards` 继续只为当前在场或转场目标注入完整 0 层角色卡。
- `memoryDB` 继续作为结构化长期记忆层，摘要和历史事实只补足背景，不抢走当前镜头焦点。
- 世界书继续保存完整角色档案、原著底盘、剧情事件和场景资料。

一句话：不动角色灵魂，只给 DeepSeek 一套更容易抓住重点的舞台灯光。

## 启用边界

后续实现默认采用手动开关：

- 默认关闭。
- 由用户在设置页明确开启。
- 不根据模型名自动启用，避免代理端点或自定义模型名误判。
- 开启后只影响上下文组织和辅助提示，不改变角色关系、剧情事实和世界书原文的权威性。

首版文档的边界：

- 不新增 UI。
- 不新增配置字段。
- 不创建 API 调用。
- 不写联网检索 sidecar。
- 不改 `buildPrompt`、`relationship.ts`、世界书 JSON/YAML 或现有 DeepSeek 格式指南。

## 文档索引

- [DSV4_ATTENTION_STRATEGY.md](./DSV4_ATTENTION_STRATEGY.md)：从 DS V4 的压缩/稀疏注意力出发，定义同人资料分层和证据块格式。
- [DEEPSEEK_MODE_WORKFLOW.md](./DEEPSEEK_MODE_WORKFLOW.md)：描述未来手动开启 DeepSeek 模式后的生成工作流、主副 API 分工和实现边界。
- [FIRST_APPEARANCE_BOOTSTRAP.md](./FIRST_APPEARANCE_BOOTSTRAP.md)：针对初登场链路空窗，定义 scenePresence 前置的短外貌/身份索引；首批重点覆盖出海、町田苑子、红坂朱音。
- [TOOL_CALLING_JS_TS.md](./TOOL_CALLING_JS_TS.md)：说明外貌或设计小细节不确定时，如何由 JS/TS 工具执行器完成搜索、抓取、缓存和证据包蒸馏。
- [CACHE_HIT_STRATEGY.md](./CACHE_HIT_STRATEGY.md)：说明 DeepSeek context cache 的前缀命中规则，以及同层卡 prompt 如何按稳定前缀/动态尾部组织。
- [DS_AGENT_CAPABILITY_ASSESSMENT.md](./DS_AGENT_CAPABILITY_ASSESSMENT.md)：评估 DeepSeek 在本项目里的 agent 程度，修正 HideWebSearch 的真实作用，并给出基于 SillyTavern WebSearch 结果的证据包方案。
- [PROJECT_AGENT_ARCHITECTURE_ASSESSMENT.md](./PROJECT_AGENT_ARCHITECTURE_ASSESSMENT.md)：评估项目代码本身的 agent 化程度，说明如何用代码外骨骼驱动 DeepSeek 这类弱扮演模型提高同人卡质量。

## 与现有指南的关系

`DeepSeek_V4_格式优化指南.md` 主要处理输出格式稳定性，例如标签、stop words、few-shot 和参数建议。

本目录处理上下文注意力适配，例如：

- 长上下文如何作为优势使用。
- 非当前角色如何以短胶囊留在后台。
- 当前镜头角色如何获得完整卡和声线样例。
- 同人资料如何变成带来源、置信度和禁止推论的证据包。
- 联网检索如何先做每轮自检门控，再决定是否真的触发搜索。
- 初登场角色如何在完整世界书卡注入前，被 scenePresence 正确识别出来。
- JS/TS 如何实现工具调用执行器，而不是让模型直接联网或直接读取网页原文。
- 如何保护 DeepSeek 的缓存命中率，避免动态信息插到稳定长上下文前面。

两者互补，不互相替代。
