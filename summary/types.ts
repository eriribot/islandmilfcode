export type SummaryEntry = {
  range: [number, number];
  text: string;
  createdAt: string;
};

export type SummaryError = {
  level: 'minor' | 'major' | 'global';
  timestamp: string;
  message: string;
};

export type SummaryStore = {
  global: string | null;
  major: SummaryEntry[];
  minor: SummaryEntry[];
  lastSummarizedIndex: number;
  consecutiveFailures: number;
  autoPaused: boolean;
  lastError: SummaryError | null;
};

export type SummaryApiConfig = {
  apiurl: string;
  key: string;
  model: string;
  source: string;
};

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
