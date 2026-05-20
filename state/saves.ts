import type { SummaryStore } from '../summary/types';
import { createDefaultSummaryStore } from '../summary/types';
import { extractContextReply } from '../message-format';
import type {
  Difficulty,
  GameState,
  PersistedMessage,
  PlayerProfile,
  PlayerStats,
  SaveKind,
  SaveMeta,
  SavePayload,
  SaveTargetMeta,
  StatusData,
} from '../types';
import { normalizePhoneMessageStore } from './store';
import { defaultStatusData, normalizeStatusData } from '../variables/normalize';
import { normalizeMemoryDB } from '../memorydatabase/normalize';
import { migrateSummaryStoreToMemoryDB } from '../memorydatabase/migrate';

const SAVE_INDEX_STORAGE_KEY = 'islandmilfcode:save-index:v2';
const SAVE_PAYLOAD_STORAGE_PREFIX = 'islandmilfcode:save-payload:v2:';
const ACTIVE_RUN_ID_STORAGE_KEY = 'islandmilfcode:active-run-id:v2';
const ACTIVE_SAVE_ID_STORAGE_KEY = 'islandmilfcode:active-save-id:v2';
const LEGACY_SAVES_STORAGE_KEY = 'islandmilfcode-saves-v1';
const SAVE_VERSION = 2;

type LegacySaveSlot = {
  id: string;
  characterName: string;
  personality: string;
  appearance: string;
  messages: PersistedMessage[];
  statusData: StatusData;
  summaryStore: SummaryStore;
  createdAt: number;
  updatedAt: number;
};

type SaveIndexRecord = Record<string, SaveMeta>;

const DEFAULT_STATS: PlayerStats = { knowledge: 60, charm: 60, proficiency: 60, kindness: 60, courage: 60 };

function normalizeStats(input: unknown): PlayerStats {
  const raw = typeof input === 'object' && input ? (input as Partial<PlayerStats>) : {};
  const clamp = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Number(v) || 0));
  return {
    knowledge: clamp(raw.knowledge ?? DEFAULT_STATS.knowledge, 0, 100),
    charm: clamp(raw.charm ?? DEFAULT_STATS.charm, 0, 100),
    proficiency: clamp(raw.proficiency ?? DEFAULT_STATS.proficiency, 0, 100),
    kindness: clamp(raw.kindness ?? DEFAULT_STATS.kindness, 0, 100),
    courage: clamp(raw.courage ?? DEFAULT_STATS.courage, 0, 100),
  };
}

function normalizeDifficulty(input: unknown): Difficulty {
  if (input === 'easy' || input === 'normal' || input === 'hard') return input;
  return 'normal';
}

function normalizePlayerProfile(input: unknown): PlayerProfile {
  const raw = typeof input === 'object' && input ? (input as Partial<PlayerProfile>) : {};
  return {
    name: String(raw.name ?? ''),
    gender: raw.gender ? String(raw.gender) : '男',
    personality: String(raw.personality ?? ''),
    appearance: String(raw.appearance ?? ''),
    className: raw.className ? String(raw.className) : '2年A班',
    stats: normalizeStats(raw.stats),
    difficulty: normalizeDifficulty(raw.difficulty),
  };
}

function getPlayerProfileFromGameState(gameState: Partial<GameState> | undefined): PlayerProfile {
  return normalizePlayerProfile(gameState?.runtimeFlags?.playerProfile);
}

function getLegacyPlayerProfile(meta: Partial<SaveMeta> | undefined): PlayerProfile {
  return normalizePlayerProfile({
    name: meta?.characterName,
    personality: meta?.personality,
    appearance: meta?.appearance,
  });
}

function normalizeSaveTargetMeta(input: unknown): SaveTargetMeta | null {
  const raw = typeof input === 'object' && input ? (input as Partial<SaveTargetMeta>) : null;
  if (!raw?.id && !raw?.name) return null;
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    ...(raw.alias ? { alias: String(raw.alias) } : {}),
    affinity: Number(raw.affinity ?? 0) || 0,
    stage: String(raw.stage ?? ''),
  };
}

function createSaveTargetMeta(statusData: StatusData): SaveTargetMeta | null {
  // 中文注释：存档封面只展示明确激活对象；不会用 targets[0] 当默认目标。
  const target = statusData.activeTargetId
    ? statusData.targets.find(item => item.id === statusData.activeTargetId) ?? null
    : null;
  if (!target) return null;
  return {
    id: target.id,
    name: target.name,
    ...(target.alias ? { alias: target.alias } : {}),
    affinity: target.affinity,
    stage: target.stage,
  };
}

function normalizeSaveMeta(meta: SaveMeta): SaveMeta {
  const raw = meta as Partial<SaveMeta>;
  const playerProfile = normalizePlayerProfile(raw.playerProfile ?? getLegacyPlayerProfile(raw));
  return {
    ...meta,
    playerProfile,
    activeTarget: normalizeSaveTargetMeta(raw.activeTarget),
    characterName: raw.characterName ?? playerProfile.name,
    personality: raw.personality ?? playerProfile.personality,
    appearance: raw.appearance ?? playerProfile.appearance,
  };
}

function shouldHydrateMetaFromPayload(meta: SaveMeta): boolean {
  const raw = meta as Partial<SaveMeta>;
  return !raw.playerProfile || !Object.prototype.hasOwnProperty.call(raw, 'activeTarget');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getPayloadStorageKey(saveId: string) {
  return `${SAVE_PAYLOAD_STORAGE_PREFIX}${saveId}`;
}

function safeReadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略容量限制错误 */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

function normalizePersistedMessages(messages: PersistedMessage[] | undefined): PersistedMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
    .map(message => ({
      role: message.role,
      speaker: String(message.speaker || (message.role === 'assistant' ? 'Assistant' : 'User')),
      text: String(message.text ?? ''),
      ...(message.rawText ? { rawText: String(message.rawText) } : {}),
      ...(message.statusSnapshot ? { statusSnapshot: cloneJson(message.statusSnapshot) } : {}),
    }));
}

function normalizeGameState(gameState: Partial<GameState> | undefined, fallbackRunId: string): GameState {
  const runtimeFlags = gameState?.runtimeFlags ? cloneJson(gameState.runtimeFlags) : undefined;
  if (runtimeFlags && typeof runtimeFlags === 'object') {
    runtimeFlags.playerProfile = normalizePlayerProfile((runtimeFlags as Record<string, unknown>).playerProfile);
    runtimeFlags.phoneMessages = normalizePhoneMessageStore((runtimeFlags as Record<string, unknown>).phoneMessages);
  }
  return {
    runId: String(gameState?.runId || fallbackRunId),
    statusData: normalizeStatusData(gameState?.statusData ?? defaultStatusData),
    currentMessageIndex: Math.max(0, Number(gameState?.currentMessageIndex ?? 0) || 0),
    worldState: gameState?.worldState ? cloneJson(gameState.worldState) : undefined,
    runtimeFlags,
  };
}

function getLatestVisiblePreview(messages: PersistedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const raw = String(message.rawText || message.text || '').trim();
    const visible = message.role === 'assistant' ? extractContextReply(raw) : raw;
    if (visible.trim()) return visible.trim();
  }
  return '';
}

function createMetaFromPayload(payload: SavePayload, input: { kind: SaveKind; label: string; createdAt?: number }): SaveMeta {
  const statusData = payload.gameState.statusData;
  const playerProfile = getPlayerProfileFromGameState(payload.gameState);
  const messageCount = payload.chatLog.length;
  const latestPreview = getLatestVisiblePreview(payload.chatLog);
  const now = Date.now();

  return {
    saveId: payload.saveId,
    runId: payload.runId,
    kind: input.kind,
    label: input.label,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    messageIndex: payload.gameState.currentMessageIndex,
    playerProfile,
    activeTarget: createSaveTargetMeta(statusData),
    characterName: playerProfile.name,
    personality: playerProfile.personality,
    appearance: playerProfile.appearance,
    location: statusData.world.currentLocation,
    gameTime: statusData.world.currentTime,
    preview: latestPreview ? latestPreview.slice(0, 80) : '',
    messageCount,
    version: SAVE_VERSION,
  };
}

function migrateLegacySavesIfNeeded(): void {
  const existingIndex = safeReadJson<SaveIndexRecord>(SAVE_INDEX_STORAGE_KEY, {});
  const legacy = safeReadJson<Record<string, LegacySaveSlot>>(LEGACY_SAVES_STORAGE_KEY, {});
  if (!Object.keys(legacy).length) return;

  const nextIndex = { ...existingIndex };
  for (const legacySave of Object.values(legacy)) {
    if (!legacySave?.id || nextIndex[legacySave.id]) continue;
    const runId = crypto.randomUUID();
    const statusData = normalizeStatusData(legacySave.statusData ?? defaultStatusData);
    const playerProfile = normalizePlayerProfile({
      name: legacySave.characterName,
      personality: legacySave.personality,
      appearance: legacySave.appearance,
    });
    const payload: SavePayload = {
      saveId: legacySave.id,
      runId,
      gameState: {
        runId,
        statusData,
        currentMessageIndex: Math.max(0, (legacySave.messages?.length ?? 0) - 1),
        runtimeFlags: {
          playerProfile,
          phoneMessages: normalizePhoneMessageStore(null),
        },
      },
      chatLog: normalizePersistedMessages(legacySave.messages),
      summaryStore: cloneJson(legacySave.summaryStore ?? createDefaultSummaryStore()),
      version: SAVE_VERSION,
    };
    writePayload(payload);
    nextIndex[legacySave.id] = {
      ...createMetaFromPayload(payload, {
        kind: legacySave.id.startsWith('autosave_') ? 'autosave' : 'manual',
        label: legacySave.id.startsWith('autosave_') ? '自动存档' : '手动存档',
        createdAt: legacySave.createdAt,
      }),
      updatedAt: Number(legacySave.updatedAt || legacySave.createdAt || Date.now()),
    };
  }

  writeSaveIndex(nextIndex);
  safeRemove(LEGACY_SAVES_STORAGE_KEY);
}

function readSaveIndex(): SaveIndexRecord {
  migrateLegacySavesIfNeeded();
  const rawIndex = safeReadJson<SaveIndexRecord>(SAVE_INDEX_STORAGE_KEY, {});
  const normalizedIndex: SaveIndexRecord = {};
  let changed = false;
  for (const [saveId, meta] of Object.entries(rawIndex)) {
    let nextMeta = normalizeSaveMeta(meta);
    if (shouldHydrateMetaFromPayload(meta)) {
      const payload = readPayload(saveId);
      if (payload) {
        nextMeta = {
          ...createMetaFromPayload(payload, {
            kind: nextMeta.kind,
            label: nextMeta.label,
            createdAt: nextMeta.createdAt,
          }),
          updatedAt: nextMeta.updatedAt,
        };
      }
    }
    if (JSON.stringify(meta) !== JSON.stringify(nextMeta)) changed = true;
    normalizedIndex[saveId] = nextMeta;
  }
  if (changed) writeSaveIndex(normalizedIndex);
  return normalizedIndex;
}

function writeSaveIndex(index: SaveIndexRecord): void {
  safeWriteJson(SAVE_INDEX_STORAGE_KEY, index);
}

function writePayload(payload: SavePayload): void {
  safeWriteJson(getPayloadStorageKey(payload.saveId), payload);
}

function readPayload(saveId: string): SavePayload | null {
  const payload = safeReadJson<SavePayload | null>(getPayloadStorageKey(saveId), null);
  if (!payload || typeof payload !== 'object') return null;

  const runId = String(payload.runId || payload.gameState?.runId || '');
  if (!runId) return null;

  const summaryStore = cloneJson(payload.summaryStore ?? createDefaultSummaryStore());

  // memoryDB：优先从存档读取，没有则从 summaryStore 迁移
  const memoryDB =
    normalizeMemoryDB(payload.memoryDB, runId)
    ?? migrateSummaryStoreToMemoryDB(summaryStore, runId);

  return {
    saveId: String(payload.saveId || saveId),
    runId,
    gameState: normalizeGameState(payload.gameState, runId),
    chatLog: normalizePersistedMessages(payload.chatLog),
    summaryStore,
    memoryDB,
    messageSnapshots: Array.isArray(payload.messageSnapshots) ? cloneJson(payload.messageSnapshots) : undefined,
    version: Number(payload.version ?? SAVE_VERSION) || SAVE_VERSION,
  };
}

function buildInitialPayload(opts: {
  saveId: string;
  runId: string;
  characterName: string;
  personality: string;
  appearance: string;
  gender?: string;
  className?: string;
  stats?: PlayerStats;
  difficulty?: Difficulty;
  kind: SaveKind;
  label: string;
}): SavePayload {
  const statusData = normalizeStatusData(defaultStatusData);

  return {
    saveId: opts.saveId,
    runId: opts.runId,
    gameState: {
      runId: opts.runId,
      statusData,
      currentMessageIndex: 0,
      runtimeFlags: {
        saveKind: opts.kind,
        playerProfile: normalizePlayerProfile({
          name: opts.characterName,
          gender: opts.gender,
          personality: opts.personality,
          appearance: opts.appearance,
          className: opts.className,
          stats: opts.stats,
          difficulty: opts.difficulty,
        }),
        phoneMessages: normalizePhoneMessageStore(null),
      },
    },
    chatLog: [],
    summaryStore: createDefaultSummaryStore(),
    version: SAVE_VERSION,
  };
}

function ensureMeta(saveId: string): SaveMeta | null {
  const index = readSaveIndex();
  const existing = index[saveId];
  if (existing) return existing;
  const payload = readPayload(saveId);
  if (!payload) return null;
  const meta = createMetaFromPayload(payload, {
    kind: payload.saveId.startsWith('autosave_') ? 'autosave' : 'manual',
    label: payload.saveId.startsWith('autosave_') ? '自动存档' : '手动存档',
  });
  index[saveId] = meta;
  writeSaveIndex(index);
  return meta;
}

export function listSaves(): SaveMeta[] {
  return Object.values(readSaveIndex()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listSavesByRunId(runId: string): SaveMeta[] {
  return listSaves().filter(save => save.runId === runId);
}

export function createSave(opts: { characterName: string; gender?: string; personality: string; appearance: string; className?: string; stats?: PlayerStats; difficulty?: Difficulty }): SaveMeta {
  const runId = crypto.randomUUID();
  const saveId = `autosave_${runId}`;
  const payload = buildInitialPayload({
    saveId,
    runId,
    kind: 'autosave',
    label: '自动存档',
    ...opts,
  });
  const meta = createMetaFromPayload(payload, {
    kind: 'autosave',
    label: '自动存档',
  });

  const index = readSaveIndex();
  index[saveId] = meta;
  writePayload(payload);
  writeSaveIndex(index);
  setActiveRunId(runId);
  setActiveSaveId(saveId);
  return meta;
}

export function createManualSave(input: {
  runId: string;
  label: string;
  gameState: GameState;
  chatLog: PersistedMessage[];
  summaryStore: SummaryStore;
  memoryDB?: import('../memorydatabase/types').IslandMemoryDB;
}): SaveMeta {
  const saveId = crypto.randomUUID();
  const payload: SavePayload = {
    saveId,
    runId: input.runId,
    gameState: normalizeGameState(input.gameState, input.runId),
    chatLog: normalizePersistedMessages(input.chatLog),
    summaryStore: cloneJson(input.summaryStore),
    memoryDB: input.memoryDB ? cloneJson(input.memoryDB) : undefined,
    version: SAVE_VERSION,
  };
  const index = readSaveIndex();
  const meta = createMetaFromPayload(payload, {
    kind: 'manual',
    label: input.label,
  });
  index[saveId] = meta;
  writePayload(payload);
  writeSaveIndex(index);
  setActiveSaveId(saveId);
  return meta;
}

export function loadSave(saveId: string): { meta: SaveMeta; payload: SavePayload } | null {
  const meta = ensureMeta(saveId);
  const payload = readPayload(saveId);
  if (!meta || !payload) return null;
  return { meta, payload };
}

export function writeSave(
  saveId: string,
  data: {
    runId: string;
    gameState: GameState;
    chatLog: PersistedMessage[];
    summaryStore: SummaryStore;
    memoryDB?: import('../memorydatabase/types').IslandMemoryDB;
    kind?: SaveKind;
    label?: string;
  },
): SaveMeta | null {
  const index = readSaveIndex();
  const existing = index[saveId];
  const kind = data.kind ?? existing?.kind ?? (saveId.startsWith('autosave_') ? 'autosave' : 'manual');
  const label = data.label ?? existing?.label ?? (kind === 'autosave' ? '自动存档' : '手动存档');

  const payload: SavePayload = {
    saveId,
    runId: data.runId,
    gameState: normalizeGameState(data.gameState, data.runId),
    chatLog: normalizePersistedMessages(data.chatLog),
    summaryStore: cloneJson(data.summaryStore),
    memoryDB: data.memoryDB ? cloneJson(data.memoryDB) : undefined,
    version: SAVE_VERSION,
  };

  const nextMeta = createMetaFromPayload(payload, {
    kind,
    label,
    createdAt: existing?.createdAt,
  });

  index[saveId] = {
    ...existing,
    ...nextMeta,
  };
  writePayload(payload);
  writeSaveIndex(index);
  return index[saveId];
}

export function writeAutosave(data: {
  runId: string;
  gameState: GameState;
  chatLog: PersistedMessage[];
  summaryStore: SummaryStore;
  memoryDB?: import('../memorydatabase/types').IslandMemoryDB;
}): SaveMeta | null {
  const saveId = `autosave_${data.runId}`;
  return writeSave(saveId, {
    ...data,
    kind: 'autosave',
    label: '自动存档',
  });
}

export function deleteSave(saveId: string): void {
  const index = readSaveIndex();
  delete index[saveId];
  writeSaveIndex(index);
  safeRemove(getPayloadStorageKey(saveId));
  if (getActiveSaveId() === saveId) {
    clearActiveSaveId();
  }
}

export function getActiveRunId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_RUN_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveRunId(runId: string | null): void {
  if (runId) {
    try {
      localStorage.setItem(ACTIVE_RUN_ID_STORAGE_KEY, runId);
    } catch {
      /* 忽略 */
    }
    return;
  }
  safeRemove(ACTIVE_RUN_ID_STORAGE_KEY);
}

export function getActiveSaveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SAVE_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveSaveId(saveId: string | null): void {
  if (saveId) {
    try {
      localStorage.setItem(ACTIVE_SAVE_ID_STORAGE_KEY, saveId);
    } catch {
      /* 忽略 */
    }
    return;
  }
  safeRemove(ACTIVE_SAVE_ID_STORAGE_KEY);
}

export function clearActiveSaveId(): void {
  setActiveSaveId(null);
}
