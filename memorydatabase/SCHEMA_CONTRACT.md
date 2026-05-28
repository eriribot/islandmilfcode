# memorydatabase Schema 行为契约

每张表的 INSERT/UPDATE/DELETE 触发条件、字段值域、容量上限的明确约定。代码消费方和 AI 写入方都应遵守此契约。

参考 YO 骰子表的五段式（note / initNode / insertNode / updateNode / deleteNode / ddl）。

---

## 通用规则

- 所有行继承 `MemoryBaseRow`：`id` / `createdAt` / `updatedAt` / `source` / `expired` / `supersededBy` / `lastSeenAt`
- 软删除用 `expired=true`，不要直接 splice 删除
- 写入时机统一：尽可能走 `upsert.ts` 的 upsert 函数，不要直接 push
- 查询统一走 `query.ts`，不要直接读 `db.X`

## 表 1：worldState（单例）

**用途**：当前世界状态。currentTime / currentLocation / currentMainEventId / storyStartDate / currentDay。  
**容量**：长度恒为 0 或 1（活跃行）。  
**INSERT**：仅在不存在活跃行时由 `upsertWorldState` 创建。  
**UPDATE**：浅合并 patch 字段，旧值不同才写。  
**DELETE**：禁止；schema 残留（多条活跃行）由 `upsertWorldState` 自动 expire 多余行。

## 表 2：attributes（角色属性快照）

**用途**：角色或 player 的当前数值/字符串属性。例：`{targetId:'英梨梨', key:'affinity', value:'42'}`。  
**容量**：每对 `(targetId, key)` 只保留 1 条活跃行。  
**写入**：累计值快照语义。  
- `affinity` / `obsession`：累计值（不再用 `affinity-delta` 键名）。变化时旧行 expire，新行带 `previousValue` 和 `delta`。  
- `outfit`：当前着装的字符串描述。  
- `stat-{知识|魅力|灵巧|体贴|勇气}`：玩家五维累计值。  
- `currentTime` / `currentLocation` / `currentMainEventId`：**禁止**写入 attributes 表，必须走 worldState。  
**INSERT/UPDATE**：统一走 `upsertAttribute`。value 不变只刷 lastSeenAt（unchanged）；变化时旧行 expire 并 supersededBy 指向新行。  
**DELETE**：禁止。

## 表 3：events（剧情事件快照）

**用途**：已发生的剧情节点 / 主线事件状态。  
**容量**：按 `relatedMainEventId`（优先）或 `title` 去重。同一事件只 1 条活跃行。  
**INSERT**：`upsertEvent` 在找不到匹配活跃行时创建。  
**UPDATE**：合并 description / outcome / gameTime / location / involvedTargetIds，刷新 lastSeenAt。  
**DELETE**：禁止；过时事件用 expire。

## 表 4：facts（关键事实）

**用途**：从摘要里抽取的承诺/秘密/关系/物品/事件/地点/人物设定，是 AI 上下文的"权威事实层"。  
**写入**：`commitBatch` 处理 facts.inserts 时调用 `deduplicateFact`。
- 同 subject + 同 content → 跳过（duplicate）
- 同 subject + 同 category 不同 content → 旧行 expired+supersededBy，新行插入（supersede）
- 否则 → 直接插入（new）

**DELETE**：禁止；过时事实用 expire 或 superseded。

## 表 5：tasks（待办/承诺）

**用途**：承诺、待办、约定。`status: 'pending' | 'done' | 'expired' | 'archived'`。  
**INSERT**：新承诺/待办通过手动编辑或摘要解析产生。  
**UPDATE**：完成时 `status='done'`，`resolvedAt` 填时间。  
**DELETE**：禁止；用 expire 或 status 切换。

## 表 6：secrets（秘密）

**用途**：特定角色知道但其他人不知道的信息。  
**写入**：现有 `findExistingSecret` 已处理同 subject 去重。  
**UPDATE**：`revealed=true` / 修改 `knownBy` / `hiddenFrom`。  
**DELETE**：禁止；暴露后用 `revealed=true` 标记，不删除。

## 表 7：items（物品）

**用途**：物品归属、数量、状态变化。  
**容量**：每个 `(name, ownerId)` 只 1 条活跃行。  
**写入**：`upsertItem`。
- `gained`：count += incoming.count（默认 1），刷新 state
- `lost`：count -= 1；count <= 0 → expired
- `transformed` / `noted`：直接更新

**DELETE**：禁止；count 归零后 expire。

## 表 8：phoneMessages（手机消息索引）

**用途**：手机消息的可检索索引（正文在 PhoneMessageStore）。  
**写入**：`indexPhoneMessage` 按 `messageId` 去重。已索引则跳过。  
**DELETE**：禁止；过期消息标记 expired。

## 表 9：summaries（小/大/全局摘要）

**用途**：三层压缩摘要。`level: 'minor' | 'major' | 'global'`。  
**写入**：`commitSummaryToMemoryDB` 在 `runSummary` 成功时插入。  
**DELETE**：禁止；过时小摘要应在升级为大摘要时 expire。

## 表 10：entities / relations / impressions

**用途**：角色登记、角色间关系、角色对玩家的印象。  
**当前状态**：未接入主写入路径，作为预留扩展点。  
**未来工作**：从 facts 表的 relation/profile 行派生，或由专门的 commit 点写入。

---

## 写入规范（给开发者）

### ✅ 正确

```ts
import { upsertAttribute } from './upsert';
upsertAttribute(db, {
  targetId: '英梨梨',
  key: 'affinity',
  value: '42',
  valueType: 'number',
});
```

### ❌ 错误

```ts
// 禁止直接 push
db.attributes.push({ targetId: '英梨梨', key: 'affinity-delta', value: '-1', ... });

// 禁止用 attributes 装 worldState
db.attributes.push({ targetId: 'world', key: 'currentTime', ... });
```

## 查询规范（给开发者）

### ✅ 正确

```ts
import { getCurrentAttributes, getWorldState, getPlayerInventory } from './query';
const attrs = getCurrentAttributes(db, '英梨梨');
const time = getWorldState(db)?.currentTime;
const inv = getPlayerInventory(db);
```

### ❌ 错误

```ts
// 自己写 filter，绕过统一查询层
const aff = db.attributes.filter(a => a.targetId === '英梨梨' && !a.expired);
```

---

## 变更记录

- v2（本次整治）：
  - attributes 改为快照语义，旧 `-delta` 键名废弃
  - 新增 worldState 单例表，承担时间/地点/当前主线事件
  - events / items / facts 全部接入 upsert
  - 新增 `query.ts` 统一查询层
  - 新增 `sweep.ts` 一次性迁移旧存档
