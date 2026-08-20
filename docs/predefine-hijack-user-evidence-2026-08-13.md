# Predefine Hijack 用户现场证据记录（2026-08-13）

## 背景

在实现 shujuku predefine.js facade 劫持机制后，用户在真实酒馆环境中进行了验收测试。

## 用户现场证据时间线

### 2026-08-13 21:16：劫持机制成功接通

**用户提供的截图证据**：
- Console 显示 `[islandmilfcode:predefine-hijack] monitoring parent document: http://127.0.0.1:8000/`
- Console 显示 `[islandmilfcode:predefine-hijack] found existing iframe TH-script--IslandMilfCode数据库转发桥`
- Console 显示 `[islandmilfcode:predefine-hijack] hijacked Object.defineProperty in iframe TH-script--IslandMilfCode数据库转发桥`
- Console 显示 `[islandmilfcode:predefine-hijack] intercepted window.SillyTavern definition in iframe TH-script--IslandMilfCode数据库转发桥`
- Console 显示 `[islandmilfcode:predefine-hijack] created stable facade for iframe TH-script--IslandMilfCode数据库转发桥`

**结论**：
- ✅ 劫持机制的监听 document 修复有效（从 `document` 改为 `window.parent.document`）
- ✅ 成功检测到 shujuku iframe
- ✅ 成功劫持 `Object.defineProperty`
- ✅ 成功拦截 `window.SillyTavern` 定义
- ✅ 成功创建稳定 Proxy

### 用户报告的问题："回退楼层还是 5"

**问题描述**：
- 用户说"是有了但我回退楼层还是5"
- 这说明劫持机制本身已经工作，但虚拟回合的某些功能可能仍有问题

**可能的根本原因**：

1. **劫持已生效，但 ACU 没有通过 Proxy 读取虚拟覆盖层**
   - 需要检查 `virtualContextOverlayReads` 是否 > 0
   - 如果 = 0，说明 ACU 可能在劫持前就缓存了对象引用

2. **劫持已生效，ACU 也读取了虚拟覆盖层，但虚拟时间线本身就只有 5 个楼层**
   - 需要检查 `shujuku:complete-timeline-ready` 日志中的 `virtualMessageCount`
   - 如果 `virtualMessageCount === 5`，说明问题不在劫持，而在虚拟时间线构建逻辑
   - 可能是 `archiveMessages` 为空，或者 `promptHistory` 只包含了最近 5 条消息

3. **"回退楼层 5"的含义不明确**
   - 可能是 ACU 规划审稿提示"当前在楼层 5"（这是正确的，因为用户正在楼层 5 输入）
   - 可能是 ACU 只能回退到楼层 5（期望回退到更早的楼层，比如楼层 3）
   - 可能是虚拟 chat 数组长度为 5（包含 root + 4 条逻辑消息）

## 下一步诊断步骤

### 步骤 1：检查 ACU 是否通过 Proxy 读取

在 Console 中找到 shujuku 桥的虚拟回合结束日志，查看：
```javascript
{
  virtualChatOverlayInstalled: true,  // 是否成功安装虚拟覆盖层
  virtualContextOverlayReads: 10,     // ACU 通过 Proxy 读取的次数（应该 > 0）
}
```

- 如果 `virtualContextOverlayReads === 0`：劫持生效了，但 ACU 没有使用被劫持的 facade
- 如果 `virtualContextOverlayReads > 0`：劫持完全接通，问题在虚拟时间线构建

### 步骤 2：检查虚拟时间线长度

在 Console 中找到 `shujuku:complete-timeline-ready` 日志，查看：
```javascript
{
  archiveMessageCount: 0,       // 从存档恢复的历史消息数量
  virtualMessageCount: 5,       // 虚拟 chat 数组的总长度
  promptMessageCount: 5,        // 传给 LLM 的消息数量
  logicalAssistantCountBeforeGeneration: 2,  // 虚拟回合前的 assistant 数量
}
```

- 如果 `virtualMessageCount === 5`：虚拟时间线确实只有 5 条消息
  - 检查 `archiveMessageCount` 是否为 0（历史消息未恢复）
  - 检查 `promptMessageCount` 是否也是 5（token 窗口限制）
- 如果 `virtualMessageCount > 5`：虚拟时间线长度足够，问题可能在 ACU 的楼层计算逻辑

### 步骤 3：明确"回退楼层 5"的具体含义

请用户提供：
1. ACU 规划审稿的完整提示文本（包含"当前楼层"和"可回退楼层"信息）
2. 用户期望回退到哪个楼层？为什么？
3. 虚拟回合前，真实的宿主 chat 数组有多少条消息？

## 技术分析：虚拟时间线构建

根据 `virtual-timeline.ts` 的实现：

```typescript
const virtualTimeline = buildShujukuVirtualTimeline({
  archiveMessages,        // 从存档恢复的历史消息（可能为空）
  runtimeMessages: promptHistory,  // 当前运行时的消息（token 窗口内）
  promptMessages: promptHistory,   // 传给 LLM 的消息
  currentUserId: submittedUserMessageId,
});
```

**虚拟 chat 数组 = `archiveMessages` + `runtimeMessages`**

如果 `archiveMessages` 为空，虚拟 chat 数组长度 = `runtimeMessages` 长度 = `promptHistory` 长度。

**`promptHistory` 是如何计算的？**
- `promptHistory` 由 Island 桥的 prompt 构建逻辑决定
- 它是 token 窗口内的消息，可能只包含最近 N 条消息
- 如果 token 窗口只允许 5 条消息，`promptHistory` 就只有 5 条

**为什么 `archiveMessages` 可能为空？**
- 如果 `submissionSaveId` 为空，`archiveMessages` 就是空数组（L2041-2043）
- `submissionSaveId` 是存档 ID，如果当前没有存档，就无法恢复历史消息

## 潜在解决方案

### 如果 `archiveMessages` 为空

**根本原因**：Island 桥没有传入有效的 `submissionSaveId`，导致无法从存档恢复历史消息。

**解决方案**：
1. 检查 `actions/index.ts:2041` 的 `submissionSaveId` 是否为空
2. 如果为空，排查为什么存档 ID 没有传入
3. 确保虚拟回合能正确读取当前存档的历史消息

### 如果 `promptHistory` 太短

**根本原因**：Island 桥的 token 窗口限制，只允许最近 5 条消息进入 prompt。

**解决方案**：
1. 虚拟回合不应受 token 窗口限制，应该包含**完整的逻辑时间线**
2. 考虑让 `runtimeMessages` 使用完整的 `state.uiMessages`，而不是 `promptHistory`
3. 或者扩大 token 窗口，让 `promptHistory` 包含更多历史消息

### 如果 ACU 的楼层计算有问题

**根本原因**：ACU 可能用 `chat.length` 计算"当前楼层"，而虚拟 chat 数组的长度确实只有 5。

**解决方案**：
1. 确认 ACU 的楼层计算逻辑
2. 如果 ACU 依赖 `chat.length`，就必须保证虚拟 chat 数组包含完整的历史消息
3. 或者修改 ACU，让它用 `floorIndex` 而不是 `chat.length` 计算楼层号

## 待用户提供的关键信息

1. **`virtualContextOverlayReads` 的值**（确认 ACU 是否通过 Proxy 读取）
2. **`virtualMessageCount` 的值**（确认虚拟时间线长度）
3. **`archiveMessageCount` 的值**（确认历史消息是否恢复）
4. **"回退楼层 5"的准确含义**（ACU 的提示文本截图）
5. **用户期望的行为**（希望 ACU 能回退到哪个楼层？为什么？）

在获得这些信息前，无法判断问题是劫持机制未生效，还是虚拟时间线构建逻辑有问题。
