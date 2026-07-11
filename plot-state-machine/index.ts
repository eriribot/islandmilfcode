import { V07_PLOT_MACHINE } from './v07';
import type { PlotMachineDefinition, PlotMachineId } from './types';

export type {
  PlotDateWindow,
  PlotFlagCommitContext,
  PlotFlagDefinition,
  PlotFlagDelta,
  PlotFlagProposal,
  PlotFlagProposalDelta,
  PlotFlagReviewError,
  PlotFlagReviewErrorCode,
  PlotFlagReviewResult,
  PlotFlagSnapshot,
  PlotFlagValueMap,
  PlotFlagValue,
  PlotMachineDefinition,
  PlotMachineId,
  PlotRouteDefinition,
  PlotRouteFamilyId,
  PlotRouteEligibility,
  PlotRouteChoiceReceipt,
  PlotRouteChoiceCommit,
  PlotRouteChoiceConfirmationErrorCode,
  PlotRouteChoiceConfirmationResult,
  PlotRouteId,
  PlotRouteVariantId,
  PlotRouteResolution,
  ValidatedPlotFlagDelta,
} from './types';

export { confirmPlotRouteChoice } from './choice';
export { extractPlotDate, isPlotDateInWindow } from './date-window';
export { parsePlotFlagDeltaLine } from './parser';
export {
  commitPlotFlagDeltas,
  commitPlotRouteChoice,
  readActivePlotFlagSnapshots,
  readActivePlotRouteChoice,
} from './memory';
export { buildPlotMachinePromptBlock } from './prompt';
export { buildPlotFlagProposalPrompts, type PlotFlagProposalPrompt } from './proposal-prompt';
export { reviewPlotFlagProposal, type PlotFlagReviewContext } from './proposal';
export { createPlotRouteBasisHash, parsePlotRouteChoiceReceipt, resolvePlotRoutes } from './resolver';
export { buildPlotRoutingContext, type PlotRoutingContext } from './routing-context';
export { V07_PLOT_MACHINE } from './v07';

const PLOT_MACHINES: Record<PlotMachineId, PlotMachineDefinition> = {
  v07: V07_PLOT_MACHINE,
};

export function getPlotMachine(machineId: string): PlotMachineDefinition | null {
  return PLOT_MACHINES[machineId as PlotMachineId] ?? null;
}

export function getPlotFlagDefinition(machineId: string, flagId: string) {
  const machine = getPlotMachine(machineId);
  return machine?.flags.find(flag => flag.id === flagId) ?? null;
}

export function getPlotFlagDefinitionByStorageKey(machineId: string, storageKey: string) {
  const machine = getPlotMachine(machineId);
  return machine?.flags.find(flag => flag.storageKey === storageKey) ?? null;
}

export function getPlotFlagInstructionList(machineId: string): string {
  const machine = getPlotMachine(machineId);
  return machine?.flags.map(flag => flag.id).join(' / ') ?? '';
}
