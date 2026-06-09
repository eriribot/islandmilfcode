import type { SummaryApiConfig, SummaryModelFetchState, SummaryStore } from './summary/types';
import type { FloatingPhonePosition, MusicPlayerState, PhoneCharacterId, PhoneRoute } from './phone/types';
import type { IslandMemoryDB } from './memorydatabase/types';
import type { MemoryTableName } from './memorydatabase/editor';

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
  version: number;
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

export type PlayerProfile = {
  name: string;
  familyName: string;
  givenName: string;
  gender?: string;
  personality: string;
  appearance: string;
  className?: string;
  stats?: PlayerStats;
  difficulty?: Difficulty;
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
  version: number;
};

export type MessageSnapshot = {
  messageIndex: number;
  kind: 'base' | 'delta';
  state: unknown;
  baseIndex?: number;
};

export type PersistedMessage = {
  role: 'user' | 'assistant';
  speaker: string;
  text: string;
  rawText?: string;
  illustrations?: MessageIllustration[];
  statusSnapshot?: RollbackSnapshot;
};

export type MessageIllustration = {
  id: string;
  imageData: string;
  prompt?: string;
  createdAt: number;
};

export type PhoneChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  speaker: string;
  text: string;
  timestamp: string;
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
  playerProfile?: PlayerProfile;
  drawingSettings?: DrawingSettings;
  phoneMessages?: PhoneMessageStore;
  summaryStore?: SummaryStore;
  memoryDB?: IslandMemoryDB;
};

export type PhoneProactiveState = {
  lastEventKey?: string;
  lastQueuedAt?: number;
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

export type BackgroundTaskKind = 'progress' | 'summary';

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
};

export type ReaderEditingState = {
  readerIndex: number;
  draft: string;
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

export type AppState = {
  activeRunId: string | null;
  activeSaveId: string | null;
  creatingCharacter: boolean;
  showingSaveList: boolean;
  playerProfile: PlayerProfile;
  playerProfileEditing: boolean;
  activeTab: TabKey;
  phoneOpen: boolean;
  phoneRoute: PhoneRoute;
  phoneRouteHistory: PhoneRoute[];
  phoneCharacterId: PhoneCharacterId;
  phoneMessages: PhoneMessageStore;
  floatingPhone: FloatingPhonePosition;
  focusedMessageIndex: number;
  focusedMessagePage: number;
  draft: string;
  generating: boolean;
  currentGenerationId: string;
  finalizedGenerationId: string;
  runtimeFlags: Record<string, unknown>;
  plotLibrary: PlotLibrary;
  characterCardLibrary: CharacterCardLibrary;
  uiMessages: UiMessage[];
  statusData: StatusData;
  musicPlayer: MusicPlayerState;
  drawingSettings: DrawingSettings;
  notification: NotificationState | null;
  backgroundTasks: BackgroundTaskState[];
  readerContextMenu: ReaderContextMenuState | null;
  readerEditing: ReaderEditingState | null;
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
      }>,
      option?: { refresh?: 'none' | 'affected' | 'all'; insert_before?: number | 'end' },
    ) => Promise<void>;
    updateVariablesWith?: (
      updater: (variables: Record<string, unknown>) => void,
      option?: Record<string, unknown>,
    ) => void;
    getVariables?: (option?: Record<string, unknown>) => Record<string, unknown>;
    getCurrentMessageId?: () => number;
    getCharWorldbookNames?: (characterName: 'current' | string) => CharWorldbooks;
    getWorldbook?: (worldbookName: string) => Promise<WorldbookEntry[]>;
    eventOn?: (eventType: string, listener: (...args: any[]) => void) => { stop: () => void };
    eventEmit?: (eventType: string, ...args: any[]) => Promise<void> | void;
    eventRemoveListener?: (eventType: string, listener: (...args: any[]) => void) => void;
    iframe_events?: Record<string, string>;
    tavern_events?: Record<string, string>;
  };
