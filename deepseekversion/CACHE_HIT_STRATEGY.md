# DeepSeek 缓存命中策略

本文档记录 DeepSeek 模式下的缓存命中设计。目标是在保留长上下文优势的同时，提高 DeepSeek context cache 的命中率，避免每轮把稳定资料重新按 cache miss 计费。

## 官方规则要点

DeepSeek Context Caching 默认开启。后续请求如果和历史请求有重叠前缀，并且该前缀已经持久化，就可能命中缓存。

关键点：

- 缓存按请求前缀匹配。
- 后续请求必须完整复用某个已持久化的 cache prefix unit 才能命中。
- 缓存是 best-effort，不保证 100% 命中。
- 响应 `usage` 中可查看 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。

工程结论：稳定内容越靠前、越少变动，越有利于缓存命中。动态内容越靠前，越容易把后面的长上下文都变成 miss。

## 同层卡的缓存风险

如果 prompt 顺序是：

```text
当前时间 / 当前地点 / scenePresence / 当前输入
  ↓
大段世界书 / 角色卡 / 记忆库
```

那么每轮当前时间、地点、scenePresence 或玩家输入变化，都会破坏后续大段内容的前缀复用。

这对 DeepSeek 特别亏，因为 V4 的 1M 上下文和缓存价格差距很大。我们应该把可复用的大块稳定上下文放在动态内容之前。

## 推荐 Prompt 分区

未来 DeepSeek 模式建议把 prompt 分成四段。

### A. 全局稳定前缀

尽量每轮完全一致。

内容：

- DeepSeek 模式静态规则。
- 输出格式硬规则。
- 同层卡总原则。
- `scenePresence` 判定定义。
- 角色 id / 别名 / bootstrap 目录。
- 工具调用约定。

要求：

- 不放当前时间。
- 不放当前地点。
- 不放当前玩家输入。
- 不放随机 id、生成时间戳、调试信息。
- 列表顺序稳定。

### B. 会话稳定前缀

同一个存档内大多不变，偶尔变化。

内容：

- 已绑定角色列表。
- 角色 bootstrap catalog。
- 稳定外貌锚点 catalog。
- 世界书条目标题索引。
- 工具/schema 说明。

要求：

- 更新时整块版本号递增。
- 避免每轮重排。
- 不把本轮检索结果插进这里。

### C. 本轮动态上下文

每轮变化，放在稳定前缀之后。

内容：

- 当前时间、地点、事件。
- scenePresence 结果。
- 当前在场角色 0 层卡。
- 本轮 APPEARANCE / DETAIL / CANON_FACT 证据包。
- memoryDB 本轮检索结果。
- 最近对话。
- 玩家当前输入。

要求：

- 动态内容不要插入 A/B 段中间。
- 工具检索结果只放 C 段或更靠后。
- 如果必须使用长动态资料，先蒸馏成短证据包。

### D. 输出任务尾部

放最后。

内容：

- 本轮具体生成任务。
- 本轮禁止事项。
- 本轮需要停止的位置。

要求：

- 保持短。
- 不重复 A 段格式规则。

## Bootstrap 与缓存

初登场 bootstrap 不应该每轮临时拼成不同文本。

推荐：

- 把所有角色的短 bootstrap catalog 放进 B 段。
- 每轮自检只输出候选 `CHAR` id 和原因。
- 被选中的候选再进入 C 段，作为本轮判定输入。

这样既能让 `scenePresence` 提前识别初登场角色，又不会因为每轮重新生成 bootstrap 文本而破坏缓存前缀。

## 工具检索与缓存

联网检索结果高度动态，不能插进稳定前缀。

推荐：

```text
A 稳定规则
B 稳定 catalog
C 本轮工具证据包
D 本轮任务
```

工具结果缓存分两层：

- DeepSeek context cache：依赖 prompt 前缀稳定。
- 本地 sidecar cache：按 `characterId + detailType + normalizedQuery` 缓存搜索和蒸馏结果。

二者不要混淆。DeepSeek 缓存省模型输入成本，本地 sidecar 缓存省搜索/抓取成本和网络延迟。

## 监控指标

如果调用链能拿到 DeepSeek 原始响应，记录：

- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- hit ratio = hit / (hit + miss)
- 本轮是否插入工具证据包
- 本轮 A/B 段版本号

如果 Tavern Helper 或代理层不暴露 `usage`，至少在 debug 面板记录 A/B 段 hash，确认稳定前缀没有被无意修改。

## 验收标准

- DeepSeek 模式下，静态规则和 bootstrap catalog 不随每轮输入重排。
- 当前时间、地点、scenePresence、玩家输入和工具结果都位于稳定前缀之后。
- 工具搜索命中不破坏全局稳定前缀。
- 能通过 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 或本地 hash 观察缓存效果。
