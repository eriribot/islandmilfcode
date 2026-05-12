import { getVisibleMessageText, parseProgressUpdate, type ProgressUpdate } from '../message-format';
import { clearBackgroundTask, setBackgroundTaskFailed, setBackgroundTaskRunning } from '../background-tasks';
import { generateSecondaryRaw } from '../secondary-api';
import type { AppState, TavernWindow, UiMessage } from '../types';
import {
  buildGlobalCompressionPrompt,
  buildMajorSummaryPrompt,
  buildMinorSummaryPrompt,
  MINOR_THRESHOLD,
  parseKeyFactsFromSummary,
  parseSummaryResult,
  shouldRunGlobalCompression,
  shouldRunMajorSummary,
  shouldRunMinorSummary,
} from './engine';
import { saveSummaryStore } from './store';
import type { FactAnchor, KeyFact, SummaryApiConfig, SummaryStore } from './types';

/** 摘要运行所需的上下文。 */
export type SummaryContext = {
  win: TavernWindow;
  state?: AppState;
  summaryStore: SummaryStore;
  summaryApiConfig: SummaryApiConfig | null;
  uiMessages: UiMessage[];
  onStoreUpdated: () => void;
  onTaskUpdated?: () => void;
  onProgressUpdate?: (update: ProgressUpdate) => void;
  /** 当前结构化状态快照，用作摘要 prompt 的事实锚点。缺省时不注入。 */
  getFactAnchor?: () => FactAnchor | null;
};

function normalizeFactKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

/** 按 category + 主体 + 内容 去重；同主体新事实会让旧事实 superseded=true。 */
function dedupeKeyFacts(store: SummaryStore): void {
  const active = store.keyFacts.filter(f => !f.superseded);
  const byIdentity = new Map<string, KeyFact>();
  const bySubjectCategory = new Map<string, KeyFact>();
  for (const fact of active) {
    const identityKey = `${fact.category}|${normalizeFactKey(fact.subject)}|${normalizeFactKey(fact.content)}`;
    const subjectKey = `${fact.category}|${normalizeFactKey(fact.subject)}`;
    const existing = byIdentity.get(identityKey);
    if (existing) {
      // 完全重复：保留更早的，新的标 superseded。
      fact.superseded = true;
      continue;
    }
    byIdentity.set(identityKey, fact);
    const prev = bySubjectCategory.get(subjectKey);
    if (prev && prev.id !== fact.id) {
      // 同主体同类别但内容不同：旧的标 superseded。
      prev.superseded = true;
    }
    bySubjectCategory.set(subjectKey, fact);
  }
}

function createKeyFacts(
  parsed: Array<Pick<KeyFact, 'category' | 'subject' | 'content'>>,
  sourceRange: [number, number],
): KeyFact[] {
  const now = new Date().toISOString();
  return parsed.map(p => ({
    id: crypto.randomUUID(),
    category: p.category,
    subject: p.subject,
    content: p.content,
    sourceRange,
    createdAt: now,
  }));
}

/** 通过统一后台入口发送摘要请求：优先副 API，未配置时回落到主接口。 */
async function callGenerateRaw(
  win: TavernWindow,
  prompts: Array<{ role: string; content: string }>,
  apiConfig: SummaryApiConfig | null,
): Promise<string> {
  return generateSecondaryRaw({
    win,
    generationId: `summary-${crypto.randomUUID()}`,
    prompts,
    apiConfig,
  });
}

function applyProgressFromMinorSummary(ctx: SummaryContext, raw: string): boolean {
  const update = parseProgressUpdate(raw);
  if (!update) return false;
  ctx.onProgressUpdate?.(update);
  return true;
}

/** 记录摘要失败；连续失败 3 次后自动暂停。 */
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

/** 成功后清除失败计数和暂停状态。 */
function clearFailureState(store: SummaryStore): void {
  store.consecutiveFailures = 0;
  store.autoPaused = false;
  store.lastError = null;
}

/** 获取可参与摘要的会话消息；摘要 range 和游标都以这个数组的序号为准。 */
function getConversationMessages(messages: UiMessage[]): UiMessage[] {
  return messages.filter(m => !m.streaming && (m.role === 'user' || m.role === 'assistant'));
}

/** 获取一个固定大小的小摘要块，避免游标落后时一次吞掉全部历史。 */
function getNextMinorSummaryChunk(messages: UiMessage[], lastIndex: number): UiMessage[] {
  return getConversationMessages(messages).slice(lastIndex, lastIndex + MINOR_THRESHOLD);
}

/** 统计非流式的用户/助手消息总数（用作 lastSummarizedIndex 的基准）。 */
function countConversationMessages(messages: UiMessage[]): number {
  return getConversationMessages(messages).length;
}

/** 将消息列表格式化为 [说话人]\n内容 的纯文本，用于重roll大摘要。 */
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
  const anchor = ctx.getFactAnchor?.() ?? null;
  const pinnedFacts = () => store.keyFacts.filter(f => !f.superseded);
  let taskStarted = false;

  const startTask = (detail: string) => {
    if (!ctx.state) return;
    taskStarted = true;
    setBackgroundTaskRunning(ctx.state, 'summary', detail);
    ctx.onTaskUpdated?.();
  };
  const failTask = (error: unknown) => {
    if (!ctx.state || !taskStarted) return;
    setBackgroundTaskFailed(ctx.state, 'summary', error);
    ctx.onTaskUpdated?.();
  };
  const finishTask = () => {
    if (!ctx.state || !taskStarted) return;
    clearBackgroundTask(ctx.state, 'summary');
    ctx.onTaskUpdated?.();
  };

  // 小摘要：自动模式达到阈值时运行，或 mode=minor 时强制运行。
  const runMinor = mode === 'minor' || (mode === 'auto' && shouldRunMinorSummary(store, messageCount));
  if (runMinor) {
    const startIndex = Math.max(0, Math.min(store.lastSummarizedIndex, messageCount));
    const unsummarized = getNextMinorSummaryChunk(uiMessages, startIndex);
    if (unsummarized.length > 0) {
      try {
        startTask('小摘要生成中');
        const prompts = buildMinorSummaryPrompt(unsummarized, anchor);
        const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
        const text = parseSummaryResult(raw);
        if (text) {
          const nextIndex = startIndex + unsummarized.length;
          const range: [number, number] = [startIndex, nextIndex - 1];
          const parsedFacts = parseKeyFactsFromSummary(raw);
          const newFacts = createKeyFacts(parsedFacts, range);
          store.minor.push({
            range,
            text,
            createdAt: new Date().toISOString(),
            keyFacts: newFacts.length ? newFacts : undefined,
          });
          if (newFacts.length) {
            store.keyFacts.push(...newFacts);
            dedupeKeyFacts(store);
          }
          store.lastSummarizedIndex = nextIndex;
          clearFailureState(store);
          applyProgressFromMinorSummary(ctx, raw);
        }
      } catch (error) {
        failTask(error);
        recordFailure(store, 'minor', error);
        saveSummaryStore(win, store);
        ctx.onStoreUpdated();
        return;
      }
    }
    // 小摘要模式到此为止，不继续级联。
    if (mode === 'minor') {
      finishTask();
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
      startTask('大摘要生成中');
      const prompts = buildMajorSummaryPrompt(consumed, anchor, pinnedFacts());
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
      failTask(error);
      store.minor.unshift(...consumed);
      recordFailure(store, 'major', error);
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
    // 大摘要模式在大摘要后停止，不做全局压缩。
    if (mode === 'major') {
      finishTask();
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
  }

  // 全局压缩：只在自动级联中执行。
  if (shouldRunGlobalCompression(store)) {
    const consumed = store.major.splice(0, store.major.length);
    try {
      startTask('全局记忆压缩中');
      const prompts = buildGlobalCompressionPrompt(store.global, consumed, anchor, pinnedFacts());
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
      const text = parseSummaryResult(raw);
      if (text) {
        store.global = text;
        clearFailureState(store);
      } else {
        store.major.unshift(...consumed);
      }
    } catch (error) {
      failTask(error);
      store.major.unshift(...consumed);
      recordFailure(store, 'global', error);
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return;
    }
  }

  finishTask();
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
    const selected = getConversationMessages(uiMessages).slice(entry.range[0], entry.range[1] + 1);
    if (!selected.length) return;

    try {
      if (ctx.state) setBackgroundTaskRunning(ctx.state, 'summary', '摘要重写中');
      ctx.onTaskUpdated?.();
      const anchor = ctx.getFactAnchor?.() ?? null;
      const prompts = buildMinorSummaryPrompt(selected, anchor);
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
      const text = parseSummaryResult(raw);
      if (text) {
        const parsedFacts = parseKeyFactsFromSummary(raw);
        const newFacts = createKeyFacts(parsedFacts, entry.range);
        store.minor[entryIndex] = {
          ...entry,
          text,
          createdAt: new Date().toISOString(),
          keyFacts: newFacts.length ? newFacts : entry.keyFacts,
        };
        if (newFacts.length) {
          store.keyFacts.push(...newFacts);
          dedupeKeyFacts(store);
        }
        clearFailureState(store);
      }
    } catch (error) {
      if (ctx.state) {
        setBackgroundTaskFailed(ctx.state, 'summary', error);
        ctx.onTaskUpdated?.();
      }
      recordFailure(store, 'minor', error);
    }
  } else {
    const entry = store.major[entryIndex];
    if (!entry) return;
    // 收集范围落在该大摘要内的小摘要来重建 prompt。
    // 如果没有可用小摘要，就直接使用原始消息。
    const messagesInRange = getConversationMessages(uiMessages).slice(entry.range[0], entry.range[1] + 1);
    if (!messagesInRange.length) return;

    try {
      if (ctx.state) setBackgroundTaskRunning(ctx.state, 'summary', '摘要重写中');
      ctx.onTaskUpdated?.();
      const anchor = ctx.getFactAnchor?.() ?? null;
      const pinned = store.keyFacts.filter(f => !f.superseded);
      // 将范围内原始消息当作"小摘要式条目"来构建大摘要 prompt。
      const pseudoMinors: import('./types').SummaryEntry[] = [
        { range: entry.range, text: formatMessagesAsText(messagesInRange), createdAt: '' },
      ];
      const prompts = buildMajorSummaryPrompt(pseudoMinors, anchor, pinned);
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig);
      const text = parseSummaryResult(raw);
      if (text) {
        store.major[entryIndex] = { ...entry, text, createdAt: new Date().toISOString() };
        clearFailureState(store);
      }
    } catch (error) {
      if (ctx.state) {
        setBackgroundTaskFailed(ctx.state, 'summary', error);
        ctx.onTaskUpdated?.();
      }
      recordFailure(store, 'major', error);
    }
  }

  if (!store.lastError && ctx.state) {
    clearBackgroundTask(ctx.state, 'summary');
    ctx.onTaskUpdated?.();
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
