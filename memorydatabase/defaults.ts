import { MEMORY_DB_VERSION } from './types';
import type { IslandMemoryDB } from './types';

/** 创建一个空的 MemoryDB 实例，所有表初始化为空数组 */
export function createDefaultMemoryDB(runId: string): IslandMemoryDB {
  return {
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
  };
}
