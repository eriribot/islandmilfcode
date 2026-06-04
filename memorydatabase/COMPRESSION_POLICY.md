# Memory Compression Policy

## Overview

本项目的 `IslandMemoryDB` 采用 **三层压缩策略**，将原始对话逐步压缩为长期记忆，平衡上下文完整性与 token 消耗。

## 三层策略架构

```
原始对话 (每轮)
    ↓
Minor Summaries (即时 → 短期)
    ↓
Major Summaries (短期 → 长期)
    ↓
Global Summaries (长期 → 超压缩)
```

---

## 1. Minor Summaries（即时 → 短期）

### 触发条件
- **频率**：每 5-10 条消息
- **时机**：用户连续对话、完成小场景、切换话题时

### 覆盖范围
- 最近对话上下文
- 单个场景或短时间段（如一次约会、一场对话）

### 保留期限
- **保留**：50 条消息内
- **过期**：50 条消息后压缩到 Major Summary

### 内容类型
- 对话细节（谁说了什么）
- 情绪起伏（高兴、生气、害羞）
- 小决策（接受邀请、拒绝请求）
- 环境描述（地点、时间、氛围）

### 实现位置
- `summary/run.ts`: `runSummary()` 函数，level: 'minor'
- `memorydatabase/commit-points.ts`: `commitSummaryToMemoryDB()`

---

## 2. Major Summaries（短期 → 长期）

### 触发条件
- **频率**：每 50 条消息
- **时机**：卷章节结束、重大剧情节点完成、关系阶段变化时

### 覆盖范围
- 弧级叙事（如一个约会弧、一个社团活动弧）
- 单卷或跨章节内容

### 保留期限
- **永久保留**：不过期，长期存档

### 内容类型
- 剧情转折（告白成功、关系破裂、加入社团）
- 关系里程碑（好感度突破阈值、执念度变化、称呼改变）
- 不可逆后果（秘密暴露、承诺兑现、物品丢失）
- 角色成长（性格变化、技能习得、心理突破）

### 实现位置
- `summary/run.ts`: `runSummary()` 函数，level: 'major'
- `memorydatabase/upsert.ts`: 去重逻辑，防止重复记录

---

## 3. Global Summaries（长期 → 超压缩）

### 触发条件
- **频率**：卷转换（第一卷 → 第二卷）或 200+ 条消息
- **时机**：开始新篇章、时间跳跃、长期回顾时

### 覆盖范围
- 多卷上下文
- 全局关系图谱
- 长期世界状态变化

### 保留期限
- **永久保留**：不过期，作为超长对话的基础锚点

### 内容类型
- 角色弧完整总结（从陌生到恋人的全程）
- 重大事件链（如「第一卷：社团成立 → 第二卷：游戏发布 → 第三卷：红坂朱音登场」）
- 世界状态快照（当前主线进度、所有角色关系状态）
- 长期目标与约定（如「完成游戏开发」、「守护英梨梨的梦想」）

### 实现位置
- `summary/run.ts`: `runSummary()` 函数，level: 'global'
- `memorydatabase/types.ts`: `MemorySummaryRow` 的 `coveredSummaryIds` 字段

---

## 表级压缩规则

### Facts Table（事实表）
- **策略**：永不过期，合并重复
- **去重规则**：相同 `category + subject + content` 视为重复，只更新 `lastSeenAt`
- **理由**：事实是稳定的，重复出现说明重要性高，不是噪音

### Events Table（事件表）
- **策略**：小事件 100 条消息后过期，剧情关键事件永久保留
- **判定标准**：
  - `relatedMainEventId` 非空 → 永久保留
  - `importance >= 4` → 永久保留
  - 其他 → 100 条消息后 `expired = true`
- **理由**：日常小事可以遗忘，剧情转折必须记住

### Relations Table（关系表）
- **策略**：用 `exclusiveGroup` 覆盖，变化轨迹存入 Attributes
- **去重规则**：同 `fromId + toId + exclusiveGroup` 的新行会让旧行 `expired = true`
- **历史追踪**：关系数值变化（好感度、执念度）写入 `attributes` 表的 `delta` 字段
- **理由**：只需当前关系状态，但变化轨迹用于回溯

### Impressions Table（印象表）
- **策略**：权重衰减，低于阈值时过期
- **衰减规则**：
  - 每 50 条消息，所有印象的 `weight` 乘以 0.9
  - `weight < 0.5` 时标记 `expired = true`
- **理由**：临时印象会淡化，持续强化的印象会留存

### Tasks Table（任务表）
- **策略**：截止日期过期时自动标记
- **自动过期**：
  - `status != 'done'` 且 `deadline < world.currentTime` → `status = 'expired'`
- **手动归档**：用户可手动设置 `status = 'archived'` 清理旧任务
- **理由**：约定过期不再有效，避免提示噪音

### Secrets Table（秘密表）
- **策略**：永不自动过期，只能手动标记 `revealed = true`
- **理由**：秘密暴露是剧情转折，必须显式处理

### Items Table（物品表）
- **策略**：与 `StatusData.player.inventory` 同步，丢失物品标记 `action = 'lost'`
- **历史保留**：即使物品不在库存中，历史记录仍保留（如「曾拥有但丢失的礼物」）
- **理由**：物品流转有叙事意义

### PhoneMessages Table（手机消息索引）
- **策略**：只记录索引元数据，正文仍在 `PhoneMessageStore`
- **不过期**：所有手机消息永久保留索引
- **理由**：手机是独立通信系统，历史消息可能被回看

### Attributes Table（属性变化表）
- **策略**：保留所有变化记录，不过期
- **用途**：回溯分析（「好感度何时突破 70？」、「执念度峰值是多少？」）
- **理由**：变化轨迹是关系曲线的数据基础

### WorldState Table（世界状态表）
- **策略**：单例表，只保留最新一条活跃行
- **更新规则**：浅合并 patch，旧行标记 `expired = true`
- **理由**：世界状态是当前快照，不需要历史版本

---

## 提交点（Commit Points）

所有数据写入都通过 **commit 点** 统一提交，保证一致性。

### 主要 Commit 点

1. **progress-commit**（主回复后）
   - 触发文件：`actions/index.ts` → `submitMessage()` 后
   - 提交内容：`attributes`（好感度等变化）、`events`（剧情事件）、`items`（库存变化）
   - 实现：`memorydatabase/commit-points.ts`: `commitProgressToMemoryDB()`

2. **summary-minor/major/global**（摘要生成后）
   - 触发文件：`summary/run.ts` → `runSummary()` 成功后
   - 提交内容：`summaries`（压缩摘要行）、相关 `facts`/`events`/`relations`
   - 实现：`memorydatabase/commit-points.ts`: `commitSummaryToMemoryDB()`

3. **phone-directive**（手机指令分析后）
   - 触发文件：`actions/index.ts` → 手机消息生成后
   - 提交内容：`phoneMessages`（索引元数据）
   - 实现：`memorydatabase/phone-repository.ts`: `indexPhoneMessage()`

4. **phone-scene-extract**（场景提取后）
   - 触发文件：`actions/index.ts` → 场景分析完成后
   - 提交内容：`events`（场景事件）、`facts`（场景事实）
   - 实现：`memorydatabase/commit-points.ts`: 专用提交函数

5. **manual**（手动编辑）
   - 触发文件：`index.ts` → 记忆编辑器保存按钮
   - 提交内容：用户手动创建/修改的行
   - 实现：`memorydatabase/editor.ts`: `insertMemoryRow()`/`updateMemoryRow()`

---

## 检索策略

### 按相关性检索

使用 `MemoryScoringContext` 计算相关性分数：

```typescript
type MemoryScoringContext = {
  currentTime?: string;           // 当前游戏时间
  currentLocation?: string;        // 当前地点
  currentTargetIds?: string[];     // 当前在场角色
  currentMainEventId?: string;     // 当前主线事件
  keywords?: string[];             // 用户输入关键词
};
```

**评分逻辑**：
- 时间匹配：越接近当前时间，分数越高
- 地点匹配：相同地点 +10 分
- 角色匹配：涉及当前角色 +5 分
- 事件匹配：关联当前主线事件 +15 分
- 关键词匹配：命中关键词 +8 分/词
- 重要度加权：`importance` 字段直接加到分数上
- 置信度过滤：`confidence = 'low'` 的行默认 -5 分惩罚

### 按时间检索

- `createdAfter` / `createdBefore`：按创建时间范围过滤
- `sourceRangeOverlaps`：查找特定消息索引范围的记忆

### 按来源检索

- `source = 'summary-major'`：只查大摘要
- `source = 'progress-commit'`：只查主回复提交的数据

---

## 最佳实践

### 1. 渐进式压缩

不要一次性压缩大量对话，而是：
- 每 5-10 条消息生成 Minor
- 每 50 条消息生成 Major
- 卷结束时生成 Global

### 2. 去重优于堆叠

相同事实重复出现时，更新 `lastSeenAt` 而不是创建新行。

### 3. 软删除优于硬删除

使用 `expired = true` 标记过期，保留历史记录用于回溯。

### 4. 置信度分级

AI 输出的数据标记 `confidence`：
- `'certain'`：用户显式确认的事实
- `'high'`：AI 高置信度推断
- `'medium'`：AI 中等置信度推断
- `'low'`：AI 低置信度推断或占位符

低置信度行可以被高置信度行覆盖。

### 5. 独立表互不干扰

不要在 `facts` 表里存事件，不要在 `events` 表里存关系。
每张表有明确职责，检索时按需组合。

---

## 未来扩展

### 1. 智能压缩触发

根据对话密度动态调整压缩频率：
- 高密度对话（10 分钟 30 条消息）→ 更频繁压缩
- 低密度对话（1 小时 5 条消息）→ 延迟压缩

### 2. 语义检索

接入向量数据库（如 Pinecone、Qdrant）：
- 将摘要文本转为 embeddings
- 用户输入转为 embeddings
- 余弦相似度排序检索

### 3. 自动重要度评分

让 AI 在生成摘要时同步输出 `importance` 分数：
- 剧情转折 → 5 分
- 日常对话 → 1-2 分
- 关键承诺 → 4 分

### 4. 跨存档记忆共享

不同存档共享「角色底盘」记忆（如角色性格、原著设定），
但分离「关系进度」记忆（如好感度、执念度）。

---

## 相关文件

- `memorydatabase/types.ts`：所有表结构定义
- `memorydatabase/upsert.ts`：批量写入与去重逻辑
- `memorydatabase/commit-points.ts`：各 commit 点实现
- `memorydatabase/query.ts`：检索函数
- `memorydatabase/sweep.ts`：自动过期清理
- `summary/run.ts`：三层摘要生成入口
- `SCHEMA_CONTRACT.md`：schema 版本兼容性契约
