import type { IslandMemoryDB } from './types';
import { upsertWorldState } from './upsert';

/**
 * 旧存档加载时的一次性数据库清洗。
 *
 * 处理：
 * 1. attributes 表的 targetId='world' 行 → 折叠到 worldState 单例表，原行 expire
 * 2. attributes 表里同 targetId+key 多条活跃行 → 仅保留 createdAt 最新一条，其余 expire
 * 3. 历史上的 'affinity-delta' / 'obsession-delta' 键名 → 累加成 'affinity' / 'obsession' 累计值快照
 *
 * 该函数幂等：对一个已经清洗过的 db 再跑一次没有副作用。
 *
 * 返回本次清洗影响的行数（用于日志）。
 */
export function sweepLegacyMemoryDB(db: IslandMemoryDB): {
  worldRowsMigrated: number;
  duplicatesCollapsed: number;
  deltaRowsFolded: number;
} {
  const now = new Date().toISOString();
  let worldRowsMigrated = 0;
  let duplicatesCollapsed = 0;
  let deltaRowsFolded = 0;

  // ── 1. 把 targetId='world' 的伪 worldState 行迁移到 worldState 表 ──
  const worldRows = db.attributes.filter(a => !a.expired && a.targetId === 'world');
  if (worldRows.length > 0) {
    const patch: Parameters<typeof upsertWorldState>[1] = {};
    for (const row of worldRows) {
      switch (row.key) {
        case 'currentTime':
          patch.currentTime = row.value;
          break;
        case 'currentLocation':
          patch.currentLocation = row.value;
          break;
        case 'currentMainEventId':
          patch.currentMainEventId = row.value;
          break;
        case 'storyStartDate':
          patch.storyStartDate = row.value;
          break;
        case 'currentDay':
          patch.currentDay = Number(row.value) || undefined;
          break;
      }
      row.expired = true;
      row.updatedAt = now;
      worldRowsMigrated += 1;
    }
    if (Object.keys(patch).length > 0) {
      upsertWorldState(db, { ...patch, source: 'migration' });
    }
  }

  // ── 2. 历史 'affinity-delta' / 'obsession-delta' 流水账：按 targetId 累加成累计值，原行 expire ──
  type DeltaKey = 'affinity-delta' | 'obsession-delta';
  type FoldedKey = 'affinity' | 'obsession';
  const deltaToFolded: Record<DeltaKey, FoldedKey> = {
    'affinity-delta': 'affinity',
    'obsession-delta': 'obsession',
  };
  const sums = new Map<string, number>(); // `${targetId}|${foldedKey}` -> sum
  for (const row of db.attributes) {
    if (row.expired) continue;
    const folded = deltaToFolded[row.key as DeltaKey];
    if (!folded) continue;
    const n = Number(row.value);
    if (!Number.isFinite(n)) {
      row.expired = true;
      row.updatedAt = now;
      deltaRowsFolded += 1;
      continue;
    }
    const sumKey = `${row.targetId}|${folded}`;
    sums.set(sumKey, (sums.get(sumKey) ?? 0) + n);
    row.expired = true;
    row.updatedAt = now;
    deltaRowsFolded += 1;
  }
  for (const [sumKey, sum] of sums) {
    const [targetId, foldedKey] = sumKey.split('|');
    if (!targetId || !foldedKey) continue;
    // 先查现有累计值（如果之前已有 'affinity' 快照行），叠加。
    const existing = db.attributes.find(
      a => !a.expired && a.targetId === targetId && a.key === foldedKey,
    );
    const previous = existing ? Number(existing.value) || 0 : 0;
    const next = previous + sum;
    if (existing) {
      existing.expired = true;
      existing.updatedAt = now;
    }
    db.attributes.push({
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      source: 'migration',
      targetId,
      key: foldedKey,
      value: String(next),
      valueType: 'number',
      previousValue: existing?.value,
      delta: sum,
      lastSeenAt: now,
    });
  }

  // ── 3. 同 targetId+key 多条活跃行：保留 createdAt 最新一条 ──
  const groups = new Map<string, typeof db.attributes>();
  for (const row of db.attributes) {
    if (row.expired) continue;
    const key = `${row.targetId}|${row.key}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(row);
  }
  for (const arr of groups.values()) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (let i = 1; i < arr.length; i++) {
      arr[i].expired = true;
      arr[i].updatedAt = now;
      duplicatesCollapsed += 1;
    }
  }

  return { worldRowsMigrated, duplicatesCollapsed, deltaRowsFolded };
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
