import type { IslandMemoryDB, MemoryBaseRow } from './types';
import { createDefaultMemoryDB } from './defaults';
import { rebuildIndexes } from './indexes';

/** 已知的核心表名列表 */
const KNOWN_TABLES = [
  'entities', 'events', 'facts', 'relations',
  'impressions', 'tasks', 'secrets', 'items',
  'phoneMessages', 'summaries', 'attributes', 'worldState',
] as const;

/**
 * 反序列化兜底：把存档中的 raw JSON 还原为合法的 IslandMemoryDB。
 *
 * 行为：
 * - 输入不是 object 或缺少 version → 返回 null（调用方应走迁移路径）
 * - 缺失的表用 [] 兜底
 * - 每行用 isValidBaseRow 过滤无效项（必须有 id 和 createdAt）
 * - 未知顶层数组 key 进 extensions（前向兼容）
 * - 永远不抛异常
 */
export function normalizeMemoryDB(raw: unknown, runId: string): IslandMemoryDB | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'number') return null;

  const db = createDefaultMemoryDB(runId);
  db.version = obj.version as number;
  db.runId = typeof obj.runId === 'string' ? obj.runId : runId;
  db.lastProcessedIndex =
    typeof obj.lastProcessedIndex === 'number'
      ? Math.max(0, obj.lastProcessedIndex)
      : 0;

  // 填充已知表，过滤无效行
  for (const tableName of KNOWN_TABLES) {
    const rawTable = obj[tableName];
    if (Array.isArray(rawTable)) {
      (db[tableName] as MemoryBaseRow[]) = rawTable.filter(isValidBaseRow);
    }
  }

  // 未知的数组类型 key 收入 extensions（前向兼容新表）
  for (const [key, value] of Object.entries(obj)) {
    if (KNOWN_TABLES.includes(key as typeof KNOWN_TABLES[number])) continue;
    if (['version', 'runId', 'lastProcessedIndex', 'extensions'].includes(key)) continue;
    if (Array.isArray(value) && value.length > 0 && isValidBaseRow(value[0])) {
      db.extensions ??= {};
      db.extensions[key] = value.filter(isValidBaseRow);
    }
  }

  // 显式传入的 extensions 也保留
  if (obj.extensions && typeof obj.extensions === 'object') {
    db.extensions ??= {};
    for (const [key, value] of Object.entries(obj.extensions as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        db.extensions[key] = value.filter(isValidBaseRow);
      }
    }
  }

  rebuildIndexes(db);
  return db;
}

/** 最小合法性校验：必须有 id 和 createdAt */
function isValidBaseRow(row: unknown): row is MemoryBaseRow {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0
    && typeof r.createdAt === 'string' && r.createdAt.length > 0;
}
