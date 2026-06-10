import type { ProgressUpdate } from '../message-format';
import {
  SAE_03_8,
  SAE_04_2A,
  SAE_04_2B,
  SAE_04_3,
  getSae0402Route,
  isPlotEventAllowedByRoute,
  isSae0307BranchId,
  isSae0402BranchId,
  isSae0402ExpiredByDate,
} from '../plot-routing';
import type { PlotEventCard, PlotLibrary, StatusData } from '../types';
import { affinityStage, clamp, obsessionStage } from './format';

export { defaultStatusData, defaultTarget } from './defaults';
export {
  affinityStage,
  attachmentStage,
  attachmentValue,
  clamp,
  dependencyStage,
  formatDate,
  formatTime,
  getInventoryIcon,
  obsessionStage,
} from './format';
export { normalizeStatusData, serializeStatusData } from './legacy';

const MAX_RECENT_EVENTS = 5;
const MAIN_EVENT_NOT_STARTED = '未进行';
const MAIN_EVENT_RUNNING = '进行中';
const MAIN_EVENT_FINISHED = '已结束';

type ScheduledEvent = {
  id: string;
  date: string;
  endDate: string;
};

function normalizeMainEventStatus(status: string | undefined): string {
  const value = String(status ?? '').trim();
  if (value === MAIN_EVENT_RUNNING) return MAIN_EVENT_RUNNING;
  if (value === MAIN_EVENT_FINISHED || value === '跳过' || value === '延后' || value === '已完成') {
    return MAIN_EVENT_FINISHED;
  }
  return MAIN_EVENT_NOT_STARTED;
}

function buildSchedule(plotLibrary: PlotLibrary | null | undefined, statusData?: StatusData | null): ScheduledEvent[] {
  if (!plotLibrary) return [];
  const events = Object.values(plotLibrary.events)
    .filter((event): event is PlotEventCard & { schedule: NonNullable<PlotEventCard['schedule']> } =>
      Boolean(event.schedule?.date),
    )
    .filter(event => !statusData || isPlotEventAllowedByRoute(event.id, statusData))
    .map(event => {
      const endDate =
        event.schedule.endDate && event.schedule.endDate >= event.schedule.date
          ? event.schedule.endDate
          : event.schedule.date;

      return {
        id: event.id,
        date: event.schedule.date,
        endDate,
      };
    });
  events.sort(
    (a, b) => a.date.localeCompare(b.date) || a.endDate.localeCompare(b.endDate) || a.id.localeCompare(b.id),
  );
  return events;
}

function getMainEventOrder(schedule: ScheduledEvent[], id: string) {
  return schedule.findIndex(event => event.id === id);
}

function getDatePart(value: string) {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

/** 把 "YYYY-MM-DD HH:mm" 折成可比较的分钟刻度；缺时分按 00:00。无法解析返回 null。 */
function toComparableMinutes(value: string): number | null {
  const date = getDatePart(value);
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const minutes = getMinutesPart(value) ?? 0;
  return Date.UTC(y, m - 1, d) / 60000 + minutes;
}

/**
 * 时间单调防线：游戏时间只进不退。新时间严格早于当前时间时拒绝（返回当前时间）。
 * 这是所有时间写入的统一兜底——无论来源是主 API、副 API 还是游标滞后的小摘要，
 * 反向覆盖(把 8月13日 写回 8月12日 / SAE_03-8 退回 SAE_03-6)都在这里被挡住。
 * 等值放行（同一时刻的重复写入无害）；无法比较时放行，避免误伤格式异常但合法的推进。
 */
function enforceMonotonicTime(nextTime: string, currentTime: string): string {
  const next = toComparableMinutes(nextTime);
  const current = toComparableMinutes(currentTime);
  if (next === null || current === null) return nextTime;
  if (next < current) {
    console.warn('[time-guard] reject backward time write:', nextTime, '<', currentTime);
    return currentTime;
  }
  return nextTime;
}

/**
 * 统一时间提交门：任何把 world.currentTime 往前推的写入都应走这里，禁止裸写 `statusData.world.currentTime = ...`。
 * 管线：normalizeIncomingTime（格式归一/中文日期/相对日期）→ enforceMonotonicTime（只进不退）。
 * 返回 { changed, time }：time 始终是写入后（或保持原值）的权威时间；changed 表示是否真的前进了。
 * 调用方负责在 changed 时落库/触发 syncMainEvents。倒叙/回忆等"不该推进世界游标"的内容不要调用本函数。
 */
export function commitWorldTimeCandidate(
  statusData: StatusData,
  rawTime: string,
): { changed: boolean; time: string } {
  const current = statusData.world.currentTime;
  const raw = String(rawTime ?? '').trim();
  if (!raw) return { changed: false, time: current };

  const normalized = normalizeIncomingTime(raw, current);
  const next = enforceMonotonicTime(normalized, current);
  if (next === current) return { changed: false, time: current };

  statusData.world.currentTime = next;
  return { changed: true, time: next };
}

function getMinutesPart(value: string) {
  const match = value.match(/\b(\d{2}):(\d{2})\b/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getHHmmPart(value: string): string {
  const match = value.match(/\b(\d{2}):(\d{2})\b/);
  return match ? `${match[1]}:${match[2]}` : '';
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function extractClockFromChinese(value: string): string {
  const explicit = value.match(/(上午|下午|晚上|凌晨)?\s*(\d{1,2})\s*[:：点]\s*(\d{1,2})?/);
  if (explicit) {
    const ampm = explicit[1] ?? '';
    let hour = Number(explicit[2]);
    const minute = explicit[3] ? Number(explicit[3]) : 0;
    if ((ampm === '下午' || ampm === '晚上') && hour < 12) hour += 12;
    if (ampm === '凌晨' && hour === 12) hour = 0;
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return `${pad2(hour)}:${pad2(minute)}`;
    }
  }
  if (/清晨|早晨|早上/.test(value)) return '07:00';
  if (/上午/.test(value)) return '10:00';
  if (/中午|午休/.test(value)) return '12:30';
  if (/下午|放学后/.test(value)) return '15:30';
  if (/傍晚/.test(value)) return '18:00';
  if (/夜晚|晚上/.test(value)) return '20:30';
  if (/深夜/.test(value)) return '23:30';
  if (/凌晨/.test(value)) return '03:00';
  return '';
}

/**
 * 规范化 AI 输出的时间字段。支持多种非标格式的容错：
 * - 完整 YYYY-MM-DD HH:mm → 直接返回
 * - 仅日期 YYYY-MM-DD → 沿用 currentTime 的 HH:mm
 * - 中文日期 "4月16日" / "2012年4月16日" → 取年份自 currentTime，尝试解析尾部时分描述
 * - 相对描述 "次日 / 翌日 / 第二天" → 基于 currentTime +1 天
 * - 全部失败 → 返回 currentTime 保底，不破坏下游 getDatePart 依赖
 */
export function normalizeIncomingTime(raw: string, currentTime: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return currentTime;

  // 完整格式
  const fullMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})[\sT]+(\d{1,2}):(\d{2})$/);
  if (fullMatch) {
    const hh = pad2(Number(fullMatch[4]));
    const mm = fullMatch[5];
    return `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]} ${hh}:${mm}`;
  }

  const currentDate = getDatePart(currentTime);
  const currentHHmm = getHHmmPart(currentTime) || '09:00';
  const currentYear = currentDate ? currentDate.slice(0, 4) : '';

  // 仅 YYYY-MM-DD
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]} ${currentHHmm}`;
  }

  // 相对描述
  if (/(次日|翌日|第二天|第二日|明天)/.test(value)) {
    const nextDate = currentDate ? addDays(currentDate, 1) : currentDate;
    const clock = extractClockFromChinese(value) || currentHHmm;
    return nextDate ? `${nextDate} ${clock}` : currentTime;
  }
  if (/(后天)/.test(value)) {
    const nextDate = currentDate ? addDays(currentDate, 2) : currentDate;
    const clock = extractClockFromChinese(value) || currentHHmm;
    return nextDate ? `${nextDate} ${clock}` : currentTime;
  }
  const daysLater = value.match(/(\d+)\s*天(?:后|之后|以后)/);
  if (daysLater && currentDate) {
    const nextDate = addDays(currentDate, Number(daysLater[1]));
    const clock = extractClockFromChinese(value) || currentHHmm;
    return `${nextDate} ${clock}`;
  }

  // 中文日期：YYYY年M月D日 或 M月D日
  const cnFull = value.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const cnShort = value.match(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  let datePart = '';
  if (cnFull) {
    datePart = `${cnFull[1]}-${pad2(Number(cnFull[2]))}-${pad2(Number(cnFull[3]))}`;
  } else if (cnShort && currentYear) {
    datePart = `${currentYear}-${pad2(Number(cnShort[1]))}-${pad2(Number(cnShort[2]))}`;
  }
  if (datePart) {
    const clock = extractClockFromChinese(value) || currentHHmm;
    return `${datePart} ${clock}`;
  }

  // 纯时分描述，更新当天时间
  const clockOnly = extractClockFromChinese(value);
  if (clockOnly && currentDate) {
    return `${currentDate} ${clockOnly}`;
  }

  return currentTime;
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

function eventMatchesCurrentDate(event: ScheduledEvent, currentDate: string) {
  return currentDate >= event.date && currentDate <= event.endDate;
}

function eventHasExpired(event: ScheduledEvent, currentDate: string) {
  return compareDate(currentDate, event.endDate) > 0;
}

function getScheduledCurrentMainEventId(statusData: StatusData, schedule: ScheduledEvent[]) {
  const currentDate = getDatePart(statusData.world.currentTime);
  const mainEvents = statusData.world.mainEvents ?? {};

  // 优先保持已经在进行中的事件，即使日期超出了 endDate
  // 这样可以确保事件一旦开始就持续到手动结束，而不是因为时间推进就自动消失
  for (const event of schedule) {
    const status = normalizeMainEventStatus(mainEvents[event.id]);
    if (status === MAIN_EVENT_RUNNING) {
      return event.id; // 已经在进行中的事件，无论日期如何都继续保持
    }
  }

  // 找到所有匹配当前日期的事件（用于启动新事件）
  const candidates = schedule.filter(event => eventMatchesCurrentDate(event, currentDate));

  // 选择未开始但符合条件的事件来启动
  for (const event of candidates) {
    const status = normalizeMainEventStatus(mainEvents[event.id]);
    if (status !== MAIN_EVENT_FINISHED && isPlotEventAllowedByRoute(event.id, statusData)) {
      return event.id;
    }
  }

  return '';
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
  if (currentId && normalizeMainEventStatus(mainEvents[currentId]) !== MAIN_EVENT_RUNNING) {
    statusData.world.currentMainEventId = '';
    changed = true;
  }

  const scheduledId = getScheduledCurrentMainEventId(statusData, schedule);
  if (scheduledId && normalizeMainEventStatus(mainEvents[scheduledId]) !== MAIN_EVENT_FINISHED) {
    if (normalizeMainEventStatus(mainEvents[scheduledId]) !== MAIN_EVENT_RUNNING) {
      mainEvents[scheduledId] = MAIN_EVENT_RUNNING;
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
        .filter(([, status]) => normalizeMainEventStatus(status) === MAIN_EVENT_RUNNING)
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
    if (normalizeMainEventStatus(mainEvents[event.id]) === MAIN_EVENT_RUNNING) {
      mainEvents[event.id] = MAIN_EVENT_FINISHED;
      changed = true;
    }
  }

  return changed;
}

function closeExpiredSae0402Branch(statusData: StatusData): boolean {
  if (!isSae0402ExpiredByDate(statusData)) return false;

  const mainEvents = (statusData.world.mainEvents ??= {});
  const currentId = statusData.world.currentMainEventId;
  const branchId = isSae0402BranchId(currentId) ? currentId : getSae0402Route(statusData);
  let changed = false;

  if (normalizeMainEventStatus(mainEvents[branchId]) !== MAIN_EVENT_FINISHED) {
    mainEvents[branchId] = MAIN_EVENT_FINISHED;
    changed = true;
  }

  const otherBranchId = branchId === SAE_04_2A ? SAE_04_2B : SAE_04_2A;
  if (normalizeMainEventStatus(mainEvents[otherBranchId]) === MAIN_EVENT_RUNNING) {
    mainEvents[otherBranchId] = MAIN_EVENT_NOT_STARTED;
    changed = true;
  }

  if (isSae0402BranchId(currentId)) {
    statusData.world.currentMainEventId = '';
    changed = true;
  }

  return changed;
}

export function syncMainEvents(statusData: StatusData, plotLibrary?: PlotLibrary | null): boolean {
  const schedule = buildSchedule(plotLibrary, statusData);
  const mainEvents = (statusData.world.mainEvents ??= {});
  const currentDate = getDatePart(statusData.world.currentTime);
  let changed = false;

  if (closeExpiredSae0402Branch(statusData)) {
    changed = true;
  }

  for (const event of schedule) {
    const normalizedStatus = normalizeMainEventStatus(mainEvents[event.id]);
    if (mainEvents[event.id] !== normalizedStatus) {
      mainEvents[event.id] = normalizedStatus;
      changed = true;
    }

    // 中文注释：过了事件窗口才自动结算；没有持续至的旧事件仍按单日窗口处理。
    if (currentDate && eventHasExpired(event, currentDate)) {
      if (normalizedStatus !== MAIN_EVENT_FINISHED) {
        mainEvents[event.id] = MAIN_EVENT_FINISHED;
        if (statusData.world.currentMainEventId === event.id) {
          statusData.world.currentMainEventId = '';
        }
        changed = true;
      }
      continue;
    }

    // 时间闸自愈：被提前写成"进行中"的未来事件（当前日期尚未到达触发日且未过期）回退为"未进行"。
    // 这能让已经"莫名跳到未来卷"的旧存档在重新载入时自动修正，与 sanitizeProgressAgainstPlotLibrary 的写入闸互为防线。
    if (currentDate && normalizedStatus === MAIN_EVENT_RUNNING && compareDate(currentDate, event.date) < 0) {
      mainEvents[event.id] = MAIN_EVENT_NOT_STARTED;
      if (statusData.world.currentMainEventId === event.id) {
        statusData.world.currentMainEventId = '';
      }
      changed = true;
      continue;
    }

    if (normalizedStatus !== MAIN_EVENT_NOT_STARTED) continue;

    if (eventMatchesCurrentDate(event, currentDate)) {
      mainEvents[event.id] = MAIN_EVENT_RUNNING;
      statusData.world.currentMainEventId = event.id;
      changed = true;
    }
  }

  for (const id of Object.keys(mainEvents)) {
    if (
      (isSae0307BranchId(id) || isSae0402BranchId(id) || id === SAE_03_8 || id === SAE_04_3) &&
      !isPlotEventAllowedByRoute(id, statusData)
    ) {
      const status = normalizeMainEventStatus(mainEvents[id]);
      if (status === MAIN_EVENT_RUNNING || status === MAIN_EVENT_FINISHED) {
        mainEvents[id] = MAIN_EVENT_NOT_STARTED;
        if (statusData.world.currentMainEventId === id) {
          statusData.world.currentMainEventId = '';
        }
        changed = true;
      }
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
  targetId?: string | null,
  plotLibrary?: PlotLibrary | null,
): void {
  const schedule = buildSchedule(plotLibrary, statusData);

  if (update.time) {
    // 走统一时间门（归一 + 单调闸），与 preflight 共用同一条井道，杜绝裸写。
    commitWorldTimeCandidate(statusData, update.time);
  }
  if (update.location) {
    statusData.world.currentLocation = update.location;
  }

  if (update.affinityDelta !== undefined && update.affinityDelta !== 0) {
    // 中文注释：旧单目标好感度必须有显式 targetId，不能再落到 activeTargetId 或首个角色。
    if (!targetId) {
      console.warn('[progress] skip legacy affinity without explicit target');
    }
    const target = statusData.targets.find(t => t.id === targetId);
    if (target) {
      target.affinity = clamp((target.affinity ?? 0) + update.affinityDelta, 0, 100);
      target.stage = affinityStage(target.affinity);
    }
  }

  if (update.obsessionDelta !== undefined && update.obsessionDelta !== 0) {
    if (!targetId) {
      console.warn('[progress] skip legacy obsession without explicit target');
    }
    const target = statusData.targets.find(t => t.id === targetId);
    if (target) {
      target.obsession = clamp((target.obsession ?? 0) + update.obsessionDelta, 0, 100);
      target.obsessionStage = obsessionStage(target.obsession);
    }
  }

  if (Object.keys(update.outfitChanges).length) {
    // 中文注释：旧单目标着装更新同样只允许明确对象，避免误写到默认角色。
    if (!targetId) {
      console.warn('[progress] skip outfit changes without explicit target');
    }
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
    const normalizedUpdates = Object.fromEntries(
      Object.entries(update.mainEvents).map(([id, eventStatus]) => [id, normalizeMainEventStatus(eventStatus)]),
    );
    statusData.world.mainEvents = {
      ...(statusData.world.mainEvents ?? {}),
      ...normalizedUpdates,
    };
    for (const [id, eventStatus] of Object.entries(normalizedUpdates)) {
      if (eventStatus === MAIN_EVENT_RUNNING) {
        statusData.world.currentMainEventId = id;
        closeEarlierRunningMainEvents(statusData, id, schedule);
      }
    }
  }

  if (update.currentMainEventId) {
    statusData.world.currentMainEventId = update.currentMainEventId;
    if (
      normalizeMainEventStatus((statusData.world.mainEvents ??= {})[update.currentMainEventId]) !== MAIN_EVENT_FINISHED
    ) {
      statusData.world.mainEvents[update.currentMainEventId] = MAIN_EVENT_RUNNING;
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

  if (update.currentMainEventId === '') {
    // 中文注释：先处理显式清空，再让时间/地点日程同步接管；避免“当前事件:无”覆盖已到达的主线事件。
    statusData.world.currentMainEventId = '';
  }
  syncMainEvents(statusData, plotLibrary);
}
