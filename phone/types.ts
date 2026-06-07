export type PhoneRoute =
  | 'home'
  | 'app:messages'
  | 'app:chat'
  | 'app:calendar'
  | 'app:summary'
  | 'app:archive'
  | 'app:status'
  | 'app:inventory'
  | 'app:memory'
  | 'app:music'
  | 'app:drawing'
  | 'app:settings';

export const PHONE_THEME_CHARACTER_IDS = ['megumi', 'eriri', 'utaha', 'izumi', 'michiru'] as const;

export type PhoneThemeCharacterId = (typeof PHONE_THEME_CHARACTER_IDS)[number];

export type PhoneCharacterId = PhoneThemeCharacterId | 'sayuri';

export function isPhoneThemeCharacterId(value: string | null | undefined): value is PhoneThemeCharacterId {
  return Boolean(value && (PHONE_THEME_CHARACTER_IDS as readonly string[]).includes(value));
}

export type FloatingPhonePosition = {
  x: number;
  y: number;
};

// gdstudio 返回的歌曲条目；统一收敛在这里，搜索结果、当前曲目、最近播放都用同一份结构。
export type MusicSource = 'netease' | 'tencent' | 'kuwo' | 'kugou' | 'joox' | 'ytmusic' | 'migu';

export type MusicTrackKind = 'search' | 'bgm';

export type MusicTrack = {
  id: string;
  // 'bgm' 来源不会去打 gdstudio API，仅作为 hero 卡的展示载体；source 字段对它无意义但保留以兼容类型。
  kind: MusicTrackKind;
  source: MusicSource;
  name: string;
  artist: string;
  album: string;
  picId: string;
  lyricId: string;
  picUrl?: string;
  streamUrl?: string;
};

export type MusicSearchState = {
  query: string;
  source: MusicSource;
  status: 'idle' | 'loading' | 'ready' | 'error';
  results: MusicTrack[];
  error: string | null;
  // 用于校验异步搜索结果是否仍是用户当前关心的那一次。
  requestId: number;
};

export type MusicPlayerState = {
  // null = 没有正在播放的曲目（关闭/未开始）。
  currentTrack: MusicTrack | null;
  // 角色头像 BGM 不入队，搜索播放才会写到 queue 里，这样下一首逻辑只在搜索结果之间循环。
  queue: MusicTrack[];
  playing: boolean;
  loadingTrackId: string | null;
  currentTime: number;
  duration: number;
  search: MusicSearchState;
};
