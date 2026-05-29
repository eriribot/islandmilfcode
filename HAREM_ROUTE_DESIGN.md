# 后宫线数值系统设计草案

> 状态：仅讨论留档，不计入当前实现工作项。本文档不约束代码改动；任何实施前需要重新评估。

## 背景

类脑社区有反馈希望存在后宫线（LGBT 进步内容）。本文档讨论一种合理的数值与触发设计，目标：

- 投其所好，不阻断这条线
- 不让叙事失重（不能让 AI 自动判定"现在该后宫了"）
- 不引入 O(N²) 关系矩阵带来的工程复杂度

## 参考来源

借鉴 *Love & Sex: Second Base*（Andrealphus Games）的核心机制：用**单边属性 + 事件痕迹**替代真矩阵，把多人关系复杂度从 O(N²) 降到 O(N)。

## 核心结论：用属性轴扩展，不用关系矩阵

每位女主在 `attributes` 表上扩展三条属性轴（在现有 `affinity / obsession` 基础上）：

| key | 范围 | 语义 | 写入场景 |
|---|---|---|---|
| `affinity` | 0-100 | 对 User 的好感（已有，攻略主轴） | 现有 progress 流 |
| `obsession` | 0-100 | 对伦也旧线的执念（已有，五人专属） | 现有 progress 流 |
| `lust` | 0-100 | 对 User 的性张力 | 暧昧推进、身体距离演出 |
| `submission` | 0-100 | 服从度 | 接受 User 引导/越界请求的下限 |
| `yuri` | 0-100 | 对女性的开放度 | 跨人剧情（百合 / 多人）的入场资格 |

**关键设计原则**：

1. 五条轴**互相正交**。affinity 高不等于 submission 高（傲娇）；lust 高不等于 affinity 高（炮友状态）；yuri 与对 User 的关系完全独立。
2. 单边属性，**不维护"A 对 B 的关系"**。
3. **嫉妒走事件痕迹**（events 表行），不维护持续状态。

## 五人组的原作锚点差异

利用原作设定让初始值/上限天然有差异（这是项目独有的叙事优势）：

| 女主 | yuri 倾向 | submission 倾向 | 叙事根据 |
|---|---|---|---|
| 加藤惠 | 中 / 高 | 中 / 高 | 原作"接受度最高"的主线女主 |
| 英梨梨 | 低 / 中 | 低 / 中 | 傲娇 + 旧情纠葛，最难推 |
| 霞之丘诗羽 | 中 / 高 | 低 / 中 | 独立毒舌但思想开放 |
| 波岛出海 | 中 / 中 | 高 / 高 | 崇拜型学妹，submission 天花板高 |
| 美智留 | 高 / 高 | 中 / 高 | 开放型大姐姐 |

这样后宫线最难突破的是英梨梨（低 yuri 上限 + 旧情牵绊），剧情张力天然存在——后宫成立的核心转折是"英梨梨被攻破"。

## 多人剧情触发条件

### 双人 / 3P

```
两人 lust ≥ 60
且 (两人 yuri ≥ 50 或 两人 submission ≥ 70)
且 两人对 User 的 affinity ≥ 60
且 worldState.currentLocation 允许（私密场景）
且 事件由专门的剧情卡触发，不由状态机自动转移
```

### 后宫线（5 人）

**硬触发条件**：

- 所有 5 人 `submission ≥ 75`
- 所有 5 人 `yuri ≥ 50`（互相能接受）
- 所有 5 人 `affinity ≥ 70`
- `obsession` 不再约束（伦也线的牵绊在叙事里被解决，不再阻塞）
- User 主动触发"后宫摊牌事件"（专门的事件卡，非自动）

**成立后**：

- 写入 `worldState.haremEstablished = true`
- 所有 buildPrompt 路径检查这个 flag，启用后宫向叙事约束（"分享日常"而非"撞见炸毛"）
- `relationship.ts` 增加后宫向 audit guidance（关系不再排他）

## 嫉妒：用事件痕迹替代矩阵

**反模式**：维护 `jealousy.eriri.megumi: 47` 这种 N×N 字段。

**推荐做法**：

- 撞见事件触发时，直接写一条 `events` 表行：
  ```ts
  upsertEvent(db, {
    title: '英梨梨撞见 User 和加藤',
    description: '...',
    outcome: '嫉妒',
    involvedTargetIds: ['eriri', 'megumi'],
  });
  ```
- 同时给"被嫉妒方"的发起者扣 `affinity`（一次性、衰减式）
- 不维护持续的嫉妒值

**判定关系恶化**：

- AI 在 prompt 里能看到"5 轮内英梨梨已撞见 User 和加藤 3 次"
- AI 自然产生反应（连续撞见会失态）
- 比看到 `jealousy.eriri.megumi: 47` 更有"人味"

## 不要做的事

1. **不要让 AI 自动判定"现在该进后宫线"**。这是用户主动选择的剧情节点，必须由专门的事件卡（如 `SAE_HAREM_ROUTE`）显式触发。
2. **不要建 N×N 关系矩阵**。任何"A 对 B 的态度"都用事件痕迹表达，不存为状态。
3. **不要把 `harem-tolerance` 单独建轴**。这个值可以从 `submission ≥ 75 + yuri ≥ 50 + affinity ≥ 70` 推导，没必要单独维护。
4. **不要在 obsession ≥ X 时阻塞后宫线**。obsession 的归零应当通过叙事节点（伦也线被解决的剧情卡）实现，不是数值门槛。

## 实现路径（如果未来落地）

1. **schema 扩展**：`memorydatabase/types.ts` 不需要改 schema，attributes 表本身已经支持任意 key
2. **prompt 字段**：`message-format.ts` 的 `buildProgressInstruction` 需要加 `lust.角色名:±N` / `submission.角色名:±N` / `yuri.角色名:±N` 三组字段
3. **解析端**：`parseProgressUpdate` 加这三组的正则解析（参考现有 `obsessionDeltas` 的实现）
4. **commit 端**：`commit-points.ts` 的 `commitProgressToMemoryDB` 加三组 upsertAttribute 调用
5. **白名单**：lust / submission 五人都有；yuri 也是五人专属（与 obsession 同白名单）
6. **新事件卡**：单独写一个 `剧情后宫线.json`（或第N卷专属节点），触发时检查上述硬条件
7. **prompt 注入**：`buildTargetStateList` 在五人状态行加这三个数值显示
8. **buildPrompt 调度**：检测 `worldState.haremEstablished`，true 时切换到后宫向 audit guidance

每一步都是局部改动，可分批落地，不需要一次性大动手术。

## 平行多线 vs 真后宫的关系

**平行多线**（默认）：
- 多个女主独立 affinity 高，user 没锁定
- 现有系统天然支持
- 是默认结局

**真后宫线**（特殊）：
- 五人互相知情且接受
- 需要本文档描述的扩展轴 + 摊牌事件
- 是一条需要主动追求的高门槛线

两者并存，不冲突。后宫不是默认，但"念想"被照顾到了。

## 给玩家的可见性

- `lust / submission / yuri` 在记忆库面板的属性表里可见（attributes 表行已经支持展示）
- 玩家心里有数：知道"我现在差英梨梨的 yuri 还差 30 才能拉她进后宫线"
- 保持玩家主动权：不强推、不剥夺、不藏

## 参考资料

- *Love & Sex: Second Base* by Andrealphus Games：核心借鉴对象
- 项目内 `memorydatabase/SCHEMA_CONTRACT.md`：attributes 表写入规范
- 项目内 `relationship.ts`：obsession 白名单实现参考
