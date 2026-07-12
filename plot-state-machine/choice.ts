import { extractPlotDate } from './date-window';
import { resolvePlotRoutes } from './resolver';
import type {
  PlotFlagValueMap,
  PlotMachineDefinition,
  PlotRouteChoiceReceipt,
  PlotRouteChoiceConfirmationErrorCode,
  PlotRouteChoiceConfirmationResult,
} from './types';

export function confirmPlotRouteChoice(input: {
  machine: PlotMachineDefinition;
  currentTime?: string;
  flagValues: PlotFlagValueMap;
  storedChoice?: string | PlotRouteChoiceReceipt | null;
  routeId: string;
  source: string;
  currentMainEventId?: string;
  mainEvents?: Readonly<Record<string, string>>;
  anchorFloorIndex?: number;
}): PlotRouteChoiceConfirmationResult {
  const resolution = resolvePlotRoutes(input.machine, input.flagValues, input.storedChoice);

  if (input.source !== 'manual') {
    return rejected('not_manual', '最终路线只接受玩家手动确认。', resolution);
  }

  const currentDate = extractPlotDate(input.currentTime);
  if (!currentDate) {
    return rejected('missing_date', '当前剧情时间没有合法 YYYY-MM-DD 日期。', resolution);
  }

  const family = resolution.families.find(item => item.id === input.routeId);
  if (!family) return rejected('unknown_route', `未知路线 ${input.routeId}。`, resolution);

  if (resolution.choice) {
    if (resolution.choice === family.id) {
      return {
        status: 'unchanged',
        changed: false,
        choice: resolution.choice,
        commit: null,
        resolution,
      };
    }
    return rejected('choice_locked', `最终路线已经锁定为 ${resolution.choice}，不能覆盖为 ${family.id}。`, resolution);
  }

  if (
    !isV07RouteChoiceRequired({
      currentTime: input.currentTime,
      currentMainEventId: input.currentMainEventId,
      mainEvents: input.mainEvents,
      hasChoice: false,
    })
  ) {
    return rejected('ddl_not_reached', 'SAE_07-8 尚未正式结束，现在不能进行最终路线选择。', resolution);
  }

  const anchorFloorIndex = input.anchorFloorIndex;
  if (typeof anchorFloorIndex !== 'number' || !Number.isInteger(anchorFloorIndex) || anchorFloorIndex < 0) {
    return rejected('missing_anchor', '当前时间线没有可绑定的已完成楼层。', resolution);
  }

  const receipt: PlotRouteChoiceReceipt = {
    schemaVersion: 2,
    machineId: input.machine.id,
    familyId: family.id,
    confirmationId: crypto.randomUUID(),
    anchorFloorIndex,
    confirmedAt: input.currentTime ?? currentDate,
    source: 'manual',
  };

  return {
    status: 'accepted',
    changed: true,
    choice: family.id,
    commit: {
      targetId: input.machine.targetId,
      key: input.machine.choiceStorageKey,
      value: JSON.stringify(receipt),
      valueType: 'json',
      source: 'manual',
      receipt,
    },
    resolution,
  };
}

export function isV07RouteChoiceRequired(input: {
  currentTime?: string;
  currentMainEventId?: string;
  mainEvents?: Readonly<Record<string, string>>;
  hasChoice: boolean;
}): boolean {
  if (input.hasChoice) return false;
  const currentDate = extractPlotDate(input.currentTime);
  if (!currentDate || currentDate < '2013-03-04') return false;
  if (String(input.currentMainEventId ?? '').trim()) return false;

  // 中文注释：DDL 只认“SAE_07-8 正常终态 + 当前主事件已清空”这一对权威状态。
  // 到达日期、检查器关闭、跳过/延后，或异常跳到其他主事件，都不能代替正文后的正式 progress。
  return /已结束|已完成/.test(String(input.mainEvents?.['SAE_07-8'] ?? '').trim());
}

function rejected(
  code: PlotRouteChoiceConfirmationErrorCode,
  message: string,
  resolution: PlotRouteChoiceConfirmationResult['resolution'],
): PlotRouteChoiceConfirmationResult {
  return {
    status: 'rejected',
    changed: false,
    choice: resolution.choice,
    commit: null,
    error: { code, message },
    resolution,
  };
}
