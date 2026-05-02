import { getVisibleMessageText } from '../message-format';
import type { TavernWindow, UiMessage } from '../types';
import {
  buildGlobalCompressionPrompt,
  buildMajorSummaryPrompt,
  buildMinorSummaryPrompt,
  parseSummaryResult,
  shouldRunGlobalCompression,
  shouldRunMajorSummary,
  shouldRunMinorSummary,
} from './engine';
import { saveSummaryStore } from './store';
import type { SummaryApiConfig, SummaryStore } from './types';

export type SummaryContext = {
  win: TavernWindow;
  summaryStore: SummaryStore;
  summaryApiConfig: SummaryApiConfig | null;
  uiMessages: UiMessage[];
  onStoreUpdated: () => void;
};

async function callGenerateRaw(
  win: TavernWindow,
  prompts: Array<{ role: string; content: string }>,
  apiConfig: SummaryApiConfig | null,
): Promise<string> {
  if (typeof win.generateRaw !== 'function') {
    throw new Error('generateRaw not available');
  }

  const config: Record<string, unknown> = {
    should_silence: true,
    should_stream: false,
    generation_id: `summary-${crypto.randomUUID()}`,
    ordered_prompts: prompts,
  };

  if (apiConfig) {
    config.custom_api = {
      apiurl: apiConfig.apiurl,
      key: apiConfig.key,
      model: apiConfig.model,
      source: apiConfig.source,
    };
  }

  const result = await win.generateRaw(config);
  return String(result ?? '');
}

function recordFailure(store: SummaryStore, level: 'minor' | 'major' | 'global', error: unknown): void {
  store.consecutiveFailures += 1;
  store.lastError = {
    level,
    timestamp: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
  };
  if (store.consecutiveFailures >= 3) {
    store.autoPaused = true;
  }
}

function clearFailureState(store: SummaryStore): void {
  store.consecutiveFailures = 0;
  store.autoPaused = false;
  store.lastError = null;
}

function getUnsummarizedMessages(messages: UiMessage[], lastIndex: number): UiMessage[] {
  return messages.slice(lastIndex).filter(m => !m.streaming && (m.role === 'user' || m.role === 'assistant'));
}

function countConversationMessages(messages: UiMessage[]): number {
  return messages.filter(m => !m.streaming && (m.role === 'user' || m.role === 'assistant')).length;
}

function formatMessagesAsText(messages: UiMessage[]): string {
  return messages
    .map(m => {
      const text = m.role === 'assistant' ? getVisibleMessageText(m) || m.text : m.text;
      const speaker = m.speaker || (m.role === 'assistant' ? 'Assistant' : 'User');
      return `[${speaker}]\n${text.trim()}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

// ── 自动摘要：生成结束后触发 ──

export async function runSummary(ctx: SummaryContext, mode: 'auto' | 'minor' | 'major' = 'auto'): Promise<void> {
  const { win, summaryStore: store, summaryApiConfig, uiMessages } = ctx;
  const messageCount = countConversationMessages(uiMessages);

  // 小摘要：自动模式达到阈值时运行，或 mode=minor 时强制运行。
  const runMinor = mode === 'minor' || (mode === 'auto' && shouldRunMinorSummary(store, messageCount));
  if (runMinor) {
    const unsummarized = getUnsummarizedMessages(uiMessages, store.lastSummarizedIndex);
    if (unsummarized.length > 0) {
      try {
        const prompts = buildMinorSummaryPrompt(unsummarized);
        const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
        const text = parseSummaryResult(raw);
        if (text) {
          store.minor.push({
            range: [store.lastSummarizedIndex, messageCount - 1],
            text,
            createdAt: new Date().toISOString(),
          });
          store.lastSummarizedIndex = messageCount;
          clearFailureState(store);
        }
      } catch (error) {
        recordFailure(store, 'minor', error);
        saveSummaryStore(win, store);
        ctx.onStoreUpdated();
        return;
      }
    }
    // 小摘要模式到此为止，不继续级联。
    if (mode === 'minor') {
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
  }

  // 大摘要：自动模式达到阈值时运行，或 mode=major 时强制运行。
  const runMajor = mode === 'major' || (mode === 'auto' && shouldRunMajorSummary(store));
  if (runMajor) {
    if (store.minor.length === 0) {
      // 没有可提升的摘要。
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
    const consumed = store.minor.splice(0, store.minor.length);
    try {
      const prompts = buildMajorSummaryPrompt(consumed);
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
      const text = parseSummaryResult(raw);
      if (text) {
        const firstRange = consumed[0]?.range[0] ?? 0;
        const lastRange = consumed[consumed.length - 1]?.range[1] ?? 0;
        store.major.push({
          range: [firstRange, lastRange],
          text,
          createdAt: new Date().toISOString(),
        });
        clearFailureState(store);
      } else {
        // 解析失败时恢复已消费的小摘要。
        store.minor.unshift(...consumed);
      }
    } catch (error) {
      store.minor.unshift(...consumed);
      recordFailure(store, 'major', error);
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
    // 大摘要模式在大摘要后停止，不做全局压缩。
    if (mode === 'major') {
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
  }

  // 全局压缩：只在自动级联中执行。
  if (shouldRunGlobalCompression(store)) {
    const consumed = store.major.splice(0, store.major.length);
    try {
      const prompts = buildGlobalCompressionPrompt(store.global, consumed);
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
      const text = parseSummaryResult(raw);
      if (text) {
        store.global = text;
        clearFailureState(store);
      } else {
        store.major.unshift(...consumed);
      }
    } catch (error) {
      store.major.unshift(...consumed);
      recordFailure(store, 'global', error);
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
  }

  saveSummaryStore(win, store);
  ctx.onStoreUpdated();
}

// ── 重roll指定摘要条目 ──

export async function rerollSummaryEntry(
  ctx: SummaryContext,
  level: 'minor' | 'major',
  entryIndex: number,
): Promise<void> {
  const { win, summaryStore: store, summaryApiConfig, uiMessages } = ctx;

  if (level === 'minor') {
    const entry = store.minor[entryIndex];
    if (!entry) return;
    const selected = uiMessages
      .slice(entry.range[0], entry.range[1] + 1)
      .filter(m => !m.streaming && (m.role === 'user' || m.role === 'assistant'));
    if (!selected.length) return;

    try {
      const prompts = buildMinorSummaryPrompt(selected);
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
      const text = parseSummaryResult(raw);
      if (text) {
        store.minor[entryIndex] = { ...entry, text, createdAt: new Date().toISOString() };
        clearFailureState(store);
      }
    } catch (error) {
      recordFailure(store, 'minor', error);
    }
  } else {
    const entry = store.major[entryIndex];
    if (!entry) return;
    // 收集范围落在该大摘要内的小摘要来重建 prompt。
    // 如果没有可用小摘要，就直接使用原始消息。
    const messagesInRange = uiMessages
      .slice(entry.range[0], entry.range[1] + 1)
      .filter(m => !m.streaming && (m.role === 'user' || m.role === 'assistant'));
    if (!messagesInRange.length) return;

    try {
      // 将范围内原始消息当作“小摘要式条目”来构建大摘要 prompt。
      const pseudoMinors: import('./types').SummaryEntry[] = [
        { range: entry.range, text: formatMessagesAsText(messagesInRange), createdAt: '' },
      ];
      const prompts = buildMajorSummaryPrompt(pseudoMinors);
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
      const text = parseSummaryResult(raw);
      if (text) {
        store.major[entryIndex] = { ...entry, text, createdAt: new Date().toISOString() };
        clearFailureState(store);
      }
    } catch (error) {
      recordFailure(store, 'major', error);
    }
  }

  saveSummaryStore(win, store);
  ctx.onStoreUpdated();
}

// ── 暂停后恢复自动摘要 ──

export function resumeAutoSummary(store: SummaryStore): void {
  store.autoPaused = false;
  store.consecutiveFailures = 0;
  store.lastError = null;
}
