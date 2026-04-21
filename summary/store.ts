import { createDefaultSummaryStore, type SummaryApiConfig, type SummaryStore } from './types';

const SUMMARY_API_CONFIG_KEY = 'islandmilfcode-summary-api-config';

/** Summary data now lives inside SaveSlot. These functions are kept for API config only. */

export function loadSummaryStore(): SummaryStore {
  return createDefaultSummaryStore();
}

export function saveSummaryStore(): void {
  // no-op: summary is persisted via the save slot in index.ts
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
    /* ignore */
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
    /* ignore */
  }
}
