import { extractPlotDate, isPlotDateInWindow } from './date-window';
import { createPlotRouteBasisHash, resolvePlotRoutes } from './resolver';
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
}): PlotRouteChoiceConfirmationResult {
  const resolution = resolvePlotRoutes(input.machine, input.flagValues, input.storedChoice);

  if (input.source !== 'manual') {
    return rejected('not_manual', '最终路线只接受玩家手动确认。', resolution);
  }

  const currentDate = extractPlotDate(input.currentTime);
  if (!currentDate) {
    return rejected('missing_date', '当前剧情时间没有合法 YYYY-MM-DD 日期。', resolution);
  }
  if (!isPlotDateInWindow(currentDate, input.machine.promptWindow)) {
    return rejected(
      'outside_choice_window',
      `日期 ${currentDate} 不在 ${input.machine.promptWindow.start} 至 ${input.machine.promptWindow.end} 的路线确认窗内。`,
      resolution,
    );
  }

  const route = resolution.routes.find(item => item.id === input.routeId);
  if (!route) return rejected('unknown_route', `未知路线 ${input.routeId}。`, resolution);

  if (resolution.choice) {
    if (resolution.choice === route.id) {
      return {
        status: 'unchanged',
        changed: false,
        choice: resolution.choice,
        commit: null,
        resolution,
      };
    }
    return rejected('choice_locked', `最终路线已经锁定为 ${resolution.choice}，不能覆盖为 ${route.id}。`, resolution);
  }

  if (!route.eligible) {
    return rejected('route_not_eligible', `${route.id} 路线仍缺少：${route.missingFlagIds.join('、')}。`, resolution);
  }

  const receipt: PlotRouteChoiceReceipt = {
    schemaVersion: 1,
    machineId: input.machine.id,
    familyId: route.familyId,
    variantId: route.id,
    confirmedAt: input.currentTime ?? currentDate,
    source: 'manual',
    basisHash: createPlotRouteBasisHash(input.machine.id, route.id, route.satisfiedFlagIds),
    basisFlagIds: [...route.satisfiedFlagIds].sort(),
  };

  return {
    status: 'accepted',
    changed: true,
    choice: route.id,
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
