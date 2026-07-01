import type { StatusData, TargetStatus } from '../types';
import { builtInTargetSeeds, defaultStatusData, defaultTarget } from './defaults';
import { affinityStage, clamp, obsessionStage } from './format';

const LEGACY_IZUMI_FILM_AVATAR_URL = 'https://eriribot.github.io/islandmilfcode/picresource/izumi_film.jpg';
const IZUMI_PHONE_AVATAR_URL = 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg';
const OBSESSION_SEED_VERSION = 'renya-obsession-seed-v1';

function normalizeTargetMeta(rawMeta: unknown): Record<string, unknown> | undefined {
  // 中文注释：meta 只接受普通对象，旧数据里的空值或非对象不再原样塞回 TargetStatus。
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) return undefined;

  const meta = { ...(rawMeta as Record<string, unknown>) };
  if (meta.avatarUrl === LEGACY_IZUMI_FILM_AVATAR_URL) {
    meta.avatarUrl = IZUMI_PHONE_AVATAR_URL;
  }
  return meta;
}

function getBuiltInTargetKeyFromValues(id: unknown, name: unknown, alias: unknown, worldbookEntryName: unknown) {
  const identityHaystack = [id, name, worldbookEntryName].map(value => String(value ?? '').toLowerCase()).join('\n');
  const haystack = [identityHaystack, alias].map(value => String(value ?? '').toLowerCase()).join('\n');
  if (/泽村小百合|澤村小百合|小百合|sayuri/.test(identityHaystack)) return 'sayuri';
  if (/町田苑子|町田|苑子|まちだそのこ|sonoko|machida/.test(haystack)) return 'sonoko';
  if (/加藤|惠|恵|megumi|katou|kato/.test(haystack)) return 'megumi';
  if (/英梨梨|泽村|澤村|eriri|sawamura/.test(haystack)) return 'eriri';
  if (/霞之丘|霞之诗羽|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(haystack)) return 'utaha';
  if (/波岛|波島|出海|izumi|hashima/.test(haystack)) return 'izumi';
  if (/冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(haystack)) return 'michiru';
  if (/西宫硝子|西宮硝子|西宫|西宮|硝子|shoko|shouko|nishimiya/.test(haystack)) return 'shoko';
  if (/高坂茜|红坂朱音|紅坂朱音|高坂|红坂|紅坂|朱音|茜|akane|kosaka|kousaka|kurenai/.test(identityHaystack)) return 'akane';
  return '';
}

function normalizeTarget(raw: Record<string, any>, fallback: TargetStatus): TargetStatus {
  const affinity = clamp(Number(raw?.affinity ?? fallback.affinity) || 0, 0, 100);
  const identityKey = getBuiltInTargetKeyFromValues(raw?.id, raw?.name, raw?.alias, raw?.meta?.worldbookEntryName);
  const builtInFallback = builtInTargetSeeds.find(seed => getBuiltInTargetKey(seed) === identityKey);
  const obsessionFallback = builtInFallback?.obsession ?? fallback.obsession ?? 0;
  const rawMeta = normalizeTargetMeta(raw?.meta);
  const hasExplicitObsession = Object.prototype.hasOwnProperty.call(raw ?? {}, 'obsession');
  const shouldSeedObsession =
    Boolean(builtInFallback) &&
    !hasExplicitObsession &&
    rawMeta?.obsessionSeedVersion !== OBSESSION_SEED_VERSION &&
    rawMeta?.source !== 'character-worldbook';
  const obsessionSource = hasExplicitObsession
    ? raw?.obsession
    : shouldSeedObsession
      ? obsessionFallback
      : fallback.obsession;
  const obsession = clamp(Number(obsessionSource ?? obsessionFallback) || 0, 0, 100);
  const titlesInput = raw?.titles ?? {};
  const outfitsInput = raw?.outfits ?? {};

  return {
    id: String(raw?.id ?? fallback.id),
    name: String(raw?.name ?? fallback.name),
    alias: raw?.alias ?? fallback.alias,
    affinity,
    obsession,
    stage: String(raw?.stage ?? affinityStage(affinity)),
    obsessionStage: shouldSeedObsession ? obsessionStage(obsession) : String(raw?.obsessionStage ?? obsessionStage(obsession)),
    titles: Object.fromEntries(
      Object.entries(titlesInput)
        .filter(([key]) => Boolean(key))
        .map(([key, value]) => [
          String(key),
          {
            effect: String((value as any)?.effect ?? '暂无效果描述'),
            selfComment: String((value as any)?.selfComment ?? '……'),
          },
        ]),
    ),
    outfits: Object.fromEntries(
      Object.entries({ ...fallback.outfits, ...outfitsInput }).map(([key, value]) => [key, String(value)]),
    ),
    meta: rawMeta || shouldSeedObsession ? {
      ...(rawMeta ?? {}),
      ...(shouldSeedObsession ? { obsessionSeedVersion: OBSESSION_SEED_VERSION } : {}),
    } : undefined,
  };
}

function normalizeWorld(raw: Record<string, any>) {
  const mainEventsInput = raw?.world?.mainEvents ?? {};
  return {
    currentTime: String(raw?.world?.currentTime ?? defaultStatusData.world.currentTime),
    currentLocation: String(raw?.world?.currentLocation ?? defaultStatusData.world.currentLocation),
    currentMainEventId: String(raw?.world?.currentMainEventId ?? defaultStatusData.world.currentMainEventId ?? ''),
    mainEvents: {
      ...defaultStatusData.world.mainEvents,
      ...Object.fromEntries(
        Object.entries(mainEventsInput)
          .filter(([key]) => Boolean(key))
          .map(([key, value]) => [String(key), String(value)]),
      ),
    },
    // recentEvents is a transient prompt signal. Do not revive stale entries from saves/snapshots.
    recentEvents: {},
  };
}

function normalizePlayer(raw: Record<string, any>) {
  const inventoryInput = raw?.player?.inventory ?? {};
  return {
    inventory: Object.fromEntries(
      Object.entries(inventoryInput)
        .map(([key, value]) => [
          String(key),
          {
            description: String((value as any)?.description ?? '暂无描述'),
            count: Math.max(0, Number((value as any)?.count ?? 0) || 0),
          },
        ])
        .filter(([, item]) => (item as { count: number }).count > 0),
    ),
  };
}

function getBuiltInTargetKey(target: TargetStatus) {
  return getBuiltInTargetKeyFromValues(target.id, target.name, target.alias, target.meta?.worldbookEntryName);
}

function mergeBuiltInTargetSeeds(targets: TargetStatus[]) {
  // 中文注释：旧存档可能只有部分角色；这里补齐内置角色变量，但绝不覆盖已有好感和阶段。
  const nextTargets = targets.filter(target => target.id !== defaultTarget.id || targets.length === 1);
  const existingKeys = new Set(nextTargets.map(getBuiltInTargetKey).filter(Boolean));
  const existingIds = new Set(nextTargets.map(target => target.id));

  for (const seed of builtInTargetSeeds) {
    const seedKey = getBuiltInTargetKey(seed);
    if ((seedKey && existingKeys.has(seedKey)) || existingIds.has(seed.id)) continue;
    nextTargets.push(normalizeTarget(seed, defaultTarget));
    if (seedKey) existingKeys.add(seedKey);
    existingIds.add(seed.id);
  }

  return nextTargets.filter(target => target.id !== defaultTarget.id || nextTargets.length === 1);
}

export function normalizeStatusData(input: unknown): StatusData {
  const raw = typeof input === 'object' && input ? (input as Record<string, any>) : {};
  const rawTargets: TargetStatus[] = Array.isArray(raw.targets)
    ? raw.targets.map((t: any) => normalizeTarget(t, defaultTarget))
    : [];
  const targets = mergeBuiltInTargetSeeds(rawTargets.length ? rawTargets : builtInTargetSeeds);
  // 中文注释：旧存档里的 activeTargetId 多数来自历史默认值，读取时清空，避免继续污染变量更新。
  const activeTargetId = null;

  return {
    world: normalizeWorld(raw),
    targets: targets.length ? targets : [],
    activeTargetId,
    player: normalizePlayer(raw),
  };
}

export function serializeStatusData(statusData: StatusData): Record<string, any> {
  return {
    world: {
      currentTime: statusData.world.currentTime,
      currentLocation: statusData.world.currentLocation,
      currentMainEventId: statusData.world.currentMainEventId,
      mainEvents: statusData.world.mainEvents,
      recentEvents: statusData.world.recentEvents,
    },
    targets: statusData.targets.map(target => ({
      id: target.id,
      name: target.name,
      ...(target.alias ? { alias: target.alias } : {}),
      affinity: target.affinity,
      obsession: target.obsession,
      stage: target.stage,
      obsessionStage: target.obsessionStage,
      titles: target.titles,
      outfits: target.outfits,
      ...(target.meta ? { meta: target.meta } : {}),
    })),
    activeTargetId: statusData.activeTargetId,
    player: {
      inventory: Object.fromEntries(
        Object.entries(statusData.player.inventory).map(([name, detail]) => [
          name,
          { description: detail.description, count: detail.count },
        ]),
      ),
    },
  };
}
