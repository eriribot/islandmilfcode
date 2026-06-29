import type { IslandMemoryDB, MemoryBaseRow } from './types';
import { rebuildIndexes } from './indexes';

/**
 * 垃圾回收模块：清理 expired 数据，防止内存膨胀
 *
 * 策略：
 * - 保留最近 N 天内 expired 的数据（用于 undo 和历史追溯）
 * - 清理超过 N 天的 expired 数据
 * - GC 后重建索引
 */

export type GarbageCollectResult = {
  /** 清理的行数 */
  cleaned: number;
  /** 清理前的总行数 */
  beforeTotal: number;
  /** 清理后的总行数 */
  afterTotal: number;
  /** 清理的行数占比 */
  cleanedRatio: number;
  /** 耗时（毫秒） */
  elapsed: number;
};

/**
 * 执行垃圾回收
 * @param db 数据库实例
 * @param retentionDays 保留最近 N 天的 expired 数据（默认 7 天）
 * @returns 清理结果
 */
export function garbageCollect(db: IslandMemoryDB, retentionDays: number = 7): GarbageCollectResult {
  const startTime = performance.now();
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();

  let cleaned = 0;
  let beforeTotal = 0;

  const tableNames: Array<keyof IslandMemoryDB> = [
    'attributes',
    'facts',
    'impressions',
    'items',
    'events',
    'relations',
    'tasks',
    'secrets',
    'entities',
    'phoneMessages',
    'summaries',
  ];

  for (const tableName of tableNames) {
    const table = db[tableName] as MemoryBaseRow[];
    if (!Array.isArray(table)) continue;

    beforeTotal += table.length;

    // 过滤：保留活跃行 + 最近 N 天内的 expired 行
    const kept = table.filter(row => {
      if (!row.expired) return true; // 活跃行：保留
      if (row.updatedAt > cutoff) return true; // 最近 expired：保留
      cleaned++; // 旧 expired：清理
      return false;
    });

    // 替换原数组
    (db[tableName] as MemoryBaseRow[]) = kept;
  }

  const afterTotal = beforeTotal - cleaned;
  const cleanedRatio = beforeTotal > 0 ? cleaned / beforeTotal : 0;
  const elapsed = performance.now() - startTime;

  // GC 后重建索引（因为数组已重新分配）
  rebuildIndexes(db);

  console.log(
    `[memorydb:gc] cleaned ${cleaned} rows (${(cleanedRatio * 100).toFixed(1)}%) in ${elapsed.toFixed(1)}ms | before=${beforeTotal} after=${afterTotal}`,
  );

  return {
    cleaned,
    beforeTotal,
    afterTotal,
    cleanedRatio,
    elapsed,
  };
}

/**
 * 自动 GC 决策：根据 expired 占比判断是否需要 GC
 * @param db 数据库实例
 * @param threshold expired 行占比阈值（默认 0.3 即 30%）
 * @returns 是否执行了 GC
 */
export function autoGarbageCollect(db: IslandMemoryDB, threshold: number = 0.3): boolean {
  const stats = db._indexes?.stats;
  if (!stats) return false;

  const { activeRows, expiredRows } = stats;
  const total = activeRows + expiredRows;
  if (total === 0) return false;

  const ratio = expiredRows / total;
  if (ratio < threshold) return false;

  garbageCollect(db);
  return true;
}

/**
 * GC 调度器：在每次 commitBatch 后检查，累计一定次数或行数后触发
 */
class GCScheduler {
  private commitCounter = 0;
  private lastGCTime = Date.now();

  /**
   * 每次 commitBatch 后调用
   */
  onCommit(db: IslandMemoryDB): void {
    this.commitCounter++;

    const stats = db._indexes?.stats;
    if (!stats) return;

    const { activeRows, expiredRows } = stats;
    const total = activeRows + expiredRows;

    // 触发条件（任一满足）：
    // 1. 累计 100 次 commit
    // 2. 总行数超过 10000 且 expired 占比 > 30%
    // 3. 距离上次 GC 超过 5 分钟且 expired 占比 > 20%
    const shouldGC =
      this.commitCounter >= 100 ||
      (total > 10000 && expiredRows / total > 0.3) ||
      (Date.now() - this.lastGCTime > 5 * 60 * 1000 && expiredRows / total > 0.2);

    if (shouldGC) {
      autoGarbageCollect(db, 0.2);
      this.commitCounter = 0;
      this.lastGCTime = Date.now();
    }
  }

  /**
   * 重置计数器（测试用）
   */
  reset(): void {
    this.commitCounter = 0;
    this.lastGCTime = Date.now();
  }
}

export const gcScheduler = new GCScheduler();

/**
 * 获取数据库内存占用统计
 */
export function getMemoryStats(db: IslandMemoryDB): {
  totalRows: number;
  activeRows: number;
  expiredRows: number;
  expiredRatio: number;
  estimatedBytes: number;
} {
  const stats = db._indexes?.stats;
  if (!stats) {
    // 没有索引，手动统计
    let active = 0;
    let expired = 0;

    const tableNames: Array<keyof IslandMemoryDB> = [
      'attributes',
      'facts',
      'impressions',
      'items',
      'events',
      'relations',
      'tasks',
      'secrets',
      'entities',
      'phoneMessages',
      'summaries',
    ];

    for (const tableName of tableNames) {
      const table = db[tableName] as MemoryBaseRow[];
      if (!Array.isArray(table)) continue;
      for (const row of table) {
        if (row.expired) {
          expired++;
        } else {
          active++;
        }
      }
    }

    const total = active + expired;
    const ratio = total > 0 ? expired / total : 0;
    const estimatedBytes = JSON.stringify(db).length;

    return {
      totalRows: total,
      activeRows: active,
      expiredRows: expired,
      expiredRatio: ratio,
      estimatedBytes,
    };
  }

  const { activeRows, expiredRows } = stats;
  const total = activeRows + expiredRows;
  const ratio = total > 0 ? expiredRows / total : 0;

  // 估算序列化后的字节数（粗略估计，仅供参考）
  const estimatedBytes = JSON.stringify(db).length;

  return {
    totalRows: total,
    activeRows,
    expiredRows,
    expiredRatio: ratio,
    estimatedBytes,
  };
}
