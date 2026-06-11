/**
 * 摘要系统修复功能测试
 *
 * 运行此测试以验证修复工具的正确性
 */

import { diagnoseSummaryStore, repairSummaryStore } from './repair';
import { createDefaultSummaryStore } from './types';
import type { SummaryStore } from './types';
import type { UiMessage } from '../types';

// 创建测试用的消息
function createTestMessages(count: number): UiMessage[] {
  const messages: UiMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `Test message ${i}`,
      rawText: `Test message ${i}`,
      streaming: false,
      speaker: i % 2 === 0 ? 'User' : 'Assistant',
    });
  }
  return messages;
}

// 测试场景1：被大总结覆盖但未清理的小总结
function testOrphanedMinors() {
  console.log('\n=== 测试1：孤立小总结检测 ===');

  const store = createDefaultSummaryStore();
  const messages = createTestMessages(20);

  // 添加小总结
  store.minor.push(
    { range: [0, 4], text: '小总结1', createdAt: new Date().toISOString() },
    { range: [5, 9], text: '小总结2', createdAt: new Date().toISOString() },
    { range: [10, 14], text: '小总结3', createdAt: new Date().toISOString() },
    { range: [15, 19], text: '小总结4', createdAt: new Date().toISOString() },
  );

  // 添加大总结（覆盖前两个小总结）
  store.major.push({
    range: [0, 9],
    text: '大总结1（覆盖0-9）',
    createdAt: new Date().toISOString(),
  });

  store.lastSummarizedIndex = 20;

  // 诊断
  const diagnostic = diagnoseSummaryStore(store, messages);
  console.log(`小总结总数: ${diagnostic.minorCount}`);
  console.log(`大总结总数: ${diagnostic.majorCount}`);
  console.log(`孤立小总结: ${diagnostic.orphanedMinors.length}`);

  if (diagnostic.orphanedMinors.length === 2) {
    console.log('✅ 正确检测到2个孤立小总结');
  } else {
    console.log(`❌ 预期2个孤立小总结，实际检测到 ${diagnostic.orphanedMinors.length}`);
  }

  // 修复
  const result = repairSummaryStore(store, messages, { removeOrphanedMinors: true });
  console.log(`修复结果: ${result.fixed ? '已修复' : '无需修复'}`);
  console.log(`修复后小总结数: ${store.minor.length}`);

  if (store.minor.length === 2) {
    console.log('✅ 成功清理孤立小总结');
  } else {
    console.log(`❌ 预期剩余2个小总结，实际 ${store.minor.length}`);
  }
}

// 测试场景2：lastSummarizedIndex 不准确
function testLastSummarizedIndex() {
  console.log('\n=== 测试2：lastSummarizedIndex 修复 ===');

  const store = createDefaultSummaryStore();
  const messages = createTestMessages(30);

  // 添加摘要但 lastSummarizedIndex 不准确
  store.minor.push(
    { range: [0, 4], text: '小总结1', createdAt: new Date().toISOString() },
    { range: [5, 9], text: '小总结2', createdAt: new Date().toISOString() },
  );
  store.major.push({
    range: [10, 19],
    text: '大总结1',
    createdAt: new Date().toISOString(),
  });

  // 错误的 lastSummarizedIndex（应该是20，但设置为25）
  store.lastSummarizedIndex = 25;

  console.log(`修复前 lastSummarizedIndex: ${store.lastSummarizedIndex}`);

  // 修复
  const result = repairSummaryStore(store, messages, { fixLastSummarizedIndex: true });
  console.log(`修复后 lastSummarizedIndex: ${store.lastSummarizedIndex}`);

  if (store.lastSummarizedIndex === 20) {
    console.log('✅ lastSummarizedIndex 修复正确');
  } else {
    console.log(`❌ 预期 lastSummarizedIndex=20，实际 ${store.lastSummarizedIndex}`);
  }
}

// 测试场景3：消息空洞检测
function testUncoveredGaps() {
  console.log('\n=== 测试3：消息空洞检测 ===');

  const store = createDefaultSummaryStore();
  const messages = createTestMessages(30);

  // 创建一个空洞：0-9有摘要，10-14没有，15-19有摘要
  store.minor.push(
    { range: [0, 9], text: '小总结1', createdAt: new Date().toISOString() },
    { range: [15, 19], text: '小总结2', createdAt: new Date().toISOString() },
  );
  store.lastSummarizedIndex = 20;

  const diagnostic = diagnoseSummaryStore(store, messages);
  console.log(`检测到 ${diagnostic.uncoveredGaps.length} 个消息空洞`);

  if (diagnostic.uncoveredGaps.length === 1) {
    const gap = diagnostic.uncoveredGaps[0];
    console.log(`空洞范围: [${gap[0]}, ${gap[1]}]`);
    if (gap[0] === 10 && gap[1] === 14) {
      console.log('✅ 正确检测到消息空洞');
    } else {
      console.log(`❌ 预期空洞 [10, 14]，实际 [${gap[0]}, ${gap[1]}]`);
    }
  } else {
    console.log(`❌ 预期1个空洞，实际 ${diagnostic.uncoveredGaps.length}`);
  }
}

// 运行所有测试
export function runSummaryRepairTests() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║   摘要系统修复功能测试                ║');
  console.log('╚═══════════════════════════════════════╝');

  try {
    testOrphanedMinors();
    testLastSummarizedIndex();
    testUncoveredGaps();

    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║   所有测试完成                        ║');
    console.log('╚═══════════════════════════════════════╝\n');
  } catch (error) {
    console.error('\n❌ 测试过程中发生错误:', error);
  }
}

// 如果直接运行此文件，执行测试
if (typeof window !== 'undefined' && (window as any).__runSummaryTests) {
  runSummaryRepairTests();
}
