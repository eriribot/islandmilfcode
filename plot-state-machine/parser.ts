import type { PlotFlagDelta, PlotFlagValue } from './types';
import { V07_PLOT_MACHINE } from './v07';

const PLOT_FLAG_LINE_RE = /^剧情开关\s*[.．]\s*([A-Za-z0-9_-]+)\s*[.．]\s*([A-Za-z0-9_:-]+)\s*[:：]\s*(yes|no)\s*$/i;

export function parsePlotFlagDeltaLine(line: string): PlotFlagDelta | null {
  const match = String(line ?? '').trim().match(PLOT_FLAG_LINE_RE);
  if (!match) return null;

  const machineId = match[1].toLowerCase();
  const flagId = match[2];
  const value = match[3].toLowerCase() as PlotFlagValue;
  if (machineId !== V07_PLOT_MACHINE.id) return null;

  const definition = V07_PLOT_MACHINE.flags.find(flag => flag.id === flagId);
  if (!definition) return null;

  return {
    machineId: V07_PLOT_MACHINE.id,
    flagId: definition.id,
    storageKey: definition.storageKey,
    value,
  };
}
