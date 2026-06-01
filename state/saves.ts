import type { SummaryStore } from '../summary/types';
import { createDefaultSummaryStore } from '../summary/types';
import { extractContextReply, isFrontendHtmlShell } from '../message-format';
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
import { migrateSummaryStoreToMemoryDB, hydrateSummaryStoreFromMemoryDB } from '../memorydatabase/migrate';
import { sweepLegacyMemoryDB } from '../memorydatabase/sweep';
import {
  deletePayloadSync,
  readPayloadSync,
  readSaveIndexSync,
  writePayloadSync,
  writeSaveIndexSync,
} from './save-store';

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
    ? (statusData.targets.find(item => item.id === statusData.activeTargetId) ?? null)
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
  } catch (err) {
    // payload/index 已迁到 IndexedDB；localStorage 现在只承载 active-id 等极小 key。
    // 如果连这点都写不进去，多半 quota/隐私模式真有问题，把错暴出来。
    console.error('[saves] localStorage.setItem failed:', key, err);
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
    .filter(
      message =>
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        !isFrontendHtmlShell(String(message.rawText || message.text || '')),
    )
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

function createMetaFromPayload(
  payload: SavePayload,
  input: { kind: SaveKind; label: string; createdAt?: number },
): SaveMeta {
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
  const rawIndex = readSaveIndexSync() as unknown as SaveIndexRecord;
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
  writeSaveIndexSync(index as unknown as Record<string, unknown>);
}

function writePayload(payload: SavePayload): void {
  writePayloadSync(payload.saveId, payload as unknown as Record<string, unknown>);
}

function readPayload(saveId: string): SavePayload | null {
  const payload = readPayloadSync(saveId) as unknown as SavePayload | null;
  if (!payload || typeof payload !== 'object') return null;

  const runId = String(payload.runId || payload.gameState?.runId || '');
  if (!runId) return null;

  const rawSummaryStore = cloneJson(payload.summaryStore ?? createDefaultSummaryStore());

  // memoryDB：优先从存档读取，没有则从 summaryStore 迁移
  const memoryDB = normalizeMemoryDB(payload.memoryDB, runId) ?? migrateSummaryStoreToMemoryDB(rawSummaryStore, runId);

  // 一次性 sweep：旧 schema 残留（流水账 attributes、伪 worldState 行）的清洗。幂等。
  const sweepStats = sweepLegacyMemoryDB(memoryDB);
  const sweepHadEffect =
    sweepStats.worldRowsMigrated > 0
    || sweepStats.duplicatesCollapsed > 0
    || sweepStats.deltaRowsFolded > 0;

  // 从 memoryDB 把摘要/事实水合回 summaryStore，让旧消费方（buildPrompt / UI）继续工作。
  // 这一步是为了修复存档加载后摘要丢失、全部历史被塞进 prompt 的问题。
  const hydrated = hydrateSummaryStoreFromMemoryDB(memoryDB);

  const summaryStore = {
    ...createDefaultSummaryStore(),
    ...hydrated,
    lastSummarizedIndex: Math.max(
      Number(rawSummaryStore.lastSummarizedIndex ?? 0) || 0,
      Number(memoryDB.lastProcessedIndex ?? 0) || 0,
    ),
    consecutiveFailures: Math.max(0, Number(rawSummaryStore.consecutiveFailures ?? 0) || 0),
    autoPaused: Boolean(rawSummaryStore.autoPaused),
    lastError: rawSummaryStore.lastError ?? null,
  };
  // 中文注释：summaryStore 已经被收敛成空壳（只保留 cursor + 失败状态），这是 migration 幂等性的根本保障；
  // 不再硬删 facts/summaries 里 source='migration' 的行 —— 迁移过来的 keyFacts 是真实数据，不应该每次读存档就被抹掉。
  if (JSON.stringify(rawSummaryStore) !== JSON.stringify(summaryStore) || !payload.memoryDB || sweepHadEffect) {
    safeWriteJson(getPayloadStorageKey(saveId), {
      ...payload,
      summaryStore,
      memoryDB,
    });
  }

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

export function getAutosaveBranchSaveId(input: { activeSaveId?: string | null; runId: string }): string {
  const activeSaveId = input.activeSaveId?.trim();
  if (!activeSaveId) return `autosave_${input.runId}`;
  return activeSaveId.startsWith('autosave_') ? activeSaveId : `autosave_${activeSaveId}`;
}

export function createSave(opts: {
  characterName: string;
  gender?: string;
  personality: string;
  appearance: string;
  className?: string;
  stats?: PlayerStats;
  difficulty?: Difficulty;
}): SaveMeta {
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
}, saveId = getAutosaveBranchSaveId({ runId: data.runId })): SaveMeta | null {
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
  deletePayloadSync(saveId);
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

// ── 全量导出/导入：把所有 islandmilfcode:* localStorage 打包为 JSON 备份 ──
// 用途：跨电脑迁移；恢复被 markLegacyMigrationRowsInactive 误删的旧 keyFacts/摘要。
// 只动 islandmilfcode: 前缀的键，不碰其它应用的 storage。

export type SaveBackupPayload = {
  version: number;
  exportedAt: string;
  entries: Record<string, unknown>;
};

export type SingleSaveBackupPayload = {
  version: number;
  exportedAt: string;
  kind: 'single-save';
  saveId: string;
  meta: SaveMeta;
  payload: SavePayload;
};

const BACKUP_KEY_PREFIX = 'islandmilfcode:';

export function exportAllSavesAsJson(): string {
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(BACKUP_KEY_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    try {
      entries[key] = JSON.parse(raw);
    } catch {
      // 不是 JSON 的就原样保留字符串，导入时再原样写回。
      entries[key] = raw;
    }
  }
  const backup: SaveBackupPayload = {
    version: SAVE_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
  };
  return JSON.stringify(backup, null, 2);
}

export function exportSaveAsJson(saveId: string): string {
  const meta = ensureMeta(saveId);
  const payload = readPayload(saveId);
  if (!meta || !payload) {
    throw new Error('当前存档不存在，无法导出。');
  }
  const backup: SingleSaveBackupPayload = {
    version: SAVE_VERSION,
    exportedAt: new Date().toISOString(),
    kind: 'single-save',
    saveId,
    meta: cloneJson(meta),
    payload: cloneJson(payload),
  };
  return JSON.stringify(backup, null, 2);
}

function importSingleSaveBackup(parsed: Partial<SingleSaveBackupPayload>): { imported: number; skipped: number; saveId: string } {
  const rawPayload = parsed.payload as Partial<SavePayload> | undefined;
  const rawMeta = parsed.meta as Partial<SaveMeta> | undefined;
  const saveId = String(parsed.saveId || rawPayload?.saveId || rawMeta?.saveId || '').trim();
  const runId = String(rawPayload?.runId || rawPayload?.gameState?.runId || rawMeta?.runId || '').trim();
  if (!saveId || !runId || !rawPayload) {
    throw new Error('备份文件格式不正确：缺少单个存档数据。');
  }

  const payload: SavePayload = {
    saveId,
    runId,
    gameState: normalizeGameState(rawPayload.gameState, runId),
    chatLog: normalizePersistedMessages(rawPayload.chatLog),
    summaryStore: cloneJson(rawPayload.summaryStore ?? createDefaultSummaryStore()),
    memoryDB: rawPayload.memoryDB ? cloneJson(rawPayload.memoryDB) : undefined,
    messageSnapshots: Array.isArray(rawPayload.messageSnapshots) ? cloneJson(rawPayload.messageSnapshots) : undefined,
    version: Number(rawPayload.version ?? SAVE_VERSION) || SAVE_VERSION,
  };
  const baseMeta = createMetaFromPayload(payload, {
    kind: rawMeta?.kind === 'manual' || rawMeta?.kind === 'autosave' ? rawMeta.kind : 'manual',
    label: rawMeta?.label ? String(rawMeta.label) : '导入存档',
    createdAt: Number(rawMeta?.createdAt ?? Date.now()) || Date.now(),
  });
  const meta: SaveMeta = normalizeSaveMeta({
    ...baseMeta,
    ...rawMeta,
    saveId,
    runId,
    updatedAt: Number(rawMeta?.updatedAt ?? baseMeta.updatedAt) || baseMeta.updatedAt,
    version: Number(rawMeta?.version ?? SAVE_VERSION) || SAVE_VERSION,
  });

  const index = readSaveIndex();
  index[saveId] = meta;
  writePayload(payload);
  writeSaveIndex(index);
  // 导入后自动切换到该存档，确保刷新后加载的是导入的存档而非旧的。
  setActiveSaveId(saveId);
  setActiveRunId(runId);
  return { imported: 1, skipped: 0, saveId };
}

export function importAllSavesFromJson(json: string): { imported: number; skipped: number } {
  const parsed = JSON.parse(json) as Partial<SaveBackupPayload>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('备份文件格式不正确。');
  }
  if ((parsed as Partial<SingleSaveBackupPayload>).kind === 'single-save') {
    return importSingleSaveBackup(parsed as Partial<SingleSaveBackupPayload>);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error('备份文件格式不正确：缺少 entries 字段。');
  }
  let imported = 0;
  let skipped = 0;

  // 全量备份的 entries 使用旧 localStorage key 格式。
  // 现在存储已迁移到 IndexedDB，需要把 index/payload 写入 save-store 而非 localStorage。
  let importedIndex: SaveIndexRecord | null = null;
  const indexKey = SAVE_INDEX_STORAGE_KEY; // 'islandmilfcode:save-index:v2'
  const payloadPrefix = SAVE_PAYLOAD_STORAGE_PREFIX; // 'islandmilfcode:save-payload:v2:'

  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!key.startsWith(BACKUP_KEY_PREFIX)) {
      skipped += 1;
      continue;
    }
    try {
      if (key === indexKey) {
        // save index → 写入 IndexedDB
        const indexData = (typeof value === 'object' && value !== null ? value : JSON.parse(value as string)) as SaveIndexRecord;
        // 合并到现有 index（覆盖同名 saveId）
        const currentIndex = readSaveIndex();
        importedIndex = { ...currentIndex, ...indexData };
        writeSaveIndex(importedIndex);
        imported += 1;
      } else if (key.startsWith(payloadPrefix)) {
        // save payload → 写入 IndexedDB
        const saveId = key.slice(payloadPrefix.length);
        const payloadData = (typeof value === 'object' && value !== null ? value : JSON.parse(value as string)) as Record<string, unknown>;
        writePayloadSync(saveId, payloadData);
        imported += 1;
      } else {
        // 其它 islandmilfcode: 前缀的小 key（如 active-run-id 等）仍写 localStorage
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(key, text);
        imported += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  // 如果导入了 index，自动切换到最新的存档
  if (importedIndex) {
    const saves = Object.values(importedIndex).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (saves.length > 0 && saves[0].saveId) {
      setActiveSaveId(saves[0].saveId);
      if (saves[0].runId) setActiveRunId(saves[0].runId);
    }
  }

  return { imported, skipped };
}
