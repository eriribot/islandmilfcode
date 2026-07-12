# V07 游戏开发双回合初版任务列表 v0.1

> 记录日期：2026-07-12（Asia/Shanghai）  
> 状态：**仅完成任务设计，尚未开始实现。**  
> 当前接通状态：**只是本地状态演示。**  
> 人工决定：一周不再拆成六天；每周固定为“工作日回合 + 周末回合”。

## 1. 本文用途

本文是下一轮实现合同，只定义初版范围、拟定接口、函数伪代码、验证合同和文件边界。

本轮没有修改 TypeScript、测试、webpack 或最终打包产物。下一轮开始前，应先以本文替换旧文档中的“六天计划 / 六个 slot”假设。

## 2. 初版目标

每周只有两个按顺序发生的正文回合：

```text
第 N 周
  -> 工作日回合：选择一项开发正事
  -> 主 AI 生成工作剧情
  -> 正文成功后，工作结算只应用一次
  -> 周末回合：独自休息或与角色约会
  -> 主 AI 生成周末剧情
  -> 正文成功后，周末结算只应用一次
  -> weeksLeft - 1
  -> 第 N+1 周
```

初版完成标准不是“页面能点”，而是以下闭环真实成立：

```text
选择行动
-> 冻结不可变 prepared turn
-> 生成只读 prompt context
-> 复用现有 submitMessage() 主正文链
-> 接受完整 assistant 正文
-> 幂等结算
-> 持久化并进入下一阶段
```

## 3. 根不变量

1. 每周严格先 `workday`，后 `weekend`；不能跳过、倒序或并行。
2. 工作日只允许开发行动；周末只允许 `rest_date`。
3. 点击行动只修改 draft，不修改项目数值。
4. 主 assistant 正文成功前不得应用 settlement。
5. 一个 `actionInstanceId` 最多结算一次。
6. 生成失败、刷新或重试必须复用相同 action、target、settlement、promptVersion 和 contextFingerprint。
7. 工作日成功后才解锁周末；周末成功后才进入下一周并扣除一周期限。
8. Reader 回退正文必须同时恢复对应项目状态和阶段。
9. AI 只能演出已选行动，不能改选行动、目标或重算数值。
10. 游戏开发业务不得继续堆进根 `index.ts`。

## 4. 初版行动域

```ts
type GameDevelopmentTurnPhase = 'workday' | 'weekend';

type GameDevelopmentWorkActionId =
  | 'art'
  | 'scenario'
  | 'music'
  | 'programming';

type GameDevelopmentWeekendActionId = 'rest_date';

type GameDevelopmentActionId =
  | GameDevelopmentWorkActionId
  | GameDevelopmentWeekendActionId;
```

目标选择合同：

- `art / scenario / music / programming`：目标可选；`null` 表示独自工作。
- `rest_date`：目标可选；`null` 表示独自休息，有角色 ID 表示与该角色约会。
- 目标必须来自当前路线和当前状态允许的角色 resolver。
- 改选行动后必须重新校验目标；不合法的旧目标直接清空，AI 不得自动补选。

旧的 `management / debug / promo / *_sprint / solo_prototype / rest` 不进入初版稳定命令域。路线差异应通过规则 profile、deltas 和 prompt guidance 表达，不能继续扩张 action ID。

## 5. 拟定状态接口

以下均为下一轮候选接口，不是已经落地的代码。

```ts
type GameDevelopmentTurnStatus =
  | 'draft'
  | 'prepared'
  | 'generating'
  | 'failed'
  | 'completed';

type GameDevelopmentTurnDraft = {
  phase: GameDevelopmentTurnPhase;
  actionId: GameDevelopmentActionId | null;
  selectedTargetId: string | null;
  intent: string;
  revision: number;
};

type GameDevelopmentProjectDeltas = Partial<{
  budget: number;
  progress: number;
  fun: number;
  creativity: number;
  writing: number;
  art: number;
  code: number;
  polish: number;
  hype: number;
  bugs: number;
  fatigue: number;
}>;

type GameDevelopmentSettlement = {
  deltas: GameDevelopmentProjectDeltas;
  nextProjectPhase: string;
  completesProject: boolean;
};

type GameDevelopmentProjectSnapshot = {
  project: GameDevelopmentProject;
  week: number;
  activePhase: GameDevelopmentTurnPhase;
};

type PreparedGameDevelopmentTurn = {
  actionInstanceId: string;
  routeConfirmationId: string;
  week: number;
  phase: GameDevelopmentTurnPhase;
  actionId: GameDevelopmentActionId;
  selectedTargetId: string | null;
  intent: string;
  draftRevision: number;
  preparedAt: string;
  preTurnSnapshot: GameDevelopmentProjectSnapshot;
  settlement: GameDevelopmentSettlement;
  promptVersion: string;
  contextFingerprint: string;
  context: string;
  status: Exclude<GameDevelopmentTurnStatus, 'draft'>;
  assistantMessageId: string | null;
  failureReason: string | null;
  completedAt: string | null;
};

type GameDevelopmentState = {
  schemaVersion: 3;
  routeConfirmationId: string;
  routeFamily: PlotRouteFamilyId;
  routeVariant: PlotRouteVariantId;
  project: GameDevelopmentProject;
  week: number;
  activePhase: GameDevelopmentTurnPhase;
  draft: GameDevelopmentTurnDraft;
  pendingTurn: PreparedGameDevelopmentTurn | null;
  turnLedger: PreparedGameDevelopmentTurn[];
  appliedActionIds: string[];
  projectStatus: 'not_created' | 'active' | 'completed' | 'deadline_reached';
};
```

状态规模约束：

- `pendingTurn` 只允许一个，不做多回合队列。
- `turnLedger` 保存回退和审计所需的已完成记录。
- `appliedActionIds` 是幂等防线；不得仅依赖 UI 禁用按钮。
- 下一轮必须决定 ledger 的存档上限或归档方式，但初版不增加复杂归档系统。

## 6. 拟定生成链接口

### 6.1 `submitMessage()` 最小扩展

现有调用方可以忽略新增字段，不要求建立第二套生成函数。

```ts
type MainAssistantAcceptedReceipt = {
  assistantMessageId: string;
  sceneText: string;
};

type SubmitMessageOptions = {
  text?: string;
  keepDraft?: boolean;
  clearDraftOnSuccess?: boolean;

  // 只在 buildPrompt 时追加；不得作为玩家自由输入拼接。
  gameDevelopmentContext?: string;

  // 在完整主正文被接受后调用，早于 secondary progress 和路线复核。
  onMainAssistantAccepted?: (
    receipt: MainAssistantAcceptedReceipt,
  ) => void | Promise<void>;
};
```

`onMainAssistantAccepted` 合同：

- 只在完整且合法的主 assistant 正文已经落入 `uiMessages` 后执行。
- 主正文失败或取消时不执行。
- secondary progress 后续失败不能让同一开发回合重新讲述。
- 回调自身持久化失败必须留下可见错误，并允许只重试幂等提交，不能重新生成正文。

### 6.2 prompt 接口

```ts
type BuildPromptOptions = ExistingBuildPromptOptions & {
  gameDevelopmentContext?: string;
};

function buildGameDevelopmentNarrativeContext(
  turn: PreparedGameDevelopmentTurn,
  project: GameDevelopmentProject,
): string;
```

建议上下文协议：

```text
[GAME_DEVELOPMENT_TURN]
action_instance_id=...
week=...
phase=workday|weekend
action_id=...
target_id=none|...
intent=...
settlement_read_only=...
prompt_version=...
context_fingerprint=...
[/GAME_DEVELOPMENT_TURN]
```

prompt 必须明确：

- 只写本回合小说正文。
- 不改变 action、target 或 intent。
- 不重新计算 settlement。
- 不把规划、调试文本或结算说明写进 Galgame 正文。
- 工作日正文不提前演出周末；周末正文不再追加第二次开发结算。

## 7. 拟定纯函数

```ts
function getAllowedGameDevelopmentActions(
  state: GameDevelopmentState,
): GameDevelopmentActionDefinition[];

function updateGameDevelopmentDraft(
  state: GameDevelopmentState,
  patch: Partial<Pick<GameDevelopmentTurnDraft, 'actionId' | 'selectedTargetId' | 'intent'>>,
): GameDevelopmentState;

function validateGameDevelopmentDraft(
  state: GameDevelopmentState,
): { ok: true } | { ok: false; reason: string };

function calculateGameDevelopmentSettlement(
  state: GameDevelopmentState,
  draft: GameDevelopmentTurnDraft,
): GameDevelopmentSettlement;

function prepareGameDevelopmentTurn(
  state: GameDevelopmentState,
  preparedAt: string,
):
  | { status: 'accepted'; state: GameDevelopmentState; turn: PreparedGameDevelopmentTurn }
  | { status: 'rejected'; reason: string };

function markGameDevelopmentTurnGenerating(
  state: GameDevelopmentState,
  actionInstanceId: string,
): GameDevelopmentState;

function completeGameDevelopmentTurn(
  state: GameDevelopmentState,
  input: {
    actionInstanceId: string;
    assistantMessageId: string;
    completedAt: string;
  },
): GameDevelopmentState;

function failGameDevelopmentTurn(
  state: GameDevelopmentState,
  actionInstanceId: string,
  reason: string,
): GameDevelopmentState;

function rollbackGameDevelopmentTurn(
  state: GameDevelopmentState,
  assistantMessageId: string,
): GameDevelopmentState;
```

## 8. 核心函数伪代码

### 8.1 冻结回合

```ts
function prepareGameDevelopmentTurn(state, preparedAt) {
  if (state.projectStatus !== 'active') reject('项目当前不可推进');
  if (state.pendingTurn) reject('当前已有未完成回合');
  if (!draft.phaseMatches(state.activePhase)) reject('行动阶段不匹配');
  if (!actionAllowedForRouteAndPhase(state, state.draft.actionId)) reject('行动不合法');
  if (!targetAllowed(state, state.draft)) reject('目标不合法');

  const snapshot = captureProjectSnapshot(state);
  const settlement = calculateGameDevelopmentSettlement(state, state.draft);
  const actionInstanceId = crypto.randomUUID();
  const context = buildFrozenContext(state, settlement, actionInstanceId);
  const fingerprint = sha256(stableSerialize(context));

  const turn = freeze({
    actionInstanceId,
    snapshot,
    settlement,
    context,
    contextFingerprint: fingerprint,
    status: 'prepared',
  });

  return accepted(state with pendingTurn = turn);
}
```

### 8.2 调用现有正文链

```ts
async function submitPreparedGameDevelopmentTurn(ctx) {
  const state = readAuthoritativeGameDevelopmentState(ctx);
  const turn = requirePreparedOrFailedTurn(state);

  persist(markGenerating(state, turn.actionInstanceId));

  try {
    await submitMessage(ctx, {
      text: fixedInputFor(turn.phase),
      keepDraft: true,
      clearDraftOnSuccess: false,
      gameDevelopmentContext: turn.context,
      onMainAssistantAccepted: async receipt => {
        const latest = readAuthoritativeGameDevelopmentState(ctx);
        const completed = completeGameDevelopmentTurn(latest, {
          actionInstanceId: turn.actionInstanceId,
          assistantMessageId: receipt.assistantMessageId,
          completedAt: now(),
        });
        persist(completed);
      },
    });
  } catch (error) {
    const latest = readAuthoritativeGameDevelopmentState(ctx);
    if (!wasAlreadyCompleted(latest, turn.actionInstanceId)) {
      persist(failGameDevelopmentTurn(latest, turn.actionInstanceId, visibleReason(error)));
    }
  }
}
```

固定输入建议：

```ts
function fixedInputFor(phase) {
  return phase === 'workday'
    ? '（游戏开发：生成本周工作日回合正文）'
    : '（游戏开发：生成本周周末回合正文）';
}
```

### 8.3 幂等完成与阶段推进

```ts
function completeGameDevelopmentTurn(state, input) {
  const turn = requireSamePendingTurn(state, input.actionInstanceId);

  if (state.appliedActionIds.includes(input.actionInstanceId)) {
    return state; // compare-and-set：已经结算，不重复应用
  }

  let nextProject = applySettlement(state.project, turn.settlement);
  let nextPhase = state.activePhase;
  let nextWeek = state.week;
  let nextWeeksLeft = nextProject.weeksLeft;

  if (turn.phase === 'workday') {
    nextPhase = 'weekend';
  } else {
    nextPhase = 'workday';
    nextWeek += 1;
    nextWeeksLeft = max(0, nextWeeksLeft - 1);
  }

  const projectStatus =
    nextProject.progress >= 100
      ? 'completed'
      : nextWeeksLeft === 0
        ? 'deadline_reached'
        : 'active';

  return state with {
    project: nextProject with weeksLeft = nextWeeksLeft,
    week: nextWeek,
    activePhase: nextPhase,
    draft: emptyDraft(nextPhase),
    pendingTurn: null,
    turnLedger: appendCompletedTurn(turn, input),
    appliedActionIds: append(input.actionInstanceId),
    projectStatus,
  };
}
```

项目结束规则：

- 工作日结算后若 `progress >= 100`，项目立即完成，不强迫再跑周末回合。
- `weeksLeft` 只在周末回合成功后减少。
- 周末结算后若 `weeksLeft === 0` 且项目未完成，进入 `deadline_reached`。

### 8.4 失败重试

```ts
function retryGameDevelopmentTurn(state) {
  const turn = requireStatus(state.pendingTurn, 'failed');
  assert(turn.contextFingerprint === sha256(stableSerialize(turn.context)));

  // 不重新调用 prepare，不重新计算 settlement，不生成新 actionInstanceId。
  return markGameDevelopmentTurnGenerating(state, turn.actionInstanceId);
}
```

### 8.5 Reader 回退

```ts
function rollbackGameDevelopmentTurn(state, assistantMessageId) {
  const turn = findCompletedTurnByAssistantMessageId(state.turnLedger, assistantMessageId);
  if (!turn) return state;

  return restoreFrom(turn.preTurnSnapshot) with {
    pendingTurn: turn with {
      status: 'prepared',
      assistantMessageId: null,
      completedAt: null,
    },
    turnLedger: removeTurnAndAllCausallyLaterTurns(turn),
    appliedActionIds: removeTurnAndAllCausallyLaterIds(turn),
  };
}
```

回退不得只清 `assistantMessageId`；项目数值、阶段、周数和期限必须一起恢复。

## 9. 页面状态任务

手机游戏开发页初版只显示当前阶段，不再显示周一到周六标签。

### 工作日阶段

- 显示四项开发行动。
- 显示可选合作角色和“独自工作”。
- 显示玩家意图输入。
- 提交文案为“开始本周工作”。

### 周末阶段

- 固定 `rest_date`。
- 显示“独自休息”或选择一名角色约会。
- 显示玩家意图输入。
- 提交文案为“开始周末安排”。

### 通用状态

- `draft`：可编辑。
- `prepared / generating`：锁定行动、目标和文案，显示生成中。
- `failed`：显示失败原因以及“重试同一回合”。
- `completed`：显示绑定正文和本次确定性数值变化。
- `project completed / deadline_reached`：隐藏普通提交按钮，显示项目结果。

## 10. 文件边界建议

下一轮只做与游戏开发闭环直接相关的局部模块化，不做根 `index.ts` 全量重构。

```text
game-development/
  index.ts             # 只做统一导出
  types.ts             # 状态、回合、settlement 类型
  rules.ts             # action/target/phase 合法性和确定性结算
  state.ts             # prepare/complete/fail/retry/migrate
  prompt.ts            # 只读上下文与 fingerprint
  orchestration.ts     # 与 submitMessage 的窄接通

index/
  game-development.ts  # DOM 事件绑定和通知胶水
```

预计需要窄修改的既有文件：

- `index.ts`：只保留模块装配和事件绑定调用。
- `actions/index.ts`：增加 prompt context 和正文成功回调。
- `message-format.ts`：注入专用只读上下文。
- `phone/render.ts`：从六天 UI 改成双阶段 UI。
- `types.ts`：让游戏开发状态进入可回滚状态边界。
- `state/store.ts`：快照、恢复、Reader 回退。
- `state/saves.ts`：schema v2 到 v3 的 normalize/migrate。

## 11. 按顺序执行的任务列表

### P0：合同与状态

- [ ] 删除生产领域中的六天/六 slot 初版假设。
- [ ] 建立双阶段 action domain 与 target policy。
- [ ] 增加 v3 状态、prepared turn、ledger 和 appliedActionIds。
- [ ] 定义 v2 六天存档迁移策略；不得把已结算六天状态伪装成未结算双回合。

### P0：确定性回合

- [ ] 实现 draft 校验和纯函数 settlement。
- [ ] 实现 prepare，提交时不再立即改项目数值。
- [ ] 实现 compare-and-set 完成和阶段推进。
- [ ] 实现失败保留与同回合重试。

### P0：正文接通

- [ ] 给 `submitMessage()` 增加专用只读 context 和主正文成功回调。
- [ ] 在两个 `buildPrompt()` 主调用分支注入完全相同的开发上下文。
- [ ] 把 assistant message ID 与 prepared turn 绑定。
- [ ] 证明 secondary progress 失败不会触发重复正文或重复结算。

### P0：存档和回退

- [ ] 把游戏开发状态加入生成前快照。
- [ ] 刷新恢复 draft/prepared/failed/completed。
- [ ] Reader 回退恢复项目快照和阶段。
- [ ] 删除或重生成正文时维护同一因果边界。

### P1：玩家页面

- [ ] 用“工作日 / 周末”替换六天标签和 6/6 计数。
- [ ] 增加 generating、failed、retry、completed 和项目结束状态。
- [ ] prepared 后锁定控件，失败原因必须可见。
- [ ] 把新增 DOM 业务从根 `index.ts` 放入 `index/game-development.ts`。

### P1：项目结束

- [ ] `progress >= 100` 后立即完成项目。
- [ ] 周末后扣 `weeksLeft`，归零且未完成时进入截止结果。
- [ ] 结束状态禁止继续创建 prepared turn。

### P1：验证和人工审查

- [ ] 工作日成功后只进入周末，不增加周数。
- [ ] 周末成功后进入下一周且只扣一周。
- [ ] 工作日/周末失败后重试不重算。
- [ ] 重复点击和重复回调不重复结算。
- [ ] 刷新恢复相同 pending turn 和 fingerprint。
- [ ] 回退工作日正文恢复到工作日前。
- [ ] 回退周末正文恢复到周末前。
- [ ] 项目完成和期限结束合同通过。
- [ ] 最终内联混淆 HTML 通过 Tavern host bundle safety gate。
- [ ] 由用户在真实酒馆完成体验、代码结构和接通审查。

## 12. 初版明确不做

- 不做性能优化和打包瘦身。
- 不做根 `index.ts` 的全量模块化。
- 不做多 pending turn 队列。
- 不增加第二套主正文生成管线。
- 不新增宿主 hidden floor、shujuku、ACU 或数据库插件桥接。
- 不增加专用 secondary AI；继续使用现有正文后的公共流程，且不得让其改算开发 settlement。
- 不把路线语义修复、学校/毕业系统修复混进本任务。
- 不手改 `dist`，不牺牲最终内联、紧凑、混淆的交付形态。

## 13. 可执行验收合同

| 合同 | 给定 | 预期 |
| --- | --- | --- |
| 工作日顺序 | 第 N 周 `workday` | 只能选择四项开发行动 |
| 周末顺序 | 工作日正文成功 | 解锁 `weekend`，周数仍为 N |
| 周推进 | 周末正文成功 | 周数变 N+1，`weeksLeft` 只减 1 |
| 主文失败 | prepared turn 生成失败 | 数值不变，保留相同 turn 可重试 |
| 幂等 | 同一成功回调执行两次 | settlement 只应用一次 |
| 刷新 | `failed` 或 `prepared` 时刷新 | actionInstanceId/context/fingerprint 不变 |
| 工作日回退 | 回退工作日 assistant 正文 | 恢复工作日前项目状态和 workday 阶段 |
| 周末回退 | 回退周末 assistant 正文 | 恢复周末前项目状态和 weekend 阶段 |
| AI 权限 | AI 文本声称不同数值 | 结构化项目数值仍以 TS settlement 为准 |
| 项目完成 | 工作日后 progress 达 100 | 直接完成，不强迫周末回合 |

## 14. 艾尔登特人工审查要求

实现完成后必须提供：

- 工作日选择、生成正文、数值变化和阶段切换截图。
- 周末选择、生成正文、周数与期限变化截图。
- 失败、重试、刷新和回退的实际运行证据。
- 对应 assistant message ID、actionInstanceId 和 settlement 日志。
- 控制台错误检查。
- 最终内联混淆 HTML 的 host safety 检查结果。

机器检查只是证据。没有用户填写的新人工审查结果，不得宣称“已可作为正式流程使用”。

## 15. 下一窗口开场指令

```text
继续 islandmilfcode 的游戏开发双回合初版。

先完整读取：
E:\web\tavern_helper_template-main\src\islandmilfcode\docs\v07-game-development-two-turn-mvp-task-list-v0.1.md

严格按文档把一周实现为“工作日回合 + 周末回合”。旧六天/六 slot 方案作废。
先核对当前 dirty worktree 和接口，再从 P0 合同与状态开始；不要顺带做性能优化、路线修复、学校系统、宿主插件桥接或全量 index.ts 重构。
代码由用户检查；机器验证只作为证据。完成实现和最终内联混淆产物检查后，发出艾尔登特人工审查邀请并停下。
```
