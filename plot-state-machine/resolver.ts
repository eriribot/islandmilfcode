import type {
  PlotFlagValueMap,
  PlotMachineDefinition,
  PlotRouteChoiceReceipt,
  PlotRouteFamilyAdvisory,
  PlotRouteFamilyId,
  PlotRouteResolution,
} from './types';

const FAMILY_LABELS: Record<PlotRouteFamilyId, string> = {
  stay: '留下',
  solo: '单飞',
  akane: '朱音',
};

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
  // 中文注释：五个 variant 继续计算剧情事实完成度，但只作为三条 family 的提示信息。
  // 玩家在 DDL 可以自由选择任意 family，不能再用 eligibleRouteIds 禁用按钮。
  const families = (['stay', 'solo', 'akane'] as const).map(familyId => {
    const variants = routes.filter(route => route.familyId === familyId);
    const best = variants.reduce((current, candidate) => {
      if (!current) return candidate;
      const currentTotal = current.satisfiedFlagIds.length + current.missingFlagIds.length;
      const candidateTotal = candidate.satisfiedFlagIds.length + candidate.missingFlagIds.length;
      const currentRatio = current.satisfiedFlagIds.length / Math.max(1, currentTotal);
      const candidateRatio = candidate.satisfiedFlagIds.length / Math.max(1, candidateTotal);
      return candidateRatio > currentRatio ? candidate : current;
    }, variants[0]);
    return {
      id: familyId,
      label: FAMILY_LABELS[familyId],
      bestVariantId: best.id,
      satisfiedFlagIds: [...best.satisfiedFlagIds],
      missingFlagIds: [...best.missingFlagIds],
    } satisfies PlotRouteFamilyAdvisory;
  });
  const receipt = parsePlotRouteChoiceReceipt(storedChoice, machine);
  const rejectedChoice = storedChoice && !receipt ? String(storedChoice) : null;

  return {
    machineId: machine.id,
    routes,
    families,
    eligibleRouteIds,
    // 中文注释：receipt 是玩家在 DDL 的最终决定；后续事实变化只能影响提示，不能撤销或换线。
    choice: receipt?.familyId ?? null,
    choiceReceipt: receipt,
    choiceState: receipt ? 'chosen' : 'unchosen',
    needsReviewReason: null,
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
  if (receipt.machineId !== machine.id || receipt.source !== 'manual' || typeof receipt.confirmedAt !== 'string') {
    return null;
  }

  if (receipt.schemaVersion === 2) {
    const knownFamily = machine.routes.some(route => route.familyId === receipt.familyId);
    if (
      !knownFamily ||
      typeof receipt.confirmationId !== 'string' ||
      !receipt.confirmationId.trim() ||
      !Number.isInteger(receipt.anchorFloorIndex) ||
      Number(receipt.anchorFloorIndex) < 0
    ) {
      return null;
    }
    return receipt as PlotRouteChoiceReceipt;
  }

  // 中文注释：旧存档仍按 variant 校验并归一到其 family；读取兼容不代表 UI 继续展示五个选择按钮。
  const legacyRoute = machine.routes.find(item => item.id === receipt.variantId);
  if (
    receipt.schemaVersion !== 1 ||
    !legacyRoute ||
    receipt.familyId !== legacyRoute.familyId ||
    typeof receipt.basisHash !== 'string' ||
    !Array.isArray(receipt.basisFlagIds) ||
    receipt.basisFlagIds.some(flagId => typeof flagId !== 'string')
  ) {
    return null;
  }
  return receipt as PlotRouteChoiceReceipt;
}
