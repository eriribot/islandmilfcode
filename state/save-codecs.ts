import type { DrawingSettings, PhoneMessageStore, PlayerProfile } from '../types';

export type SaveFieldAuthority =
  | 'authoritative-save'
  | 'host-mirror'
  | 'global-preference'
  | 'derived-cache'
  | 'ephemeral';

/**
 * 已知 runtimeFlags 的冻结分类。只有 authoritative-save 会进入 v3 迁移；
 * 其余字段由各自权威来源恢复，不能因为存在于旧对象里就继续持久化。
 */
export const LEGACY_RUNTIME_FLAG_CLASSIFICATION = Object.freeze({
  playerProfile: 'authoritative-save',
  phoneMessages: 'authoritative-save',
  drawingSettings: 'authoritative-save',
  cardVersion: 'host-mirror',
  saveSchemaVersion: 'host-mirror',
  migratedFromSaveSchemaVersion: 'host-mirror',
  paperTheme: 'global-preference',
  deepSeekMode: 'global-preference',
  tucaoFloat: 'derived-cache',
  backgroundTaskStack: 'derived-cache',
  saveRecoveryNotice: 'derived-cache',
  gameDevelopmentChoiceEdit: 'ephemeral',
  generationCancelRequested: 'ephemeral',
  phoneCancelRequested: 'ephemeral',
  deepSeekWebLookup: 'ephemeral',
  deepSeekFanLookup: 'ephemeral',
} satisfies Record<string, SaveFieldAuthority>);

export const LEGACY_AUTHORITATIVE_RUNTIME_FLAG_KEYS = [
  'playerProfile',
  'phoneMessages',
  'drawingSettings',
] as const;

export type LegacyAuthoritativeRuntimeFields = {
  playerProfile?: PlayerProfile;
  phoneMessages?: PhoneMessageStore;
  drawingSettings?: DrawingSettings;
};

export type LegacyRuntimeProjection = {
  authoritative: LegacyAuthoritativeRuntimeFields;
  /** 原始权威字段仅供迁移核对未知子字段，不直接水合到 v3 运行态。 */
  authoritativeRawSource: Record<string, unknown>;
  /** 未登记旧字段只保存在迁移证据中，不会直接进入运行态。 */
  legacyExtras: Record<string, unknown>;
  /** 已登记但明确不持久化的字段名；不复制其值，避免泄露 key/token/debug 数据。 */
  excludedKnownKeys: string[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function splitLegacyExtras(
  input: Record<string, unknown>,
  knownKeys: readonly string[],
): Record<string, unknown> {
  const known = new Set(knownKeys);
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => [key, cloneJsonValue(value)]),
  );
}

export function projectLegacyRuntimeFlags(input: unknown): LegacyRuntimeProjection {
  const raw = isRecord(input) ? input : {};
  const authoritative: LegacyAuthoritativeRuntimeFields = {};
  const authoritativeRawSource: Record<string, unknown> = {};

  if (isRecord(raw.playerProfile)) {
    authoritative.playerProfile = cloneJsonValue(raw.playerProfile) as PlayerProfile;
    authoritativeRawSource.playerProfile = cloneJsonValue(raw.playerProfile);
  }
  if (isRecord(raw.phoneMessages)) {
    authoritative.phoneMessages = cloneJsonValue(raw.phoneMessages) as PhoneMessageStore;
    authoritativeRawSource.phoneMessages = cloneJsonValue(raw.phoneMessages);
  }
  if (isRecord(raw.drawingSettings)) {
    authoritative.drawingSettings = cloneJsonValue(raw.drawingSettings) as DrawingSettings;
    authoritativeRawSource.drawingSettings = cloneJsonValue(raw.drawingSettings);
  }

  const classifiedKeys = new Set(Object.keys(LEGACY_RUNTIME_FLAG_CLASSIFICATION));
  const legacyExtras: Record<string, unknown> = {};
  const excludedKnownKeys: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const authority = LEGACY_RUNTIME_FLAG_CLASSIFICATION[key as keyof typeof LEGACY_RUNTIME_FLAG_CLASSIFICATION];
    if (authority === 'authoritative-save') continue;
    if (classifiedKeys.has(key)) {
      excludedKnownKeys.push(key);
      continue;
    }
    legacyExtras[key] = cloneJsonValue(value);
  }

  return {
    authoritative,
    authoritativeRawSource,
    legacyExtras,
    excludedKnownKeys: excludedKnownKeys.sort(),
  };
}
