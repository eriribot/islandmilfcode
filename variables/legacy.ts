import type { StatusData, TargetStatus } from '../types';
import { defaultStatusData, defaultTarget } from './defaults';
import { affinityStage, clamp } from './format';

function normalizeTarget(raw: Record<string, any>, fallback: TargetStatus): TargetStatus {
  const affinity = clamp(Number(raw?.依存度 ?? raw?.dependency ?? raw?.affinity ?? fallback.affinity) || 0, 0, 100);
  const titlesInput = raw?.称号 ?? raw?.titles ?? {};
  const outfitsInput = raw?.着装 ?? raw?.outfits ?? {};

  return {
    id: String(raw?.id ?? fallback.id),
    name: String(raw?.name ?? fallback.name),
    alias: raw?.alias ?? fallback.alias,
    affinity,
    stage: String(raw?.$依存度阶段 ?? raw?.stage ?? affinityStage(affinity)),
    titles: Object.fromEntries(
      Object.entries(titlesInput)
        .filter(([key]) => Boolean(key))
        .map(([key, value]) => [
          String(key),
          {
            effect: String((value as any)?.效果 ?? (value as any)?.effect ?? '暂无效果描述'),
            selfComment: String((value as any)?.自我评价 ?? (value as any)?.selfComment ?? '……'),
          },
        ]),
    ),
    outfits: Object.fromEntries(
      Object.entries({ ...fallback.outfits, ...outfitsInput }).map(([key, value]) => [key, String(value)]),
    ),
    meta: raw?.meta,
  };
}

function findLegacyTargetEntry(raw: Record<string, any>): { name: string; value: Record<string, any> } | null {
  for (const key of ['白娅', 'baiya']) {
    const value = raw[key];
    if (value && typeof value === 'object') {
      return { name: key, value: value as Record<string, any> };
    }
  }

  const ignoredKeys = new Set(['世界', 'world', '主角', 'player', 'targets', 'activeTargetId']);
  for (const [key, value] of Object.entries(raw)) {
    if (ignoredKeys.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const looksLikeTarget =
      '依存度' in value ||
      'dependency' in value ||
      'affinity' in value ||
      '着装' in value ||
      'outfits' in value ||
      '称号' in value ||
      'titles' in value;
    if (looksLikeTarget) {
      return { name: key, value: value as Record<string, any> };
    }
  }

  return null;
}

function normalizeWorld(raw: Record<string, any>) {
  const eventsInput = raw?.世界?.近期事务 ?? raw?.world?.recentEvents ?? {};
  return {
    currentTime: String(raw?.世界?.当前时间 ?? raw?.world?.currentTime ?? defaultStatusData.world.currentTime),
    currentLocation: String(
      raw?.世界?.当前地点 ?? raw?.world?.currentLocation ?? defaultStatusData.world.currentLocation,
    ),
    recentEvents: Object.fromEntries(
      Object.entries(eventsInput)
        .filter(([key]) => Boolean(key))
        .map(([key, value]) => [String(key), String(value)]),
    ),
  };
}

function normalizePlayer(raw: Record<string, any>) {
  const inventoryInput = raw?.主角?.物品栏 ?? raw?.player?.inventory ?? {};
  return {
    inventory: Object.fromEntries(
      Object.entries(inventoryInput)
        .map(([key, value]) => [
          String(key),
          {
            description: String((value as any)?.描述 ?? (value as any)?.description ?? '暂无描述'),
            count: Math.max(0, Number((value as any)?.数量 ?? (value as any)?.count ?? 0) || 0),
          },
        ])
        .filter(([, item]) => (item as { count: number }).count > 0),
    ),
  };
}

export function normalizeStatusData(input: unknown): StatusData {
  const raw = typeof input === 'object' && input ? (input as Record<string, any>) : {};

  if (Array.isArray(raw.targets)) {
    const targets: TargetStatus[] = raw.targets.map((t: any) => normalizeTarget(t, defaultTarget));
    return {
      world: normalizeWorld(raw),
      targets: targets.length ? targets : [{ ...defaultTarget }],
      activeTargetId: raw.activeTargetId ?? targets[0]?.id ?? defaultTarget.id,
      player: normalizePlayer(raw),
    };
  }

  const legacyTarget = findLegacyTargetEntry(raw);
  const targetRaw = legacyTarget?.value ?? {};
  const target = normalizeTarget(
    {
      ...targetRaw,
      id: targetRaw.id ?? legacyTarget?.name ?? defaultTarget.id,
      name: targetRaw.name ?? legacyTarget?.name ?? defaultTarget.name,
    },
    defaultTarget,
  );

  return {
    world: normalizeWorld(raw),
    targets: [target],
    activeTargetId: target.id,
    player: normalizePlayer(raw),
  };
}

export function serializeStatusData(statusData: StatusData): Record<string, any> {
  const target = statusData.targets[0];
  const player = {
    物品栏: Object.fromEntries(
      Object.entries(statusData.player.inventory).map(([name, detail]) => [
        name,
        { 描述: detail.description, 数量: detail.count },
      ]),
    ),
  };
  const world = {
    当前时间: statusData.world.currentTime,
    当前地点: statusData.world.currentLocation,
    近期事务: statusData.world.recentEvents,
  };

  if (!target) {
    return {
      世界: world,
      主角: player,
    };
  }

  return {
    世界: world,
    [target.name]: {
      依存度: target.affinity,
      $依存度阶段: target.stage,
      着装: target.outfits,
      称号: Object.fromEntries(
        Object.entries(target.titles).map(([name, detail]) => [
          name,
          { 效果: detail.effect, 自我评价: detail.selfComment },
        ]),
      ),
    },
    主角: player,
  };
}
