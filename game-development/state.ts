import type { IslandMemoryDB } from '../memorydatabase/types';
import { upsertAttribute } from '../memorydatabase/upsert';
import type { PlotRouteChoiceReceipt, PlotRouteResolution } from '../plot-state-machine/types';
import {
  addGameDevelopmentCalendarWeeks,
  applyGameDevelopmentSettlement,
  calculateGameDevelopmentSettlement,
  emptyGameDevelopmentDraft,
  getGameDevelopmentCalendarWeekStartForPhase,
  getGameDevelopmentPhaseCalendarRange,
  getInitialGameDevelopmentCalendarWeekStart,
  isGameDevelopmentVariantForFamily,
  parseGameDevelopmentDateTimestamp,
  resolveGameDevelopmentRouteProfile,
  validateGameDevelopmentDraft,
  type GameDevelopmentRuleResult,
} from './rules';
import {
  buildGameDevelopmentFrozenPayloadFingerprint,
  buildGameDevelopmentNarrativeContext,
  buildGameDevelopmentReceiptFingerprint,
  buildGameDevelopmentSceneFingerprint,
  fingerprintGameDevelopmentValue,
  GAME_DEVELOPMENT_PROMPT_VERSION,
  verifyGameDevelopmentAssistantReceipt,
  verifyGameDevelopmentTurnContext,
  type GameDevelopmentFrozenPayload,
} from './prompt';
import type {
  CompletedGameDevelopmentTurn,
  GameDevelopmentActionInstanceId,
  GameDevelopmentAssistantMessageId,
  GameDevelopmentAssistantReceipt,
  GameDevelopmentGenerationAttemptId,
  GameDevelopmentMigrationProvenance,
  GameDevelopmentProject,
  GameDevelopmentRollbackSnapshot,
  GameDevelopmentState,
  GameDevelopmentTurnDraft,
  PendingGameDevelopmentTurn,
  PreparedGameDevelopmentTurn,
} from './types';

export const GAME_DEVELOPMENT_TARGET_ID = 'route:v07';
export const GAME_DEVELOPMENT_STORAGE_KEY = 'gameDevelopment.v1.state';

type LegacyGameDevelopmentProject = Partial<GameDevelopmentProject> & { created?: boolean };

type LegacyGameDevelopmentState = {
  schemaVersion?: number;
  routeConfirmationId?: string;
  routeFamily?: GameDevelopmentState['routeFamily'];
  routeVariant?: GameDevelopmentState['routeVariant'];
  project?: LegacyGameDevelopmentProject;
  week?: number;
  lastSubmission?: { submissionId?: string } | null;
};

export type GameDevelopmentAssistantAcceptance = {
  readonly assistantMessageId: string;
  readonly hostMessageId: number | null;
  readonly sceneText: string;
  readonly generationSource: 'tavern_generate' | 'tavern_generate_raw' | 'shujuku_island_generate';
  readonly acceptedAt: string;
  readonly runId: string;
};

export function getGameDevelopmentRouteConfirmationId(receipt: PlotRouteChoiceReceipt): string {
  return receipt.schemaVersion === 2
    ? receipt.confirmationId
    : `legacy-${receipt.familyId}-${receipt.variantId}-${receipt.confirmedAt}`;
}

export function createInitialGameDevelopmentState(
  receipt: PlotRouteChoiceReceipt,
  resolution: PlotRouteResolution,
): GameDevelopmentState {
  const routeVariant = resolveGameDevelopmentRouteProfile(receipt, resolution);
  const routeEnteredAt = receipt.confirmedAt;
  return {
    schemaVersion: 3,
    routeConfirmationId: getGameDevelopmentRouteConfirmationId(receipt),
    routeFamily: receipt.familyId,
    routeVariant,
    routeEnteredAt,
    calendarWeekStart: getInitialGameDevelopmentCalendarWeekStart(routeEnteredAt),
    project: createDefaultGameDevelopmentProject(),
    projectStatus: 'not_created',
    week: 1,
    activePhase: 'workday',
    draft: emptyGameDevelopmentDraft('workday'),
    pendingTurn: null,
    turnLedger: [],
    migration: null,
  };
}

export function readGameDevelopmentState(
  db: IslandMemoryDB,
  receipt: PlotRouteChoiceReceipt,
  resolution: PlotRouteResolution,
  currentTime = new Date().toISOString(),
  options?: { readonly recoverInterruptedTurn?: boolean },
): GameDevelopmentState {
  const initial = createInitialGameDevelopmentState(receipt, resolution);
  const raw = readStoredGameDevelopmentValue(db);
  if (!raw) return initial;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isMatchingV3State(parsed, initial)) {
      return options?.recoverInterruptedTurn ? normalizeLoadedGameDevelopmentState(parsed, currentTime) : parsed;
    }
    const legacy = parsed as LegacyGameDevelopmentState;
    if (!legacyStateMatchesReceipt(legacy, receipt, initial.routeConfirmationId)) return initial;
    return migrateLegacyGameDevelopmentState(legacy, initial, currentTime);
  } catch {
    return initial;
  }
}

export function commitGameDevelopmentState(db: IslandMemoryDB, state: GameDevelopmentState): void {
  upsertAttribute(db, {
    targetId: GAME_DEVELOPMENT_TARGET_ID,
    key: GAME_DEVELOPMENT_STORAGE_KEY,
    value: JSON.stringify(state),
    valueType: 'json',
    source: 'manual',
    reason: `游戏开发 v3 第 ${state.week} 周 ${state.activePhase}；路线 ${state.routeFamily}/${state.routeVariant}；确认实例 ${state.routeConfirmationId}`,
  });
}

export function createGameDevelopmentProject(
  state: GameDevelopmentState,
  details: Pick<GameDevelopmentProject, 'title' | 'genre' | 'theme' | 'platform'>,
  startedAt = state.routeEnteredAt,
): GameDevelopmentRuleResult<GameDevelopmentState> {
  if (state.projectStatus !== 'not_created') return rejected('项目已经建立。');
  const title = details.title.trim();
  if (!title) return rejected('请先填写游戏名。');
  return accepted({
    ...state,
    calendarWeekStart: getGameDevelopmentCalendarWeekStartForPhase(startedAt, 'workday'),
    projectStatus: 'active',
    project: {
      ...state.project,
      title,
      genre: details.genre.trim() || state.project.genre,
      theme: details.theme.trim() || state.project.theme,
      platform: details.platform.trim() || state.project.platform,
      phase: '企划已建立',
    },
  } as GameDevelopmentState);
}

export function prepareGameDevelopmentTurn(
  state: GameDevelopmentState,
  preparedAt: string,
  allowedTargetIds: Iterable<string>,
): GameDevelopmentRuleResult<{ readonly state: GameDevelopmentState; readonly turn: PendingGameDevelopmentTurn }> {
  if (state.projectStatus !== 'active') return rejected('项目当前不可推进。');
  const validation = validateGameDevelopmentDraft(state, allowedTargetIds);
  if (validation.status === 'rejected') return validation;
  const settlementResult = calculateGameDevelopmentSettlement(state, validation.value);
  if (settlementResult.status === 'rejected') return settlementResult;

  const actionInstanceId = crypto.randomUUID() as GameDevelopmentActionInstanceId;
  const snapshot = captureGameDevelopmentRollbackSnapshot(state, validation.value);
  const payload: GameDevelopmentFrozenPayload = {
    actionInstanceId,
    routeConfirmationId: state.routeConfirmationId,
    routeFamily: state.routeFamily,
    routeVariant: state.routeVariant,
    routeEnteredAt: state.routeEnteredAt,
    calendarWeekStart: state.calendarWeekStart,
    week: state.week,
    phase: validation.value.phase,
    actionId: validation.value.actionId,
    selectedTargetId: validation.value.selectedTargetId,
    intent: validation.value.intent,
    draftRevision: validation.value.revision,
    preparedAt,
    settlement: settlementResult.value,
    promptVersion: GAME_DEVELOPMENT_PROMPT_VERSION,
  };
  const frozenPayloadFingerprint = buildGameDevelopmentFrozenPayloadFingerprint(payload);
  const base = {
    ...payload,
    preTurnSnapshot: snapshot,
    frozenPayloadFingerprint,
    context: buildGameDevelopmentNarrativeContext({ ...payload, frozenPayloadFingerprint }, state.project),
    status: 'prepared' as const,
    generationAttemptId: null,
    failurePhase: null,
    assistantReceipt: null,
    failureReason: null,
    completedAt: null,
  };
  const turn = base as PendingGameDevelopmentTurn;
  return accepted({ state: { ...state, pendingTurn: turn } as GameDevelopmentState, turn });
}

export function markGameDevelopmentTurnGenerating(
  state: GameDevelopmentState,
  actionInstanceId: string,
): GameDevelopmentRuleResult<GameDevelopmentState> {
  const turn = requirePendingTurn(state, actionInstanceId);
  if (turn.status === 'rejected') return turn;
  if (turn.value.status === 'generating') return accepted(state);
  if (turn.value.status === 'commit_pending') return rejected('正文已经接受，正在等待结算提交。');
  if (turn.value.status === 'failed' && turn.value.failurePhase === 'accepted_commit') {
    return rejected('正文已经接受，只能重试结算，不能重新生成。');
  }
  if (!verifyGameDevelopmentTurnContext(turn.value)) return rejected('冻结回合指纹不一致，拒绝重新生成。');
  const pendingTurn: PendingGameDevelopmentTurn = {
    ...turn.value,
    status: 'generating',
    generationAttemptId: crypto.randomUUID() as GameDevelopmentGenerationAttemptId,
    failurePhase: null,
    assistantReceipt: null,
    failureReason: null,
    completedAt: null,
  };
  return accepted({ ...state, pendingTurn } as GameDevelopmentState);
}

export function markGameDevelopmentTurnCommitPending(
  state: GameDevelopmentState,
  actionInstanceId: string,
  acceptance: GameDevelopmentAssistantAcceptance,
): GameDevelopmentRuleResult<GameDevelopmentState> {
  const turn = requirePendingTurn(state, actionInstanceId);
  if (turn.status === 'rejected') return turn;
  if (turn.value.status === 'commit_pending') return accepted(state);
  if (turn.value.status !== 'generating' || !turn.value.generationAttemptId) {
    return rejected('当前回合不处于真实生成状态，拒绝接受正文。');
  }
  const receiptBase: Omit<GameDevelopmentAssistantReceipt, 'receiptFingerprint'> = {
    schemaVersion: 1,
    actionInstanceId: turn.value.actionInstanceId,
    frozenPayloadFingerprint: turn.value.frozenPayloadFingerprint,
    generationAttemptId: turn.value.generationAttemptId,
    messageIdentity: {
      schemaVersion: 1,
      kind: 'persisted_app_message',
      runId: acceptance.runId,
      assistantMessageId: acceptance.assistantMessageId as GameDevelopmentAssistantMessageId,
      hostMessageId: acceptance.hostMessageId,
    },
    generationSource: acceptance.generationSource,
    sceneFingerprint: buildGameDevelopmentSceneFingerprint(acceptance.sceneText),
    acceptedAt: acceptance.acceptedAt,
  };
  const assistantReceipt: GameDevelopmentAssistantReceipt = {
    ...receiptBase,
    receiptFingerprint: buildGameDevelopmentReceiptFingerprint(receiptBase),
  };
  const pendingTurn: PendingGameDevelopmentTurn = {
    ...turn.value,
    status: 'commit_pending',
    assistantReceipt,
    failurePhase: null,
    failureReason: null,
    completedAt: null,
  };
  return accepted({ ...state, pendingTurn } as GameDevelopmentState);
}

export function completeGameDevelopmentTurn(
  state: GameDevelopmentState,
  actionInstanceId: string,
  completedAt: string,
): GameDevelopmentRuleResult<GameDevelopmentState> {
  if (state.turnLedger.some(turn => turn.actionInstanceId === actionInstanceId)) return accepted(state);
  const turn = requirePendingTurn(state, actionInstanceId);
  if (turn.status === 'rejected') return turn;
  if (
    turn.value.status !== 'commit_pending' &&
    !(turn.value.status === 'failed' && turn.value.failurePhase === 'accepted_commit')
  ) {
    return rejected('主正文尚未被接受，不能应用结算。');
  }
  if (!turn.value.assistantReceipt) return rejected('缺少主正文接受凭据。');
  if (!verifyGameDevelopmentTurnContext(turn.value)) return rejected('冻结回合上下文已经变化。');
  if (!verifyGameDevelopmentAssistantReceipt(turn.value.assistantReceipt)) return rejected('主正文接受凭据无效。');
  if (turn.value.assistantReceipt.frozenPayloadFingerprint !== turn.value.frozenPayloadFingerprint) {
    return rejected('主正文接受凭据不属于当前冻结回合。');
  }

  const completedTurn = {
    ...turn.value,
    status: 'completed',
    failurePhase: null,
    failureReason: null,
    completedAt,
  } as CompletedGameDevelopmentTurn;
  const settledProject = applyGameDevelopmentSettlement(state.project, turn.value.settlement);
  const turnLedger = [...state.turnLedger, completedTurn];

  if (settledProject.progress >= 100) {
    return accepted({
      ...state,
      project: settledProject,
      projectStatus: 'completed',
      pendingTurn: null,
      turnLedger,
    } as GameDevelopmentState);
  }

  if (turn.value.phase === 'workday') {
    return accepted({
      ...state,
      project: settledProject,
      activePhase: 'weekend',
      draft: emptyGameDevelopmentDraft('weekend'),
      pendingTurn: null,
      turnLedger,
    } as GameDevelopmentState);
  }

  const project = { ...settledProject, weeksLeft: Math.max(0, settledProject.weeksLeft - 1) };
  const deadlineReached = project.weeksLeft === 0;
  return accepted({
    ...state,
    project,
    projectStatus: deadlineReached ? 'deadline_reached' : 'active',
    week: state.week + 1,
    calendarWeekStart: addGameDevelopmentCalendarWeeks(state.calendarWeekStart, 1),
    activePhase: 'workday',
    draft: emptyGameDevelopmentDraft('workday'),
    pendingTurn: null,
    turnLedger,
  } as GameDevelopmentState);
}

export function failGameDevelopmentTurn(
  state: GameDevelopmentState,
  actionInstanceId: string,
  reason: string,
): GameDevelopmentRuleResult<GameDevelopmentState> {
  if (state.turnLedger.some(turn => turn.actionInstanceId === actionInstanceId)) return accepted(state);
  const turn = requirePendingTurn(state, actionInstanceId);
  if (turn.status === 'rejected') return turn;
  if (turn.value.status === 'prepared') return accepted(state);
  if (turn.value.status === 'failed') return accepted(state);
  const failureReason = String(reason || '未知失败').slice(0, 500);
  const pendingTurn: PendingGameDevelopmentTurn =
    turn.value.status === 'commit_pending'
      ? {
          ...turn.value,
          status: 'failed',
          failurePhase: 'accepted_commit',
          failureReason,
          completedAt: null,
        }
      : {
          ...turn.value,
          status: 'failed',
          failurePhase: 'generation',
          assistantReceipt: null,
          failureReason,
          completedAt: null,
        };
  return accepted({ ...state, pendingTurn } as GameDevelopmentState);
}

export function retryGameDevelopmentCommit(
  state: GameDevelopmentState,
  completedAt: string,
): GameDevelopmentRuleResult<GameDevelopmentState> {
  const turn = state.pendingTurn;
  if (!turn || turn.status !== 'failed' || turn.failurePhase !== 'accepted_commit') {
    return rejected('当前没有可重试的正文后结算。');
  }
  return completeGameDevelopmentTurn(state, turn.actionInstanceId, completedAt);
}

export function rollbackGameDevelopmentTurn(
  state: GameDevelopmentState,
  assistantMessageId: string,
): GameDevelopmentState {
  const index = state.turnLedger.findIndex(
    turn => turn.assistantReceipt.messageIdentity.assistantMessageId === assistantMessageId,
  );
  if (index < 0) return state;
  const turn = state.turnLedger[index];
  const snapshot = turn.preTurnSnapshot;
  const pendingTurn: PendingGameDevelopmentTurn = {
    ...turn,
    status: 'prepared',
    generationAttemptId: null,
    failurePhase: null,
    assistantReceipt: null,
    failureReason: null,
    completedAt: null,
  };
  return {
    ...state,
    project: snapshot.project,
    projectStatus: snapshot.projectStatus,
    week: snapshot.week,
    calendarWeekStart: snapshot.calendarWeekStart,
    activePhase: snapshot.activePhase,
    draft: snapshot.draft,
    pendingTurn,
    turnLedger: state.turnLedger.slice(0, index),
    migration: snapshot.migration,
  } as GameDevelopmentState;
}

export function restorePendingGameDevelopmentTurnForRollback(state: GameDevelopmentState): GameDevelopmentState {
  const pending = state.pendingTurn;
  if (!pending) return state;
  const snapshot = pending.preTurnSnapshot;
  return {
    ...state,
    project: snapshot.project,
    projectStatus: snapshot.projectStatus,
    week: snapshot.week,
    calendarWeekStart: snapshot.calendarWeekStart,
    activePhase: snapshot.activePhase,
    draft: snapshot.draft,
    pendingTurn: null,
    turnLedger: state.turnLedger.slice(0, snapshot.completedTurnCount),
    migration: snapshot.migration,
  } as GameDevelopmentState;
}

export function getLastCompletedGameDevelopmentTurn(state: GameDevelopmentState): CompletedGameDevelopmentTurn | null {
  return state.turnLedger[state.turnLedger.length - 1] ?? null;
}

function createDefaultGameDevelopmentProject(): GameDevelopmentProject {
  return {
    title: '第二作',
    genre: '青春创作文字冒险',
    theme: '社团 / 创作者 / 关系修复',
    platform: '电脑同人游戏',
    phase: '等待建立项目',
    weeksLeft: 18,
    budget: 120,
    progress: 0,
    fun: 10,
    creativity: 10,
    writing: 0,
    art: 0,
    music: 0,
    code: 0,
    polish: 0,
    hype: 0,
    bugs: 0,
    fatigue: 0,
  };
}

function captureGameDevelopmentRollbackSnapshot(
  state: Extract<GameDevelopmentState, { readonly projectStatus: 'active' }>,
  draft: GameDevelopmentTurnDraft & { readonly actionId: GameDevelopmentTurnDraft['actionId'] & string },
): GameDevelopmentRollbackSnapshot {
  return {
    project: state.project,
    projectStatus: 'active',
    week: state.week,
    calendarWeekStart: state.calendarWeekStart,
    activePhase: state.activePhase,
    draft,
    completedTurnCount: state.turnLedger.length,
    completedTurnPrefixFingerprint: fingerprintGameDevelopmentValue(
      state.turnLedger.map(turn => turn.actionInstanceId),
    ),
    migration: state.migration,
  } as GameDevelopmentRollbackSnapshot;
}

function normalizeLoadedGameDevelopmentState(state: GameDevelopmentState, currentTime: string): GameDevelopmentState {
  const pending = state.pendingTurn;
  let normalized = state;
  if (pending) {
    if (
      pending.status === 'commit_pending' ||
      (pending.status === 'failed' && pending.failurePhase === 'accepted_commit')
    ) {
      return state;
    }

    // 老存档可能在 prepared/generating/生成失败时关闭页面；这些状态没有已接受正文，
    // 加载后应恢复提交前选择，不能永久显示“回合处理中”。
    normalized = restorePendingGameDevelopmentTurnForRollback(state);
  }

  if (normalized.projectStatus !== 'active' || normalized.pendingTurn) return normalized;
  const currentTimestamp = parseGameDevelopmentDateTimestamp(currentTime);
  if (currentTimestamp === null) return normalized;
  const currentRange = getGameDevelopmentPhaseCalendarRange(normalized, normalized.activePhase);
  const rangeEndTimestamp = parseGameDevelopmentDateTimestamp(currentRange.end);
  if (rangeEndTimestamp === null || currentTimestamp <= rangeEndTimestamp) return normalized;

  // 旧项目可能在路线确认后很久才真正建立，导致项目仍显示三月、世界已经进入四月。
  // 当前阶段已经完全落后于世界时间时，把这一阶段重锚到当前/下一可用周，禁止正文倒叙推进。
  const calendarWeekStart = getGameDevelopmentCalendarWeekStartForPhase(currentTime, normalized.activePhase);
  return calendarWeekStart === normalized.calendarWeekStart
    ? normalized
    : ({ ...normalized, calendarWeekStart } as GameDevelopmentState);
}

function migrateLegacyGameDevelopmentState(
  legacy: LegacyGameDevelopmentState,
  initial: GameDevelopmentState,
  migratedAt: string,
): GameDevelopmentState {
  const sourceFingerprint = fingerprintGameDevelopmentValue(legacy);
  const project = normalizeLegacyProject(legacy.project, initial.project);
  const sourceLastSubmissionId = String(legacy.lastSubmission?.submissionId ?? '').trim() || null;
  const migration: GameDevelopmentMigrationProvenance = {
    sourceStorageKey: GAME_DEVELOPMENT_STORAGE_KEY,
    sourceSchemaVersion: legacy.schemaVersion === 1 ? 1 : 2,
    sourceRouteConfirmationId:
      legacy.schemaVersion === 1 ? null : String(legacy.routeConfirmationId ?? initial.routeConfirmationId),
    sourceWeek: Math.max(1, Math.floor(Number(legacy.week) || 1)),
    sourceStateFingerprint: sourceFingerprint,
    baselineStateFingerprint: fingerprintGameDevelopmentValue(project),
    strategy: 'legacy_weekly_state_preserved_as_non_rollback_baseline',
    draftSlotsDisposition: 'discarded_without_settlement',
    migratedAt,
    sourceLastSubmissionId,
    lastSubmissionDisposition: sourceLastSubmissionId ? 'discarded_as_already_reflected_in_project_baseline' : 'absent',
  } as GameDevelopmentMigrationProvenance;
  const created = legacy.project?.created !== false;
  const projectStatus = !created
    ? 'not_created'
    : project.progress >= 100
      ? 'completed'
      : project.weeksLeft <= 0
        ? 'deadline_reached'
        : 'active';
  return {
    ...initial,
    project,
    projectStatus,
    week: Math.max(1, Math.floor(Number(legacy.week) || 1)),
    migration,
  } as GameDevelopmentState;
}

function normalizeLegacyProject(
  legacy: LegacyGameDevelopmentProject | undefined,
  fallback: GameDevelopmentProject,
): GameDevelopmentProject {
  const text = (key: keyof Pick<GameDevelopmentProject, 'title' | 'genre' | 'theme' | 'platform' | 'phase'>) =>
    String(legacy?.[key] ?? fallback[key]).trim() || fallback[key];
  const number = (key: keyof Omit<GameDevelopmentProject, 'title' | 'genre' | 'theme' | 'platform' | 'phase'>) => {
    const value = Number(legacy?.[key]);
    return Number.isFinite(value) ? value : fallback[key];
  };
  return {
    title: text('title'),
    genre: text('genre'),
    theme: text('theme'),
    platform: text('platform'),
    phase: text('phase'),
    weeksLeft: Math.max(0, number('weeksLeft')),
    budget: Math.max(0, number('budget')),
    progress: clamp(number('progress')),
    fun: clamp(number('fun')),
    creativity: clamp(number('creativity')),
    writing: clamp(number('writing')),
    art: clamp(number('art')),
    music: clamp(number('music')),
    code: clamp(number('code')),
    polish: clamp(number('polish')),
    hype: clamp(number('hype')),
    bugs: clamp(number('bugs')),
    fatigue: clamp(number('fatigue')),
  };
}

function readStoredGameDevelopmentValue(db: IslandMemoryDB): string | null {
  return (
    db.attributes
      .filter(
        row => !row.expired && row.targetId === GAME_DEVELOPMENT_TARGET_ID && row.key === GAME_DEVELOPMENT_STORAGE_KEY,
      )
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]?.value ?? null
  );
}

function isMatchingV3State(input: unknown, expected: GameDevelopmentState): input is GameDevelopmentState {
  if (!input || typeof input !== 'object') return false;
  const state = input as Partial<GameDevelopmentState>;
  return (
    state.schemaVersion === 3 &&
    state.routeConfirmationId === expected.routeConfirmationId &&
    state.routeFamily === expected.routeFamily &&
    Boolean(state.routeVariant && isGameDevelopmentVariantForFamily(state.routeVariant, expected.routeFamily)) &&
    Boolean(state.project) &&
    Array.isArray(state.turnLedger)
  );
}

function legacyStateMatchesReceipt(
  state: LegacyGameDevelopmentState,
  receipt: PlotRouteChoiceReceipt,
  routeConfirmationId: string,
): boolean {
  if ((state.schemaVersion !== 1 && state.schemaVersion !== 2) || state.routeFamily !== receipt.familyId) return false;
  if (!state.project) return false;
  if (state.schemaVersion === 2) return state.routeConfirmationId === routeConfirmationId;
  return (
    receipt.schemaVersion === 1 &&
    Boolean(state.routeVariant) &&
    state.routeVariant === receipt.variantId &&
    isGameDevelopmentVariantForFamily(state.routeVariant, receipt.familyId)
  );
}

function requirePendingTurn(
  state: GameDevelopmentState,
  actionInstanceId: string,
): GameDevelopmentRuleResult<PendingGameDevelopmentTurn> {
  if (!state.pendingTurn) return rejected('当前没有待处理的游戏开发回合。');
  if (state.pendingTurn.actionInstanceId !== actionInstanceId) return rejected('回合实例已经变化。');
  return accepted(state.pendingTurn);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function accepted<T>(value: T): GameDevelopmentRuleResult<T> {
  return { status: 'accepted', value };
}

function rejected<T>(reason: string): GameDevelopmentRuleResult<T> {
  return { status: 'rejected', reason };
}
