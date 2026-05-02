import type { StatusData, TavernWindow } from '../types';
import { normalizeStatusData, defaultStatusData, serializeStatusData } from './normalize';

export interface VariableAdapter {
  readonly source: 'mvu' | 'fallback';
  load(): StatusData;
  save(data: StatusData): void;
  onUpdate(callback: (data: StatusData) => void): () => void;
}

// ── MVU 适配器：通过 VARIABLE_UPDATE_ENDED 事件驱动 ──

function createMvuAdapter(win: TavernWindow, Mvu: any): VariableAdapter {
  function getMessageId() {
    return typeof win.getCurrentMessageId === 'function' ? win.getCurrentMessageId() : 'latest';
  }

  return {
    source: 'mvu',

    load(): StatusData {
      try {
        const messageId = getMessageId();
        const data = Mvu.getMvuData?.({ type: 'message', message_id: messageId });
        if (data?.stat_data) {
          return normalizeStatusData(data.stat_data);
        }
      } catch { /* 继续尝试后备读取 */ }

      // MVU 可用但暂时没有数据时，改用 getVariables 作为次级来源。
      try {
        const messageId = getMessageId();
        const variables =
          win.getVariables?.({ type: 'message', message_id: messageId }) ??
          win.getVariables?.({ type: 'message' }) ?? {};
        if (variables.stat_data) {
          return normalizeStatusData(variables.stat_data);
        }
      } catch { /* 继续使用默认状态 */ }

      return normalizeStatusData(defaultStatusData);
    },

    save(data: StatusData): void {
      try {
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
  function getMessageId() {
    return typeof win.getCurrentMessageId === 'function' ? win.getCurrentMessageId() : 'latest';
  }

  return {
    source: 'fallback',

    load(): StatusData {
      try {
        const messageId = getMessageId();
        const variables =
          win.getVariables?.({ type: 'message', message_id: messageId }) ??
          win.getVariables?.({ type: 'message' }) ?? {};
        if (variables.stat_data) {
          return normalizeStatusData(variables.stat_data);
        }
      } catch { /* 继续使用默认状态 */ }

      return normalizeStatusData(defaultStatusData);
    },

    save(data: StatusData): void {
      try {
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
