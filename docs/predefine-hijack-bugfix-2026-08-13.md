# predefine.js 劫持机制关键 Bug 修复（2026-08-13）

## 问题描述

初次实现的劫持机制无法检测到任何 shujuku iframe，日志中只有 `observer started`，但没有 `detected new iframe` 或 `hijacked Object.defineProperty`。

## 根本原因

**监听了错误的 document**：

```typescript
// ❌ 错误代码
const doc = document;
const existingFrames = Array.from(doc.querySelectorAll<HTMLIFrameElement>(SHUJUKU_FRAME_SELECTOR));
```

这里的 `document` 指向的是 **Island 桥自己的 iframe 的 document**，而不是宿主页面的 document。

由于：
- Island 桥运行在 `TH-script--islandmilfcode` 这个 iframe 里
- shujuku 桥运行在 `TH-script--IslandMilfCode数据库转发桥` 这个 iframe 里
- 这两个 iframe 是**兄弟关系**，不是父子关系

因此：
- `document.querySelectorAll('iframe')` 只能查到 Island 自己 iframe **内部**的子 iframe
- 查不到**兄弟 iframe**（shujuku、存档桥、DICE 等）

## 用户提供的现场证据

用户在 SillyTavern 的 Console 中执行：

```javascript
Array.from(document.querySelectorAll('iframe')).map(f => ({ id: f.id, name: f.name }))
```

返回结果：

```javascript
[
  {id: 'TH-script--islandmilfcode', name: ''},
  {id: 'TH-script--IslandMilfCode数据库转发桥', name: ''},
  {id: 'TH-script--IslandMilfCode本机存档桥', name: ''},
  {id: 'TH-script--DICE', name: ''}
]
```

这证明：
- ✅ iframe 确实存在
- ✅ id 格式正确（`TH-script--*`）
- ❌ 旧代码无法检测到它们（因为监听的是错误的 document）

## 修复方案

**监听宿主页面的 document**：

```typescript
// ✅ 修复后的代码
const doc = window.parent.document;
if (!doc) {
  console.error(`${HIJACK_LABEL} parent document unavailable, cannot start observer`);
  return () => {};
}

console.info(`${HIJACK_LABEL} monitoring parent document: ${doc.location?.href || 'unknown'}`);

const existingFrames = Array.from(doc.querySelectorAll<HTMLIFrameElement>(SHUJUKU_FRAME_SELECTOR));
for (const frame of existingFrames) {
  diagnostics.framesDetected++;
  console.info(`${HIJACK_LABEL} found existing iframe ${frame.id}`);
  hijackFrameDefineProperty(frame);
}
```

### 为什么 `window.parent.document` 是正确的？

```
宿主页面 (window.parent)
├── iframe#TH-script--islandmilfcode (Island 桥，当前代码运行在这里)
├── iframe#TH-script--IslandMilfCode数据库转发桥 (shujuku 桥)
├── iframe#TH-script--IslandMilfCode本机存档桥 (存档桥)
└── iframe#TH-script--DICE (DICE 脚本)
```

- Island 桥的 `window` 指向 `iframe#TH-script--islandmilfcode` 的 window
- Island 桥的 `window.parent` 指向**宿主页面**的 window
- `window.parent.document` 可以查到所有兄弟 iframe

## 修复后的预期行为

刷新角色卡后，Console 中应该看到：

```
[islandmilfcode:predefine-hijack] monitoring parent document: http://localhost:8000/
[islandmilfcode:predefine-hijack] found existing iframe TH-script--IslandMilfCode数据库转发桥
[islandmilfcode:predefine-hijack] hijacked Object.defineProperty in iframe TH-script--IslandMilfCode数据库转发桥
[islandmilfcode:predefine-hijack] found existing iframe TH-script--IslandMilfCode本机存档桥
[islandmilfcode:predefine-hijack] hijacked Object.defineProperty in iframe TH-script--IslandMilfCode本机存档桥
[islandmilfcode:predefine-hijack] found existing iframe TH-script--DICE
[islandmilfcode:predefine-hijack] hijacked Object.defineProperty in iframe TH-script--DICE
```

以及在 `[islandmilfcode:init]` 日志中：

```javascript
predefineHijack: {
  observerStarted: true,
  framesDetected: 3,     // >= 3（检测到多个兄弟 iframe）
  framesHijacked: 3,     // >= 3（成功劫持）
  hijackFailures: [],    // 无失败
  stableFacadeCreated: true  // 创建了稳定 Proxy
}
```

## 修复文件

- `shujuku/predefine-hijack.ts` (L241-L255)：修改 `startPredefineHijack()` 监听 `window.parent.document`
- `humanpending.md` (HP-014)：更新验收标准和技术细节

## 后续验收

需要真人在真实酒馆环境下验收：
1. 刷新角色卡，检查劫持日志和诊断信息
2. 触发虚拟回合，验证 ACU 能通过稳定 Proxy 读取虚拟覆盖层
3. 确认虚拟回合不再报"chat 为空"或"A !== B"相关错误

完成验收前，不得将本机制标记为"生产可用"。
