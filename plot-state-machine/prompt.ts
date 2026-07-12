import type { IslandMemoryDB } from '../memorydatabase/types';
import { readActivePlotFlagSnapshots, readActivePlotRouteChoice } from './memory';

const FAMILY_LABELS = {
  stay: '留下',
  solo: '单飞',
  akane: '朱音',
} as const;

export function buildPlotMachinePromptBlock(
  db: IslandMemoryDB | null | undefined,
  currentMainEventId?: string,
  currentTime?: string,
): string {
  if (!db) return '';
  const choice = readActivePlotRouteChoice(db, 'v07');
  if (choice) {
    const label = FAMILY_LABELS[choice.familyId];
    // 中文注释：DDL 后只注入玩家亲自确认的三线 choice。旧 flag 是背景证据，不能在这里
    // 推翻、替换或细分玩家的最终决定；单飞/朱音的游戏开发由独立模块开启。
    return [
      `玩家已在 SAE_07-8 结束后的 DDL 亲自确认最终路线：${label}（${choice.familyId}）。`,
      `硬约束：后续正文必须沿“${label}”路线继续，不得根据旧剧情开关自动换线，也不得再次要求玩家选线。`,
    ].join('\n');
  }

  if (!isV07FactContextWindow(currentMainEventId, currentTime)) return '';

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

function isV07FactContextWindow(currentMainEventId: string | undefined, currentTime: string | undefined): boolean {
  if (/^SAE_07-8$/i.test(String(currentMainEventId ?? ''))) return true;
  const currentDate = String(currentTime ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  // 中文注释：检查器和事实背景只服务第七章 DDL 之前的有限窗口；2013-03-04 当天
  // 仅在 SAE_07-8 正在进行时保留背景，事件结束后必须等待玩家 choice，而不是继续靠 flag 路由。
  return isDateInsideWindow(currentDate, '2013-02-08', '2013-03-03');
}

function isDateInsideWindow(date: string, startDate: string, endDate: string): boolean {
  if (date < startDate) return false;
  return date <= endDate;
}
