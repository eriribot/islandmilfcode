/**
 * shujuku predefine.js facade hijacker
 * 
 * 问题背景：
 * JS-Slash-Runner 的 predefine.js 为每个 userscript iframe 定义了 window.SillyTavern getter，
 * 每次读取时返回新对象 facade，导致 ACU 初始化时缓存的对象 A 和桥后续修改的对象 B 不是同一个引用，
 * 使得 installVirtualChatOverlay() 的 patch 对 ACU 无效。
 * 
 * 解决方案：
 * 在 shujuku iframe 创建时、predefine.js 执行前，劫持 Object.defineProperty，
 * 拦截对 window.SillyTavern 的定义，替换成返回稳定 Proxy 的版本。
 * 
 * 时序：
 * 1. Island 桥初始化，启动 MutationObserver 监听 DOM
 * 2. JS-Slash-Runner 创建 <iframe id="TH-script--xxx">
 * 3. MutationObserver 检测到 iframe 插入
 * 4. **劫持 iframe.contentWindow.Object.defineProperty** ← 在这里
 * 5. predefine.js 执行，调用被劫持的 Object.defineProperty
 * 6. 我们的劫持逻辑拦截到 window.SillyTavern 的定义，替换成稳定 Proxy
 * 7. ACU 初始化时读取 window.SillyTavern，获得稳定 Proxy 对象
 * 8. 桥后续修改 parent.SillyTavern.getContext() 的返回值，ACU 通过 Proxy 能感知到
 */

const SHUJUKU_FRAME_SELECTOR = 'iframe[id^="TH-script--"]';
const HIJACK_LABEL = '[islandmilfcode:predefine-hijack]';

interface HijackDiagnostics {
  observerStarted: boolean;
  framesDetected: number;
  framesHijacked: number;
  hijackFailures: Array<{ frameId: string; reason: string }>;
  stableFacadeCreated: boolean;
}

const diagnostics: HijackDiagnostics = {
  observerStarted: false,
  framesDetected: 0,
  framesHijacked: 0,
  hijackFailures: [],
  stableFacadeCreated: false,
};

/**
 * 创建稳定的 SillyTavern facade Proxy
 * 
 * 这个 Proxy 会在每次属性访问时，动态读取 parent.SillyTavern.getContext()，
 * 因此当 installVirtualChatOverlay() 修改 parent.SillyTavern.getContext() 时，
 * 通过这个 Proxy 读取的数据会立即反映最新的虚拟覆盖层。
 */
function createStableFacade(parentWindow: Window): object {
  const handler: ProxyHandler<object> = {
    get(target, prop, receiver) {
      // 特殊处理：让 Proxy 看起来像普通对象（避免某些库的 Proxy 检测）
      if (prop === Symbol.toStringTag) return 'Object';
      if (prop === 'constructor') return Object;
      
      // 核心逻辑：每次访问都从 parent.SillyTavern.getContext() 动态读取
      try {
        const parentST = (parentWindow as any).SillyTavern;
        if (!parentST) return undefined;
        
        // 优先从 getContext() 读取（支持虚拟覆盖层）
        if (typeof parentST.getContext === 'function') {
          try {
            const context = parentST.getContext();
            if (context && typeof context === 'object' && prop in context) {
              return context[prop];
            }
          } catch {
            // getContext() 失败时降级到直接读取
          }
        }
        
        // 降级：直接从 parent.SillyTavern 读取
        return parentST[prop];
      } catch {
        return undefined;
      }
    },
    
    set(target, prop, value, receiver) {
      // 所有写操作都转发到 parent.SillyTavern
      try {
        const parentST = (parentWindow as any).SillyTavern;
        if (!parentST) return false;
        parentST[prop] = value;
        return true;
      } catch {
        return false;
      }
    },
    
    has(target, prop) {
      try {
        const parentST = (parentWindow as any).SillyTavern;
        if (!parentST) return false;
        
        if (typeof parentST.getContext === 'function') {
          try {
            const context = parentST.getContext();
            if (context && typeof context === 'object') {
              return prop in context;
            }
          } catch {
            // 降级
          }
        }
        
        return prop in parentST;
      } catch {
        return false;
      }
    },
    
    ownKeys(target) {
      try {
        const parentST = (parentWindow as any).SillyTavern;
        if (!parentST) return [];
        
        if (typeof parentST.getContext === 'function') {
          try {
            const context = parentST.getContext();
            if (context && typeof context === 'object') {
              return Reflect.ownKeys(context);
            }
          } catch {
            // 降级
          }
        }
        
        return Reflect.ownKeys(parentST);
      } catch {
        return [];
      }
    },
    
    getOwnPropertyDescriptor(target, prop) {
      try {
        const parentST = (parentWindow as any).SillyTavern;
        if (!parentST) return undefined;
        
        if (typeof parentST.getContext === 'function') {
          try {
            const context = parentST.getContext();
            if (context && typeof context === 'object') {
              return Object.getOwnPropertyDescriptor(context, prop);
            }
          } catch {
            // 降级
          }
        }
        
        return Object.getOwnPropertyDescriptor(parentST, prop);
      } catch {
        return undefined;
      }
    },
  };
  
  return new Proxy({}, handler);
}

/**
 * 劫持 iframe 的 Object.defineProperty，拦截 window.SillyTavern 定义
 */
function hijackFrameDefineProperty(iframe: HTMLIFrameElement): boolean {
  try {
    const win = iframe.contentWindow;
    if (!win) {
      diagnostics.hijackFailures.push({ frameId: iframe.id, reason: 'contentWindow unavailable' });
      return false;
    }
    
    const parentWin = win.parent;
    if (!parentWin || parentWin === win) {
      diagnostics.hijackFailures.push({ frameId: iframe.id, reason: 'parent window unavailable' });
      return false;
    }
    
    // 保存原始 Object.defineProperty
    const originalDefineProperty = (win as any).Object.defineProperty;
    
    // 标记：避免重复劫持
    if ((win as any).__islandmilfcode_predefine_hijacked__) {
      console.warn(`${HIJACK_LABEL} iframe ${iframe.id} already hijacked, skip`);
      return false;
    }
    (win as any).__islandmilfcode_predefine_hijacked__ = true;
    
    // 创建稳定 facade（仅创建一次）
    let stableFacade: object | null = null;
    
    // 劫持 Object.defineProperty
    (win as any).Object.defineProperty = function (obj: any, prop: PropertyKey, descriptor: PropertyDescriptor) {
      // 检测：是否在定义 window.SillyTavern？
      if (obj === win && (prop === 'SillyTavern' || String(prop) === 'SillyTavern')) {
        console.info(`${HIJACK_LABEL} intercepted window.SillyTavern definition in iframe ${iframe.id}`);
        
        // 创建稳定 facade
        if (!stableFacade) {
          stableFacade = createStableFacade(parentWin);
          diagnostics.stableFacadeCreated = true;
          console.info(`${HIJACK_LABEL} created stable facade for iframe ${iframe.id}`);
        }
        
        // 替换成返回稳定 facade 的 getter
        const hijackedDescriptor: PropertyDescriptor = {
          get() {
            return stableFacade;
          },
          configurable: descriptor.configurable !== false, // 保持原配置
          enumerable: descriptor.enumerable !== false,
        };
        
        return originalDefineProperty.call(this, obj, prop, hijackedDescriptor);
      }
      
      // 其他属性定义不受影响
      return originalDefineProperty.call(this, obj, prop, descriptor);
    };
    
    console.info(`${HIJACK_LABEL} hijacked Object.defineProperty in iframe ${iframe.id}`);
    diagnostics.framesHijacked++;
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    diagnostics.hijackFailures.push({ frameId: iframe.id, reason });
    console.error(`${HIJACK_LABEL} failed to hijack iframe ${iframe.id}:`, error);
    return false;
  }
}

/**
 * 启动 MutationObserver 监听 shujuku iframe 创建
 */
export function startPredefineHijack(): () => void {
  if (diagnostics.observerStarted) {
    console.warn(`${HIJACK_LABEL} observer already started`);
    return () => {};
  }
  
  // ⚠️ 关键修复：必须监听宿主页面的 DOM，而不是 Island 桥自己 iframe 的 DOM
  const doc = window.parent.document;
  if (!doc) {
    console.error(`${HIJACK_LABEL} parent document unavailable, cannot start observer`);
    return () => {};
  }
  
  console.info(`${HIJACK_LABEL} monitoring parent document: ${doc.location?.href || 'unknown'}`);
  
  // 先劫持已存在的 iframe（可能在 Island 加载前就创建了）
  const existingFrames = Array.from(doc.querySelectorAll<HTMLIFrameElement>(SHUJUKU_FRAME_SELECTOR));
  for (const frame of existingFrames) {
    diagnostics.framesDetected++;
    console.info(`${HIJACK_LABEL} found existing iframe ${frame.id}`);
    hijackFrameDefineProperty(frame);
  }
  
  // 启动 MutationObserver 监听新创建的 iframe
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      
      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof HTMLIFrameElement)) continue;
        if (!node.id || !node.id.startsWith('TH-script--')) continue;
        
        diagnostics.framesDetected++;
        console.info(`${HIJACK_LABEL} detected new iframe ${node.id}`);
        
        // 劫持这个 iframe
        hijackFrameDefineProperty(node);
      }
    }
  });
  
  observer.observe(doc.body || doc.documentElement, {
    childList: true,
    subtree: true,
  });
  
  diagnostics.observerStarted = true;
  console.info(`${HIJACK_LABEL} observer started`);
  
  // 返回清理函数
  return () => {
    observer.disconnect();
    console.info(`${HIJACK_LABEL} observer stopped`);
  };
}

/**
 * 获取劫持诊断信息
 */
export function getHijackDiagnostics(): Readonly<HijackDiagnostics> {
  return { ...diagnostics };
}
