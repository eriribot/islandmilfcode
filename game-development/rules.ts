import type {
  PlotRouteChoiceReceipt,
  PlotRouteFamilyId,
  PlotRouteResolution,
  PlotRouteVariantId,
} from '../plot-state-machine/types';
import type {
  GameDevelopmentActionDefinition,
  GameDevelopmentActionId,
  GameDevelopmentProject,
  GameDevelopmentProjectMetric,
  GameDevelopmentSettlement,
  GameDevelopmentState,
  GameDevelopmentTurnDraft,
  GameDevelopmentTurnPhase,
  GameDevelopmentWeekendActionId,
  GameDevelopmentWorkActionId,
} from './types';

export type GameDevelopmentRuleResult<T> =
  | { readonly status: 'accepted'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: string };

export type GameDevelopmentDraftPatch = Partial<{
  actionId: GameDevelopmentActionId | null;
  selectedTargetId: string | null;
  intent: string;
}>;

type ActionRule = {
  readonly definition: GameDevelopmentActionDefinition;
  readonly settlement: GameDevelopmentSettlement;
};

const ACTION_RULES: Record<GameDevelopmentActionId, ActionRule> = {
  art: {
    definition: { id: 'art', turnPhase: 'workday', label: '画原画', hint: '角色图、插画与界面视觉' },
    settlement: {
      deltas: { progress: 10, art: 16, fun: 6, budget: -12, fatigue: 7 },
      nextProjectPhaseLabel: '美术开发',
    },
  },
  scenario: {
    definition: { id: 'scenario', turnPhase: 'workday', label: '写剧本', hint: '主线、角色故事与台词' },
    settlement: {
      deltas: { progress: 10, writing: 16, creativity: 6, budget: -10, fatigue: 6 },
      nextProjectPhaseLabel: '脚本开发',
    },
  },
  music: {
    definition: { id: 'music', turnPhase: 'workday', label: '制作音乐', hint: '主题曲、配乐与音效方向' },
    settlement: {
      deltas: { progress: 8, music: 16, fun: 8, creativity: 4, budget: -10, fatigue: 5 },
      nextProjectPhaseLabel: '音乐开发',
    },
  },
  programming: {
    definition: { id: 'programming', turnPhase: 'workday', label: '写程序', hint: '系统、演出与存档实现' },
    settlement: {
      deltas: { progress: 14, code: 16, bugs: 10, budget: -14, fatigue: 8 },
      nextProjectPhaseLabel: '程序开发',
    },
  },
  rest_date: {
    definition: { id: 'rest_date', turnPhase: 'weekend', label: '休息 / 约会', hint: '独自恢复或与角色共度周末' },
    settlement: {
      deltas: { fatigue: -18, fun: 4, budget: -2 },
      nextProjectPhaseLabel: '周末休整',
    },
  },
};

export const GAME_DEVELOPMENT_ACTIONS = Object.freeze(
  (Object.keys(ACTION_RULES) as GameDevelopmentActionId[]).map(id => ACTION_RULES[id].definition),
) as readonly GameDevelopmentActionDefinition[];

const FAMILY_VARIANTS: Readonly<Record<PlotRouteFamilyId, readonly PlotRouteVariantId[]>> = {
  stay: ['stay_blackgold', 'stay_user_only'],
  solo: ['solo_user_exit', 'solo_group_exit_except_tomoya'],
  akane: ['akane_core'],
};

const NUMERIC_METRICS: readonly GameDevelopmentProjectMetric[] = [
  'budget',
  'progress',
  'fun',
  'creativity',
  'writing',
  'art',
  'music',
  'code',
  'polish',
  'hype',
  'bugs',
  'fatigue',
];

export function isGameDevelopmentRouteChoice(
  receipt: PlotRouteChoiceReceipt | null | undefined,
): receipt is PlotRouteChoiceReceipt {
  return Boolean(
    receipt && (receipt.familyId === 'stay' || receipt.familyId === 'solo' || receipt.familyId === 'akane'),
  );
}

export function isGameDevelopmentVariantForFamily(variantId: PlotRouteVariantId, familyId: PlotRouteFamilyId): boolean {
  return FAMILY_VARIANTS[familyId].includes(variantId);
}

/**
 * The family remains the player's authoritative route choice. The selected variant is a frozen
 * gameplay profile: legacy receipts keep their real variant, while v2 receipts snapshot the
 * resolver advisory supplied at entry and never follow later flag drift.
 */
export function resolveGameDevelopmentRouteProfile(
  receipt: PlotRouteChoiceReceipt,
  resolution: PlotRouteResolution,
): PlotRouteVariantId {
  if (receipt.schemaVersion === 1) {
    if (!isGameDevelopmentVariantForFamily(receipt.variantId, receipt.familyId)) {
      throw new Error('旧路线 receipt 的 family 与 variant 不一致。');
    }
    return receipt.variantId;
  }

  if (resolution.choice !== receipt.familyId) {
    throw new Error('路线 resolution 与当前 choice receipt 不一致。');
  }
  if (
    resolution.choiceReceipt?.schemaVersion === 2 &&
    resolution.choiceReceipt.confirmationId !== receipt.confirmationId
  ) {
    throw new Error('路线 resolution 属于其他确认实例。');
  }

  const advisory = resolution.families.find(item => item.id === receipt.familyId);
  const variant = advisory?.bestVariantId;
  const matchingRoute = variant
    ? resolution.routes.find(item => item.id === variant && item.familyId === receipt.familyId)
    : null;
  if (!variant || !matchingRoute || !isGameDevelopmentVariantForFamily(variant, receipt.familyId)) {
    throw new Error(`路线 ${receipt.familyId} 没有可冻结的游戏开发 profile。`);
  }
  return variant;
}

export function getAllowedGameDevelopmentActions(
  state: Pick<GameDevelopmentState, 'projectStatus' | 'activePhase'>,
): readonly GameDevelopmentActionDefinition[] {
  if (state.projectStatus !== 'active') return [];
  return GAME_DEVELOPMENT_ACTIONS.filter(action => action.turnPhase === state.activePhase);
}

export function createGameDevelopmentTargetAllowList(targetIds: Iterable<string>): ReadonlySet<string> {
  return new Set(Array.from(targetIds, id => String(id ?? '').trim()).filter(Boolean));
}

export function emptyGameDevelopmentDraft(phase: 'workday'): Extract<GameDevelopmentTurnDraft, { phase: 'workday' }>;
export function emptyGameDevelopmentDraft(phase: 'weekend'): Extract<GameDevelopmentTurnDraft, { phase: 'weekend' }>;
export function emptyGameDevelopmentDraft(phase: GameDevelopmentTurnPhase): GameDevelopmentTurnDraft;
export function emptyGameDevelopmentDraft(phase: GameDevelopmentTurnPhase): GameDevelopmentTurnDraft {
  return phase === 'workday'
    ? { phase, actionId: null, selectedTargetId: null, intent: '', revision: 0 }
    : { phase, actionId: 'rest_date', selectedTargetId: null, intent: '', revision: 0 };
}

export function updateGameDevelopmentDraft(
  state: GameDevelopmentState,
  patch: GameDevelopmentDraftPatch,
  allowedTargetIds: Iterable<string>,
): GameDevelopmentRuleResult<GameDevelopmentState> {
  if (state.projectStatus !== 'active') return rejected('项目当前不可编辑。');
  if (state.pendingTurn) return rejected('当前回合已经冻结，不能再修改行动。');

  const allowedTargets = createGameDevelopmentTargetAllowList(allowedTargetIds);
  const current = state.draft;
  const actionId = patch.actionId !== undefined ? patch.actionId : current.actionId;
  if (actionId && ACTION_RULES[actionId].definition.turnPhase !== state.activePhase) {
    return rejected(state.activePhase === 'workday' ? '工作日只能选择开发行动。' : '周末只能选择休息或约会。');
  }

  let selectedTargetId =
    patch.selectedTargetId !== undefined ? normalizeTargetId(patch.selectedTargetId) : current.selectedTargetId;
  if (!actionId || (selectedTargetId && !allowedTargets.has(selectedTargetId))) selectedTargetId = null;
  const intent = patch.intent !== undefined ? String(patch.intent) : current.intent;

  if (actionId === current.actionId && selectedTargetId === current.selectedTargetId && intent === current.intent) {
    return accepted(state);
  }

  const revision = current.revision + 1;
  const draft: GameDevelopmentTurnDraft =
    state.activePhase === 'workday'
      ? {
          phase: 'workday',
          actionId: actionId as GameDevelopmentWorkActionId | null,
          selectedTargetId,
          intent,
          revision,
        }
      : {
          phase: 'weekend',
          actionId: actionId as GameDevelopmentWeekendActionId | null,
          selectedTargetId,
          intent,
          revision,
        };
  return accepted({ ...state, draft } as GameDevelopmentState);
}

export function validateGameDevelopmentDraft(
  state: GameDevelopmentState,
  allowedTargetIds: Iterable<string>,
): GameDevelopmentRuleResult<GameDevelopmentTurnDraft & { readonly actionId: GameDevelopmentActionId }> {
  if (state.projectStatus !== 'active') return rejected('项目当前不可推进。');
  if (state.pendingTurn) return rejected('当前已有未完成回合。');
  if (state.draft.phase !== state.activePhase) return rejected('草稿阶段与当前回合不一致。');
  if (!state.draft.actionId) return rejected('请先选择本回合行动。');

  const rule = ACTION_RULES[state.draft.actionId];
  if (rule.definition.turnPhase !== state.activePhase) return rejected('行动不属于当前回合。');
  const allowedTargets = createGameDevelopmentTargetAllowList(allowedTargetIds);
  if (state.draft.selectedTargetId && !allowedTargets.has(state.draft.selectedTargetId)) {
    return rejected('所选合作对象已不在当前路线允许列表中。');
  }
  return accepted(state.draft as GameDevelopmentTurnDraft & { readonly actionId: GameDevelopmentActionId });
}

export function calculateGameDevelopmentSettlement(
  state: Pick<GameDevelopmentState, 'projectStatus' | 'activePhase'>,
  draft: GameDevelopmentTurnDraft & { readonly actionId: GameDevelopmentActionId },
): GameDevelopmentRuleResult<GameDevelopmentSettlement> {
  if (state.projectStatus !== 'active') return rejected('项目当前不可结算。');
  const rule = ACTION_RULES[draft.actionId];
  if (rule.definition.turnPhase !== state.activePhase || draft.phase !== state.activePhase) {
    return rejected('行动与当前阶段不一致。');
  }
  return accepted({
    deltas: Object.freeze({ ...rule.settlement.deltas }),
    nextProjectPhaseLabel: rule.settlement.nextProjectPhaseLabel,
  });
}

export function applyGameDevelopmentSettlement(
  project: GameDevelopmentProject,
  settlement: GameDevelopmentSettlement,
): GameDevelopmentProject {
  const next: Record<string, unknown> = { ...project, phase: settlement.nextProjectPhaseLabel };
  for (const key of NUMERIC_METRICS) {
    const delta = settlement.deltas[key];
    if (delta === undefined) continue;
    const raw = Number(project[key]) + delta;
    next[key] = key === 'budget' ? Math.max(0, raw) : clamp(raw, 0, 100);
  }
  return next as GameDevelopmentProject;
}

export function getInitialGameDevelopmentCalendarWeekStart(routeEnteredAt: string): string {
  return getGameDevelopmentCalendarWeekStartForPhase(routeEnteredAt, 'workday');
}

export function getGameDevelopmentCalendarWeekStartForPhase(
  currentTime: string,
  phase: GameDevelopmentTurnPhase,
): string {
  const date = parseIsoDate(currentTime);
  const day = date.getUTCDay();
  if (phase === 'workday') {
    const daysUntilMonday = day === 1 ? 0 : (8 - day) % 7;
    date.setUTCDate(date.getUTCDate() + daysUntilMonday);
  } else {
    const daysSinceMonday = (day + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  }
  return formatIsoDate(date);
}

export function addGameDevelopmentCalendarWeeks(calendarWeekStart: string, weeks: number): string {
  const date = parseIsoDate(calendarWeekStart);
  date.setUTCDate(date.getUTCDate() + Math.trunc(weeks) * 7);
  return formatIsoDate(date);
}

export function getGameDevelopmentPhaseCalendarRange(
  state: Pick<GameDevelopmentState, 'calendarWeekStart' | 'routeEnteredAt' | 'week'>,
  phase: GameDevelopmentTurnPhase,
): { readonly start: string; readonly end: string } {
  const monday = parseIsoDate(state.calendarWeekStart);
  const isV07EntryWeek =
    state.week === 1 &&
    formatIsoDate(monday) === '2013-03-04' &&
    formatIsoDate(parseIsoDate(state.routeEnteredAt)) === '2013-03-04';
  // SAE_07-8 and route confirmation consume Monday. The first playable workday range is Tue-Fri.
  const startOffset = phase === 'workday' ? (isV07EntryWeek ? 1 : 0) : 5;
  const endOffset = phase === 'workday' ? 4 : 6;
  const start = new Date(monday);
  const end = new Date(monday);
  start.setUTCDate(start.getUTCDate() + startOffset);
  end.setUTCDate(end.getUTCDate() + endOffset);
  return { start: formatIsoDate(start), end: formatIsoDate(end) };
}

export function parseGameDevelopmentDateTimestamp(value: string): number | null {
  const datePart = String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!datePart) return null;
  const [year, month, day] = datePart.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (formatIsoDate(parsed) !== datePart) return null;
  return timestamp;
}

function normalizeTargetId(value: string | null): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function parseIsoDate(value: string): Date {
  const timestamp = parseGameDevelopmentDateTimestamp(value);
  if (timestamp === null) throw new Error(`无效的游戏开发日期：${value}`);
  return new Date(timestamp);
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function accepted<T>(value: T): GameDevelopmentRuleResult<T> {
  return { status: 'accepted', value };
}

function rejected<T>(reason: string): GameDevelopmentRuleResult<T> {
  return { status: 'rejected', reason };
}
