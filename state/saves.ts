import type { SummaryStore } from '../summary/types';
import { createDefaultSummaryStore } from '../summary/types';
import { extractContextReply, isFrontendHtmlShell } from '../message-format';
import type {
  Difficulty,
  GameState,
  ImageRerollContext,
  PersistedMessage,
  PlayerProfile,
  PlayerStats,
  RollbackSnapshot,
  SaveKind,
  SaveMeta,
  SavePayload,
  SaveTargetMeta,
  StatusData,
} from '../types';
import { normalizeDrawingSettings, normalizePhoneMessageStore } from './store';
import { affinityStage, defaultStatusData, normalizeStatusData, obsessionStage } from '../variables/normalize';
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

function normalizeImageRerollContext(context?: ImageRerollContext): ImageRerollContext | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const normalized: ImageRerollContext = {};
  const assignString = (key: keyof ImageRerollContext) => {
    const value = context[key];
    if (typeof value === 'string' && value.trim()) normalized[key] = value;
  };
  assignString('prompt');
  assignString('change');
  assignString('sceneText');
  assignString('rawText');
  assignString('generationContext');
  assignString('generationWorldBook');
  assignString('userInput');
  return Object.keys(normalized).length ? normalized : undefined;
}

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
const PROFILE_KEYS = {
  role: ['gen', 'der'].join('') as keyof PlayerProfile,
};
const PROFILE_DEFAULTS = {
  role: String.fromCharCode(0x7500 + 55),
};

function applyProfileDefaults<T extends Record<string, unknown>>(profile: T): T {
  return {
    ...profile,
    [PROFILE_KEYS.role]: PROFILE_DEFAULTS.role,
  };
}

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

export function normalizePlayerProfile(input: unknown): PlayerProfile {
  const raw = typeof input === 'object' && input ? (input as Partial<PlayerProfile>) : {};

  // 旧存档兼容：如果没有 familyName/givenName，从 name 自动拆分
  let familyName = raw.familyName ? String(raw.familyName) : '';
  let givenName = raw.givenName ? String(raw.givenName) : '';
  const name = String(raw.name ?? '');

  if (!familyName || !givenName) {
    // 自动拆分逻辑
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (normalized) {
      const parts = normalized.split(' ').filter(Boolean);
      if (parts.length >= 2) {
        // 有空格：第一部分是姓
        familyName = parts[0];
        givenName = parts.slice(1).join(' ');
      } else {
        // 无空格：中文姓名拆分
        const compact = normalized.replace(/[・·]/g, '');
        if (/^[一-鿿]{2,4}$/.test(compact)) {
          const familyLength = compact.length >= 4 ? 2 : 1;
          familyName = compact.slice(0, familyLength);
          givenName = compact.slice(familyLength) || compact;
        } else {
          // 其他情况：全名作为姓和名
          familyName = normalized;
          givenName = normalized;
        }
      }
    }
  }

  // name 字段自动拼接
  const fullName = familyName + givenName;

  return applyProfileDefaults({
    name: fullName,
    familyName,
    givenName,
    personality: String(raw.personality ?? ''),
    appearance: String(raw.appearance ?? ''),
    className: raw.className ? String(raw.className) : '2年A班',
    stats: normalizeStats(raw.stats),
    difficulty: normalizeDifficulty(raw.difficulty),
  });
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

function isStatusDataLike(input: unknown): input is Partial<StatusData> {
  if (!input || typeof input !== 'object') return false;
  const raw = input as Record<string, unknown>;
  return Boolean(raw.world || raw.targets || raw.player);
}

function normalizePersistedStatusSnapshot(input: unknown): RollbackSnapshot | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (isStatusDataLike(input)) {
    return { statusData: normalizeStatusData(input) };
  }

  const raw = input as Partial<RollbackSnapshot>;
  return {
    statusData: normalizeStatusData(raw.statusData ?? defaultStatusData),
    ...(raw.playerProfile ? { playerProfile: normalizePlayerProfile(raw.playerProfile) } : {}),
    ...(raw.drawingSettings ? { drawingSettings: normalizeDrawingSettings(raw.drawingSettings) } : {}),
  };
}

function hasHeavyPersistedStatusSnapshot(input: unknown): boolean {
  if (!input || typeof input !== 'object' || isStatusDataLike(input)) return false;
  const raw = input as Partial<RollbackSnapshot>;
  return Boolean(raw.phoneMessages || raw.summaryStore || raw.memoryDB);
}

function shouldCompactPersistedMessages(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(message => hasHeavyPersistedStatusSnapshot((message as Partial<PersistedMessage> | null)?.statusSnapshot));
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
    .map(message => {
      const statusSnapshot = normalizePersistedStatusSnapshot(message.statusSnapshot);
      return {
        role: message.role,
        speaker: String(message.speaker || (message.role === 'assistant' ? 'Assistant' : 'User')),
        text: String(message.text ?? ''),
        ...(message.rawText ? { rawText: String(message.rawText) } : {}),
        ...(Array.isArray(message.illustrations) && message.illustrations.length
          ? {
              illustrations: message.illustrations
                .map(illustration => ({
                  id: String(illustration.id || crypto.randomUUID()),
                  imageData: String(illustration.imageData || ''),
                  prompt: illustration.prompt ? String(illustration.prompt) : undefined,
                  anchorIndex: Number.isFinite(Number(illustration.anchorIndex))
                    ? Math.max(0, Math.floor(Number(illustration.anchorIndex)))
                    : undefined,
                  rerollContext: normalizeImageRerollContext(illustration.rerollContext),
                  createdAt: Number(illustration.createdAt) || Date.now(),
                }))
                .filter(illustration => illustration.imageData),
            }
          : {}),
        ...(statusSnapshot ? { statusSnapshot } : {}),
      };
    });
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

function normalizeTargetIdentity(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[·・\s　._-]/g, '');
}

function getBuiltInTargetKeyFromStatusTarget(target: Partial<SavePayload['gameState']['statusData']['targets'][number]>) {
  const identityHaystack = [target.id, target.name, target.meta?.worldbookEntryName]
    .map(normalizeTargetIdentity)
    .join('\n');
  const haystack = [identityHaystack, target.alias].map(normalizeTargetIdentity).join('\n');
  if (/泽村小百合|澤村小百合|小百合|sayuri/.test(identityHaystack)) return 'sayuri';
  if (/町田苑子|町田|苑子|まちだそのこ|sonoko|machida/.test(haystack)) return 'sonoko';
  if (/加藤|惠|恵|megumi|katou|kato/.test(haystack)) return 'megumi';
  if (/英梨梨|英梨々|泽村|澤村|eriri|sawamura/.test(haystack)) return 'eriri';
  if (/霞之丘|霞ヶ丘|诗羽|詩羽|霞诗子|utaha|kasumigaoka/.test(haystack)) return 'utaha';
  if (/波岛|波島|出海|izumi|hashima/.test(haystack)) return 'izumi';
  if (/冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(haystack)) return 'michiru';
  if (/高坂茜|红坂朱音|紅坂朱音|高坂|红坂|紅坂|朱音|茜|akane|kosaka|kousaka|kurenai/.test(identityHaystack)) return 'akane';
  return '';
}

function getTargetRecoveryKeys(target: SavePayload['gameState']['statusData']['targets'][number]) {
  return [
    `id:${normalizeTargetIdentity(target.id)}`,
    `name:${normalizeTargetIdentity(target.name)}`,
    `wb:${normalizeTargetIdentity(target.meta?.worldbookEntryName)}`,
    `built:${getBuiltInTargetKeyFromStatusTarget(target)}`,
  ].filter(key => !key.endsWith(':'));
}

function buildPreviousTargetRecoveryMap(previousStatusData: StatusData) {
  const map = new Map<string, StatusData['targets'][number]>();
  for (const target of previousStatusData.targets) {
    for (const key of getTargetRecoveryKeys(target)) {
      if (!map.has(key)) map.set(key, target);
    }
  }
  return map;
}

function getObsessionSpikeLimit(targetKey: string) {
  if (targetKey === 'megumi') return 8;
  if (targetKey === 'michiru') return 12;
  if (targetKey === 'izumi') return 15;
  if (targetKey === 'utaha' || targetKey === 'eriri') return 18;
  return 0;
}

function shouldRecoverAffinityReset(previous: number, next: number) {
  return previous >= 10 && next === 0;
}

function shouldRecoverObsessionSpike(targetKey: string, previous: number, next: number) {
  const spikeLimit = getObsessionSpikeLimit(targetKey);
  if (!spikeLimit) return false;
  return next > previous && next - previous > spikeLimit;
}

function protectStatusDataAgainstPayloadCorruption(
  nextStatusData: StatusData,
  previousStatusData: StatusData | null,
): StatusData {
  if (!previousStatusData?.targets?.length || !nextStatusData.targets.length) return nextStatusData;

  const previousTargets = buildPreviousTargetRecoveryMap(previousStatusData);
  let recovered = false;
  const targets = nextStatusData.targets.map(target => {
    const previous = getTargetRecoveryKeys(target)
      .map(key => previousTargets.get(key))
      .find(Boolean);
    if (!previous) return target;

    const nextTarget = { ...target };
    const targetKey = getBuiltInTargetKeyFromStatusTarget(target);
    if (shouldRecoverAffinityReset(Number(previous.affinity ?? 0), Number(target.affinity ?? 0))) {
      nextTarget.affinity = previous.affinity;
      nextTarget.stage = previous.stage || affinityStage(previous.affinity);
      recovered = true;
    }
    if (shouldRecoverObsessionSpike(targetKey, Number(previous.obsession ?? 0), Number(target.obsession ?? 0))) {
      nextTarget.obsession = previous.obsession;
      nextTarget.obsessionStage = previous.obsessionStage || obsessionStage(previous.obsession);
      recovered = true;
    }
    return nextTarget;
  });

  if (!recovered) return nextStatusData;
  console.warn('[save-guard] recovered corrupted target relationship values from previous payload snapshot');
  return {
    ...nextStatusData,
    targets,
  };
}

function readPreviousPayloadStatusData(saveId: string): StatusData | null {
  const previousPayload = readPayloadSync(saveId) as unknown as Partial<SavePayload> | null;
  if (!previousPayload?.gameState) return null;
  const runId = String(previousPayload.runId || previousPayload.gameState.runId || saveId);
  return normalizeGameState(previousPayload.gameState, runId).statusData;
}

function protectPayloadAgainstPreviousPayloadCorruption(saveId: string, payload: SavePayload): SavePayload {
  const previousStatusData = readPreviousPayloadStatusData(saveId);
  if (!previousStatusData) return payload;
  const statusData = protectStatusDataAgainstPayloadCorruption(payload.gameState.statusData, previousStatusData);
  if (statusData === payload.gameState.statusData) return payload;
  return {
    ...payload,
    gameState: {
      ...payload.gameState,
      statusData,
    },
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
  const chatLog = normalizePersistedMessages(payload.chatLog);

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
  if (
    JSON.stringify(rawSummaryStore) !== JSON.stringify(summaryStore) ||
    !payload.memoryDB ||
    sweepHadEffect ||
    shouldCompactPersistedMessages(payload.chatLog)
  ) {
    writePayloadSync(saveId, {
      ...payload,
      chatLog,
      summaryStore,
      memoryDB,
    } as unknown as Record<string, unknown>);
  }

  return {
    saveId: String(payload.saveId || saveId),
    runId,
    gameState: normalizeGameState(payload.gameState, runId),
    chatLog,
    summaryStore,
    memoryDB,
    messageSnapshots: Array.isArray(payload.messageSnapshots) ? cloneJson(payload.messageSnapshots) : undefined,
    version: Number(payload.version ?? SAVE_VERSION) || SAVE_VERSION,
  };
}

function buildInitialPayload(opts: {
  saveId: string;
  runId: string;
  familyName: string;
  givenName: string;
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
  const characterName = opts.familyName + opts.givenName;

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
          name: characterName,
          familyName: opts.familyName,
          givenName: opts.givenName,
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
  familyName: string;
  givenName: string;
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

  const rawPayload: SavePayload = {
    saveId,
    runId: data.runId,
    gameState: normalizeGameState(data.gameState, data.runId),
    chatLog: normalizePersistedMessages(data.chatLog),
    summaryStore: cloneJson(data.summaryStore),
    memoryDB: data.memoryDB ? cloneJson(data.memoryDB) : undefined,
    version: SAVE_VERSION,
  };
  const payload = protectPayloadAgainstPreviousPayloadCorruption(saveId, rawPayload);

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

function appendJsonField(parts: string[], key: string, value: unknown, hasPreviousField: boolean): boolean {
  if (hasPreviousField) parts.push(',');
  parts.push(JSON.stringify(key), ':', JSON.stringify(value));
  return true;
}

function appendChatLogJson(parts: string[], messages: PersistedMessage[]): void {
  parts.push('[');
  messages.forEach((message, index) => {
    if (index > 0) parts.push(',');
    parts.push(JSON.stringify(message));
  });
  parts.push(']');
}

function appendSavePayloadJson(parts: string[], payload: SavePayload): void {
  parts.push('{');
  let hasField = false;
  hasField = appendJsonField(parts, 'saveId', payload.saveId, hasField);
  hasField = appendJsonField(parts, 'runId', payload.runId, hasField);
  hasField = appendJsonField(parts, 'gameState', payload.gameState, hasField);
  if (hasField) parts.push(',');
  parts.push(JSON.stringify('chatLog'), ':');
  appendChatLogJson(parts, payload.chatLog);
  hasField = true;
  hasField = appendJsonField(parts, 'summaryStore', payload.summaryStore, hasField);
  if (payload.memoryDB) hasField = appendJsonField(parts, 'memoryDB', payload.memoryDB, hasField);
  if (Array.isArray(payload.messageSnapshots)) {
    hasField = appendJsonField(parts, 'messageSnapshots', payload.messageSnapshots, hasField);
  }
  appendJsonField(parts, 'version', payload.version, hasField);
  parts.push('}');
}

function appendEntryPrefix(parts: string[], key: string, hasPreviousEntry: boolean): boolean {
  if (hasPreviousEntry) parts.push(',');
  parts.push(JSON.stringify(key), ':');
  return true;
}

export function exportAllSavesAsJsonParts(): string[] {
  const parts: string[] = ['{'];
  let hasField = false;
  const index = readSaveIndex();

  hasField = appendJsonField(parts, 'version', SAVE_VERSION, hasField);
  hasField = appendJsonField(parts, 'exportedAt', new Date().toISOString(), hasField);
  if (hasField) parts.push(',');
  parts.push(JSON.stringify('entries'), ':{');

  let hasEntry = false;
  hasEntry = appendEntryPrefix(parts, SAVE_INDEX_STORAGE_KEY, hasEntry);
  parts.push(JSON.stringify(cloneJson(index)));

  for (const saveId of Object.keys(index)) {
    const payload = readPayload(saveId);
    if (!payload) continue;
    hasEntry = appendEntryPrefix(parts, getPayloadStorageKey(saveId), hasEntry);
    appendSavePayloadJson(parts, payload);
  }

  for (const key of [ACTIVE_RUN_ID_STORAGE_KEY, ACTIVE_SAVE_ID_STORAGE_KEY]) {
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    hasEntry = appendEntryPrefix(parts, key, hasEntry);
    parts.push(JSON.stringify(raw));
  }

  parts.push('}}');
  return parts;
}

export function exportAllSavesAsJson(): string {
  return exportAllSavesAsJsonParts().join('');
}

export function exportSaveAsJsonParts(saveId: string): string[] {
  const meta = ensureMeta(saveId);
  const payload = readPayload(saveId);
  if (!meta || !payload) {
    throw new Error('Current save does not exist, so it cannot be exported.');
  }

  const parts: string[] = ['{'];
  let hasField = false;
  hasField = appendJsonField(parts, 'version', SAVE_VERSION, hasField);
  hasField = appendJsonField(parts, 'exportedAt', new Date().toISOString(), hasField);
  hasField = appendJsonField(parts, 'kind', 'single-save', hasField);
  hasField = appendJsonField(parts, 'saveId', saveId, hasField);
  hasField = appendJsonField(parts, 'meta', cloneJson(meta), hasField);
  if (hasField) parts.push(',');
  parts.push(JSON.stringify('payload'), ':');
  appendSavePayloadJson(parts, payload);
  parts.push('}');
  return parts;
}

export function exportSaveAsJson(saveId: string): string {
  return exportSaveAsJsonParts(saveId).join('');
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
