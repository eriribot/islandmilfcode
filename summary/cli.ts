/**
 * 摘要系统命令行工具
 * 提供诊断和修复命令
 */

import type { AppState } from '../types';
import { diagnoseSummaryStore, repairSummaryStore, formatDiagnosticReport } from './repair';
import { saveSummaryStore } from './store';

/**
 * 诊断摘要系统状态
 */
export function diagnoseSummaryCommand(state: AppState): string {
  const diagnostic = diagnoseSummaryStore(state.summaryStore, state.uiMessages);
  return formatDiagnosticReport(diagnostic);
}

/**
 * 修复摘要系统问题
 */
export function repairSummaryCommand(state: AppState, win: Window): string {
  const result = repairSummaryStore(state.summaryStore, state.uiMessages, {
    removeOrphanedMinors: true,
    fixLastSummarizedIndex: true,
    removeOverlapping: true,
  });

  if (result.fixed) {
    saveSummaryStore(win, state.summaryStore);
    const lines = [
      '✅ 摘要系统修复完成',
      '',
      '修复内容：',
      ...result.changes.map(c => `  • ${c}`),
      '',
      '修复后状态：',
      `  小总结: ${result.diagnostic.minorCount} 条`,
      `  大总结: ${result.diagnostic.majorCount} 条`,
      `  已总结到: ${result.diagnostic.lastSummarizedIndex}`,
      `  待总结: ${result.diagnostic.pendingMessages} 条`,
    ];

    if (result.diagnostic.orphanedMinors.length === 0 &&
        result.diagnostic.uncoveredGaps.length === 0 &&
        result.diagnostic.overlappingRanges.length === 0) {
      lines.push('', '✅ 所有问题已修复');
    } else {
      lines.push('', '⚠️ 仍有以下问题需要人工处理：');
      if (result.diagnostic.orphanedMinors.length > 0) {
        lines.push(`  • ${result.diagnostic.orphanedMinors.length} 条孤立小总结`);
      }
      if (result.diagnostic.uncoveredGaps.length > 0) {
        lines.push(`  • ${result.diagnostic.uncoveredGaps.length} 个消息空洞`);
      }
      if (result.diagnostic.overlappingRanges.length > 0) {
        lines.push(`  • ${result.diagnostic.overlappingRanges.length} 处重叠范围`);
      }
    }

    return lines.join('\n');
  } else {
    return '✅ 摘要系统状态正常，无需修复';
  }
}

/**
 * 强制重建 lastSummarizedIndex
 * 根据现有摘要的最大覆盖范围重新计算
 */
export function rebuildLastSummarizedIndexCommand(state: AppState, win: Window): string {
  const store = state.summaryStore;
  const allRanges = [...store.minor.map(m => m.range), ...store.major.map(m => m.range)];

  if (allRanges.length === 0) {
    return '⚠️ 没有任何摘要，无法重建索引';
  }

  const maxCovered = Math.max(...allRanges.map(r => r[1]));
  const newIndex = maxCovered + 1;
  const oldIndex = store.lastSummarizedIndex;

  if (oldIndex === newIndex) {
    return `✅ lastSummarizedIndex 已经正确: ${oldIndex}`;
  }

  store.lastSummarizedIndex = newIndex;
  saveSummaryStore(win, store);

  return [
    '✅ lastSummarizedIndex 已重建',
    `  旧值: ${oldIndex}`,
    `  新值: ${newIndex}`,
    `  差异: ${newIndex - oldIndex > 0 ? '+' : ''}${newIndex - oldIndex}`,
  ].join('\n');
}

/**
 * 清理所有被大总结覆盖的小总结
 */
export function cleanupOrphanedMinorsCommand(state: AppState, win: Window): string {
  const store = state.summaryStore;
  const rangeContains = (outer: [number, number], inner: [number, number]) =>
    inner[0] >= outer[0] && inner[1] <= outer[1];

  const beforeCount = store.minor.length;
  const orphaned = store.minor.filter(minor =>
    store.major.some(major => rangeContains(major.range, minor.range))
  );

  if (orphaned.length === 0) {
    return '✅ 没有发现被覆盖的小总结';
  }

  store.minor = store.minor.filter(minor =>
    !store.major.some(major => rangeContains(major.range, minor.range))
  );

  saveSummaryStore(win, store);

  const lines = [
    `✅ 清理了 ${orphaned.length} 条被覆盖的小总结`,
    '',
    '清理详情：',
  ];

  for (const minor of orphaned) {
    const coveringMajor = store.major.find(major => rangeContains(major.range, minor.range));
    if (coveringMajor) {
      lines.push(`  • 小总结 [${minor.range[0]}, ${minor.range[1]}] 被大总结 [${coveringMajor.range[0]}, ${coveringMajor.range[1]}] 覆盖`);
    }
  }

  lines.push('', `小总结数量: ${beforeCount} → ${store.minor.length}`);

  return lines.join('\n');
}
