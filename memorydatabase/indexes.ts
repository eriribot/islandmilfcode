import type {
  IslandMemoryDB,
  MemoryAttributeRow,
  MemoryBaseRow,
  MemoryFactRow,
  MemoryImpressionRow,
  MemoryIndexes,
  MemoryItemRow,
} from './types';
import {
  getPhoneArchiveImpressionSemanticKey,
  normalizePhoneArchiveImpressionSubject,
} from '../phone/types';

/**
 * 索引管理模块：将 O(n) 查询降低到 O(1)
 *
 * 核心思路：
 * - 表数据（attributes/facts等）是 source of truth，永远保持不变
 * - 索引是派生数据，可以随时丢弃和重建
 * - 序列化时不保存索引，加载后重建
 * - 每次 commitBatch 后增量更新索引
 */

/**
 * 重建所有索引（从存档加载后调用）
 * 时间复杂度：O(n)，但只在加载时执行一次
 */
export function rebuildIndexes(db: IslandMemoryDB, options: { log?: boolean } = {}): void {
  const startTime = performance.now();

  db._indexes = {
    attributesByTargetKey: new Map(),
    factsByCategorySubject: new Map(),
    impressionsByIdentity: new Map(),
    itemsByNameOwner: new Map(),
    phoneMessageIds: new Set(),
    rowIdsByTarget: new Map(),
    stats: {
      activeRows: 0,
      expiredRows: 0,
      lastGCTime: new Date().toISOString(),
    },
  };

  let activeCount = 0;
  let expiredCount = 0;

  // ── 索引 attributes 表 ──
  for (const row of db.attributes) {
    if (row.expired) {
      expiredCount++;
      continue;
    }
    activeCount++;

    const key = makeAttributeIndexKey(row.targetId, row.key);
    const existing = db._indexes.attributesByTargetKey.get(key);

    // 保留 createdAt 最新的活跃行（防御多条活跃行的脏数据）
    if (!existing || row.createdAt > existing.createdAt) {
      db._indexes.attributesByTargetKey.set(key, row);
    }

    addToTargetIndex(db._indexes, row.targetId, row.id);
  }

  // ── 索引 facts 表 ──
  for (const row of db.facts) {
    if (row.expired) {
      expiredCount++;
      continue;
    }
    activeCount++;

    const key = makeFactIndexKey(row.category, row.subject);
    let list = db._indexes.factsByCategorySubject.get(key);
    if (!list) {
      list = [];
      db._indexes.factsByCategorySubject.set(key, list);
    }
    list.push(row);

    // facts 也可能有 relatedEntityIds，索引它们
    if (row.relatedEntityIds) {
      for (const targetId of row.relatedEntityIds) {
        addToTargetIndex(db._indexes, targetId, row.id);
      }
    }
  }

  // ── 索引 impressions 表 ──
  for (const row of db.impressions) {
    if (row.expired) {
      expiredCount++;
      continue;
    }
    activeCount++;

    const key = makeImpressionIndexKey(row.targetId, row.subject, row.label);
    let list = db._indexes.impressionsByIdentity.get(key);
    if (!list) {
      list = [];
      db._indexes.impressionsByIdentity.set(key, list);
    }
    list.push(row);

    addToTargetIndex(db._indexes, row.targetId, row.id);
  }

  // ── 索引 items 表 ──
  for (const row of db.items) {
    if (row.expired) {
      expiredCount++;
      continue;
    }
    activeCount++;

    const key = makeItemIndexKey(row.name, row.ownerId ?? 'player');
    const existing = db._indexes.itemsByNameOwner.get(key);

    // 保留 createdAt 最新的活跃行
    if (!existing || row.createdAt > existing.createdAt) {
      db._indexes.itemsByNameOwner.set(key, row);
    }

    addToTargetIndex(db._indexes, row.ownerId ?? 'player', row.id);
  }

  // ── 索引 phoneMessages 表 ──
  for (const row of db.phoneMessages) {
    if (row.expired) {
      expiredCount++;
      continue;
    }
    activeCount++;

    db._indexes.phoneMessageIds.add(row.messageId);
    addToTargetIndex(db._indexes, row.targetId, row.id);
  }

  // ── 索引其他表（只计数，不建特殊索引） ──
  const otherTables: Array<keyof IslandMemoryDB> = [
    'entities',
    'events',
    'relations',
    'tasks',
    'secrets',
    'summaries',
    'worldState',
  ];

  for (const tableName of otherTables) {
    const table = db[tableName] as MemoryBaseRow[];
    if (!Array.isArray(table)) continue;

    for (const row of table) {
      if (row.expired) {
        expiredCount++;
      } else {
        activeCount++;

        // 索引有 targetId 字段的行
        if ('targetId' in row && typeof row.targetId === 'string') {
          addToTargetIndex(db._indexes, row.targetId, row.id);
        }
      }
    }
  }

  db._indexes.stats.activeRows = activeCount;
  db._indexes.stats.expiredRows = expiredCount;

  const elapsed = performance.now() - startTime;
  const totalCount = activeCount + expiredCount;
  const expiredRatioText = totalCount > 0 ? `${((expiredCount / totalCount) * 100).toFixed(1)}%` : '0.0%';
  if (options.log !== false) {
    console.log(
      `[memorydb:indexes] rebuilt in ${elapsed.toFixed(1)}ms | active=${activeCount} expired=${expiredCount} ratio=${expiredRatioText}`,
    );
  }
}

/**
 * 增量更新索引（commitBatch 后调用）
 * 只处理本次新增/修改/删除的行
 */
export function updateIndexesIncremental(
  db: IslandMemoryDB,
  changes: {
    inserted?: { tableName: string; rows: MemoryBaseRow[] }[];
    expired?: { tableName: string; ids: string[] }[];
  },
): void {
  if (!db._indexes) {
    rebuildIndexes(db);
    return;
  }

  // ── 处理新插入的行 ──
  if (changes.inserted) {
    for (const { tableName, rows } of changes.inserted) {
      for (const row of rows) {
        db._indexes.stats.activeRows++;
        indexSingleRow(db._indexes, tableName, row);
      }
    }
  }

  // ── 处理 expired 的行 ──
  if (changes.expired) {
    for (const { tableName, ids } of changes.expired) {
      for (const id of ids) {
        db._indexes.stats.activeRows--;
        db._indexes.stats.expiredRows++;
        removeFromIndexes(db._indexes, tableName, id);
      }
    }
  }
}

/**
 * 索引单行（增量插入时使用）
 */
function indexSingleRow(indexes: MemoryIndexes, tableName: string, row: MemoryBaseRow): void {
  switch (tableName) {
    case 'attributes': {
      const attrRow = row as MemoryAttributeRow;
      const key = makeAttributeIndexKey(attrRow.targetId, attrRow.key);
      indexes.attributesByTargetKey.set(key, attrRow);
      addToTargetIndex(indexes, attrRow.targetId, row.id);
      break;
    }

    case 'facts': {
      const factRow = row as MemoryFactRow;
      const key = makeFactIndexKey(factRow.category, factRow.subject);
      let list = indexes.factsByCategorySubject.get(key);
      if (!list) {
        list = [];
        indexes.factsByCategorySubject.set(key, list);
      }
      list.push(factRow);
      if (factRow.relatedEntityIds) {
        for (const targetId of factRow.relatedEntityIds) {
          addToTargetIndex(indexes, targetId, row.id);
        }
      }
      break;
    }

    case 'impressions': {
      const impRow = row as MemoryImpressionRow;
      const key = makeImpressionIndexKey(impRow.targetId, impRow.subject, impRow.label);
      let list = indexes.impressionsByIdentity.get(key);
      if (!list) {
        list = [];
        indexes.impressionsByIdentity.set(key, list);
      }
      list.push(impRow);
      addToTargetIndex(indexes, impRow.targetId, row.id);
      break;
    }

    case 'items': {
      const itemRow = row as MemoryItemRow;
      const key = makeItemIndexKey(itemRow.name, itemRow.ownerId ?? 'player');
      indexes.itemsByNameOwner.set(key, itemRow);
      addToTargetIndex(indexes, itemRow.ownerId ?? 'player', row.id);
      break;
    }

    case 'phoneMessages': {
      const msgRow = row as { messageId: string; targetId: string };
      indexes.phoneMessageIds.add(msgRow.messageId);
      addToTargetIndex(indexes, msgRow.targetId, row.id);
      break;
    }

    default:
      // 其他表：只索引 targetId
      if ('targetId' in row && typeof row.targetId === 'string') {
        addToTargetIndex(indexes, row.targetId, row.id);
      }
  }
}

/**
 * 从索引中移除行（expire 时使用）
 * 注意：这里不从 Map 删除键，只是后续查询时过滤 expired
 * 真正清理在 GC 时重建索引
 */
function removeFromIndexes(indexes: MemoryIndexes, tableName: string, id: string): void {
  // 移除 targetId 索引（遍历所有 targetId，找到包含此 id 的集合）
  for (const set of indexes.rowIdsByTarget.values()) {
    set.delete(id);
  }

  // 其他索引：expire 后查询时自然会过滤掉，无需立即删除
  // 真正清理由 GC 时的 rebuildIndexes 完成
}

// ── 辅助函数 ──

function makeAttributeIndexKey(targetId: string, key: string): string {
  return `${targetId}|${key}`;
}

function makeFactIndexKey(category: string, subject: string): string {
  return `${category}|${subject}`;
}

function makeImpressionIndexKey(targetId: string, subject: string, label: string): string {
  const normalizedSubject = normalizePhoneArchiveImpressionSubject(subject);
  const semanticKey = getPhoneArchiveImpressionSemanticKey(label);
  return `${targetId}|${normalizedSubject}|${semanticKey}`;
}

function makeItemIndexKey(name: string, ownerId: string): string {
  return `${name}|${ownerId}`;
}

function addToTargetIndex(indexes: MemoryIndexes, targetId: string, rowId: string): void {
  let set = indexes.rowIdsByTarget.get(targetId);
  if (!set) {
    set = new Set();
    indexes.rowIdsByTarget.set(targetId, set);
  }
  set.add(rowId);
}

// ── 公开查询接口（使用索引） ──

/**
 * 通过索引快速查询 attribute（O(1) vs O(n)）
 */
export function getAttributeFromIndex(
  db: IslandMemoryDB,
  targetId: string,
  key: string,
): MemoryAttributeRow | undefined {
  if (!db._indexes) {
    rebuildIndexes(db);
  }

  const indexKey = makeAttributeIndexKey(targetId, key);
  const row = db._indexes!.attributesByTargetKey.get(indexKey);

  // 防御：二次确认未 expired（索引可能有延迟）
  if (row && !row.expired) {
    return row;
  }
  return undefined;
}

/**
 * 通过索引查询 facts（O(1) vs O(n)）
 */
export function getFactsFromIndex(
  db: IslandMemoryDB,
  category: string,
  subject: string,
): MemoryFactRow[] {
  if (!db._indexes) {
    rebuildIndexes(db);
  }

  const key = makeFactIndexKey(category, subject);
  const list = db._indexes!.factsByCategorySubject.get(key) ?? [];

  // 过滤 expired（防御）
  return list.filter(f => !f.expired);
}

/**
 * 通过索引查询 impressions（O(1) vs O(n)）
 */
export function getImpressionsFromIndex(
  db: IslandMemoryDB,
  targetId: string,
  subject: string,
  label: string,
): MemoryImpressionRow[] {
  if (!db._indexes) {
    rebuildIndexes(db);
  }

  const key = makeImpressionIndexKey(targetId, subject, label);
  const list = db._indexes!.impressionsByIdentity.get(key) ?? [];

  return list.filter(i => !i.expired);
}

/**
 * 通过索引查询 item（O(1) vs O(n)）
 */
export function getItemFromIndex(
  db: IslandMemoryDB,
  name: string,
  ownerId: string = 'player',
): MemoryItemRow | undefined {
  if (!db._indexes) {
    rebuildIndexes(db);
  }

  const key = makeItemIndexKey(name, ownerId);
  const row = db._indexes!.itemsByNameOwner.get(key);

  if (row && !row.expired) {
    return row;
  }
  return undefined;
}

/**
 * 通过索引检查 phoneMessage 是否已索引（O(1) vs O(n)）
 */
export function isPhoneMessageIndexed(db: IslandMemoryDB, messageId: string): boolean {
  if (!db._indexes) {
    rebuildIndexes(db);
  }

  return db._indexes!.phoneMessageIds.has(messageId);
}

/**
 * 获取索引统计信息
 */
export function getIndexStats(db: IslandMemoryDB): MemoryIndexes['stats'] | null {
  return db._indexes?.stats ?? null;
}

/**
 * 判断是否需要 GC（expired 行占比超过阈值）
 */
export function shouldGarbageCollect(db: IslandMemoryDB, threshold: number = 0.3): boolean {
  if (!db._indexes) return false;

  const { activeRows, expiredRows } = db._indexes.stats;
  const total = activeRows + expiredRows;
  if (total === 0) return false;

  return expiredRows / total > threshold;
}
