import type { CharacterCardLibrary, PlotLibrary, TargetStatus } from '../types';
import type { CharacterWorldbookLoadResult } from '../worldbook';
import { IDB_STORE_WORLDBOOK_CACHE_V3, idbGet, idbPut } from './idb';

export type WorldbookCacheData = {
  targets: TargetStatus[];
  plotLibrary: PlotLibrary;
  characterCardLibrary: CharacterCardLibrary;
};

export type WorldbookCacheRecord = {
  formatVersion: 3;
  characterKey: string;
  worldbookSetHash: string;
  worldbookNames: string[];
  data: WorldbookCacheData;
  cachedAt: number;
  staleAt?: number;
};

const pointerKey = (characterKey: string) => `last-success:${characterKey}`;
const recordKey = (characterKey: string, setHash: string) => `binding:${characterKey}:${setHash}`;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function readRecentWorldbookCache(characterKey = 'current'): Promise<WorldbookCacheRecord | null> {
  const pointer = await idbGet<{ key: string }>(IDB_STORE_WORLDBOOK_CACHE_V3, pointerKey(characterKey));
  if (!pointer?.key) return null;
  const record = await idbGet<WorldbookCacheRecord>(IDB_STORE_WORLDBOOK_CACHE_V3, pointer.key);
  if (
    !record
    || record.formatVersion !== 3
    || record.characterKey !== characterKey
    || typeof record.worldbookSetHash !== 'string'
    || !Array.isArray(record.worldbookNames)
    || !record.worldbookNames.every(name => typeof name === 'string')
    || !record.data
    || !Array.isArray(record.data.targets)
    || !record.data.targets.every(target => target && typeof target === 'object' && typeof target.id === 'string')
    || !record.data.plotLibrary
    || !record.data.plotLibrary.events
    || typeof record.data.plotLibrary.events !== 'object'
    || Array.isArray(record.data.plotLibrary.events)
    || !Array.isArray(record.data.plotLibrary.sourceEntryNames)
    || !record.data.characterCardLibrary
    || !record.data.characterCardLibrary.cards
    || typeof record.data.characterCardLibrary.cards !== 'object'
    || Array.isArray(record.data.characterCardLibrary.cards)
  ) {
    return null;
  }
  return record;
}

export function cacheMatchesWorldbookBinding(
  record: WorldbookCacheRecord,
  binding:
    | CharacterWorldbookLoadResult['binding']
    | { available: boolean; names: string[] },
) {
  // When the host cannot expose a binding, the last successful cache remains
  // the most playable fallback. Once a binding is available, never mix data
  // from a different worldbook set into the current character.
  if ('available' in binding && !binding.available) return true;
  if ('characterKey' in binding && record.characterKey !== binding.characterKey) return false;
  const cachedNames = [...record.worldbookNames].sort();
  const currentNames = [...('worldbookNames' in binding ? binding.worldbookNames : binding.names)].sort();
  return cachedNames.length === currentNames.length
    && cachedNames.every((name, index) => name === currentNames[index]);
}

export async function writeWorldbookSuccessCache(result: CharacterWorldbookLoadResult) {
  if (result.status !== 'success' && result.status !== 'legitimate-empty') return;
  const key = recordKey(result.binding.characterKey, result.binding.worldbookSetHash);
  const record: WorldbookCacheRecord = {
    formatVersion: 3,
    characterKey: result.binding.characterKey,
    worldbookSetHash: result.binding.worldbookSetHash,
    worldbookNames: [...result.binding.worldbookNames],
    data: cloneJson({
      targets: result.targets,
      plotLibrary: result.plotLibrary,
      characterCardLibrary: result.characterCardLibrary,
    }),
    cachedAt: Date.now(),
  };
  await idbPut(IDB_STORE_WORLDBOOK_CACHE_V3, key, record);
  await idbPut(IDB_STORE_WORLDBOOK_CACHE_V3, pointerKey(result.binding.characterKey), { key });
}

export async function markRecentWorldbookCacheStale(characterKey = 'current') {
  const record = await readRecentWorldbookCache(characterKey);
  if (!record) return;
  await idbPut(IDB_STORE_WORLDBOOK_CACHE_V3, recordKey(characterKey, record.worldbookSetHash), {
    ...record,
    staleAt: Date.now(),
  });
}

export function mergePartialWorldbookData(
  fresh: WorldbookCacheData,
  cached: WorldbookCacheData | null,
): WorldbookCacheData {
  if (!cached) return cloneJson(fresh);
  const targets = new Map(cached.targets.map(target => [target.id, target]));
  fresh.targets.forEach(target => targets.set(target.id, target));
  return {
    targets: [...targets.values()],
    plotLibrary: {
      ...cached.plotLibrary,
      ...fresh.plotLibrary,
      events: { ...cached.plotLibrary.events, ...fresh.plotLibrary.events },
      sourceEntryNames: [...new Set([...cached.plotLibrary.sourceEntryNames, ...fresh.plotLibrary.sourceEntryNames])],
      writingProtocols: {
        ...(cached.plotLibrary.writingProtocols ?? {}),
        ...(fresh.plotLibrary.writingProtocols ?? {}),
      },
      loadedAt: Math.max(cached.plotLibrary.loadedAt, fresh.plotLibrary.loadedAt),
    },
    characterCardLibrary: {
      cards: { ...cached.characterCardLibrary.cards, ...fresh.characterCardLibrary.cards },
      loadedAt: Math.max(cached.characterCardLibrary.loadedAt, fresh.characterCardLibrary.loadedAt),
    },
  };
}
