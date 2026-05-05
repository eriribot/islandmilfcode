import type { StatusData, TargetStatus } from '../types';
import { defaultStatusData, defaultTarget } from './defaults';
import { affinityStage, clamp } from './format';

function normalizeTarget(raw: Record<string, any>, fallback: TargetStatus): TargetStatus {
  const affinity = clamp(Number(raw?.affinity ?? fallback.affinity) || 0, 0, 100);
  const titlesInput = raw?.titles ?? {};
  const outfitsInput = raw?.outfits ?? {};

  return {
    id: String(raw?.id ?? fallback.id),
    name: String(raw?.name ?? fallback.name),
    alias: raw?.alias ?? fallback.alias,
    affinity,
    stage: String(raw?.stage ?? affinityStage(affinity)),
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
    meta: raw?.meta,
  };
}

function normalizeWorld(raw: Record<string, any>) {
  const eventsInput = raw?.world?.recentEvents ?? {};
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
    recentEvents: Object.fromEntries(
      Object.entries(eventsInput)
        .filter(([key]) => Boolean(key))
        .map(([key, value]) => [String(key), String(value)]),
    ),
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

export function normalizeStatusData(input: unknown): StatusData {
  const raw = typeof input === 'object' && input ? (input as Record<string, any>) : {};
  const targets: TargetStatus[] = Array.isArray(raw.targets)
    ? raw.targets.map((t: any) => normalizeTarget(t, defaultTarget))
    : [];

  return {
    world: normalizeWorld(raw),
    targets: targets.length ? targets : [{ ...defaultTarget }],
    activeTargetId: raw.activeTargetId ?? targets[0]?.id ?? defaultTarget.id,
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
      stage: target.stage,
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
