import type { PlotEventCard, PlotEventSchedule, PlotLibrary, StatusData, TargetStatus, TavernWindow, WorldbookEntry } from '../types';
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

  return { date, timeSegments, locations };
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
    sourceEntryName: entry.name,
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

function getBuiltInAvatarUrl(...texts: string[]) {
  const haystack = texts.join('\n').toLowerCase();
  return TARGET_AVATAR_RULES.find(rule => rule.patterns.some(pattern => haystack.includes(pattern.toLowerCase())))
    ?.avatarUrl;
}

function getTargetAvatarUrl(targetName: string, entry: WorldbookEntry) {
  // 中文注释：头像先按目标名和条目名判断；正文里会出现其他角色关系描述，不能用来抢优先级。
  return getBuiltInAvatarUrl(targetName, entry.name) ?? getBuiltInAvatarUrl(entry.content);
}

function normalizeBuiltInTargetName(name: string, ...texts: string[]) {
  const haystack = [name, ...texts].join('\n').toLowerCase();
  // 中文注释：诗羽在世界书里可能写成“霞之诗羽”“霞诗子”或罗马音，这里统一回手机档案使用的标准名。
  if (/霞之丘|霞之诗羽|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(haystack)) {
    return '霞之丘诗羽';
  }
  return name;
}

function parseJsonTarget(raw: Record<string, unknown>, entry: WorldbookEntry): TargetStatus | null {
  const kind = getStringField(raw, ['kind', 'type']);
  const name = getStringField(raw, ['name', '姓名']);
  if (kind !== TARGET_KIND && !name) return null;

  const targetName = normalizeBuiltInTargetName(name || entry.name || defaultTarget.name, entry.name, entry.content);
  const titles = toTitleRecord(getRecordField(raw, 'titles'));
  const legacyTitles = toTitleRecord(getRecordField(raw, '称号'));
  const outfits = toStringRecord(getRecordField(raw, 'outfits'));
  const legacyOutfits = toStringRecord(getRecordField(raw, '着装'));

  return {
    id: getStringField(raw, ['id']) || createIdFromName(targetName),
    name: targetName,
    alias: getStringField(raw, ['alias', '别名']) || undefined,
    affinity: defaultTarget.affinity,
    stage: affinityStage(defaultTarget.affinity),
    titles: Object.keys(titles).length ? titles : legacyTitles,
    outfits: {
      ...defaultTarget.outfits,
      ...legacyOutfits,
      ...outfits,
    },
    meta: {
      source: 'character-worldbook',
      worldbookEntryUid: entry.uid,
      worldbookEntryName: entry.name,
      ...(getTargetAvatarUrl(targetName, entry)
        ? { avatarUrl: getTargetAvatarUrl(targetName, entry) }
        : {}),
      ...(getRecordField(raw, 'meta')),
    },
  };
}

function parseTextTarget(entry: WorldbookEntry): TargetStatus | null {
  if (/^\s*\[剧情]/.test(entry.name) || !/姓名[:：]/.test(entry.content)) {
    return null;
  }

  const rawName = getTextField(entry.content, '姓名');
  const name = normalizeBuiltInTargetName(rawName, entry.name, entry.content);
  if (!name) return null;
  const alias = getTextField(entry.content, '别名');

  return {
    id: createIdFromName(name),
    name,
    ...(alias ? { alias } : {}),
    affinity: defaultTarget.affinity,
    stage: affinityStage(defaultTarget.affinity),
    titles: {},
    outfits: { ...defaultTarget.outfits },
    meta: {
      source: 'character-worldbook',
      worldbookEntryUid: entry.uid,
      worldbookEntryName: entry.name,
      ...(getTargetAvatarUrl(name, entry) ? { avatarUrl: getTargetAvatarUrl(name, entry) } : {}),
    },
  };
}

function parseTargetEntry(entry: WorldbookEntry): TargetStatus | null {
  const rawEntry = entry as WorldbookEntry & { disable?: boolean };
  // 中文注释：不同酒馆 API 可能返回 enabled 或 disable；缺省时按启用处理，避免正常条目被误判为关闭。
  if (rawEntry.enabled === false || rawEntry.disable === true) return null;

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

function isPlotCandidateEntry(entry: WorldbookEntry) {
  return /^\s*\[剧情]/.test(entry.name) || /^\s*\[plot]/i.test(entry.name) || entry.content.includes('"事件链"');
}

function parsePlotEntry(entry: WorldbookEntry): PlotEventCard[] {
  if (!isPlotCandidateEntry(entry)) return [];

  const extra = entry.extra && typeof entry.extra === 'object' ? parsePlotEventsFromJson(entry.extra, entry) : [];
  const json = safeParseJson(entry.content);
  const content = json ? parsePlotEventsFromJson(json, entry) : [];
  return [...extra, ...content];
}

function createPlotLibrary(events: PlotEventCard[]): PlotLibrary {
  const byId = new Map<string, PlotEventCard>();
  for (const event of events) {
    byId.set(event.id, event);
  }

  return {
    events: Object.fromEntries(byId),
    sourceEntryNames: Array.from(new Set(events.map(event => event.sourceEntryName))),
    loadedAt: Date.now(),
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

  for (const name of names) {
    try {
      const entries = await win.getWorldbook(name);
      for (const entry of entries) {
        const target = parseTargetEntry(entry);
        if (target) {
          targets.push(target);
        }
        plotEvents.push(...parsePlotEntry(entry));
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
    plotLibrary: createPlotLibrary(plotEvents),
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

    return {
      ...worldbookTarget,
      affinity: existing.affinity,
      stage: existing.stage === defaultTarget.stage ? worldbookTarget.stage : existing.stage,
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
  const targets = [...mergedTargets, ...customTargets];

  return {
    ...statusData,
    targets,
    activeTargetId:
      statusData.activeTargetId && targets.some(target => target.id === statusData.activeTargetId)
        ? statusData.activeTargetId
        : targets[0]?.id ?? null,
  };
}
