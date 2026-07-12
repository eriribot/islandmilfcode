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

  writePlotRouteChoiceTombstone(
    db,
    machine,
    receipt,
    `楼层回退越过路线确认点 ${receipt.anchorFloorIndex}，清除确认实例 ${receipt.confirmationId}`,
    { firstRemovedFloorIndex },
  );
  return true;
}

export function reconcilePlotRouteChoiceAfterTimelineChange(
  db: IslandMemoryDB,
  machineId: string,
  input: {
    currentTime?: string;
    currentMainEventId?: string;
    mainEvents?: Readonly<Record<string, string>>;
    readerFloorCount: number;
  },
): boolean {
  const machine = machineId === V07_PLOT_MACHINE.id ? V07_PLOT_MACHINE : null;
  if (!machine) return false;
  const receipt = readActivePlotRouteChoice(db, machineId);
  if (!receipt) return false;

  const currentDate = extractDatePart(input.currentTime);
  const sae078State = String(input.mainEvents?.['SAE_07-8'] ?? '').trim();
  const lifecycleRewound =
    Date.parse(currentDate) < Date.parse('2013-03-04') ||
    String(input.currentMainEventId ?? '').trim() === 'SAE_07-8' ||
    Boolean(sae078State && !/已结束|已完成/.test(sae078State));
  const readerHeadIndex = Math.max(-1, Math.floor(input.readerFloorCount) - 1);
  const anchorRemoved = receipt.schemaVersion === 2 && receipt.anchorFloorIndex > readerHeadIndex;
  if (!lifecycleRewound && !anchorRemoved) return false;

  // 中文注释：旧版本可能已经把跨 DDL 回退后的 choice 保存进存档。加载时必须用权威时间线
  // 再做一次对账；否则 UI 会在 2012 年仍显示已选路线和游戏开发进度。
  const reason = anchorRemoved
    ? `当前时间线头部 ${readerHeadIndex} 早于路线确认点 ${receipt.anchorFloorIndex}`
    : `权威剧情状态已回到 V07 DDL 之前（${currentDate || '日期未知'} / ${sae078State || 'SAE_07-8 无终态'}）`;
  writePlotRouteChoiceTombstone(db, machine, receipt, reason, {
    readerHeadIndex,
    currentDate: currentDate || null,
  });
  return true;
}

function writePlotRouteChoiceTombstone(
  db: IslandMemoryDB,
  machine: typeof V07_PLOT_MACHINE,
  receipt: PlotRouteChoiceReceipt,
  reason: string,
  details: Record<string, unknown>,
): void {
  // 中文注释：只写 supersede tombstone，不物理删除旧 receipt；这样既让读取立刻失效，
  // 又保留旧确认实例供存档审计。游戏开发状态由 confirmationId 隔离，不在这里改写。
  upsertAttribute(db, {
    targetId: machine.targetId,
    key: machine.choiceStorageKey,
    value: JSON.stringify({
      schemaVersion: 1,
      state: 'cleared',
      clearedAt: new Date().toISOString(),
      confirmationId: receipt.schemaVersion === 2 ? receipt.confirmationId : null,
      ...details,
    }),
    valueType: 'json',
    reason,
    source: 'manual',
  });
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
