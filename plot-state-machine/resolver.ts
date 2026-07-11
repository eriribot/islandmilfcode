import type {
  PlotFlagValueMap,
  PlotMachineDefinition,
  PlotRouteChoiceReceipt,
  PlotRouteResolution,
} from './types';

export function resolvePlotRoutes(
  machine: PlotMachineDefinition,
  flagValues: PlotFlagValueMap,
  storedChoice?: string | PlotRouteChoiceReceipt | null,
): PlotRouteResolution {
  const routes = machine.routes.map(route => {
    const missingFlagIds = route.requiredFlagIds.filter(flagId => flagValues[flagId] !== 'yes');
    const satisfiedFlagIds = route.requiredFlagIds.filter(flagId => flagValues[flagId] === 'yes');
    return {
      id: route.id,
      familyId: route.familyId,
      label: route.label,
      eligible: missingFlagIds.length === 0,
      satisfiedFlagIds,
      missingFlagIds,
    };
  });
  const eligibleRouteIds = routes.filter(route => route.eligible).map(route => route.id);
  const receipt = parsePlotRouteChoiceReceipt(storedChoice, machine);
  const selectedRoute = receipt ? routes.find(route => route.id === receipt.variantId) ?? null : null;
  const basisHash = selectedRoute ? createPlotRouteBasisHash(machine.id, selectedRoute.id, selectedRoute.satisfiedFlagIds) : '';
  const basisChanged = Boolean(receipt && selectedRoute && receipt.basisHash !== basisHash);
  const choiceState = !receipt ? 'unchosen' : !selectedRoute || !selectedRoute.eligible || basisChanged ? 'needs_review' : 'chosen';
  const needsReviewReason =
    choiceState !== 'needs_review'
      ? null
      : !selectedRoute
        ? '已保存的路线变体不再存在。'
        : !selectedRoute.eligible
          ? `已锁定路线的依据已失效：${selectedRoute.missingFlagIds.join('、')}。`
          : '已锁定路线的 eligibility basis 已变化，需要显式复核。';
  const rejectedChoice = storedChoice && !receipt ? String(storedChoice) : null;

  return {
    machineId: machine.id,
    routes,
    eligibleRouteIds,
    // 已落 receipt 的 choice 即使依据失效也保持锁定，不能静默换线。
    choice: receipt?.variantId ?? null,
    choiceReceipt: receipt,
    choiceState,
    needsReviewReason,
    rejectedChoice,
  };
}

export function createPlotRouteBasisHash(machineId: string, variantId: string, flagIds: readonly string[]): string {
  const source = `${machineId}|${variantId}|${[...flagIds].sort().join('|')}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function parsePlotRouteChoiceReceipt(
  storedChoice: string | PlotRouteChoiceReceipt | null | undefined,
  machine: PlotMachineDefinition,
): PlotRouteChoiceReceipt | null {
  if (!storedChoice) return null;
  let parsed: unknown = storedChoice;
  if (typeof storedChoice === 'string') {
    try {
      parsed = JSON.parse(storedChoice);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const receipt = parsed as Partial<PlotRouteChoiceReceipt>;
  const route = machine.routes.find(item => item.id === receipt.variantId);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.machineId !== machine.id ||
    receipt.source !== 'manual' ||
    !route ||
    receipt.familyId !== route.familyId ||
    typeof receipt.confirmedAt !== 'string' ||
    typeof receipt.basisHash !== 'string' ||
    !Array.isArray(receipt.basisFlagIds) ||
    receipt.basisFlagIds.some(flagId => typeof flagId !== 'string')
  ) {
    return null;
  }
  return receipt as PlotRouteChoiceReceipt;
}
