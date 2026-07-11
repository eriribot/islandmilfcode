import type { IslandMemoryDB } from '../memorydatabase/types';
import { upsertAttribute } from '../memorydatabase/upsert';
import type { PlotRouteChoiceReceipt, PlotRouteFamilyId, PlotRouteVariantId } from '../plot-state-machine';

export type GameDevelopmentDayId = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export type GameDevelopmentActionId =
  | 'scenario'
  | 'art'
  | 'code'
  | 'management'
  | 'debug'
  | 'promo'
  | 'blackgold_sprint'
  | 'akane_sprint'
  | 'solo_prototype'
  | 'rest';

export type GameDevelopmentProject = {
  created: boolean;
  title: string;
  genre: string;
  theme: string;
  platform: string;
  phase: string;
  weeksLeft: number;
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
};

export type GameDevelopmentSlot = {
  dayId: GameDevelopmentDayId;
  label: string;
  kind: 'work' | 'weekend';
  actionId: GameDevelopmentActionId | null;
  targetId: string | null;
  intent: string;
};

export type GameDevelopmentSubmission = {
  submissionId: string;
  week: number;
  routeFamily: PlotRouteFamilyId;
  routeVariant: PlotRouteVariantId;
  submittedAt: string;
  context: string;
  slots: GameDevelopmentSlot[];
};

export type GameDevelopmentState = {
  schemaVersion: 1;
  routeFamily: PlotRouteFamilyId;
  routeVariant: PlotRouteVariantId;
  project: GameDevelopmentProject;
  week: number;
  selectedDay: GameDevelopmentDayId;
  slots: Record<GameDevelopmentDayId, GameDevelopmentSlot>;
  lastSubmission: GameDevelopmentSubmission | null;
};

type NumericProjectKey = Exclude<keyof GameDevelopmentProject, 'created' | 'title' | 'genre' | 'theme' | 'platform' | 'phase'>;

export type GameDevelopmentActionDefinition = {
  id: GameDevelopmentActionId;
  label: string;
  hint: string;
  phase: string;
  kind: 'work' | 'weekend';
  families?: PlotRouteFamilyId[];
  variants?: PlotRouteVariantId[];
  deltas: Partial<Record<NumericProjectKey, number>>;
};

export const GAME_DEVELOPMENT_DAYS: Array<{
  id: GameDevelopmentDayId;
  label: string;
  kind: 'work' | 'weekend';
}> = [
  { id: 'mon', label: '周一', kind: 'work' },
  { id: 'tue', label: '周二', kind: 'work' },
  { id: 'wed', label: '周三', kind: 'work' },
  { id: 'thu', label: '周四', kind: 'work' },
  { id: 'fri', label: '周五', kind: 'work' },
  { id: 'sat', label: '周末', kind: 'weekend' },
];

export const GAME_DEVELOPMENT_ACTIONS: GameDevelopmentActionDefinition[] = [
  {
    id: 'scenario',
    label: '写剧本',
    hint: '主线、角色故事与台词',
    phase: '脚本开发',
    kind: 'work',
    deltas: { progress: 10, writing: 16, creativity: 6, budget: -10, fatigue: 6 },
  },
  {
    id: 'art',
    label: '画原画',
    hint: '角色图、插画与界面草图',
    phase: '美术开发',
    kind: 'work',
    deltas: { progress: 10, art: 16, fun: 6, budget: -12, fatigue: 7 },
  },
  {
    id: 'code',
    label: '写代码',
    hint: '游戏运行、画面表现与存档',
    phase: '程序开发',
    kind: 'work',
    deltas: { progress: 14, code: 16, bugs: 10, budget: -14, fatigue: 8 },
  },
  {
    id: 'management',
    label: '制作管理',
    hint: '工作安排、取舍与试玩反馈',
    phase: '制作管理',
    kind: 'work',
    deltas: { progress: 6, polish: 8, bugs: -4, budget: -6, fatigue: -2 },
  },
  {
    id: 'debug',
    label: '测试与修复',
    hint: '试玩、修正与稳定性',
    phase: '测试修正',
    kind: 'work',
    deltas: { progress: 6, polish: 12, bugs: -16, budget: -8, fatigue: 5 },
  },
  {
    id: 'promo',
    label: '宣传试玩',
    hint: '宣传视频、体验版与口碑',
    phase: '宣传准备',
    kind: 'work',
    deltas: { hype: 20, budget: -12, fatigue: 4 },
  },
  {
    id: 'blackgold_sprint',
    label: '英梨梨与诗羽冲刺',
    hint: '高强度剧本与美术联动',
    phase: '高强度冲刺',
    kind: 'work',
    variants: ['stay_blackgold'],
    deltas: { progress: 16, writing: 10, art: 10, fun: 8, bugs: 6, budget: -16, fatigue: 12 },
  },
  {
    id: 'akane_sprint',
    label: '接受朱音严格评审',
    hint: '接受严格反馈，加快完成作品',
    phase: '朱音评审',
    kind: 'work',
    variants: ['akane_core'],
    deltas: { progress: 18, creativity: 12, polish: 8, bugs: 5, budget: -18, fatigue: 16 },
  },
  {
    id: 'solo_prototype',
    label: '独立试玩版',
    hint: '以有限资源独立推进',
    phase: '独立试玩版',
    kind: 'work',
    families: ['solo'],
    deltas: { progress: 12, code: 8, creativity: 8, budget: -7, fatigue: 10 },
  },
  {
    id: 'rest',
    label: '休整 / 约会',
    hint: '恢复疲劳，不推进开发',
    phase: '休整',
    kind: 'weekend',
    deltas: { fatigue: -18, budget: -2 },
  },
];

const GAME_DEVELOPMENT_TARGET_ID = 'route:v07';
const GAME_DEVELOPMENT_STORAGE_KEY = 'gameDevelopment.v1.state';

export function createInitialGameDevelopmentState(receipt: PlotRouteChoiceReceipt): GameDevelopmentState {
  return {
    schemaVersion: 1,
    routeFamily: receipt.familyId,
    routeVariant: receipt.variantId,
    project: {
      created: false,
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
      code: 0,
      polish: 0,
      hype: 0,
      bugs: 0,
      fatigue: 0,
    },
    week: 1,
    selectedDay: 'mon',
    slots: createEmptySlots(),
    lastSubmission: null,
  };
}

export function readGameDevelopmentState(
  db: IslandMemoryDB,
  receipt: PlotRouteChoiceReceipt,
): GameDevelopmentState {
  const raw = db.attributes
    .filter(row => !row.expired && row.targetId === GAME_DEVELOPMENT_TARGET_ID && row.key === GAME_DEVELOPMENT_STORAGE_KEY)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.value;
  if (!raw) return createInitialGameDevelopmentState(receipt);
  try {
    const parsed = JSON.parse(raw) as Partial<GameDevelopmentState>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.routeFamily !== receipt.familyId ||
      parsed.routeVariant !== receipt.variantId ||
      !parsed.project ||
      !parsed.slots
    ) {
      return createInitialGameDevelopmentState(receipt);
    }
    return parsed as GameDevelopmentState;
  } catch {
    return createInitialGameDevelopmentState(receipt);
  }
}

export function commitGameDevelopmentState(db: IslandMemoryDB, state: GameDevelopmentState): void {
  upsertAttribute(db, {
    targetId: GAME_DEVELOPMENT_TARGET_ID,
    key: GAME_DEVELOPMENT_STORAGE_KEY,
    value: JSON.stringify(state),
    valueType: 'json',
    source: 'manual',
    reason: `游戏开发第 ${state.week} 周状态；路线 ${state.routeFamily}/${state.routeVariant}`,
  });
}

export function createGameDevelopmentProject(
  state: GameDevelopmentState,
  details: Pick<GameDevelopmentProject, 'title' | 'genre' | 'theme' | 'platform'>,
): GameDevelopmentState {
  const title = details.title.trim();
  if (!title) return state;
  return {
    ...state,
    project: {
      ...state.project,
      created: true,
      title,
      genre: details.genre.trim() || state.project.genre,
      theme: details.theme.trim() || state.project.theme,
      platform: details.platform.trim() || state.project.platform,
      phase: '企划已建立',
    },
  };
}

export function selectGameDevelopmentDay(
  state: GameDevelopmentState,
  dayId: GameDevelopmentDayId,
): GameDevelopmentState {
  return state.slots[dayId] ? { ...state, selectedDay: dayId } : state;
}

export function selectGameDevelopmentAction(
  state: GameDevelopmentState,
  dayId: GameDevelopmentDayId,
  actionId: GameDevelopmentActionId,
): GameDevelopmentState {
  if (!state.project.created) return state;
  const slot = state.slots[dayId];
  const action = getGameDevelopmentActions(state, slot?.kind).find(item => item.id === actionId);
  if (!slot || !action) return state;
  return {
    ...state,
    selectedDay: dayId,
    slots: {
      ...state.slots,
      [dayId]: { ...slot, actionId, targetId: null, intent: '' },
    },
  };
}

export function updateGameDevelopmentSlot(
  state: GameDevelopmentState,
  dayId: GameDevelopmentDayId,
  patch: Partial<Pick<GameDevelopmentSlot, 'targetId' | 'intent'>>,
): GameDevelopmentState {
  const slot = state.slots[dayId];
  if (!slot || !slot.actionId) return state;
  return {
    ...state,
    slots: {
      ...state.slots,
      [dayId]: {
        ...slot,
        ...(patch.targetId !== undefined ? { targetId: patch.targetId || null } : {}),
        ...(patch.intent !== undefined ? { intent: patch.intent.slice(0, 240) } : {}),
      },
    },
  };
}

export function getGameDevelopmentActions(
  state: Pick<GameDevelopmentState, 'routeFamily' | 'routeVariant'>,
  kind?: GameDevelopmentSlot['kind'],
): GameDevelopmentActionDefinition[] {
  return GAME_DEVELOPMENT_ACTIONS.filter(action => {
    if (kind && action.kind !== kind) return false;
    if (action.families && !action.families.includes(state.routeFamily)) return false;
    if (action.variants && !action.variants.includes(state.routeVariant)) return false;
    return true;
  });
}

export function isGameDevelopmentWeekReady(state: GameDevelopmentState): boolean {
  return state.project.created && GAME_DEVELOPMENT_DAYS.every(day => Boolean(state.slots[day.id].actionId));
}

export function submitGameDevelopmentWeek(
  state: GameDevelopmentState,
  submittedAt: string,
): { status: 'accepted'; state: GameDevelopmentState } | { status: 'rejected'; reason: string } {
  if (!isGameDevelopmentWeekReady(state)) return { status: 'rejected', reason: '六个行动尚未排满。' };
  const slots = GAME_DEVELOPMENT_DAYS.map(day => ({ ...state.slots[day.id] }));
  let project = { ...state.project };
  for (const slot of slots) {
    const action = getGameDevelopmentActions(state, slot.kind).find(item => item.id === slot.actionId);
    if (!action) return { status: 'rejected', reason: `${slot.label} 的行动无效。` };
    project = applyProjectDeltas(project, action.deltas);
    if (action.kind === 'work') project.phase = action.phase;
  }
  project.weeksLeft = Math.max(0, project.weeksLeft - 1);
  const context = buildSubmissionContext(state, slots);
  const submission: GameDevelopmentSubmission = {
    submissionId: `gd-${state.routeVariant}-w${state.week}`,
    week: state.week,
    routeFamily: state.routeFamily,
    routeVariant: state.routeVariant,
    submittedAt,
    context,
    slots,
  };
  return {
    status: 'accepted',
    state: {
      ...state,
      project,
      week: state.week + 1,
      selectedDay: 'mon',
      slots: createEmptySlots(),
      lastSubmission: submission,
    },
  };
}

function createEmptySlots(): Record<GameDevelopmentDayId, GameDevelopmentSlot> {
  return Object.fromEntries(
    GAME_DEVELOPMENT_DAYS.map(day => [
      day.id,
      { dayId: day.id, label: day.label, kind: day.kind, actionId: null, targetId: null, intent: '' },
    ]),
  ) as Record<GameDevelopmentDayId, GameDevelopmentSlot>;
}

function applyProjectDeltas(
  project: GameDevelopmentProject,
  deltas: GameDevelopmentActionDefinition['deltas'],
): GameDevelopmentProject {
  const next = { ...project };
  for (const [key, delta] of Object.entries(deltas) as Array<[NumericProjectKey, number]>) {
    const raw = Number(next[key]) + delta;
    if (key === 'budget' || key === 'weeksLeft') next[key] = Math.max(0, raw);
    else next[key] = Math.max(0, Math.min(100, raw));
  }
  return next;
}

function buildSubmissionContext(state: GameDevelopmentState, slots: GameDevelopmentSlot[]): string {
  return [
    '[GAME_DEVELOPMENT_WEEK]',
    `route_family=${state.routeFamily}`,
    `route_variant=${state.routeVariant}`,
    `week=${state.week}`,
    ...slots.map(slot =>
      `${slot.dayId}: action=${slot.actionId}; target=${slot.targetId ?? 'none'}; intent=${slot.intent || 'none'}`,
    ),
    '[/GAME_DEVELOPMENT_WEEK]',
  ].join('\n');
}
