import { getPromptMessageText, getSummaryMessages } from '../message-format';
import { clearBackgroundTask, setBackgroundTaskFailed, setBackgroundTaskRunning } from '../background-tasks';
import { SecondaryTaskCancelledError, runSecondaryTask, type SecondaryTaskKind } from '../secondary-api';
import type { AppState, TavernWindow, UiMessage } from '../types';
import {
  buildGlobalCompressionPrompt,
  buildMajorSummaryPrompt,
  buildMinorSummaryPrompt,
  MINOR_THRESHOLD,
  parseImpressionsFromSummary,
  parseKeyFactsFromSummary,
  parseSummaryResult,
  shouldRunGlobalCompression,
  shouldRunMajorSummary,
  shouldRunMinorSummary,
} from './engine';
import { saveSummaryStore } from './store';
import type { FactAnchor, KeyFact, SummaryApiConfig, SummaryStore } from './types';
import { commitSummaryToMemoryDB, updateSummaryTextInMemoryDB } from '../memorydatabase/commit-points';
import { commitBatch } from '../memorydatabase/upsert';
import type { IslandMemoryDB } from '../memorydatabase/types';
import { loadSummaryTriggerConfig } from '../memory-config';

/** 摘要运行所需的上下文。 */
export type SummaryContext = {
  win: TavernWindow;
  state?: AppState;
  summaryStore: SummaryStore;
  summaryApiConfig: SummaryApiConfig | null;
  uiMessages: UiMessage[];
  /** Global completed-reader offset of uiMessages when only one archive window is resident. */
  messageStartIndex?: number;
  /** Global completed-reader count; defaults to the resident message count. */
  totalMessageCount?: number;
  /** Reads a bounded global message range when the summary cursor is outside the resident reader window. */
  loadMessageRange?: (
    startMessage: number,
    maxMessages: number,
  ) => Promise<{ startMessage: number; totalMessageCount: number; messages: UiMessage[] }>;
  onStoreUpdated: () => void;
  onTaskUpdated?: () => void;
  /** 当前结构化状态快照，用作摘要 prompt 的事实锚点。缺省时不注入。 */
  getFactAnchor?: () => FactAnchor | null;
  /** memoryDB 引用，摘要成功后写入 summaries/facts 表。 */
  memoryDB?: IslandMemoryDB;
  isCancelled?: () => boolean;
};

export type SummaryRunResult = {
  minorRan: boolean;
  majorRan: boolean;
  globalRan: boolean;
};

function normalizeFactKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function isSingletonKeyFactCategory(category: KeyFact['category']): boolean {
  return category === 'location' || category === 'profile' || category === 'relation';
}

/** 按 category + 主体 + 内容 去重；只让适合单例覆盖的类别按同主体替换旧事实。 */
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
    if (!isSingletonKeyFactCategory(fact.category)) continue;
    const prev = bySubjectCategory.get(subjectKey);
    if (prev && prev.id !== fact.id) {
      // 单例类别同主体但内容不同：旧的标 superseded。
      prev.superseded = true;
    }
    bySubjectCategory.set(subjectKey, fact);
  }
}

function createKeyFacts(
  parsed: Array<Pick<KeyFact, 'category' | 'subject' | 'content' | 'gameTime'>>,
  sourceRange: [number, number],
  anchor?: FactAnchor | null,
): KeyFact[] {
  const now = new Date().toISOString();
  const recordTime = anchor?.time ? `记录时间 ${anchor.time}` : undefined;
  return parsed.map(p => ({
    id: crypto.randomUUID(),
    category: p.category,
    subject: p.subject,
    content: p.content,
    gameTime: p.gameTime || recordTime,
    sourceRange,
    createdAt: now,
  }));
}

/** 通过统一后台入口发送摘要请求：优先副 API，未配置时回落到主接口。 */
async function callGenerateRaw(
  win: TavernWindow,
  prompts: Array<{ role: string; content: string }>,
  apiConfig: SummaryApiConfig | null,
  kind: Extract<SecondaryTaskKind, 'summary-minor' | 'summary-major' | 'summary-global'>,
  isCancelled?: () => boolean,
): Promise<string> {
  return runSecondaryTask({
    win,
    generationId: `summary-${crypto.randomUUID()}`,
    kind,
    prompts,
    apiConfig,
    isCancelled,
  });
}

function parseRequiredSummaryResult(raw: string, kind: SecondaryTaskKind): string {
  const text = parseSummaryResult(raw);
  if (!text) {
    throw new Error(`secondary API returned invalid summary content (${kind})`);
  }
  return text;
}

/** 把摘要里的 [关系] 印象行写入 memoryDB.impressions 表；source 名→target.id 归一后才写，否则丢弃。 */
function commitImpressionsFromSummary(ctx: SummaryContext, raw: string): void {
  const db = ctx.memoryDB;
  const targets = ctx.state?.statusData.targets;
  if (!db || !targets?.length) return;

  const parsed = parseImpressionsFromSummary(raw);
  if (!parsed.length) return;

  const inserts: NonNullable<Parameters<typeof commitBatch>[1]['inserts']>['impressions'] = [];
  for (const imp of parsed) {
    const targetId = resolveImpressionTargetId(imp.source, targets);
    if (!targetId) continue; // 无法归一到已知角色（如 User 自己持有印象）则跳过。
    inserts.push({
      targetId,
      subject: imp.subject,
      label: imp.label,
      polarity: imp.polarity,
      // 权重用极性的绝对存在感表达：有倾向(±1)权重高于纯中性观察。
      weight: imp.polarity === 0 ? 1 : 2,
    });
  }
  if (!inserts.length) return;
  commitBatch(db, { source: 'summary-minor', inserts: { impressions: inserts } });
}

/** 把印象持有者名字归一到 target.id；匹配 id/name/alias/世界书名。 */
function resolveImpressionTargetId(source: string, targets: AppState['statusData']['targets']): string | null {
  const needle = source.trim().toLowerCase();
  if (!needle) return null;
  for (const target of targets) {
    const haystack = [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
      .map(v => String(v ?? '').toLowerCase())
      .filter(Boolean);
    if (haystack.some(h => h === needle || (h.length >= 2 && (h.includes(needle) || needle.includes(h))))) {
      return target.id;
    }
  }
  return null;
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

/** 获取一个固定大小的小摘要块，避免游标落后时一次吞掉全部历史。 */
function getNextMinorSummaryChunk(messages: UiMessage[], localStartIndex: number): UiMessage[] {
  return getSummaryMessages(messages).slice(localStartIndex, localStartIndex + MINOR_THRESHOLD);
}

/** 统计 Reader 可见且已完成的楼层总数（用作 lastSummarizedIndex 的基准）。 */
function countSummaryFloors(messages: UiMessage[]): number {
  return getSummaryMessages(messages).length;
}

function rangeContains(outer: [number, number], inner: [number, number]) {
  return inner[0] >= outer[0] && inner[1] <= outer[1];
}

function getUncoveredMinorSummaries(store: SummaryStore) {
  return store.minor.filter(minor => !store.major.some(major => rangeContains(major.range, minor.range)));
}

function getActiveGlobalRanges(db?: import('../memorydatabase/types').IslandMemoryDB | null): Array<[number, number]> {
  if (!db) return [];
  return db.summaries
    .filter(row => !row.expired && row.level === 'global' && Array.isArray(row.range) && row.range.length >= 2)
    .map(row => row.range);
}

function getUncoveredMajorSummaries(
  store: SummaryStore,
  db?: import('../memorydatabase/types').IslandMemoryDB | null,
) {
  const globalRanges = getActiveGlobalRanges(db);
  return store.major.filter(major => !globalRanges.some(range => rangeContains(range, major.range)));
}

/** 将消息列表格式化为 [说话人]\n内容 的纯文本，用于重roll大摘要。 */
function formatMessagesAsText(messages: UiMessage[]): string {
  return messages
    .map(m => {
      const text = getPromptMessageText(m);
      if (!text.trim()) return '';
      const speaker = m.speaker || (m.role === 'assistant' ? 'Assistant' : 'User');
      return `[${speaker}]\n${text.trim()}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

async function readSummaryRange(
  ctx: SummaryContext,
  range: [number, number],
): Promise<UiMessage[]> {
  const messageStartIndex = Math.max(0, Math.floor(Number(ctx.messageStartIndex) || 0));
  const resident = getSummaryMessages(ctx.uiMessages);
  const localStart = range[0] - messageStartIndex;
  const localEndExclusive = range[1] - messageStartIndex + 1;
  if (localStart >= 0 && localEndExclusive <= resident.length) {
    return resident.slice(localStart, localEndExclusive);
  }
  const expectedCount = Math.max(0, range[1] - range[0] + 1);
  const loaded = await ctx.loadMessageRange?.(range[0], expectedCount);
  if (!loaded || loaded.startMessage !== range[0]) return [];
  const messages = getSummaryMessages(loaded.messages).slice(0, expectedCount);
  return messages.length === expectedCount ? messages : [];
}

// ── 自动摘要：生成结束后触发 ──

export async function runSummary(
  ctx: SummaryContext,
  mode: 'auto' | 'minor' | 'major' | 'global' = 'auto',
): Promise<SummaryRunResult> {
  const { win, summaryStore: store, summaryApiConfig, uiMessages } = ctx;
  const messageStartIndex = Math.max(0, Math.floor(Number(ctx.messageStartIndex) || 0));
  const residentSummaryFloorCount = countSummaryFloors(uiMessages);
  const summaryFloorCount = Math.max(
    messageStartIndex + residentSummaryFloorCount,
    Math.floor(Number(ctx.totalMessageCount) || 0),
  );
  const anchor = ctx.getFactAnchor?.() ?? null;
  const pinnedFacts = () => store.keyFacts.filter(f => !f.superseded);
  let taskStarted = false;
  const result: SummaryRunResult = {
    minorRan: false,
    majorRan: false,
    globalRan: false,
  };

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
  const runMinor = mode === 'minor' || (mode === 'auto' && shouldRunMinorSummary(store, summaryFloorCount));
  if (runMinor) {
    const startIndex = Math.max(0, Math.min(store.lastSummarizedIndex, summaryFloorCount));
    let unsummarized: UiMessage[];
    if (startIndex >= summaryFloorCount) {
      unsummarized = [];
    } else if (
      startIndex < messageStartIndex
      || startIndex >= messageStartIndex + residentSummaryFloorCount
    ) {
      const loaded = await ctx.loadMessageRange?.(startIndex, MINOR_THRESHOLD);
      if (!loaded || loaded.startMessage !== startIndex) {
        throw new Error(`摘要楼层窗口 #${startIndex + 1} 暂时无法读取。`);
      }
      unsummarized = getNextMinorSummaryChunk(loaded.messages, 0);
    } else {
      const localStartIndex = startIndex - messageStartIndex;
      unsummarized = getNextMinorSummaryChunk(uiMessages, localStartIndex);
    }
    if (unsummarized.length > 0) {
      try {
        result.minorRan = true;
        startTask('小摘要生成中');
        const prompts = buildMinorSummaryPrompt(unsummarized, anchor);
        const raw = await callGenerateRaw(win, prompts, summaryApiConfig, 'summary-minor', ctx.isCancelled);
        if (ctx.isCancelled?.()) {
          finishTask();
          return result;
        }
        const text = parseRequiredSummaryResult(raw, 'summary-minor');
        const nextIndex = startIndex + unsummarized.length;
        const range: [number, number] = [startIndex, nextIndex - 1];
        const parsedFacts = parseKeyFactsFromSummary(raw);
        const newFacts = createKeyFacts(parsedFacts, range, anchor);
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
        commitSummaryToMemoryDB(ctx.memoryDB, 'minor', text, range, newFacts);
        commitImpressionsFromSummary(ctx, raw);
      } catch (error) {
        if (error instanceof SecondaryTaskCancelledError || ctx.isCancelled?.()) {
          finishTask();
          return result;
        }
        failTask(error);
        recordFailure(store, 'minor', error);
        saveSummaryStore(win, store);
        ctx.onStoreUpdated();
        return result;
      }
    }
    // 小摘要模式到此为止，不继续级联。
    if (mode === 'minor') {
      finishTask();
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return result;
    }
  }

  // 大摘要：自动模式达到阈值时运行，或 mode=major 时强制运行。
  const runMajor = mode === 'major' || (mode === 'auto' && shouldRunMajorSummary(store));
  if (runMajor) {
    const consumed = getUncoveredMinorSummaries(store).sort((a, b) => a.range[0] - b.range[0]);
    const config = loadSummaryTriggerConfig();
    const majorThreshold = config.majorThreshold ?? 4;
    const sourceMinor = consumed.length
      ? consumed
      : mode === 'major'
        ? [...store.minor].sort((a, b) => a.range[0] - b.range[0])
        : [];
    if (sourceMinor.length === 0 || (mode === 'auto' && sourceMinor.length < majorThreshold)) {
      // 没有可提升的摘要。
      if (mode === 'major') {
        saveSummaryStore(win, store);
        ctx.onStoreUpdated();
        return result;
      }
    } else {
      try {
        result.majorRan = true;
        startTask('大摘要生成中');
        const prompts = buildMajorSummaryPrompt(sourceMinor, anchor, pinnedFacts());
        const raw = await callGenerateRaw(win, prompts, summaryApiConfig, 'summary-major', ctx.isCancelled);
        if (ctx.isCancelled?.()) {
          finishTask();
          return result;
        }
        const text = parseRequiredSummaryResult(raw, 'summary-major');
        const firstRange = sourceMinor[0]?.range[0] ?? 0;
        const lastRange = sourceMinor[sourceMinor.length - 1]?.range[1] ?? 0;
        const majorRange: [number, number] = [firstRange, lastRange];
        const now = new Date().toISOString();
        const existing = store.major.find(entry => entry.range[0] === firstRange && entry.range[1] === lastRange);
        if (existing) {
          existing.text = text;
          existing.createdAt = now;
        } else {
          store.major.push({
            range: majorRange,
            text,
            createdAt: now,
          });
        }
        // 清理被此大摘要覆盖的所有小摘要（修复：确保完全清理）
        store.minor = store.minor.filter(entry => !rangeContains(majorRange, entry.range));
        clearFailureState(store);
        commitSummaryToMemoryDB(ctx.memoryDB, 'major', text, majorRange);
      } catch (error) {
        if (error instanceof SecondaryTaskCancelledError || ctx.isCancelled?.()) {
          finishTask();
          return result;
        }
        failTask(error);
        recordFailure(store, 'major', error);
        saveSummaryStore(win, store);
        ctx.onStoreUpdated();
        return result;
      }
    }
    // 大摘要模式在大摘要后停止，不做全局压缩。
    if (mode === 'major') {
      finishTask();
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return result;
    }
  }

  // 全局压缩：只在自动级联中执行。
  if (mode === 'global' || shouldRunGlobalCompression(store)) {
    const uncoveredMajors = getUncoveredMajorSummaries(store, ctx.memoryDB).sort((a, b) => a.range[0] - b.range[0]);
    const config = loadSummaryTriggerConfig();
    const globalThreshold = config.globalThreshold ?? 4;
    const consumed = uncoveredMajors.slice(0, -1);
    if (consumed.length === 0 || (mode === 'auto' && uncoveredMajors.length < globalThreshold)) {
      finishTask();
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return result;
    }
    try {
      result.globalRan = true;
      startTask('全局记忆压缩中');
      const prompts = buildGlobalCompressionPrompt(store.global, consumed, anchor, pinnedFacts());
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig, 'summary-global', ctx.isCancelled);
      if (ctx.isCancelled?.()) {
        finishTask();
        return result;
      }
      const text = parseRequiredSummaryResult(raw, 'summary-global');
      store.global = text;
      clearFailureState(store);
      const globalRange: [number, number] = [0, consumed[consumed.length - 1]?.range[1] ?? 0];
      store.major = store.major.filter(entry => !rangeContains(globalRange, entry.range));
      commitSummaryToMemoryDB(ctx.memoryDB, 'global', text, globalRange);
    } catch (error) {
      if (error instanceof SecondaryTaskCancelledError || ctx.isCancelled?.()) {
        finishTask();
        return result;
      }
      failTask(error);
      recordFailure(store, 'global', error);
      saveSummaryStore(win, store);
      ctx.onStoreUpdated();
      return result;
    }
  }

  finishTask();
  saveSummaryStore(win, store);
  ctx.onStoreUpdated();
  return result;
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
    const selected = await readSummaryRange(ctx, entry.range);
    if (!selected.length) return;

    try {
      if (ctx.state) setBackgroundTaskRunning(ctx.state, 'summary', '摘要重写中');
      ctx.onTaskUpdated?.();
      const anchor = ctx.getFactAnchor?.() ?? null;
      const prompts = buildMinorSummaryPrompt(selected, anchor);
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig, 'summary-minor');
      const text = parseRequiredSummaryResult(raw, 'summary-minor');
      const parsedFacts = parseKeyFactsFromSummary(raw);
      const newFacts = createKeyFacts(parsedFacts, entry.range, anchor);
      store.minor[entryIndex] = {
        ...entry,
        text,
        createdAt: new Date().toISOString(),
        keyFacts: newFacts.length ? newFacts : entry.keyFacts,
      };
      updateSummaryTextInMemoryDB(ctx.memoryDB, 'minor', text, entry.range);
      if (newFacts.length) {
        store.keyFacts.push(...newFacts);
        dedupeKeyFacts(store);
      }
      clearFailureState(store);
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
    const messagesInRange = await readSummaryRange(ctx, entry.range);
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
      const raw = await callGenerateRaw(win, prompts, summaryApiConfig, 'summary-major');
      const text = parseRequiredSummaryResult(raw, 'summary-major');
      store.major[entryIndex] = { ...entry, text, createdAt: new Date().toISOString() };
      updateSummaryTextInMemoryDB(ctx.memoryDB, 'major', text, entry.range);
      clearFailureState(store);
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



