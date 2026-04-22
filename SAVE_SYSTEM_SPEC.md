# Island Milf Code Save System Spec

## 1. 目标

本文件定义 `islandmilfcode` 的目标存档机制规范。

目标不是立即改代码，而是先统一以下问题：

- 什么才是“一个独立游戏档”的边界
- 新开 ST 对话后为什么还能看到旧档
- 自动存档、手动存档、回档之间的职责怎么划分
- `SillyTavern` 消息变量、前端内存态、本地持久化三者分别负责什么
- 后续如何从现有实现平滑迁移到目标模型

本规范参考当前对标项目的核心思路：

- 存档列表全局可见
- 实际运行态按 `runId` 隔离
- 手动存档是快照
- 自动存档是每条运行线上的持续覆盖点
- `SillyTavern` 不是存档边界，只是宿主

## 2. 核心结论

### 2.1 存档边界

`islandmilfcode` 后续应以 `runId` 作为真正的游戏档隔离边界，而不是：

- ST 聊天窗口
- 当前 iframe 会话
- 单个 `saveId`

定义如下：

- `runId`: 一条独立游戏线的唯一标识
- `saveId`: 该游戏线上的某一个恢复点

因此：

- 一个 `runId` 可以有多个手动存档
- 一个 `runId` 可以有一个或多个自动存档记录，但逻辑上只保留最新自动存档
- 同一个 ST 角色下，不同对话窗口可以共享存档列表
- 读档后必须切换当前活动 `runId`

### 2.2 ST 的角色

`SillyTavern` 在目标模型里只负责：

- 承载当前聊天
- 提供消息变量 / MVU / 消息列表接口
- 提供生成能力

`SillyTavern` 不应作为长期权威存档来源。

长期权威存档来源应是前端自己的本地持久化层。

### 2.3 当前状态的定位

当前项目已有以下基础能力：

- `saveId` 槽位保存
- `messages + statusData + summaryStore` 一起写入
- `statusSnapshot` 用于局部回滚
- 通过变量适配器把 `stat_data` 写回当前消息变量

但当前模型仍然存在以下结构性问题：

- 没有明确的 `runId` 层
- 全局 `status cache` 没有按档隔离
- 存档元数据和重数据没有拆层
- 恢复流程只恢复内存，不包含“运行态重建”的正式规范
- 自动存档和手动存档没有形成统一的生命周期模型

## 3. 目标模型

## 3.1 分层模型

目标存档系统分为四层：

### A. 运行态层

当前页面正在运行的内存状态。

包括：

- 当前 `runId`
- 当前 `saveId`
- 当前 `gameState`
- 当前 `chatLog`
- 当前 `summaryStore`
- 当前 UI 阅读位置

这是会话中的唯一真实工作状态。

### B. 快照层

存档快照，用于恢复。

包括：

- 手动存档快照
- 自动存档快照
- 消息级轻量快照

### C. 本地持久化层

长期权威存档层。

推荐职责：

- 保存存档元数据
- 保存完整快照负载
- 保存自动存档
- 保存大型聊天记录

该层不依赖 ST 当前消息是否还存在。

### D. ST 变量桥接层

用于当前轮交互、宿主同步和兼容恢复，不是长期权威源。

包括：

- `stat_data`
- 可能保留的 conversation variables
- 当前消息变量同步

## 3.2 全局共享与按档隔离

后续应明确区分：

### 全局共享数据

所有存档共享，和角色当前 iframe 绑定。

包括：

- 存档列表索引
- 用户偏好设置
- UI 布局设置
- 面板位置
- API 配置

### 按 runId 隔离的数据

每条游戏线独立。

包括：

- 剧情状态
- 角色状态
- 目标角色关系
- 背包
- 摘要状态
- 聊天记录
- 回滚快照
- 任何由剧情演进产生的数据

## 4. 数据结构规范

## 4.1 SaveMeta

轻量元数据，用于标题页展示和排序。

建议字段：

```ts
type SaveMeta = {
  saveId: string;
  runId: string;
  kind: 'manual' | 'autosave';
  label: string;
  createdAt: number;
  updatedAt: number;
  messageIndex: number;
  characterName: string;
  personality: string;
  appearance: string;
  location?: string;
  gameTime?: string;
  preview?: string;
  messageCount: number;
  version: number;
};
```

约束：

- `SaveMeta` 必须足够小
- 标题页只依赖 `SaveMeta`
- 不允许把完整 `chatLog` 塞在 `SaveMeta`

## 4.2 SavePayload

真正用于恢复的重数据。

建议字段：

```ts
type SavePayload = {
  saveId: string;
  runId: string;
  gameState: GameState;
  chatLog: PersistedMessage[];
  summaryStore: SummaryStore;
  messageSnapshots?: MessageSnapshot[];
  version: number;
};
```

约束：

- `gameState` 是恢复主入口
- `chatLog` 是玩家可见历史
- `summaryStore` 跟随存档，不是全局共享
- `messageSnapshots` 是局部回滚辅助数据

## 4.3 GameState

当前项目现有的 `statusData` 过于偏“单块状态”，后续应升级为更明确的 `gameState` 概念。

最低要求：

```ts
type GameState = {
  runId: string;
  statusData: StatusData;
  currentMessageIndex: number;
  worldState?: Record<string, unknown>;
  runtimeFlags?: Record<string, unknown>;
};
```

最低原则：

- `runId` 必须进入 `gameState`
- 存档恢复时，`gameState.runId` 是切档依据
- 当前运行态不得只依赖外层 `activeSaveId`

## 4.4 MessageSnapshot

消息级快照保留，但只作为局部回滚工具。

建议字段：

```ts
type MessageSnapshot = {
  messageIndex: number;
  kind: 'base' | 'delta';
  state: unknown;
  baseIndex?: number;
};
```

原则：

- 可以继续支持轻量消息快照
- 但消息快照不能代替正式存档
- 正式读档永远以 `SavePayload` 为准

## 5. 存储层规范

## 5.1 存储后端

目标方案应采用：

- 轻量元数据：可用 `localStorage` 或 IndexedDB 小记录
- 重量数据：必须迁移到 IndexedDB

不建议继续把所有存档都塞进单个 `localStorage` JSON。

原因：

- 配额小
- 单键膨胀快
- 任意一次写入失败会影响整组数据
- 不适合长聊天记录和大量快照

## 5.2 存储键规范

建议命名：

### 全局元数据

- `islandmilfcode:save-index:v2`
- `islandmilfcode:settings:v2`
- `islandmilfcode:active-run-id:v2`

### IndexedDB

数据库名建议：

- `IslandMilfCodeDB`

对象仓库建议：

- `save_meta`
- `save_payload`
- `chat_chunks`
- `runtime_cache`

### 按 runId 命名空间

任何缓存键都必须带 `runId`。

例如：

- `status-cache:${runId}`
- `autosave:${runId}`

## 5.3 Status Cache 规范

当前项目有单一全局键：

- `islandmilfcode-status-cache-v1`

目标规范：

- 不允许继续使用无 `runId` 的全局状态缓存
- 若保留缓存，只能作为崩溃恢复 fallback
- 缓存键必须命名空间化
- 缓存优先级必须低于正式存档

也就是说，缓存不是存档。

## 6. 生命周期规范

## 6.1 新游戏

“开始新游戏”时必须执行：

1. 生成新的 `runId`
2. 创建初始 `gameState`
3. 创建初始自动存档
4. 设置当前活动 `runId`
5. 设置当前活动 `saveId`
6. 清空或重建与上一档相关的运行态缓存
7. 渲染进入游戏

要求：

- 新游戏不是在旧档上“清空数据”
- 必须是新建一条独立运行线

## 6.2 手动存档

“手动存档”时必须执行：

1. 从当前运行态生成完整 `SavePayload`
2. 生成独立的 `saveId`
3. 写入 `SavePayload`
4. 写入对应 `SaveMeta`
5. 刷新标题页列表

要求：

- 手动存档是不可变快照
- 手动存档不覆盖旧手动存档

## 6.3 自动存档

自动存档应使用固定规则：

- `saveId = autosave_${runId}`

触发时机建议：

- 一次用户输入和 AI 回复完整完成后
- 变量变更确认后
- 消息编辑确认后
- 回滚完成后
- 摘要更新后

要求：

- 自动存档覆盖同一 `runId` 的最新自动存档
- 不产生无限增长的自动存档数量
- 自动存档和手动存档共用同一恢复逻辑

## 6.4 读档

读档必须执行正式恢复流程：

1. 读取 `SavePayload`
2. 恢复 `gameState`
3. 恢复 `chatLog`
4. 恢复 `summaryStore`
5. 切换当前活动 `runId`
6. 设置当前活动 `saveId`
7. 重建运行态依赖
8. 刷新 UI

这里的关键要求是：

读档不只是 `replaceConversationMessages + statusData = ... + render()`。

读档必须被定义成一次完整的“切档”过程。

## 6.5 返回标题页

返回标题页时：

- 若当前处于有效 `runId`，先执行自动存档
- 退出当前运行视图
- 不销毁全局存档索引
- 允许后续再进入同一档

## 7. 恢复后重建规范

这是当前项目和目标项目差距最大的地方。

恢复后必须允许执行统一的 post-restore 钩子。

建议定义 `rebuildRuntimeAfterRestore()` 之类的概念，职责包括：

- 重建当前激活目标
- 重建依赖 `statusData` 的衍生 UI
- 重建通知状态
- 重建消息焦点位置
- 清理未完成生成状态
- 清理过时上下文菜单状态
- 如未来存在按 runId 切换的扩展数据，也在这里统一恢复

原则：

- 恢复是数据过程
- 重建是运行态过程
- 两者不能混在几个散落的 UI 赋值里

## 8. ST 变量与存档的职责划分

## 8.1 `stat_data`

`stat_data` 应保留，但职责仅限于：

- 当前轮状态桥接
- 与宿主消息变量同步
- 页面刷新时的临时恢复辅助

不能把它定义成正式长期存档。

## 8.2 conversation variables

如果继续保留 conversation variables：

- 只作为兼容层或临时恢复层
- 不作为长期权威聊天记录
- 不作为唯一读档来源

## 8.3 host chat messages

隐藏消息恢复应视为遗留兼容手段，不再作为主要持久化方案。

## 9. 回滚规范

后续保留两种恢复能力：

### A. 正式读档

恢复整个 `SavePayload`。

适用于：

- 从标题页读档
- 跨会话恢复
- 崩溃后恢复

### B. 消息级回滚

恢复消息级快照。

适用于：

- 回到某一句重新生成
- 局部撤销当前分支

原则：

- 消息级回滚属于编辑工具
- 不是正式存档替代品

## 10. UI 规范

标题页应展示的是“全局存档列表”，而不是“当前聊天窗口的存档列表”。

每个存档项建议展示：

- 存档名
- 存档类型：手动 / 自动
- 角色名
- 最后更新时间
- 运行线标识的短形式
- 聊天条数
- 简短预览

推荐额外支持：

- 按 `runId` 分组查看
- 仅看当前运行线
- 自动存档折叠

## 11. 向现有实现的迁移约束

本次只是定规范，不写代码。

后续迁移时必须满足：

### 阶段 1

先补数据结构，不改 UI 行为：

- `SaveSlot` 扩展出 `runId`
- 引入 `SaveMeta / SavePayload` 概念
- 引入 `activeRunId`

### 阶段 2

迁移存储后端：

- `localStorage` 的整包 save 列表迁到元数据索引
- `chatLog` 和重负载迁入 IndexedDB

### 阶段 3

规范恢复流程：

- 正式区分“读档恢复”和“消息回滚”
- 恢复后统一执行 runtime rebuild

### 阶段 4

清理旧机制：

- 弱化全局单键 `status cache`
- 弱化隐藏消息恢复
- 弱化 conversation variables 对长期持久化的职责

## 12. 必须保留的兼容性目标

迁移后仍应支持：

- 老存档导入
- 老 `statusSnapshot` 回滚逻辑继续工作
- 在 ST 环境不可用时尽量降级运行
- 页面刷新后尽可能恢复当前活动档

## 13. 当前实现与目标实现对照

### 当前实现

- `activeSaveId` 是当前唯一主键
- `SaveSlot` 直接存 `messages + statusData + summaryStore`
- 所有 save 放在一个 `localStorage` 键里
- `status cache` 是全局单键
- `enterSave()` 只做内存恢复

### 目标实现

- `activeRunId + activeSaveId` 双主键
- `runId` 是隔离边界
- 元数据和重数据分层
- 大数据进入 IndexedDB
- `status cache` 改成按 `runId` 命名空间
- 读档恢复和运行态重建分离

## 14. 最终规范一句话版

`islandmilfcode` 的存档系统应改为：

“全局共享存档列表，按 `runId` 隔离游戏线，按 `saveId` 表示恢复点，本地持久化层作为长期权威源，ST 变量仅作为当前轮桥接和兼容恢复层。”

## 15. 后续文档建议

本规范确认后，下一步建议补两份文档：

1. `SAVE_MIGRATION_PLAN.md`
   - 按阶段拆迁移步骤

2. `SAVE_DATA_SCHEMA.md`
   - 把最终 TypeScript 结构写严谨

