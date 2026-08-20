# 2026-08-10 问题链复现记录

本文件记录第二轮诊断轮的可执行问题链。它不是修复说明，也不把本地合同通过当作真实酒馆接通。

## A. 悬浮手机 `setPointerCapture`

状态：`executed`（真实页面）+ `executed`（最小 DOM）；源码未修复。

### 现场

- 页面：`http://127.0.0.1:8000/`，Chrome 外部已登录标签。
- 日志：`2026-08-10T14:31:37.194Z`。
- 原始错误：`VM8103:1:835916 InvalidStateError: Failed to execute 'setPointerCapture' on 'Element'`。
- 产物定位：当前内联脚本的相对偏移 `835896` 命中 `phone/floating.ts:113`；该元素由 `phone/render.ts:2177-2185` 生成为 `[data-action="open-phone"]` 的 `HTMLButtonElement`。

### 稳定复现步骤

1. 在 reader 上打开楼层右键菜单。
2. 左键按下悬浮手机按钮，不需要移动。
3. 捕获阶段 `index.ts:5829-5837` 调用 `closeReaderContextMenu(true)`。
4. `closeReaderContextMenu` 在 `index.ts:559-563` 同步 `render()`；`render()` 在 `index.ts:5774-5776` 用 `root.innerHTML` 替换整棵 UI。
5. 原始指针事件仍沿旧传播路径到达已断开的手机按钮，`phone/floating.ts:113` 调 `setPointerCapture`，Chrome 抛出异常。

最小 DOM 复现使用同样的“捕获阶段替换旧按钮，目标监听器随后捕获指针”结构，得到同名异常并观测到 `oldButton.isConnected === false`。无菜单时真实点击/拖动本轮未产生新增该错误，因此“任何点击都报错”不是当前证据支持的说法。

### 修复后验收（下一轮）

- 菜单打开场景无未捕获异常，菜单只关闭一次。
- 手机普通点击仍打开 phone，移动超过拖动阈值才移动且抑制 click。
- reader、后台任务栈、吐槽浮窗和 phone home 的其他 capture/release 路径保持原合同。

## B. 第二轮召回引文为 0

状态：`executed`（真实页面）；“渲染丢失”尚未成立。

### 现场事实

- 回到第二轮规划页后，页面显示：`召回引文` `共 0 条`，`本轮没有召回引文`；同时 `背景旁证` 为 `共 3 条`。
- 打开 shujuku 的 `纪要表` 导航，状态表显示：频率 `1`、未记录 `—`、上次更新 `未初始`、下次触发 `待初始`。当前可见表没有 AM 编码。
- 规划预设 `scripts/build-kirihime-island-preset.mjs` 把 `$5` 放入 `<memory_index>`，并明确要求 `<recall>` 只能返回该输入中真实存在的 AM 编码；没有编码时应保持空标签。
- `shujukuinject/context.ts:404-438` 的 `buildShujukuPlanningDisplaySnapshot()` 仅把 qrf 产出的 `AM\d+` 映射到规划时捕获的纪要/总结表快照。它不从 `<supplement>`、近期正文或常识创建 AM 记录。

因此当前证据支持的链是：`纪要表未初始化 -> $5 没有可用 AM 索引 -> qrf <recall> 为空 -> 规划页召回 0`。`背景旁证 3` 是另一条 `<supplement>` 链，不能替代召回。

### 之前合同的覆盖缺口

- `scripts/verify-island-planning-context.ts:245-265` 直接构造含 `AM0042` 的纪要快照。
- `scripts/verify-shujuku-v2-reader-planning.ts:73-100` 直接构造含 `AM21` 的 `pluginData` 和 `<recall>`。
- 这些合同证明“已有 AM 编码时渲染/快照不丢失”，没有证明“第一轮真实提交生成纪要 -> 第二轮 `$5` 非空 -> qrf 选择 AM -> UI 显示”。

### 修复前置与验收（下一轮）

1. 先备份并由人工确认是否允许初始化/接受纪要表；此动作可能改变真实 shujuku 表，不在本诊断轮执行。
2. 第一轮真实提交后记录：AM 编码、纪要表导出/持久化状态、handoff/table hash、当前 virtual user 的 qrf 字段。
3. 第二轮记录四个独立事实：`$5` `memory_index` 非空、qrf `<recall>` 非空且只含真实 AM、`_islandmilfcode_planning_display_v1.recallEntries` 非空、规划页引文数量大于 0。
4. 若第 1 步前置仍为 `未初始`，停止在数据前置层，不修改展示层来伪造“有引文”。

## C. 下一轮问题定位循环

每次复现按以下顺序记录，避免再次把下游 UI 当成上游成功：

1. **身份**：页面 URL、内联产物偏移/版本、宿主 floor、bridge 版本、exchange/generation id。
2. **前置**：菜单是否打开；纪要表是否初始化；目标表/快照 hash；当前轮输入和历史边界。
3. **触发**：单一用户动作或单一虚拟回合，不把刷新、重 roll、接受表格混在同一次触发中。
4. **上游证据**：指针事件的 `isConnected`/capture 状态；规划 `$5` 输入、qrf 字段、表导出。
5. **投影证据**：`plannedText`、planning display snapshot、iframe DOM 计数；分别记录 `<recall>` 和 `<supplement>`。
6. **归类**：前置未满足、上游未产生、桥丢失、投影丢失、仅视觉误读；只能选一个首个断点。
7. **修复验收**：只修首个断点，再完整重跑同一 frozen case；未通过前不扩大到相邻模块。

本轮结论：A 的首个断点是 DOM 生命周期与指针捕获竞态；B 的首个断点是纪要表未初始化，不能先归咎于规划卡渲染。
