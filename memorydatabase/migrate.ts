import type { SummaryStore, KeyFact, SummaryEntry } from '../summary/types';
import type { IslandMemoryDB, MemoryFactCategory } from './types';
import { createDefaultMemoryDB } from './defaults';

/**
 * 从 IslandMemoryDB 水合摘要数据回 SummaryStore。
 * 用于修复存档加载后摘要丢失的问题——让旧消费方（buildPrompt / UI）继续工作。
 *
 * 这是 migrateSummaryStoreToMemoryDB 的反向操作。
 */
export function hydrateSummaryStoreFromMemoryDB(
  db: IslandMemoryDB,
): Pick<SummaryStore, 'global' | 'major' | 'minor' | 'keyFacts'> {
  let global: string | null = null;
  let globalCreatedAt = '';
  const keyFacts: KeyFact[] = [];

  // ── 第一遍：按 range[0] 去重，保留 createdAt 最新一条；同时收集 global ──
  // db.summaries 里历史上可能堆积大量同范围的 minor / major（旧 bug：写时不 expire 旧条）。
  // 这里用 Map<range[0], SummaryEntry> 取每个起点最新的一条，避免 UI 重复展示。
  const minorByStart = new Map<number, SummaryEntry & { _ts: string }>();
  const majorByStart = new Map<number, SummaryEntry & { _ts: string }>();
  for (const row of db.summaries) {
    if (row.expired) continue;
    const startKey = Number(row.range?.[0] ?? 0);
    if (row.level === 'minor') {
      const prev = minorByStart.get(startKey);
      if (!prev || row.createdAt > prev._ts) {
        minorByStart.set(startKey, {
          range: row.range,
          text: row.text,
          createdAt: row.createdAt,
          _ts: row.createdAt,
        });
      }
    } else if (row.level === 'major') {
      const prev = majorByStart.get(startKey);
      if (!prev || row.createdAt > prev._ts) {
        majorByStart.set(startKey, {
          range: row.range,
          text: row.text,
          createdAt: row.createdAt,
          _ts: row.createdAt,
        });
      }
    } else if (row.level === 'global') {
      // 只保留最新的全局摘要（按 createdAt 比较）
      if (!global || row.createdAt > globalCreatedAt) {
        global = row.text;
        globalCreatedAt = row.createdAt;
      }
    }
  }

  // ── 第二遍：剔除已被 major 覆盖范围的 minor（避免显示双份） ──
  // 仅按相同 range[0] 去重 major，不做"包含关系"判断——
  // 因为历史 bug 写出过 92-156 这种跨度异常大的怪物 major，如果按"被包含就丢弃"，
  // 它会反过来把 82-101、102-121 这些正常 major 全吞掉，剩一条怪物。
  // 保守做法：只折叠完全相同起点的重复条目。
  const majorList = [...majorByStart.values()].sort((a, b) => a.range[0] - b.range[0]);
  const minorList = [...minorByStart.values()]
    .filter(m => !majorList.some(M => m.range[0] >= M.range[0] && m.range[1] <= M.range[1]))
    .sort((a, b) => a.range[0] - b.range[0]);

  const major: SummaryEntry[] = majorList.map(({ _ts, ...rest }) => {
    void _ts;
    return rest;
  });
  const minor: SummaryEntry[] = minorList.map(({ _ts, ...rest }) => {
    void _ts;
    return rest;
  });

  // ── 兜底：如果没有 global 但有 major，合并 major 作为临时 global ──
  // 这修复了旧存档迁移后 global 丢失的问题
  if (!global && major.length > 0) {
    global = major.map(e => e.text).join('\n\n');
  }

  // ── 从 facts 表恢复关键事实 ──
  for (const row of db.facts) {
    if (row.expired) continue;

    keyFacts.push({
      id: row.id,
      category: reverseMapFactCategory(row.category),
      subject: row.subject,
      content: row.content,
      sourceRange: row.sourceRange ?? [0, 0],
      createdAt: row.createdAt,
      superseded: row.expired ?? false,
    });
  }

  return {
    global,
    major,
    minor,
    keyFacts,
  };
}

/** 新 MemoryFactCategory → 旧 KeyFactCategory 反向映射 */
function reverseMapFactCategory(category: MemoryFactCategory): string {
  // 直接返回，因为两边的值是一致的
  return category;
}

/**
 * 从旧 SummaryStore 迁移到 IslandMemoryDB。
 * 在存档首次加载且没有 memoryDB 字段时调用。
 *
 * 迁移策略：
 * - minor/major/global → summaries 表
 * - keyFacts → facts 表（按 category 映射）
 * - lastSummarizedIndex → lastProcessedIndex 游标
 * - 所有迁移行标记 source='migration'
 */
export function migrateSummaryStoreToMemoryDB(
  summaryStore: SummaryStore,
  runId: string,
): IslandMemoryDB {
  const db = createDefaultMemoryDB(runId);
  const now = new Date().toISOString();

  // ── 迁移摘要 ──

  // 小摘要
  for (const entry of summaryStore.minor) {
    db.summaries.push({
      id: generateMigrationId(),
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      source: 'migration',
      sourceRange: entry.range,
      level: 'minor',
      range: entry.range,
      text: entry.text,
    });

    // 小摘要内嵌的 keyFacts 也一并迁移
    if (entry.keyFacts) {
      for (const fact of entry.keyFacts) {
        migrateSingleKeyFact(db, fact);
      }
    }
  }

  // 大摘要
  for (const entry of summaryStore.major) {
    db.summaries.push({
      id: generateMigrationId(),
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      source: 'migration',
      sourceRange: entry.range,
      level: 'major',
      range: entry.range,
      text: entry.text,
    });
  }

  // 全局摘要
  if (summaryStore.global) {
    db.summaries.push({
      id: generateMigrationId(),
      createdAt: now,
      updatedAt: now,
      source: 'migration',
      level: 'global',
      range: [0, summaryStore.lastSummarizedIndex],
      text: summaryStore.global,
    });
  }

  // ── 迁移关键事实 ──

  for (const fact of summaryStore.keyFacts) {
    migrateSingleKeyFact(db, fact);
  }

  // ── 设置游标 ──

  db.lastProcessedIndex = summaryStore.lastSummarizedIndex;

  // ── 去重：迁移过程中可能从 minor.keyFacts 和顶层 keyFacts 重复导入 ──

  deduplicateMigratedFacts(db);

  return db;
}

/** 迁移单条 KeyFact 到 facts 表 */
function migrateSingleKeyFact(db: IslandMemoryDB, fact: KeyFact): void {
  const category = mapKeyFactCategory(fact.category);

  db.facts.push({
    id: fact.id,
    createdAt: fact.createdAt,
    updatedAt: fact.createdAt,
    source: 'migration',
    sourceRange: fact.sourceRange,
    expired: fact.superseded ?? false,
    category,
    subject: fact.subject,
    content: fact.content,
  });
}

/** 旧 KeyFactCategory → 新 MemoryFactCategory 映射 */
function mapKeyFactCategory(category: string): MemoryFactCategory {
  const map: Record<string, MemoryFactCategory> = {
    promise: 'promise',
    secret: 'secret',
    relation: 'relation',
    item: 'item',
    event: 'event',
    location: 'location',
    profile: 'profile',
  };
  return map[category] ?? 'custom';
}

/** 迁移后去重：同 id 的 fact 只保留一条 */
function deduplicateMigratedFacts(db: IslandMemoryDB): void {
  const seen = new Set<string>();
  db.facts = db.facts.filter(f => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

/** 迁移专用 ID 生成（带 mig- 前缀便于识别） */
function generateMigrationId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `mig-${crypto.randomUUID()}`;
  }
  return `mig-${'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  })}`;
}
