/**
 * MemoryDB 性能测试
 *
 * 运行方法：
 * - Node.js: node --loader ts-node/esm performance-test.ts
 * - 或在项目中集成到测试框架
 */

import { createDefaultMemoryDB } from './defaults';
import { commitBatch } from './upsert';
import { getNumericAttribute, getStringAttribute } from './query';
import { garbageCollect, getMemoryStats } from './gc';
import { rebuildIndexes, getIndexStats } from './indexes';
import type { IslandMemoryDB } from './types';

// ── 性能测试工具 ──

function benchmark(name: string, fn: () => void, iterations: number = 1000): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const elapsed = performance.now() - start;
  const avg = elapsed / iterations;
  console.log(`[benchmark] ${name}: ${elapsed.toFixed(2)}ms total, ${avg.toFixed(4)}ms avg (${iterations} iterations)`);
  return avg;
}

function generateTestData(db: IslandMemoryDB, rowCount: number): void {
  console.log(`\n[test] 生成 ${rowCount} 条测试数据...`);

  const batchSize = 100;
  const batches = Math.ceil(rowCount / batchSize);

  for (let b = 0; b < batches; b++) {
    const count = Math.min(batchSize, rowCount - b * batchSize);
    const attributes = [];

    for (let i = 0; i < count; i++) {
      const charId = `char${(b * batchSize + i) % 100}`; // 100 个角色循环
      const key = ['affinity', 'obsession', 'trust', 'jealousy'][i % 4];
      attributes.push({
        targetId: charId,
        key,
        value: String(Math.floor(Math.random() * 100)),
      });
    }

    commitBatch(db, {
      source: 'manual',
      inserts: { attributes },
    });
  }

  const stats = getMemoryStats(db);
  console.log(`[test] 数据生成完成: ${stats.totalRows} 行`);
}

// ── 测试 1: 索引查询性能 ──

function testIndexedQuery(db: IslandMemoryDB): void {
  console.log('\n━━━ 测试 1: 索引查询性能 ━━━');

  // 先生成 10000 条数据
  generateTestData(db, 10000);

  // 测试查询性能
  const avgWithIndex = benchmark('[有索引] getNumericAttribute', () => {
    getNumericAttribute(db, 'char50', 'affinity');
  }, 10000);

  // 模拟无索引的查询（直接扫描数组）
  const avgWithoutIndex = benchmark('[无索引] 线性扫描', () => {
    db.attributes.find(a => !a.expired && a.targetId === 'char50' && a.key === 'affinity');
  }, 10000);

  const speedup = avgWithoutIndex / avgWithIndex;
  console.log(`[result] 性能提升: ${speedup.toFixed(1)}x`);
  console.log(`[result] 有索引: ${avgWithIndex.toFixed(4)}ms, 无索引: ${avgWithoutIndex.toFixed(4)}ms`);
}

// ── 测试 2: 批量写入 + 去重性能 ──

function testBatchInsert(db: IslandMemoryDB): void {
  console.log('\n━━━ 测试 2: 批量写入 + 去重性能 ━━━');

  const start = performance.now();

  // 插入 1000 条数据（会触发去重检查）
  for (let i = 0; i < 1000; i++) {
    commitBatch(db, {
      source: 'manual',
      inserts: {
        attributes: [
          { targetId: 'testChar', key: 'counter', value: String(i) },
        ],
      },
    });
  }

  const elapsed = performance.now() - start;
  console.log(`[result] 插入 1000 条耗时: ${elapsed.toFixed(2)}ms (平均 ${(elapsed / 1000).toFixed(2)}ms/条)`);

  // 验证去重是否生效（同 targetId+key 应该只有最新一条活跃）
  const active = db.attributes.filter(a => !a.expired && a.targetId === 'testChar' && a.key === 'counter');
  console.log(`[result] 活跃行数: ${active.length} (预期: 1)`);
  console.log(`[result] 最新值: ${active[0]?.value} (预期: 999)`);
}

// ── 测试 3: GC 效果 ──

function testGarbageCollect(db: IslandMemoryDB): void {
  console.log('\n━━━ 测试 3: 垃圾回收效果 ━━━');

  // 生成数据并让其过期
  console.log('[test] 生成 5000 条数据...');
  generateTestData(db, 5000);

  // 模拟数据过期（手动标记 70% 为 expired）
  console.log('[test] 模拟数据过期...');
  const oldDate = new Date(Date.now() - 10 * 86400_000).toISOString(); // 10 天前
  let expiredCount = 0;
  for (let i = 0; i < db.attributes.length; i++) {
    if (i % 10 < 7) { // 70% 标记为 expired
      db.attributes[i].expired = true;
      db.attributes[i].updatedAt = oldDate;
      expiredCount++;
    }
  }

  const beforeStats = getMemoryStats(db);
  console.log(`[before] 总行数: ${beforeStats.totalRows}, 活跃: ${beforeStats.activeRows}, expired: ${beforeStats.expiredRows} (${(beforeStats.expiredRatio * 100).toFixed(1)}%)`);
  console.log(`[before] 估算大小: ${(beforeStats.estimatedBytes / 1024).toFixed(1)} KB`);

  // 执行 GC
  const gcResult = garbageCollect(db, 7); // 清理 7 天前的

  const afterStats = getMemoryStats(db);
  console.log(`[after] 总行数: ${afterStats.totalRows}, 活跃: ${afterStats.activeRows}, expired: ${afterStats.expiredRows}`);
  console.log(`[after] 估算大小: ${(afterStats.estimatedBytes / 1024).toFixed(1)} KB`);
  console.log(`[result] 清理了 ${gcResult.cleaned} 行 (${(gcResult.cleanedRatio * 100).toFixed(1)}%), 耗时 ${gcResult.elapsed.toFixed(2)}ms`);
  console.log(`[result] 内存节省: ${((1 - afterStats.estimatedBytes / beforeStats.estimatedBytes) * 100).toFixed(1)}%`);
}

// ── 测试 4: 索引重建性能 ──

function testIndexRebuild(db: IslandMemoryDB): void {
  console.log('\n━━━ 测试 4: 索引重建性能 ━━━');

  // 生成不同规模的数据，测试重建时间
  const sizes = [1000, 5000, 10000, 50000];

  for (const size of sizes) {
    const testDb = createDefaultMemoryDB('test');

    // 生成数据（不计时）
    for (let i = 0; i < size; i++) {
      testDb.attributes.push({
        id: `id${i}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'manual',
        targetId: `char${i % 100}`,
        key: 'affinity',
        value: String(i),
      });
    }

    // 测试重建时间
    const start = performance.now();
    rebuildIndexes(testDb);
    const elapsed = performance.now() - start;

    const stats = getIndexStats(testDb);
    console.log(`[result] ${size} 行数据重建索引: ${elapsed.toFixed(2)}ms (活跃: ${stats?.activeRows})`);
  }
}

// ── 测试 5: 大规模数据压力测试 ──

function testLargeScale(db: IslandMemoryDB): void {
  console.log('\n━━━ 测试 5: 大规模数据压力测试 ━━━');

  console.log('[test] 生成 50000 条数据...');
  generateTestData(db, 50000);

  const stats = getMemoryStats(db);
  console.log(`[result] 总行数: ${stats.totalRows}`);
  console.log(`[result] 估算大小: ${(stats.estimatedBytes / 1024 / 1024).toFixed(2)} MB`);

  // 测试查询性能
  const avgQuery = benchmark('[50k数据] 索引查询', () => {
    getNumericAttribute(db, 'char50', 'affinity');
  }, 1000);

  console.log(`[result] 查询延迟: ${avgQuery.toFixed(4)}ms (仍保持 O(1))`);

  // 测试 GC
  console.log('[test] 执行 GC...');
  const gcResult = garbageCollect(db, 7);
  console.log(`[result] GC 耗时: ${gcResult.elapsed.toFixed(2)}ms`);
}

// ── 主测试入口 ──

export function runPerformanceTests(): void {
  console.log('\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
  console.log('┃  MemoryDB 性能测试套件            ┃');
  console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n');

  try {
    // 测试 1: 索引查询性能
    const db1 = createDefaultMemoryDB('test1');
    testIndexedQuery(db1);

    // 测试 2: 批量写入
    const db2 = createDefaultMemoryDB('test2');
    testBatchInsert(db2);

    // 测试 3: GC 效果
    const db3 = createDefaultMemoryDB('test3');
    testGarbageCollect(db3);

    // 测试 4: 索引重建
    testIndexRebuild(createDefaultMemoryDB('test4'));

    // 测试 5: 大规模压力测试
    const db5 = createDefaultMemoryDB('test5');
    testLargeScale(db5);

    console.log('\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
    console.log('┃  ✅ 所有测试完成                   ┃');
    console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n');

  } catch (error) {
    console.error('\n❌ 测试失败:', error);
    throw error;
  }
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  runPerformanceTests();
}
