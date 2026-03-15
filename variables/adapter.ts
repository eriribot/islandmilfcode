import type { StatusData, TavernWindow } from '../types';
import { normalizeStatusData, defaultStatusData, serializeStatusData } from './normalize';

export interface VariableAdapter {
  readonly source: 'mvu' | 'fallback';
  load(): StatusData;
  save(data: StatusData): void;
  onUpdate(callback: (data: StatusData) => void): () => void;
}

// ── MVU adapter: event-driven via VARIABLE_UPDATE_ENDED ──

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
      } catch { /* fallthrough */ }

      // MVU available but no data yet — try getVariables as secondary
      try {
        const messageId = getMessageId();
        const variables =
          win.getVariables?.({ type: 'message', message_id: messageId }) ??
          win.getVariables?.({ type: 'message' }) ?? {};
        if (variables.stat_data) {
          return normalizeStatusData(variables.stat_data);
        }
      } catch { /* fallthrough */ }

      return normalizeStatusData(defaultStatusData);
    },

    save(data: StatusData): void {
      try {
        const messageId = getMessageId();
        const serialized = serializeStatusData(data);

        // Try MVU replaceMvuData first
        if (typeof Mvu.replaceMvuData === 'function') {
          const currentData = Mvu.getMvuData?.({ type: 'message', message_id: messageId }) ?? {};
          Mvu.replaceMvuData({ ...currentData, stat_data: serialized }, { type: 'message', message_id: messageId });
          return;
        }

        // Fallback to updateVariablesWith
        win.updateVariablesWith?.(variables => {
          variables.stat_data = serialized;
        }, { type: 'message', message_id: messageId });
      } catch { /* ignore outside Tavern */ }
    },

    onUpdate(callback: (data: StatusData) => void): () => void {
      // Listen to MVU's VARIABLE_UPDATE_ENDED event
      if (Mvu.events?.VARIABLE_UPDATE_ENDED && typeof win.eventOn === 'function') {
        const { stop } = win.eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {
          callback(this.load());
        });
        return stop;
      }

      // MVU exists but no event support — fall back to polling
      const timer = window.setInterval(() => {
        callback(this.load());
      }, 1500);
      return () => window.clearInterval(timer);
    },
  };
}

// ── Fallback adapter: polling via setInterval ──

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
      } catch { /* fallthrough */ }

      return normalizeStatusData(defaultStatusData);
    },

    save(data: StatusData): void {
      try {
        const messageId = getMessageId();
        win.updateVariablesWith?.(variables => {
          variables.stat_data = serializeStatusData(data);
        }, { type: 'message', message_id: messageId });
      } catch { /* ignore outside Tavern */ }
    },

    onUpdate(callback: (data: StatusData) => void): () => void {
      const timer = window.setInterval(() => {
        callback(this.load());
      }, 1500);
      return () => window.clearInterval(timer);
    },
  };
}

// ── Factory: async init, tries MVU first ──

/**
 * Creates the appropriate variable adapter.
 * Attempts to wait for MVU initialization; falls back to direct getVariables.
 */
export async function createVariableAdapter(win: TavernWindow): Promise<VariableAdapter> {
  try {
    // waitGlobalInitialized is provided by the tavern helper runtime
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
  } catch { /* MVU not available, use fallback */ }

  return createFallbackAdapter(win);
}
