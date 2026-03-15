export type TabKey = 'summary' | 'status' | 'inventory';

export type TargetStatus = {
  id: string;
  name: string;
  alias?: string;
  affinity: number;
  stage: string;
  titles: Record<string, { effect: string; selfComment: string }>;
  outfits: Record<string, string>;
  meta?: Record<string, unknown>;
};

export type StatusData = {
  world: {
    currentTime: string;
    currentLocation: string;
    recentEvents: Record<string, string>;
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
  return data.targets[0] ?? null;
}

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  speaker: string;
  text: string;
  streaming?: boolean;
  tavernMessageId?: number;
};

export type NotificationState = {
  kind: 'message' | 'status';
  title: string;
  preview: string;
  targetTab: TabKey;
  timestamp: string;
};

export type FloatingPhonePosition = {
  x: number;
  y: number;
};

export type ReaderContextMenuState = {
  x: number;
  y: number;
  readerIndex: number;
  sourceUserText: string;
};

export type AppState = {
  activeTab: TabKey;
  phoneOpen: boolean;
  floatingPhone: FloatingPhonePosition;
  focusedMessageIndex: number;
  focusedMessagePage: number;
  draft: string;
  generating: boolean;
  currentGenerationId: string;
  finalizedGenerationId: string;
  uiMessages: UiMessage[];
  statusData: StatusData;
  notification: NotificationState | null;
  readerContextMenu: ReaderContextMenuState | null;
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
    deleteChatMessages?: (
      messageIds: number[],
      option?: { refresh?: 'none' | 'affected' | 'all' },
    ) => Promise<void>;
    generate?: (config: Record<string, unknown>) => Promise<string>;
    generateRaw?: (config: Record<string, unknown>) => Promise<string>;
    createChatMessages?: (
      messages: Array<{ role: 'system' | 'assistant' | 'user'; message: string; is_hidden?: boolean; data?: Record<string, unknown> }>,
      option?: { refresh?: 'none' | 'affected' | 'all'; insert_before?: number | 'end' },
    ) => Promise<void>;
    updateVariablesWith?: (updater: (variables: Record<string, unknown>) => void, option?: Record<string, unknown>) => void;
    getVariables?: (option?: Record<string, unknown>) => Record<string, unknown>;
    getCurrentMessageId?: () => number;
    eventOn?: (eventType: string, listener: (...args: any[]) => void) => { stop: () => void };
    iframe_events?: Record<string, string>;
    tavern_events?: Record<string, string>;
  };
