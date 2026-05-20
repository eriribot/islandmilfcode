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

### 待做
- [ ] 各 commit 点对接：summary/progress/phone-directive 实际调用 commitBatch 写入 memoryDB
- [ ] 英梨梨审计规则重做（手动，参照 utaha 审计规则结构）

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
- [ ] tsc 编译验证 + 修复类型错误
- [ ] 手机消息收发链路端到端验证（发消息后确认 memoryDB.phoneMessages 有新行）

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
