import templateJson from './island-memory-v3.json';

import type {
  IslandMemoryDB,
  MemoryAttributeRow,
  MemoryBaseRow,
  MemoryEntityRow,
  MemoryFactRow,
  MemoryItemRow,
  MemoryRelationRow,
} from '../memorydatabase/types';
import type { PlayerProfile, StatusData, TargetStatus } from '../types';

export const SHUJUKU_MEMORY_MAPPING_VERSION = 'island-memory-v3';

const SHEET_HEADERS = {
  sheet_global_data: ['row_id', '全局状态', '当前详细地点', '当前次要地区', '当前主要地区', '上轮场景时间', '经过的时间', '当前时间'],
  sheet_world_map: ['row_id', '详细地点', '次要地区', '主要地区', '地点类型', '环境描述', '解锁阶段'],
  sheet_relation_network: ['row_id', '网络名称', '当前立场', '存在状态', '关联角色', '关系说明', '对恋爱线影响'],
  sheet_protagonist: ['row_id', '姓名', '性别', '年龄', '外貌特征', '身份', '现况', '社交态度', '大众风评', '所在地点', '基础属性', '特有属性', '随身财物', '亲密定位', '亲密经验', '身体敏感区', '身体整体状态'],
  sheet_skills: ['row_id', '名称', '分类', '熟练度', '说明'],
  sheet_romance_targets: ['row_id', '姓名', '性别', '年龄', '一句话介绍', '外貌特征', '穿着打扮', '基础属性', '特有属性', '所在地点', '在场状态', '人际关系', '社交态度', '大众风评', '亲密次数', '亲密定位', '亲密经验', '身体敏感区', '身体整体状态'],
  sheet_love_diary: ['row_id', '写作角色', '关联角色', '关联AM码', '客观事件', '当时想法'],
  sheet_important_non_romance: ['row_id', '姓名', '性别', '年龄', '一句话介绍', '外貌特征', '穿着打扮', '基础属性', '特有属性', '所在地点', '在场状态', '人际关系', '社交态度', '大众风评'],
  sheet_char_journal: ['row_id', '角色姓名', '客观事件', '内心想法'],
  sheet_minutes: ['row_id', '编码索引', '时间跨度', '概览', '纪要', '重要对话'],
  sheet_items: ['row_id', '物品名称', '类型', '数量', '情感分量', '品质', '描述'],
  sheet_memo: ['row_id', '备忘标题', '类型', '关联角色', '详细内容', '当前状态', '相关时间', '重要程度', '后续结果'],
  sheet_check_advice: ['row_id', '展示文本', '骰子命令'],
  sheet_director_plan: ['row_id', '剧情走向', '大纲', 'AI指导'],
} as const;

type SheetKey = keyof typeof SHEET_HEADERS;
type Cell = string | number | null;
type TableRow = Cell[];
type UnknownRecord = Record<string, unknown>;
type ChatSheet = UnknownRecord & { content: unknown[][]; name?: string };
type ChatSheets = UnknownRecord & { mate: UnknownRecord };

export type ShujukuMemoryMigrationInput = {
  memoryDB: IslandMemoryDB;
  playerProfile: PlayerProfile;
  statusData: StatusData;
};

export type ShujukuMemoryMigrationStats = {
  activeRows: number;
  expiredRows: number;
  mappedRows: Record<SheetKey, number>;
  skippedSecrets: number;
  skippedPhoneMessages: number;
  skippedShortSummaries: number;
  skippedExtensions: number;
};

export type ShujukuMemoryMigration = {
  mappingVersion: typeof SHUJUKU_MEMORY_MAPPING_VERSION;
  tables: ChatSheets;
  sourceProjection: UnknownRecord;
  stats: ShujukuMemoryMigrationStats;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function clip(value: unknown, max: number): string {
  return text(value).slice(0, max);
}

function activeRows<T extends MemoryBaseRow>(rows: readonly T[]): T[] {
  return rows
    .filter(row => !row.expired)
    .slice()
    .sort((left, right) => {
      const leftFloor = left.sourceRange?.[0] ?? Number.MAX_SAFE_INTEGER;
      const rightFloor = right.sourceRange?.[0] ?? Number.MAX_SAFE_INTEGER;
      return leftFloor - rightFloor || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
}

function readRecordValue(record: unknown, keys: readonly string[]): unknown {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && text(record[key])) return record[key];
  }
  return undefined;
}

function readRowValue(row: MemoryBaseRow | undefined, keys: readonly string[]): unknown {
  return readRecordValue(row?.extra, keys);
}

function readNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function toOptional(value: unknown, max = Number.MAX_SAFE_INTEGER): string | null {
  const normalized = clip(value, max);
  return normalized || null;
}

function uniqueText(raw: unknown, max: number, used: Set<string>, fallback: string): string {
  const base = clip(raw, max) || fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const marker = '~' + suffix;
    candidate = base.slice(0, Math.max(1, max - marker.length)) + marker;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function splitLocation(value: unknown): { detail: string; minor: string; major: string } {
  const parts = text(value).split(/[>＞/／|｜]+/).map(part => part.trim()).filter(Boolean);
  return {
    detail: parts.at(-1) || '未记录',
    minor: parts.length >= 2 ? parts.at(-2) || '未记录' : '未记录',
    major: parts.length >= 3 ? parts.at(-3) || '未记录' : '未记录',
  };
}

function importanceLabel(value: unknown): string {
  const importance = Number(value);
  if (importance >= 5) return '关键伏笔';
  if (importance >= 4) return '紧急';
  if (importance >= 3) return '重要';
  return '普通';
}

function taskStatus(value: unknown): string {
  if (value === 'done') return '已完成';
  if (value === 'expired') return '已取消';
  if (value === 'archived') return '暂缓';
  return '未开始';
}

function assertTemplate(value: unknown): asserts value is ChatSheets {
  if (!isRecord(value) || !isRecord(value.mate) || value.mate.type !== 'chatSheets') {
    throw new Error('Island shujuku 迁移模板缺少 chatSheets mate。');
  }
  for (const [sheetKey, expectedHeader] of Object.entries(SHEET_HEADERS) as Array<[SheetKey, readonly string[]]>) {
    const sheet = value[sheetKey];
    if (!isRecord(sheet) || !Array.isArray(sheet.content) || !Array.isArray(sheet.content[0])) {
      throw new Error('Island shujuku 迁移模板缺少表：' + sheetKey);
    }
    if (JSON.stringify(sheet.content[0]) !== JSON.stringify(expectedHeader)) {
      throw new Error('Island shujuku 迁移模板列头不匹配：' + sheetKey);
    }
  }
}

function setRows(tables: ChatSheets, sheetKey: SheetKey, rows: TableRow[]): void {
  const sheet = tables[sheetKey] as ChatSheet;
  sheet.content = [Array.from(SHEET_HEADERS[sheetKey]), ...rows];
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[\s_.:：/-]+/g, '');
}

function buildAttributeIndex(rows: readonly MemoryAttributeRow[]): Map<string, Map<string, MemoryAttributeRow>> {
  const result = new Map<string, Map<string, MemoryAttributeRow>>();
  for (const row of activeRows(rows)) {
    const target = result.get(row.targetId) ?? new Map<string, MemoryAttributeRow>();
    target.set(normalizeKey(row.key), row);
    result.set(row.targetId, target);
  }
  return result;
}

function findAttribute(
  index: Map<string, Map<string, MemoryAttributeRow>>,
  targetIds: readonly string[],
  keys: readonly string[],
): MemoryAttributeRow | undefined {
  for (const targetId of targetIds) {
    const target = index.get(targetId);
    if (!target) continue;
    for (const key of keys) {
      const row = target.get(normalizeKey(key));
      if (row) return row;
    }
  }
  return undefined;
}

function formatAttributes(
  index: Map<string, Map<string, MemoryAttributeRow>>,
  targetIds: readonly string[],
  excludedKeys: readonly string[] = [],
): string | null {
  const excluded = new Set(excludedKeys.map(normalizeKey));
  const values = new Map<string, string>();
  for (const targetId of targetIds) {
    for (const row of index.get(targetId)?.values() ?? []) {
      const key = normalizeKey(row.key);
      if (!excluded.has(key) && !/^(?:skill|技能|才艺)/i.test(row.key)) values.set(row.key, row.value);
    }
  }
  return values.size ? [...values].map(([key, value]) => key + ':' + value).join('; ') : null;
}

function buildNameResolver(input: ShujukuMemoryMigrationInput, entities: readonly MemoryEntityRow[]) {
  const names = new Map<string, string>();
  for (const entity of entities) {
    names.set(entity.entityId, entity.name);
    names.set(entity.id, entity.name);
    for (const alias of entity.aliases ?? []) names.set(alias, entity.name);
  }
  for (const target of input.statusData.targets) {
    names.set(target.id, target.name);
    if (target.alias) names.set(target.alias, target.name);
  }
  names.set('player', input.playerProfile.name || '玩家');
  names.set('user', input.playerProfile.name || '玩家');
  return (value: unknown): string => names.get(text(value)) || text(value) || '未记录';
}

function relationsFor(
  entityId: string,
  rows: readonly MemoryRelationRow[],
  resolveName: (value: unknown) => string,
): string | null {
  const values = rows.filter(row => row.fromId === entityId || row.toId === entityId).map(row => {
    const other = row.fromId === entityId ? row.toId : row.fromId;
    const detail = [row.label, row.stage, row.affinity === undefined ? '' : '亲密度' + row.affinity, row.reason]
      .filter(Boolean)
      .join(' / ');
    return resolveName(other) + ':' + detail;
  });
  return values.length ? values.join('; ') : null;
}

function profileFactsFor(
  entityIds: readonly string[],
  entityName: string,
  facts: readonly MemoryFactRow[],
): MemoryFactRow[] {
  const ids = new Set([...entityIds, entityName]);
  return facts.filter(fact => fact.category === 'profile' && (
    ids.has(fact.subject) || fact.relatedEntityIds?.some(id => ids.has(id))
  ));
}

function buildGlobalRows(input: ShujukuMemoryMigrationInput): TableRow[] {
  const activeWorld = activeRows(input.memoryDB.worldState).at(-1);
  const currentTime = activeWorld?.currentTime || input.statusData.world.currentTime || '未记录';
  const location = splitLocation(activeWorld?.currentLocation || input.statusData.world.currentLocation);
  return [[
    1,
    '全局状态',
    location.detail,
    location.minor,
    location.major,
    null,
    '0分',
    currentTime,
  ]];
}

function buildWorldMapRows(
  input: ShujukuMemoryMigrationInput,
  entities: readonly MemoryEntityRow[],
  facts: readonly MemoryFactRow[],
): TableRow[] {
  const places = new Map<string, { location: ReturnType<typeof splitLocation>; type: string | null; desc: string | null; stage: string | null }>();
  const put = (name: unknown, extra?: unknown, description?: unknown) => {
    const location = splitLocation(name);
    if (!location.detail || location.detail === '未记录') return;
    const existing = places.get(location.detail);
    places.set(location.detail, {
      location,
      type: toOptional(readRecordValue(extra, ['locationType', 'type', '地点类型'])) ?? existing?.type ?? null,
      desc: toOptional(description || readRecordValue(extra, ['description', 'environment', '环境描述']), 60) ?? existing?.desc ?? null,
      stage: toOptional(readRecordValue(extra, ['unlockStage', 'stage', '解锁阶段'])) ?? existing?.stage ?? '已解锁',
    });
  };
  for (const entity of entities.filter(entity => entity.kind === 'location')) put(entity.name, entity.extra);
  for (const fact of facts.filter(fact => fact.category === 'location')) put(fact.subject, fact.extra, fact.content);
  const world = activeRows(input.memoryDB.worldState).at(-1);
  put(world?.currentLocation || input.statusData.world.currentLocation);
  return [...places.values()].map((place, index) => [
    index + 1,
    place.location.detail,
    place.location.minor,
    place.location.major,
    place.type,
    place.desc,
    place.stage,
  ]);
}

function buildNetworkRows(
  entities: readonly MemoryEntityRow[],
  relations: readonly MemoryRelationRow[],
  resolveName: (value: unknown) => string,
): TableRow[] {
  return entities.filter(entity => entity.kind === 'organization').map((entity, index) => {
    const related = relations.filter(row => row.fromId === entity.entityId || row.toId === entity.entityId);
    const linked = [...new Set(related.map(row => resolveName(row.fromId === entity.entityId ? row.toId : row.fromId)))];
    return [
      index + 1,
      entity.name,
      toOptional(readRowValue(entity, ['stance', '立场']) || related.at(-1)?.label),
      toOptional(readRowValue(entity, ['presence', '存在状态'])),
      linked.length ? linked.join(';') : null,
      toOptional(readRowValue(entity, ['description', 'relationshipDesc', '关系说明']) || related.map(row => row.reason).filter(Boolean).join('; ')),
      toOptional(readRowValue(entity, ['influenceOnRomance', 'romanceInfluence', '对恋爱线影响'])),
    ];
  });
}

function normalizedBaseStat(value: unknown, fallback = 50): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(90, Math.max(10, Math.round(number))) : fallback;
}

function playerBaseAttributes(profile: PlayerProfile): string {
  const stats = profile.stats;
  return [
    '健康:' + 50,
    '力量:' + normalizedBaseStat(stats?.courage),
    '敏捷:' + normalizedBaseStat(stats?.proficiency),
    '理智:' + normalizedBaseStat(stats?.knowledge),
    '观察:' + normalizedBaseStat(stats?.knowledge),
    '魅力:' + normalizedBaseStat(stats?.charm),
  ].join('; ');
}

function buildProtagonistRows(
  input: ShujukuMemoryMigrationInput,
  entities: readonly MemoryEntityRow[],
  attributes: Map<string, Map<string, MemoryAttributeRow>>,
  items: readonly MemoryItemRow[],
): TableRow[] {
  const entity = entities.find(row => row.kind === 'player');
  const targetIds = ['player', 'user', entity?.entityId ?? ''].filter(Boolean);
  const get = (keys: readonly string[]) => findAttribute(attributes, targetIds, keys)?.value;
  const special = formatAttributes(attributes, targetIds);
  const belongings = items
    .filter(item => !item.ownerId || targetIds.includes(item.ownerId) || !item.holderId || targetIds.includes(item.holderId))
    .map(item => item.name + ((item.count ?? 1) > 1 ? '×' + item.count : ''))
    .join('; ');
  const age = readNumber(get(['age', '年龄']), readRowValue(entity, ['age', '年龄']))
    ?? (Number(input.playerProfile.className?.match(/(\d+)年/)?.[1]) + 15 || 18);
  return [[
    1,
    input.playerProfile.name || entity?.name || '玩家',
    input.playerProfile.gender || text(readRowValue(entity, ['gender', '性别'])) || '未记录',
    age,
    clip(input.playerProfile.appearance || readRowValue(entity, ['appearance', '外貌']), 60) || '未记录',
    clip(input.playerProfile.className || input.playerProfile.schoolIdentityLabel || readRowValue(entity, ['identity', '身份']), 40) || '未记录',
    get(['currentCondition', 'condition', '现况']) || '一切如常',
    toOptional(get(['socialAttitude', '社交态度'])),
    toOptional(get(['publicReputation', '大众风评'])),
    activeRows(input.memoryDB.worldState).at(-1)?.currentLocation || input.statusData.world.currentLocation || '未记录',
    playerBaseAttributes(input.playerProfile),
    special || (input.playerProfile.stats?.kindness !== undefined
      ? '体贴:' + normalizedBaseStat(input.playerProfile.stats.kindness)
      : null),
    belongings || null,
    toOptional(get(['intimacyPosition', '亲密定位'])),
    toOptional(get(['intimacyExperience', '亲密经验'])),
    toOptional(get(['intimacySensitive', '身体敏感区'])),
    toOptional(get(['intimacyOverall', '身体整体状态'])),
  ]];
}

function readCharacterValue(
  attributes: Map<string, Map<string, MemoryAttributeRow>>,
  targetIds: readonly string[],
  entity: MemoryEntityRow | undefined,
  target: TargetStatus | undefined,
  keys: readonly string[],
): unknown {
  return findAttribute(attributes, targetIds, keys)?.value
    ?? readRecordValue(target?.meta, keys)
    ?? readRowValue(entity, keys);
}

function presenceValue(value: unknown): string | null {
  const normalized = text(value);
  return normalized === '在场' || normalized === '离场' ? normalized : null;
}

function buildCharacterRow(options: {
  rowId: number;
  target?: TargetStatus;
  entity?: MemoryEntityRow;
  attributes: Map<string, Map<string, MemoryAttributeRow>>;
  facts: readonly MemoryFactRow[];
  relations: readonly MemoryRelationRow[];
  impressions: ShujukuMemoryMigrationInput['memoryDB']['impressions'];
  resolveName: (value: unknown) => string;
  usedNames: Set<string>;
  romance: boolean;
}): TableRow {
  const { target, entity } = options;
  const rawName = target?.name || entity?.name || '未记录角色';
  const name = uniqueText(rawName, 60, options.usedNames, '未记录角色');
  const targetIds = [target?.id, entity?.entityId, entity?.id, rawName].filter((value): value is string => Boolean(value));
  const get = (keys: readonly string[]) => readCharacterValue(options.attributes, targetIds, entity, target, keys);
  const profileFacts = profileFactsFor(targetIds, rawName, options.facts);
  const relationFacts = options.facts.filter(fact => fact.category === 'relation' && (
    fact.subject === rawName || targetIds.includes(fact.subject) || fact.relatedEntityIds?.some(id => targetIds.includes(id))
  ));
  const relationText = [
    relationsFor(target?.id || entity?.entityId || rawName, options.relations, options.resolveName),
    ...relationFacts.map(fact => fact.content),
  ].filter(Boolean).join('; ') || null;
  const impressionText = options.impressions
    .filter(row => targetIds.includes(row.targetId))
    .map(row => row.label + (row.reason ? ':' + row.reason : ''))
    .join('; ') || null;
  const baseAttributes = text(get(['baseAttributes', 'base_attributes', '基础属性']))
    || '健康:50; 力量:50; 敏捷:50; 理智:50; 观察:50; 魅力:50';
  const observedAttributes = formatAttributes(options.attributes, targetIds, [
    'baseAttributes', 'base_attributes', '基础属性', 'location', 'currentLocation', '所在地点',
    'age', '年龄', 'gender', '性别', 'appearance', '外貌', 'outfit', '穿着', 'presence', '在场状态',
  ]);
  const targetState = target
    ? ['好感度:' + target.affinity, '执念度:' + target.obsession, '关系阶段:' + target.stage, '执念阶段:' + target.obsessionStage].join('; ')
    : '';
  const specialAttributes = [targetState, observedAttributes].filter(Boolean).join('; ') || null;
  const common: TableRow = [
    options.rowId,
    name,
    toOptional(get(['gender', '性别'])),
    readNumber(get(['age', '年龄'])),
    toOptional(profileFacts[0]?.content || get(['briefIntro', 'intro', '一句话介绍']), 30),
    toOptional(get(['appearance', '外貌特征', '外貌']), 60),
    toOptional(get(['outfit', 'outfitText', '穿着打扮', '穿着']) || Object.values(target?.outfits ?? {}).at(-1), 40),
    baseAttributes,
    specialAttributes,
    toOptional(get(['location', 'currentLocation', 'locationName', '所在地点'])),
    presenceValue(get(['presence', 'presenceStatus', '在场状态'])),
    relationText,
    toOptional(get(['socialAttitude', '社交态度']) || impressionText),
    toOptional(get(['publicReputation', '大众风评']) || profileFacts.slice(1).map(fact => fact.content).join('; ')),
  ];
  if (!options.romance) return common;
  return [
    ...common,
    readNumber(get(['intimacyCount', '亲密次数'])) ?? 0,
    toOptional(get(['intimacyPosition', '亲密定位'])),
    toOptional(get(['intimacyExperience', '亲密经验'])),
    toOptional(get(['intimacySensitive', '身体敏感区'])),
    toOptional(get(['intimacyOverall', '身体整体状态'])),
  ];
}

function buildCharacterRows(
  input: ShujukuMemoryMigrationInput,
  entities: readonly MemoryEntityRow[],
  facts: readonly MemoryFactRow[],
  relations: readonly MemoryRelationRow[],
  attributes: Map<string, Map<string, MemoryAttributeRow>>,
  resolveName: (value: unknown) => string,
): { romance: TableRow[]; important: TableRow[] } {
  const characterEntities = entities.filter(entity => entity.kind === 'character');
  const usedRomanceNames = new Set<string>();
  const romance = input.statusData.targets.map((target, index) => {
    const entity = characterEntities.find(row => row.entityId === target.id || row.name === target.name || row.aliases?.includes(target.name));
    return buildCharacterRow({
      rowId: index + 1,
      target,
      entity,
      attributes,
      facts,
      relations,
      impressions: activeRows(input.memoryDB.impressions),
      resolveName,
      usedNames: usedRomanceNames,
      romance: true,
    });
  });
  const romanceEntityIds = new Set(input.statusData.targets.flatMap(target => [
    target.id,
    ...characterEntities.filter(row => row.entityId === target.id || row.name === target.name).map(row => row.entityId),
  ]));
  const usedImportantNames = new Set<string>();
  const importantEntities = characterEntities.filter(entity => !romanceEntityIds.has(entity.entityId));
  const important = importantEntities.map((entity, index) => buildCharacterRow({
    rowId: index + 1,
    entity,
    attributes,
    facts,
    relations,
    impressions: activeRows(input.memoryDB.impressions),
    resolveName,
    usedNames: usedImportantNames,
    romance: false,
  }));
  return { romance, important };
}

function buildSkillRows(
  entities: readonly MemoryEntityRow[],
  attributes: Map<string, Map<string, MemoryAttributeRow>>,
): TableRow[] {
  const player = entities.find(entity => entity.kind === 'player');
  const targetIds = ['player', 'user', player?.entityId ?? ''].filter(Boolean);
  const rows: Array<{ name: string; value: string; reason?: string }> = [];
  for (const targetId of targetIds) {
    for (const row of attributes.get(targetId)?.values() ?? []) {
      const match = row.key.match(/^(?:skill|技能|才艺)[.:：/-](.+)$/i);
      if (match?.[1]) rows.push({ name: match[1].trim(), value: row.value, reason: row.reason });
    }
  }
  const used = new Set<string>();
  const levels = ['完全不会', '入门', '熟练', '精通', '专家', '顶尖'] as const;
  const proficiency = (value: string) => {
    if ((levels as readonly string[]).includes(value)) return value;
    const number = Number(value);
    if (!Number.isFinite(number)) return '熟练';
    return levels[Math.min(levels.length - 1, Math.max(0, Math.floor(number / 20)))];
  };
  return rows.map((row, index) => [
    index + 1,
    uniqueText(row.name, 60, used, '未命名技能'),
    '专业',
    proficiency(row.value),
    clip(row.reason || '来源于 Island 老存档，具体获得方式未记录。', 100),
  ]);
}

function buildLoveDiaryRows(
  input: ShujukuMemoryMigrationInput,
  resolveName: (value: unknown) => string,
): TableRow[] {
  return activeRows(input.memoryDB.impressions).map((row, index) => [
    index + 1,
    resolveName(row.targetId),
    resolveName(row.subject),
    null,
    row.reason || row.subject,
    [row.label, '极性' + row.polarity, '权重' + row.weight].join('; '),
  ]);
}

function buildJournalRows(
  input: ShujukuMemoryMigrationInput,
  facts: readonly MemoryFactRow[],
  resolveName: (value: unknown) => string,
): TableRow[] {
  const rows: TableRow[] = [];
  for (const event of activeRows(input.memoryDB.events)) {
    const characters = event.involvedTargetIds?.map(resolveName).filter(Boolean).join('、') || '全局';
    rows.push([rows.length + 1, characters, [event.gameTime, event.title, event.description].filter(Boolean).join(' | '), toOptional(event.outcome)]);
  }
  for (const fact of facts.filter(fact => fact.category === 'event')) {
    const characters = fact.relatedEntityIds?.map(resolveName).filter(Boolean).join('、') || resolveName(fact.subject);
    rows.push([rows.length + 1, characters, [fact.gameTime, fact.content].filter(Boolean).join(' | '), null]);
  }
  return rows;
}

function splitChronicle(value: string, min = 200, max = 520): string[] {
  const source = value.trim();
  if (source.length < min) return [];
  const result: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const remaining = source.length - offset;
    if (remaining <= max) {
      if (remaining >= min) result.push(source.slice(offset));
      else if (result.length) result[result.length - 1] += '\n' + source.slice(offset);
      break;
    }
    let size = max;
    if (remaining - size < min) size = remaining - min;
    const boundary = source.lastIndexOf('。', offset + size);
    if (boundary >= offset + min) size = boundary + 1 - offset;
    result.push(source.slice(offset, offset + size));
    offset += size;
  }
  return result;
}

function buildMinuteRows(
  input: ShujukuMemoryMigrationInput,
): { rows: TableRow[]; shortCount: number } {
  const rows: TableRow[] = [];
  let shortCount = 0;
  for (const summary of activeRows(input.memoryDB.summaries)) {
    const chunks = splitChronicle(summary.text);
    if (!chunks.length) {
      shortCount += 1;
      continue;
    }
    chunks.forEach((chunk, index) => {
      const range = summary.range.join('-');
      rows.push([
        rows.length + 1,
        'island-' + range + (chunks.length > 1 ? '-' + (index + 1) : ''),
        range,
        clip(chunk, 80),
        chunk,
        null,
      ]);
    });
  }
  return { rows, shortCount };
}

function buildInventoryRows(
  input: ShujukuMemoryMigrationInput,
): TableRow[] {
  const grouped = new Map<string, MemoryItemRow>();
  for (const item of activeRows(input.memoryDB.items)) {
    const existing = grouped.get(item.name);
    if (!existing) grouped.set(item.name, { ...item });
    else {
      existing.count = (existing.count ?? 1) + (item.count ?? 1);
      existing.state = [existing.state, item.state].filter(Boolean).join('; ');
    }
  }
  const used = new Set<string>();
  return [...grouped.values()].map((item, index) => [
    index + 1,
    uniqueText(item.name, 20, used, '未命名物品'),
    toOptional(readRowValue(item, ['type', 'itemType', '类型'])) || '情绪物件',
    Math.max(0, Math.trunc(item.count ?? 1)),
    item.promptRelevant || (item.importance ?? 0) >= 4 ? '随身携带' : '可有可无',
    toOptional(readRowValue(item, ['quality', '品质'])),
    clip([
      item.state,
      item.location ? '地点:' + item.location : '',
      item.holderId ? '持有者:' + item.holderId : '',
    ].filter(Boolean).join('; '), 80) || null,
  ]);
}

function buildMemoRows(
  input: ShujukuMemoryMigrationInput,
  facts: readonly MemoryFactRow[],
  resolveName: (value: unknown) => string,
): TableRow[] {
  const candidates: Array<{ title: string; type: string; character: string | null; detail: string; status: string; time: string | null; importance: string; result: string | null }> = [];
  for (const task of activeRows(input.memoryDB.tasks)) {
    candidates.push({
      title: task.content,
      type: task.status === 'done' ? '待办' : '约定',
      character: task.targetId ? resolveName(task.targetId) : null,
      detail: task.content,
      status: taskStatus(task.status),
      time: toOptional(task.deadline || task.gameTime),
      importance: importanceLabel(task.importance),
      result: toOptional(task.resolvedAt ? '完成时间:' + task.resolvedAt : null),
    });
  }
  for (const fact of facts.filter(fact => fact.category === 'promise' || fact.category === 'custom')) {
    candidates.push({
      title: fact.subject || fact.content,
      type: fact.category === 'promise' ? '约定' : '伏笔',
      character: fact.relatedEntityIds?.map(resolveName).join('、') || null,
      detail: fact.content,
      status: '未开始',
      time: toOptional(fact.gameTime),
      importance: importanceLabel(fact.importance),
      result: null,
    });
  }
  const used = new Set<string>();
  return candidates.map((candidate, index) => [
    index + 1,
    uniqueText(candidate.title, 120, used, '未命名备忘'),
    candidate.type,
    candidate.character,
    candidate.detail,
    candidate.status,
    candidate.time,
    candidate.importance,
    candidate.result,
  ]);
}

function emptyMappedRows(): Record<SheetKey, number> {
  return Object.fromEntries(Object.keys(SHEET_HEADERS).map(key => [key, 0])) as Record<SheetKey, number>;
}

function activeRowStats(memoryDB: IslandMemoryDB): ShujukuMemoryMigrationStats {
  const tableNames = ['entities', 'events', 'facts', 'relations', 'impressions', 'tasks', 'secrets', 'items', 'phoneMessages', 'summaries', 'attributes', 'worldState'] as const;
  return tableNames.reduce((stats, tableName) => {
    for (const row of memoryDB[tableName] as MemoryBaseRow[]) {
      if (row.expired) stats.expiredRows += 1;
      else stats.activeRows += 1;
    }
    return stats;
  }, {
    activeRows: 0,
    expiredRows: 0,
    mappedRows: emptyMappedRows(),
    skippedSecrets: 0,
    skippedPhoneMessages: 0,
    skippedShortSummaries: 0,
    skippedExtensions: 0,
  });
}

export function migrateMemoryDatabaseToShujuku(input: ShujukuMemoryMigrationInput): ShujukuMemoryMigration {
  const tables = cloneJson(templateJson) as unknown as ChatSheets;
  assertTemplate(tables);
  const entities = activeRows(input.memoryDB.entities);
  const facts = activeRows(input.memoryDB.facts);
  const relations = activeRows(input.memoryDB.relations);
  const attributes = buildAttributeIndex(activeRows(input.memoryDB.attributes));
  const resolveName = buildNameResolver(input, entities);
  const stats = activeRowStats(input.memoryDB);
  const mappedRows = emptyMappedRows();
  const mark = (sheetKey: SheetKey, rows: TableRow[]) => {
    mappedRows[sheetKey] = rows.length;
    setRows(tables, sheetKey, rows);
  };

  const worldRows = buildWorldMapRows(input, entities, facts);
  const networkRows = buildNetworkRows(entities, relations, resolveName);
  const characterRows = buildCharacterRows(input, entities, facts, relations, attributes, resolveName);
  const itemRows = buildInventoryRows(input);
  const minuteResult = buildMinuteRows(input);
  const memoFacts = facts.filter(fact => fact.category !== 'secret');
  mark('sheet_global_data', buildGlobalRows(input));
  mark('sheet_world_map', worldRows);
  mark('sheet_relation_network', networkRows);
  mark('sheet_protagonist', buildProtagonistRows(input, entities, attributes, activeRows(input.memoryDB.items)));
  mark('sheet_skills', buildSkillRows(entities, attributes));
  mark('sheet_romance_targets', characterRows.romance);
  mark('sheet_love_diary', buildLoveDiaryRows(input, resolveName));
  mark('sheet_important_non_romance', characterRows.important);
  mark('sheet_char_journal', buildJournalRows(input, facts, resolveName));
  mark('sheet_minutes', minuteResult.rows);
  mark('sheet_items', itemRows);
  mark('sheet_memo', buildMemoRows(input, memoFacts, resolveName));
  setRows(tables, 'sheet_check_advice', []);
  setRows(tables, 'sheet_director_plan', []);
  stats.skippedSecrets = input.memoryDB.secrets.filter(row => !row.expired).length + facts.filter(fact => fact.category === 'secret').length;
  stats.skippedPhoneMessages = input.memoryDB.phoneMessages.filter(row => !row.expired).length;
  stats.skippedShortSummaries = minuteResult.shortCount;
  stats.skippedExtensions = Object.values(input.memoryDB.extensions ?? {}).reduce((count, rows) => count + rows.filter(row => !row.expired).length, 0);
  stats.mappedRows = mappedRows;
  return {
    mappingVersion: SHUJUKU_MEMORY_MAPPING_VERSION,
    tables,
    sourceProjection: {
      mappingVersion: SHUJUKU_MEMORY_MAPPING_VERSION,
      runId: input.memoryDB.runId,
      memoryDB: cloneJson({ ...input.memoryDB, _indexes: undefined }),
      playerProfile: cloneJson(input.playerProfile),
      statusData: cloneJson(input.statusData),
    },
    stats,
  };
}

export function getShujukuMemoryTemplate(): ChatSheets {
  const tables = cloneJson(templateJson) as unknown as ChatSheets;
  assertTemplate(tables);
  return tables;
}
