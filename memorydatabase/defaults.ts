import { MEMORY_DB_VERSION } from './types';
import type { IslandMemoryDB } from './types';
import { rebuildIndexes } from './indexes';

/** 创建一个空的 MemoryDB 实例，所有表初始化为空数组 */
export function createDefaultMemoryDB(runId: string): IslandMemoryDB {
  const db: IslandMemoryDB = {
    version: MEMORY_DB_VERSION,
    runId,
    lastProcessedIndex: 0,
    entities: [],
    events: [],
    facts: [],
    relations: [],
    impressions: [],
    tasks: [],
    secrets: [],
    items: [],
    phoneMessages: [],
    summaries: [],
    attributes: [],
    worldState: [],
  };

  // 初始化空索引；空库日志会误导存档排查，加载真实数据后再打印重建结果。
  rebuildIndexes(db, { log: false });

  return db;
}
