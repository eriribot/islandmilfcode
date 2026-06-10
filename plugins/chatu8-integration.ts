import type { TavernWindow } from '../types';

/**
 * 智慧姬插件集成
 * 仓库: https://github.com/damoshen123/st-chatu8.git
 */

type TavernEventApi = Pick<TavernWindow, 'eventEmit' | 'eventOn' | 'eventRemoveListener'>;

function getEventApi(win: TavernWindow): TavernEventApi {
  const globalApi = globalThis as Partial<TavernEventApi>;
  return {
    eventEmit: win.eventEmit ?? globalApi.eventEmit,
    eventOn: win.eventOn ?? globalApi.eventOn,
    eventRemoveListener: win.eventRemoveListener ?? globalApi.eventRemoveListener,
  };
}

/**
 * 检查智慧姬插件是否安装
 * 通过多种方式检测：全局变量、扩展系统、DOM 元素
 */
export function isChatu8PluginAvailable(win: TavernWindow): boolean {
  const api = getEventApi(win);

  // 检查事件 API 是否可用
  if (typeof api.eventEmit !== 'function' || typeof api.eventOn !== 'function') {
    return false;
  }

  // 方法 1: 检查 SillyTavern 的扩展系统
  const globalScope = globalThis as {
    extensions?: string[];
    extensionNames?: string[];
    getContext?: () => { extensionNames?: string[]; extensions?: Record<string, unknown> };
    SillyTavern?: {
      extensions?: string[] | Record<string, unknown>;
      getContext?: () => { extensionNames?: string[]; extensions?: Record<string, unknown> };
    };
  };

  // 检查扩展名称数组
  const extensionNames =
    globalScope.extensions ||
    globalScope.extensionNames ||
    globalScope.getContext?.()?.extensionNames ||
    globalScope.SillyTavern?.extensions ||
    (Array.isArray(globalScope.SillyTavern?.getContext?.()?.extensionNames)
      ? globalScope.SillyTavern.getContext().extensionNames
      : []);

  // 智慧姬插件可能的扩展名
  const possibleNames = [
    'chatu8',
    'st-chatu8',
    'third-party-chatu8',
    'SillyTavern-Chatu8',
    'third-party/chatu8',
  ];

  if (Array.isArray(extensionNames)) {
    const found = possibleNames.some(name =>
      extensionNames.some(ext =>
        typeof ext === 'string' && ext.toLowerCase().includes(name.toLowerCase())
      )
    );
    if (found) return true;
  }

  // 检查扩展对象
  if (typeof extensionNames === 'object' && extensionNames !== null) {
    const extensionKeys = Object.keys(extensionNames);
    const found = possibleNames.some(name =>
      extensionKeys.some(key => key.toLowerCase().includes(name.toLowerCase()))
    );
    if (found) return true;
  }

  // 方法 2: 检查 DOM 中的扩展元素
  // SillyTavern 的扩展通常会在 DOM 中留下痕迹
  try {
    const extensionElements = document.querySelectorAll('[data-extension-name], .extension-block, [id*="chatu8"]');
    for (const element of extensionElements) {
      const extensionName = (
        element.getAttribute('data-extension-name') ||
        element.id ||
        element.className ||
        element.textContent
      )?.toLowerCase();

      if (extensionName && possibleNames.some(name => extensionName.includes(name.toLowerCase()))) {
        return true;
      }
    }

    // 检查扩展列表容器
    const extensionContainers = document.querySelectorAll('#extensions_list, .extensions-list, [class*="extensions"]');
    for (const container of extensionContainers) {
      const text = container.textContent?.toLowerCase() || '';
      if (possibleNames.some(name => text.includes(name.toLowerCase()))) {
        return true;
      }
    }
  } catch (e) {
    console.warn('[chatu8-integration] DOM 检测失败:', e);
  }

  // 方法 3: 检查事件监听器（扩展通常会注册事件）
  // 尝试发送一个测试事件看是否有响应
  try {
    let hasListener = false;
    const testEvent = 'chatu8-plugin-check';
    const testHandler = () => { hasListener = true; };

    // 暂时注册一个测试监听器
    if (typeof api.eventOn === 'function') {
      api.eventOn(testEvent, testHandler);

      // 尝试触发并检查
      const knownEvents = [
        'ch-char-data-import-request',
        'ch-llm-image-gen-request',
        'chatu8-task-request',
      ];

      // 如果这些事件的监听器存在，说明插件可能已加载
      // 注意：这只是一个启发式检测，不保证 100% 准确
    }
  } catch (e) {
    console.warn('[chatu8-integration] 事件检测失败:', e);
  }

  return false;
}

/**
 * 显示插件未安装提示
 */
export function showChatu8NotInstalledNotification(win: TavernWindow) {
  const message = '未检测到智慧姬插件。请先安装智慧姬插件后再使用此功能。\n\n插件仓库：https://github.com/damoshen123/st-chatu8.git';

  // 尝试使用 Tavern 的通知 API
  if (typeof win.toastr?.warning === 'function') {
    win.toastr.warning(message, '智慧姬插件未安装', {
      timeOut: 8000,
      extendedTimeOut: 3000,
    });
    return;
  }

  // 降级到浏览器原生 alert
  alert(message);
}

/**
 * 打开智慧姬插件界面
 * @returns 是否成功打开
 */
export function openChatu8Plugin(win: TavernWindow): boolean {
  if (!isChatu8PluginAvailable(win)) {
    showChatu8NotInstalledNotification(win);
    return false;
  }

  const api = getEventApi(win);

  // 尝试发送打开插件的事件
  // 根据智慧姬插件的实现，可能有以下几种事件名称
  const possibleEvents = [
    'open-chatu8-plugin',
    'chatu8-open',
    'st-chatu8-open',
    'chatu8_open',
  ];

  // 尝试所有可能的事件
  for (const eventName of possibleEvents) {
    try {
      api.eventEmit?.(eventName, {});
    } catch (error) {
      console.warn(`[chatu8-integration] Failed to emit ${eventName}:`, error);
    }
  }

  // 尝试调用全局方法
  const globalScope = globalThis as {
    openChatu8?: () => void;
    openChatu8Plugin?: () => void;
    chatu8Open?: () => void;
  };

  if (typeof globalScope.openChatu8 === 'function') {
    globalScope.openChatu8();
    return true;
  }

  if (typeof globalScope.openChatu8Plugin === 'function') {
    globalScope.openChatu8Plugin();
    return true;
  }

  if (typeof globalScope.chatu8Open === 'function') {
    globalScope.chatu8Open();
    return true;
  }

  // 尝试查找并点击智慧姬的按钮
  const possibleSelectors = [
    '[data-plugin="chatu8"]',
    '[data-chatu8-button]',
    '.chatu8-open-button',
    '#chatu8-open',
    'button[title*="智慧姬"]',
    'button[aria-label*="智慧姬"]',
  ];

  for (const selector of possibleSelectors) {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (button) {
      button.click();
      return true;
    }
  }

  console.warn('[chatu8-integration] Plugin is installed but could not find a way to open it');
  return true; // 插件已安装，但打开方式未知
}

/**
 * 请求智慧姬执行任务
 * @param taskType 任务类型
 * @param payload 任务数据
 * @param timeoutMs 超时时间（毫秒）
 */
export function requestChatu8Task<T = unknown>(
  win: TavernWindow,
  taskType: string,
  payload: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<T> {
  if (!isChatu8PluginAvailable(win)) {
    return Promise.reject(new Error('智慧姬插件未安装'));
  }

  const api = getEventApi(win);
  const requestId = `chatu8-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requestEvent = `chatu8-task-request`;
  const responseEvent = `chatu8-task-response`;

  return new Promise((resolve, reject) => {
    let handled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let stopListening: { stop?: () => void } | void;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      stopListening?.stop?.();
      api.eventRemoveListener?.(responseEvent, responseHandler);
    };

    const finish = (callback: () => void) => {
      if (handled) return;
      handled = true;
      cleanup();
      callback();
    };

    const responseHandler = (responseData: unknown) => {
      const response = responseData as {
        id?: string;
        success?: boolean;
        result?: T;
        error?: string;
      } | null;

      if (!response || response.id !== requestId) return;

      finish(() => {
        if (response.success === false) {
          reject(new Error(response.error ?? '智慧姬任务执行失败'));
          return;
        }
        resolve(response.result as T);
      });
    };

    timeoutId = setTimeout(() => {
      finish(() => reject(new Error('智慧姬任务请求超时')));
    }, timeoutMs);

    stopListening = api.eventOn(responseEvent, responseHandler);

    Promise.resolve(
      api.eventEmit(requestEvent, {
        id: requestId,
        type: taskType,
        payload,
      }),
    ).catch(error => {
      finish(() => reject(error));
    });
  });
}
