import type { SummaryStore } from '../summary/types';
import { createDefaultSummaryStore } from '../summary/types';
import type { PersistedMessage, SaveSlot, StatusData } from '../types';
import { defaultStatusData, normalizeStatusData } from '../variables/normalize';

const SAVES_STORAGE_KEY = 'islandmilfcode-saves-v1';

function readAllSaves(): Record<string, SaveSlot> {
  try {
    const raw = localStorage.getItem(SAVES_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, SaveSlot>;
  } catch {
    return {};
  }
}

function writeAllSaves(saves: Record<string, SaveSlot>): void {
  try {
    localStorage.setItem(SAVES_STORAGE_KEY, JSON.stringify(saves));
  } catch {
    /* ignore quota errors */
  }
}

/** Returns saves sorted by updatedAt descending (most recent first). */
export function listSaves(): SaveSlot[] {
  const saves = readAllSaves();
  return Object.values(saves).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Creates a new save slot with default data. Returns the new saveId. */
export function createSave(opts: { characterName: string; personality: string; appearance: string }): string {
  const saves = readAllSaves();
  const id = crypto.randomUUID();
  const now = Date.now();
  saves[id] = {
    id,
    characterName: opts.characterName,
    personality: opts.personality,
    appearance: opts.appearance,
    messages: [],
    statusData: normalizeStatusData(defaultStatusData),
    summaryStore: createDefaultSummaryStore(),
    createdAt: now,
    updatedAt: now,
  };
  writeAllSaves(saves);
  return id;
}

/** Loads a single save. Returns null if not found. */
export function loadSave(saveId: string): SaveSlot | null {
  const saves = readAllSaves();
  return saves[saveId] ?? null;
}

/** Writes updated data into an existing save slot. */
export function writeSave(
  saveId: string,
  data: {
    messages: PersistedMessage[];
    statusData: StatusData;
    summaryStore: SummaryStore;
  },
): void {
  const saves = readAllSaves();
  const existing = saves[saveId];
  if (!existing) return;
  existing.messages = data.messages;
  existing.statusData = data.statusData;
  existing.summaryStore = data.summaryStore;
  existing.updatedAt = Date.now();
  writeAllSaves(saves);
}

/** Deletes a save slot. */
export function deleteSave(saveId: string): void {
  const saves = readAllSaves();
  delete saves[saveId];
  writeAllSaves(saves);
}
