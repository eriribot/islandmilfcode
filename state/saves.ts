import type { SummaryStore } from '../summary/types';
import { createDefaultSummaryStore } from '../summary/types';
import type { GameState, PersistedMessage, PlayerProfile, SaveKind, SaveMeta, SavePayload, StatusData } from '../types';
import { getActiveTarget } from '../types';
import { defaultStatusData, normalizeStatusData } from '../variables/normalize';

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

function normalizePlayerProfile(input: unknown): PlayerProfile {
  const raw = typeof input === 'object' && input ? (input as Partial<PlayerProfile>) : {};
  return {
    name: String(raw.name ?? ''),
    personality: String(raw.personality ?? ''),
    appearance: String(raw.appearance ?? ''),
  };
}

function getPlayerProfileFromGameState(gameState: Partial<GameState> | undefined): PlayerProfile {
  return normalizePlayerProfile(gameState?.runtimeFlags?.playerProfile);
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
    /* ignore quota errors */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
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
      ...(message.statusSnapshot ? { statusSnapshot: cloneJson(message.statusSnapshot) } : {}),
    }));
}

function normalizeGameState(gameState: Partial<GameState> | undefined, fallbackRunId: string): GameState {
  const runtimeFlags = gameState?.runtimeFlags ? cloneJson(gameState.runtimeFlags) : undefined;
  if (runtimeFlags && typeof runtimeFlags === 'object') {
    runtimeFlags.playerProfile = normalizePlayerProfile((runtimeFlags as Record<string, unknown>).playerProfile);
  }
  return {
    runId: String(gameState?.runId || fallbackRunId),
    statusData: normalizeStatusData(gameState?.statusData ?? defaultStatusData),
    currentMessageIndex: Math.max(0, Number(gameState?.currentMessageIndex ?? 0) || 0),
    worldState: gameState?.worldState ? cloneJson(gameState.worldState) : undefined,
    runtimeFlags,
  };
}

function createMetaFromPayload(payload: SavePayload, input: { kind: SaveKind; label: string; createdAt?: number }): SaveMeta {
  const statusData = payload.gameState.statusData;
  const activeTarget = getActiveTarget(statusData);
  const playerProfile = getPlayerProfileFromGameState(payload.gameState);
  const messageCount = payload.chatLog.length;
  const latestPreview = payload.chatLog.length ? payload.chatLog[payload.chatLog.length - 1]?.text?.trim() : '';
  const now = Date.now();

  return {
    saveId: payload.saveId,
    runId: payload.runId,
    kind: input.kind,
    label: input.label,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    messageIndex: payload.gameState.currentMessageIndex,
    characterName: playerProfile.name || activeTarget?.name || '未命名角色',
    personality: playerProfile.personality || activeTarget?.stage || '',
    appearance: playerProfile.appearance || activeTarget?.alias || '',
    location: statusData.world.currentLocation,
    gameTime: statusData.world.currentTime,
    preview: latestPreview ? latestPreview.slice(0, 80) : '',
    messageCount,
    version: SAVE_VERSION,
  };
}

function readSaveIndex(): SaveIndexRecord {
  migrateLegacySavesIfNeeded();
  return safeReadJson<SaveIndexRecord>(SAVE_INDEX_STORAGE_KEY, {});
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

  return {
    saveId: String(payload.saveId || saveId),
    runId,
    gameState: normalizeGameState(payload.gameState, runId),
    chatLog: normalizePersistedMessages(payload.chatLog),
    summaryStore: cloneJson(payload.summaryStore ?? createDefaultSummaryStore()),
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
          personality: opts.personality,
          appearance: opts.appearance,
        }),
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

function migrateLegacySavesIfNeeded(): void {
  const existingIndex = safeReadJson<SaveIndexRecord>(SAVE_INDEX_STORAGE_KEY, {});
  const legacy = safeReadJson<Record<string, LegacySaveSlot>>(LEGACY_SAVES_STORAGE_KEY, {});
  if (!Object.keys(legacy).length) return;

  const nextIndex = { ...existingIndex };
  for (const legacySave of Object.values(legacy)) {
    if (!legacySave?.id || nextIndex[legacySave.id]) continue;
    const runId = crypto.randomUUID();
    const payload: SavePayload = {
      saveId: legacySave.id,
      runId,
      gameState: {
        runId,
        statusData: normalizeStatusData(legacySave.statusData ?? defaultStatusData),
        currentMessageIndex: Math.max(0, (legacySave.messages?.length ?? 0) - 1),
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
      characterName: legacySave.characterName || '未命名角色',
      personality: legacySave.personality || '',
      appearance: legacySave.appearance || '',
    };
  }

  writeSaveIndex(nextIndex);
  safeRemove(LEGACY_SAVES_STORAGE_KEY);
}

export function listSaves(): SaveMeta[] {
  return Object.values(readSaveIndex()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listSavesByRunId(runId: string): SaveMeta[] {
  return listSaves().filter(save => save.runId === runId);
}

export function createSave(opts: { characterName: string; personality: string; appearance: string }): SaveMeta {
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
  meta.characterName = opts.characterName;
  meta.personality = opts.personality;
  meta.appearance = opts.appearance;

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
}): SaveMeta {
  const saveId = crypto.randomUUID();
  const payload: SavePayload = {
    saveId,
    runId: input.runId,
    gameState: normalizeGameState(input.gameState, input.runId),
    chatLog: normalizePersistedMessages(input.chatLog),
    summaryStore: cloneJson(input.summaryStore),
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
      /* ignore */
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
      /* ignore */
    }
    return;
  }
  safeRemove(ACTIVE_SAVE_ID_STORAGE_KEY);
}

export function clearActiveSaveId(): void {
  setActiveSaveId(null);
}
