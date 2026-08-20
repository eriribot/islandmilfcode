# shujuku predefine.js facade 劫持机制设计文档

**创建时间**：2026-08-13  
**状态**：已实现，待真人验收

---

## 问题背景

### 根本问题：对象身份分裂（A !== B）

JS-Slash-Runner 的 `predefine.js` 为每个 userscript iframe 定义了 `window.SillyTavern` getter，**每次读取时返回新对象**：

```javascript
// predefine.js (简化示意)
Object.defineProperty(window, 'SillyTavern', {
  get() {
    return { ...parent.SillyTavern.getContext() };  // 每次返回新对象
  }
});
```

这导致了严重的对象身份分裂问题：

1. **ACU 初始化时**（shujuku iframe 加载）：
   - 读取 `window.SillyTavern` → 获得对象 A
   - ACU 缓存 A 的引用到内部变量（如 `this.sillyTavern = window.SillyTavern`）

2. **Island 桥 `installVirtualChatOverlay()` 执行时**：
   - 再次读取 `window.SillyTavern` → 获得**新对象 B**
   - 修改 B 的 `chat`、`getContext()` 等属性

3. **ACU 调用 `triggerUpdate()` 时**：
   - 使用的是**初始化时缓存的对象 A**
   - 完全看不到 B 上的修改 → 虚拟覆盖层失效

**结论**：A !== B，Island 桥修改的对象和 ACU 使用的对象不是同一个引用。

### 之前失败的方案

尝试过的方案包括：

1. ❌ **Patch 多个候选对象**：在 `installVirtualChatOverlay()` 中 patch `runtime.sillyTavern`、`runtime.hostSillyTavern`、`runtime.runtimeWindow?.SillyTavern_API_ACU`，但都拿不到 ACU 内部持有的对象 A
2. ❌ **修改 `parent.SillyTavern.getContext()`**：理论可行，但 ACU 不走这条路径（实测 A !== B 证明 ACU 持有的对象不是通过 `parent.SillyTavern` 动态读取的）
3. ❌ **依赖脚本加载顺序**：无法可靠控制，且即使 Island 桥先加载，也无法在 ACU 初始化前注入稳定对象

---

## 解决方案：劫持 predefine.js

### 核心思路

**在 shujuku iframe 创建时、predefine.js 执行前，劫持 `Object.defineProperty`，拦截对 `window.SillyTavern` 的定义，替换成返回稳定 Proxy 的版本。**

这样：
- ACU 初始化时读取 `window.SillyTavern` → 获得**稳定 Proxy 对象**
- Island 桥后续修改 `parent.SillyTavern.getContext()` 的返回值
- **稳定 Proxy 的每次属性访问都动态调用 `parent.SillyTavern.getContext()`**
- → ACU 通过 Proxy 能感知到 Island 桥的虚拟覆盖层

### 时序控制

```
1. Island 桥 index.ts 全局作用域执行
   ↓ 同步调用 startPredefineHijack()
   ↓ 启动 MutationObserver 监听 DOM

2. JS-Slash-Runner 创建 <iframe id="TH-script--xxx">
   ↓ iframe 插入到 DOM

3. MutationObserver 检测到 iframe 插入
   ↓ 立即劫持 iframe.contentWindow.Object.defineProperty
   ↓ 标记 iframe.__islandmilfcode_predefine_hijacked__ = true

4. predefine.js 执行
   ↓ 调用 Object.defineProperty(window, 'SillyTavern', ...)
   ↓ **被劫持的 defineProperty 拦截到这次调用**
   ↓ 替换 descriptor 为返回稳定 Proxy 的 getter

5. ACU 初始化
   ↓ 读取 window.SillyTavern
   ↓ 获得稳定 Proxy 对象（而不是普通对象）

6. Island 桥 installVirtualChatOverlay()
   ↓ 修改 parent.SillyTavern.getContext() 的返回值

7. ACU 调用 triggerUpdate() / 读取 chat
   ↓ 通过稳定 Proxy 的 get trap
   ↓ 动态调用 parent.SillyTavern.getContext()
   ↓ **能感知到 Island 桥的虚拟覆盖层**
```

### 为什么能在 predefine.js 之前执行？

**关键点**：MutationObserver 的 microtask 优先级 + iframe 创建的异步性

1. Island 桥脚本在**自己的 iframe** 中运行，它的全局作用域代码（包括 `startPredefineHijack()`）会在该 iframe 加载时**同步执行**
2. `MutationObserver` 监听的是**宿主页面的 DOM**，而不是 Island 自己的 iframe
3. 当 JS-Slash-Runner 创建 shujuku iframe 时：
   - 先创建 `<iframe>` DOM 元素并插入到宿主页面
   - MutationObserver 的回调在 microtask 中触发
   - 然后才在 iframe 的 `contentWindow` 中执行 predefine.js

**时序保证**：DOM 插入 → MutationObserver 回调（劫持 Object.defineProperty）→ predefine.js 执行

---

## 实现细节

### 文件结构

- **`shujuku/predefine-hijack.ts`**：劫持逻辑与稳定 Proxy 实现
- **`index.ts:5891-5896`**：在 Island 桥初始化时同步启动劫持
- **`index.ts:5913`**：在 init 日志中记录劫持诊断信息
- **`index.ts:5955`**：在页面卸载时清理 MutationObserver

### 核心函数

#### 1. `createStableFacade(parentWindow: Window): object`

创建稳定的 SillyTavern facade Proxy，每次属性访问都动态读取 `parent.SillyTavern.getContext()`：

```typescript
const handler: ProxyHandler<object> = {
  get(target, prop, receiver) {
    // 每次访问都从 parent.SillyTavern.getContext() 动态读取
    const parentST = (parentWindow as any).SillyTavern;
    if (!parentST) return undefined;
    
    // 优先从 getContext() 读取（支持虚拟覆盖层）
    if (typeof parentST.getContext === 'function') {
      const context = parentST.getContext();
      if (context && typeof context === 'object' && prop in context) {
        return context[prop];
      }
    }
    
    // 降级：直接从 parent.SillyTavern 读取
    return parentST[prop];
  },
  
  set(target, prop, value, receiver) {
    // 所有写操作都转发到 parent.SillyTavern
    const parentST = (parentWindow as any).SillyTavern;
    if (!parentST) return false;
    parentST[prop] = value;
    return true;
  },
  
  // ... has, ownKeys, getOwnPropertyDescriptor 等也都动态代理
};

return new Proxy({}, handler);
```

**关键特性**：
- ✅ 每次属性读取都调用 `parent.SillyTavern.getContext()`，不缓存
- ✅ 支持虚拟覆盖层（Island 桥修改 `getContext()` 的返回值后立即生效）
- ✅ 写操作转发到 `parent.SillyTavern`，保持语义一致
- ✅ 实现了完整的 Proxy traps（get/set/has/ownKeys/getOwnPropertyDescriptor）

#### 2. `hijackFrameDefineProperty(iframe: HTMLIFrameElement): boolean`

劫持 iframe 的 `Object.defineProperty`，拦截对 `window.SillyTavern` 的定义：

```typescript
function hijackFrameDefineProperty(iframe: HTMLIFrameElement): boolean {
  const win = iframe.contentWindow;
  const parentWin = win.parent;
  
  // 保存原始 Object.defineProperty
  const originalDefineProperty = (win as any).Object.defineProperty;
  
  // 标记：避免重复劫持
  if ((win as any).__islandmilfcode_predefine_hijacked__) return false;
  (win as any).__islandmilfcode_predefine_hijacked__ = true;
  
  let stableFacade: object | null = null;
  
  // 劫持 Object.defineProperty
  (win as any).Object.defineProperty = function (obj: any, prop: PropertyKey, descriptor: PropertyDescriptor) {
    // 检测：是否在定义 window.SillyTavern？
    if (obj === win && prop === 'SillyTavern') {
      // 创建稳定 facade（仅创建一次）
      if (!stableFacade) {
        stableFacade = createStableFacade(parentWin);
      }
      
      // 替换成返回稳定 facade 的 getter
      const hijackedDescriptor: PropertyDescriptor = {
        get() { return stableFacade; },
        configurable: descriptor.configurable !== false,
        enumerable: descriptor.enumerable !== false,
      };
      
      return originalDefineProperty.call(this, obj, prop, hijackedDescriptor);
    }
    
    // 其他属性定义不受影响
    return originalDefineProperty.call(this, obj, prop, descriptor);
  };
  
  return true;
}
```

**关键特性**：
- ✅ 只拦截对 `window.SillyTavern` 的定义，其他属性不受影响
- ✅ 避免重复劫持（检查 `__islandmilfcode_predefine_hijacked__` 标记）
- ✅ 稳定 facade 只创建一次，后续读取都返回同一个 Proxy 对象
- ✅ 保持原 descriptor 的 configurable/enumerable 配置

#### 3. `startPredefineHijack(): () => void`

启动 MutationObserver 监听 shujuku iframe 创建：

```typescript
export function startPredefineHijack(): () => void {
  const doc = document;
  
  // 先劫持已存在的 iframe（Island 加载时 shujuku 可能已存在）
  const existingFrames = Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe[id^="TH-script--"]'));
  for (const frame of existingFrames) {
    hijackFrameDefineProperty(frame);
  }
  
  // 启动 MutationObserver 监听新创建的 iframe
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof HTMLIFrameElement)) continue;
        if (!node.id.startsWith('TH-script--')) continue;
        
        hijackFrameDefineProperty(node);
      }
    }
  });
  
  observer.observe(doc.body || doc.documentElement, {
    childList: true,
    subtree: true,
  });
  
  // 返回清理函数
  return () => observer.disconnect();
}
```

**关键特性**：
- ✅ 劫持已存在的 iframe（Island 可能后于 shujuku 加载）
- ✅ 监听新创建的 iframe（Island 可能先于 shujuku 加载）
- ✅ 只劫持 `id^="TH-script--"` 的 iframe（不影响其他 iframe）
- ✅ 返回清理函数，在页面卸载时停止监听

### 集成到 Island 桥

在 `index.ts` 中：

```typescript
// 5891-5896行：⚠️ 必须在 init() 之前同步启动劫持
import { startPredefineHijack, getHijackDiagnostics } from './shujuku/predefine-hijack';
const stopPredefineHijack = startPredefineHijack();

async function init() {
  // ... 原有初始化逻辑
  
  // 5913行：在 init 日志中记录劫持诊断信息
  console.info('[islandmilfcode:init]', {
    // ... 其他诊断信息
    predefineHijack: getHijackDiagnostics(),
  });
  
  // ... 继续初始化
  
  // 5955行：在页面卸载时清理 MutationObserver
  window.addEventListener('beforeunload', () => {
    // ... 其他清理逻辑
    stopPredefineHijack();
  });
}
```

---

## 诊断信息

### `HijackDiagnostics` 接口

```typescript
interface HijackDiagnostics {
  observerStarted: boolean;        // MutationObserver 是否已启动
  framesDetected: number;          // 检测到的 iframe 数量
  framesHijacked: number;          // 成功劫持的 iframe 数量
  hijackFailures: Array<{          // 劫持失败的记录
    frameId: string;
    reason: string;
  }>;
  stableFacadeCreated: boolean;    // 是否创建了稳定 facade
}
```

### 预期的诊断日志

成功劫持时：

```javascript
[islandmilfcode:predefine-hijack] hijacked Object.defineProperty in iframe TH-script--xxx
[islandmilfcode:predefine-hijack] intercepted window.SillyTavern definition in iframe TH-script--xxx
[islandmilfcode:predefine-hijack] created stable facade for iframe TH-script--xxx

[islandmilfcode:init] {
  predefineHijack: {
    observerStarted: true,
    framesDetected: 1,
    framesHijacked: 1,
    hijackFailures: [],
    stableFacadeCreated: true
  }
}
```

劫持失败时：

```javascript
[islandmilfcode:predefine-hijack] failed to hijack iframe TH-script--xxx: <错误信息>

[islandmilfcode:init] {
  predefineHijack: {
    observerStarted: true,
    framesDetected: 1,
    framesHijacked: 0,
    hijackFailures: [
      { frameId: 'TH-script--xxx', reason: 'contentWindow unavailable' }
    ],
    stableFacadeCreated: false
  }
}
```

---

## 验收步骤

### 前置条件

1. 导入最新构建的 Island 桥和 shujuku 桥
2. 确保 shujuku 以 userscript 模式运行（不是 extension 模式）

### 步骤 1：检查劫持是否成功

打开 Chrome DevTools Console，刷新角色卡，观察初始化日志中的 `predefineHijack` 字段：

```javascript
// 预期输出
[islandmilfcode:init] {
  predefineHijack: {
    observerStarted: true,
    framesDetected: 1,      // 应该 >= 1（检测到 shujuku iframe）
    framesHijacked: 1,      // 应该 >= 1（成功劫持）
    hijackFailures: [],     // 应该为空
    stableFacadeCreated: true  // 应该为 true
  }
}
```

**如果 `framesHijacked === 0`**：
- 检查 `hijackFailures` 数组，查看失败原因
- 可能的原因：跨域限制、iframe 未及时创建、contentWindow 不可访问

### 步骤 2：验证 ACU 是否使用稳定 Proxy

触发一次虚拟回合（shujuku 路线），观察 shujuku 桥日志：

```javascript
// 预期输出（在 shujuku 桥日志中）
virtualChatOverlayInstalled: true
virtualContextOverlayReads: <大于 0 的数字>  // 说明 ACU 通过 Proxy 读取了虚拟覆盖层
```

**如果 `virtualContextOverlayReads === 0`**：
- 说明 ACU 仍未使用被劫持的 facade
- 可能的原因：ACU 在劫持之前就缓存了对象、ACU 不走 `window.SillyTavern` 路径

### 步骤 3：验证虚拟回合是否正常运行

执行一次完整的 shujuku 虚拟回合：

1. 开启 shujuku 路线
2. 触发规划生成
3. 观察是否有"chat 为空"或"A !== B"相关错误
4. 确认规划结果能正常写入到卡内逻辑时间线

**预期结果**：
- ✅ 虚拟回合正常运行，不报错
- ✅ 规划结果正确写入到 `state.statusData`
- ✅ ACU 能感知到虚拟 chat 数据

---

## 边界与限制

### 只对本卡生效

劫持机制只在 Island 桥运行期间生效：

- ✅ 只劫持 `id^="TH-script--"` 的 iframe（shujuku 等 userscript iframe）
- ✅ 只在本 Island 卡的生命周期内生效
- ✅ 其他卡的脚本不受影响（切换到其他卡后，劫持自动停止）

### 无法劫持 Extension 模式

如果 shujuku 以 Extension 模式运行（在宿主页面而不是 iframe 中），劫持机制无效：

- ❌ Extension 模式下 shujuku 直接运行在宿主页面，没有 iframe
- ❌ 无法劫持 `window.Object.defineProperty`（修改宿主页面的 Object 会影响所有脚本）
- ✅ Extension 模式下天然没有 A !== B 问题（shujuku 直接访问宿主的 `window.SillyTavern`）

### 跨域限制

如果 shujuku iframe 与宿主页面跨域，劫持可能失败：

- ❌ 无法访问 `iframe.contentWindow`（跨域安全限制）
- ❌ 无法劫持 `Object.defineProperty`

但在实际环境中，JS-Slash-Runner 创建的 iframe 与宿主页面**同源**，因此不存在跨域问题。

---

## 失败情况处理

### 如果劫持方案失败

如果在真实环境中劫持方案无法工作（如 `framesHijacked === 0` 或 `virtualContextOverlayReads === 0`），有两条后备路径：

#### 方案 A：向 JS-Slash-Runner 提交 PR

修改 predefine.js，让 facade getter 返回稳定 Proxy 而不是每次新对象：

```javascript
// predefine.js 修改建议
const stableFacade = new Proxy({}, {
  get(target, prop) {
    return parent.SillyTavern.getContext()[prop];
  },
  set(target, prop, value) {
    parent.SillyTavern[prop] = value;
    return true;
  }
});

Object.defineProperty(window, 'SillyTavern', {
  get() { return stableFacade; }  // 每次返回同一个 Proxy
});
```

**优点**：
- ✅ 从根本上解决问题
- ✅ 所有依赖 predefine.js 的项目都能受益

**缺点**：
- ❌ 需要向上游提 PR，等待合并
- ❌ 用户需要更新 JS-Slash-Runner

#### 方案 B：切换到 Extension 模式

将 shujuku/ACU 安装为 SillyTavern 官方插件，规避 predefine.js 的 facade 问题。

**优点**：
- ✅ 天然规避 A !== B 问题
- ✅ 不需要修改任何源码

**缺点**：
- ❌ 需要用户重新安装 shujuku（从 userscript 改成 extension）
- ❌ 需要调整 Island 桥的 `findShujukuRuntime()` 等逻辑
- ❌ 可能失去 iframe 隔离等特性

---

## 总结

### 为什么这个方案能解决 A !== B 问题？

1. **劫持时机正确**：在 predefine.js 执行前劫持 `Object.defineProperty`
2. **稳定对象引用**：让 `window.SillyTavern` getter 返回同一个 Proxy 对象
3. **动态属性读取**：Proxy 的每次属性访问都调用 `parent.SillyTavern.getContext()`，能感知虚拟覆盖层
4. **只对本卡生效**：不影响其他卡的脚本，边界清晰

### 与之前方案的区别

| 方案 | 问题 | 劫持方案的改进 |
|------|------|----------------|
| Patch 多个候选对象 | 拿不到 ACU 内部持有的对象 A | ✅ 让 ACU 从一开始就持有稳定 Proxy |
| 修改 `parent.SillyTavern.getContext()` | ACU 不走这条路径（A !== B） | ✅ Proxy 强制 ACU 每次都走 `getContext()` |
| 依赖脚本加载顺序 | 无法可靠控制 | ✅ 用 MutationObserver 保证劫持在 predefine.js 之前 |

### 下一步

完成真人验收（HP-014）后，如果劫持方案在实际环境中工作正常，则可以将本机制标记为"生产可用"。

如果劫持方案失败，则需要评估是否采用方案 A（PR）或方案 B（Extension 模式）。
