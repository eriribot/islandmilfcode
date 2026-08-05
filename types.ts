import type { SummaryApiConfig, SummaryModelFetchState, SummaryStore } from './summary/types';
import type { FloatingPhonePosition, MusicPlayerState, PhoneCharacterId, PhoneRoute } from './phone/types';
import type { IslandMemoryDB } from './memorydatabase/types';
import type { MemoryTableName } from './memorydatabase/editor';
import type { GameDevelopmentState } from './game-development/types';

export type TabKey = 'summary' | 'status' | 'inventory';

export type SaveKind = 'manual' | 'autosave';

export type SaveTargetMeta = {
  id: string;
  name: string;
  alias?: string;
  affinity: number;
  stage: string;
};

export type SaveMeta = {
  saveId: string;
  runId: string;
  kind: SaveKind;
  label: string;
  createdAt: number;
  updatedAt: number;
  messageIndex: number;
  playerProfile: PlayerProfile;
  activeTarget: SaveTargetMeta | null;
  location?: string;
  gameTime?: string;
  preview?: string;
  messageCount: number;
  version: string | number;
  /** Monotonic browser commit revision; absent on legacy records. */
  browserRevision?: number;
  characterName?: string;
  personality?: string;
  appearance?: string;
};

export type PlayerStats = {
  knowledge: number;
  charm: number;
  proficiency: number;
  kindness: number;
  courage: number;
};

export type Difficulty = 'easy' | 'normal' | 'hard';

export type OpeningMode = 'manual' | 'ai';

export type PlayerProfile = {
  name: string;
  familyName: string;
  givenName: string;
  avatarAssetId?: string;
  gender?: string;
  personality: string;
  appearance: string;
  className?: string;
  schoolCalendarBaseClassName?: string;
  schoolIdentityKind?: string;
  schoolIdentityLabel?: string;
  schoolCalendarSyncedAt?: string;
  stats?: PlayerStats;
  difficulty?: Difficulty;
  backgroundIds?: string[];
  backgrounds?: string[];
  backgroundCost?: number;
};

export type GameState = {
  runId: string;
  statusData: StatusData;
  currentMessageIndex: number;
  worldState?: Record<string, unknown>;
  runtimeFlags?: Record<string, unknown>;
};

export type SavePayload = {
  saveId: string;
  runId: string;
  gameState: GameState;
  chatLog: PersistedMessage[];
  summaryStore: SummaryStore;
  /** 结构化长期记忆（旧存档可能没有，load 时从 summaryStore 迁移） */
  memoryDB?: IslandMemoryDB;
  messageSnapshots?: MessageSnapshot[];
  version: string | number;
  /** Monotonic browser commit revision; absent on legacy records. */
  browserRevision?: number;
};

export type MessageSnapshot = {
  messageIndex: number;
  kind: 'base' | 'delta';
  state: unknown;
  baseIndex?: number;
};

export type PersistedMessage = {
  id: string;
  role: 'user' | 'assistant';
  speaker: string;
  text: string;
  rawText?: string;
  illustrations?: MessageIllustration[];
  statusSnapshot?: RollbackSnapshot;
  /** Stable host marker + last-known position. message_id is only a locator hint. */
  hostLocator?: import('./state/host-timeline-adapter').HostMessageLocator;
};

export type PersistedUserMessage = PersistedMessage & { role: 'user' };
export type PersistedAssistantMessage = PersistedMessage & { role: 'assistant' };

export type MessageIllustration = {
  id: string;
  /** Legacy/transient inline image data. New saves should persist assetId instead. */
  imageData?: string;
  assetId?: string;
  prompt?: string;
  anchorIndex?: number;
  rerollContext?: ImageRerollContext;
  createdAt: number;
};

export type ImageRerollContext = {
  prompt?: string;
  negativePrompt?: string;
  change?: string;
  sceneText?: string;
  rawText?: string;
  generationContext?: string;
  generationWorldBook?: string;
  userInput?: string;
};

export type PhoneChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  speaker: string;
  text: string;
  timestamp: string;
  /** 发信时的完整游戏时间，用于解析"半小时后/明天"这类相对时间。 */
  worldTime?: string;
  /** 这条手机消息生成/发送时绑定的阅读器楼层，从 0 开始。 */
  floorIndex?: number;
  statusSnapshot?: RollbackSnapshot;
};

export type PhoneChatThread = {
  targetId: string;
  messages: PhoneChatMessage[];
  unread: number;
  updatedAt: number;
};

export type PhoneMessageStore = {
  activeThreadId: string | null;
  draft: string;
  generating: boolean;
  threads: Record<string, PhoneChatThread>;
};

export type RollbackSnapshot = {
  statusData: StatusData;
  /** Missing means a legacy snapshot with no authority over game-development state; null explicitly clears it. */
  gameDevelopment?: GameDevelopmentState | null;
  playerProfile?: PlayerProfile;
  drawingSettings?: DrawingSettings;
  phoneMessages?: PhoneMessageStore;
  summaryStore?: SummaryStore;
  memoryDB?: IslandMemoryDB;
};

export type FloorSnapshotFieldSource =
  | 'message-snapshot'
  | 'previous-floor-after'
  | 'same-floor-before'
  | 'same-floor-after-fallback'
  | 'legacy-floor-derived'
  | 'save-current-fallback'
  | 'defaulted';

/**
 * 手机正文继续由独立记录保存；楼层快照只冻结恢复所需的有界游标，
 * 避免每层复制完整 PhoneMessageStore 导致 O(N²) 存档。
 */
export type FloorPhoneThreadCursor = {
  lastMessageId: string | null;
  messageCount: number;
  unread: number;
};

export type FloorPhoneStateSnapshot = {
  activeThreadId: string | null;
  draft: string;
  threads: Record<string, FloorPhoneThreadCursor>;
};

/** 当前明确允许跟随楼层恢复的运行时字段；未知 runtimeFlags 不得混入。 */
export type FloorRuntimeSnapshot = {
  gameDevelopment?: GameDevelopmentState | null;
};

export type FloorStateSnapshotProvenance = {
  statusData: FloorSnapshotFieldSource;
  playerProfile: FloorSnapshotFieldSource;
  phoneState: FloorSnapshotFieldSource;
  drawingSettings: FloorSnapshotFieldSource;
  runtime: FloorSnapshotFieldSource;
};

export type FloorStateSnapshot = {
  statusData: StatusData;
  playerProfile: PlayerProfile;
  phoneState: FloorPhoneStateSnapshot;
  drawingSettings: DrawingSettings;
  runtime: FloorRuntimeSnapshot;
  provenance: FloorStateSnapshotProvenance;
};

export type StoredGenerationContext = {
  kind: 'reader' | 'opening';
  promptFloorRange: [number, number] | null;
  summaryBoundary: number;
  memoryBoundary: number;
  worldbookSetHash?: string;
  routeContextId?: string;
};

export type FloorRecordProvenance = {
  origin: 'v3-native' | 'legacy-v2';
  sourceSchemaVersion: string | number | null;
  sourceMessageIndexes: number[];
  sourceMessageIds: string[];
  syntheticUserMessage: boolean;
  /** 只承接旧源未知字段；业务代码不得把它当作新的自由扩展入口。 */
  legacyExtras?: Record<string, unknown>;
};

export type FloorRecord = {
  saveId: string;
  /** 从 0 开始的稳定业务楼层，不随内存窗口或分页变化。 */
  floorIndex: number;
  userMessage: PersistedUserMessage;
  assistantMessage?: PersistedAssistantMessage;
  beforeTurnState: FloorStateSnapshot;
  afterTurnState?: FloorStateSnapshot;
  generationContext?: StoredGenerationContext;
  /** 摘要与 MemoryDB 都使用“已覆盖楼层数”的 exclusive boundary。 */
  summaryBoundary: number;
  memoryBoundary: number;
  imageAssetIds: string[];
  revision: number;
  provenance: FloorRecordProvenance;
};

export type PhoneProactiveState = {
  lastEventKey?: string;
  lastQueuedAt?: number;
};

export type DeepSeekFanSearchProvider = 'offline' | 'encyclopedia' | 'jina' | 'jina_reader' | 'searxng' | 'ddg';

export type DeepSeekFanSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  focus?: 'timeline' | 'appearance' | 'profile';
  priority?: number;
};

export type DeepSeekFanGeneratedProfile = {
  name: string;
  sourceWork: string;
  aliases: string[];
  gender: string;
  age: string;
  birthday: string;
  identity: string;
  appearance: string;
  personality: string;
  speech: string;
  psychologyBehavior: string;
  abilities: string;
  background: string;
  relationships: Array<{ name: string; text: string }>;
  uncertain: string[];
  entryTitle: string;
  content: string;
};

export type DeepSeekFanLookupState = {
  workTitle: string;
  characterName: string;
  targetRoleId: string;
  worldbookName: string;
  worldbookCandidates: string[];
  extra: string;
  searchProvider: DeepSeekFanSearchProvider;
  searchApiKey: string;
  searchSearxngUrl: string;
  searchDdgRegion: string;
  searchTimeoutMs: number;
  searchMaxResults: number;
  readerResultCount: number;
  status: 'idle' | 'searching' | 'searched' | 'generating' | 'generated' | 'saved' | 'writing' | 'written' | 'error';
  error: string;
  searchQuery: string;
  searchContext: string;
  searchResults: DeepSeekFanSearchResult[];
  generatedText: string;
  generatedProfile: DeepSeekFanGeneratedProfile | null;
  worldbookEntryText: string;
  lastUpdatedAt: number;
};

export type TargetStatus = {
  id: string;
  name: string;
  alias?: string;
  affinity: number;
  obsession: number;
  stage: string;
  obsessionStage: string;
  titles: Record<string, { effect: string; selfComment: string }>;
  outfits: Record<string, string>;
  meta?: Record<string, unknown>;
};

export type CharWorldbooks = {
  primary: string | null;
  additional: string[];
};

export type WorldbookEntry = {
  uid: number;
  name?: string;
  comment?: string;
  key?: string[];
  enabled?: boolean;
  disable?: boolean;
  content: string;
  extra?: Record<string, unknown>;
};

export type PlotEventSchedule = {
  date: string;
  endDate?: string;
  timeSegments: string[];
  locations: string[];
};

export type PlotEventCard = {
  id: string;
  title: string;
  volumeId?: string;
  summary?: string;
  previousIds: string[];
  nextIds: string[];
  content: string;
  schedule?: PlotEventSchedule;
  sourceEntryUid: number;
  sourceEntryName: string;
};

export type VolumeWritingProtocol = {
  作品调性?: string[];
  叙事风格?: string[];
  对白原则?: string[];
  场景原则?: string[];
};

export type PlotLibrary = {
  events: Record<string, PlotEventCard>;
  sourceEntryNames: string[];
  loadedAt: number;
  // 卷级写作协议:key 是卷 ID,value 是该卷的写作指导。
  // 当 currentEvent.volumeId 命中时,会被注入到 prompt 里作为文风锚点。
  writingProtocols?: Record<string, VolumeWritingProtocol>;
};

// 0 层角色卡：从世界书条目里抽出来、由 TS 主动按场景注入的角色档案。
// 世界书条目可以 disable 关闭关键词触发，loader 仍然会把内容抓进来挂在这里。
export type CharacterCard = {
  // 与 targets/relationship.ts 共用的角色键（megumi/eriri/utaha/izumi/michiru/...）。
  key: string;
  name: string;
  content: string;
  sourceEntryUid: number;
  sourceEntryName: string;
};

export type CharacterCardLibrary = {
  // 按角色键索引，buildActiveCharacterCards 用 scenePresence 过滤后注入。
  cards: Record<string, CharacterCard>;
  loadedAt: number;
};

export type ScenePresence = {
  presentIds: string[];
  focusIds: string[];
  absentIds: string[];
  uncertainIds: string[];
  evidence?: Record<string, string>;
  plotImpact?: {
    shiftLevel: 'none' | 'minor_shift' | 'branch_pressure' | 'major_divergence' | 'route_override';
    currentEventShould: 'continue' | 'continue_with_adjustment' | 'pause' | 'delay' | 'skip' | 'branch' | 'override';
    causalTrace: string[];
    butterflyEffects: {
      rippleLevel: 'none' | 'faint' | 'clear' | 'major';
      shortTermEffects: string[];
      midTermEffects: string[];
      routeDamage: 'none' | 'light' | 'medium' | 'heavy';
    };
    mainApiGuidance: string;
  };
  appearanceGuards?: Array<{
    id: string;
    mustFollow: string[];
    mustNotInvent: string[];
    sourcePolicy: 'only_worldbook_card_or_recent_text';
  }>;
  recallPlan?: {
    mustRecall: Array<{ type: string; queryHint: string; reason: string; priority?: number }>;
    niceToRecall?: Array<{ type: string; queryHint: string; reason: string }>;
    mustSuppress?: Array<{ queryHint: string; reason: string }>;
    summaryRecall?: Array<{
      sourceLevel: 'global' | 'major' | 'minor';
      queryHint: string;
      content: string;
      reason: string;
      useInNextPage: string;
    }>;
  };
  webLookupPlan?: Array<{
    intent: 'fact_check' | 'appearance' | 'canon_timeline' | 'detail';
    query: string;
    reason: string;
  }>;
  // 只在本轮正文 prompt 中使用的联网证据摘要；不写入 StatusData / 世界书 / 记忆库。
  webEvidenceContext?: string;
  /**
   * 生成前预判的时间推进建议。仅当玩家/正文明确把世界游标推进到某日期或时段时给出；
   * 倒叙/回忆/计划日期/被提及的旁人日期一律不产生 proposal。confidence='high' 才会被 commit。
   */
  timeProposal?: {
    time: string;
    confidence: 'high' | 'low';
    source: string;
    reason: string;
  };
};

export type StatusData = {
  world: {
    currentTime: string;
    currentLocation: string;
    currentMainEventId: string;
    recentEvents: Record<string, string>;
    mainEvents: Record<string, string>;
    /** 成功落地的主事件正文次数；生成失败不增加，回滚随状态快照恢复。 */
    eventTriggerCounts: Record<string, number>;
  };
  targets: TargetStatus[];
  activeTargetId: string | null;
  player: {
    inventory: Record<string, { description: string; count: number }>;
  };
};

export function getActiveTarget(data: StatusData): TargetStatus | null {
  if (data.activeTargetId) {
    const found = data.targets.find(t => t.id === data.activeTargetId);
    if (found) return found;
  }
  // 中文注释：变量目标没有数组首项兜底；只有明确设置 activeTargetId 时才返回对象。
  return null;
}

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  speaker: string;
  text: string;
  rawText?: string;
  illustrations?: MessageIllustration[];
  streaming?: boolean;
  tavernMessageId?: number;
  statusSnapshot?: RollbackSnapshot;
  /** Real TT/ST message identity. The host marker is authoritative; the id is repairable. */
  hostLocator?: import('./state/host-timeline-adapter').HostMessageLocator;
};

export type NotificationState = {
  kind: 'message' | 'status';
  title: string;
  preview: string;
  targetTab: TabKey;
  timestamp: string;
  phoneRoute?: PhoneRoute;
  targetId?: string;
};

export type BackgroundTaskKind = 'progress' | 'plot-review' | 'summary';

export type BackgroundTaskState = {
  kind: BackgroundTaskKind;
  label: string;
  status: 'running' | 'failed';
  detail?: string;
  startedAt: number;
  updatedAt: number;
};

export type ReaderContextMenuState = {
  x: number;
  y: number;
  readerIndex: number;
  sourceUserText: string;
  canDeleteMessage: boolean;
  canRollbackCompleted: boolean;
};

export type ReaderEditingState = {
  readerIndex: number;
  draft: string;
};

export type ImageRerollEditingState = {
  messageId: string;
  illustrationId: string;
  prompt: string;
  negativePrompt: string;
};

export type DrawingCharacterAnchor = {
  id: string;
  name: string;
  prompt: string;
};

export type DrawingSettings = {
  enabled: boolean;
  qualityPrompt: string;
  negativePrompt: string;
  contextMessageCount: number;
  width: number;
  height: number;
  manualPrompt: string;
  characterAnchors: DrawingCharacterAnchor[];
  systemPrompt: string;
};

/**
 * The reader only keeps a bounded archive slice in memory. Message offsets
 * use the persisted source-message coordinate; floor offsets use archive
 * FloorRecord coordinates.
 */
export type MessageWindowState = {
  startFloor: number;
  endFloorExclusive: number;
  startMessage: number;
  endMessageExclusive: number;
  totalFloorCount: number;
  totalMessageCount: number;
};

export type AppState = {
  activeRunId: string | null;
  activeSaveId: string | null;
  creatingCharacter: boolean;
  deepSeekModeEnabled: boolean;
  showingSaveList: boolean;
  playerProfile: PlayerProfile;
  playerProfileEditing: boolean;
  activeTab: TabKey;
  phoneOpen: boolean;
  phoneRoute: PhoneRoute;
  phoneRouteHistory: PhoneRoute[];
  phoneHomePage: number;
  phoneCharacterId: PhoneCharacterId;
  phoneMessages: PhoneMessageStore;
  floatingPhone: FloatingPhonePosition;
  focusedMessageIndex: number;
  focusedMessagePage: number;
  draft: string;
  generating: boolean;
  openingGenerationError: string | null;
  currentGenerationId: string;
  finalizedGenerationId: string;
  runtimeFlags: Record<string, unknown>;
  plotLibrary: PlotLibrary;
  characterCardLibrary: CharacterCardLibrary;
  uiMessages: UiMessage[];
  messageWindow: MessageWindowState;
  statusData: StatusData;
  musicPlayer: MusicPlayerState;
  drawingSettings: DrawingSettings;
  notification: NotificationState | null;
  backgroundTasks: BackgroundTaskState[];
  readerContextMenu: ReaderContextMenuState | null;
  readerEditing: ReaderEditingState | null;
  imageRerollEditing: ImageRerollEditingState | null;
  summaryStore: SummaryStore;
  summaryApiConfig: SummaryApiConfig | null;
  summaryModelFetch: SummaryModelFetchState;
  summarizing: boolean;
  memoryDB: IslandMemoryDB;
  memoryEditor: MemoryEditorState;
};

export type MemoryEditorState = {
  selectedTable: MemoryTableName | '__trash' | null;
  selectedCategory: string | null;
  expandedRowId: string | null;
  editingRowId: string | null;
  editingDraft: string;
  creating: boolean;
  creatingDraft: string;
  showExpired: boolean;
  error: string | null;
};

export type TavernWindow = Window &
  typeof globalThis & {
    getChatMessages?: (
      range: string | number,
      option?: {
        role?: 'all' | 'system' | 'assistant' | 'user';
        hide_state?: 'all' | 'hidden' | 'unhidden';
        include_swipes?: false;
      },
    ) => Array<{
      message_id: number;
      name: string;
      role: 'system' | 'assistant' | 'user';
      is_hidden: boolean;
      message: string;
      data: Record<string, unknown>;
      extra: Record<string, unknown>;
    }>;
    setChatMessages?: (
      messages: Array<{
        message_id: number;
        is_hidden?: boolean;
        message?: string;
        name?: string;
        role?: 'system' | 'assistant' | 'user';
        data?: Record<string, unknown>;
        extra?: Record<string, unknown>;
      }>,
      option?: { refresh?: 'none' | 'affected' | 'all' },
    ) => Promise<void>;
    deleteChatMessages?: (messageIds: number[], option?: { refresh?: 'none' | 'affected' | 'all' }) => Promise<void>;
    generate?: (config: Record<string, unknown>) => Promise<string>;
    generateRaw?: (config: Record<string, unknown>) => Promise<string>;
    createChatMessages?: (
      messages: Array<{
        role: 'system' | 'assistant' | 'user';
        message: string;
        is_hidden?: boolean;
        data?: Record<string, unknown>;
        extra?: Record<string, unknown>;
      }>,
      option?: { refresh?: 'none' | 'affected' | 'all'; insert_before?: number | 'end' },
    ) => Promise<void>;
    updateVariablesWith?: (
      updater: (variables: Record<string, unknown>) => void,
      option?: Record<string, unknown>,
    ) => void;
    getVariables?: (option?: Record<string, unknown>) => Record<string, unknown>;
    getCurrentMessageId?: () => number;
    getLastMessageId?: () => number;
    getCharWorldbookNames?: (characterName: 'current' | string) => CharWorldbooks;
    getWorldbook?: (worldbookName: string) => Promise<WorldbookEntry[]>;
    createWorldbookEntries?: (worldbookName: string, entries: Array<Partial<WorldbookEntry>>) => Promise<unknown>;
    setWorldbook?: (worldbookName: string, entries: WorldbookEntry[]) => Promise<unknown>;
    eventOn?: (eventType: string, listener: (...args: any[]) => void) => { stop: () => void };
    eventEmit?: (eventType: string, ...args: any[]) => Promise<void> | void;
    eventRemoveListener?: (eventType: string, listener: (...args: any[]) => void) => void;
    iframe_events?: Record<string, string>;
    tavern_events?: Record<string, string>;
  };
