import type { IslandMemoryDB } from '../memorydatabase/types';
import { upsertAttribute } from '../memorydatabase/upsert';
import type { PlotFlagCommitContext, PlotFlagDelta, PlotFlagSnapshot, PlotFlagValue } from './types';
import { V07_PLOT_MACHINE } from './v07';

export function commitPlotFlagDeltas(deltas: PlotFlagDelta[], context: PlotFlagCommitContext): void {
  if (!deltas.length) return;

  const currentDate = extractDatePart(context.currentTime);
  if (!currentDate) return;

  for (const delta of deltas) {
    const machine = delta.machineId === V07_PLOT_MACHINE.id ? V07_PLOT_MACHINE : null;
    const definition = machine?.flags.find(flag => flag.id === delta.flagId);
    if (!machine || !definition) continue;
    if (currentDate < definition.earliestDate) continue;

    upsertAttribute(context.db, {
      targetId: machine.targetId,
      key: definition.storageKey,
      value: delta.value,
      valueType: 'boolean',
      reason: `${definition.label}: ${delta.value === 'yes' ? definition.yesMeaning : definition.noMeaning}`,
      sourceRange: context.sourceRange,
    });
  }
}

export function readActivePlotFlagSnapshots(db: IslandMemoryDB, machineId: string): PlotFlagSnapshot[] {
  const machine = machineId === V07_PLOT_MACHINE.id ? V07_PLOT_MACHINE : null;
  if (!machine) return [];

  return machine.flags
    .map(definition => {
      const value = readActiveAttributeValue(db, machine.targetId, definition.storageKey);
      if (!isPlotFlagValue(value)) return null;
      return { definition, value };
    })
    .filter((item): item is PlotFlagSnapshot => Boolean(item));
}

function isPlotFlagValue(value: string | undefined): value is PlotFlagValue {
  return value === 'yes' || value === 'no';
}

function extractDatePart(value: string | undefined): string {
  return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

function readActiveAttributeValue(db: IslandMemoryDB, targetId: string, key: string): string | undefined {
  return db.attributes
    .filter(row => !row.expired && row.targetId === targetId && row.key === key)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]?.value;
}
