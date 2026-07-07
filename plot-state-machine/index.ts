import { V07_PLOT_MACHINE } from './v07';
import type { PlotMachineDefinition, PlotMachineId } from './types';

export type {
  PlotFlagCommitContext,
  PlotFlagDefinition,
  PlotFlagDelta,
  PlotFlagSnapshot,
  PlotFlagValue,
  PlotMachineDefinition,
  PlotMachineId,
} from './types';

export { parsePlotFlagDeltaLine } from './parser';
export { commitPlotFlagDeltas, readActivePlotFlagSnapshots } from './memory';
export { buildPlotMachinePromptBlock } from './prompt';

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
