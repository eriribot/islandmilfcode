import type { PlotEventCard, PlotEventSchedule, PlotLibrary, StatusData, TargetStatus, TavernWindow, VolumeWritingProtocol, WorldbookEntry } from '../types';
import { affinityStage, defaultTarget } from '../variables/normalize';

const TARGET_KIND = 'islandmilfcode.target';
const PLOT_KIND = 'islandmilfcode.plot_event';
const PLOT_VOLUME_KIND = 'islandmilfcode.plot_volume';
const TARGET_AVATAR_RULES: Array<{ patterns: string[]; avatarUrl: string }> = [
  {
    patterns: ['英梨梨', '泽村', '澤村', 'eriri', 'sawamura'],
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/eriri_phone.jpg',
  },
  {
    patterns: ['加藤惠', '加藤恵', 'megumi', 'katou', 'kato'],
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/megumi_phone.jpg',
  },
  {
    patterns: ['霞之丘诗羽', '霞之诗羽', '霞ヶ丘詩羽', '霞ヶ丘 詩羽', '诗羽', '詩羽', '霞诗子', '霞詩子', 'utaha', 'kasumigaoka'],
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/utaha_phone.jpg',
  },
  {
    patterns: ['波岛出海', '波島出海', '波岛', '波島', '出海', 'izumi', 'hashima'],
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg',
  },
  {
    patterns: ['冰堂美智留', '氷堂美智留', '冰堂', '氷堂', '美智留', 'michiru', 'hyodo', 'hyoudou'],
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Michiru_phone.jpg',
  },
];

// 从世界书条目中提取目标信息的逻辑：
// 1. 优先从 entry.extra（如果存在且格式正确）中解析 JSON 来获取目标信息。
// 2. 如果 entry.extra 不存在或无法解析，再尝试解析 entry.content 作为 JSON。
// 3. 如果 entry.content 也无法解析为 JSON，则使用正则表达式从文本中提取姓名来创建目标。
function uniqueNames(names: Array<string | null | undefined>) {
  return Array.from(new Set(names.map(name => String(name ?? '').trim()).filter(Boolean)));
}

function getCurrentCharacterWorldbookNames(win: TavernWindow) {
  if (typeof win.getCharWorldbookNames !== 'function') {
    return [];
  }

  try {
    const bound = win.getCharWorldbookNames('current');
    return uniqueNames([bound?.primary, ...(bound?.additional ?? [])]);
  } catch {
    return [];
  }
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getStringArrayField(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value)) {
      return value.map(item => String(item ?? '').trim()).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
  }
  return [];
}

function getStringField(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function getTextField(text: string, label: string) {
  return text.match(new RegExp(`${label}[:：]\\s*([^\\n]+)`))?.[1]?.trim() ?? '';
}

function getRecordField(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compactJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function splitLocationField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .flatMap(item => String(item ?? '').split(/[,，、;；]/))
      .map(item => item.trim())
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,，、;；]/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseEventSchedule(raw: Record<string, unknown>): PlotEventSchedule | undefined {
  const triggerControl = getRecordField(raw, '触发控制');

  const dateRaw =
    getStringField(triggerControl, ['触发日期', 'triggerDate', 'date']) ||
    getStringField(raw, ['日期', 'date', 'triggerDate']);
  const date = (dateRaw.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '').trim();
  if (!date) return undefined;
  const endDateRaw =
    getStringField(triggerControl, ['持续至', '结束日期', 'endDate', 'until']) ||
    getStringField(raw, ['持续至', '结束日期', 'endDate', 'until']);
  const endDate = (endDateRaw.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '').trim();

  const timeSegments = (() => {
    const fromTrigger = getStringArrayField(triggerControl, ['触发时间片段', 'triggerTimeSegments', 'timeSegments']);
    if (fromTrigger.length) return fromTrigger;
    return getStringArrayField(raw, ['时间片段', 'timeSegments']);
  })();

  const locations = (() => {
    const fromTrigger = splitLocationField(triggerControl['触发地点'] ?? triggerControl['triggerLocations']);
    if (fromTrigger.length) return fromTrigger;
    return splitLocationField(raw['核心地点'] ?? raw['locations'] ?? raw['location']);
  })();

  return { date, endDate: endDate && endDate >= date ? endDate : undefined, timeSegments, locations };
}

function summarizeEvent(raw: Record<string, unknown>) {
  return getStringField(raw, ['summary', '阶段摘要', '摘要', '简介']);
}

function getEventNextIds(raw: Record<string, unknown>) {
  const explicit = getStringArrayField(raw, ['next', 'nextIds', '可接续事件', '后续事件']);
  if (explicit.length) return explicit;

  const endControl = getRecordField(raw, '结束控制');
  return getStringArrayField(endControl, ['可接续事件', 'next', 'nextIds']);
}

function getEventPreviousIds(raw: Record<string, unknown>) {
  const explicit = getStringArrayField(raw, ['prev', 'previous', 'previousIds', '前置事件']);
  if (explicit.length) return explicit;

  const triggerControl = getRecordField(raw, '触发控制');
  return getStringArrayField(triggerControl, ['前置事件', 'prev', 'previousIds']);
}

function parsePlotEventRecord(
  raw: Record<string, unknown>,
  entry: WorldbookEntry,
  fallbackVolumeId?: string,
): PlotEventCard | null {
  const kind = getStringField(raw, ['kind', 'type']);
  const eventId = getStringField(raw, ['eventId', 'event_id', 'id']);
  if (!eventId || (kind && kind !== PLOT_KIND && kind !== PLOT_VOLUME_KIND)) return null;

  const title = getStringField(raw, ['title', '标题', 'name']) || eventId;
  const contentValue = raw.content ?? raw['正文'] ?? raw['事件卡'] ?? raw;

  return {
    id: eventId,
    title,
    volumeId: getStringField(raw, ['volumeId', 'volume_id', '卷ID']) || fallbackVolumeId,
    summary: summarizeEvent(raw),
    previousIds: getEventPreviousIds(raw),
    nextIds: getEventNextIds(raw),
    content: typeof contentValue === 'string' ? contentValue.trim() : compactJson(contentValue),
    schedule: parseEventSchedule(raw),
    sourceEntryUid: entry.uid,
    sourceEntryName: getWorldbookEntryName(entry),
  };
}

function parsePlotEventsFromJson(raw: Record<string, unknown>, entry: WorldbookEntry): PlotEventCard[] {
  const kind = getStringField(raw, ['kind', 'type']);
  const volumeId = getStringField(raw, ['volumeId', 'volume_id', 'id']);
  const chain = raw['事件链'];
  const events = raw.events ?? raw['events'];

  const sourceEvents = Array.isArray(chain) ? chain : Array.isArray(events) ? events : null;
  if (sourceEvents) {
    return sourceEvents
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(item => parsePlotEventRecord(item, entry, volumeId))
      .filter((event): event is PlotEventCard => Boolean(event));
  }

  const single = parsePlotEventRecord(raw, entry, kind === PLOT_VOLUME_KIND ? volumeId : undefined);
  return single ? [single] : [];
}

// 从一个 plot_volume 条目的 JSON 里提取写作协议。
// 兼容两种写法:写作协议:{对白原则:[...]} 直接挂在顶层,或者嵌套在 metadata 子键下。
function parseVolumeWritingProtocol(
  raw: Record<string, unknown>,
): { volumeId: string; protocol: VolumeWritingProtocol } | null {
  const volumeId = getStringField(raw, ['volumeId', 'volume_id', 'id']);
  if (!volumeId) return null;

  const protoRaw =
    (raw['写作协议'] && typeof raw['写作协议'] === 'object' ? (raw['写作协议'] as Record<string, unknown>) : null) ??
    (raw['writingProtocol'] && typeof raw['writingProtocol'] === 'object'
      ? (raw['writingProtocol'] as Record<string, unknown>)
      : null);
  if (!protoRaw) return null;

  const pickArr = (key: string): string[] | undefined => {
    const v = protoRaw[key];
    if (Array.isArray(v)) {
      const items = v.map(x => String(x ?? '').trim()).filter(Boolean);
      return items.length ? items : undefined;
    }
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return undefined;
  };

  const protocol: VolumeWritingProtocol = {
    作品调性: pickArr('作品调性') ?? pickArr('tone'),
    叙事风格: pickArr('叙事风格') ?? pickArr('narrativeStyle'),
    对白原则: pickArr('对白原则') ?? pickArr('dialogueRules'),
    场景原则: pickArr('场景原则') ?? pickArr('sceneRules'),
  };

  // 全部为空时不挂
  if (!protocol.作品调性 && !protocol.叙事风格 && !protocol.对白原则 && !protocol.场景原则) {
    return null;
  }
  return { volumeId, protocol };
}

function toTitleRecord(raw: Record<string, unknown>): TargetStatus['titles'] {
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => {
      const detail = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      return [
        name,
        {
          effect: String(detail.effect ?? detail['效果'] ?? '暂无效果描述'),
          selfComment: String(detail.selfComment ?? detail['自我评价'] ?? '……'),
        },
      ];
    }),
  );
}

function toStringRecord(raw: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
}

function createIdFromName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || defaultTarget.id;
}

function getWorldbookEntryName(entry: WorldbookEntry) {
  return String(entry.name || entry.comment || entry.key?.[0] || '').trim();
}

function getBuiltInAvatarUrl(...texts: string[]) {
  const haystack = texts.join('\n').toLowerCase();
  return TARGET_AVATAR_RULES.find(rule => rule.patterns.some(pattern => haystack.includes(pattern.toLowerCase())))
    ?.avatarUrl;
}

function getTargetAvatarUrl(targetName: string, entry: WorldbookEntry) {
  // 中文注释：头像只按目标名和条目名判断；角色正文里会互相提到对方，不能拿正文抢头像优先级。
  return getBuiltInAvatarUrl(targetName, getWorldbookEntryName(entry));
}

function normalizeBuiltInTargetName(name: string, ...texts: string[]) {
  const haystack = [name, ...texts].join('\n').toLowerCase();
  // 中文注释：只用姓名、别名、条目名等身份字段归一化，避免正文里的“关系描述”把角色串成别人。
  if (/加藤|惠|恵|megumi|katou|kato/.test(haystack)) {
    return '加藤惠';
  }
  if (/英梨梨|泽村|澤村|eriri|sawamura/.test(haystack)) {
    return '泽村·斯宾塞·英梨梨';
  }
  // 中文注释：诗羽在世界书里可能写成“霞之诗羽”“霞诗子”或罗马音，这里统一回手机档案使用的标准名。
  if (/霞之丘|霞之诗羽|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(haystack)) {
    return '霞之丘诗羽';
  }
  // 中文注释：新增角色也必须在世界书身份字段阶段归一化，避免“联系人有了但变量键不稳”。
  if (/波岛|波島|出海|izumi|hashima/.test(haystack)) {
    return '波岛出海';
  }
  if (/冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(haystack)) {
    return '冰堂美智留';
  }
  return name;
}

// 从文本里提取班级信息。优先匹配显式写法"X年Y班"/"X年级Y班",
// 也支持"初中X年X班"这种前缀。返回规范化字符串如 "2年G班" / "3年F班"。
function extractClassName(...texts: string[]): string {
  const haystack = texts.filter(Boolean).join('\n');
  if (!haystack) return '';
  // 1. 直接模式:如"2年G班" / "二年级B班" / "3年级F班"
  const direct = haystack.match(/([一二三四五六七八九十\d]+)\s*年(?:级)?\s*([A-Za-z\d一二三四五六七八九十]+)\s*班/);
  if (direct) {
    const year = normalizeChineseNumber(direct[1]);
    const cls = direct[2].toUpperCase();
    return `${year}年${cls}班`;
  }
  // 2. 早应大学文学系 / XX学部 这种大学/学部模式,直接作为身份保留
  const dept = haystack.match(/([一-鿿]{2,6}大学[一-鿿]{1,10}(?:系|学部|学科))/);
  if (dept) return dept[1];
  return '';
}

function normalizeChineseNumber(raw: string): string {
  const map: Record<string, string> = {
    一: '1', 二: '2', 三: '3', 四: '4', 五: '5',
    六: '6', 七: '7', 八: '8', 九: '9', 十: '10',
  };
  if (/^\d+$/.test(raw)) return raw;
  if (map[raw]) return map[raw];
  // 十一 / 十二 → 11 / 12
  if (raw.startsWith('十') && raw.length === 2) return `1${map[raw[1]] ?? ''}`;
  return raw;
}

function parseJsonTarget(raw: Record<string, unknown>, entry: WorldbookEntry): TargetStatus | null {
  const kind = getStringField(raw, ['kind', 'type']);
  const name = getStringField(raw, ['name', '姓名']);
  if (kind !== TARGET_KIND && !name) return null;

  const alias = getStringField(raw, ['alias', '别名']);
  const entryName = getWorldbookEntryName(entry);
  const targetName = normalizeBuiltInTargetName(name || entryName || defaultTarget.name, alias, entryName);
  const titles = toTitleRecord(getRecordField(raw, 'titles'));
  const legacyTitles = toTitleRecord(getRecordField(raw, '称号'));
  const outfits = toStringRecord(getRecordField(raw, 'outfits'));
  const legacyOutfits = toStringRecord(getRecordField(raw, '着装'));
  const explicitClass =
    getStringField(raw, ['className', 'class', '班级']) ||
    extractClassName(entry.content, getStringField(raw, ['年龄', 'age']), getStringField(raw, ['身份', 'identity']));

  return {
    id: getStringField(raw, ['id']) || createIdFromName(targetName),
    name: targetName,
    alias: alias || undefined,
    affinity: defaultTarget.affinity,
    obsession: defaultTarget.obsession,
    stage: affinityStage(defaultTarget.affinity),
    obsessionStage: defaultTarget.obsessionStage,
    titles: Object.keys(titles).length ? titles : legacyTitles,
    outfits: {
      ...defaultTarget.outfits,
      ...legacyOutfits,
      ...outfits,
    },
    meta: {
      source: 'character-worldbook',
      worldbookEntryUid: entry.uid,
      worldbookEntryName: entryName,
      ...(explicitClass ? { className: explicitClass } : {}),
      ...(getTargetAvatarUrl(targetName, entry)
        ? { avatarUrl: getTargetAvatarUrl(targetName, entry) }
        : {}),
      ...(getRecordField(raw, 'meta')),
    },
  };
}

function parseTextTarget(entry: WorldbookEntry): TargetStatus | null {
  const entryName = getWorldbookEntryName(entry);
  if (/^\s*\[剧情]/.test(entryName) || !/姓名[:：]/.test(entry.content)) {
    return null;
  }

  const rawName = getTextField(entry.content, '姓名');
  const alias = getTextField(entry.content, '别名');
  const name = normalizeBuiltInTargetName(rawName, alias, entryName);
  if (!name) return null;
  const className = extractClassName(entry.content);

  return {
    id: createIdFromName(name),
    name,
    ...(alias ? { alias } : {}),
    affinity: defaultTarget.affinity,
    obsession: defaultTarget.obsession,
    stage: affinityStage(defaultTarget.affinity),
    obsessionStage: defaultTarget.obsessionStage,
    titles: {},
    outfits: { ...defaultTarget.outfits },
    meta: {
      source: 'character-worldbook',
      worldbookEntryUid: entry.uid,
      worldbookEntryName: entryName,
      ...(className ? { className } : {}),
      ...(getTargetAvatarUrl(name, entry) ? { avatarUrl: getTargetAvatarUrl(name, entry) } : {}),
    },
  };
}

function parseTargetEntry(entry: WorldbookEntry): TargetStatus | null {
  // 中文注释：disable 才是硬关闭；enabled=false 常只是选择性世界书当前未激活，角色档案仍要进入 targets 才能在空档期更新好感。
  if (entry.disable === true) return null;

  const extraTarget =
    entry.extra && typeof entry.extra === 'object' ? parseJsonTarget(entry.extra as Record<string, unknown>, entry) : null;
  if (extraTarget) return extraTarget;

  const jsonTarget = safeParseJson(entry.content);
  if (jsonTarget) {
    const parsed = parseJsonTarget(jsonTarget, entry);
    if (parsed) return parsed;
  }

  return parseTextTarget(entry);
}

function getBuiltInTargetKeyFromIdentity(target: TargetStatus) {
  // 中文注释：修复旧存档串位时，只看 target 自身身份字段；不要看 worldbookEntryName，否则旧的错误来源会继续污染变量合并。
  const haystack = [target.id, target.name, target.alias].map(value => String(value ?? '').toLowerCase()).join('\n');
  if (/加藤|惠|恵|megumi|katou|kato/.test(haystack)) return 'megumi';
  if (/英梨梨|泽村|澤村|eriri|sawamura/.test(haystack)) return 'eriri';
  if (/霞之丘|霞之诗羽|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(haystack)) return 'utaha';
  if (/波岛|波島|出海|izumi|hashima/.test(haystack)) return 'izumi';
  if (/冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(haystack)) return 'michiru';
  return '';
}

function canReuseExistingTargetVariables(worldbookTarget: TargetStatus, existing: TargetStatus) {
  const worldbookKey = getBuiltInTargetKeyFromIdentity(worldbookTarget);
  const existingKey = getBuiltInTargetKeyFromIdentity(existing);
  return !worldbookKey || !existingKey || worldbookKey === existingKey;
}

function repairKnownBuiltInTargetBleed(targets: TargetStatus[]) {
  const byKey = new Map<string, TargetStatus>();
  for (const target of targets) {
    const key = getBuiltInTargetKeyFromIdentity(target);
    if (key && !byKey.has(key)) byKey.set(key, target);
  }

  const megumi = byKey.get('megumi');
  const utaha = byKey.get('utaha');
  if (!megumi || !utaha) return targets;
  if (megumi.meta?.variableRepairVersion === 'megumi-utaha-bleed-v1') return targets;

  const sameAffinity = Number(megumi.affinity ?? 0) === Number(utaha.affinity ?? 0);
  const sameStage = String(megumi.stage ?? '') === String(utaha.stage ?? '');
  if (!sameAffinity || !sameStage || Number(megumi.affinity ?? 0) === 0) return targets;

  // 中文注释：旧版本曾把加藤惠条目归一成诗羽，导致诗羽好感被写进加藤惠；这里做一次性窄迁移。
  megumi.affinity = defaultTarget.affinity;
  megumi.stage = affinityStage(defaultTarget.affinity);
  megumi.meta = {
    ...(megumi.meta ?? {}),
    variableRepairVersion: 'megumi-utaha-bleed-v1',
  };
  return targets;
}

function isPlotCandidateEntry(entry: WorldbookEntry) {
  const entryName = getWorldbookEntryName(entry);
  return /^\s*\[剧情]/.test(entryName) || /^\s*\[plot]/i.test(entryName) || entry.content.includes('"事件链"');
}

function parsePlotEntry(entry: WorldbookEntry): {
  events: PlotEventCard[];
  protocols: Array<{ volumeId: string; protocol: VolumeWritingProtocol }>;
} {
  if (!isPlotCandidateEntry(entry)) return { events: [], protocols: [] };

  const extra = entry.extra && typeof entry.extra === 'object' ? parsePlotEventsFromJson(entry.extra, entry) : [];
  const json = safeParseJson(entry.content);
  const content = json ? parsePlotEventsFromJson(json, entry) : [];

  const protocols: Array<{ volumeId: string; protocol: VolumeWritingProtocol }> = [];
  if (entry.extra && typeof entry.extra === 'object') {
    const proto = parseVolumeWritingProtocol(entry.extra as Record<string, unknown>);
    if (proto) protocols.push(proto);
  }
  if (json) {
    const proto = parseVolumeWritingProtocol(json);
    if (proto) protocols.push(proto);
  }
  return { events: [...extra, ...content], protocols };
}

function createPlotLibrary(
  events: PlotEventCard[],
  protocols: Array<{ volumeId: string; protocol: VolumeWritingProtocol }> = [],
): PlotLibrary {
  const byId = new Map<string, PlotEventCard>();
  for (const event of events) {
    byId.set(event.id, event);
  }

  const writingProtocols: Record<string, VolumeWritingProtocol> = {};
  for (const { volumeId, protocol } of protocols) {
    writingProtocols[volumeId] = protocol;
  }

  return {
    events: Object.fromEntries(byId),
    sourceEntryNames: Array.from(new Set(events.map(event => event.sourceEntryName))),
    loadedAt: Date.now(),
    ...(Object.keys(writingProtocols).length ? { writingProtocols } : {}),
  };
}

export async function loadCharacterWorldbookData(win: TavernWindow): Promise<{
  targets: TargetStatus[];
  plotLibrary: PlotLibrary;
}> {
  if (typeof win.getWorldbook !== 'function') {
    return {
      targets: [],
      plotLibrary: createPlotLibrary([]),
    };
  }

  const names = getCurrentCharacterWorldbookNames(win);
  const targets: TargetStatus[] = [];
  const plotEvents: PlotEventCard[] = [];
  const plotProtocols: Array<{ volumeId: string; protocol: VolumeWritingProtocol }> = [];

  for (const name of names) {
    try {
      const entries = await win.getWorldbook(name);
      for (const entry of entries) {
        const target = parseTargetEntry(entry);
        if (target) {
          targets.push(target);
        }
        const plotResult = parsePlotEntry(entry);
        plotEvents.push(...plotResult.events);
        plotProtocols.push(...plotResult.protocols);
      }
    } catch {
      // 某个绑定世界书读取失败时，跳过它，不影响其他世界书。
    }
  }

  const byId = new Map<string, TargetStatus>();
  for (const target of targets) {
    byId.set(target.id, target);
  }
  return {
    targets: Array.from(byId.values()),
    plotLibrary: createPlotLibrary(plotEvents, plotProtocols),
  };
}

export async function loadCharacterWorldbookTargets(win: TavernWindow): Promise<TargetStatus[]> {
  return (await loadCharacterWorldbookData(win)).targets;
}

export function mergeWorldbookTargets(statusData: StatusData, worldbookTargets: TargetStatus[]): StatusData {
  if (!worldbookTargets.length) return statusData;

  const existingById = new Map(statusData.targets.map(target => [target.id, target]));
  const existingByName = new Map(statusData.targets.map(target => [target.name, target]));
  const existingByAlias = new Map(statusData.targets.filter(target => target.alias).map(target => [target.alias, target]));
  const existingByWorldbookUid = new Map(
    statusData.targets
      .filter(target => target.meta?.worldbookEntryUid !== undefined)
      .map(target => [String(target.meta?.worldbookEntryUid), target]),
  );
  const mergedTargets = worldbookTargets.map(worldbookTarget => {
    const existing =
      existingById.get(worldbookTarget.id) ??
      existingByName.get(worldbookTarget.name) ??
      (worldbookTarget.alias ? existingByAlias.get(worldbookTarget.alias) : undefined) ??
      (worldbookTarget.meta?.worldbookEntryUid !== undefined
        ? existingByWorldbookUid.get(String(worldbookTarget.meta.worldbookEntryUid))
        : undefined);
    if (!existing) return worldbookTarget;
    if (!canReuseExistingTargetVariables(worldbookTarget, existing)) return worldbookTarget;

    return {
      ...worldbookTarget,
      affinity: existing.affinity,
      obsession: existing.obsession,
      stage: existing.stage === defaultTarget.stage ? worldbookTarget.stage : existing.stage,
      obsessionStage:
        existing.obsessionStage === defaultTarget.obsessionStage ? worldbookTarget.obsessionStage : existing.obsessionStage,
      titles: {
        ...worldbookTarget.titles,
        ...existing.titles,
      },
      outfits: {
        ...worldbookTarget.outfits,
        ...existing.outfits,
      },
      meta: {
        ...(existing.meta ?? {}),
        // 中文注释：世界书目标信息是头像和来源的权威；否则旧存档里误判过的头像会一直覆盖新解析结果。
        ...(worldbookTarget.meta ?? {}),
      },
    };
  });

  const worldbookIds = new Set(mergedTargets.map(target => target.id));
  const customTargets = statusData.targets.filter(target => !worldbookIds.has(target.id) && target.id !== defaultTarget.id);
  const targets = repairKnownBuiltInTargetBleed([...mergedTargets, ...customTargets]);

  return {
    ...statusData,
    targets,
    // 中文注释：世界书只刷新目标数组，不把数组首项提升成默认变量目标。
    activeTargetId: null,
  };
}
