export type TabKey = 'summary' | 'status' | 'inventory';

export type StatusData = {
  world: {
    currentTime: string;
    currentLocation: string;
    recentEvents: Record<string, string>;
  };
  baiya: {
    dependency: number;
    stage: string;
    titles: Record<string, { effect: string; selfComment: string }>;
    outfits: Record<string, string>;
  };
  player: {
    inventory: Record<string, { description: string; count: number }>;
  };
};

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  speaker: string;
  text: string;
  streaming?: boolean;
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
};

export type TavernWindow = Window &
  typeof globalThis & {
    generate?: (config: Record<string, unknown>) => Promise<string>;
    generateRaw?: (config: Record<string, unknown>) => Promise<string>;
    createChatMessages?: (
      messages: Array<{ role: 'system' | 'assistant' | 'user'; message: string; is_hidden?: boolean }>,
      option?: { refresh?: 'none' | 'affected' | 'all'; insert_before?: number | 'end' },
    ) => Promise<void>;
    updateVariablesWith?: (updater: (variables: Record<string, unknown>) => void, option?: Record<string, unknown>) => void;
    getVariables?: (option?: Record<string, unknown>) => Record<string, unknown>;
    getCurrentMessageId?: () => number;
    eventOn?: (eventType: string, listener: (...args: any[]) => void) => { stop: () => void };
    iframe_events?: Record<string, string>;
  };
