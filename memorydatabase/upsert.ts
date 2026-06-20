import type {
  IslandMemoryDB,
  MemoryAttributeRow,
  MemoryBaseRow,
  MemoryEventRow,
  MemoryItemRow,
  MemoryWorldStateRow,
  MemoryWriteBatch,
} from './types';
import {
  getPhoneArchiveImpressionSemanticKey,
  isPhoneArchiveGoldImpression,
  normalizePhoneArchiveImpressionSubject,
  PHONE_ARCHIVE_IMPRESSION_GOLD_TAG,
  PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG,
  selectPhoneArchiveImpressions,
} from '../phone/types';

/**
 * 应用一个写入批次到 MemoryDB。同步操作，直接修改传入的 db 对象。
 * 返回本次新插入的所有行 ID。
 *
 * 特殊处理：
 * - facts 走 deduplicateFact，duplicate 跳过、supersede 把旧行 expired+supersededBy 后再插入
 * - 其他表保持原始 push（个别表的 upsert 由调用方自行使用 upsertAttribute/upsertEvent/upsertItem）
 */
export function commitBatch(db: IslandMemoryDB, batch: MemoryWriteBatch): string[] {
  const now = new Date().toISOString();
  const newIds: string[] = [];

  // 1. 处理插入
  if (batch.inserts) {
    const tableNames = Object.keys(batch.inserts) as Array<keyof typeof batch.inserts>;
    for (const tableName of tableNames) {
      const payloads = batch.inserts[tableName];
      if (!payloads || payloads.length === 0) continue;

      const table = db[tableName] as MemoryBaseRow[];
      if (!Array.isArray(table)) continue;

      for (const payload of payloads) {
        // facts 走去重：同 subject+content 跳过；同 subject 不同 content 让旧行 expired。
        if (tableName === 'facts') {
          const factPayload = payload as unknown as {
            category: string;
            subject: string;
            content: string;
          };
          const dedup = deduplicateFact(db, factPayload);
          if (dedup.action === 'duplicate') {
            continue;
          }
          const newId = generateId();
          const row: MemoryBaseRow = {
            id: newId,
            createdAt: now,
            updatedAt: now,
            source: batch.source,
            ...payload,
          };
          if (dedup.action === 'supersede' && dedup.existingId) {
            const old = db.facts.find(f => f.id === dedup.existingId);
            if (old) {
              old.expired = true;
              old.supersededBy = newId;
              old.updatedAt = now;
            }
          }
          table.push(row);
          newIds.push(newId);
          continue;
        }

        // impressions 走去重：同 (targetId, subject, label) 不重复堆叠；极性变化时旧行 supersede。
        if (tableName === 'impressions') {
          const impPayload = payload as unknown as {
            targetId: string;
            subject: string;
            label: string;
            polarity: -1 | 0 | 1;
            weight?: number;
            importance?: number;
            tags?: string[];
          };
          const normalizedPayload = normalizeImpressionPayload(impPayload);
          const dedup = deduplicateImpression(db, normalizedPayload);
          if (dedup.action === 'duplicate') {
            pruneImpressionsForSubject(db, normalizedPayload.targetId, normalizedPayload.subject, now);
            continue;
          }
          const newId = generateId();
          const row: MemoryBaseRow = {
            id: newId,
            createdAt: now,
            updatedAt: now,
            source: batch.source,
            ...payload,
            ...normalizedPayload,
          };
          if (dedup.action === 'supersede' && dedup.existingId) {
            const old = db.impressions.find(i => i.id === dedup.existingId);
            if (old) {
              old.expired = true;
              old.supersededBy = newId;
              old.updatedAt = now;
            }
          }
          table.push(row);
          newIds.push(newId);
          pruneImpressionsForSubject(db, normalizedPayload.targetId, normalizedPayload.subject, now);
          continue;
        }

        const row: MemoryBaseRow = {
          id: generateId(),
          createdAt: now,
          updatedAt: now,
          source: batch.source,
          ...payload,
        };
        table.push(row);
        newIds.push(row.id);
      }
    }
  }

  // 2. 处理软删除
  if (batch.expire) {
    for (const [tableName, ids] of Object.entries(batch.expire)) {
      const table = (db as Record<string, unknown>)[tableName];
      if (!Array.isArray(table)) continue;
      for (const row of table as MemoryBaseRow[]) {
        if (ids.includes(row.id)) {
          row.expired = true;
          row.updatedAt = now;
        }
      }
    }
  }

  // 3. 处理局部更新
  if (batch.updates) {
    for (const [tableName, patches] of Object.entries(batch.updates)) {
      const table = (db as Record<string, unknown>)[tableName];
      if (!Array.isArray(table)) continue;
      for (const patch of patches) {
        const row = (table as MemoryBaseRow[]).find(r => r.id === patch.id);
        if (!row) continue;
        Object.assign(row, patch, { updatedAt: now });
      }
    }
  }

  // 4. 推进游标
  if (batch.advanceCursor !== undefined) {
    db.lastProcessedIndex = Math.max(db.lastProcessedIndex, batch.advanceCursor);
  }

  return newIds;
}

// ── 去重规则 ──

/**
 * 事实去重：检查是否已存在相同 subject + content 的活跃事实。
 * - 完全相同 → 只更新 lastSeenAt，返回 'duplicate'
 * - 同 subject 不同 content → 标记旧行 supersededBy，返回 'supersede'
 * - 无匹配 → 返回 'new'
 */
export function deduplicateFact(
  db: IslandMemoryDB,
  incoming: { category: string; subject: string; content: string },
): { action: 'duplicate' | 'supersede' | 'new'; existingId?: string } {
  const now = new Date().toISOString();
  const activeFacts = db.facts.filter(f => !f.expired);

  // 完全匹配：同 subject + 同 content
  const exact = activeFacts.find(f => f.subject === incoming.subject && f.content === incoming.content);
  if (exact) {
    exact.lastSeenAt = now;
    exact.updatedAt = now;
    return { action: 'duplicate', existingId: exact.id };
  }

  // 同 subject 不同 content：supersede
  const sameSubject = activeFacts.find(f => f.subject === incoming.subject && f.category === incoming.category);
  if (sameSubject) {
    return { action: 'supersede', existingId: sameSubject.id };
  }

  return { action: 'new' };
}

/**
 * 印象去重：以 (targetId, subject, 语义标签) 为身份。
 * - 同语义且同极性 → 只刷 lastSeenAt，返回 'duplicate'（避免同一印象反复堆叠成一长串 chip）
 * - 同语义但极性变了（如"靠谱"从 + 转 -）→ supersede 旧行，返回 'supersede'
 * - 无匹配 → 'new'
 */
export function deduplicateImpression(
  db: IslandMemoryDB,
  incoming: { targetId: string; subject: string; label: string; polarity: -1 | 0 | 1 },
): { action: 'duplicate' | 'supersede' | 'new'; existingId?: string } {
  const now = new Date().toISOString();
  const incomingSubject = normalizePhoneArchiveImpressionSubject(incoming.subject);
  const incomingKey = getPhoneArchiveImpressionSemanticKey(incoming.label);
  const active = db.impressions.filter(
    i =>
      !i.expired &&
      i.targetId === incoming.targetId &&
      normalizePhoneArchiveImpressionSubject(i.subject) === incomingSubject &&
      getPhoneArchiveImpressionSemanticKey(i.label) === incomingKey,
  );
  if (!active.length) return { action: 'new' };

  // 同身份 + 同极性：纯重复，刷新最近出现时间即可。
  const samePolarity = active.find(i => i.polarity === incoming.polarity);
  if (samePolarity) {
    samePolarity.lastSeenAt = now;
    samePolarity.updatedAt = now;
    return { action: 'duplicate', existingId: samePolarity.id };
  }

  // 同身份不同极性：让最新的旧行被新行取代。
  return { action: 'supersede', existingId: active[0].id };
}

function normalizeImpressionPayload<
  T extends {
    targetId: string;
    subject: string;
    label: string;
    polarity: -1 | 0 | 1;
    weight?: number;
    importance?: number;
    tags?: string[];
  },
>(payload: T): T {
  const label = payload.label.trim();
  const normalized = {
    ...payload,
    subject: normalizePhoneArchiveImpressionSubject(payload.subject),
    label,
  };
  if (!isPhoneArchiveGoldImpression(normalized)) return normalized;

  const tags = new Set(normalized.tags ?? []);
  tags.add(PHONE_ARCHIVE_IMPRESSION_GOLD_TAG);
  tags.add(PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG);
  return {
    ...normalized,
    tags: [...tags],
    weight: Math.max(Math.abs(normalized.weight ?? 0), 5),
    importance: Math.max(normalized.importance ?? 0, 5),
  };
}

function pruneImpressionsForSubject(
  db: IslandMemoryDB,
  targetId: string,
  subject: string,
  now = new Date().toISOString(),
): void {
  const normalizedSubject = normalizePhoneArchiveImpressionSubject(subject);
  const active = db.impressions.filter(
    i =>
      !i.expired && i.targetId === targetId && normalizePhoneArchiveImpressionSubject(i.subject) === normalizedSubject,
  );
  if (active.length <= 1) return;

  const keep = new Set(selectPhoneArchiveImpressions(active).map(i => i.id));
  for (const row of active) {
    if (keep.has(row.id) || isPhoneArchiveGoldImpression(row)) continue;
    row.expired = true;
    row.updatedAt = now;
  }
}

/**
 * 关系去重：同 fromId + toId + exclusiveGroup 只保留最新。
 * 返回需要 expire 的旧行 ID 列表。
 */
export function findSupersededRelations(
  db: IslandMemoryDB,
  incoming: { fromId: string; toId: string; exclusiveGroup?: string },
): string[] {
  if (!incoming.exclusiveGroup) return [];

  return db.relations
    .filter(
      r =>
        !r.expired &&
        r.fromId === incoming.fromId &&
        r.toId === incoming.toId &&
        r.exclusiveGroup === incoming.exclusiveGroup,
    )
    .map(r => r.id);
}

/**
 * 秘密去重：同 subject 的秘密走状态更新而非新增。
 * 返回已存在的行 ID（调用方应 update 而非 insert）。
 */
export function findExistingSecret(db: IslandMemoryDB, subject: string): string | null {
  const existing = db.secrets.find(s => !s.expired && s.subject === subject);
  return existing?.id ?? null;
}

/**
 * 手机消息去重：按 messageId 判断是否已索引。
 */
export function isPhoneMessageIndexed(db: IslandMemoryDB, messageId: string): boolean {
  return db.phoneMessages.some(m => m.messageId === messageId);
}

/**
 * 属性去重：同 targetId + key 的最新行如果 value 没变，只更新 lastSeenAt。
 * 返回 true 表示是重复的（不需要新增行）。
 */
export function deduplicateAttribute(
  db: IslandMemoryDB,
  incoming: { targetId: string; key: string; value: string },
): boolean {
  const now = new Date().toISOString();
  const latest = db.attributes
    .filter(a => !a.expired && a.targetId === incoming.targetId && a.key === incoming.key)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (latest && latest.value === incoming.value) {
    latest.lastSeenAt = now;
    latest.updatedAt = now;
    return true;
  }
  return false;
}

// ── 置信度保护 ──

const CONFIDENCE_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  certain: 4,
};

/**
 * 检查新行是否有权覆盖旧行。
 * 规则：低置信度不能覆盖高置信度 + 高重要度的行。
 */
export function canSupersede(existing: MemoryBaseRow, incomingConfidence?: string): boolean {
  const existingRank = CONFIDENCE_RANK[existing.confidence ?? 'low'] ?? 1;
  const incomingRank = CONFIDENCE_RANK[incomingConfidence ?? 'low'] ?? 1;

  // importance >= 4 且置信度高于 incoming → 保护
  if ((existing.importance ?? 0) >= 4 && existingRank > incomingRank) {
    return false;
  }
  return true;
}

// ── 工具函数 ──

/** 生成简易 UUID（浏览器环境兼容） */
function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // 降级方案
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Upsert 系列：把流水账表改成快照表 ──

export type UpsertAction = 'unchanged' | 'updated' | 'created';

export type UpsertResult = {
  action: UpsertAction;
  rowId: string;
};

/**
 * 属性快照写入：同 targetId+key 永远只保留 1 条活跃行。
 * - value 不变 → 仅刷 lastSeenAt（unchanged）
 * - value 变化 → 旧行 expired=true 并指向新行；新行带 previousValue + delta
 * - 不存在 → 新建一行（created）
 */
export function upsertAttribute(
  db: IslandMemoryDB,
  patch: {
    targetId: string;
    key: string;
    value: string;
    valueType?: MemoryAttributeRow['valueType'];
    reason?: string;
    importance?: number;
    sourceRange?: [number, number];
    source?: MemoryBaseRow['source'];
  },
): UpsertResult {
  const now = new Date().toISOString();
  const active = db.attributes.filter(a => !a.expired && a.targetId === patch.targetId && a.key === patch.key);
  // 同 key 出现多条活跃行（旧 schema 残留）：按 createdAt 取最新一条，其余 expire。
  active.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = active[0];
  for (let i = 1; i < active.length; i++) {
    active[i].expired = true;
    active[i].updatedAt = now;
  }

  if (latest && latest.value === patch.value) {
    latest.lastSeenAt = now;
    latest.updatedAt = now;
    return { action: 'unchanged', rowId: latest.id };
  }

  const previousValue = latest?.value;
  let delta: number | undefined;
  if (patch.valueType === 'number') {
    const prev = Number(previousValue);
    const next = Number(patch.value);
    if (Number.isFinite(prev) && Number.isFinite(next)) {
      delta = next - prev;
    }
  }

  const newRow: MemoryAttributeRow = {
    id: generateId(),
    createdAt: now,
    updatedAt: now,
    source: patch.source ?? 'progress-commit',
    sourceRange: patch.sourceRange,
    importance: patch.importance,
    targetId: patch.targetId,
    key: patch.key,
    value: patch.value,
    valueType: patch.valueType,
    previousValue,
    delta,
    reason: patch.reason,
    lastSeenAt: now,
  };
  db.attributes.push(newRow);

  if (latest) {
    latest.expired = true;
    latest.supersededBy = newRow.id;
    latest.updatedAt = now;
    return { action: 'updated', rowId: newRow.id };
  }

  return { action: 'created', rowId: newRow.id };
}

/**
 * 事件快照写入：按 relatedMainEventId（优先）或 title 去重。
 * 已存在 → 合并 description/outcome/lastSeenAt，不新增行。
 * 不存在 → 新建一行。
 */
export function upsertEvent(
  db: IslandMemoryDB,
  patch: {
    title: string;
    description?: string;
    relatedMainEventId?: string;
    outcome?: string;
    gameTime?: string;
    location?: string;
    involvedTargetIds?: string[];
    importance?: number;
    sourceRange?: [number, number];
    source?: MemoryBaseRow['source'];
  },
): UpsertResult {
  const now = new Date().toISOString();
  const matchKey = patch.relatedMainEventId || patch.title;
  const existing = db.events.find(e => {
    if (e.expired) return false;
    if (patch.relatedMainEventId) return e.relatedMainEventId === patch.relatedMainEventId;
    return e.title === patch.title;
  });

  if (existing) {
    if (patch.description !== undefined) existing.description = patch.description;
    if (patch.outcome !== undefined) existing.outcome = patch.outcome;
    if (patch.gameTime !== undefined) existing.gameTime = patch.gameTime;
    if (patch.location !== undefined) existing.location = patch.location;
    if (patch.involvedTargetIds) existing.involvedTargetIds = patch.involvedTargetIds;
    existing.lastSeenAt = now;
    existing.updatedAt = now;
    // matchKey 仅用于潜在调试输出，避免 unused 告警
    void matchKey;
    return { action: 'updated', rowId: existing.id };
  }

  const newRow: MemoryEventRow = {
    id: generateId(),
    createdAt: now,
    updatedAt: now,
    source: patch.source ?? 'progress-commit',
    sourceRange: patch.sourceRange,
    importance: patch.importance,
    title: patch.title,
    description: patch.description ?? '',
    relatedMainEventId: patch.relatedMainEventId,
    outcome: patch.outcome,
    gameTime: patch.gameTime,
    location: patch.location,
    involvedTargetIds: patch.involvedTargetIds,
    lastSeenAt: now,
  };
  db.events.push(newRow);
  return { action: 'created', rowId: newRow.id };
}

/**
 * 物品快照写入：按 name + ownerId 合并。
 * - gained：count += incoming.count（默认 1），刷新 state
 * - lost：count -= incoming.count（默认 1）；若 count <= 0 → expired
 * - lost 但不存在：no-op，返回 unchanged
 */
export function upsertItem(
  db: IslandMemoryDB,
  patch: {
    name: string;
    ownerId?: string;
    action: 'gained' | 'lost' | 'transformed' | 'noted';
    count?: number;
    state?: string;
    holderId?: string;
    location?: string;
    gameTime?: string;
    sourceRange?: [number, number];
    source?: MemoryBaseRow['source'];
  },
): UpsertResult {
  const now = new Date().toISOString();
  const owner = patch.ownerId ?? 'player';
  const delta = patch.count ?? 1;

  const existing = db.items.find(i => !i.expired && i.name === patch.name && (i.ownerId ?? 'player') === owner);

  if (patch.action === 'lost') {
    if (!existing) return { action: 'unchanged', rowId: '' };
    if (existing.locked) {
      existing.updatedAt = now;
      existing.lastSeenAt = now;
      return { action: 'unchanged', rowId: existing.id };
    }
    const next = (existing.count ?? 1) - delta;
    if (next <= 0) {
      existing.expired = true;
      existing.count = 0;
      existing.action = 'lost';
    } else {
      existing.count = next;
      existing.action = 'lost';
    }
    existing.updatedAt = now;
    existing.lastSeenAt = now;
    return { action: 'updated', rowId: existing.id };
  }

  if (existing) {
    if (patch.action === 'gained') {
      existing.count = (existing.count ?? 1) + delta;
    } else {
      existing.count = patch.count ?? existing.count;
    }
    if (patch.state !== undefined) existing.state = patch.state;
    if (patch.holderId !== undefined) existing.holderId = patch.holderId;
    if (patch.location !== undefined) existing.location = patch.location;
    if (patch.gameTime !== undefined) existing.gameTime = patch.gameTime;
    existing.action = patch.action;
    existing.updatedAt = now;
    existing.lastSeenAt = now;
    return { action: 'updated', rowId: existing.id };
  }

  const newRow: MemoryItemRow = {
    id: generateId(),
    createdAt: now,
    updatedAt: now,
    source: patch.source ?? 'progress-commit',
    sourceRange: patch.sourceRange,
    name: patch.name,
    ownerId: owner,
    holderId: patch.holderId,
    location: patch.location,
    gameTime: patch.gameTime,
    state: patch.state,
    action: patch.action,
    count: delta,
    lastSeenAt: now,
  };
  db.items.push(newRow);
  return { action: 'created', rowId: newRow.id };
}

/**
 * 世界状态写入：worldState 表始终只保留一条活跃行。
 * 已存在 → 浅合并 patch；不存在 → 新建。
 * 多余的活跃行（schema 残留）一并 expire。
 */
export function upsertWorldState(
  db: IslandMemoryDB,
  patch: Partial<Omit<MemoryWorldStateRow, keyof MemoryBaseRow>> & {
    sourceRange?: [number, number];
    source?: MemoryBaseRow['source'];
  },
): UpsertResult {
  const now = new Date().toISOString();
  const active = db.worldState.filter(w => !w.expired);
  active.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (let i = 1; i < active.length; i++) {
    active[i].expired = true;
    active[i].updatedAt = now;
  }
  const row = active[0];

  if (row) {
    let changed = false;
    const fields = ['currentTime', 'currentLocation', 'currentMainEventId', 'storyStartDate', 'currentDay'] as const;
    for (const f of fields) {
      const next = patch[f];
      if (next === undefined) continue;
      if (row[f] !== next) {
        (row as Record<string, unknown>)[f] = next;
        changed = true;
      }
    }
    if (changed) {
      row.updatedAt = now;
      row.lastSeenAt = now;
      return { action: 'updated', rowId: row.id };
    }
    row.lastSeenAt = now;
    return { action: 'unchanged', rowId: row.id };
  }

  const newRow: MemoryWorldStateRow = {
    id: generateId(),
    createdAt: now,
    updatedAt: now,
    source: patch.source ?? 'progress-commit',
    sourceRange: patch.sourceRange,
    currentTime: patch.currentTime,
    currentLocation: patch.currentLocation,
    currentMainEventId: patch.currentMainEventId,
    storyStartDate: patch.storyStartDate,
    currentDay: patch.currentDay,
    lastSeenAt: now,
  };
  db.worldState.push(newRow);
  return { action: 'created', rowId: newRow.id };
}
