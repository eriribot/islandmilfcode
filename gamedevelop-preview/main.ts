import { isPlotDateInWindow } from '../plot-state-machine/date-window';
import { confirmPlotRouteChoice } from '../plot-state-machine/choice';
import { buildPlotFlagProposalPrompts } from '../plot-state-machine/proposal-prompt';
import { reviewPlotFlagProposal } from '../plot-state-machine/proposal';
import { resolvePlotRoutes } from '../plot-state-machine/resolver';
import type {
  PlotFlagDelta,
  PlotFlagReviewResult,
  PlotFlagValue,
  PlotRouteChoiceReceipt,
  PlotRouteId,
} from '../plot-state-machine/types';
import { V07_PLOT_MACHINE } from '../plot-state-machine/v07';
import { LAB_SCENARIOS, type LabScenario } from './scenarios';

type NumericProjectKey =
  | 'weeksLeft'
  | 'budget'
  | 'progress'
  | 'fun'
  | 'creativity'
  | 'writing'
  | 'art'
  | 'code'
  | 'polish'
  | 'hype'
  | 'bugs'
  | 'fatigue';

type ProjectState = {
  projectId: string | null;
  created: boolean;
  title: string;
  genre: string;
  theme: string;
  platform: string;
  phase: string;
} & Record<NumericProjectKey, number>;

type StaffId = 'user' | 'megumi' | 'eriri' | 'utaha';

type StaffState = {
  name: string;
  role: string;
  skill: number;
  morale: number;
};

type StaffDelta = Partial<Record<StaffId, Partial<Pick<StaffState, 'skill' | 'morale'>>>>;

type ActionDefinition = {
  id: string;
  label: string;
  hint: string;
  phase: string;
  deltas: Partial<Record<NumericProjectKey, number>>;
  staff?: StaffDelta;
  signals: string[];
  candidate: string;
};

type WeekdayId = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
type WeeklyRouteMode = 'solo' | 'akane';
type WeeklyScoreKey = 'development' | 'quality' | 'story' | 'fatigue' | 'budget';
type WeeklyScore = Record<WeeklyScoreKey, number>;

type WeeklySlot = {
  id: WeekdayId;
  label: string;
  dateLabel: string;
  kind: 'work' | 'weekend';
  actionId: string | null;
  targetId: string | null;
  intent: string;
};

type WeeklyPlan = {
  routeMode: WeeklyRouteMode;
  week: number;
  selectedDay: WeekdayId;
  slots: Record<WeekdayId, WeeklySlot>;
  submitted: boolean;
  promptPreview: string;
  narrativePreview: string;
};

type ReviewCandidate = {
  id: string;
  turn: number;
  actionId: string;
  actionLabel: string;
  projectDeltas: Partial<Record<NumericProjectKey, number>>;
  staffDeltas: StaffDelta;
  opened: string[];
  phase: string;
  narrativeCandidate: string;
  status: 'pending_review' | 'revision_requested';
  reviewNotes?: string;
  triggerChain: string[];
  createdAt: string;
};

type LabStatus = 'idle' | 'accepted' | 'accepted_no_change' | 'needs_review' | 'outside_window' | 'unavailable';

type LabState = {
  scenarioId: string;
  status: LabStatus;
  sceneText: string;
  rawText: string;
  rawAvailable: boolean;
  promptRoles: string[];
  attempts: number;
  review: PlotFlagReviewResult | null;
  writes: string[];
};

type GameState = {
  screen: 'cover' | 'play';
  view: 'route' | 'development';
  currentDate: string;
  currentEventId: string;
  turn: number;
  project: ProjectState;
  staff: Record<StaffId, StaffState>;
  storySignals: Record<string, PlotFlagValue | undefined>;
  evidence: Record<string, string | undefined>;
  reviewQueue: ReviewCandidate[];
  lastTriggerChain: string[];
  localChoice: PlotRouteChoiceReceipt | null;
  weeklyPlan: WeeklyPlan;
  lab: LabState;
};

type ReviewDecision =
  | 'approve'
  | 'reject'
  | 'revise'
  | {
      decision?: 'approve' | 'reject' | 'revise';
      notes?: string;
    };

type GameDevelopPreviewApi = {
  loadGameDevelopState: () => GameState;
  settlePlayerAction: (input: string | { actionId?: string }) => ReviewCandidate | null;
  queueNarrativeCandidate: (result: ReviewCandidate | null) => {
    status: string;
    candidateId?: string;
    reason?: string;
  };
  applyHumanReview: (decision?: ReviewDecision) => Record<string, unknown>;
  exportRouteSignals: () => PlotFlagDelta[];
  enterGame: () => void;
  showCover: () => void;
  setView: (view: 'route' | 'development') => void;
  runLabScenario: (scenarioId: string) => void;
  confirmLocalRoute: (routeId: PlotRouteId, skipDialog?: boolean) => boolean;
  submitWeeklyPlan: () => boolean;
};

declare global {
  interface Window {
    gameDevelopPreview: GameDevelopPreviewApi;
    render_game_to_text: () => string;
    advanceTime: (ms: number) => void;
  }
}

const signalDefinitions = V07_PLOT_MACHINE.flags;

const weekDays: Array<{ id: WeekdayId; label: string; dateLabel: string; kind: 'work' | 'weekend' }> = [
  { id: 'mon', label: '周一', dateLabel: '工作日 01', kind: 'work' },
  { id: 'tue', label: '周二', dateLabel: '工作日 02', kind: 'work' },
  { id: 'wed', label: '周三', dateLabel: '工作日 03', kind: 'work' },
  { id: 'thu', label: '周四', dateLabel: '工作日 04', kind: 'work' },
  { id: 'fri', label: '周五', dateLabel: '工作日 05', kind: 'work' },
  { id: 'sat', label: '周末', dateLabel: '休整 / 约会', kind: 'weekend' },
];

const weeklyRouteProfiles: Record<WeeklyRouteMode, { label: string; note: string; promptName: string }> = {
  solo: {
    label: '单飞线',
    note: '自主推进，资源更紧；合作对象按本周安排进入。',
    promptName: 'solo',
  },
  akane: {
    label: '朱音线',
    note: '截止压力更高，创作强度和关系压力会进入正文。',
    promptName: 'akane',
  },
};

const weeklyScoreMeta: Array<[WeeklyScoreKey, string, string]> = [
  ['development', '开发积分', '#1f7a8c'],
  ['quality', '质量积分', '#76519f'],
  ['story', '剧情/关系', '#c9365a'],
  ['fatigue', '疲劳变化', '#7a8699'],
  ['budget', '预算变化', '#b7791f'],
];

const weekendTargets: Record<WeeklyRouteMode, Array<{ id: string; label: string }>> = {
  solo: [
    { id: 'solo_self', label: '独处整理思路' },
    { id: 'eriri', label: '和英梨梨放松' },
    { id: 'utaha', label: '和诗羽谈创作' },
  ],
  akane: [
    { id: 'akane', label: '和朱音见面' },
    { id: 'eriri', label: '和英梨梨放松' },
    { id: 'utaha', label: '和诗羽谈创作' },
  ],
};

function makeWeeklyPlan(): WeeklyPlan {
  return {
    routeMode: 'solo',
    week: 1,
    selectedDay: 'mon',
    slots: Object.fromEntries(
      weekDays.map(day => [
        day.id,
        {
          ...day,
          actionId: null,
          targetId: null,
          intent: '',
        },
      ]),
    ) as Record<WeekdayId, WeeklySlot>,
    submitted: false,
    promptPreview: '',
    narrativePreview: '',
  };
}

const initialState: GameState = {
  screen: 'cover',
  view: 'route',
  currentDate: '2013-03-04',
  currentEventId: 'SAE_07-GAME-DEVELOP',
  turn: 1,
  project: {
    projectId: 'v07-second-project',
    created: true,
    title: '第二作',
    genre: '青春创作 ADV',
    theme: '社团 / 创作者 / 关系修复',
    platform: 'PC 同人展',
    phase: '企划已建立',
    weeksLeft: 18,
    budget: 120,
    progress: 8,
    fun: 18,
    creativity: 22,
    writing: 20,
    art: 16,
    code: 10,
    polish: 6,
    hype: 4,
    bugs: 12,
    fatigue: 18,
  },
  staff: {
    user: { name: 'User', role: '制作人 / 企划', skill: 38, morale: 62 },
    megumi: { name: '惠', role: '副代表候选', skill: 26, morale: 54 },
    eriri: { name: '英梨梨', role: '原画', skill: 44, morale: 46 },
    utaha: { name: '诗羽', role: '剧本', skill: 46, morale: 44 },
  },
  storySignals: Object.fromEntries(signalDefinitions.map(signal => [signal.id, undefined])),
  evidence: {},
  reviewQueue: [],
  lastTriggerChain: ['init -> cover: PRESS ANY KEY waits for input'],
  localChoice: null,
  weeklyPlan: makeWeeklyPlan(),
  lab: {
    scenarioId: LAB_SCENARIOS[0].id,
    status: 'idle',
    sceneText: LAB_SCENARIOS[0].sceneText,
    rawText: LAB_SCENARIOS[0].responses.join('\n\n--- repair ---\n\n'),
    rawAvailable: true,
    promptRoles: [],
    attempts: 0,
    review: null,
    writes: [],
  },
};

const actions: ActionDefinition[] = [
  {
    id: 'concept',
    label: '定企划',
    hint: '游戏名 / 类型 / 卖点',
    phase: '企划定稿',
    deltas: { progress: 12, creativity: 14, fun: 8, budget: -8, fatigue: 4 },
    staff: { user: { skill: 4, morale: 2 }, megumi: { skill: 3, morale: 4 } },
    signals: ['second_project_seed_ready'],
    candidate: '企划候选：第二作企划初稿已经足以成为实际行动的基础。',
  },
  {
    id: 'scenario',
    label: '写剧本',
    hint: '共通线 / 个人线 / 台词',
    phase: '脚本开发',
    deltas: { progress: 10, writing: 18, creativity: 6, budget: -10, fatigue: 6 },
    staff: { utaha: { skill: 5, morale: 3 }, user: { skill: 2, morale: -1 } },
    signals: ['utaha_author_pride_supported'],
    candidate: '剧本候选：User 明确承认诗羽作为霞诗子的作者自尊，不把她当作附属工具。',
  },
  {
    id: 'art',
    label: '画原画',
    hint: '立绘 / CG / UI 草图',
    phase: '美术开发',
    deltas: { progress: 10, art: 18, fun: 6, budget: -12, fatigue: 7 },
    staff: { eriri: { skill: 5, morale: 3 }, user: { skill: 1, morale: -1 } },
    signals: ['eriri_high_battlefield_supported'],
    candidate: '原画候选：User 给英梨梨提供足够让她燃烧的高强度创作战场。',
  },
  {
    id: 'code',
    label: '写代码',
    hint: '引擎 / 演出 / 存档',
    phase: '程序开发',
    deltas: { progress: 14, code: 18, bugs: 10, budget: -14, fatigue: 8 },
    staff: { user: { skill: 5, morale: -2 } },
    signals: [],
    candidate: '程序候选：把企划变成能跑的版本，但 bug 会明显上升。',
  },
  {
    id: 'megumi',
    label: '请惠共担',
    hint: '排期 / 否决权 / 普通人视角',
    phase: '制作管理',
    deltas: { progress: 6, polish: 8, bugs: -4, fatigue: -2, budget: -6 },
    staff: { megumi: { skill: 6, morale: 8 }, user: { morale: 4 } },
    signals: ['megumi_coplanner'],
    candidate: '管理候选：惠以共同企划和副代表身份拥有纠正、争吵和制衡权。',
  },
  {
    id: 'debug',
    label: '测试除 bug',
    hint: '试玩 / 修正 / 稳定性',
    phase: 'Debug',
    deltas: { progress: 6, polish: 12, bugs: -16, budget: -8, fatigue: 5 },
    staff: { megumi: { skill: 3, morale: 2 }, user: { skill: 2, morale: -1 } },
    signals: [],
    candidate: 'Debug 候选：让当前版本更稳定，减少后面正文与玩法不一致的风险。',
  },
  {
    id: 'promo',
    label: '宣传试玩',
    hint: 'PV / 体验版 / 口碑',
    phase: '宣传准备',
    deltas: { hype: 20, budget: -12, fatigue: 4 },
    staff: { user: { skill: 2, morale: 3 }, eriri: { morale: 2 }, utaha: { morale: 2 } },
    signals: [],
    candidate: '宣传候选：做出可展示的试玩与宣传素材，给项目外部反馈。',
  },
  {
    id: 'blackgold',
    label: '黑金冲刺',
    hint: '英梨梨 + 诗羽合力',
    phase: '高强度冲刺',
    deltas: { progress: 16, writing: 10, art: 10, fun: 8, bugs: 6, fatigue: 12, budget: -16 },
    staff: { eriri: { skill: 4, morale: 4 }, utaha: { skill: 4, morale: 4 }, user: { morale: -2 } },
    signals: ['blackgold_counterwill'],
    candidate: '黑金冲刺候选：英梨梨和诗羽形成了共同击退朱音的创作意志。',
  },
  {
    id: 'rest',
    label: '休整',
    hint: '恢复 / 腻歪 / 不推进开发',
    phase: '休整',
    deltas: { fatigue: -18, budget: -2 },
    staff: {
      user: { morale: 6 },
      megumi: { morale: 4 },
      eriri: { morale: 4 },
      utaha: { morale: 4 },
    },
    signals: [],
    candidate: '休整候选：不推进路线事实，只保留一起喘口气的余裕。',
  },
];

const metricMeta: Array<[NumericProjectKey, string, string]> = [
  ['progress', '完成度', '#1f7a8c'],
  ['fun', '趣味', '#2f855a'],
  ['creativity', '创意', '#c9365a'],
  ['writing', '剧本', '#76519f'],
  ['art', '美术', '#b7791f'],
  ['code', '程序', '#4a63b5'],
  ['polish', '完成感', '#697386'],
  ['hype', '期待度', '#d14d72'],
  ['bugs', 'Bug', '#b42318'],
  ['fatigue', '疲劳', '#7a8699'],
  ['budget', '预算', '#1f7a8c'],
];

let state = clone(initialState);

const coverScreen = byId<HTMLElement>('cover-screen');
const gameScreen = byId<HTMLElement>('game-screen');
const routeScreen = byId<HTMLElement>('route-screen');
const developmentView = byId<HTMLElement>('development-view');
const routePageStatus = byId<HTMLElement>('route-page-status');
const routeWindowLabel = byId<HTMLElement>('route-window-label');
const routeWindowNote = byId<HTMLElement>('route-window-note');
const routeEvidencePage = byId<HTMLElement>('route-evidence-page');
const actionGrid = byId<HTMLElement>('action-grid');
const metricGrid = byId<HTMLElement>('metric-grid');
const weeklyReadiness = byId<HTMLElement>('weekly-readiness');
const weeklyStatusLabel = byId<HTMLElement>('weekly-status-label');
const weeklyRouteTabs = byId<HTMLElement>('weekly-route-tabs');
const weeklyRouteNote = byId<HTMLElement>('weekly-route-note');
const weekTabs = byId<HTMLElement>('week-tabs');
const selectedWeekDayKicker = byId<HTMLElement>('selected-week-day-kicker');
const selectedWeekDayTitle = byId<HTMLElement>('selected-week-day-title');
const selectedWeekDayState = byId<HTMLElement>('selected-week-day-state');
const weekActionGrid = byId<HTMLElement>('week-action-grid');
const weekTargetSelect = byId<HTMLSelectElement>('week-target-select');
const weekIntent = byId<HTMLTextAreaElement>('week-intent');
const weeklyScoreboard = byId<HTMLElement>('weekly-scoreboard');
const weeklyScoreCaption = byId<HTMLElement>('weekly-score-caption');
const weeklyPlanSummary = byId<HTMLElement>('weekly-plan-summary');
const weeklySubmitHint = byId<HTMLElement>('weekly-submit-hint');
const submitWeekButton = byId<HTMLButtonElement>('submit-week-btn');
const weeklyPromptPreview = byId<HTMLElement>('weekly-prompt-preview');
const weeklyNarrativePreview = byId<HTMLElement>('weekly-narrative-preview');
const staffList = byId<HTMLElement>('staff-list');
const candidateBox = byId<HTMLElement>('candidate-box');
const storySignalList = byId<HTMLElement>('story-signal-list');
const routeResolutionList = byId<HTMLElement>('route-resolution-list');
const scenarioSelect = byId<HTMLSelectElement>('lab-scenario');
const labDate = byId<HTMLInputElement>('lab-date');
const labScene = byId<HTMLElement>('lab-scene');
const labRaw = byId<HTMLElement>('lab-raw');
const labReview = byId<HTMLElement>('lab-review');
const labWrite = byId<HTMLElement>('lab-write');
const labStatus = byId<HTMLElement>('lab-status');
const canvas = byId<HTMLCanvasElement>('route-canvas');
const ctx = requireCanvasContext(canvas);

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function requireCanvasContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = target.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  return context;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clamp(value: number, max = 100): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function applyProjectDeltas(target: GameState, deltas: Partial<Record<NumericProjectKey, number>>): void {
  for (const [rawKey, rawDelta] of Object.entries(deltas)) {
    const key = rawKey as NumericProjectKey;
    const delta = rawDelta ?? 0;
    const max = key === 'budget' ? 200 : 100;
    target.project[key] = clamp(target.project[key] + delta, max);
  }
}

function applyStaffDeltas(target: GameState, staffDeltas: StaffDelta): void {
  for (const [rawStaffId, deltas] of Object.entries(staffDeltas)) {
    const staffId = rawStaffId as StaffId;
    const staff = target.staff[staffId];
    if (!staff || !deltas) continue;
    if (typeof deltas.skill === 'number') staff.skill = clamp(staff.skill + deltas.skill);
    if (typeof deltas.morale === 'number') staff.morale = clamp(staff.morale + deltas.morale);
  }
}

function derivePhase(project: ProjectState): string {
  if (project.progress >= 100) return '完成候选';
  if (project.progress >= 72) return project.bugs > 20 ? 'Debug' : '收尾打磨';
  if (project.progress >= 42) return '正式开发';
  if (project.progress >= 20) return '原型制作';
  return project.phase;
}

function settlePlayerAction(input: string | { actionId?: string }): ReviewCandidate | null {
  const actionId = typeof input === 'string' ? input : input.actionId;
  const action = actions.find(item => item.id === actionId);
  if (!action) return null;
  if (action.id === 'concept' && state.project.created) return null;

  const preview = clone(state);
  applyProjectDeltas(preview, action.deltas);
  applyStaffDeltas(preview, action.staff ?? {});
  preview.project.phase = derivePhase({ ...preview.project, phase: action.phase });
  const opened = action.signals.filter(signalId => state.storySignals[signalId] !== 'yes');

  return {
    id: makeCandidateId(),
    turn: state.turn,
    actionId: action.id,
    actionLabel: action.label,
    projectDeltas: action.deltas,
    staffDeltas: action.staff ?? {},
    opened,
    phase: action.phase,
    narrativeCandidate: action.candidate,
    status: 'pending_review',
    triggerChain: [
      `player action: ${action.id}`,
      'settlePlayerAction(input): preview project state only',
      `applyProjectDeltas(preview): ${formatDeltas(action.deltas)}`,
      'queueNarrativeCandidate(result): waits for Human Review before project settlement',
    ],
    createdAt: new Date().toISOString(),
  };
}

function makeCandidateId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `candidate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDeltas(deltas: Partial<Record<NumericProjectKey, number>>): string {
  return Object.entries(deltas)
    .map(([key, delta]) => `${key}${Number(delta) >= 0 ? '+' : ''}${delta}`)
    .join(', ');
}

function getWeeklyAction(actionId: string | null): ActionDefinition | null {
  return actionId ? actions.find(action => action.id === actionId) ?? null : null;
}

function getWeeklyActionsForSlot(slot: WeeklySlot): ActionDefinition[] {
  if (slot.kind === 'weekend') return actions.filter(action => action.id === 'rest');
  return actions.filter(action => {
    if (action.id === 'rest') return false;
    if (action.id === 'concept') return !state.project.created;
    return true;
  });
}

function getWeeklyTargets(slot: WeeklySlot): Array<{ id: string; label: string }> {
  if (slot.kind === 'weekend') return [{ id: '', label: '不指定对象' }, ...weekendTargets[state.weeklyPlan.routeMode]];
  return [
    { id: '', label: '独自完成' },
    { id: 'megumi', label: '和惠协作' },
    { id: 'eriri', label: '和英梨梨协作' },
    { id: 'utaha', label: '和诗羽协作' },
    ...(state.weeklyPlan.routeMode === 'akane' ? [{ id: 'akane', label: '和朱音协作' }] : []),
  ];
}

function weeklyActionScore(action: ActionDefinition): WeeklyScore {
  const deltas = action.deltas;
  return {
    development: deltas.progress ?? 0,
    quality: Math.round(
      ((deltas.creativity ?? 0) + (deltas.writing ?? 0) + (deltas.art ?? 0) + (deltas.code ?? 0) + (deltas.polish ?? 0)) / 2,
    ),
    story: action.signals.length * 4 + (action.id === 'scenario' || action.id === 'rest' ? 2 : 0),
    fatigue: deltas.fatigue ?? 0,
    budget: deltas.budget ?? 0,
  };
}

function weeklyScore(): WeeklyScore {
  const score: WeeklyScore = { development: 0, quality: 0, story: 0, fatigue: 0, budget: 0 };
  for (const day of weekDays) {
    const action = getWeeklyAction(state.weeklyPlan.slots[day.id].actionId);
    if (!action) continue;
    const actionScore = weeklyActionScore(action);
    for (const key of Object.keys(score) as WeeklyScoreKey[]) score[key] += actionScore[key];
  }
  return score;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function weeklyPlanCount(): number {
  return weekDays.filter(day => Boolean(state.weeklyPlan.slots[day.id].actionId)).length;
}

function isWeeklyPlanReady(): boolean {
  return weeklyPlanCount() === weekDays.length;
}

function weeklyTargetLabel(slot: WeeklySlot): string {
  return getWeeklyTargets(slot).find(target => target.id === (slot.targetId ?? ''))?.label ?? '独自完成';
}

function buildWeeklyPrompt(): string {
  const profile = weeklyRouteProfiles[state.weeklyPlan.routeMode];
  const lines = weekDays.map(day => {
    const slot = state.weeklyPlan.slots[day.id];
    const action = getWeeklyAction(slot.actionId);
    return `${slot.label}（${slot.dateLabel}）：action=${action?.id}; action_label=${action?.label}; target=${weeklyTargetLabel(slot)}; intent=${slot.intent || '未填写，由正文根据行动事实演出'}`;
  });
  return [
    '[GAME_DEVELOPMENT_WEEK]',
    `route=${profile.promptName}`,
    `week=${state.weeklyPlan.week}`,
    'cadence=5_workdays_plus_weekend',
    'instruction=本周六个行动是玩家已确定的只读上下文，正文必须按日体现，不得替换行动类型或自行改写项目数值。',
    ...lines,
    '[/GAME_DEVELOPMENT_WEEK]',
  ].join('\n');
}

function buildWeeklyNarrativePreview(): string {
  const profile = weeklyRouteProfiles[state.weeklyPlan.routeMode];
  const arranged = weekDays
    .map(day => {
      const slot = state.weeklyPlan.slots[day.id];
      const action = getWeeklyAction(slot.actionId);
      return `${slot.label}的${action?.label ?? '行动'}`;
    })
    .join('、');
  return `第 ${state.weeklyPlan.week} 周，${profile.label}的开发节奏被排成了${arranged}。正文会从这些确定行动中展开人物冲突、工作细节和周末场景；这段文字只是本地预览，没有调用 AI。`;
}

function invalidateWeeklySubmission(): void {
  state.weeklyPlan.submitted = false;
  state.weeklyPlan.promptPreview = '';
  state.weeklyPlan.narrativePreview = '';
}

function selectWeeklyDay(dayId: WeekdayId): void {
  state.weeklyPlan.selectedDay = dayId;
  render();
}

function setWeeklyRoute(routeMode: WeeklyRouteMode): void {
  state.weeklyPlan.routeMode = routeMode;
  for (const day of weekDays) {
    const slot = state.weeklyPlan.slots[day.id];
    const validTarget = getWeeklyTargets(slot).some(target => target.id === (slot.targetId ?? ''));
    if (!validTarget) slot.targetId = slot.kind === 'weekend' ? weekendTargets[routeMode][0]?.id ?? null : null;
  }
  invalidateWeeklySubmission();
  state.lastTriggerChain = [`weekly route mode: ${routeMode}`, 'local preview only: no route choice or memoryDB write'];
  render();
}

function assignWeeklyAction(actionId: string): void {
  const slot = state.weeklyPlan.slots[state.weeklyPlan.selectedDay];
  const action = getWeeklyActionsForSlot(slot).find(item => item.id === actionId);
  if (!action) return;
  slot.actionId = action.id;
  slot.targetId = slot.kind === 'weekend' ? weekendTargets[state.weeklyPlan.routeMode][0]?.id ?? null : null;
  invalidateWeeklySubmission();
  render();
}

function submitWeeklyPlan(): boolean {
  if (!isWeeklyPlanReady()) return false;
  state.weeklyPlan.promptPreview = buildWeeklyPrompt();
  state.weeklyPlan.narrativePreview = buildWeeklyNarrativePreview();
  state.weeklyPlan.submitted = true;
  state.lastTriggerChain = [
    `weekly plan submitted: week ${state.weeklyPlan.week}`,
    `six actions frozen: ${weekDays.map(day => state.weeklyPlan.slots[day.id].actionId).join(' -> ')}`,
    'main prompt preview: weekly action context injected as read-only input',
    'local preview only: no real generation or project settlement',
  ];
  render();
  return true;
}

function renderWeeklyPromptPreview(): void {
  if (!isWeeklyPlanReady()) {
    weeklyPromptPreview.textContent = '六个行动安排完成后，这里会显示只读的提示词片段。';
    weeklyNarrativePreview.classList.add('is-hidden');
    return;
  }
  weeklyPromptPreview.textContent = state.weeklyPlan.submitted
    ? state.weeklyPlan.promptPreview
    : `【待提交预览】\n${buildWeeklyPrompt()}`;
  weeklyNarrativePreview.classList.toggle('is-hidden', !state.weeklyPlan.submitted);
  weeklyNarrativePreview.innerHTML = state.weeklyPlan.submitted
    ? `<span>本地正文预览</span><p>${escapeHtml(state.weeklyPlan.narrativePreview)}</p>`
    : '';
}

function renderWeeklyPlanner(): void {
  const plan = state.weeklyPlan;
  const profile = weeklyRouteProfiles[plan.routeMode];
  const count = weeklyPlanCount();
  const ready = isWeeklyPlanReady();
  const selectedSlot = plan.slots[plan.selectedDay];
  const selectedDay = weekDays.find(day => day.id === plan.selectedDay) ?? weekDays[0];
  const score = weeklyScore();

  weeklyRouteTabs.innerHTML = (Object.keys(weeklyRouteProfiles) as WeeklyRouteMode[])
    .map(routeMode => {
      const route = weeklyRouteProfiles[routeMode];
      return `<button type="button" class="weekly-route-tab ${plan.routeMode === routeMode ? 'is-selected' : ''}" data-week-route="${routeMode}">${route.label}</button>`;
    })
    .join('');
  weeklyRouteNote.textContent = profile.note;

  weekTabs.innerHTML = weekDays
    .map(day => {
      const slot = plan.slots[day.id];
      const action = getWeeklyAction(slot.actionId);
      return `
        <button type="button" role="tab" aria-selected="${plan.selectedDay === day.id}" class="week-tab ${plan.selectedDay === day.id ? 'is-selected' : ''} ${slot.actionId ? 'is-planned' : ''} ${day.kind === 'weekend' ? 'is-weekend' : ''}" data-week-day="${day.id}">
          <span>${day.label}</span>
          <strong>${action ? escapeHtml(action.label) : '待安排'}</strong>
          <small>${day.dateLabel}</small>
        </button>
      `;
    })
    .join('');

  selectedWeekDayKicker.textContent = `${selectedDay.label} · ${selectedDay.kind === 'weekend' ? '周末行动' : '工作日开发'}`;
  selectedWeekDayTitle.textContent = selectedDay.kind === 'weekend' ? '安排本周末的休整或约会' : `安排${selectedDay.label}的开发行动`;
  selectedWeekDayState.textContent = selectedSlot.actionId ? `已安排：${getWeeklyAction(selectedSlot.actionId)?.label ?? ''}` : '未安排';
  selectedWeekDayState.className = `slot-state ${selectedSlot.actionId ? 'is-planned' : ''}`;

  const availableActions = getWeeklyActionsForSlot(selectedSlot);
  weekActionGrid.innerHTML = availableActions
    .map(action => {
      const actionScore = weeklyActionScore(action);
      return `
        <button type="button" class="week-action-card ${selectedSlot.actionId === action.id ? 'is-selected' : ''}" data-week-action-id="${action.id}">
          <span class="week-action-card__top"><strong>${escapeHtml(action.label)}</strong><em>${selectedSlot.actionId === action.id ? '已选择' : '选择'}</em></span>
          <small>${escapeHtml(action.hint)}</small>
          <span class="week-action-card__points">开发 ${formatSigned(actionScore.development)} · 质量 ${formatSigned(actionScore.quality)} · 疲劳 ${formatSigned(actionScore.fatigue)}</span>
        </button>
      `;
    })
    .join('');

  const targets = getWeeklyTargets(selectedSlot);
  weekTargetSelect.innerHTML = targets.map(target => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)}</option>`).join('');
  weekTargetSelect.value = selectedSlot.targetId ?? '';
  weekTargetSelect.disabled = !selectedSlot.actionId;
  weekIntent.value = selectedSlot.intent;
  weekIntent.disabled = !selectedSlot.actionId;

  weeklyReadiness.textContent = `${count} / ${weekDays.length}`;
  weeklyStatusLabel.textContent = plan.submitted ? '已提交本周正文预览' : ready ? '已排满，可提交' : '尚未排满';
  weeklyScoreCaption.textContent = `${count} / 6 个行动已计入`;
  weeklyScoreboard.innerHTML = weeklyScoreMeta
    .map(([key, label, color]) => {
      const value = score[key];
      const visualValue = key === 'fatigue' || key === 'budget' ? Math.min(100, Math.abs(value)) : Math.min(100, Math.max(0, value));
      return `
        <div class="weekly-score-card">
          <div><span>${label}</span><strong>${formatSigned(value)}</strong></div>
          <div class="meter"><span style="width:${visualValue}%;background:${color}"></span></div>
        </div>
      `;
    })
    .join('');

  weeklyPlanSummary.innerHTML = `
    <div class="weekly-plan-summary__head"><span>行动清单</span><strong>${count}/6</strong></div>
    ${weekDays
      .map(day => {
        const slot = plan.slots[day.id];
        const action = getWeeklyAction(slot.actionId);
        return `<div class="weekly-plan-row ${slot.actionId ? 'is-planned' : ''}"><span>${day.label}</span><strong>${action ? escapeHtml(action.label) : '待安排'}</strong><em>${action ? escapeHtml(weeklyTargetLabel(slot)) : '—'}</em></div>`;
      })
      .join('')}
  `;

  weeklySubmitHint.textContent = plan.submitted
    ? '本周正文提示词已生成，可在下方展开查看。'
    : ready
      ? '六个行动已排满，现在可以把本周安排提交给正文生成。'
      : `请先安排${weekDays.length - count}个行动，未排满时不能提交正文。`;
  submitWeekButton.disabled = !ready || plan.submitted;
  submitWeekButton.textContent = plan.submitted ? '本周正文预览已提交' : '安排完成，提交本周正文';
  renderWeeklyPromptPreview();
}

function queueNarrativeCandidate(result: ReviewCandidate | null) {
  if (!result) return { status: 'ignored', reason: 'invalid_action' };
  state.reviewQueue.unshift(result);
  state.lastTriggerChain = result.triggerChain;
  render();
  return { status: 'queued', candidateId: result.id };
}

function applyHumanReview(decision?: ReviewDecision): Record<string, unknown> {
  const review = normalizeReviewDecision(decision);
  const candidate = state.reviewQueue[0];
  if (!candidate) return { status: 'empty_queue' };

  if (review.decision === 'reject') {
    state.reviewQueue.shift();
    state.lastTriggerChain = [...candidate.triggerChain, 'applyHumanReview(reject): discard project candidate'];
    render();
    return { status: 'rejected', candidateId: candidate.id };
  }

  if (review.decision === 'revise') {
    candidate.status = 'revision_requested';
    candidate.reviewNotes = review.notes;
    state.lastTriggerChain = [...candidate.triggerChain, 'applyHumanReview(revise): keep project candidate queued'];
    render();
    return { status: 'revision_requested', candidateId: candidate.id };
  }

  state.reviewQueue.shift();
  if (candidate.actionId === 'concept' && !state.project.created) {
    state.project.created = true;
    state.project.projectId = 'v07-second-project';
    state.project.title = '第二作';
    state.project.phase = '企划已建立';
  }
  applyProjectDeltas(state, candidate.projectDeltas);
  applyStaffDeltas(state, candidate.staffDeltas);
  state.project.phase = derivePhase({ ...state.project, phase: candidate.phase });
  state.turn += 1;

  if (candidate.opened.length) {
    const raw = buildLocalProposalRaw(candidate.opened, candidate.narrativeCandidate);
    evaluateProposalCycle({
      scenarioId: `action:${candidate.actionId}`,
      sceneText: candidate.narrativeCandidate,
      responses: [raw],
      rawAvailable: true,
    });
  }

  state.lastTriggerChain = [
    ...candidate.triggerChain,
    'applyHumanReview(approve): commit local project deltas',
    candidate.opened.length
      ? 'reviewPlotFlagProposal(): validate deterministic mock proposal before local signal write'
      : 'route proposal skipped: action has no story signal',
  ];
  render();
  return { status: 'approved', candidateId: candidate.id, routeSignals: exportRouteSignals() };
}

function normalizeReviewDecision(decision?: ReviewDecision): {
  decision: 'approve' | 'reject' | 'revise';
  notes: string;
} {
  if (!decision) return { decision: 'approve', notes: '' };
  if (typeof decision === 'string') return { decision, notes: '' };
  return { decision: decision.decision ?? 'approve', notes: decision.notes ?? '' };
}

function buildLocalProposalRaw(flagIds: string[], evidenceQuote: string): string {
  const deltas = flagIds.map(flagId => ({ flagId, value: 'yes', evidenceQuote }));
  return `<plot_flag_proposal>${JSON.stringify({ checked: true, deltas })}</plot_flag_proposal>`;
}

function evaluateProposalCycle(input: {
  scenarioId: string;
  sceneText: string;
  responses: string[];
  rawAvailable: boolean;
}): void {
  const prompts = buildPlotFlagProposalPrompts({
    machine: V07_PLOT_MACHINE,
    currentTime: `${state.currentDate} 16:00`,
    currentEventId: state.currentEventId,
    sceneText: input.sceneText,
    currentValues: state.storySignals,
  });
  let attempts = 0;
  let review: PlotFlagReviewResult | null = null;

  if (prompts.length && input.rawAvailable) {
    for (const response of input.responses.slice(0, 2)) {
      attempts += 1;
      review = reviewPlotFlagProposal(response, {
        machine: V07_PLOT_MACHINE,
        currentTime: `${state.currentDate} 16:00`,
        sceneText: input.sceneText,
        currentValues: state.storySignals,
      });
      if (review.status !== 'rejected') break;
    }
  }

  const writes: string[] = [];
  if (review?.status === 'accepted') {
    for (const delta of review.deltas) {
      state.storySignals[delta.flagId] = delta.value;
      state.evidence[delta.flagId] = delta.evidenceQuote;
      writes.push(`${delta.flagId}:${delta.value}`);
    }
  }

  const status: LabStatus = !prompts.length
    ? 'outside_window'
    : !input.rawAvailable
      ? 'unavailable'
      : review?.status === 'accepted'
        ? 'accepted'
        : review?.status === 'accepted_no_change'
          ? 'accepted_no_change'
          : 'needs_review';

  state.lab = {
    scenarioId: input.scenarioId,
    status,
    sceneText: input.sceneText,
    rawText: input.responses.join('\n\n--- repair ---\n\n'),
    rawAvailable: input.rawAvailable,
    promptRoles: prompts.map(prompt => prompt.role),
    attempts,
    review,
    writes,
  };
}

function runLabScenario(scenarioId: string): void {
  const scenario = getScenario(scenarioId);
  state.currentDate = labDate.value || scenario.date;
  evaluateProposalCycle({
    scenarioId: scenario.id,
    sceneText: scenario.sceneText,
    responses: scenario.responses,
    rawAvailable: scenario.rawAvailable,
  });
  state.lastTriggerChain = [
    `lab scenario: ${scenario.id}`,
    `proposal window: ${state.currentDate}`,
    state.lab.promptRoles.length
      ? `ordered prompt roles: ${state.lab.promptRoles.join(',')}`
      : 'prompt skipped by date window',
    `review result: ${state.lab.status}`,
    `local writes: ${state.lab.writes.join(', ') || 'none'}`,
  ];
  render();
}

function getScenario(scenarioId: string): LabScenario {
  return LAB_SCENARIOS.find(item => item.id === scenarioId) ?? LAB_SCENARIOS[0];
}

function prepareScenario(scenarioId: string): void {
  const scenario = getScenario(scenarioId);
  state.lab = {
    scenarioId: scenario.id,
    status: 'idle',
    sceneText: scenario.sceneText,
    rawText: scenario.responses.join('\n\n--- repair ---\n\n'),
    rawAvailable: scenario.rawAvailable,
    promptRoles: [],
    attempts: 0,
    review: null,
    writes: [],
  };
  state.currentDate = scenario.date;
  labDate.value = scenario.date;
  render();
}

function enterGame(): void {
  if (state.screen === 'play') return;
  state.screen = 'play';
  state.lastTriggerChain = ['PRESS ANY KEY -> enterGame(): start local game-development simulator'];
  render();
}

function showCover(): void {
  state.screen = 'cover';
  state.lastTriggerChain = ['showCover(): return to title screen'];
  render();
}

function setView(view: 'route' | 'development'): void {
  state.view = view;
  state.lastTriggerChain = [`local view: ${view}`, 'route choice and development planner remain separate preview surfaces'];
  render();
}

function resetState(): void {
  const screen = state.screen;
  state = clone(initialState);
  state.screen = screen;
  if (screen === 'play') state.lastTriggerChain = ['reset -> keep simulator screen'];
  labDate.value = state.currentDate;
  scenarioSelect.value = state.lab.scenarioId;
  render();
}

function exportRouteSignals(): PlotFlagDelta[] {
  return signalDefinitions
    .filter(signal => state.storySignals[signal.id] === 'yes')
    .map(signal => ({
      machineId: V07_PLOT_MACHINE.id,
      flagId: signal.id,
      storageKey: signal.storageKey,
      value: 'yes',
    }));
}

function resolveCurrentRoutes() {
  return resolvePlotRoutes(V07_PLOT_MACHINE, state.storySignals, state.localChoice);
}

function renderRoutePage(): void {
  const resolution = resolveCurrentRoutes();
  const insideDecisionWindow = isPlotDateInWindow(state.currentDate, V07_PLOT_MACHINE.promptWindow);
  const eligibleCount = resolution.eligibleRouteIds.length;
  routeWindowLabel.textContent = `${V07_PLOT_MACHINE.promptWindow.start} → ${V07_PLOT_MACHINE.promptWindow.end}`;
  routeWindowNote.textContent = insideDecisionWindow
    ? `当前日期 ${state.currentDate} 在路线判断窗口内，${eligibleCount} 条路线满足当前事实。`
    : `当前日期 ${state.currentDate} 不在路线判断窗口内，choice 不能提交。`;
  routePageStatus.textContent = resolution.choice
    ? `已锁定：${V07_PLOT_MACHINE.routes.find(route => route.id === resolution.choice)?.label ?? resolution.choice}`
    : '尚未锁定路线';
  routePageStatus.className = `route-page-status ${resolution.choice ? 'is-locked' : ''}`;
  routeEvidencePage.innerHTML = signalDefinitions
    .map(signal => {
      const value = state.storySignals[signal.id];
      const evidence = state.evidence[signal.id];
      return `
        <article class="route-evidence-row ${value === 'yes' ? 'is-confirmed' : ''}">
          <div>
            <strong>${escapeHtml(signal.label)}</strong>
            <small>${escapeHtml(signal.id)} · 最早 ${escapeHtml(signal.earliestDate)}</small>
            ${evidence ? `<p>证据：${escapeHtml(evidence)}</p>` : `<p>${escapeHtml(signal.noMeaning)}</p>`}
          </div>
          <span>${value === 'yes' ? '已确认' : '待确认'}</span>
        </article>
      `;
    })
    .join('');
}

function confirmLocalRoute(routeId: PlotRouteId, skipDialog = false): boolean {
  const confirmation = confirmPlotRouteChoice({
    machine: V07_PLOT_MACHINE,
    currentTime: state.currentDate,
    flagValues: state.storySignals,
    storedChoice: state.localChoice,
    routeId,
    source: 'manual',
  });
  if (confirmation.status === 'rejected') return false;
  if (confirmation.status === 'unchanged') return true;

  const route = confirmation.resolution.routes.find(item => item.id === routeId);
  if (!route) return false;
  if (!skipDialog && !window.confirm(`仅在本地预览中确认「${route.label}」路线？此操作不写生产 memoryDB。`)) return false;
  state.localChoice = confirmation.commit.receipt;
  state.lastTriggerChain = [
    `local route click: ${routeId}`,
    'confirmPlotRouteChoice(): verify manual source, date, eligibility, and lock',
    'local choice only: no memoryDB write',
  ];
  render();
  return true;
}

function renderProject(): void {
  byId<HTMLElement>('project-title').textContent = state.project.title;
  byId<HTMLElement>('game-title').textContent = state.project.title;
  byId<HTMLElement>('game-genre').textContent = state.project.genre;
  byId<HTMLElement>('game-theme').textContent = state.project.theme;
  byId<HTMLElement>('game-platform').textContent = state.project.platform;
  byId<HTMLElement>('dev-phase').textContent = state.project.phase;
  byId<HTMLElement>('deadline-left').textContent = `${state.project.weeksLeft} 周`;
  byId<HTMLElement>('project-state-badge').textContent = state.project.created
    ? '项目已建立 · “定企划”已关闭'
    : '尚未建立项目 · 先完成“定企划”';
  byId<HTMLElement>('current-date-label').textContent = `${state.currentDate} / after school`;
}

function renderMetrics(): void {
  metricGrid.innerHTML = metricMeta
    .map(([key, label, color]) => {
      const value = state.project[key];
      const percent = key === 'budget' ? Math.min(100, value / 2) : value;
      return `
        <div class="metric-card">
          <div class="metric-card__head"><span>${label}</span><strong>${value}</strong></div>
          <div class="meter"><span style="width:${percent}%;background:${color}"></span></div>
        </div>
      `;
    })
    .join('');
}

function renderStaff(): void {
  staffList.innerHTML = Object.values(state.staff)
    .map(
      staff => `
        <div class="staff-row">
          <strong>${escapeHtml(staff.name)}</strong>
          <span>${escapeHtml(staff.role)}</span>
          <em>${staff.skill}/${staff.morale}</em>
        </div>
      `,
    )
    .join('');
}

function renderActions(): void {
  actionGrid.innerHTML = actions
    .map(
      action => {
        const projectCreationClosed = action.id === 'concept' && state.project.created;
        return `
        <button class="action-button ${projectCreationClosed ? 'is-disabled' : ''}" type="button" data-action-id="${action.id}" id="act-${action.id}" ${projectCreationClosed ? 'disabled' : ''}>
          <strong>${escapeHtml(action.label)}</strong>
          <span>${escapeHtml(projectCreationClosed ? '项目已建立：无需再次定企划' : action.hint)}</span>
        </button>
      `;
      },
    )
    .join('');
}

function renderCandidate(): void {
  const candidate = state.reviewQueue[0];
  if (!candidate) {
    candidateBox.innerHTML = '暂无候选。开发行动先进入 Review，项目数值获批后才进入本地剧情事实校验。';
    return;
  }
  const signalText = candidate.opened.length ? candidate.opened.join(' / ') : '无剧情事实';
  candidateBox.innerHTML = `
    <strong>${escapeHtml(candidate.actionLabel)}</strong>
    <p>${escapeHtml(candidate.narrativeCandidate)}</p>
    <p>项目变化：${escapeHtml(formatDeltas(candidate.projectDeltas))}</p>
    <p>候选事实：${escapeHtml(signalText)}</p>
    <p>状态：${candidate.status}</p>
  `;
}

function renderStorySignals(): void {
  storySignalList.innerHTML = signalDefinitions
    .map(signal => {
      const value = state.storySignals[signal.id] ?? 'unset';
      const evidence = state.evidence[signal.id];
      return `
        <div class="story-signal story-signal--${value}">
          <div>
            <strong>${escapeHtml(signal.label)}</strong>
            <small>${escapeHtml(signal.id)}</small>
            ${evidence ? `<p>证据：${escapeHtml(evidence)}</p>` : ''}
          </div>
          <span>${value}</span>
        </div>
      `;
    })
    .join('');
}

function renderRouteResolution(): void {
  const resolution = resolveCurrentRoutes();
  const insideDecisionWindow = isPlotDateInWindow(state.currentDate, V07_PLOT_MACHINE.promptWindow);
  routeResolutionList.innerHTML = resolution.routes
    .map(route => {
      const selected = resolution.choice === route.id;
      const canChoose = route.eligible && insideDecisionWindow && !state.localChoice;
      return `
        <article class="route-result ${route.eligible ? 'is-eligible' : ''} ${selected ? 'is-selected' : ''}">
          <div>
            <span>${route.eligible ? '可选' : '未满足'}</span>
            <strong>${escapeHtml(route.label)}</strong>
          </div>
          <p>${route.missingFlagIds.length ? `缺少：${escapeHtml(route.missingFlagIds.join(' / '))}` : '全部必要事实已为 yes'}</p>
          ${
            canChoose
              ? `<button type="button" data-route-choice="${route.id}">本地确认</button>`
              : selected
                ? '<em>本地 choice 已锁定</em>'
                : ''
          }
        </article>
      `;
    })
    .join('');
}

function renderLab(): void {
  const errorText =
    state.lab.review?.status === 'rejected'
      ? state.lab.review.errors.map(error => `${error.code}: ${error.message}`).join('\n')
      : state.lab.review
        ? `status: ${state.lab.review.status}\nvalidated deltas: ${state.lab.review.deltas.length}`
        : state.lab.status === 'unavailable'
          ? 'generateRaw unavailable：路线审查未运行，零写入。'
          : state.lab.status === 'outside_window'
            ? '日期不在 proposalWindow：prompt 未生成，零写入。'
            : '尚未运行。';
  labStatus.textContent = labStatusLabel(state.lab.status);
  labStatus.className = `lab-status lab-status--${state.lab.status}`;
  labScene.textContent = state.lab.sceneText;
  labRaw.textContent = state.lab.rawText || '无响应';
  labReview.textContent = [
    `simulated raw capability: ${state.lab.rawAvailable ? 'generateRaw' : 'unavailable'}`,
    `ordered roles: ${state.lab.promptRoles.join(' -> ') || 'none'}`,
    `attempts: ${state.lab.attempts}`,
    errorText,
  ].join('\n');
  labWrite.textContent = state.lab.writes.length
    ? `本地模拟写入：\n${state.lab.writes.join('\n')}`
    : '本地模拟写入：none';
}

function renderScenarioOptions(): void {
  const isPreset = LAB_SCENARIOS.some(scenario => scenario.id === state.lab.scenarioId);
  const actionOption = isPreset
    ? ''
    : `<option value="${escapeHtml(state.lab.scenarioId)}">当前行动提案：${escapeHtml(state.lab.scenarioId.replace(/^action:/, ''))}</option>`;
  scenarioSelect.innerHTML = `${actionOption}${LAB_SCENARIOS.map(
    scenario => `<option value="${scenario.id}">${escapeHtml(scenario.label)}</option>`,
  ).join('')}`;
  scenarioSelect.value = state.lab.scenarioId;
}

function labStatusLabel(status: LabStatus): string {
  const labels: Record<LabStatus, string> = {
    idle: '等待运行',
    accepted: '校验通过',
    accepted_no_change: '已检查，无变化',
    needs_review: 'needs_review',
    outside_window: '窗口外',
    unavailable: 'generateRaw 不可用',
  };
  return labels[status];
}

function drawCanvas(): void {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#fbfcff';
  ctx.fillRect(0, 0, width, height);
  drawGrid();
  drawBarTrack(56, 70, width - 112, '开发进度', state.project.progress, '#1f7a8c');
  drawBarTrack(56, 135, width - 112, '质量总和', qualityScore(), '#2f855a');
  drawBarTrack(56, 200, width - 112, 'Bug 压力', state.project.bugs, '#b42318');
  ctx.fillStyle = '#17202a';
  ctx.font = '700 22px "Segoe UI", sans-serif';
  ctx.fillText(state.project.title, 56, 36);
  ctx.font = '14px "Segoe UI", sans-serif';
  ctx.fillStyle = '#667085';
  ctx.fillText(`${state.project.genre} / ${state.project.theme}`, 56, height - 34);
}

function drawGrid(): void {
  ctx.strokeStyle = 'rgba(23,32,42,0.06)';
  for (let x = 40; x < canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 40; y < canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function drawBarTrack(x: number, y: number, width: number, label: string, value: number, color: string): void {
  const clamped = clamp(value);
  ctx.fillStyle = '#17202a';
  ctx.font = '700 15px "Segoe UI", sans-serif';
  ctx.fillText(`${label} ${clamped}`, x, y - 14);
  ctx.fillStyle = 'rgba(105,115,134,0.16)';
  roundRect(x, y, width, 28, 8);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(x, y, (width * clamped) / 100, 28, 8);
  ctx.fill();
}

function qualityScore(): number {
  const project = state.project;
  return clamp((project.fun + project.creativity + project.writing + project.art + project.code + project.polish) / 6);
}

function roundRect(x: number, y: number, width: number, height: number, radiusInput: number): void {
  const radius = Math.min(radiusInput, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function render(): void {
  coverScreen.classList.toggle('is-hidden', state.screen !== 'cover');
  gameScreen.classList.toggle('is-hidden', state.screen !== 'play');
  routeScreen.classList.toggle('is-hidden', state.view !== 'route');
  developmentView.classList.toggle('is-hidden', state.view !== 'development');
  document.querySelectorAll<HTMLElement>('.view-tab').forEach(button => {
    button.classList.toggle('is-selected', button.dataset.view === state.view);
  });
  renderScenarioOptions();
  labDate.value = state.currentDate;
  renderProject();
  renderRoutePage();
  renderWeeklyPlanner();
  renderMetrics();
  renderStaff();
  renderActions();
  renderCandidate();
  renderStorySignals();
  renderRouteResolution();
  renderLab();
  drawCanvas();
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen();
}

document.addEventListener('keydown', event => {
  if (state.screen === 'cover') {
    enterGame();
    return;
  }
  if (event.key.toLowerCase() === 'f' && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault();
    void toggleFullscreen();
  }
});

document.addEventListener('pointerdown', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (state.screen === 'cover') {
    enterGame();
    return;
  }
  const viewButton = target.closest<HTMLElement>('[data-view]');
  if (viewButton?.dataset.view) {
    setView(viewButton.dataset.view as 'route' | 'development');
    return;
  }
  const weekRouteButton = target.closest<HTMLElement>('[data-week-route]');
  if (weekRouteButton?.dataset.weekRoute) {
    setWeeklyRoute(weekRouteButton.dataset.weekRoute as WeeklyRouteMode);
    return;
  }
  const weekDayTab = target.closest<HTMLElement>('[data-week-day]');
  if (weekDayTab?.dataset.weekDay) {
    selectWeeklyDay(weekDayTab.dataset.weekDay as WeekdayId);
    return;
  }
  const weekActionButton = target.closest<HTMLElement>('[data-week-action-id]');
  if (weekActionButton?.dataset.weekActionId) {
    assignWeeklyAction(weekActionButton.dataset.weekActionId);
    return;
  }
  const actionButton = target.closest<HTMLElement>('[data-action-id]');
  if (actionButton?.dataset.actionId) {
    queueNarrativeCandidate(settlePlayerAction({ actionId: actionButton.dataset.actionId }));
    return;
  }
  const routeButton = target.closest<HTMLElement>('[data-route-choice]');
  if (routeButton?.dataset.routeChoice) {
    confirmLocalRoute(routeButton.dataset.routeChoice as PlotRouteId);
    return;
  }
  if (target.closest('#cover-btn')) showCover();
  if (target.closest('#review-btn')) applyHumanReview();
  if (target.closest('#reset-btn')) resetState();
  if (target.closest('#run-lab-btn')) runLabScenario(scenarioSelect.value);
  if (target.closest('#submit-week-btn')) submitWeeklyPlan();
});

scenarioSelect.addEventListener('change', () => prepareScenario(scenarioSelect.value));
weekTargetSelect.addEventListener('change', () => {
  const slot = state.weeklyPlan.slots[state.weeklyPlan.selectedDay];
  slot.targetId = weekTargetSelect.value || null;
  invalidateWeeklySubmission();
  render();
});
weekIntent.addEventListener('input', () => {
  const slot = state.weeklyPlan.slots[state.weeklyPlan.selectedDay];
  slot.intent = weekIntent.value;
  if (state.weeklyPlan.submitted) {
    invalidateWeeklySubmission();
    weeklyStatusLabel.textContent = isWeeklyPlanReady() ? '已排满，可提交' : '尚未排满';
    weeklySubmitHint.textContent = isWeeklyPlanReady()
      ? '行动说明已修改，需要重新提交本周正文。'
      : `请先安排${weekDays.length - weeklyPlanCount()}个行动，未排满时不能提交正文。`;
    submitWeekButton.disabled = !isWeeklyPlanReady();
    submitWeekButton.textContent = '安排完成，提交本周正文';
    weeklyNarrativePreview.classList.add('is-hidden');
  }
  renderWeeklyPromptPreview();
});
labDate.addEventListener('change', () => {
  state.currentDate = labDate.value;
  render();
});

window.gameDevelopPreview = {
  loadGameDevelopState: () => clone(state),
  settlePlayerAction,
  queueNarrativeCandidate,
  applyHumanReview,
  exportRouteSignals,
  enterGame,
  showCover,
  setView,
  runLabScenario,
  confirmLocalRoute,
  submitWeeklyPlan,
};

window.render_game_to_text = () => {
  const resolution = resolveCurrentRoutes();
  return JSON.stringify({
    screen: 'gamedevelop-preview',
    phase: state.screen,
    view: state.view,
    connectionStatus: '只是本地状态演示',
    note: 'No SillyTavern generation, memoryDB write, host floor, or plugin hook is connected.',
    currentDate: state.currentDate,
    currentEventId: state.currentEventId,
    turn: state.turn,
    weeklyPlan: {
      routeMode: state.weeklyPlan.routeMode,
      week: state.weeklyPlan.week,
      selectedDay: state.weeklyPlan.selectedDay,
      submitted: state.weeklyPlan.submitted,
      slots: state.weeklyPlan.slots,
      score: weeklyScore(),
    },
    project: state.project,
    storySignals: Object.fromEntries(
      signalDefinitions.map(signal => [signal.id, state.storySignals[signal.id] ?? 'unset']),
    ),
    pendingReview: state.reviewQueue[0]
      ? {
          action: state.reviewQueue[0].actionLabel,
          opened: state.reviewQueue[0].opened,
          status: state.reviewQueue[0].status,
        }
      : null,
    pipeline: {
      scenarioId: state.lab.scenarioId,
      status: state.lab.status,
      rawAvailable: state.lab.rawAvailable,
      promptRoles: state.lab.promptRoles,
      attempts: state.lab.attempts,
      writes: state.lab.writes,
      errors: state.lab.review?.status === 'rejected' ? state.lab.review.errors.map(error => error.code) : [],
    },
    routeResolution: resolution,
    routeSignals: exportRouteSignals(),
    lastTriggerChain: state.lastTriggerChain,
  });
};

window.advanceTime = (ms: number) => {
  const steps = Math.max(1, Math.round(ms / 100));
  for (let i = 0; i < steps; i += 1) {
    // No animated simulation state yet; this keeps browser tests deterministic.
  }
  render();
};

render();
