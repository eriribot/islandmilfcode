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

  if (!Number.isInteger(input.anchorFloorIndex) || Number(input.anchorFloorIndex) < 0) {
    return rejected('missing_anchor', '当前时间线没有可绑定的已完成楼层。', resolution);
  }

  const receipt: PlotRouteChoiceReceipt = {
    schemaVersion: 2,
    machineId: input.machine.id,
    familyId: family.id,
    confirmationId: crypto.randomUUID(),
    anchorFloorIndex: input.anchorFloorIndex,
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
  if (input.currentMainEventId === 'SAE_07-8') return false;

  // 中文注释：DDL 只认 SAE_07-8 的正常完成终态。到达日期、检查器关闭、跳过或延后事件
  // 都不能代替正文生命周期；只有事件确实写成“已结束/已完成”后才强制玩家三选一。
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
