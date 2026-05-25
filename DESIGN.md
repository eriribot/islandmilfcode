// 待办

## 2026-05-19 今日任务

### 已完成
- [x] 雷达图 p5 视觉增强（手绘感、粒子、呼吸动画）
- [x] `memorydatabase/types.ts`：全部表结构类型（含 attributes 扩展表）
- [x] `memorydatabase/defaults.ts` + `normalize.ts`：默认值工厂、反序列化兜底
- [x] `memorydatabase/upsert.ts`：commitBatch + 去重规则（事实/关系/秘密/属性/手机消息）
- [x] `memorydatabase/migrate.ts`：旧 SummaryStore → MemoryDB 迁移
- [x] `types.ts`：SavePayload 增加 `memoryDB?: IslandMemoryDB` 字段
- [x] `state/saves.ts`：load 时自动迁移、write 时带上 memoryDB


## 2026-05-20 今日任务

### 已完成
- [x] 英梨梨审计规则重做：5 条 Rule 全部写完，挂入 `getRelationshipAuditGuidance`
- [x] `memorydatabase/commit-points.ts`：commitProgressToMemoryDB（attributes+events+items）+ commitSummaryToMemoryDB
- [x] `memorydatabase/phone-repository.ts`：MutationQueue + indexPhoneMessage 串行写入
- [x] AppState 加 `memoryDB: IslandMemoryDB`，createInitialState 初始化，saves load/write 全链路
- [x] `actions/index.ts`：progress commit、手机消息（directive/proactive/scene-extract）全部接入 memoryDB
- [x] `summary/run.ts`：minor/major/global 成功后调用 commitSummaryToMemoryDB
- [x] `memorydatabase/editor.ts`：行级 CRUD（updateMemoryRow/expireMemoryRow/restoreMemoryRow/insertMemoryRow）+ 完整渲染
- [x] `phone/types.ts` 加 `app:memory` 路由；AppState 加 `memoryEditor` 状态
- [x] `phone/render.ts`：首页记忆库图标 + renderMemoryPhonePage 路由分发
- [x] `index.ts`：memory editor 全部事件绑定（表切换/展开/编辑/保存/删除/恢复/新增/textarea 同步）

### 待做
- [ ] memory editor CSS 样式（`.memory-editor` / `.memory-tab` / `.memory-row` 等）


---

## 手机发布节奏

- 先做一个可玩的阶段版，再分批补内容和重构。
- 第一批发出去的版本只保证核心流程完整，不追求一次做满。
- 后续更新按“补角色、补剧情、补结构”逐步推进。

## P0

- 手机最小可用链路：消息收发、会话列表、聊天页、联系人可见性。
- 美智留链路补完整：出场、审计规则、消息关联、联系人可见性。
- API RPM / 副 API 稳定性修正，先保证生成链路不塌。
- 英梨梨审计规则重做，避免写成单纯的暴娇模板。

## P1

- 伦也执念度变量补上，作为关系推进的底层变量。
- 波岛出海补完整，至少达到可稳定出场和推动剧情的程度。
- 第一季 / 第四卷剧情收尾后发布主版本，不竭泽而渔。
- 归档 / 总结先做可用版，保证能稳定回看和续写。

## P2

- 手机结构向数据库式记忆系统靠拢。
- 总结系统继续重构，减少“摘要堆叠感”。
- 町田苑子、红坂朱音做最小可用版本。
- 发糖、冲突、吐槽类场景做专项测试。

## P3

- 其他角色与支线补完。
- 细节抛光与文风微调。

---

## 角色卡与关系路由设计

### 核心目标

- 钱不是主要限制，AI 注意力才是主要限制。
- 多女主 AIRP 不能把所有完整 0 层角色卡常驻塞进 prompt，否则容易串味、抢戏、弱化当前场景焦点。
- 系统目标不是单纯复刻原著，而是让原著关系作为初始惯性，允许 User 通过关系推进成为角色成长和情感变化的主要因果来源。

### 分层原则

- 世界书保存长文本内容：完整角色 0 层卡、原著底盘、剧情事件、场景资料。
- TS 状态层负责判断：当前事件、地点、在场人物、activeTarget、最近对话焦点、手机路由等。
- EJS 世界书控制器负责拼接：根据 TS 写入的变量加载对应角色条目。
- `relationship.ts` 只输出短动态叠层：关系阶段、称呼规则、当前目标审计、User 影响提示。

一句话：代码做裁判，世界书说话。

### 推荐架构

```text
plotLibrary / currentMainEventId / activeTargetId / scenePresence / recent focus
        ↓
TS 计算 activeCardIds
        ↓
写入 stat_data.world.activeCardIds
        ↓
世界书 0层角色卡控制器
        ↓
getwi('霞之丘诗羽_0层卡') / getwi('英梨梨_0层卡') / getwi('加藤惠_0层卡')
        ↓
relationship.ts 追加短关系叠层
```

### 世界书角色条目

- 每个女主保留独立世界书条目，例如 `加藤惠_0层卡`、`霞之丘诗羽_0层卡`、`英梨梨_0层卡`。
- 完整角色条目后续应改成默认禁用，只由控制器 `getwi` 加载。
- 不建议依赖关键词自然触发完整角色卡，因为剧情条目、回忆、关系提示中提到名字时会误激活。
- 条目应开启不可递归 / 防止进一步递归，避免角色卡互相拉起。

### 0 层卡控制器

控制器常驻，读取统一变量，不在每个角色条目里散写判断。

示意：

```ejs
<%_
if (typeof cards === 'undefined') var cards = getvar('stat_data.world.activeCardIds', { defaults: [] });
cards = Array.isArray(cards) ? cards : [];
_%>
<%_ if (cards.includes('utaha')) { _%>
<%- await getwi('霞之丘诗羽_0层卡') %>
<%_ } _%>
<%_ if (cards.includes('eriri')) { _%>
<%- await getwi('英梨梨_0层卡') %>
<%_ } _%>
<%_ if (cards.includes('megumi')) { _%>
<%- await getwi('加藤惠_0层卡') %>
<%_ } _%>
```

### activeCardIds 判定建议

`activeCardIds` 应由 TS 集中计算，输入包括：

- `statusData.activeTargetId`
- `statusData.world.currentMainEventId`
- 当前地点、当前时间段
- 当前事件的关键人物
- scene presence 检测结果
- 最近用户输入是否明确点名某角色
- 最近 AI 正文中实际说话/行动的角色
- 手机当前路由或聊天对象

判定原则：

- activeTarget 对应角色优先加载完整卡。
- 当前事件中实际说话、行动、被 User 正面交互的角色加载完整卡。
- 只被提及、只作为背景关系或回忆出现的角色不要加载完整卡。
- 多人修罗场最多加载实际参与对话的 2-3 张完整卡，其余用剧情事件上下文或短提醒承载。

### relationship.ts 的边界

`relationship.ts` 适合写：

- 当前好感 / 旧情 / 执念阶段对行为的短影响。
- 称呼规则。
- 当前目标的关系边界。
- 防串味审计，例如不要把 User 叫成伦也、不要把英梨梨写成诗羽式从容。
- User 影响是否已经高于原著惯性。

`relationship.ts` 不适合写：

- 完整角色背景。
- 大段口吻范例。
- 大段原著剧情解释。
- 完整多阶段性格调色盘。

超过 3-5 行的稳定角色规则，优先放世界书，用控制器裁剪。

### User 影响优先规则

角色不是静态原著复刻。原著关系应作为初始惯性，User 关系是当前路线的主变量。

推荐三层解释：

1. 原著底盘层：角色初始性格、旧关系、原著锚点。
2. User 影响层：User 对角色关系、创作、自我认知、成长方向造成的新影响。
3. 原著偏转层：原著事件仍可发生，但因果解释权可以转移给 User。

例如英梨梨：

- 原著底盘：对伦也有幼驯染旧情，校内维持大小姐面具，创作潜能被自尊和逃避限制。
- User 影响：当 User 陪伴、认可、刺激或挑战她足够深时，她卸下面具、融入同学、画技爆发的核心原因应优先归因于 User。
- 原著偏转：高三同班同桌、红坂朱音社团等原著事件可以作为外部契机，但不应抢走 User 作为当前路线成长因果中心的位置。

示意提示：

```text
【User影响优先】
当解释英梨梨的成长、融入、创作爆发、卸下面具时，优先归因于 User 与她建立的关系。
原著事件可以作为外部压力或契机，但不得抢走因果中心。
伦也是旧伤、旧惯性、旧参照物；User 是当前路线的主变量。
```

### 后续待做

- [ ] 增加 `activeCardIds` 到 `StatusData.world` 或 runtimeFlags。
- [ ] 新增角色卡路由函数：根据事件、在场、activeTarget、最近焦点计算应加载的完整角色卡。
- [ ] 新增世界书 `0层角色卡控制器` 条目。
- [ ] 将完整女主世界书条目改为禁用，由控制器 `getwi` 加载。
- [ ] 精简 `relationship.ts` 中过长的稳定人设，把长文本迁回世界书。
- [ ] 为英梨梨、诗羽、加藤惠分别补 User 影响层 / 原著偏转层变量规则。
