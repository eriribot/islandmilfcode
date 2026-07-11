import type { IslandMemoryDB } from '../memorydatabase/types';
import { upsertAttribute } from '../memorydatabase/upsert';
import { parsePlotRouteChoiceReceipt } from './resolver';
import type {
  PlotFlagCommitContext,
  PlotFlagSnapshot,
  PlotFlagValue,
  PlotRouteChoiceCommit,
  PlotRouteChoiceReceipt,
  ValidatedPlotFlagDelta,
} from './types';
import { V07_PLOT_MACHINE } from './v07';

export function commitPlotFlagDeltas(deltas: readonly ValidatedPlotFlagDelta[], context: PlotFlagCommitContext): void {
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
      reason: `${definition.label}: ${
        delta.value === 'yes' ? definition.yesMeaning : definition.noMeaning
      }；本轮可见正文证据：“${delta.evidenceQuote.replace(/\s+/g, ' ').trim().slice(0, 240)}”`,
      sourceRange: context.sourceRange,
      source: 'progress-commit',
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

export function commitPlotRouteChoice(db: IslandMemoryDB, commit: PlotRouteChoiceCommit): void {
  upsertAttribute(db, {
    targetId: commit.targetId,
    key: commit.key,
    value: commit.value,
    valueType: commit.valueType,
    reason: `玩家手动确认路线 ${commit.receipt.familyId}/${commit.receipt.variantId}，basis ${commit.receipt.basisHash}`,
    source: 'manual',
  });
}

export function readActivePlotRouteChoice(db: IslandMemoryDB, machineId: string): PlotRouteChoiceReceipt | null {
  const machine = machineId === V07_PLOT_MACHINE.id ? V07_PLOT_MACHINE : null;
  if (!machine) return null;
  return parsePlotRouteChoiceReceipt(
    readActiveAttributeValue(db, machine.targetId, machine.choiceStorageKey),
    machine,
  );
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
