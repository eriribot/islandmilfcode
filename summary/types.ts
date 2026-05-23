/** 单条摘要条目：记录消息范围、摘要文本和创建时间。 */
export type SummaryEntry = {
  /** 该摘要覆盖的消息索引范围 [起始, 结束]。 */
  range: [number, number];
  /** 摘要正文。 */
  text: string;
  /** ISO 时间戳。 */
  createdAt: string;
  /** 本段落抽取的关键事实（可选，老存档可能没有）。 */
  keyFacts?: KeyFact[];
};

/** 关键事实类别：稳定事实沉淀层使用。 */
export type KeyFactCategory = 'promise' | 'secret' | 'relation' | 'item' | 'event' | 'location' | 'profile';

/** 中文类别名到内部类别键的映射（parse 用）。 */
export const KEY_FACT_CATEGORY_MAP: Record<string, KeyFactCategory> = {
  承诺: 'promise',
  秘密: 'secret',
  关系: 'relation',
  物品: 'item',
  事件: 'event',
  地点: 'location',
  设定: 'profile',
  promise: 'promise',
  secret: 'secret',
  relation: 'relation',
  item: 'item',
  event: 'event',
  location: 'location',
  profile: 'profile',
};

/** 中文展示标签（注入 prompt 用）。 */
export const KEY_FACT_CATEGORY_LABEL: Record<KeyFactCategory, string> = {
  promise: '承诺',
  secret: '秘密',
  relation: '关系',
  item: '物品',
  event: '事件',
  location: '地点',
  profile: '设定',
};

/** 关键事实：从小摘要抽取后沉淀进 SummaryStore，不参与压缩。 */
export type KeyFact = {
  id: string;
  category: KeyFactCategory;
  subject: string;
  content: string;
  sourceRange: [number, number];
  createdAt: string;
  /** 被新事实覆盖时标记，但保留可追溯。 */
  superseded?: boolean;
};

/** 摘要失败时记录的错误信息。 */
export type SummaryError = {
  level: 'minor' | 'major' | 'global';
  timestamp: string;
  message: string;
};

/** 摘要存储：三级摘要 + 关键事实沉淀层 + 游标 + 失败状态。 */
export type SummaryStore = {
  /** 全局压缩摘要（最高级别，600 字以内）。 */
  global: string | null;
  /** 大摘要列表（由多条小摘要合并而来）。 */
  major: SummaryEntry[];
  /** 小摘要列表（每 5 条消息生成一条）。 */
  minor: SummaryEntry[];
  /** 关键事实沉淀层：独立于压缩链条，作为主 prompt 的 pinned facts。 */
  keyFacts: KeyFact[];
  /** 已被摘要覆盖的消息数量游标；新消息从此索引之后开始计入下次摘要。 */
  lastSummarizedIndex: number;
  /** 连续失败次数；达到 3 次时自动暂停。 */
  consecutiveFailures: number;
  /** 是否因连续失败而自动暂停。 */
  autoPaused: boolean;
  /** 最近一次失败的详情。 */
  lastError: SummaryError | null;
};

/** 事实锚点：供摘要 prompt 注入当前结构化状态快照。 */
export type FactAnchor = {
  time: string;
  location: string;
  currentMainEventId: string;
  affinities: Array<{ name: string; value: number; stage: string }>;
  obsessions: Array<{ name: string; value: number; stage: string }>;
  mainEvents: Array<{ id: string; status: string }>;
};

/** 从 statusData 构造一个事实锚点，供摘要 prompt 使用。 */
export function buildFactAnchorFromStatus(statusData: {
  world: {
    currentTime: string;
    currentLocation: string;
    currentMainEventId?: string;
    mainEvents?: Record<string, string>;
  };
  targets: Array<{ name: string; affinity?: number; stage?: string; obsession?: number; obsessionStage?: string }>;
}): FactAnchor {
  return {
    time: statusData.world.currentTime,
    location: statusData.world.currentLocation,
    currentMainEventId: statusData.world.currentMainEventId || '',
    affinities: statusData.targets.map(t => ({
      name: t.name,
      value: t.affinity ?? 0,
      stage: t.stage ?? '',
    })),
    obsessions: statusData.targets.map(t => ({
      name: t.name,
      value: t.obsession ?? 0,
      stage: t.obsessionStage ?? '',
    })),
    mainEvents: Object.entries(statusData.world.mainEvents ?? {}).map(([id, s]) => ({
      id,
      status: String(s),
    })),
  };
}

/** 副 API 配置，用于将摘要/变量提取请求发往独立的模型。 */
export type SummaryApiConfig = {
  apiurl: string;
  key: string;
  model: string;
  source: string;
};

/** 模型列表中的单个选项。 */
export type SummaryModelOption = {
  id: string;
  ownedBy?: string;
};

/** 模型列表拉取状态。 */
export type SummaryModelFetchState = {
  loading: boolean;
  models: SummaryModelOption[];
  error: string | null;
  fetchedAt: number | null;
};

/** 创建空白的默认摘要存储。 */
export function createDefaultSummaryStore(): SummaryStore {
  return {
    global: null,
    major: [],
    minor: [],
    keyFacts: [],
    lastSummarizedIndex: 0,
    consecutiveFailures: 0,
    autoPaused: false,
    lastError: null,
  };
}

/** 从持久化的原始数据反序列化为 SummaryStore，对缺失/非法字段做兜底。 */
export function deserializeSummaryStore(raw: unknown): SummaryStore {
  const defaults = createDefaultSummaryStore();
  if (!raw || typeof raw !== 'object') return defaults;
  const obj = raw as Record<string, unknown>;

  return {
    global: typeof obj.global === 'string' ? obj.global : null,
    major: Array.isArray(obj.major) ? obj.major.filter(isValidEntry) : [],
    minor: Array.isArray(obj.minor) ? obj.minor.filter(isValidEntry) : [],
    keyFacts: Array.isArray(obj.keyFacts) ? obj.keyFacts.filter(isValidKeyFact) : [],
    lastSummarizedIndex: typeof obj.lastSummarizedIndex === 'number' ? Math.max(0, obj.lastSummarizedIndex) : 0,
    consecutiveFailures: typeof obj.consecutiveFailures === 'number' ? Math.max(0, obj.consecutiveFailures) : 0,
    autoPaused: typeof obj.autoPaused === 'boolean' ? obj.autoPaused : false,
    lastError: isValidError(obj.lastError) ? obj.lastError : null,
  };
}

function isValidEntry(entry: unknown): entry is SummaryEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    Array.isArray(e.range) &&
    e.range.length === 2 &&
    typeof e.range[0] === 'number' &&
    typeof e.range[1] === 'number' &&
    typeof e.text === 'string' &&
    typeof e.createdAt === 'string'
  );
}

function isValidKeyFact(entry: unknown): entry is KeyFact {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.category === 'string' &&
    typeof e.subject === 'string' &&
    typeof e.content === 'string' &&
    Array.isArray(e.sourceRange) &&
    e.sourceRange.length === 2 &&
    typeof e.sourceRange[0] === 'number' &&
    typeof e.sourceRange[1] === 'number' &&
    typeof e.createdAt === 'string'
  );
}

function isValidError(err: unknown): err is SummaryError {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return typeof e.level === 'string' && typeof e.timestamp === 'string' && typeof e.message === 'string';
}
