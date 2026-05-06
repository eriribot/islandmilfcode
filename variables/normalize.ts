import type { ProgressUpdate } from '../message-format';
import type { PlotEventCard, PlotLibrary, StatusData } from '../types';
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

type ScheduledEvent = {
  id: string;
  date: string;
  timeSegments: string[];
  locations: string[];
};

const FINISHED_MAIN_EVENT_STATUSES = new Set(['已结束', '跳过', '延后']);

function buildSchedule(plotLibrary: PlotLibrary | null | undefined): ScheduledEvent[] {
  if (!plotLibrary) return [];
  const events = Object.values(plotLibrary.events)
    .filter((event): event is PlotEventCard & { schedule: NonNullable<PlotEventCard['schedule']> } =>
      Boolean(event.schedule?.date),
    )
    .map(event => ({
      id: event.id,
      date: event.schedule.date,
      timeSegments: event.schedule.timeSegments ?? [],
      locations: event.schedule.locations ?? [],
    }));
  events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return events;
}

function getMainEventOrder(schedule: ScheduledEvent[], id: string) {
  return schedule.findIndex(event => event.id === id);
}

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

function eventMatchesCurrentState(
  event: ScheduledEvent,
  currentDate: string,
  currentSegment: string,
  currentLocation: string,
) {
  if (currentDate !== event.date) return false;
  const timeMatches = !event.timeSegments.length || event.timeSegments.includes(currentSegment);
  const locationMatches = !event.locations.length || event.locations.some(location => currentLocation.includes(location));
  return timeMatches && locationMatches;
}

function getScheduledCurrentMainEventId(statusData: StatusData, schedule: ScheduledEvent[]) {
  const currentDate = getDatePart(statusData.world.currentTime);
  const currentSegment = getTimeSegment(statusData.world.currentTime);
  const currentLocation = statusData.world.currentLocation;
  return (
    schedule.find(event =>
      eventMatchesCurrentState(event, currentDate, currentSegment, currentLocation),
    )?.id ?? ''
  );
}

function syncCurrentMainEvent(statusData: StatusData, schedule: ScheduledEvent[]): boolean {
  const mainEvents = (statusData.world.mainEvents ??= {});
  let changed = false;
  if (statusData.world.currentMainEventId === undefined) {
    statusData.world.currentMainEventId = '';
    changed = true;
  }
  const currentId = statusData.world.currentMainEventId ?? '';

  // 当前事件是手机和提示词使用的权威游标；历史状态允许保留多个"进行中"，但游标只能指向一个。
  if (currentId && mainEvents[currentId] !== '进行中') {
    statusData.world.currentMainEventId = '';
    changed = true;
  }

  const scheduledId = getScheduledCurrentMainEventId(statusData, schedule);
  if (scheduledId && !FINISHED_MAIN_EVENT_STATUSES.has(mainEvents[scheduledId] ?? '未触发')) {
    if (mainEvents[scheduledId] !== '进行中') {
      mainEvents[scheduledId] = '进行中';
      changed = true;
    }
    if (statusData.world.currentMainEventId !== scheduledId) {
      statusData.world.currentMainEventId = scheduledId;
      changed = true;
    }
  }

  if (!statusData.world.currentMainEventId) {
    const fallbackId =
      Object.entries(mainEvents)
        .filter(([, status]) => status === '进行中')
        .sort(([a], [b]) => getMainEventOrder(schedule, b) - getMainEventOrder(schedule, a))[0]?.[0] ?? '';
    if (fallbackId) {
      statusData.world.currentMainEventId = fallbackId;
      changed = true;
    }
  }

  return changed;
}

function closeEarlierRunningMainEvents(
  statusData: StatusData,
  currentId: string,
  schedule: ScheduledEvent[],
): boolean {
  const currentOrder = getMainEventOrder(schedule, currentId);
  if (currentOrder < 0) return false;

  let changed = false;
  const mainEvents = (statusData.world.mainEvents ??= {});
  for (const event of schedule.slice(0, currentOrder)) {
    // 主线按时间线强覆盖：后续事件进入进行中后，前序仍卡在"进行中"的旧事件自动结算。
    if (mainEvents[event.id] === '进行中') {
      mainEvents[event.id] = '已结束';
      changed = true;
    }
  }

  return changed;
}

export function syncMainEvents(statusData: StatusData, plotLibrary?: PlotLibrary | null): boolean {
  const schedule = buildSchedule(plotLibrary);
  const mainEvents = (statusData.world.mainEvents ??= {});
  const currentDate = getDatePart(statusData.world.currentTime);
  const currentSegment = getTimeSegment(statusData.world.currentTime);
  const currentLocation = statusData.world.currentLocation;
  let changed = false;

  for (const event of schedule) {
    const status = mainEvents[event.id] ?? '未触发';
    if (status !== '未触发') continue;

    if (eventMatchesCurrentState(event, currentDate, currentSegment, currentLocation)) {
      mainEvents[event.id] = '进行中';
      statusData.world.currentMainEventId = event.id;
      changed = true;
      continue;
    }

    if (currentDate && compareDate(currentDate, event.date) > 0) {
      mainEvents[event.id] = '延后';
      changed = true;
    }
  }

  if (syncCurrentMainEvent(statusData, schedule)) {
    changed = true;
  }
  if (
    statusData.world.currentMainEventId &&
    closeEarlierRunningMainEvents(statusData, statusData.world.currentMainEventId, schedule)
  ) {
    changed = true;
  }

  return changed;
}

export function applyProgressUpdate(
  statusData: StatusData,
  update: ProgressUpdate,
  targetId = statusData.activeTargetId,
  plotLibrary?: PlotLibrary | null,
): void {
  const schedule = buildSchedule(plotLibrary);

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
    for (const [id, eventStatus] of Object.entries(update.mainEvents)) {
      if (eventStatus === '进行中') {
        statusData.world.currentMainEventId = id;
        closeEarlierRunningMainEvents(statusData, id, schedule);
      }
    }
  }

  if (update.currentMainEventId) {
    statusData.world.currentMainEventId = update.currentMainEventId;
    if (
      !FINISHED_MAIN_EVENT_STATUSES.has((statusData.world.mainEvents ??= {})[update.currentMainEventId] ?? '未触发')
    ) {
      statusData.world.mainEvents[update.currentMainEventId] = '进行中';
      closeEarlierRunningMainEvents(statusData, update.currentMainEventId, schedule);
    }
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

  syncMainEvents(statusData, plotLibrary);
  if (update.currentMainEventId === '') {
    statusData.world.currentMainEventId = '';
  }
}
