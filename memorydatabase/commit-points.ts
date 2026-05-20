import type { ProgressUpdate } from '../message-format';
import type { KeyFact } from '../summary/types';
import { commitBatch, deduplicateAttribute } from './upsert';
import type { IslandMemoryDB, MemoryFactCategory, MemoryWriteBatch } from './types';

export function commitProgressToMemoryDB(
  db: IslandMemoryDB | null | undefined,
  update: ProgressUpdate,
  sourceRange?: [number, number],
): void {
  if (!db) return;

  const inserts: NonNullable<MemoryWriteBatch['inserts']> = {};

  for (const item of update.affinityDeltas) {
    if (!item.delta) continue;
    const isDuplicate = deduplicateAttribute(db, {
      targetId: item.target,
      key: 'affinity-delta',
      value: String(item.delta),
    });
    if (isDuplicate) continue;
    inserts.attributes ??= [];
    inserts.attributes.push({
      targetId: item.target,
      key: 'affinity-delta',
      value: String(item.delta),
      valueType: 'number',
      delta: item.delta,
    });
  }

  for (const [statKey, delta] of Object.entries(update.statDeltas)) {
    if (!delta) continue;
    inserts.attributes ??= [];
    inserts.attributes.push({
      targetId: 'player',
      key: `stat-${statKey}`,
      value: String(delta),
      valueType: 'number',
      delta: Number(delta),
    });
  }

  for (const [targetId, outfit] of Object.entries(update.outfitChanges)) {
    if (!outfit) continue;
    const isDuplicate = deduplicateAttribute(db, {
      targetId,
      key: 'outfit',
      value: outfit,
    });
    if (isDuplicate) continue;
    inserts.attributes ??= [];
    inserts.attributes.push({
      targetId,
      key: 'outfit',
      value: outfit,
      valueType: 'string',
    });
  }

  if (update.currentMainEventId) {
    const isDuplicate = deduplicateAttribute(db, {
      targetId: 'world',
      key: 'currentMainEventId',
      value: update.currentMainEventId,
    });
    if (!isDuplicate) {
      inserts.attributes ??= [];
      inserts.attributes.push({
        targetId: 'world',
        key: 'currentMainEventId',
        value: update.currentMainEventId,
        valueType: 'string',
      });
    }
  }

  for (const [eventId, status] of Object.entries(update.mainEvents)) {
    if (!eventId) continue;
    inserts.events ??= [];
    inserts.events.push({
      title: eventId,
      description: `主线事件状态变更: ${status}`,
      relatedMainEventId: eventId,
      outcome: status,
    });
  }

  for (const [name, description] of Object.entries(update.events)) {
    if (!name) continue;
    inserts.events ??= [];
    inserts.events.push({
      title: name,
      description: String(description ?? ''),
    });
  }

  for (const item of update.itemsGained) {
    if (!item?.name) continue;
    inserts.items ??= [];
    inserts.items.push({
      name: item.name,
      ownerId: 'player',
      action: 'gained',
      count: item.count,
      state: item.description,
    });
  }

  for (const name of update.itemsLost) {
    if (!name) continue;
    inserts.items ??= [];
    inserts.items.push({
      name,
      ownerId: 'player',
      action: 'lost',
    });
  }

  const hasInserts = Object.values(inserts).some(arr => Array.isArray(arr) && arr.length > 0);
  if (!hasInserts && sourceRange === undefined) return;

  const batch: MemoryWriteBatch = {
    source: 'progress-commit',
    inserts: hasInserts ? inserts : undefined,
  };
  if (sourceRange) batch.advanceCursor = sourceRange[1];
  commitBatch(db, batch);
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

export function commitSummaryToMemoryDB(
  db: IslandMemoryDB | null | undefined,
  level: 'minor' | 'major' | 'global',
  text: string,
  range: [number, number],
  keyFacts?: KeyFact[],
): void {
  if (!db) return;

  const inserts: NonNullable<MemoryWriteBatch['inserts']> = {
    summaries: [{ level, range, text }],
  };

  if (keyFacts?.length) {
    inserts.facts = keyFacts
      .filter(fact => fact && !fact.superseded)
      .map(fact => ({
        category: KEY_FACT_TO_MEMORY_CATEGORY[fact.category] ?? 'custom',
        subject: fact.subject,
        content: fact.content,
        sourceRange: fact.sourceRange,
      }));
  }

  commitBatch(db, {
    source: SUMMARY_SOURCE_MAP[level],
    inserts,
    advanceCursor: range[1],
  });
}
