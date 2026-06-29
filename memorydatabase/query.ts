import type {
  IslandMemoryDB,
  MemoryAttributeRow,
  MemoryFactCategory,
  MemoryFactRow,
  MemoryImpressionRow,
  MemoryItemRow,
  MemorySecretRow,
  MemoryTaskRow,
  MemoryWorldStateRow,
} from './types';
import { getAttributeFromIndex, getItemFromIndex } from './indexes';

/**
 * 统一查询 API。
 * 所有外部消费方（editor、prompt 注入、UI）都应该走这层，
 * 不要直接访问 db.attributes / db.tasks 等原始数组。
 *
 * 设计原则：
 * - 默认只返回 !expired 的活跃行
 * - 返回的是引用，调用方不要原地改写（要写就走 upsert）
 * - 优先使用索引查询（O(1)），降级到线性扫描（O(n)）
 */

// ── attributes ──

/**
 * 取某个 targetId 当前所有活跃属性的快照。
 * 返回 Map<key, row>，同 key 已经在 upsert 阶段保证只剩一条活跃行。
 */
export function getCurrentAttributes(
  db: IslandMemoryDB,
  targetId: string,
): Map<string, MemoryAttributeRow> {
  const out = new Map<string, MemoryAttributeRow>();
  for (const row of db.attributes) {
    if (row.expired) continue;
    if (row.targetId !== targetId) continue;
    const prev = out.get(row.key);
    // 防御：万一 schema 残留多行，按 createdAt 取最新。
    if (!prev || row.createdAt > prev.createdAt) {
      out.set(row.key, row);
    }
  }
  return out;
}

/** 取所有 targetId 列表（去重）。 */
export function getAttributeTargetIds(db: IslandMemoryDB): string[] {
  const ids = new Set<string>();
  for (const row of db.attributes) {
    if (row.expired) continue;
    ids.add(row.targetId);
  }
  return [...ids];
}

/** 读取单个数值属性，缺省为 0。使用索引加速。 */
export function getNumericAttribute(
  db: IslandMemoryDB,
  targetId: string,
  key: string,
): number {
  const row = getAttributeFromIndex(db, targetId, key);
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : 0;
}

/** 读取单个字符串属性，缺省为 undefined。使用索引加速。 */
export function getStringAttribute(
  db: IslandMemoryDB,
  targetId: string,
  key: string,
): string | undefined {
  const row = getAttributeFromIndex(db, targetId, key);
  return row?.value;
}

// ── tasks ──

/** 取所有未完成任务（pending）。 */
export function getActiveTasks(db: IslandMemoryDB): MemoryTaskRow[] {
  return db.tasks.filter(t => !t.expired && t.status === 'pending');
}

/** 取与某个角色相关的所有未完成任务。 */
export function getTasksForTarget(db: IslandMemoryDB, targetId: string): MemoryTaskRow[] {
  return db.tasks.filter(
    t =>
      !t.expired
      && t.status === 'pending'
      && (t.targetId === targetId || t.ownerId === targetId),
  );
}

// ── impressions ──

/** 取某角色持有的所有活跃印象（按权重绝对值降序，便于 UI 优先展示强印象）。 */
export function getImpressionsForTarget(db: IslandMemoryDB, targetId: string): MemoryImpressionRow[] {
  return db.impressions
    .filter(i => !i.expired && i.targetId === targetId)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

// ── items ──

/** 取 player 当前持有的物品（count > 0）。 */
export function getPlayerInventory(db: IslandMemoryDB): MemoryItemRow[] {
  // 物品查询暂时保持线性扫描（需要过滤 count > 0）
  return db.items.filter(
    i => !i.expired && (i.ownerId ?? 'player') === 'player' && (i.count ?? 0) > 0,
  );
}

/** 按持有者取物品。使用索引优化单个物品查询。 */
export function getInventoryFor(db: IslandMemoryDB, ownerId: string): MemoryItemRow[] {
  // 返回该持有者的所有物品
  return db.items.filter(
    i => !i.expired && (i.ownerId ?? 'player') === ownerId && (i.count ?? 0) > 0,
  );
}

/**
 * 查询单个物品（新增）。使用索引加速。
 */
export function getItemByName(db: IslandMemoryDB, name: string, ownerId: string = 'player'): MemoryItemRow | undefined {
  return getItemFromIndex(db, name, ownerId);
}

// ── facts ──

export function getActiveFacts(
  db: IslandMemoryDB,
  opts?: { category?: MemoryFactCategory; subject?: string },
): MemoryFactRow[] {
  return db.facts.filter(f => {
    if (f.expired) return false;
    if (opts?.category && f.category !== opts.category) return false;
    if (opts?.subject && f.subject !== opts.subject) return false;
    return true;
  });
}

// ── secrets ──

export function getActiveSecrets(db: IslandMemoryDB): MemorySecretRow[] {
  return db.secrets.filter(s => !s.expired);
}

/** 取还没暴露的秘密。 */
export function getUnrevealedSecrets(db: IslandMemoryDB): MemorySecretRow[] {
  return db.secrets.filter(s => !s.expired && !s.revealed);
}

// ── worldState（单例） ──

/** 取当前世界状态。worldState 表只有 0 或 1 条活跃行。 */
export function getWorldState(db: IslandMemoryDB): MemoryWorldStateRow | null {
  return db.worldState.find(w => !w.expired) ?? null;
}
