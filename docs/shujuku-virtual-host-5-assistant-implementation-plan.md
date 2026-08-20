# shujuku 虚拟宿主 5-assistant 实现蓝图

**日期**：2026-08-11  
**范围**：10 条逻辑消息 = 5 个 assistant，ACU 工作台长期显示 AI 第5层  
**状态**：第一阶段完成，剩余核心复杂度待实现

## 执行摘要

**目标合同**：
- 真实 Tavern 宿主始终只有 `chat[0]`（root assistant）
- 10 条逻辑消息（5 user + 5 assistant）映射为 5 个 assistant 回合
- 所有 ACU mutations 只提交 Island archive，禁止落入真实宿主
- 生成结束后 ACU 工作台/DICE 长期显示 `AI 第5层`

**当前进度**：
- ✅ 协议层：`ShujukuVirtualMessageInput` 增加 `logicalId`/`exchangeId`/`floorIndex`
- ✅ 会话管理器：`shujuku/runtime-session.ts` 提供生命周期和 mutation 跟踪
- ✅ 桥接层：数据库转发桥支持 `rootMessage` 和稳定 ID 传递
- ✅ 调用点：`actions/index.ts` 和 `actions/opening.ts` 传递完整 rootMessage
- ⏳ **核心缺口**：桥尚未构造完整虚拟 `chat[]`（仍只是窗口临时拼接）

## 架构诊断

### 当前实现的局限

GPT 方案列出的"必改清单"精确，但有一个关键误判：

> **数据库转发桥.js**：构造 Tavern-compatible `chat[]`；数字 `message_id` 只作数组索引；所有 `save/set/create/delete` 转发 Island，禁止落入真实宿主

**实际情况**：
1. 桥的 `buildVirtualChat(input)` 只构造**当前回合的窗口**，不是完整时间线
2. `input.messages` 来自 `actions/index.ts:2057`，只包含 `promptHistory.slice(rootMessage ? 1 : 0)`
3. 这是 Island 的**分页提示词窗口**，不是 archive 的完整历史
4. 因此"10 条消息 = 5 个 assistant"的映射**尚未实现**

### 根因：两层架构职责错配

```
Island (actions/index.ts)
  ↓ 传递：promptHistory 的当前窗口（可能只有最近 3 轮）
桥 (buildVirtualChat)
  ↓ 构造：临时 chat[] 用于本轮生成
shujuku runtime
  ↓ 生成后：storageFrame 写入当前 assistant
  ↓ 问题：ACU 只看到窗口内的消息计数
```

**正确架构**：

```
Island archive
  ↓ hydrateArchiveMessages()：完整时间线
Island session manager
  ↓ 维护：10 条逻辑消息 + 稳定 ID 映射
  ↓ 生成时：传递完整 timeline + rootMessage
桥 (buildVirtualChat)
  ↓ 构造：完整虚拟 chat[]，包含所有历史
  ↓ ACU 计数：基于完整数组，显示 AI 第5层
shujuku runtime
  ↓ storageFrame：只保存当前 assistant 的 isolated data
  ↓ ACU 读取：通过桥的 provider 读到虚拟 chat[]
```

## 实现蓝图

### 第二阶段：虚拟宿主持久化（中等复杂度）

**文件**：`shujuku/IslandMilfCode数据库转发桥.js`

**当前代码**（约 793-825 行）：
```javascript
function buildVirtualChat(input) {
  const rootMessage = input.rootMessage;
  // ... 构造 chat[0]
  for (const message of input.messages) {
    chat.push(toVirtualMessage(message, chat.length));
  }
  // input.messages 只是窗口，不是完整历史
}
```

**需要改造**：
1. `input.messages` 必须是**完整逻辑时间线**（从 archive 读取）
2. 虚拟 `chat[]` 的 `message_id` 必须稳定映射：
   - `chat[0]` = root assistant
   - `chat[1]` = logical user 1（exchange 1）
   - `chat[2]` = logical assistant 1（exchange 1）
   - `chat[3]` = logical user 2（exchange 2）
   - `chat[4]` = logical assistant 2（exchange 2）
   - ...
   - `chat[9]` = logical user 5（exchange 5）
   - `chat[10]` = logical assistant 5（exchange 5，当前生成）

3. 不能用数组索引作为稳定 ID（回滚/删除会错位）
4. 必须在 `installVirtualChatOverlay()` 中持久化替换：
   - `chat` 数组
   - `getChatMessages()` / `setChatMessages()`
   - `getContext()` 返回的虚拟上下文

**预估**：需重写 `buildVirtualChat` 和 overlay 逻辑（约 150 行）

### 第三阶段：生命周期管理（中等偏高复杂度）

**文件**：
- `index.ts:1443` `enterSave()`
- `index.ts` 换档/unload 路径
- `shujuku/adapter.ts` 新增 `openVirtualHostSession()` / `closeVirtualHostSession()`

**职责**：
1. **Open session**（`enterSave` 完成 archive 读取后）：
   - 从 `hydrateArchiveMessages(saveId)` 取完整时间线
   - 构造 `VirtualHostSession`：
     - `timeline`: 所有 logical messages（含稳定 ID）
     - `rootMessage`: chat[0]
     - `isolationKey`: 当前 shujuku compatibility
   - 注册到 `runtime-session.ts` 的 active map

2. **Sync session**（每次生成完成后）：
   - 记录新 `SessionMutation`（kind: 'create'，新 assistant）
   - 更新 `timeline` 和 `revision`
   - 调用 `archive-repository.ts` 批量写回

3. **Close session**（换档、unload、标题页）：
   - 刷新未提交的 pending mutations
   - 清理 active session
   - 恢复原生 provider（如果有）

**难点**：
- Island 的 `enterSave` 有多个分支（v3 archive / legacy / recovery）
- 换档路径不止一个（标题页、删除、导入、crash recovery）
- 必须保证 session close 的原子性（不能遗留 provider）

**预估**：需梳理完整生命周期并插入 3-5 个调用点（约 200 行 + 测试）

### 第四阶段：写操作回传（高复杂度）

**文件**：
- `shujuku/IslandMilfCode数据库转发桥.js`：拦截 `setChatMessages` / `createChatMessages` / `deleteChatMessages`
- `state/archive-repository.ts`：按稳定 ID 批量更新

**当前问题**：
- ACU 的 `setChatMessages()` 会尝试写回宿主
- 如果写入真实宿主，会破坏"始终只有 chat[0]"的合同
- 如果完全禁止，ACU 的某些功能会失效

**正确方案**：
1. 桥的 `installVirtualChatOverlay()` 提供假的 `setChatMessages`：
   ```javascript
   const handlers = {
     setChatMessages: (updates) => {
       // 转换为 SessionMutation
       for (const update of updates) {
         const logicalId = update._islandmilfcode_logical_id;
         recordSessionMutation(saveId, runId, {
           kind: 'update',
           logicalId,
           message: convertToPersistedMessage(update),
         });
       }
       // 更新虚拟 chat[] 的内存副本
       applyVirtualUpdates(chat, updates);
       // 禁止落入真实宿主
     },
   };
   ```

2. Island 在下一次 `persistConversation()` 时：
   - 调用 `flushSessionMutations(saveId, runId)`
   - 按 `logicalId` 批量更新 `archive-repository`
   - 不触碰真实宿主的 `chat[]`

**难点**：
- 必须拦截**所有** Tavern API（`saveChat`、`deleteLastMessage` 等）
- 稳定 ID 映射必须双向（`message_id` ↔ `logicalId`）
- 删除操作需要特殊处理（tombstone？还是直接 archive delete？）

**预估**：需完整审计 Tavern API 并逐个包装（约 300 行 + 大量测试）

### 第五阶段：验证与修复（未知复杂度）

**验证合同**：
1. 打开 100 层存档 → session open → 虚拟 chat[] 包含 100 条
2. 生成一轮新正文 → ACU 工作台显示 `AI 第51层`
3. 刷新页面 → session close/reopen → 工作台仍显示 `AI 第51层`
4. 回滚到第 48 层 → session sync → 工作台降为 `AI 第48层`
5. 切换到另一存档 → 旧 session close → 新 session open → 计数独立
6. DICE 自动回写 → 写入被拦截 → Island 收到 mutation → archive 更新

**预期问题**：
- Provider 恢复不干净（刷新后 ACU 仍读到旧数据）
- 稳定 ID 冲突（删除后 exchangeId 复用）
- 性能（1000 层时构造虚拟 chat[] 耗时过长）
- shujuku isolationKey 轮换与 session 不同步

## 复杂度评估

| 阶段 | 文件 | 行数估算 | 风险 | 前置依赖 |
|---|---|---|---|---|
| 第一阶段（已完成） | adapter.ts, runtime-session.ts, 桥, actions | ~150 | 低 | 无 |
| 第二阶段 | 数据库转发桥.js | ~150 | 中 | 完整 timeline 传递 |
| 第三阶段 | index.ts, adapter.ts | ~200 | 中高 | 第二阶段 |
| 第四阶段 | 桥, archive-repository.ts | ~300 | 高 | 第三阶段 |
| 第五阶段 | 验证 + 修复 | ? | 未知 | 第四阶段 |
| **总计** | | **~800** | | |

**关键风险点**：
1. ❌ **当前调用点传递的仍是窗口，不是完整历史**（第二阶段必改）
2. ❌ **session 生命周期未实现**（第三阶段必改）
3. ❌ **写操作未拦截**（第四阶段必改）
4. ⚠️ **Archive 批量更新 API 尚不存在**（需扩展 `archive-repository.ts`）
5. ⚠️ **真实宿主 chat[0] 的保护尚未验证**（可能需要额外 guard）

## 与 GPT 方案的对比

| 项目 | GPT 方案 | 实际情况 | 差异 |
|---|---|---|---|
| adapter.ts | 增加 logicalId 协议 | ✅ 已完成 | 一致 |
| 数据库转发桥 | 构造完整 chat[] | ❌ 仍是窗口 | **关键缺口** |
| actions/index.ts | 传递完整 root | ✅ 已完成 | 一致 |
| index.ts 生命周期 | open/sync/close | ❌ 未实现 | **必改** |
| archive-repository | 批量更新 API | ❌ 不存在 | **必改** |
| shujukuinject/ | 不改 | ✅ 正确 | 一致 |
| ACU 扩展 | scoped provider | ⚠️ 可选 | 备选方案 |

**结论**：GPT 的架构清单正确，但**低估了桥的改造复杂度**。当前桥只构造窗口，要支持完整历史需要：
1. Island 调用点传递完整 timeline（不是 promptHistory）
2. 桥构造完整虚拟 chat[]（不是窗口拼接）
3. Provider 持久化（不是生成窗口内临时替换）

## 下一步行动

### 立即可做（低风险）

1. **评估 `hydrateArchiveMessages()` 的性能**：
   - 1000 层存档的完整读取耗时
   - 是否需要分页或懒加载（与第二阶段冲突）

2. **设计稳定 ID 生成策略**：
   - `logicalId` = `${floorIndex}-${role}`？还是 UUID？
   - `exchangeId` = `floor-${floorIndex}`？
   - root 的 `logicalId` 固定为 `"root-assistant"`

3. **草拟 `archive-repository.ts` 的批量更新 API**：
   ```typescript
   export function batchUpdateArchiveMessages(input: {
     saveId: string;
     mutations: Array<{
       logicalId: string;
       kind: 'update' | 'create' | 'delete';
       message?: PersistedMessage;
     }>;
   }): Promise<ArchiveCommitReceipt>;
   ```

### 需要人工决策

1. **是否允许开始第二阶段？**
   - 第二阶段会修改桥的核心逻辑（`buildVirtualChat`）
   - 需要传递完整 timeline，可能影响性能
   - 必须在真实 SillyTavern 中验证 ACU 计数

2. **删除操作的处理策略**：
   - 方案 A：tombstone（标记删除，保留 logicalId）
   - 方案 B：真实删除 + exchangeId 复用检测
   - 方案 C：禁止删除（只允许 rollback）

3. **Provider 恢复的作用域**：
   - 只恢复 `chat[]`？还是包括 `getContext()`？
   - 是否需要拦截 `eventOn('MESSAGE_SENT')`？

## 人工审查门

按 META v2.0 和 humanpending.md 规则，本轮**只读诊断 + 协议层改造**，未修改桥的核心生成逻辑，未接入真实 ACU 计数验证。

**下一轮授权前必须人工确认**：
- [ ] 接受"完整历史传递"的性能权衡（1000 层时可能慢）
- [ ] 接受"桥核心改造"的风险（虚拟 chat[] 构造逻辑变更）
- [ ] 明确删除操作策略（tombstone / 真删除 / 禁止）
- [ ] 批准真实 SillyTavern 验证（需导入最新桥并执行生成）

没有人工审查表，不开下一轮。

---

**文档版本**：v0.1（第一阶段完成，剩余蓝图）  
**工作树状态**：协议层改造已完成，核心逻辑待实现  
**预估总工作量**：~800 行 + 大量测试 + 真实验证
