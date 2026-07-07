import type { ProgressUpdate } from '../message-format';
import { commitPlotFlagDeltas } from '../plot-state-machine';
import type { KeyFact } from '../summary/types';
import {
  commitBatch,
  upsertAttribute,
  upsertEvent,
  upsertItem,
  upsertWorldState,
} from './upsert';
import type { IslandMemoryDB, MemoryFactCategory, MemorySummaryLevel, MemoryWriteBatch } from './types';
import { getWorldState } from './query';

/**
 * 把一次主回复的 ProgressUpdate 写入 memoryDB。
 *
 * 写入语义（不再是流水账）：
 * - 数值属性（好感度/旧情度/五维）：写累计值快照到 attributes 表，旧行 expire；delta 字段保留变化量
 * - 着装：按 targetId+key='outfit-{部位}' 写快照
 * - 主线事件 / 事件名：按 relatedMainEventId 或 title 去重，不重复堆积
 * - 物品获得/丢失：按 name+ownerId 合并 count
 * - currentTime / currentLocation / currentMainEventId：写到单例 worldState 表
 */
export function commitProgressToMemoryDB(
  db: IslandMemoryDB | null | undefined,
  update: ProgressUpdate,
  sourceRange?: [number, number],
): void {
  if (!db) return;

  // ── 1. 世界状态：时间 / 地点 / 当前主线事件 → worldState 单例表 ──
  const previousWorldState = getWorldState(db);
  const commitGameTime = update.time || previousWorldState?.currentTime;
  const commitLocation = update.location || previousWorldState?.currentLocation;
  const worldPatch: Parameters<typeof upsertWorldState>[1] = { sourceRange };
  let worldHasPatch = false;
  if (update.time) {
    worldPatch.currentTime = update.time;
    worldHasPatch = true;
  }
  if (update.location) {
    worldPatch.currentLocation = update.location;
    worldHasPatch = true;
  }
  if (update.currentMainEventId) {
    worldPatch.currentMainEventId = update.currentMainEventId;
    worldHasPatch = true;
  }
  if (worldHasPatch) {
    upsertWorldState(db, worldPatch);
  }

  // ── 1.5 剧情状态机：第七卷路线开关，按当前剧情日期守门后写入 attributes ──
  commitPlotFlagDeltas(update.plotFlags, {
    db,
    currentTime: commitGameTime,
    sourceRange,
  });

  // ── 2. 角色属性：好感度 / 旧情度（累计值，不再用 -delta 键名） ──
  for (const item of update.affinityDeltas) {
    if (!item.delta) continue;
    const previous = readNumericAttribute(db, item.target, 'affinity');
    const next = previous + item.delta;
    upsertAttribute(db, {
      targetId: item.target,
      key: 'affinity',
      value: String(next),
      valueType: 'number',
      sourceRange,
    });
  }

  for (const item of update.obsessionDeltas) {
    if (!item.delta) continue;
    const previous = readNumericAttribute(db, item.target, 'obsession');
    const next = previous + item.delta;
    upsertAttribute(db, {
      targetId: item.target,
      key: 'obsession',
      value: String(next),
      valueType: 'number',
      sourceRange,
    });
  }

  // ── 2.5 贞操闩锁 / 身体开发计数器：随属性快照留痕（闩锁权威在 actions 层） ──
  for (const flag of update.virginityFlags) {
    upsertAttribute(db, {
      targetId: flag.target,
      key: 'virginity',
      value: 'lost',
      valueType: 'string',
      sourceRange,
    });
  }

  for (const item of update.intimacyCounters) {
    if (item.delta <= 0) continue;
    const key = `counter-${item.field}`;
    const previous = readNumericAttribute(db, item.target, key);
    const next = previous + item.delta;
    upsertAttribute(db, {
      targetId: item.target,
      key,
      value: String(next),
      valueType: 'number',
      sourceRange,
    });
  }

  // ── 3. 玩家五维：累计值快照 ──
  for (const [statKey, delta] of Object.entries(update.statDeltas)) {
    const numericDelta = Number(delta);
    if (!numericDelta) continue;
    const key = `stat-${statKey}`;
    const previous = readNumericAttribute(db, 'player', key);
    const next = previous + numericDelta;
    upsertAttribute(db, {
      targetId: 'player',
      key,
      value: String(next),
      valueType: 'number',
      sourceRange,
    });
  }

  // ── 4. 着装：每个 targetId 一个 outfit 字符串快照 ──
  for (const [targetId, outfit] of Object.entries(update.outfitChanges)) {
    if (!outfit) continue;
    upsertAttribute(db, {
      targetId,
      key: 'outfit',
      value: String(outfit),
      valueType: 'string',
      sourceRange,
    });
  }

  // ── 5. 主线事件 / 事件名：去重写入 ──
  for (const [eventId, status] of Object.entries(update.mainEvents)) {
    if (!eventId) continue;
    upsertEvent(db, {
      title: eventId,
      relatedMainEventId: eventId,
      description: `主线事件状态变更: ${status}`,
      outcome: status,
      gameTime: commitGameTime,
      location: commitLocation,
      sourceRange,
    });
  }

  for (const [name, description] of Object.entries(update.events)) {
    if (!name) continue;
    upsertEvent(db, {
      title: name,
      description: String(description ?? ''),
      gameTime: commitGameTime,
      location: commitLocation,
      sourceRange,
    });
  }

  // ── 6. 物品：合并语义 ──
  for (const item of update.itemsGained) {
    if (!item?.name) continue;
    upsertItem(db, {
      name: item.name,
      ownerId: 'player',
      action: 'gained',
      count: item.count ?? 1,
      state: item.description,
      gameTime: commitGameTime,
      location: commitLocation,
      sourceRange,
    });
  }

  for (const name of update.itemsLost) {
    if (!name) continue;
    upsertItem(db, {
      name,
      ownerId: 'player',
      action: 'lost',
      count: 1,
      gameTime: commitGameTime,
      location: commitLocation,
      sourceRange,
    });
  }

  // Progress 行只记录 sourceRange 供回退裁剪；摘要游标只由 commitSummaryToMemoryDB 推进。
}

/** 内部：读取某 targetId+key 的当前数值属性，缺省为 0。 */
function readNumericAttribute(db: IslandMemoryDB, targetId: string, key: string): number {
  const row = db.attributes.find(
    a => !a.expired && a.targetId === targetId && a.key === key,
  );
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : 0;
}

const SUMMARY_SOURCE_MAP = {
  minor: 'summary-minor',
  major: 'summary-major',
  global: 'summary-global',
} as const;

const KEY_FACT_TO_MEMORY_CATEGORY: Record<KeyFact['category'], MemoryFactCategory> = {
  promise: 'promise',
  secret: 'secret',
  relation: 'relation',
  item: 'item',
  event: 'event',
  location: 'location',
  profile: 'profile',
};

function rangeContains(outer: [number, number], inner: [number, number] | undefined): boolean {
  return Array.isArray(inner) && inner.length >= 2 && inner[0] >= outer[0] && inner[1] <= outer[1];
}

function sameRange(a: [number, number] | undefined, b: [number, number]): boolean {
  return Array.isArray(a) && a.length >= 2 && a[0] === b[0] && a[1] === b[1];
}

export function commitSummaryToMemoryDB(
  db: IslandMemoryDB | null | undefined,
  level: 'minor' | 'major' | 'global',
  text: string,
  range: [number, number],
  keyFacts?: KeyFact[],
): void {
  if (!db) return;

  const expireSummaryIds =
    level === 'major'
      ? db.summaries
          .filter(row => !row.expired && row.level === 'minor' && rangeContains(range, row.range))
          .map(row => row.id)
      : level === 'global'
        ? db.summaries
            .filter(row => !row.expired && row.level === 'major' && rangeContains(range, row.range))
            .map(row => row.id)
        : [];

  const inserts: NonNullable<MemoryWriteBatch['inserts']> = {
    summaries: [{ level, range, text }],
  };

  if (keyFacts?.length) {
    inserts.facts = keyFacts
      .filter(fact => fact && !fact.superseded)
      .map(fact => ({
        category: KEY_FACT_TO_MEMORY_CATEGORY[fact.category] ?? 'custom',
        gameTime: fact.gameTime,
        subject: fact.subject,
        content: fact.content,
        sourceRange: fact.sourceRange,
      }));
  }

  commitBatch(db, {
    source: SUMMARY_SOURCE_MAP[level],
    inserts,
    expire: expireSummaryIds.length ? { summaries: expireSummaryIds } : undefined,
    // 摘要游标表示“已覆盖楼层数/下一个起点”，range[1] 是 0-based 结束楼层。
    advanceCursor: range[1] + 1,
  });
}

export function updateSummaryTextInMemoryDB(
  db: IslandMemoryDB | null | undefined,
  level: MemorySummaryLevel,
  text: string | null,
  range?: [number, number],
): void {
  if (!db) return;

  const now = new Date().toISOString();

  if (level === 'global') {
    const activeGlobals = db.summaries.filter(row => !row.expired && row.level === 'global');
    if (!text?.trim()) {
      for (const row of activeGlobals) {
        row.expired = true;
        row.updatedAt = now;
      }
      return;
    }

    const latest = activeGlobals.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
    if (latest) {
      latest.text = text;
      latest.updatedAt = now;
      return;
    }

    commitSummaryToMemoryDB(db, 'global', text, range ?? [0, Math.max(0, db.lastProcessedIndex - 1)]);
    return;
  }

  if (!range) return;

  const matches = db.summaries.filter(row => !row.expired && row.level === level && sameRange(row.range, range));
  if (!text?.trim()) {
    for (const row of matches) {
      row.expired = true;
      row.updatedAt = now;
    }
    return;
  }

  if (matches.length) {
    for (const row of matches) {
      row.text = text;
      row.updatedAt = now;
    }
    return;
  }

  commitSummaryToMemoryDB(db, level, text, range);
}
