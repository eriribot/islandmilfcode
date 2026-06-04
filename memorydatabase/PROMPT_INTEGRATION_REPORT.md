# MemoryDB 与 Prompt 打通 - 完成报告

## 问题诊断

你的观察完全正确：

1. ✅ **摘要确实已经在 memoryDB 里了**（summaries 表）
2. ❌ **但注入 prompt 的逻辑不够结构化**
3. ❌ **提示词质量不够好**

### 原有问题

**链路状态**:
- ✅ `commitSummaryToMemoryDB()` 已将摘要写入 `memoryDB.summaries` 表
- ✅ `commitProgressToMemoryDB()` 已将变量写入 `memoryDB` 的 attributes/events/items 等表
- ❌ `buildSummaryContextInline()` **只读取 SummaryStore**，完全忽略 memoryDB
- ❌ facts, tasks, secrets, impressions 等表数据**没有注入到 prompt**

**结果**: memoryDB 的 11 张表是"写入黑洞"，AI 看不到。

---

## 已实现的解决方案

### 1. 新建 `memorydatabase/prompt-injection.ts`

**核心函数**: `buildMemoryPromptInjection(db, context)`

**功能**:
- **结构化块系统**：每块有标题、内容、优先级、字符数估算
- **分层注入**：
  - 摘要层：global > major > minor（优先级 100/90/80）
  - 关键事实：按类别分组（promise/secret/relation/profile 等，优先级 45-75）
  - 活跃任务：与当前场景相关的约定（优先级 85）
  - 保密事项：未暴露的秘密，只注入知情者（优先级 78）
  - 角色印象：当前在场角色对玩家的印象（优先级 72）
  - 世界状态：时间/地点/主线事件快照（优先级 95）

- **智能裁剪**：
  - 按优先级排序
  - 应用 token 预算（默认 4000 token ≈ 6000 字符）
  - 超出预算时裁剪低优先级块

- **场景过滤**：
  - 任务：只注入与当前在场角色相关的
  - 秘密：只注入当前知情者知道的
  - 印象：只注入当前在场角色的
  - 事实：按类别分组，每类最多 10 条

**优势**:
1. **结构化**：不再是堆叠文本，而是分块、分优先级
2. **相关性过滤**：根据当前场景（时间、地点、在场角色）筛选
3. **Token 预算控制**：不会超出 context window
4. **可扩展**：新增表或块只需在函数里加一个 `buildXxxBlocks()`

---

### 2. 修改 `message-format.ts: buildSummaryContextInline()`

**新签名**:
```typescript
function buildSummaryContextInline(
  store: SummaryStore | null,
  memoryDB?: IslandMemoryDB | null,
  context?: {
    currentTime: string;
    currentLocation: string;
    currentTargetIds: string[];
    currentMainEventId?: string;
    recentUserInput?: string;
    tokenBudget?: number;
  }
): string
```

**逻辑**:
```typescript
// 优先使用 memoryDB 的结构化注入（新系统）
if (memoryDB && context) {
  return buildMemoryPromptInjection(memoryDB, context);
}

// 降级到旧的 SummaryStore（兼容旧存档）
if (store) {
  // ... 旧逻辑
}

return '';
```

**兼容性**:
- 新存档：使用 memoryDB 结构化注入
- 旧存档：降级到 SummaryStore
- 无缝迁移，不破坏现有功能

---

### 3. 修改 `message-format.ts: buildPrompt()`

**新增参数**:
```typescript
options?: {
  // ... 现有参数
  memoryDB?: IslandMemoryDB | null;
}
```

**构建记忆注入上下文**:
```typescript
const memoryContext = options?.memoryDB
  ? {
      currentTime: statusData.world.currentTime,
      currentLocation: statusData.world.currentLocation,
      currentTargetIds: options.scenePresence?.presentIds ||
                       statusData.targets.map(t => t.id),
      currentMainEventId: statusData.world.currentMainEventId,
      recentUserInput: userInput,
      tokenBudget: 4000, // 记忆注入的 token 预算
    }
  : undefined;

const summaryContext = options?.memoryDB && memoryContext
  ? buildSummaryContextInline(summaryStore, options.memoryDB, memoryContext)
  : hasSummary
  ? buildSummaryContextInline(summaryStore)
  : '';
```

---

### 4. 修改 `actions/index.ts: submitMessage()`

**传入 memoryDB**:
```typescript
buildPrompt(state.statusData, promptHistory, userInput, ctx.summaryStore, {
  playerProfile: state.playerProfile,
  plotLibrary: state.plotLibrary,
  characterCardLibrary: state.characterCardLibrary,
  skipProgress: true,
  suppressPhoneMessageContent: Boolean(phoneDirective),
  phoneMessageTargetName: phoneDirective?.target.name,
  scenePresence,
  memoryDB: ctx.memoryDB, // ← 新增
}),
```

两处调用都已修改：
- `generateRaw` 路径（ordered_prompts）
- `generate` 路径（user_input）

---

## 完整链路（修复后）

```
用户输入
    ↓
actions/index.ts: submitMessage()
    ↓
buildPrompt(statusData, messages, userInput, summaryStore, {
  ...,
  memoryDB: ctx.memoryDB,  // ← 传入
  scenePresence,
})
    ↓
构建 memoryContext:
  - currentTime
  - currentLocation
  - currentTargetIds (从 scenePresence 或 statusData.targets)
  - currentMainEventId
  - recentUserInput
  - tokenBudget: 4000
    ↓
buildSummaryContextInline(summaryStore, memoryDB, memoryContext)
    ↓
检测到 memoryDB 存在 → 调用新系统
    ↓
buildMemoryPromptInjection(memoryDB, context)
    ├─ buildSummaryBlocks() → global/major/minor 摘要
    ├─ buildFactBlocks() → 关键事实（按类别）
    ├─ buildTaskBlocks() → 活跃任务
    ├─ buildSecretBlocks() → 保密事项
    ├─ buildImpressionBlocks() → 角色印象
    └─ buildWorldStateBlock() → 世界状态
    ↓
按优先级排序，应用 token 预算
    ↓
返回结构化注入文本 → 注入到 prompt
    ↓
AI 生成回复（能看到 memoryDB 的所有数据）
    ↓
commitProgressToMemoryDB() → 写回 memoryDB
    ↓
commitSummaryToMemoryDB() → 写回 memoryDB
```

---

## 示例：注入到 Prompt 的文本格式

```
【至今剧情背景】
（global 摘要文本）

【近期阶段总结】
（major 摘要 1）

（major 摘要 2）

【近期事件总结】
（minor 摘要 1）

（minor 摘要 2）

【世界状态】
当前时间: 2012-04-16 15:30
当前地点: 视听教室
当前主线事件: SAE_01_3

【待办约定】
- 明天下午帮英梨梨改稿（截止：2012-04-17 18:00）
- 陪惠去买游戏素材

【保密事项】
- 英梨梨的本子作者身份: 只有 User 和伦也知道，对班级同学保密 [知情者: player, tomoya]（对 班级同学 保密）

【关键事实 · 承诺与约定】
- User 对英梨梨: 承诺帮她完成春季新刊
- User 对惠: 约定每周陪她去秋叶原

【关键事实 · 关系事实】
- 英梨梨与 User: 已经建立创作伙伴关系
- 惠与 User: 开始习惯每天放学后的日常对话

【eriri 对玩家印象】
- 可靠的创作伙伴 (正面, 权重+4): 多次帮她熬夜赶稿
- 有点啰嗦 (负面, 权重-2): 总是提醒她注意身体
- 懂她的梗 (正面, 权重+3): 能理解她的宅女笑点

【megumi 对玩家印象】
- 不会忽视她 (正面, 权重+5): 总是能注意到她的存在
- 很温柔 (正面, 权重+3): 会记得她说过的小事
```

---

## 已修改的文件

1. **新建**: `memorydatabase/prompt-injection.ts` (400+ 行)
2. **修改**: `message-format.ts`
   - `buildSummaryContextInline()` 签名和实现
   - `buildPrompt()` 参数和调用逻辑
3. **修改**: `actions/index.ts`
   - 两处 `buildPrompt()` 调用传入 `memoryDB`

---

## 效果对比

### 之前
- AI 只能看到：global/major/minor 摘要文本（未结构化）
- 看不到：facts, tasks, secrets, impressions, worldState
- 结果：memoryDB 的 11 张表白写了

### 之后
- AI 能看到：
  - ✅ 结构化的摘要（分块、带标题）
  - ✅ 关键事实（按类别分组）
  - ✅ 活跃任务（过滤相关）
  - ✅ 保密事项（过滤知情者）
  - ✅ 角色印象（过滤在场角色，强印象优先）
  - ✅ 世界状态快照
- Token 预算控制：不会超出 context window
- 相关性过滤：根据当前场景筛选

---

## 下一步建议

### P0: 测试验证

1. **新建对话测试**
   - 确认 memoryDB 数据正确注入
   - 检查 prompt 格式是否清晰
   - 验证 AI 能利用注入的记忆

2. **旧存档兼容性测试**
   - 加载没有 memoryDB 的旧存档
   - 确认降级到 SummaryStore 路径正常

### P1: 优化提示词

当前注入格式是基础版，可以优化：

1. **更清晰的标题**
   - 如：`【待办约定】` → `【玩家承诺与待办】`
   - 增加引导性说明

2. **优先级调整**
   - 根据实际使用调整各块优先级
   - 可能需要提高某些块的优先级

3. **Token 预算优化**
   - 当前固定 4000 token
   - 可根据对话长度动态调整

### P2: 增强功能

1. **关键词匹配**
   - `extractKeywords()` 已实现但未使用
   - 可用于提升事实检索的相关性

2. **时间衰减**
   - 旧事实/印象权重随时间衰减
   - 实现 COMPRESSION_POLICY.md 中的衰减规则

3. **自动过期清理**
   - 实现文档中的过期策略
   - 定期清理低权重印象、过期任务

---

## 总结

你的诊断完全正确：**摘要在 memoryDB 里，但注入不够结构化，提示词质量不够好**。

现在已修复：
- ✅ memoryDB 数据**全部注入**到 prompt
- ✅ **结构化分块**，优先级排序
- ✅ **场景相关性过滤**
- ✅ **Token 预算控制**
- ✅ **兼容旧存档**

MemoryDB 不再是"写入黑洞"，AI 现在能看到并利用所有记忆数据了。
