import type { GameDevelopmentState } from '../game-development/types';
import type { IslandMemoryDB } from '../memorydatabase/types';
import type { SummaryStore } from '../summary/types';
import type {
  DrawingSettings,
  FloorPhoneStateSnapshot,
  FloorRecord,
  FloorRuntimeSnapshot,
  FloorSnapshotFieldSource,
  FloorStateSnapshot,
  GameState,
  PersistedAssistantMessage,
  PersistedMessage,
  PersistedUserMessage,
  PhoneMessageStore,
  PlayerProfile,
  StatusData,
} from '../types';
import { defaultStatusData } from '../variables/normalize';
import { SAVE_DATA_SCHEMA_VERSION, canUseLegacyAggregateSaveCodec } from '../version';
import { parseHostMessageLocator } from './host-timeline-adapter';
import {
  cloneJsonValue,
  isRecord,
  projectLegacyRuntimeFlags,
  splitLegacyExtras,
  type LegacyRuntimeProjection,
} from './save-codecs';

const PAYLOAD_KEYS = [
  'saveId',
  'runId',
  'gameState',
  'chatLog',
  'summaryStore',
  'memoryDB',
  'messageSnapshots',
  'version',
] as const;
const GAME_STATE_KEYS = ['runId', 'statusData', 'currentMessageIndex', 'worldState', 'runtimeFlags'] as const;
const MESSAGE_KEYS = [
  'id',
  'role',
  'speaker',
  'text',
  'rawText',
  'illustrations',
  'statusSnapshot',
  'hostLocator',
] as const;
const SNAPSHOT_KEYS = [
  'statusData',
  'gameDevelopment',
  'playerProfile',
  'drawingSettings',
  'phoneMessages',
  'summaryStore',
  'memoryDB',
] as const;

type DecodedLegacyMessage = {
  sourceIndex: number;
  message: PersistedMessage;
  snapshot: DecodedSnapshot;
  legacyExtras: Record<string, unknown>;
  snapshotExtras: Record<string, unknown>;
};

export type LegacyAggregateSaveSource = {
  saveId: string;
  runId: string;
  version: string | number | null;
  gameState: Partial<GameState>;
  messages: DecodedLegacyMessage[];
  summaryStore?: SummaryStore;
  memoryDB?: IslandMemoryDB;
  messageSnapshots?: unknown[];
  runtimeProjection: LegacyRuntimeProjection;
  legacyExtras: {
    payload: Record<string, unknown>;
    gameState: Record<string, unknown>;
    unmappedMessages: Array<{ sourceIndex: number; value: unknown }>;
  };
};

export type LegacyMigrationIssue = {
  severity: 'warning' | 'blocking';
  code:
    | 'unmapped-message'
    | 'synthetic-user-message'
    | 'before-state-fallback'
    | 'after-state-fallback'
    | 'generation-context-unavailable'
    | 'phone-floor-unmapped';
  floorIndex?: number;
  sourceMessageIndex?: number;
  detail: string;
};

export type LegacyV2ToV3MigrationPlan = {
  saveId: string;
  runId: string;
  sourceSchemaVersion: string | number | null;
  targetSchemaVersion: typeof SAVE_DATA_SCHEMA_VERSION;
  initialRevision: 1;
  floors: FloorRecord[];
  currentState: {
    statusData: StatusData;
    playerProfile: PlayerProfile;
    phoneMessages: PhoneMessageStore;
    drawingSettings: DrawingSettings;
    runtime: FloorRuntimeSnapshot;
    worldState?: Record<string, unknown>;
  };
  summaryStore?: SummaryStore;
  memoryDB?: IslandMemoryDB;
  messageSnapshots?: unknown[];
  legacyExtras: LegacyAggregateSaveSource['legacyExtras'] & {
    runtimeFlags: Record<string, unknown>;
    runtimeAuthoritativeRawSource: Record<string, unknown>;
  };
  excludedRuntimeFlagKeys: string[];
  legacyMessageIndexToFloorIndex: Record<number, number>;
  issues: LegacyMigrationIssue[];
  readyForTransactionalPublish: boolean;
};

type DecodedSnapshot = {
  statusData?: StatusData;
  playerProfile?: PlayerProfile;
  phoneMessages?: PhoneMessageStore;
  drawingSettings?: DrawingSettings;
  runtime: FloorRuntimeSnapshot;
};

type PlannedFloorMessages = {
  user: DecodedLegacyMessage;
  assistant?: DecodedLegacyMessage;
  syntheticUserMessage: boolean;
};

function createDefaultPlayerProfile(): PlayerProfile {
  return {
    name: '',
    familyName: '',
    givenName: '',
    personality: '',
    appearance: '',
  };
}

function createDefaultDrawingSettings(): DrawingSettings {
  return {
    enabled: false,
    qualityPrompt: '',
    negativePrompt: '',
    contextMessageCount: 0,
    width: 832,
    height: 1216,
    manualPrompt: '',
    characterAnchors: [],
    systemPrompt: '',
  };
}

function createDefaultPhoneMessages(): PhoneMessageStore {
  return {
    activeThreadId: null,
    draft: '',
    generating: false,
    threads: {},
  };
}

function isStatusDataLike(value: unknown): value is StatusData {
  return isRecord(value) && (isRecord(value.world) || Array.isArray(value.targets) || isRecord(value.player));
}

function decodeRollbackSnapshot(value: unknown): DecodedSnapshot {
  if (isStatusDataLike(value)) {
    return {
      statusData: cloneJsonValue(value),
      runtime: {},
    };
  }
  if (!isRecord(value)) return { runtime: {} };

  const runtime: FloorRuntimeSnapshot = {};
  if (Object.prototype.hasOwnProperty.call(value, 'gameDevelopment')) {
    const gameDevelopment = sanitizeGameDevelopmentSnapshot(value.gameDevelopment);
    if (gameDevelopment !== undefined) runtime.gameDevelopment = gameDevelopment;
  }
  return {
    ...(isStatusDataLike(value.statusData) ? { statusData: cloneJsonValue(value.statusData) } : {}),
    ...(isRecord(value.playerProfile) ? { playerProfile: cloneJsonValue(value.playerProfile) as PlayerProfile } : {}),
    ...(isRecord(value.phoneMessages)
      ? { phoneMessages: cloneJsonValue(value.phoneMessages) as PhoneMessageStore }
      : {}),
    ...(isRecord(value.drawingSettings)
      ? { drawingSettings: cloneJsonValue(value.drawingSettings) as DrawingSettings }
      : {}),
    runtime,
  };
}

function sanitizeGameDevelopmentSnapshot(value: unknown): GameDevelopmentState | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || value.schemaVersion !== 3) return undefined;
  const snapshot = cloneJsonValue(value) as GameDevelopmentState;
  if (snapshot.pendingTurn?.status !== 'generating') return snapshot;
  return {
    ...snapshot,
    pendingTurn: {
      ...snapshot.pendingTurn,
      status: 'prepared',
      generationAttemptId: null,
      failurePhase: null,
      assistantReceipt: null,
      failureReason: null,
      completedAt: null,
    },
  } as GameDevelopmentState;
}

function decodeMessage(value: unknown, sourceIndex: number): DecodedLegacyMessage | null {
  if (!isRecord(value)) return null;
  const hostLocator = parseHostMessageLocator(value.hostLocator);
  if (value.hostLocator !== undefined && !hostLocator) {
    throw new Error(`旧存档第 ${sourceIndex + 1} 条消息的 host locator 无效。`);
  }
  if (value.role !== 'user' && value.role !== 'assistant') return null;
  const role = value.role;
  const rawSnapshot = value.statusSnapshot;
  const decodedSnapshot = decodeRollbackSnapshot(rawSnapshot);

  return {
    sourceIndex,
    message: {
      id: String(value.id || `legacy-message-${sourceIndex}`),
      role,
      speaker: String(value.speaker || (role === 'assistant' ? 'Assistant' : 'User')),
      text: String(value.text ?? ''),
      ...(typeof value.rawText === 'string' ? { rawText: value.rawText } : {}),
      ...(Array.isArray(value.illustrations) ? { illustrations: cloneJsonValue(value.illustrations) } : {}),
      ...(hostLocator ? { hostLocator } : {}),
    },
    snapshot: decodedSnapshot,
    legacyExtras: splitLegacyExtras(value, MESSAGE_KEYS),
    snapshotExtras:
      isRecord(rawSnapshot) && !isStatusDataLike(rawSnapshot) ? splitLegacyExtras(rawSnapshot, SNAPSHOT_KEYS) : {},
  };
}

function cloneMemoryDBForPersistence(input: Record<string, unknown>): IslandMemoryDB {
  const { _indexes: _derivedIndexes, ...persisted } = cloneJsonValue(input);
  return persisted as IslandMemoryDB;
}

export function decodeLegacyAggregateSaveSource(input: unknown): LegacyAggregateSaveSource {
  if (!isRecord(input)) throw new Error('旧存档 payload 不是对象。');
  if (!canUseLegacyAggregateSaveCodec(input)) {
    throw new Error('只有 v1/v2 聚合存档可以进入 v2→v3 迁移计划。');
  }
  const gameState = isRecord(input.gameState) ? input.gameState : {};
  const saveId = String(input.saveId || '').trim();
  const runId = String(input.runId || gameState.runId || '').trim();
  if (!saveId || !runId) throw new Error('旧存档缺少 saveId 或 runId。');

  const messages: DecodedLegacyMessage[] = [];
  const unmappedMessages: Array<{ sourceIndex: number; value: unknown }> = [];
  const rawMessages = Array.isArray(input.chatLog) ? input.chatLog : [];
  rawMessages.forEach((value, sourceIndex) => {
    const decoded = decodeMessage(value, sourceIndex);
    if (decoded) messages.push(decoded);
    else unmappedMessages.push({ sourceIndex, value: cloneJsonValue(value) });
  });

  return {
    saveId,
    runId,
    version: typeof input.version === 'string' || typeof input.version === 'number' ? input.version : null,
    gameState: cloneJsonValue(gameState) as Partial<GameState>,
    messages,
    ...(isRecord(input.summaryStore) ? { summaryStore: cloneJsonValue(input.summaryStore) as SummaryStore } : {}),
    ...(isRecord(input.memoryDB) ? { memoryDB: cloneMemoryDBForPersistence(input.memoryDB) } : {}),
    ...(Array.isArray(input.messageSnapshots) ? { messageSnapshots: cloneJsonValue(input.messageSnapshots) } : {}),
    runtimeProjection: projectLegacyRuntimeFlags(gameState.runtimeFlags),
    legacyExtras: {
      payload: splitLegacyExtras(input, PAYLOAD_KEYS),
      gameState: splitLegacyExtras(gameState, GAME_STATE_KEYS),
      unmappedMessages,
    },
  };
}

function asUserMessage(message: PersistedMessage): PersistedUserMessage {
  const { statusSnapshot: _statusSnapshot, ...persisted } = cloneJsonValue(message);
  return { ...persisted, role: 'user' };
}

function asAssistantMessage(message: PersistedMessage): PersistedAssistantMessage {
  const { statusSnapshot: _statusSnapshot, ...persisted } = cloneJsonValue(message);
  return { ...persisted, role: 'assistant' };
}

function createSyntheticUserMessage(assistant: DecodedLegacyMessage): DecodedLegacyMessage {
  return {
    sourceIndex: assistant.sourceIndex,
    message: {
      id: `${assistant.message.id}:synthetic-opening-user`,
      role: 'user',
      speaker: 'System',
      text: '',
    },
    snapshot: { runtime: {} },
    legacyExtras: {},
    snapshotExtras: {},
  };
}

function groupMessagesIntoFloors(messages: DecodedLegacyMessage[]): PlannedFloorMessages[] {
  const floors: PlannedFloorMessages[] = [];
  let pendingUser: DecodedLegacyMessage | null = null;

  for (const decoded of messages) {
    if (decoded.message.role === 'user') {
      if (pendingUser) floors.push({ user: pendingUser, syntheticUserMessage: false });
      pendingUser = decoded;
      continue;
    }

    if (pendingUser) {
      floors.push({ user: pendingUser, assistant: decoded, syntheticUserMessage: false });
      pendingUser = null;
      continue;
    }

    floors.push({
      user: createSyntheticUserMessage(decoded),
      assistant: decoded,
      syntheticUserMessage: true,
    });
  }

  if (pendingUser) floors.push({ user: pendingUser, syntheticUserMessage: false });
  return floors;
}

function mapLegacyMessageIndexes(floors: PlannedFloorMessages[]): Map<number, number> {
  const result = new Map<number, number>();
  floors.forEach((floor, floorIndex) => {
    result.set(floor.user.sourceIndex, floorIndex);
    if (floor.assistant) result.set(floor.assistant.sourceIndex, floorIndex);
  });
  return result;
}

function translateLegacyBoundary(boundary: unknown, indexMap: Map<number, number>): number {
  const legacyExclusiveBoundary = Math.max(0, Math.floor(Number(boundary) || 0));
  let translated = 0;
  for (const [sourceIndex, floorIndex] of indexMap) {
    if (sourceIndex < legacyExclusiveBoundary) translated = Math.max(translated, floorIndex + 1);
  }
  return translated;
}

function translatePhoneMessages(
  input: PhoneMessageStore | undefined,
  indexMap: Map<number, number>,
  issues: LegacyMigrationIssue[],
): PhoneMessageStore {
  const source = input ?? createDefaultPhoneMessages();
  const threads: PhoneMessageStore['threads'] = {};

  for (const [targetId, thread] of Object.entries(source.threads ?? {})) {
    const messages = (Array.isArray(thread.messages) ? thread.messages : []).map(message => {
      const baseMessage = {
        id: String(message.id || ''),
        role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        speaker: String(message.speaker || ''),
        text: String(message.text ?? ''),
        timestamp: String(message.timestamp || ''),
        ...(message.worldTime ? { worldTime: String(message.worldTime) } : {}),
      };
      const legacyFloorIndex = Number(message.floorIndex);
      if (!Number.isFinite(legacyFloorIndex) || legacyFloorIndex < 0) {
        return baseMessage;
      }
      const floorIndex = indexMap.get(Math.floor(legacyFloorIndex));
      if (floorIndex === undefined) {
        issues.push({
          severity: 'warning',
          code: 'phone-floor-unmapped',
          sourceMessageIndex: Math.floor(legacyFloorIndex),
          detail: `手机消息 ${message.id} 的旧 floorIndex 无法映射，已保留正文但移除错误楼层引用。`,
        });
        return baseMessage;
      }
      return {
        ...baseMessage,
        floorIndex,
      };
    });
    threads[targetId] = {
      targetId: String(thread.targetId || targetId),
      messages,
      unread: Math.max(0, Math.min(Number(thread.unread) || 0, messages.length)),
      updatedAt: Number(thread.updatedAt) || 0,
    };
  }

  return {
    activeThreadId: source.activeThreadId ?? null,
    draft: String(source.draft ?? ''),
    generating: false,
    threads,
  };
}

function createPhoneStateSnapshot(
  phoneMessages: PhoneMessageStore,
  floorIndex: number,
  position: 'before' | 'after',
  isLatestFloor: boolean,
): FloorPhoneStateSnapshot {
  const threads: FloorPhoneStateSnapshot['threads'] = {};
  for (const [targetId, thread] of Object.entries(phoneMessages.threads)) {
    const messages = thread.messages.filter(message => {
      if (typeof message.floorIndex !== 'number') return isLatestFloor;
      return position === 'before' ? message.floorIndex < floorIndex : message.floorIndex <= floorIndex;
    });
    const lastMessage = messages[messages.length - 1];
    threads[targetId] = {
      lastMessageId: lastMessage?.id ?? null,
      messageCount: messages.length,
      unread: isLatestFloor ? Math.min(thread.unread, messages.length) : 0,
    };
  }
  return {
    activeThreadId: isLatestFloor ? phoneMessages.activeThreadId : null,
    draft: isLatestFloor ? phoneMessages.draft : '',
    threads,
  };
}

function getSnapshot(message: DecodedLegacyMessage | undefined): DecodedSnapshot {
  return message ? cloneJsonValue(message.snapshot) : { runtime: {} };
}

function pickValue<T>(
  direct: T | undefined,
  previous: T | undefined,
  fallback: T | undefined,
  defaultValue: T,
  directSource: FloorSnapshotFieldSource = 'message-snapshot',
  previousSource: FloorSnapshotFieldSource = 'previous-floor-after',
): { value: T; source: FloorSnapshotFieldSource } {
  if (direct !== undefined) return { value: cloneJsonValue(direct), source: directSource };
  if (previous !== undefined) return { value: cloneJsonValue(previous), source: previousSource };
  if (fallback !== undefined) return { value: cloneJsonValue(fallback), source: 'save-current-fallback' };
  return { value: cloneJsonValue(defaultValue), source: 'defaulted' };
}

function createFloorStateSnapshot(input: {
  direct: DecodedSnapshot;
  previous?: FloorStateSnapshot;
  fallbackStatusData?: StatusData;
  fallbackPlayerProfile?: PlayerProfile;
  fallbackDrawingSettings?: DrawingSettings;
  phoneMessages: PhoneMessageStore;
  floorIndex: number;
  position: 'before' | 'after';
  isLatestFloor: boolean;
  directSource?: FloorSnapshotFieldSource;
  previousSource?: FloorSnapshotFieldSource;
  directPhoneMessages?: PhoneMessageStore;
}): FloorStateSnapshot {
  const statusData = pickValue(
    input.direct.statusData,
    input.previous?.statusData,
    input.fallbackStatusData,
    defaultStatusData,
    input.directSource,
    input.previousSource,
  );
  const playerProfile = pickValue(
    input.direct.playerProfile,
    input.previous?.playerProfile,
    input.fallbackPlayerProfile,
    createDefaultPlayerProfile(),
    input.directSource,
    input.previousSource,
  );
  const drawingSettings = pickValue(
    input.direct.drawingSettings,
    input.previous?.drawingSettings,
    input.fallbackDrawingSettings,
    createDefaultDrawingSettings(),
    input.directSource,
    input.previousSource,
  );
  const runtime = pickValue(
    Object.keys(input.direct.runtime).length ? input.direct.runtime : undefined,
    input.previous?.runtime,
    undefined,
    {},
    input.directSource,
    input.previousSource,
  );
  if (runtime.source === 'defaulted') runtime.source = 'legacy-floor-derived';

  return {
    statusData: statusData.value,
    playerProfile: playerProfile.value,
    phoneState: createPhoneStateSnapshot(
      input.directPhoneMessages ?? input.phoneMessages,
      input.floorIndex,
      input.position,
      input.isLatestFloor,
    ),
    drawingSettings: drawingSettings.value,
    runtime: runtime.value,
    provenance: {
      statusData: statusData.source,
      playerProfile: playerProfile.source,
      phoneState: input.directPhoneMessages ? (input.directSource ?? 'message-snapshot') : 'legacy-floor-derived',
      drawingSettings: drawingSettings.source,
      runtime: runtime.source,
    },
  };
}

function collectImageAssetIds(...messages: Array<PersistedMessage | undefined>): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const illustration of message?.illustrations ?? []) {
      if (illustration.assetId) ids.add(String(illustration.assetId));
    }
  }
  return [...ids];
}

function hasFallback(snapshot: FloorStateSnapshot): boolean {
  return Object.values(snapshot.provenance).some(
    source => source === 'save-current-fallback' || source === 'defaulted',
  );
}

export function buildLegacyV2ToV3MigrationPlan(input: unknown): LegacyV2ToV3MigrationPlan {
  const source = decodeLegacyAggregateSaveSource(input);
  const groupedFloors = groupMessagesIntoFloors(source.messages);
  const indexMap = mapLegacyMessageIndexes(groupedFloors);
  const issues: LegacyMigrationIssue[] = source.legacyExtras.unmappedMessages.map(item => ({
    severity: 'warning',
    code: 'unmapped-message',
    sourceMessageIndex: item.sourceIndex,
    detail: `旧 chatLog 第 ${item.sourceIndex} 条不是 user/assistant，迁移计划未发布该记录。`,
  }));

  const fallbackStatusData = isStatusDataLike(source.gameState.statusData)
    ? cloneJsonValue(source.gameState.statusData)
    : cloneJsonValue(defaultStatusData);
  const fallbackProfile = source.runtimeProjection.authoritative.playerProfile ?? createDefaultPlayerProfile();
  const fallbackDrawingSettings =
    source.runtimeProjection.authoritative.drawingSettings ?? createDefaultDrawingSettings();
  const phoneMessages = translatePhoneMessages(source.runtimeProjection.authoritative.phoneMessages, indexMap, issues);
  const summaryBoundary = translateLegacyBoundary(source.summaryStore?.lastSummarizedIndex, indexMap);
  const memoryBoundary = translateLegacyBoundary(source.memoryDB?.lastProcessedIndex, indexMap);

  const floors: FloorRecord[] = [];
  let previousAfter: FloorStateSnapshot | undefined;
  groupedFloors.forEach((group, floorIndex) => {
    const isLatestFloor = floorIndex === groupedFloors.length - 1;
    const userSnapshot = getSnapshot(group.syntheticUserMessage ? undefined : group.user);
    const assistantSnapshot = getSnapshot(group.assistant);
    const beforeDirect = group.syntheticUserMessage && group.assistant ? assistantSnapshot : userSnapshot;
    const beforePhoneMessages = beforeDirect.phoneMessages
      ? translatePhoneMessages(beforeDirect.phoneMessages, indexMap, issues)
      : undefined;
    const beforeTurnState = createFloorStateSnapshot({
      direct: beforeDirect,
      previous: previousAfter,
      fallbackStatusData,
      fallbackPlayerProfile: fallbackProfile,
      fallbackDrawingSettings,
      phoneMessages,
      floorIndex,
      position: 'before',
      isLatestFloor,
      directSource: group.syntheticUserMessage ? 'same-floor-after-fallback' : 'message-snapshot',
      directPhoneMessages: beforePhoneMessages,
    });
    const afterTurnState = group.assistant
      ? createFloorStateSnapshot({
          direct: assistantSnapshot,
          previous: beforeTurnState,
          fallbackStatusData,
          fallbackPlayerProfile: fallbackProfile,
          fallbackDrawingSettings,
          phoneMessages,
          floorIndex,
          position: 'after',
          isLatestFloor,
          previousSource: 'same-floor-before',
          directPhoneMessages: assistantSnapshot.phoneMessages
            ? translatePhoneMessages(assistantSnapshot.phoneMessages, indexMap, issues)
            : undefined,
        })
      : undefined;

    if (group.syntheticUserMessage) {
      issues.push({
        severity: 'warning',
        code: 'synthetic-user-message',
        floorIndex,
        sourceMessageIndex: group.assistant?.sourceIndex,
        detail: '旧档存在没有配对用户输入的 AI 正文；已用带来源标记的空合成输入保留正文。',
      });
    }
    if (hasFallback(beforeTurnState)) {
      issues.push({
        severity: 'warning',
        code: 'before-state-fallback',
        floorIndex,
        sourceMessageIndex: group.user.sourceIndex,
        detail: 'beforeTurnState 有字段只能从当前存档或默认值补齐，不能当作已验证的历史权威状态。',
      });
    }

    const sourceMessages = [group.syntheticUserMessage ? undefined : group.user, group.assistant].filter(
      (item): item is DecodedLegacyMessage => Boolean(item),
    );
    const legacyMessageExtras = Object.fromEntries(
      sourceMessages
        .filter(item => Object.keys(item.legacyExtras).length || Object.keys(item.snapshotExtras).length)
        .map(item => [
          String(item.sourceIndex),
          {
            ...(Object.keys(item.legacyExtras).length ? { message: item.legacyExtras } : {}),
            ...(Object.keys(item.snapshotExtras).length ? { snapshot: item.snapshotExtras } : {}),
          },
        ]),
    );
    const userMessage = asUserMessage(group.user.message);
    const assistantMessage = group.assistant ? asAssistantMessage(group.assistant.message) : undefined;
    floors.push({
      saveId: source.saveId,
      floorIndex,
      userMessage,
      ...(assistantMessage ? { assistantMessage } : {}),
      beforeTurnState,
      ...(afterTurnState ? { afterTurnState } : {}),
      summaryBoundary: Math.min(summaryBoundary, floorIndex + 1),
      memoryBoundary: Math.min(memoryBoundary, floorIndex + 1),
      imageAssetIds: collectImageAssetIds(userMessage, assistantMessage),
      revision: 1,
      provenance: {
        origin: 'legacy-v2',
        sourceSchemaVersion: source.version,
        sourceMessageIndexes: sourceMessages.map(item => item.sourceIndex),
        sourceMessageIds: sourceMessages.map(item => item.message.id),
        syntheticUserMessage: group.syntheticUserMessage,
        ...(Object.keys(legacyMessageExtras).length ? { legacyExtras: legacyMessageExtras } : {}),
      },
    });
    previousAfter = afterTurnState ?? beforeTurnState;
  });

  const currentRuntime: FloorRuntimeSnapshot = {};
  const latestSnapshot = floors[floors.length - 1]?.afterTurnState ?? floors[floors.length - 1]?.beforeTurnState;
  if (latestSnapshot?.runtime.gameDevelopment !== undefined) {
    currentRuntime.gameDevelopment = cloneJsonValue(latestSnapshot.runtime.gameDevelopment);
  }

  return {
    saveId: source.saveId,
    runId: source.runId,
    sourceSchemaVersion: source.version,
    targetSchemaVersion: SAVE_DATA_SCHEMA_VERSION,
    initialRevision: 1,
    floors,
    currentState: {
      statusData: fallbackStatusData,
      playerProfile: cloneJsonValue(fallbackProfile),
      phoneMessages,
      drawingSettings: cloneJsonValue(fallbackDrawingSettings),
      runtime: currentRuntime,
      ...(isRecord(source.gameState.worldState) ? { worldState: cloneJsonValue(source.gameState.worldState) } : {}),
    },
    ...(source.summaryStore ? { summaryStore: cloneJsonValue(source.summaryStore) } : {}),
    ...(source.memoryDB ? { memoryDB: cloneJsonValue(source.memoryDB) } : {}),
    ...(source.messageSnapshots ? { messageSnapshots: cloneJsonValue(source.messageSnapshots) } : {}),
    legacyExtras: {
      ...source.legacyExtras,
      runtimeFlags: source.runtimeProjection.legacyExtras,
      runtimeAuthoritativeRawSource: source.runtimeProjection.authoritativeRawSource,
    },
    excludedRuntimeFlagKeys: source.runtimeProjection.excludedKnownKeys,
    legacyMessageIndexToFloorIndex: Object.fromEntries(indexMap),
    issues,
    // 可玩优先：v2 本来就没有足够信息证明每个历史字段的精确来源。
    // 只要 codec 能完整保留正文与 raw provenance，就允许发布为可回退的 v3；
    // future/unknown schema 仍在 decode 入口被硬拒绝，绝不降级写回。
    readyForTransactionalPublish: true,
  };
}
