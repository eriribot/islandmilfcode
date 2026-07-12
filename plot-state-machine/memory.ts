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
    reason:
      commit.receipt.schemaVersion === 2
        ? `玩家在 V07 DDL 手动确认 ${commit.receipt.familyId} 路线，确认实例 ${commit.receipt.confirmationId}`
        : `兼容旧存档路线 ${commit.receipt.familyId}/${commit.receipt.variantId}，basis ${commit.receipt.basisHash}`,
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

export function clearPlotRouteChoiceAfterFloor(
  db: IslandMemoryDB,
  machineId: string,
  firstRemovedFloorIndex: number,
): boolean {
  const machine = machineId === V07_PLOT_MACHINE.id ? V07_PLOT_MACHINE : null;
  if (!machine) return false;
  const receipt = readActivePlotRouteChoice(db, machineId);
  if (
    !receipt ||
    receipt.schemaVersion !== 2 ||
    !Number.isInteger(receipt.anchorFloorIndex) ||
    Number(receipt.anchorFloorIndex) < firstRemovedFloorIndex
  ) {
    return false;
  }

  // 中文注释：路线选择发生在时间线头部。回退/删除跨过确认锚点后写正式 tombstone，
  // 不直接删除旧 receipt，也不恢复整个 memoryDB；旧确认实例留在 supersede 链中供审计。
  upsertAttribute(db, {
    targetId: machine.targetId,
    key: machine.choiceStorageKey,
    value: JSON.stringify({
      schemaVersion: 1,
      state: 'cleared',
      clearedAt: new Date().toISOString(),
      confirmationId: receipt.confirmationId,
      firstRemovedFloorIndex,
    }),
    valueType: 'json',
    reason: `楼层回退越过路线确认点 ${receipt.anchorFloorIndex}，清除确认实例 ${receipt.confirmationId}`,
    source: 'manual',
  });
  return true;
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
