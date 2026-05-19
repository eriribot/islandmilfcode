import type {
  IslandMemoryDB,
  MemoryBaseRow,
  MemoryWriteBatch,
} from './types';

/**
 * 应用一个写入批次到 MemoryDB。同步操作，直接修改传入的 db 对象。
 * 返回本次新插入的所有行 ID。
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
  const exact = activeFacts.find(
    f => f.subject === incoming.subject && f.content === incoming.content,
  );
  if (exact) {
    exact.lastSeenAt = now;
    exact.updatedAt = now;
    return { action: 'duplicate', existingId: exact.id };
  }

  // 同 subject 不同 content：supersede
  const sameSubject = activeFacts.find(
    f => f.subject === incoming.subject && f.category === incoming.category,
  );
  if (sameSubject) {
    return { action: 'supersede', existingId: sameSubject.id };
  }

  return { action: 'new' };
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
    .filter(r =>
      !r.expired
      && r.fromId === incoming.fromId
      && r.toId === incoming.toId
      && r.exclusiveGroup === incoming.exclusiveGroup,
    )
    .map(r => r.id);
}

/**
 * 秘密去重：同 subject 的秘密走状态更新而非新增。
 * 返回已存在的行 ID（调用方应 update 而非 insert）。
 */
export function findExistingSecret(
  db: IslandMemoryDB,
  subject: string,
): string | null {
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
export function canSupersede(
  existing: MemoryBaseRow,
  incomingConfidence?: string,
): boolean {
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
