# JS/TS 工具调用方案

本文档记录 DeepSeek 模式后续接入联网检索工具的实现思路。目标是让外貌、服装、角色设计小细节或 canon 细节拿不准时，系统能通过 JS/TS 执行搜索和蒸馏，而不是让主模型凭印象补全。

## 核心判断

工具调用可以靠 JavaScript 或 TypeScript 实现。

模型本身不真正执行函数。DeepSeek API 的 tool calls 流程是：模型返回想调用的函数名和参数，调用方代码执行函数，再把结果作为 tool 消息交回模型。也就是说，真正的搜索、抓取、缓存、过滤和蒸馏都应该由本项目的 JS/TS 代码或一个本地 sidecar 服务完成。

## dist/index.html 的限制

打包后的 `dist/islandmilfcode/index.html` 是浏览器 / iframe 页面，不是 Node.js 运行时。

它不能直接调用：

- `fs`
- `child_process`
- `node:http`
- `node:https`
- 任意本地文件系统读写
- 任意 Node 包的服务端能力

它能做的是：

- 使用浏览器 `fetch` 调用远端 API 或本地 HTTP 服务。
- 使用酒馆 / Tavern Helper 暴露给 iframe 的前端 API，例如 `generateRaw`、事件、世界书读取等。
- 访问 `localStorage`、IndexedDB、DOM 和浏览器允许的网络请求。

因此，如果要做真实搜索、网页抓取、缓存和来源清洗，推荐让 `dist/index.html` 调用一个已经运行的本地 Node.js sidecar，而不是试图在 HTML 内直接跑 Node。

## 触发原则

每轮生成前做轻量不确定性审计，但不是每轮都联网。

只在以下情况触发工具：

- 外貌拿不准：发色、眼睛、发型、身高体型、年龄感、服装、饰品。
- 设计小细节拿不准：角色标志物、手机头像、社团/品牌/作品名、制服、舞台服、编辑部或创作工具。
- 初登场 bootstrap 本地锚点不足，无法帮助 `scenePresence` 正确识别角色。
- 用户明确询问原作、卷数、出场事件、设定来源或同人资料。
- 本地资料互相冲突，继续写会导致明显 canon 错误。

不触发工具：

- 当前轮只需要情绪推进、对话承接或关系反应。
- 本地世界书、`picresource`、memoryDB 或最近正文已经有足够锚点。
- 查到的资料不会改变当前可见描写。

## 推荐工具

首版只需要三个逻辑工具：

```text
search_web(query, intent, characterId?)
fetch_source(url)
distill_evidence(rawSource, intent, characterId?)
```

对外给模型看的工具可以更少，例如只暴露一个：

```text
lookup_character_detail(characterId, detailType, uncertaintyReason)
```

由 TS 内部再拆成搜索、抓取和蒸馏，避免模型直接控制太多底层步骤。

## TS 执行器流程

```text
副 API: 不确定性审计
  ↓
输出 need_search + detailType + queryHint
  ↓
TS 工具执行器
  ↓
搜索 / 抓取 / 去重 / 缓存
  ↓
副 API 或本地规则蒸馏为证据包
  ↓
写入临时 evidence pack
  ↓
主 API 只读取证据包，不读取网页原文
```

## 证据包格式

```text
[APPEARANCE][CHAR:akane][来源:web-cache:url-hash][置信度:medium]
必须遵守：深酒红/紫红系长发；红粉/紫红系眼睛。
禁止推论：不得写成金发；不得无来源补眼镜、制服或固定露出服装。
适用：红坂朱音初登场、正面描写、镜头观察或外貌纠偏。
```

设计细节示例：

```text
[DETAIL][CHAR:izumi][类型:design_small_detail][来源:web-cache:url-hash][置信度:medium]
事实：角色常见视觉锚点包含双侧发饰和深红系双马尾。
适用：初登场、头像描写、玩家观察她的发型或饰品时。
禁止推论：不得把发饰扩写成未确认的复杂首饰或制服设定。
```

## 浏览器与本地 sidecar

实现有两种路线：

- 浏览器内 TS：适合调用已有 API、读本地状态、组装 prompt；但会受 CORS、API key 暴露和网页抓取限制。
- 本地 Node.js sidecar：适合做真实搜索、抓网页、缓存、去重和来源清洗；前端只调用本地 HTTP 接口。

推荐后续采用本地 Node.js sidecar。原因是搜索 API key 更安全，抓取网页更可控，也方便做缓存和来源白名单。

推荐通信方式：

```text
dist/index.html
  ↓ fetch("http://127.0.0.1:8787/lookup-character-detail")
Node.js sidecar
  ↓ search / fetch / cache / distill
返回 evidence pack JSON
  ↓
dist/index.html 把证据包放入下一轮 prompt
```

注意：

- `index.html` 不能自己启动 sidecar；sidecar 必须由用户、启动脚本、酒馆插件或外部进程预先启动。
- 本地服务需要允许 CORS，至少允许来自酒馆 iframe 所在 origin 的请求。
- API key 不应写进打包后的 HTML，应该放在 sidecar 的环境变量或本地配置里。
- 如果 iframe sandbox 或浏览器策略拦截 `127.0.0.1` 请求，需要改走酒馆后端扩展或用户明确允许的代理接口。

## 缓存策略

联网结果不应每轮重复查。

建议缓存键：

```text
characterId + detailType + normalizedQuery
```

缓存内容：

- 来源 URL。
- 抓取时间。
- 蒸馏后的证据包。
- 置信度。
- 过期策略。

外貌和角色设计这类资料通常很稳定，可以长缓存。新闻、价格、现实地点营业信息才需要短缓存。

## 安全边界

- 主模型不能直接看到长网页原文。
- 主模型不能直接决定把搜索结果写入永久数据库。
- 工具结果必须先蒸馏成 `APPEARANCE`、`DETAIL`、`BOOTSTRAP` 或 `CANON_FACT` 证据包。
- 低置信结果只允许约束“不要脑补”，不能作为强事实写进正文。
