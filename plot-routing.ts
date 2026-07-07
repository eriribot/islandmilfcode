import type { StatusData, TargetStatus } from './types';

export const SAE_03_6 = 'SAE_03-6';
export const SAE_03_7A = 'SAE_03-7A';
export const SAE_03_7B = 'SAE_03-7B';
export const SAE_03_8 = 'SAE_03-8';
export const SAE_04_2A = 'SAE_04-2A';
export const SAE_04_2B = 'SAE_04-2B';
export const SAE_04_3 = 'SAE_04-3';
const SAE_04_2_DATE = '2012-09-24';
export const SAE_05_2A = 'SAE_05-2A';
export const SAE_05_2B = 'SAE_05-2B';
export const SAE_05_3 = 'SAE_05-3';

export type Sae0307Route = typeof SAE_03_7A | typeof SAE_03_7B | typeof SAE_03_8;
export type Sae0402Route = typeof SAE_04_2A | typeof SAE_04_2B;
export type Sae0502Route = typeof SAE_05_2A | typeof SAE_05_2B;

function getTargetHaystack(target: TargetStatus) {
  const metaName = typeof target.meta?.worldbookEntryName === 'string' ? target.meta.worldbookEntryName : '';
  return [target.id, target.name, target.alias, metaName].filter(Boolean).join(' ');
}

export function findEririTarget(statusData: StatusData | null | undefined): TargetStatus | null {
  return statusData?.targets.find(target => /英梨梨|泽村|澤村|eriri|sawamura/i.test(getTargetHaystack(target))) ?? null;
}

export function findMichiruTarget(statusData: StatusData | null | undefined): TargetStatus | null {
  return (
    statusData?.targets.find(target => /冰堂|氷堂|美智留|michiru|hyodo|hyoudou/i.test(getTargetHaystack(target))) ??
    null
  );
}

export function findUtahaTarget(statusData: StatusData | null | undefined): TargetStatus | null {
  return (
    statusData?.targets.find(target => /霞之丘|霞ヶ丘|诗羽|詩羽|utaha|kasumigaoka/i.test(getTargetHaystack(target))) ??
    null
  );
}

function asScore(value: unknown, fallback: number) {
  const score = Number(value);
  return Number.isFinite(score) ? score : fallback;
}

export function getSae0307Route(statusData: StatusData | null | undefined): Sae0307Route {
  const eriri = findEririTarget(statusData);
  if (!eriri) return SAE_03_7A;

  const affinity = asScore(eriri.affinity, 0);
  const obsession = asScore(eriri.obsession, 80);

  if (obsession >= 30) return SAE_03_7A;
  if (affinity >= 60) return SAE_03_7B;
  return SAE_03_8;
}

export function isSae0307BranchId(eventId: string) {
  return eventId === SAE_03_7A || eventId === SAE_03_7B;
}

export function getSae0402Route(statusData: StatusData | null | undefined): Sae0402Route {
  const michiru = findMichiruTarget(statusData);
  if (!michiru) return SAE_04_2A;

  const affinity = asScore(michiru.affinity, 0);
  return affinity >= 60 ? SAE_04_2B : SAE_04_2A;
}

export function isSae0402BranchId(eventId: string) {
  return eventId === SAE_04_2A || eventId === SAE_04_2B;
}

export function getSae0502Route(statusData: StatusData | null | undefined): Sae0502Route {
  const utaha = findUtahaTarget(statusData);
  if (!utaha) return SAE_05_2A;

  const obsession = asScore(utaha.obsession, 80);
  return obsession >= 70 ? SAE_05_2A : SAE_05_2B;
}

export function isSae0502BranchId(eventId: string) {
  return eventId === SAE_05_2A || eventId === SAE_05_2B;
}

function getDatePart(value: string) {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

function getTimeMinutes(value: string): number {
  const match = value.match(/(\d{2}):(\d{2})/);
  if (!match) return -1;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function isFinishedMainEventStatus(status: string | undefined) {
  return /已结束|跳过|延后|已完成/.test(String(status ?? '').trim());
}

export function isSae0306Resolved(statusData: StatusData | null | undefined) {
  return isFinishedMainEventStatus(statusData?.world.mainEvents?.[SAE_03_6]);
}

export function isSae0401Resolved(statusData: StatusData | null | undefined) {
  return isFinishedMainEventStatus(statusData?.world.mainEvents?.['SAE_04-1']);
}

export function isSae0402Resolved(statusData: StatusData | null | undefined) {
  const mainEvents = statusData?.world.mainEvents ?? {};
  return (
    isFinishedMainEventStatus(mainEvents[SAE_04_2A]) ||
    isFinishedMainEventStatus(mainEvents[SAE_04_2B]) ||
    isSae0402ExpiredByDate(statusData)
  );
}

export function isSae0402ExpiredByDate(statusData: StatusData | null | undefined) {
  const currentDate = getDatePart(statusData?.world.currentTime ?? '');
  return currentDate > SAE_04_2_DATE;
}

function validateSae0402DateTime(statusData: StatusData | null | undefined): boolean {
  if (!statusData) return false;
  const currentTime = statusData.world.currentTime;
  const currentDate = getDatePart(currentTime);
  return currentDate === SAE_04_2_DATE && getTimeMinutes(currentTime) >= 17 * 60;
}

export function isPlotEventVisibleByRoute(eventId: string, statusData: StatusData | null | undefined) {
  if (!statusData) return true;

  if (isSae0307BranchId(eventId) || eventId === SAE_03_8) {
    if (statusData.world.currentMainEventId === SAE_03_6) return true;
    return isPlotEventAllowedByRoute(eventId, statusData);
  }

  if (isSae0402BranchId(eventId)) {
    const route = getSae0402Route(statusData);
    return (
      eventId === route &&
      validateSae0402DateTime(statusData) &&
      (isSae0401Resolved(statusData) || statusData.world.currentMainEventId === 'SAE_04-1')
    );
  }

  if (isSae0502BranchId(eventId)) {
    const route = getSae0502Route(statusData);
    return eventId === route;
  }

  if (eventId === SAE_04_3) {
    if (isPlotEventAllowedByRoute(eventId, statusData)) return true;
    return (
      isSae0401Resolved(statusData) &&
      (statusData.world.currentMainEventId === SAE_04_2A || statusData.world.currentMainEventId === SAE_04_2B)
    );
  }

  return true;
}

export function isPlotEventAllowedByRoute(eventId: string, statusData: StatusData | null | undefined) {
  if (!statusData) return true;

  const currentId = statusData.world.currentMainEventId ?? '';
  if (
    eventId === currentId &&
    !isSae0307BranchId(eventId) &&
    !isSae0402BranchId(eventId) &&
    eventId !== SAE_03_8 &&
    eventId !== SAE_04_3
  ) {
    return true;
  }

  const route = getSae0307Route(statusData);
  if (isSae0307BranchId(eventId)) {
    return isSae0306Resolved(statusData) && eventId === route;
  }

  if (eventId === SAE_03_8) {
    if (!isSae0306Resolved(statusData)) return false;
    if (route === SAE_03_8) return true;
    // SAE_03-8 本身已经是当前事件（已被激活）
    if (currentId === SAE_03_8) return true;

    const mainEvents = statusData.world.mainEvents ?? {};
    // 7分支已结束 → SAE_03-8 解锁
    if (isFinishedMainEventStatus(mainEvents[SAE_03_7A]) || isFinishedMainEventStatus(mainEvents[SAE_03_7B])) {
      return true;
    }

    // 日期已到 08-13 → SAE_03-8 解锁
    const currentDate = getDatePart(statusData.world.currentTime);
    return currentDate >= '2012-08-13';
  }

  if (isSae0402BranchId(eventId)) {
    const isSae0401Active = statusData.world.currentMainEventId === 'SAE_04-1';
    return (
      (isSae0401Resolved(statusData) || isSae0401Active) &&
      validateSae0402DateTime(statusData) &&
      eventId === getSae0402Route(statusData)
    );
  }

  if (eventId === SAE_04_3) {
    if (!isSae0401Resolved(statusData)) return false;
    if (currentId === SAE_04_3) return true;
    if (isSae0402Resolved(statusData)) return true;
    return isSae0402BranchId(currentId);
  }

  return true;
}
