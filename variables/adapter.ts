import type { StatusData, TavernWindow } from '../types';
import { normalizeStatusData, defaultStatusData, serializeStatusData } from './normalize';
import { protectTargetAffinityReset } from './runtime-guard';

export interface VariableAdapter {
  readonly source: 'mvu' | 'fallback';
  load(): StatusData;
  save(data: StatusData): void;
  onUpdate(callback: (data: StatusData) => void): () => void;
}

// ── MVU 适配器：通过 VARIABLE_UPDATE_ENDED 事件驱动 ──

function createMvuAdapter(win: TavernWindow, Mvu: any): VariableAdapter {
  let lastLoadedStatusData: StatusData | null = null;

  function getMessageId() {
    return typeof win.getCurrentMessageId === 'function' ? win.getCurrentMessageId() : 'latest';
  }

  function acceptLoadedStatusData(data: StatusData, source: string) {
    const protectedData = protectTargetAffinityReset(data, lastLoadedStatusData, source);
    lastLoadedStatusData = protectedData;
    return protectedData;
  }

  function loadMessageVariables(messageId: string | number): StatusData | null {
    try {
      const data = Mvu.getMvuData?.({ type: 'message', message_id: messageId });
      if (data?.stat_data) return acceptLoadedStatusData(normalizeStatusData(data.stat_data), `mvu:${messageId}`);
    } catch { /* 继续尝试后备读取 */ }

    try {
      const variables = win.getVariables?.({ type: 'message', message_id: messageId }) ?? {};
      if (variables.stat_data) return acceptLoadedStatusData(normalizeStatusData(variables.stat_data), `variables:${messageId}`);
    } catch { /* 继续尝试更早楼层 */ }

    return null;
  }

  function loadNearestMessageVariables(): StatusData | null {
    const current = getMessageId();
    const currentLoaded = loadMessageVariables(current);
    if (currentLoaded) return currentLoaded;

    const currentNumber = Number(current);
    if (!Number.isInteger(currentNumber) || currentNumber < 0) return null;

    // 中文注释：MVU/楼层变量有时只存在于上一条消息；当前楼层空变量不能回落默认值，否则会把好感清零。
    for (let messageId = currentNumber - 1; messageId >= Math.max(0, currentNumber - 30); messageId -= 1) {
      const loaded = loadMessageVariables(messageId);
      if (loaded) return loaded;
    }

    return null;
  }

  return {
    source: 'mvu',

    load(): StatusData {
      const nearest = loadNearestMessageVariables();
      if (nearest) return nearest;

      // MVU 可用但暂时没有数据时，改用 getVariables 作为次级来源。
      try {
        const messageId = getMessageId();
        const variables =
          win.getVariables?.({ type: 'message', message_id: messageId }) ??
          win.getVariables?.({ type: 'message' }) ?? {};
        if (variables.stat_data) {
          return acceptLoadedStatusData(normalizeStatusData(variables.stat_data), `variables:${messageId}`);
        }
      } catch { /* 继续使用默认状态 */ }

      return acceptLoadedStatusData(normalizeStatusData(defaultStatusData), 'default');
    },

    save(data: StatusData): void {
      try {
        lastLoadedStatusData = data;
        const messageId = getMessageId();
        const serialized = serializeStatusData(data);

        // 优先尝试 MVU 的 replaceMvuData。
        if (typeof Mvu.replaceMvuData === 'function') {
          const currentData = Mvu.getMvuData?.({ type: 'message', message_id: messageId }) ?? {};
          Mvu.replaceMvuData({ ...currentData, stat_data: serialized }, { type: 'message', message_id: messageId });
          return;
        }

        // 回退到 updateVariablesWith。
        win.updateVariablesWith?.(variables => {
          variables.stat_data = serialized;
        }, { type: 'message', message_id: messageId });
      } catch { /* 不在 Tavern 内时忽略 */ }
    },

    onUpdate(callback: (data: StatusData) => void): () => void {
      // 监听 MVU 的 VARIABLE_UPDATE_ENDED 事件。
      if (Mvu.events?.VARIABLE_UPDATE_ENDED && typeof win.eventOn === 'function') {
        const { stop } = win.eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {
          callback(this.load());
        });
        return stop;
      }

      // MVU 存在但没有事件支持时，回退到轮询。
      const timer = window.setInterval(() => {
        callback(this.load());
      }, 1500);
      return () => window.clearInterval(timer);
    },
  };
}

// ── 后备适配器：通过 setInterval 轮询 ──

function createFallbackAdapter(win: TavernWindow): VariableAdapter {
  let lastLoadedStatusData: StatusData | null = null;

  function getMessageId() {
    return typeof win.getCurrentMessageId === 'function' ? win.getCurrentMessageId() : 'latest';
  }

  function acceptLoadedStatusData(data: StatusData, source: string) {
    const protectedData = protectTargetAffinityReset(data, lastLoadedStatusData, source);
    lastLoadedStatusData = protectedData;
    return protectedData;
  }

  function loadMessageVariables(messageId: string | number): StatusData | null {
    try {
      const variables = win.getVariables?.({ type: 'message', message_id: messageId }) ?? {};
      if (variables.stat_data) return acceptLoadedStatusData(normalizeStatusData(variables.stat_data), `fallback:${messageId}`);
    } catch { /* 继续尝试更早楼层 */ }
    return null;
  }

  function loadNearestMessageVariables(): StatusData | null {
    const current = getMessageId();
    const currentLoaded = loadMessageVariables(current);
    if (currentLoaded) return currentLoaded;

    const currentNumber = Number(current);
    if (!Number.isInteger(currentNumber) || currentNumber < 0) return null;

    // 中文注释：后备适配器也向前找最近 stat_data，避免当前消息变量为空时把关系变量重置为默认 0。
    for (let messageId = currentNumber - 1; messageId >= Math.max(0, currentNumber - 30); messageId -= 1) {
      const loaded = loadMessageVariables(messageId);
      if (loaded) return loaded;
    }

    return null;
  }

  return {
    source: 'fallback',

    load(): StatusData {
      const nearest = loadNearestMessageVariables();
      if (nearest) return nearest;

      try {
        const messageId = getMessageId();
        const variables =
          win.getVariables?.({ type: 'message', message_id: messageId }) ??
          win.getVariables?.({ type: 'message' }) ?? {};
        if (variables.stat_data) {
          return acceptLoadedStatusData(normalizeStatusData(variables.stat_data), `fallback:${messageId}`);
        }
      } catch { /* 继续使用默认状态 */ }

      return acceptLoadedStatusData(normalizeStatusData(defaultStatusData), 'fallback:default');
    },

    save(data: StatusData): void {
      try {
        lastLoadedStatusData = data;
        const messageId = getMessageId();
        win.updateVariablesWith?.(variables => {
          variables.stat_data = serializeStatusData(data);
        }, { type: 'message', message_id: messageId });
      } catch { /* 不在 Tavern 内时忽略 */ }
    },

    onUpdate(callback: (data: StatusData) => void): () => void {
      const timer = window.setInterval(() => {
        callback(this.load());
      }, 1500);
      return () => window.clearInterval(timer);
    },
  };
}

// ── 工厂：异步初始化，优先尝试 MVU ──

/**
 * 创建合适的变量适配器。
 * 优先等待 MVU 初始化，失败后回退到直接读取 getVariables。
 */
export async function createVariableAdapter(win: TavernWindow): Promise<VariableAdapter> {
  try {
    // waitGlobalInitialized 由 tavern helper 运行时提供。
    const waitGlobal = (window as any).waitGlobalInitialized;
    if (typeof waitGlobal === 'function') {
      const Mvu = await Promise.race([
        waitGlobal('Mvu'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      if (Mvu) {
        return createMvuAdapter(win, Mvu);
      }
    }
  } catch { /* MVU 不可用，使用后备适配器 */ }

  return createFallbackAdapter(win);
}
