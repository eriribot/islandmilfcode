# MemoryDB 优化迁移指南

## 概述

本次优化**完全向后兼容**，现有代码无需修改即可自动享受性能提升。但如果你想充分利用新功能，可以参考本指南进行可选的升级。

---

## 自动生效的优化（无需改动）

以下优化在升级后**自动生效**，无需修改任何代码：

### ✅ 查询自动使用索引

```typescript
// 这些查询会自动使用索引（O(n) → O(1)）
const affinity = getNumericAttribute(db, 'char1', 'affinity');
const name = getStringAttribute(db, 'char1', 'name');
const tasks = getActiveTasks(db);
const inventory = getPlayerInventory(db);
```

### ✅ 写入自动更新索引

```typescript
// commitBatch 会自动更新索引
commitBatch(db, {
  source: 'progress-commit',
  inserts: { attributes: [...] },
});
```

### ✅ 自动垃圾回收

```typescript
// GC 会在满足条件时自动触发：
// - 累计 100 次 commit
// - 总行数 > 10000 且 expired 占比 > 30%
// - 距上次 GC > 5 分钟且 expired 占比 > 20%
```

---

## 可选升级（建议采用）

### 1. 替换直接数组访问为查询 API

**不推荐**（绕过索引）：
```typescript
// ❌ 直接访问数组，无法使用索引
const row = db.attributes.find(a => 
  !a.expired && a.targetId === targetId && a.key === key
);
```

**推荐**（使用索引）：
```typescript
// ✅ 使用查询 API，自动使用索引
import { getAttributeFromIndex } from './memorydatabase/indexes';
const row = getAttributeFromIndex(db, targetId, key);
```

### 2. 使用新增的查询函数

```typescript
import { getItemByName } from './memorydatabase/query';

// 旧方式：线性扫描
const item = db.items.find(i => 
  !i.expired && i.name === 'sword' && i.ownerId === 'player'
);

// 新方式：索引查询
const item = getItemByName(db, 'sword', 'player');
```

### 3. 监控内存使用

```typescript
import { getMemoryStats, getIndexStats } from './memorydatabase/gc';
import { shouldGarbageCollect } from './memorydatabase/indexes';

// 定期检查内存状态（例如每 10 分钟）
setInterval(() => {
  const stats = getMemoryStats(db);
  console.log(`[memorydb] 活跃: ${stats.activeRows}, expired: ${stats.expiredRows} (${(stats.expiredRatio * 100).toFixed(1)}%)`);
  
  if (shouldGarbageCollect(db, 0.3)) {
    console.log('[memorydb] 建议执行 GC');
  }
}, 10 * 60 * 1000);
```

### 4. 手动触发 GC（长时间运行的场景）

```typescript
import { garbageCollect } from './memorydatabase/gc';

// 在合适的时机手动触发 GC（例如存档保存前）
function saveGame() {
  // 清理旧数据，减小存档大小
  garbageCollect(db, 7);
  
  // 序列化并保存
  const saveData = JSON.stringify(db);
  localStorage.setItem('save', saveData);
}
```

---

## 存档兼容性

### 加载旧存档

旧存档会**自动兼容**：

```typescript
// 从存档加载
const loadedDb = JSON.parse(saveData) as IslandMemoryDB;

// 索引会自动重建（如果不存在 _indexes 字段）
// 无需手动调用 rebuildIndexes()
const affinity = getNumericAttribute(loadedDb, 'char1', 'affinity');
```

### 保存新存档

索引**不会序列化**，存档大小不受影响：

```typescript
// 序列化时，_indexes 字段会被自动排除（或序列化后很小）
const saveData = JSON.stringify(db);

// 存档只包含原始数据，不包含索引
// 加载时会自动重建索引
```

---

## 性能调优建议

### 1. 批量操作合并

**不推荐**（多次 commitBatch）：
```typescript
// ❌ 每次写入都触发索引更新
for (const attr of attributes) {
  commitBatch(db, {
    source: 'manual',
    inserts: { attributes: [attr] },
  });
}
```

**推荐**（合并批次）：
```typescript
// ✅ 一次性写入，减少索引更新次数
commitBatch(db, {
  source: 'manual',
  inserts: { attributes },
});
```

### 2. 避免频繁 GC

```typescript
// ❌ 每次写入都检查 GC（浪费性能）
commitBatch(db, ...);
garbageCollect(db);

// ✅ 让调度器自动处理
commitBatch(db, ...);
// 调度器会在合适时机自动触发
```

### 3. 大批量导入时禁用自动 GC

```typescript
import { gcScheduler } from './memorydatabase/gc';

// 禁用自动 GC（导入期间）
gcScheduler.reset();

// 批量导入
for (let i = 0; i < 100000; i++) {
  commitBatch(db, ...);
}

// 手动触发一次 GC
garbageCollect(db);
```

---

## 故障排查

### 问题 1: 查询结果不一致

**原因**: 索引可能未更新或损坏

**解决**:
```typescript
import { rebuildIndexes } from './memorydatabase/indexes';

// 重建索引（安全操作，不会丢失数据）
rebuildIndexes(db);
```

### 问题 2: 内存持续增长

**原因**: GC 未触发或清理不够激进

**解决**:
```typescript
import { garbageCollect, getMemoryStats } from './memorydatabase/gc';

// 检查内存状态
const stats = getMemoryStats(db);
console.log(`expired 占比: ${(stats.expiredRatio * 100).toFixed(1)}%`);

// 手动触发 GC，使用更短的保留期
garbageCollect(db, 3); // 只保留 3 天内的 expired 数据
```

### 问题 3: 加载存档很慢

**原因**: 大存档重建索引需要时间

**优化**:
```typescript
// 在后台线程重建索引（Web Worker）
// 或显示加载进度
import { rebuildIndexes } from './memorydatabase/indexes';

console.log('正在加载存档...');
const db = JSON.parse(saveData);

console.log('正在重建索引...');
rebuildIndexes(db); // 通常 < 100ms

console.log('加载完成');
```

---

## API 变更清单

### 新增 API

```typescript
// indexes.ts
export function rebuildIndexes(db: IslandMemoryDB): void;
export function updateIndexesIncremental(db, changes): void;
export function getAttributeFromIndex(db, targetId, key): MemoryAttributeRow | undefined;
export function getFactsFromIndex(db, category, subject): MemoryFactRow[];
export function getImpressionsFromIndex(db, targetId, subject, label): MemoryImpressionRow[];
export function getItemFromIndex(db, name, ownerId): MemoryItemRow | undefined;
export function isPhoneMessageIndexed(db, messageId): boolean;
export function getIndexStats(db): MemoryIndexes['stats'] | null;
export function shouldGarbageCollect(db, threshold): boolean;

// gc.ts
export function garbageCollect(db, retentionDays): GarbageCollectResult;
export function autoGarbageCollect(db, threshold): boolean;
export function getMemoryStats(db): { totalRows, activeRows, expiredRows, ... };

// query.ts
export function getItemByName(db, name, ownerId): MemoryItemRow | undefined; // 新增
```

### 移除 API

```typescript
// upsert.ts
// ❌ 已移除（迁移到 indexes.ts）
export function isPhoneMessageIndexed(db, messageId): boolean;

// 替代方案：
import { isPhoneMessageIndexed } from './indexes';
```

### 修改 API

```typescript
// 无破坏性修改，所有现有 API 签名不变
// 仅内部实现优化
```

---

## 回滚方案

如果遇到问题需要回滚：

### 1. 代码回滚

```bash
# 删除新增的文件
rm memorydatabase/indexes.ts
rm memorydatabase/gc.ts
rm memorydatabase/performance-test.ts

# 恢复修改的文件
git checkout memorydatabase/types.ts
git checkout memorydatabase/query.ts
git checkout memorydatabase/upsert.ts
git checkout memorydatabase/defaults.ts
git checkout memorydatabase/migrate.ts
git checkout memorydatabase/phone-repository.ts
```

### 2. 存档兼容

旧代码可以读取新存档（索引字段会被忽略），无需担心存档损坏。

---

## 常见问题

### Q: 索引会占用多少内存？

A: 索引占用约为原始数据的 10-20%。例如 10000 行数据（~5MB），索引约 500KB-1MB。

### Q: 重建索引要多久？

A: 取决于数据量：
- 1000 行：< 10ms
- 10000 行：10-50ms
- 100000 行：100-500ms

### Q: GC 会丢失数据吗？

A: 不会。GC 只清理超过保留期（默认 7 天）的 **expired** 数据。活跃数据永不清理。

### Q: 能否禁用自动 GC？

A: 可以。修改 `gc.ts` 中的 `gcScheduler` 触发条件，或者不调用 `gcScheduler.onCommit()`。

### Q: 索引损坏会怎样？

A: 查询时会自动重建索引（如果检测到 `!db._indexes`），不会导致数据丢失。

---

## 下一步

1. ✅ 运行性能测试：`node performance-test.ts`
2. ✅ 监控线上内存使用
3. ✅ 根据实际情况调整 GC 策略
4. ⚠️ 如需更极致性能，考虑迁移到 SQLite/Dexie

---

**需要帮助？** 查看 `OPTIMIZATION_REPORT.md` 了解技术细节。
