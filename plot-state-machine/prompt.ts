import type { IslandMemoryDB } from '../memorydatabase/types';
import { readActivePlotFlagSnapshots } from './memory';

export function buildPlotMachinePromptBlock(
  db: IslandMemoryDB | null | undefined,
  currentMainEventId?: string,
  currentTime?: string,
): string {
  if (!db) return '';
  if (!isV07RouteDecisionWindow(currentMainEventId, currentTime)) return '';

  const snapshots = readActivePlotFlagSnapshots(db, 'v07');
  if (!snapshots.length) return '';

  const lines = [
    '当前第七卷路线开关（只读取已经通过日期闸门写入的开关；不要自行补不存在的开关）：',
    ...snapshots.map(({ definition, value }) => {
      const meaning = value === 'yes' ? definition.yesMeaning : definition.noMeaning;
      return `- ${definition.id}:${value}（${meaning}）`;
    }),
  ];

  return lines.join('\n');
}

function isV07RouteDecisionWindow(currentMainEventId: string | undefined, currentTime: string | undefined): boolean {
  if (/^SAE_07-8$/i.test(String(currentMainEventId ?? ''))) return true;
  const currentDate = String(currentTime ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  return isDateInsideWindow(currentDate, '2013-03-04', '2013-03-31');
}

function isDateInsideWindow(date: string, startDate: string, endDate: string): boolean {
  if (date < startDate) return false;
  return date <= endDate;
}
