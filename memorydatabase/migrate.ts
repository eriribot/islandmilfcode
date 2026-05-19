import type { SummaryStore, KeyFact } from '../summary/types';
import type { IslandMemoryDB, MemoryFactCategory } from './types';
import { createDefaultMemoryDB } from './defaults';

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
