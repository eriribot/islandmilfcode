import type { StatusData, TargetStatus, TavernWindow, WorldbookEntry } from '../types';
import { defaultTarget } from '../variables/normalize';

const TARGET_KIND = 'islandmilfcode.target';
const LOADED_STAGE = '资料已载入';
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
    patterns: ['霞之丘诗羽', '霞ヶ丘詩羽', '诗羽', 'utaha', 'kasumigaoka'],
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

function getStringField(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function getNumberField(raw: Record<string, unknown>, keys: string[], fallback: number) {
  for (const key of keys) {
    const value = raw[key];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(100, parsed));
    }
  }
  return fallback;
}

function getRecordField(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

function parseJsonTarget(raw: Record<string, unknown>, entry: WorldbookEntry): TargetStatus | null {
  const kind = getStringField(raw, ['kind', 'type']);
  const name = getStringField(raw, ['name', '姓名']);
  if (kind !== TARGET_KIND && !name) return null;

  const targetName = name || entry.name || defaultTarget.name;
  const titles = toTitleRecord(getRecordField(raw, 'titles'));
  const legacyTitles = toTitleRecord(getRecordField(raw, '称号'));
  const outfits = toStringRecord(getRecordField(raw, 'outfits'));
  const legacyOutfits = toStringRecord(getRecordField(raw, '着装'));

  return {
    id: getStringField(raw, ['id']) || createIdFromName(targetName),
    name: targetName,
    alias: getStringField(raw, ['alias', '别名']) || undefined,
    affinity: getNumberField(raw, ['affinity', '好感度'], defaultTarget.affinity),
    stage: getStringField(raw, ['stage', '阶段']) || defaultTarget.stage,
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
      ...(getBuiltInAvatarUrl(targetName, entry.name, entry.content)
        ? { avatarUrl: getBuiltInAvatarUrl(targetName, entry.name, entry.content) }
        : {}),
      ...(getRecordField(raw, 'meta')),
    },
  };
}

function parseTextTarget(entry: WorldbookEntry): TargetStatus | null {
  if (/^\s*\[剧情]/.test(entry.name) || !/姓名[:：]/.test(entry.content)) {
    return null;
  }

  const name = entry.content.match(/姓名[:：]\s*([^\n]+)/)?.[1]?.trim();
  if (!name) return null;

  return {
    id: createIdFromName(name),
    name,
    affinity: defaultTarget.affinity,
    stage: LOADED_STAGE,
    titles: {},
    outfits: { ...defaultTarget.outfits },
    meta: {
      source: 'character-worldbook',
      worldbookEntryUid: entry.uid,
      worldbookEntryName: entry.name,
      ...(getBuiltInAvatarUrl(name, entry.name, entry.content) ? { avatarUrl: getBuiltInAvatarUrl(name, entry.name, entry.content) } : {}),
    },
  };
}

function parseTargetEntry(entry: WorldbookEntry): TargetStatus | null {
  if (!entry.enabled) return null;

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

export async function loadCharacterWorldbookTargets(win: TavernWindow): Promise<TargetStatus[]> {
  if (typeof win.getWorldbook !== 'function') {
    return [];
  }

  const names = getCurrentCharacterWorldbookNames(win);
  const targets: TargetStatus[] = [];

  for (const name of names) {
    try {
      const entries = await win.getWorldbook(name);
      for (const entry of entries) {
        const target = parseTargetEntry(entry);
        if (target) {
          targets.push(target);
        }
      }
    } catch {
      // 某个绑定世界书读取失败时，跳过它，不影响其他世界书。
    }
  }

  const byId = new Map<string, TargetStatus>();
  for (const target of targets) {
    byId.set(target.id, target);
  }
  return Array.from(byId.values());
}

export function mergeWorldbookTargets(statusData: StatusData, worldbookTargets: TargetStatus[]): StatusData {
  if (!worldbookTargets.length) return statusData;

  const existingById = new Map(statusData.targets.map(target => [target.id, target]));
  const existingByName = new Map(statusData.targets.map(target => [target.name, target]));
  const mergedTargets = worldbookTargets.map(worldbookTarget => {
    const existing = existingById.get(worldbookTarget.id) ?? existingByName.get(worldbookTarget.name);
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
        ...(worldbookTarget.meta ?? {}),
        ...(existing.meta ?? {}),
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
