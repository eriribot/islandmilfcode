/**
 * 摘要系统修复工具
 * 用于诊断和修复小总结未被清理、消息覆盖范围不连续等问题
 */

import type { SummaryStore, SummaryEntry } from './types';
import type { UiMessage } from '../types';

export type SummaryDiagnostic = {
  /** 总消息数（会话消息，不含流式和系统消息） */
  totalMessages: number;
  /** 最后已总结索引 */
  lastSummarizedIndex: number;
  /** 待总结消息数 */
  pendingMessages: number;
  /** 小总结条数 */
  minorCount: number;
  /** 大总结条数 */
  majorCount: number;
  /** 是否有全局总结 */
  hasGlobal: boolean;
  /** 小总结覆盖的消息范围 */
  minorRanges: Array<[number, number]>;
  /** 大总结覆盖的消息范围 */
  majorRanges: Array<[number, number]>;
  /** 被大总结覆盖但未清理的小总结 */
  orphanedMinors: SummaryEntry[];
  /** 未被任何总结覆盖的消息段（空洞） */
  uncoveredGaps: Array<[number, number]>;
  /** 重复覆盖的范围（不应该发生） */
  overlappingRanges: Array<{ type: 'minor-minor' | 'major-major' | 'minor-major'; ranges: [[number, number], [number, number]] }>;
};

function rangeContains(outer: [number, number], inner: [number, number]): boolean {
  return inner[0] >= outer[0] && inner[1] <= outer[1];
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return !(a[1] < b[0] || b[1] < a[0]);
}

function getConversationMessages(messages: UiMessage[]): UiMessage[] {
  return messages.filter(m => !m.streaming && (m.role === 'user' || m.role === 'assistant'));
}

/**
 * 诊断摘要系统状态，识别问题
 */
export function diagnoseSummaryStore(store: SummaryStore, uiMessages: UiMessage[]): SummaryDiagnostic {
  const conversationMessages = getConversationMessages(uiMessages);
  const totalMessages = conversationMessages.length;

  const minorRanges = store.minor.map(m => m.range);
  const majorRanges = store.major.map(m => m.range);

  // 找出被大总结覆盖但未清理的小总结
  const orphanedMinors = store.minor.filter(minor =>
    store.major.some(major => rangeContains(major.range, minor.range))
  );

  // 找出重复覆盖
  const overlappingRanges: SummaryDiagnostic['overlappingRanges'] = [];

  // 检查小总结之间的重叠
  for (let i = 0; i < store.minor.length; i++) {
    for (let j = i + 1; j < store.minor.length; j++) {
      if (rangesOverlap(store.minor[i].range, store.minor[j].range)) {
        overlappingRanges.push({
          type: 'minor-minor',
          ranges: [store.minor[i].range, store.minor[j].range],
        });
      }
    }
  }

  // 检查大总结之间的重叠
  for (let i = 0; i < store.major.length; i++) {
    for (let j = i + 1; j < store.major.length; j++) {
      if (rangesOverlap(store.major[i].range, store.major[j].range)) {
        overlappingRanges.push({
          type: 'major-major',
          ranges: [store.major[i].range, store.major[j].range],
        });
      }
    }
  }

  // 检查小总结和大总结之间的部分重叠（不是完全包含）
  for (const minor of store.minor) {
    for (const major of store.major) {
      if (rangesOverlap(minor.range, major.range) && !rangeContains(major.range, minor.range)) {
        overlappingRanges.push({
          type: 'minor-major',
          ranges: [minor.range, major.range],
        });
      }
    }
  }

  // 找出未被覆盖的消息段（0 到 lastSummarizedIndex 之间的空洞）
  const uncoveredGaps: Array<[number, number]> = [];
  if (store.lastSummarizedIndex > 0) {
    const allRanges = [...minorRanges, ...majorRanges].sort((a, b) => a[0] - b[0]);

    if (allRanges.length === 0) {
      // 没有任何总结但 lastSummarizedIndex > 0
      uncoveredGaps.push([0, store.lastSummarizedIndex - 1]);
    } else {
      // 检查开头空洞
      if (allRanges[0][0] > 0) {
        uncoveredGaps.push([0, allRanges[0][0] - 1]);
      }

      // 检查中间空洞
      for (let i = 0; i < allRanges.length - 1; i++) {
        const currentEnd = allRanges[i][1];
        const nextStart = allRanges[i + 1][0];
        if (nextStart > currentEnd + 1) {
          uncoveredGaps.push([currentEnd + 1, nextStart - 1]);
        }
      }

      // 检查末尾空洞
      const lastCovered = allRanges[allRanges.length - 1][1];
      if (lastCovered < store.lastSummarizedIndex - 1) {
        uncoveredGaps.push([lastCovered + 1, store.lastSummarizedIndex - 1]);
      }
    }
  }

  return {
    totalMessages,
    lastSummarizedIndex: store.lastSummarizedIndex,
    pendingMessages: Math.max(0, totalMessages - store.lastSummarizedIndex),
    minorCount: store.minor.length,
    majorCount: store.major.length,
    hasGlobal: Boolean(store.global),
    minorRanges,
    majorRanges,
    orphanedMinors,
    uncoveredGaps,
    overlappingRanges,
  };
}

/**
 * 修复摘要系统问题
 * @returns 修复报告
 */
export function repairSummaryStore(
  store: SummaryStore,
  uiMessages: UiMessage[],
  options: {
    /** 是否清理被大总结覆盖的小总结 */
    removeOrphanedMinors?: boolean;
    /** 是否修正 lastSummarizedIndex 到实际覆盖的最大索引 */
    fixLastSummarizedIndex?: boolean;
    /** 是否清理重叠的总结（保留范围更大的） */
    removeOverlapping?: boolean;
  } = {}
): {
  fixed: boolean;
  changes: string[];
  diagnostic: SummaryDiagnostic;
} {
  const conversationCount = getConversationMessages(uiMessages).length;
  const changes: string[] = [];
  const diagnostic = diagnoseSummaryStore(store, uiMessages);

  // 1. 清理被大总结覆盖的小总结
  if (options.removeOrphanedMinors !== false && diagnostic.orphanedMinors.length > 0) {
    const beforeCount = store.minor.length;
    store.minor = store.minor.filter(minor =>
      !store.major.some(major => rangeContains(major.range, minor.range))
    );
    const removed = beforeCount - store.minor.length;
    if (removed > 0) {
      changes.push(`清理了 ${removed} 条被大总结覆盖的小总结`);
    }
  }

  // 2. 清理重叠的总结
  if (options.removeOverlapping !== false && diagnostic.overlappingRanges.length > 0) {
    // 处理小总结之间的重叠（保留范围更大的，或更新的）
    const minorToRemove = new Set<number>();
    for (const overlap of diagnostic.overlappingRanges) {
      if (overlap.type === 'minor-minor') {
        const [range1, range2] = overlap.ranges;
        const idx1 = store.minor.findIndex(m => m.range[0] === range1[0] && m.range[1] === range1[1]);
        const idx2 = store.minor.findIndex(m => m.range[0] === range2[0] && m.range[1] === range2[1]);
        if (idx1 >= 0 && idx2 >= 0) {
          const size1 = range1[1] - range1[0];
          const size2 = range2[1] - range2[0];
          if (size1 > size2) {
            minorToRemove.add(idx2);
          } else if (size2 > size1) {
            minorToRemove.add(idx1);
          } else {
            // 大小相同，保留更新的
            const time1 = new Date(store.minor[idx1].createdAt).getTime();
            const time2 = new Date(store.minor[idx2].createdAt).getTime();
            minorToRemove.add(time1 > time2 ? idx2 : idx1);
          }
        }
      }
    }
    if (minorToRemove.size > 0) {
      store.minor = store.minor.filter((_, idx) => !minorToRemove.has(idx));
      changes.push(`清理了 ${minorToRemove.size} 条重叠的小总结`);
    }

    // 处理大总结之间的重叠
    const majorToRemove = new Set<number>();
    for (const overlap of diagnostic.overlappingRanges) {
      if (overlap.type === 'major-major') {
        const [range1, range2] = overlap.ranges;
        const idx1 = store.major.findIndex(m => m.range[0] === range1[0] && m.range[1] === range1[1]);
        const idx2 = store.major.findIndex(m => m.range[0] === range2[0] && m.range[1] === range2[1]);
        if (idx1 >= 0 && idx2 >= 0) {
          const size1 = range1[1] - range1[0];
          const size2 = range2[1] - range2[0];
          if (size1 > size2) {
            majorToRemove.add(idx2);
          } else if (size2 > size1) {
            majorToRemove.add(idx1);
          } else {
            const time1 = new Date(store.major[idx1].createdAt).getTime();
            const time2 = new Date(store.major[idx2].createdAt).getTime();
            majorToRemove.add(time1 > time2 ? idx2 : idx1);
          }
        }
      }
    }
    if (majorToRemove.size > 0) {
      store.major = store.major.filter((_, idx) => !majorToRemove.has(idx));
      changes.push(`清理了 ${majorToRemove.size} 条重叠的大总结`);
    }
  }

  // 3. 修正 lastSummarizedIndex
  // ⚠️ 关键修复：lastSummarizedIndex 只增不减，防止消息污染
  if (options.fixLastSummarizedIndex !== false) {
    const allRanges = [...store.minor.map(m => m.range), ...store.major.map(m => m.range)];
    
    if (allRanges.length > 0) {
      const maxCovered = Math.max(...allRanges.map(r => r[1]));
      const correctedIndex = maxCovered + 1;
      
      // 情况1：lastSummarizedIndex 超出了消息总数（错误状态，需要回退）
      if (store.lastSummarizedIndex > conversationCount) {
        const oldIndex = store.lastSummarizedIndex;
        store.lastSummarizedIndex = Math.min(conversationCount, correctedIndex);
        changes.push(`修正 lastSummarizedIndex（超出消息总数）: ${oldIndex} → ${store.lastSummarizedIndex}`);
      }
      // 情况2：lastSummarizedIndex 小于实际覆盖范围（需要前进）
      else if (store.lastSummarizedIndex < correctedIndex) {
        const oldIndex = store.lastSummarizedIndex;
        store.lastSummarizedIndex = correctedIndex;
        changes.push(`修正 lastSummarizedIndex（向前推进）: ${oldIndex} → ${correctedIndex}`);
      }
      // 情况3：lastSummarizedIndex 大于实际覆盖范围
      // ⚠️ 这种情况下，消息 (maxCovered+1) 到 (lastSummarizedIndex-1) 之间有空洞
      // 但是这些消息已经存在于 uiMessages 中，不应该回退 lastSummarizedIndex
      // 因为回退会导致这些旧消息被重复包含在 prompt 中
      else if (store.lastSummarizedIndex > correctedIndex) {
        // 不回退！只记录警告
        const gapSize = store.lastSummarizedIndex - correctedIndex;
        changes.push(`⚠️ 检测到消息空洞: [${correctedIndex}, ${store.lastSummarizedIndex - 1}] (${gapSize} 条消息未被总结，但保留 lastSummarizedIndex 以防止消息污染)`);
      }
    } else if (store.lastSummarizedIndex > conversationCount) {
      // 没有任何摘要，但 lastSummarizedIndex 超出消息数
      const oldIndex = store.lastSummarizedIndex;
      store.lastSummarizedIndex = conversationCount;
      changes.push(`修正 lastSummarizedIndex（无摘要状态）: ${oldIndex} → ${conversationCount}`);
    }
  }

  return {
    fixed: changes.length > 0,
    changes,
    diagnostic,
  };
}

/**
 * 生成诊断报告的可读文本
 */
export function formatDiagnosticReport(diagnostic: SummaryDiagnostic): string {
  const lines: string[] = [];

  lines.push('=== 摘要系统诊断报告 ===');
  lines.push('');
  lines.push('基本状态：');
  lines.push(`  总消息数: ${diagnostic.totalMessages}`);
  lines.push(`  已总结到: ${diagnostic.lastSummarizedIndex}`);
  lines.push(`  待总结: ${diagnostic.pendingMessages} 条`);
  lines.push(`  小总结: ${diagnostic.minorCount} 条`);
  lines.push(`  大总结: ${diagnostic.majorCount} 条`);
  lines.push(`  全局总结: ${diagnostic.hasGlobal ? '有' : '无'}`);
  lines.push('');

  if (diagnostic.orphanedMinors.length > 0) {
    lines.push(`⚠️ 发现问题：${diagnostic.orphanedMinors.length} 条小总结被大总结覆盖但未清理`);
    for (const minor of diagnostic.orphanedMinors) {
      lines.push(`  - 小总结范围 [${minor.range[0]}, ${minor.range[1]}]`);
      const coveringMajor = diagnostic.majorRanges.find(major =>
        rangeContains(major, minor.range)
      );
      if (coveringMajor) {
        lines.push(`    被大总结 [${coveringMajor[0]}, ${coveringMajor[1]}] 覆盖`);
      }
    }
    lines.push('');
  }

  if (diagnostic.uncoveredGaps.length > 0) {
    lines.push(`⚠️ 发现问题：${diagnostic.uncoveredGaps.length} 个未被覆盖的消息段`);
    for (const gap of diagnostic.uncoveredGaps) {
      const gapSize = gap[1] - gap[0] + 1;
      lines.push(`  - 消息 [${gap[0]}, ${gap[1]}] (${gapSize} 条消息未被总结)`);
    }
    lines.push('');
  }

  if (diagnostic.overlappingRanges.length > 0) {
    lines.push(`⚠️ 发现问题：${diagnostic.overlappingRanges.length} 处重叠范围`);
    for (const overlap of diagnostic.overlappingRanges) {
      lines.push(`  - ${overlap.type}: [${overlap.ranges[0][0]}, ${overlap.ranges[0][1]}] 与 [${overlap.ranges[1][0]}, ${overlap.ranges[1][1]}]`);
    }
    lines.push('');
  }

  if (diagnostic.orphanedMinors.length === 0 &&
      diagnostic.uncoveredGaps.length === 0 &&
      diagnostic.overlappingRanges.length === 0) {
    lines.push('✅ 未发现问题，摘要系统状态正常');
  }

  return lines.join('\n');
}
