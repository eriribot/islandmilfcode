/** 卡片/UI 的发布版本。它不再代表任何持久化格式。 */
export const CARD_VERSION = '0.43';

/**
 * 当前逻辑存档 schema。新写入由 v3 archive repository 承担；旧聚合
 * SavePayload 只作为保留兼容源和应急降级副本。
 */
export const SAVE_DATA_SCHEMA_VERSION = 3;

/** 当前实际打开的 IndexedDB 结构版本，包含 v3 分块与缓存 stores。 */
export const IDB_SCHEMA_VERSION = 3;

/** MemoryDB 自己的 schema，不跟随卡片或存档 schema。 */
export const MEMORY_DB_SCHEMA_VERSION = 1;

/** 当前本机内容寻址分块归档格式。 */
export const LOCAL_ARCHIVE_FORMAT_VERSION = 3;

/** 当前酒馆事件桥协议；仅在请求/响应 ABI 改变时递增。 */
export const BRIDGE_PROTOCOL_VERSION = 2;

/** 现有 v2 聚合 SavePayload 使用过的最后一个卡版本标记。 */
export const LEGACY_AGGREGATE_SAVE_SCHEMA_VERSION = '0.43';

export type SaveDataSchemaRelation = 'legacy' | 'current' | 'future' | 'unknown';

function parseIntegerSchemaVersion(value: unknown): number | null {
  // 历史版本曾以 0.4x 这类 number 保存；它们仍属于旧聚合 payload。
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().toLowerCase().match(/^v?(\d+)$/);
  return match ? Number(match[1]) : null;
}

function compareLegacyCardVersion(value: string): number | null {
  const match = value.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const left = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const right = [0, 43, 0];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

/**
 * 只判断兼容关系，不做 normalize，也不产生写副作用。
 * 缺失版本、历史数字 v1/v2 和 0.43 聚合 payload 都属于 legacy。
 * 无法识别的非空版本按 unknown 冻结，避免猜测后降级写回。
 */
export function classifySaveDataSchemaVersion(value: unknown): SaveDataSchemaRelation {
  if (value === undefined || value === null || value === '') return 'legacy';
  if (typeof value === 'string') {
    const legacyCardComparison = compareLegacyCardVersion(value);
    if (legacyCardComparison !== null) return legacyCardComparison <= 0 ? 'legacy' : 'future';
  }

  const integerVersion = parseIntegerSchemaVersion(value);
  if (integerVersion === null) return 'unknown';
  if (integerVersion < SAVE_DATA_SCHEMA_VERSION) return 'legacy';
  if (integerVersion === SAVE_DATA_SCHEMA_VERSION) return 'current';
  return 'future';
}

/**
 * Card release versions and persistence schema versions were historically
 * stored in the same `version` field. Structure wins for old aggregate saves:
 * a recognizable gameState+chatLog payload remains playable even if its card
 * semver is newer than this build. Only an explicit future schema marker is a
 * hard read-only boundary.
 */
export function classifySavePayloadSchema(payload: unknown): SaveDataSchemaRelation {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return classifySaveDataSchemaVersion(payload);
  }
  const raw = payload as Record<string, unknown>;
  const recognizableAggregate = isRecognizableAggregateSavePayload(payload);
  const explicit = raw.saveDataSchemaVersion ?? raw.schemaVersion;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const explicitRelation = classifySaveDataSchemaVersion(explicit);
    if (explicitRelation === 'future') return explicitRelation;
    // Older cards and third-party exporters sometimes wrote their own schema
    // labels. If the complete aggregate shape is still one our decoder knows,
    // prefer a playable legacy read over freezing the save for an unknown tag.
    if (explicitRelation === 'unknown') return recognizableAggregate ? 'legacy' : 'unknown';
    if (explicitRelation === 'current') return 'current';
  }
  if (recognizableAggregate) return 'legacy';
  return classifySaveDataSchemaVersion(raw.version);
}

/** 只有聚合 codec 明确认识的结构与版本才能进入 normalize/write-back 路径。 */
function isRecognizableAggregateSavePayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return Boolean(raw.gameState && typeof raw.gameState === 'object' && !Array.isArray(raw.gameState))
    && Array.isArray(raw.chatLog);
}

/**
 * A structurally recognizable aggregate payload can use the existing codec
 * when its schema is not newer than this build. `current` still requires the
 * gameState+chatLog shape so unrelated v3 data cannot be normalized as a save.
 */
export function canUseLegacyAggregateSaveCodec(value: unknown): boolean {
  const relation = value && typeof value === 'object'
    ? classifySavePayloadSchema(value)
    : classifySaveDataSchemaVersion(value);
  return relation === 'legacy' || (relation === 'current' && isRecognizableAggregateSavePayload(value));
}

/** 明确未来 schema，或结构也无法识别的未知数据，只能保留、列出和原样导出。 */
export function isReadOnlySaveDataSchema(value: unknown): boolean {
  const relation = value && typeof value === 'object'
    ? classifySavePayloadSchema(value)
    : classifySaveDataSchemaVersion(value);
  return relation === 'future' || relation === 'unknown';
}

// 旧聚合 codec 与版本展示仍使用这两个兼容别名；v3 路径使用独立常量。
export const ISLANDMILFCODE_VERSION = CARD_VERSION;
export const SAVE_SCHEMA_VERSION = LEGACY_AGGREGATE_SAVE_SCHEMA_VERSION;
