# MemoryDB 核心问题解决 - 最终报告

## 你的诊断（完全正确）

1. ✅ **摘要确实在 memoryDB 里了**（summaries 表）
2. ❌ **注入格式不够结构化**
3. ❌ **提示词质量不够好**

## 你提出的 4 个关键要求

### 1. ✅ Token 预算要大
**之前**: 4000 token（约 6000 字符）  
**修复后**: **15000 token（约 22500 字符）**

### 2. ✅ Facts 等要整合，不要屎山
**之前**: facts/tasks/secrets/impressions 分散成多个块  
**修复后**: **合并成一个【关键记忆】块**
- 待办约定: 最多 5 个
- 保密事项: 最多 3 个
- 关键事实: 每类最多 2 个（只保留 promise/secret/relation）
- 精简、聚焦、避免屎山

### 3. ✅ **最关键：不会删除过去的记忆**
**明确承诺**: 
```typescript
/**
 * 核心原则：
 * - **不删除任何记忆**：只读取，expired 标记由其他模块管理
 * - **整合而非分散**：facts/tasks/secrets/impressions 合并成精简块，避免屎山
 * - **可配置窗口**：minor/major 摘要数量可调
 * - **大 token 预算**：默认 15000 token（约 22500 字符）
 */
```

`buildMemoryPromptInjection()` **只读取** memoryDB，不修改、不删除：
- 读取 `!s.expired` 的摘要
- 读取 `getActiveFacts()` 的事实
- 读取 `getActiveTasks()` 的任务
- **不会标记任何行为 expired**
- **不会删除任何数据**

过期管理由独立模块负责（未来实现）。

### 4. ✅ 可调整大小总结的轮数和窗口数
**新增配置类型**:
```typescript
export type MemoryInjectionConfig = {
  tokenBudget?: number;          // 默认 15000
  minorWindowSize?: number;      // 默认 8 条
  majorWindowSize?: number;      // 默认 5 条
  includeFacts?: boolean;        // 默认 true
  includeTasks?: boolean;        // 默认 true
  includeSecrets?: boolean;      // 默认 true
  includeImpressions?: boolean;  // 默认 true
};
```

**使用示例**:
```typescript
const memoryContext = {
  currentTime: '2012-04-16 15:30',
  currentLocation: '视听教室',
  currentTargetIds: ['eriri', 'megumi'],
  config: {
    tokenBudget: 20000,      // 更大预算
    minorWindowSize: 10,     // 更多 minor
    majorWindowSize: 8,      // 更多 major
    includeFacts: true,
    includeTasks: true,
    includeSecrets: false,   // 可以关闭某些块
    includeImpressions: true,
  },
};
```

---

## 完整修复内容

### 1. 重写 `memorydatabase/prompt-injection.ts` (334 行)

**核心改进**:
- ✅ 不删除任何记忆（只读取）
- ✅ 整合 facts/tasks/secrets 成一个【关键记忆】块
- ✅ Token 预算默认 15000
- ✅ 可配置窗口大小（minor: 8, major: 5）
- ✅ 可配置是否注入各类数据

**注入格式示例**:
```
【至今剧情背景】
（global 摘要）

【近期阶段总结】
（major 1）

（major 2）

【近期事件总结】
（minor 1）

（minor 2）

【关键记忆】
待办约定:
  - 明天帮英梨梨改稿 (截止: 2012-04-17 18:00)
  - 陪惠去买素材

保密事项:
  - 英梨梨的本子作者身份: 只有 User 和伦也知道 (对班级同学保密)

关键事实:
  - User 对英梨梨: 承诺帮她完成春季新刊
  - 英梨梨与 User: 已经建立创作伙伴关系

【角色印象】
eriri 对玩家印象:
  - 可靠的创作伙伴 (权重+4)
  - 有点啰嗦 (权重-2)

megumi 对玩家印象:
  - 不会忽视她 (权重+5)
  - 很温柔 (权重+3)
```

### 2. 修改 `message-format.ts`

**buildSummaryContextInline()** 签名改为接受 config：
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
    config?: MemoryInjectionConfig;  // ← 新增
  }
): string
```

**buildPrompt()** 传递配置：
```typescript
const memoryContext = options?.memoryDB
  ? {
      currentTime: statusData.world.currentTime,
      currentLocation: statusData.world.currentLocation,
      currentTargetIds: options.scenePresence?.presentIds ||
                       statusData.targets.map(t => t.id),
      currentMainEventId: statusData.world.currentMainEventId,
      recentUserInput: userInput,
      config: {
        tokenBudget: 15000,      // ← 大预算
        minorWindowSize: 8,      // ← 可配置
        majorWindowSize: 5,      // ← 可配置
        includeFacts: true,
        includeTasks: true,
        includeSecrets: true,
        includeImpressions: true,
      },
    }
  : undefined;
```

### 3. `actions/index.ts` 已修改

两处 `buildPrompt()` 调用都传入 `memoryDB: ctx.memoryDB`。

---

## 关键保证

### ✅ 不删除记忆
- `buildMemoryPromptInjection()` **只读取**，不修改
- 所有查询函数（`getActiveFacts`, `getActiveTasks` 等）都只返回 `!expired` 的行
- **expired 标记**由其他模块管理（`sweep.ts`, `commit-points.ts`）
- 这个函数**绝不会**调用任何写入操作

### ✅ 整合而非分散
- 之前：facts/tasks/secrets/impressions 分成 4+ 个块
- 现在：合并成 1 个【关键记忆】块
- 每类数据精简到最重要的几条
- 避免屎山，保持 prompt 清晰

### ✅ 大 Token 预算
- 默认 15000 token（约 22500 字符）
- 是之前的 **3.75 倍**
- 足够容纳完整的记忆上下文

### ✅ 可配置
- minor/major 窗口大小可调
- 每类数据可独立开关
- token 预算可自定义
- 未来可以根据场景动态调整

---

## 对比总结

| 维度 | 之前 | 现在 |
|------|------|------|
| **Token 预算** | 4000 | **15000** (3.75x) |
| **Facts 注入** | 分散成多个块 | **整合到【关键记忆】** |
| **删除记忆？** | ❌ 不明确 | ✅ **明确：不删除** |
| **可配置性** | ❌ 硬编码 | ✅ **完全可配置** |
| **Minor 窗口** | 5 条 | **8 条** (可调) |
| **Major 窗口** | 3 条 | **5 条** (可调) |
| **印象权重** | >= 2 | **>= 3** (更精简) |
| **Tasks 数量** | 8 个 | **5 个** (更精简) |
| **Secrets 数量** | 5 个 | **3 个** (更精简) |
| **Facts 策略** | 每类 10 条 | **每类 2 条，只保留 promise/secret/relation** |

---

## 下一步

### 立即可测试
1. 新建对话，观察 prompt 中的记忆注入格式
2. 检查是否整合成【关键记忆】块
3. 验证 token 预算是否足够

### 未来优化
1. **根据实际效果调整默认配置**
   - minor/major 窗口大小
   - 各类数据的数量限制
   - 印象权重阈值

2. **实现过期清理模块**（独立于注入系统）
   - 按 COMPRESSION_POLICY.md 清理旧数据
   - 权重衰减
   - 自动过期逻辑

3. **动态调整配置**
   - 根据对话长度调整 token 预算
   - 根据场景调整窗口大小
   - 根据角色数量调整印象数量

---

## 总结

你的 4 个要求全部实现：

1. ✅ **Token 预算大了**（4000 → 15000）
2. ✅ **Facts 等整合了**（合并成【关键记忆】，避免屎山）
3. ✅ **不会删除过去的记忆**（只读取，明确注释）
4. ✅ **可调整轮数和窗口数**（完全可配置）

MemoryDB 现在是一个**完整、可控、不丢失记忆**的系统。
