export type PhoneRoute =
  | 'home'
  | 'app:messages'
  | 'app:chat'
  | 'app:calendar'
  | 'app:summary'
  | 'app:archive'
  | 'app:relationships'
  | 'app:status'
  | 'app:inventory'
  | 'app:memory'
  | 'app:studio'
  | 'app:game-development'
  | 'app:music'
  | 'app:drawing'
  | 'app:deepseek-web'
  | 'app:settings'
  | 'app:message-styles';

export const PHONE_THEME_CHARACTER_IDS = ['megumi', 'eriri', 'utaha', 'izumi', 'michiru'] as const;

export type PhoneThemeCharacterId = (typeof PHONE_THEME_CHARACTER_IDS)[number];

export type PhoneCharacterId = PhoneThemeCharacterId | 'sayuri' | 'sonoko' | 'akane' | 'shoko';

export function isPhoneThemeCharacterId(value: string | null | undefined): value is PhoneThemeCharacterId {
  return Boolean(value && (PHONE_THEME_CHARACTER_IDS as readonly string[]).includes(value));
}

// 档案页印象标签策略：金色关系闩锁不参与裁剪；普通标签按极性配额展示，避免重复刷屏。
export const PHONE_ARCHIVE_IMPRESSION_MAX_COUNT = 8;

export const PHONE_ARCHIVE_IMPRESSION_POLARITY_LIMITS = {
  positive: 3,
  neutral: 2,
  negative: 1,
} as const;

export const PHONE_ARCHIVE_IMPRESSION_GOLD_TAG = 'gold-variable';
export const PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG = 'locked-variable';

export const PHONE_ARCHIVE_GOLD_IMPRESSION_KEYWORDS = [
  '恋人',
  '恋爱关系',
  '交往',
  '女友',
  '男友',
  '伴侣',
  '爱人',
  '婚约',
  '结婚',
  '后宫',
  '正宫',
  '结缘',
] as const;

export type PhoneArchiveImpressionLike = {
  label: string;
  polarity: -1 | 0 | 1;
  weight?: number;
  importance?: number;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
};

export function normalizePhoneArchiveImpressionSubject(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^(user|玩家|你)$/.test(normalized) ? 'user' : normalized.replace(/\s+/g, '');
}

export function isPlayerPhonePseudoTarget(target: {
  id?: string;
  name?: string;
  alias?: string;
  meta?: Record<string, unknown>;
} | null | undefined) {
  if (!target) return true;
  const haystack = [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .map(value =>
      String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[{}・·.\s　"'“”‘’《》【】「」『』（）()]+/g, ''),
    )
    .filter(Boolean);
  return haystack.some(value => /^(?:user|player|玩家|主角|你|我)$/.test(value));
}

function compactImpressionText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[“”"'「」『』【】\[\]（）()\s、，,。.!！?？：:；;·\-_/\\|｜]/g, '')
    .replace(/[的地得]/g, '');
}

export function getPhoneArchiveImpressionSemanticKey(label: string): string {
  const compact = compactImpressionText(label)
    .replace(/极强|强烈|高度|非常|明显|过度|深度|很|有点|略微|相当/g, '')
    .replace(/和|与|且|并且/g, '');

  if (/后宫|正宫/.test(compact)) return 'locked-harem';
  if (/婚约|结婚/.test(compact)) return 'locked-marriage';
  if (/恋人|恋爱关系|交往|女友|男友|伴侣|爱人/.test(compact)) return 'locked-lover';
  if (/结缘/.test(compact)) return 'locked-bond';
  if (/依赖|信任|信赖|安心|可靠|靠谱|托付|靠得住|安全感/.test(compact)) return 'trust';
  if (/占有|独占|吃醋|嫉妒|醋意|不想分享/.test(compact)) return 'possessive';
  if (/迷恋|沉迷|上瘾|渴望|欲望|吸引/.test(compact)) return 'desire';
  if (/亲密|暧昧|偏心|在意|心动|喜欢|好感|宠爱/.test(compact)) return 'affection';
  if (/保护|守护|护短|照顾|关心/.test(compact)) return 'care';
  if (/伤害|受伤|刺痛|失望|难过|委屈/.test(compact)) return 'hurt';
  if (/警惕|戒备|怀疑|防备|不信任/.test(compact)) return 'wary';
  if (/尴尬|困惑|迷茫|观察|试探|好奇/.test(compact)) return 'neutral-watch';
  return compact;
}

export function isPhoneArchiveGoldImpression(imp: PhoneArchiveImpressionLike): boolean {
  if (imp.tags?.some(tag => tag === PHONE_ARCHIVE_IMPRESSION_GOLD_TAG || tag === PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG)) {
    return true;
  }
  return PHONE_ARCHIVE_GOLD_IMPRESSION_KEYWORDS.some(keyword => imp.label.includes(keyword));
}

function getImpressionTime(imp: PhoneArchiveImpressionLike): string {
  return imp.lastSeenAt || imp.updatedAt || imp.createdAt || '';
}

function rankPhoneArchiveImpression(a: PhoneArchiveImpressionLike, b: PhoneArchiveImpressionLike): number {
  const goldDiff = Number(isPhoneArchiveGoldImpression(b)) - Number(isPhoneArchiveGoldImpression(a));
  if (goldDiff) return goldDiff;
  const weightDiff = Math.abs(b.weight ?? 0) - Math.abs(a.weight ?? 0);
  if (weightDiff) return weightDiff;
  const importanceDiff = (b.importance ?? 0) - (a.importance ?? 0);
  if (importanceDiff) return importanceDiff;
  return getImpressionTime(b).localeCompare(getImpressionTime(a));
}

export function selectPhoneArchiveImpressions<T extends PhoneArchiveImpressionLike>(impressions: T[]): T[] {
  const sorted = [...impressions].sort(rankPhoneArchiveImpression);
  const unique: T[] = [];
  const seen = new Set<string>();
  for (const imp of sorted) {
    const key = `${imp.polarity}|${getPhoneArchiveImpressionSemanticKey(imp.label)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(imp);
  }

  const gold = unique.filter(isPhoneArchiveGoldImpression);
  const regular = unique.filter(imp => !isPhoneArchiveGoldImpression(imp));
  const selected: T[] = [...gold];
  const selectedSet = new Set<T>(selected);

  const addByPolarity = (polarity: -1 | 0 | 1, limit: number) => {
    for (const imp of regular.filter(item => item.polarity === polarity).slice(0, limit)) {
      if (selectedSet.has(imp)) continue;
      selected.push(imp);
      selectedSet.add(imp);
    }
  };

  addByPolarity(1, PHONE_ARCHIVE_IMPRESSION_POLARITY_LIMITS.positive);
  addByPolarity(0, PHONE_ARCHIVE_IMPRESSION_POLARITY_LIMITS.neutral);
  addByPolarity(-1, PHONE_ARCHIVE_IMPRESSION_POLARITY_LIMITS.negative);

  return gold.length > PHONE_ARCHIVE_IMPRESSION_MAX_COUNT
    ? gold
    : selected.slice(0, PHONE_ARCHIVE_IMPRESSION_MAX_COUNT);
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

/** 全局消息文字样式配置 */
export type GlobalMessageStyleConfig = {
  fontColor: string;      // 字体颜色（惠管）
  fontSize: number;       // 字体大小（英梨梨管）
  lineHeight: number;     // 行高（诗羽管）
  fontFamily: string;     // 字体（美智留管）
};

/** 美智留管理的可选字体列表 */
export const MESSAGE_FONT_OPTIONS = [
  { value: 'SimSun', label: '宋体' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'SimHei', label: '黑体' },
  { value: 'KaiTi', label: '楷体' },
  { value: 'DengXian', label: '等线' },
  { value: 'FangSong', label: '仿宋' },
  { value: 'YouYuan', label: '幼圆' },
  { value: 'STXihei', label: '华文细黑' },
  { value: 'LiSu', label: '隶书' },
  { value: 'FZShuTi', label: '方正舒体' },
] as const;
