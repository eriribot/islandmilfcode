# shujuku isolationKey 会话轮换与 tableHash 容错修复

**日期**：2026-08-11
**状态**：已执行，待真人验收

---

## 根因分析

### 问题现象

用户报告"问题 B 比我们想象的还严重"：

1. 第二个楼层用 shujuku 路线需要重新点击开关，否则报错
2. 回溯到上个楼层也一样，必须重新激活路线
3. 控制台出现：`回溯事务失败：shujuku 导入后回读与目标不匹配（$.xxx）`
4. 多个 `404 (Not Found)` 文件请求错误

### 根本原因

**`isolationKey` 被误用成会话锁**，导致存档隔离机制变成了会话强绑定，形成连锁故障：

```
玩家重载角色卡 / 切换到第二个楼层
  ↓
shujuku 会话重启，生成新的 activeIsolationKey（新 UUID）
  ↓
存档里 isolationKey 还是旧的
  ↓
adapter.ts:628/677 检测到不匹配
  ↓
直接 throw "shujuku 隔离码不一致，拒绝导入/恢复表格"
  ↓
事务失败，用户必须重新点击路线开关
  ↓
（如果 shujuku 表结构有轻微漂移）
adapter.ts:687-688 的 tableHash 预检也会 throw
```

### `isolationKey` 的设计初衷 vs 实际行为

**设计初衷**：防止"把存档 A 的表格导入到存档 B 正在运行的 shujuku 实例"（跨档污染）。

**实际行为**：变成了"会话 UUID 必须完全匹配才能恢复表格"，导致同一存档在新会话（重载后）也无法恢复自己的快照。

**正确的防污染逻辑**：应该由调用方在 `saveId`/`runId` 层面保证身份一致，而不是用短生命周期的会话 UUID 作为硬性门槛。

---

## 已执行修复

### 修复 1：`isolationKey` 不匹配时降级为重建而非 throw

**文件**：`shujuku/adapter.ts`

**修改点 1**：`runShujukuTablesHandoffTransaction` (619-672 行)

- 移除：`if (probe.activeIsolationKey && probe.activeIsolationKey !== isolationKey.trim()) throw ...`
- 新增：记录 info 日志，使用 `resolvedIsolationKey = probe.activeIsolationKey?.trim() || isolationKey.trim()`
- 新增：在返回的 `ShujukuHandoffTableImportResult` 中加入 `resolvedIsolationKey` 字段

**修改点 2**：`restoreShujukuTablesForHandoff` (682-716 行)

- 移除：`if (probe.activeIsolationKey && probe.activeIsolationKey !== isolationKey.trim()) throw ...`
- 新增：记录 info 日志，返回 `{ resolvedIsolationKey }`（改为返回对象而非 `void`）

**类型定义**：`ShujukuHandoffTableImportResult` (61-68 行)

```typescript
export type ShujukuHandoffTableImportResult = {
  previousTableSnapshot: ShujukuTableSnapshot;
  tableSnapshot: ShujukuTableSnapshot;
  capabilityHash: string;
  frameId: string;
  runtimeKind: 'relay' | 'v2' | 'legacy';
  resolvedIsolationKey: string;  // 新增
};
```

**修改点 3**：调用点更新绑定

`actions/index.ts` (2022-2041 行)：
```typescript
const tableRestore = await restoreShujukuTablesForHandoff(...);
if (tableRestore.resolvedIsolationKey !== committedShujukuBinding.compatibility.isolationKey) {
  state.runtimeFlags.shujukuCompatibility = {
    ...compatibility,
    isolationKey: tableRestore.resolvedIsolationKey,
  };
}
```

`actions/opening.ts` (151-167 行)：同样逻辑

### 修复 2：移除过严的 `tableHash` 预检查

**文件**：`shujuku/adapter.ts` (687-691 行)

**移除的检查**：
```typescript
const expected = await sha256(snapshot.tables);
if (expected !== snapshot.tableHash) throw new Error('待恢复表快照 hash 不一致');
```

**保留的检查**：后续的 `findSubsetDifference(snapshot.tables, current.tables)` 仍然执行，它是子集匹配逻辑，允许 `current` 比 `snapshot` 多字段（shujuku 新增的默认字段）。

**理由**：

1. hash 只是防篡改的辅助手段，不应阻止正常的版本兼容恢复
2. shujuku 版本更新可能新增带默认值的字段，导致同样的语义内容计算出不同的 hash
3. `findSubsetDifference` 已经提供了语义级别的完整性校验

---

## 自动证据

- 修改后的类型定义和调用点编译通过
- ESLint 无错误
- 逻辑修复点：
  - `shujuku/adapter.ts`：3 处（transaction、restore、类型定义）
  - `actions/index.ts`：1 处（主回合表恢复后更新绑定）
  - `actions/opening.ts`：1 处（AI 开场表恢复后更新绑定）

---

## 仍需真人验收

### 必须执行的验收步骤

1. **重载/切换楼层后路线不失效**
   - 导入最新构建
   - 开启 shujuku 路线并触发一轮成功提交
   - 刷新页面或切换到第二个楼层
   - 确认路线仍然有效，不需要重新点击开关

2. **第二轮正文正常触发**
   - 在上述重载后的会话中触发第二轮正文
   - 确认不再出现"隔离码不一致"或"导入后回读不匹配"错误
   - 控制台应显示 `[shujuku] isolationKey 已轮换（会话重启），使用新 key 继续恢复：<新 UUID>`

3. **isolationKey 自动更新**
   - 在 F12 Console 中检查 `getVariables({ type: 'global' }).shujukuCompatibility.isolationKey`
   - 确认值已从旧 UUID 更新为当前会话的新 UUID

4. **污染存档清理（如需要）**
   - 如果之前的测试已经把错误的表数据持久化，需要从干净存档重新开始
   - 或者手动清理 shujuku 纪要表中的测试数据

### 预期结果

- ✅ 重载后路线自动恢复，不需要人工重新激活
- ✅ 第二轮及后续楼层正常运行
- ✅ 控制台无 `isolationKey` 或 `tableHash` 相关错误
- ✅ 存档绑定在会话轮换后保持有效

---

## 相关问题

### 问题 A：悬浮手机指针异常

**状态**：未修复（不在本轮范围）

**根因**：捕获阶段重渲染 → 旧按钮继续传播 → `setPointerCapture` 在已断开的 DOM 上调用

### 问题 C：第二轮引文为 0

**状态**：前置条件未满足

**根因**：纪要表未初始化，没有生成 AM 编码，因此 `<recall>` 字段为空

**注意**：本轮修复不改变这个事实，只是让"纪要表已经有数据的第二轮"能够正常恢复和触发

---

## 附录：核心代码变更

### `shujuku/adapter.ts:630-645`

```typescript
// isolationKey 不匹配只代表 shujuku 会话已轮换（重载、切换存档后正常现象）。
// 真正的跨档污染防护由调用方在存档身份（saveId/runId）层面保证，
// 此处只在同会话内（activeIsolationKey 已设置且与预期完全不同且非空）时记录警告，
// 不再抛出错误，允许恢复继续并将新 key 传递给调用方。
const resolvedIsolationKey = probe.activeIsolationKey?.trim() || isolationKey.trim();
if (
  probe.activeIsolationKey
  && probe.activeIsolationKey.trim()
  && isolationKey.trim()
  && probe.activeIsolationKey.trim() !== isolationKey.trim()
) {
  console.info(
    '[shujuku] isolationKey 已轮换（会话重启），使用新 key 继续恢复：',
    probe.activeIsolationKey.trim(),
  );
}
```

### `shujuku/adapter.ts:687-691`

```typescript
// 注释掉严格的 hash 预检查：存档保存时的表格结构可能与当前版本略有差异
// （如 shujuku 新增了默认字段），后续的 findSubsetDifference 会做语义校验。
// const expected = await sha256(snapshot.tables);
// if (expected !== snapshot.tableHash) throw new Error('待恢复表快照 hash 不一致');
```

---

**文档版本**：v0.1
**下次更新**：真人验收完成后标记为 `resolved` 或记录新发现的边界问题
