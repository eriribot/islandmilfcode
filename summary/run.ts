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

// ── Auto summary (triggered after generation) ──

export async function runSummary(ctx: SummaryContext, mode: 'auto' | 'minor' | 'major' = 'auto'): Promise<void> {
  const { win, summaryStore: store, summaryApiConfig, uiMessages } = ctx;
  const messageCount = countConversationMessages(uiMessages);

  // Minor summary: run if auto+threshold met, or if mode=minor (forced)
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
    // Mode 'minor': stop here, no cascade
    if (mode === 'minor') {
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
  }

  // Major summary: run if auto+threshold met, or if mode=major (forced)
  const runMajor = mode === 'major' || (mode === 'auto' && shouldRunMajorSummary(store));
  if (runMajor) {
    if (store.minor.length === 0) {
      // Nothing to promote
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
        // Restore consumed minors if parsing failed
        store.minor.unshift(...consumed);
      }
    } catch (error) {
      store.minor.unshift(...consumed);
      recordFailure(store, 'major', error);
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
    // Mode 'major': stop after major, no global compression
    if (mode === 'major') {
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
  }

  // Global compression (auto cascade only)
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

// ── Reroll a specific summary entry ──

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
    // Collect all minor entries whose range falls within this major's range to rebuild prompt
    // If no minors available, use messages directly
    const messagesInRange = uiMessages
      .slice(entry.range[0], entry.range[1] + 1)
      .filter(m => !m.streaming && (m.role === 'user' || m.role === 'assistant'));
    if (!messagesInRange.length) return;

    try {
      // Build major prompt from the raw messages in range (treated as minor-like entries)
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

// ── Resume auto summary after pause ──

export function resumeAutoSummary(store: SummaryStore): void {
  store.autoPaused = false;
  store.consecutiveFailures = 0;
  store.lastError = null;
}
