# antiml 模块化重构方案

## 1. 背景与目标

`antiml` 的定位不是“酒馆原生楼层界面改皮”，而是一个**同层前端界面**：

- 玩家进入角色卡后，始终在一个前端界面中游玩；
- 0 层只作为**角色入口页 / 宿主挂载层**；
- 剧情消息依旧利用 SillyTavern 的楼层机制持久化；
- AI 生成、流式传输、停止、重试等能力由前端主动调用并控制；
- 玩家最终看到的内容，以前端界面渲染为准，而不是酒馆原生楼层为准。

当前主要问题不是“单个 bug”，而是职责混杂：

- 0 层既被当作前端挂载层，又被部分逻辑当作正文消息层；
- 前端运行态、酒馆持久化、UI 渲染、SillyTavern API 调用散落在多个文件中；
- 消息恢复逻辑依赖楼层位置关系，刷新后容易错位；
- 正则替换层、宿主层、剧情消息层三者语义没有严格分离；
- `index.ts` 负担过多，持续堆功能会让后续维护越来越脆。

本方案目标是：把 `antiml` 重构为一个**双层模式 + 明确模块边界**的前端系统。

---

## 2. 核心设计结论

### 2.1 0 层的定义

0 层是：

- 角色自定义界面入口；
- 前端应用宿主层；
- 固定挂载点。

0 层不是：

- 第一条剧情消息；
- 阅读器第一页正文；
- 对话历史恢复边界；
- user / assistant 计数的一部分。

### 2.2 双层模式

`antiml` 应采用“双层模式”：

#### 第一层：前端运行态真源

由前端 Store 维护：

- 当前可见消息列表；
- 流式中的临时文本；
- 当前输入框状态；
- 重试状态；
- 队列状态；
- 当前页面 UI 状态。

也就是说：**玩家看到什么，以前端状态为准。**

#### 第二层：SillyTavern 持久化层

由 SillyTavern 提供：

- `createChatMessages`
- `setChatMessages`
- `deleteChatMessages`
- `getChatMessages`

用于：

- 保存剧情记录；
- 支持回溯、删除、恢复；
- 在刷新后恢复前端消息历史。

也就是说：**SillyTavern 负责存档，不直接等于 UI。**

---

## 3. 总体架构

建议把 antiml 拆成以下几层：

### 3.1 宿主层（Host Layer）

职责：

- 负责把前端应用挂到 0 层；
- 只处理“如何进入 antiml”；
- 不参与剧情消息解释；
- 不负责恢复正文历史。

原则：

- 正则替换只负责挂载前端，不负责正文语义；
- 宿主层内容不应进入阅读器消息列表；
- 不再依赖“宿主层之后的楼层”这种位置关系判断正文归属。

### 3.2 前端状态层（App State Layer）

职责：

- 管理运行态 UI；
- 管理当前消息列表；
- 管理输入、阅读器、通知、流式中间态；
- 成为所有组件和动作的唯一状态来源。

原则：

- 任何组件不直接去读 SillyTavern 原始楼层；
- UI 渲染仅读 Store；
- 恢复历史时，先恢复到 Store，再由 Store 驱动渲染。

### 3.3 SillyTavern 对接层（ST Client Layer）

职责：

- 封装 `generate / generateRaw`；
- 封装流式事件监听；
- 封装停止生成、重试、注入提示词、覆盖历史等能力；
- 提供统一 ST API 入口，避免项目中到处直接访问 `window.xxx`。

原则：

- 所有 ST 能力通过统一 client 暴露；
- UI 组件不直接监听 `iframe_events`；
- `generate`、`stream`、`stop`、`retry` 等都走这一层。

### 3.4 剧情持久化层（Conversation Persistence Layer）

职责：

- 把当前对话以 chat messages 的形式写回酒馆；
- 读取属于 antiml 的消息并恢复；
- 处理回溯、删除、编辑同步；
- 维护消息 ID 映射。

原则：

- 消息归属必须靠**明确标记**识别，不能靠楼层相对位置推断；
- 推荐给 antiml 管理的消息统一写入 marker，例如：
  - `data.antiml_source = 'islandmilfcode'`
- 恢复时优先读取 marker 消息，旧数据再走兼容逻辑。

### 3.5 Prompt / 生成编排层（Prompt Orchestration Layer）

职责：

- 根据前端状态构建发送给 AI 的提示词；
- 管理完整历史注入；
- 管理系统提示、用户输入、队列任务等拼装逻辑；
- 为未来的合并发送、指令队列、自动重试提供统一入口。

原则：

- hidden messages 不依赖酒馆自动拼装；
- 提示词必须由前端显式构建；
- 不将“消息显示格式”和“提示词构建逻辑”混在一起。

### 3.6 渲染层（Render Layer）

职责：

- 只负责把状态映射成前端界面；
- 不直接调用 ST API；
- 不直接持久化；
- 不直接恢复历史。

原则：

- 渲染层保持纯粹；
- 输入、阅读器、通知、菜单、流式效果都从状态层拿数据；
- 避免在渲染层中混入业务判断。

---

## 4. 建议模块划分

### 4.1 `bootstrap/`

负责：

- 宿主层挂载；
- 启动前端应用；
- 初始化 ST client；
- 执行首次恢复。

建议文件：

- `bootstrap/mount.ts`
- `bootstrap/init.ts`

### 4.2 `st/`

负责：

- 封装 SillyTavern API；
- 统一事件监听；
- 统一生成请求能力。

建议文件：

- `st/client.ts`
- `st/events.ts`
- `st/generate.ts`
- `st/chat-messages.ts`

### 4.3 `state/`

负责：

- AppState；
- 消息状态；
- 阅读器状态；
- 输入状态；
- 队列状态。

建议文件：

- `state/app-store.ts`
- `state/message-store.ts`
- `state/reader-store.ts`
- `state/composer-store.ts`

### 4.4 `conversation/`

负责：

- 消息恢复；
- 消息持久化；
- 消息标记；
- 回溯与删除；
- 历史同步。

建议文件：

- `conversation/persistence.ts`
- `conversation/recovery.ts`
- `conversation/rollback.ts`
- `conversation/markers.ts`

### 4.5 `prompt/`

负责：

- Prompt 组装；
- 历史转 prompt；
- 队列注入；
- 角色状态与场景状态合并。

建议文件：

- `prompt/build-prompt.ts`
- `prompt/history.ts`
- `prompt/injects.ts`

### 4.6 `actions/`

负责：

- 发送；
- 停止；
- 重试；
- 合并发送；
- 队列处理。

建议文件：

- `actions/send.ts`
- `actions/stop.ts`
- `actions/retry.ts`
- `actions/queue.ts`

### 4.7 `ui/` 或 `render/`

负责：

- 页面渲染；
- 组件组合；
- 纯视图逻辑。

建议文件：

- `render/app.ts`
- `render/reader.ts`
- `render/composer.ts`
- `render/notifications.ts`

---

## 5. 消息模型设计

### 5.1 前端消息模型

前端 `UiMessage` 建议至少包含：

- `id`
- `role`
- `speaker`
- `text`
- `streaming`
- `tavernMessageId`
- `source`

其中 `source` 建议明确区分：

- `host`
- `conversation`
- `system`
- `queue`

这样可以从类型层面避免“宿主层被当剧情层”。

### 5.2 持久化识别规则

antiml 管理的消息必须带统一标识，例如：

```ts
data.antiml_source = 'islandmilfcode'
```

恢复策略：

1. 优先读取 marker 消息；
2. 若没有 marker，再兼容旧 hidden user/assistant 消息；
3. 不再按“宿主层之后”来推断归属。

---

## 6. 关键原则

### 原则 1：挂载层不参与正文恢复

0 层只负责挂载前端，不进入阅读器消息列表。

### 原则 2：消息归属靠标记，不靠位置

不能再使用：

- `getCurrentMessageId() + 1 ~ last`
- “宿主层之后的楼层”
- “当前可见楼层大概就是我的消息”

这种推断方式。

### 原则 3：前端自己掌控上下文

对于 `generate / generateRaw`：

- 历史由前端显式拼装；
- hidden messages 不依赖酒馆自动进 prompt；
- 流式文本由前端自行接收并更新 Store。

### 原则 4：SillyTavern 是底座，不是主界面

ST 提供：

- 生成能力；
- 流式事件；
- 持久化；
- 回溯结构。

但玩家真正看到的内容由 antiml 前端决定。

---

## 7. 分阶段重构计划

### 阶段一：架构定型

目标：

- 明确 0 层 = 宿主层；
- 明确双层模式；
- 统一消息 marker 方案；
- 输出模块边界。

产物：

- 本设计文档；
- 消息模型定义；
- 模块目录方案。

### 阶段二：SillyTavern 对接收口

目标：

- 建立统一 `st client`；
- 收口 `generate / generateRaw / stop / events / chatMessages`；
- 避免在多个文件中直接使用 `window.xxx`。

产物：

- `st/client.ts`
- `st/events.ts`
- `st/chat-messages.ts`

### 阶段三：消息持久化与恢复重构

目标：

- 所有 antiml 消息统一打 marker；
- 恢复逻辑从“按位置恢复”改为“按 marker 恢复”；
- 回溯和删除统一走消息 ID 映射。

产物：

- `conversation/persistence.ts`
- `conversation/recovery.ts`
- `conversation/rollback.ts`

### 阶段四：前端状态收敛

目标：

- 将消息、输入、阅读器、通知、流式态统一进 Store；
- 渲染层只读 Store；
- Actions 只改 Store 和调用 client。

产物：

- `state/*`
- `actions/*`

### 阶段五：高级交互能力

目标：

- 停止生成；
- 自动重试；
- 合并发送；
- 指令队列；
- 社交消息排队与统一发送。

这部分建议在架构清晰后再做，不应先堆在入口文件里。

---

## 8. 验收标准

重构完成后应满足：

### 宿主层

- 0 层只作为角色入口前端界面；
- 0 层不被视为阅读器第一条正文；
- 开场白 / 宿主文本不进入阅读器历史。

### 消息恢复

- 刷新后消息恢复不依赖宿主层位置；
- 不再出现首条丢失；
- 不再把原生开局消息误识别为正文。

### 架构边界

- `index.ts` / 启动文件仅保留装配职责；
- ST 对接通过统一 client 完成；
- Prompt 构建与 UI 渲染分离；
- 持久化逻辑与渲染逻辑分离。

### 功能行为

- 流式传输可持续更新前端；
- 停止生成不破坏前端运行态；
- 重试可以在 Store 中完成而不是依赖原生楼层 UI；
- 合并发送、队列等高级能力有明确落点。

---

## 9. 非目标

本轮不追求：

- 直接改造成流式楼层界面；
- 依赖原生楼层作为最终 UI；
- 用正则替换本身承载全部业务逻辑；
- 在 `index.ts` 继续堆新功能。

---

## 10. 最终结论

`antiml` 应被定义为：

> 一个以 0 层为宿主入口、以前端状态为运行态真源、以 SillyTavern 楼层为剧情记录层的同层前端界面系统。

它的核心不是“替换开局为一坨 HTML”，而是：

- 宿主层只负责挂载；
- 前端层负责体验；
- ST client 负责能力收口；
- 持久化层负责剧情记录；
- Prompt 层负责上下文编排。

这套边界清楚之后，后续的刷新恢复、流式显示、停止生成、自动重试、合并发送、指令队列，才有稳定落点。
