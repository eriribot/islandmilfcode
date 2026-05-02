import { createDefaultSummaryStore, type SummaryApiConfig, type SummaryStore } from './types';

const SUMMARY_API_CONFIG_KEY = 'islandmilfcode-summary-api-config';

/** 摘要数据现在保存在 SaveSlot 中；这里的函数仅保留给 API 配置使用。 */

export function loadSummaryStore(): SummaryStore {
  return createDefaultSummaryStore();
}

export function saveSummaryStore(_win?: unknown, _store?: SummaryStore): void {
  // 空操作：摘要通过 index.ts 的存档槽持久化。
}

export function loadSummaryApiConfig(): SummaryApiConfig | null {
  try {
    const raw = localStorage.getItem(SUMMARY_API_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.apiurl === 'string' &&
      typeof parsed.key === 'string' &&
      typeof parsed.model === 'string'
    ) {
      return parsed as SummaryApiConfig;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

export function saveSummaryApiConfig(config: SummaryApiConfig | null): void {
  try {
    if (config) {
      localStorage.setItem(SUMMARY_API_CONFIG_KEY, JSON.stringify(config));
    } else {
      localStorage.removeItem(SUMMARY_API_CONFIG_KEY);
    }
  } catch {
    /* 忽略 */
  }
}
