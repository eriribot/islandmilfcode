/** 单条摘要条目：记录消息范围、摘要文本和创建时间。 */
export type SummaryEntry = {
  /** 该摘要覆盖的消息索引范围 [起始, 结束]。 */
  range: [number, number];
  /** 摘要正文。 */
  text: string;
  /** ISO 时间戳。 */
  createdAt: string;
};

/** 摘要失败时记录的错误信息。 */
export type SummaryError = {
  level: 'minor' | 'major' | 'global';
  timestamp: string;
  message: string;
};

/** 摘要存储：三级摘要 + 游标 + 失败状态。 */
export type SummaryStore = {
  /** 全局压缩摘要（最高级别，400 字以内）。 */
  global: string | null;
  /** 大摘要列表（由多条小摘要合并而来）。 */
  major: SummaryEntry[];
  /** 小摘要列表（每 5 条消息生成一条）。 */
  minor: SummaryEntry[];
  /** 已被摘要覆盖的消息数量游标；新消息从此索引之后开始计入下次摘要。 */
  lastSummarizedIndex: number;
  /** 连续失败次数；达到 3 次时自动暂停。 */
  consecutiveFailures: number;
  /** 是否因连续失败而自动暂停。 */
  autoPaused: boolean;
  /** 最近一次失败的详情。 */
  lastError: SummaryError | null;
};

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

function isValidError(err: unknown): err is SummaryError {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return typeof e.level === 'string' && typeof e.timestamp === 'string' && typeof e.message === 'string';
}
