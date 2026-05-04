import type { ProgressUpdate } from '../message-format';
import type { StatusData } from '../types';
import { affinityStage, clamp } from './format';

export { defaultStatusData, defaultTarget } from './defaults';
export {
  affinityStage,
  clamp,
  dependencyStage,
  formatDate,
  formatTime,
  getInventoryIcon,
} from './format';
export { normalizeStatusData, serializeStatusData } from './legacy';

const MAX_RECENT_EVENTS = 5;

const MAIN_EVENT_SCHEDULE = [
  {
    id: 'SAE_01-1',
    date: '2012-03-31',
    timeSegments: ['早晨'],
    locations: ['侦探坡'],
  },
  {
    id: 'SAE_01-2',
    date: '2012-04-05',
    timeSegments: ['早晨'],
    locations: ['丰之崎学园'],
  },
] as const;

function getDatePart(value: string) {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

function getMinutesPart(value: string) {
  const match = value.match(/\b(\d{2}):(\d{2})\b/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getTimeSegment(value: string) {
  if (value.includes('清晨')) return '清晨';
  if (value.includes('早晨')) return '早晨';
  if (value.includes('上午')) return '上午';
  if (value.includes('午休')) return '午休';
  if (value.includes('下午')) return '下午';
  if (value.includes('放学后')) return '放学后';
  if (value.includes('傍晚')) return '傍晚';
  if (value.includes('夜晚')) return '夜晚';
  if (value.includes('深夜')) return '深夜';

  const minutes = getMinutesPart(value);
  if (minutes == null) return '';
  if (minutes < 5 * 60) return '深夜';
  if (minutes < 8 * 60) return '清晨';
  if (minutes < 12 * 60) return '早晨';
  if (minutes < 13 * 60) return '午休';
  if (minutes < 16 * 60) return '下午';
  if (minutes < 18 * 60) return '放学后';
  if (minutes < 21 * 60) return '傍晚';
  return '夜晚';
}

function compareDate(a: string, b: string) {
  return a.localeCompare(b);
}

export function syncMainEvents(statusData: StatusData): boolean {
  const mainEvents = (statusData.world.mainEvents ??= {});
  const currentDate = getDatePart(statusData.world.currentTime);
  const currentSegment = getTimeSegment(statusData.world.currentTime);
  const currentLocation = statusData.world.currentLocation;
  let changed = false;

  for (const event of MAIN_EVENT_SCHEDULE) {
    const status = mainEvents[event.id] ?? '未触发';
    if (status !== '未触发') continue;

    if (currentDate === event.date) {
      const timeMatches =
        !event.timeSegments.length || (event.timeSegments as readonly string[]).includes(currentSegment);
      const locationMatches =
        !event.locations.length || event.locations.some(location => currentLocation.includes(location));
      if (timeMatches && locationMatches) {
        mainEvents[event.id] = '进行中';
        changed = true;
      }
      continue;
    }

    if (currentDate && compareDate(currentDate, event.date) > 0) {
      mainEvents[event.id] = '延后';
      changed = true;
    }
  }

  return changed;
}

export function applyProgressUpdate(statusData: StatusData, update: ProgressUpdate, targetId = statusData.activeTargetId): void {
  if (update.time) {
    statusData.world.currentTime = update.time;
  }
  if (update.location) {
    statusData.world.currentLocation = update.location;
  }

  if (update.affinityDelta !== undefined && update.affinityDelta !== 0) {
    const target = statusData.targets.find(t => t.id === targetId);
    if (target) {
      target.affinity = clamp((target.affinity ?? 0) + update.affinityDelta, 0, 100);
      target.stage = affinityStage(target.affinity);
    }
  }

  if (Object.keys(update.outfitChanges).length) {
    const target = statusData.targets.find(t => t.id === targetId);
    if (target) {
      for (const [part, desc] of Object.entries(update.outfitChanges)) {
        target.outfits[part] = desc;
      }
    }
  }

  if (Object.keys(update.events).length) {
    const merged = { ...update.events, ...statusData.world.recentEvents };
    const entries = Object.entries(merged).slice(0, MAX_RECENT_EVENTS);
    statusData.world.recentEvents = Object.fromEntries(entries);
  }

  if (Object.keys(update.mainEvents ?? {}).length) {
    statusData.world.mainEvents = {
      ...(statusData.world.mainEvents ?? {}),
      ...update.mainEvents,
    };
  }

  for (const item of update.itemsGained) {
    const existing = statusData.player.inventory[item.name];
    if (existing) {
      existing.count += item.count;
      if (item.description) existing.description = item.description;
    } else {
      statusData.player.inventory[item.name] = {
        description: item.description || '暂无描述',
        count: item.count,
      };
    }
  }

  for (const name of update.itemsLost) {
    delete statusData.player.inventory[name];
  }

  syncMainEvents(statusData);
}
