import { isPlotDateInWindow } from '../plot-state-machine/date-window';
import { confirmPlotRouteChoice } from '../plot-state-machine/choice';
import { buildPlotFlagProposalPrompts } from '../plot-state-machine/proposal-prompt';
import { reviewPlotFlagProposal } from '../plot-state-machine/proposal';
import { resolvePlotRoutes } from '../plot-state-machine/resolver';
import type { PlotFlagReviewResult, PlotFlagValue, PlotFlagValueMap } from '../plot-state-machine/types';
import { V07_PLOT_MACHINE } from '../plot-state-machine/v07';
import { runSecondaryTask } from '../secondary-api';
import type { TavernWindow } from '../types';

declare const process: {
  argv: string[];
  exitCode?: number;
};

type TraceRow = {
  case: string;
  date: string;
  rawAvailable: boolean;
  promptCount: number;
  attempts: number;
  review: string;
  writes: string[];
  eligible: string[];
  choice: string | null;
};

type MockRawConfig = {
  should_silence?: boolean;
  should_stream?: boolean;
  ordered_prompts?: Array<{ role: string; content: string }>;
};

const traces: TraceRow[] = [];
let assertionCount = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertionCount += 1;
  if (!condition) throw new Error(message);
}

function proposal(deltas: Array<{ flagId: string; value: PlotFlagValue; evidenceQuote: string }>): string {
  return `<plot_flag_proposal>${JSON.stringify({ checked: true, deltas })}</plot_flag_proposal>`;
}

function applyAccepted(values: Record<string, PlotFlagValue | undefined>, review: PlotFlagReviewResult): string[] {
  if (review.status === 'rejected') return [];
  for (const delta of review.deltas) values[delta.flagId] = delta.value;
  return review.deltas.map(delta => `${delta.flagId}:${delta.value}`);
}

async function runRawReview(input: {
  name: string;
  date: string;
  scene: string;
  responses: string[];
  values?: Record<string, PlotFlagValue | undefined>;
  storedChoice?: string | null;
  rawAvailable?: boolean;
}): Promise<{
  review: PlotFlagReviewResult | null;
  values: Record<string, PlotFlagValue | undefined>;
  reviewStatus: string;
}> {
  const values = { ...(input.values ?? {}) };
  const prompts = buildPlotFlagProposalPrompts({
    machine: V07_PLOT_MACHINE,
    currentTime: `${input.date} 16:00`,
    currentEventId: 'SAE_07-8',
    sceneText: input.scene,
    currentValues: values,
  });
  const rawAvailable = input.rawAvailable ?? true;
  let attempts = 0;
  let review: PlotFlagReviewResult | null = null;

  if (prompts.length && rawAvailable) {
    for (const response of input.responses.slice(0, 2)) {
      attempts += 1;
      const win = {
        generateRaw: async (config: MockRawConfig) => {
          assert(config.should_silence === true, `${input.name}: generateRaw 必须静默`);
          assert(config.should_stream === false, `${input.name}: generateRaw 不得流式`);
          assert(
            config.ordered_prompts?.map(item => item.role).join(',') === 'system,user',
            `${input.name}: prompt 角色顺序错误`,
          );
          return response;
        },
      } as unknown as TavernWindow;
      const raw = await runSecondaryTask({
        win,
        kind: 'custom',
        generationId: `v07-simulation-${input.name}-${attempts}`,
        prompts,
        apiConfig: null,
      });
      review = reviewPlotFlagProposal(raw, {
        machine: V07_PLOT_MACHINE,
        currentTime: `${input.date} 16:00`,
        sceneText: input.scene,
        currentValues: values,
      });
      if (review.status !== 'rejected') break;
    }
  }

  const writes = review ? applyAccepted(values, review) : [];
  const reviewStatus =
    review?.status === 'rejected' && attempts >= 2
      ? 'needs_review'
      : (review?.status ?? (prompts.length ? 'unavailable' : 'outside_window'));
  const resolution = resolvePlotRoutes(V07_PLOT_MACHINE, values, input.storedChoice);
  traces.push({
    case: input.name,
    date: input.date,
    rawAvailable,
    promptCount: prompts.length,
    attempts,
    review: reviewStatus,
    writes,
    eligible: resolution.eligibleRouteIds,
    choice: resolution.choice,
  });
  return { review, values, reviewStatus };
}

async function main() {
  const knownFlagIds = new Set(V07_PLOT_MACHINE.flags.map(flag => flag.id));
  assert(
    V07_PLOT_MACHINE.routes.every(route => route.requiredFlagIds.every(flagId => knownFlagIds.has(flagId))),
    '每条路线的 requiredFlagIds 都必须引用真实 flag',
  );
  assert(!isPlotDateInWindow('2013-02-24', V07_PLOT_MACHINE.proposalWindow), 'proposal 下界前必须关闭');
  assert(isPlotDateInWindow('2013-02-25', V07_PLOT_MACHINE.proposalWindow), 'proposal 下界必须包含');
  assert(isPlotDateInWindow('2013-03-31', V07_PLOT_MACHINE.proposalWindow), 'proposal 上界必须包含');
  assert(!isPlotDateInWindow('2013-04-01', V07_PLOT_MACHINE.proposalWindow), 'proposal 上界后必须关闭');
  assert(!isPlotDateInWindow('2013-03-03', V07_PLOT_MACHINE.promptWindow), '主 prompt 下界前必须关闭');
  assert(isPlotDateInWindow('2013-03-04', V07_PLOT_MACHINE.promptWindow), '主 prompt 下界必须包含');
  assert(isPlotDateInWindow('2013-03-31', V07_PLOT_MACHINE.promptWindow), '主 prompt 上界必须包含');
  assert(!isPlotDateInWindow('2013-04-01', V07_PLOT_MACHINE.promptWindow), '主 prompt 上界后必须关闭');

  const beforeWindow = await runRawReview({
    name: 'before-window-event-cannot-bypass',
    date: '2013-02-24',
    scene: '即使事件名写着 SAE_07-8，也不能绕过日期。',
    responses: [proposal([])],
  });
  assert(beforeWindow.review === null, '窗口外不能运行提案审查');

  const empty = await runRawReview({
    name: 'checked-empty',
    date: '2013-02-25',
    scene: '本轮只有普通的放学对话，没有任何路线事实变化。',
    responses: [proposal([])],
  });
  assert(empty.review?.status === 'accepted_no_change', 'checked 空提案必须是合法 no-op');

  const sameValue = await runRawReview({
    name: 'same-value-noop',
    date: '2013-02-26',
    scene: '第二作企划初稿仍然足以成为实际行动的基础。',
    values: { second_project_seed_ready: 'yes' },
    responses: [
      proposal([
        {
          flagId: 'second_project_seed_ready',
          value: 'yes',
          evidenceQuote: '第二作企划初稿仍然足以成为实际行动的基础',
        },
      ]),
    ],
  });
  assert(sameValue.review?.status === 'accepted_no_change', '同值提案必须是合法 no-op');
  assert(sameValue.values.second_project_seed_ready === 'yes', '同值 no-op 不得改变既有事实');

  const upgraded = await runRawReview({
    name: 'no-to-yes-upgrade',
    date: '2013-02-26',
    scene: '第二作企划初稿已经补全，现在足以成为实际行动的基础。',
    values: { second_project_seed_ready: 'no' },
    responses: [
      proposal([
        {
          flagId: 'second_project_seed_ready',
          value: 'yes',
          evidenceQuote: '第二作企划初稿已经补全，现在足以成为实际行动的基础',
        },
      ]),
    ],
  });
  assert(upgraded.review?.status === 'accepted', 'no 到 yes 的升级必须允许');
  assert(upgraded.values.second_project_seed_ready === 'yes', 'no 到 yes 必须产生写入');

  const flagDateLocked = await runRawReview({
    name: 'flag-earliest-date-locked',
    date: '2013-02-25',
    scene: '第二作企划初稿提前完成，已经足以成为实际行动的基础。',
    responses: [
      proposal([
        {
          flagId: 'second_project_seed_ready',
          value: 'yes',
          evidenceQuote: '第二作企划初稿提前完成，已经足以成为实际行动的基础',
        },
      ]),
    ],
  });
  assert(
    flagDateLocked.review?.status === 'rejected' &&
      flagDateLocked.review.errors.some(error => error.code === 'flag_date_locked'),
    '早于 flag earliestDate 的提案必须整批拒绝',
  );
  assert(Object.keys(flagDateLocked.values).length === 0, '过早 flag 必须零写入');

  const repaired = await runRawReview({
    name: 'repair-once',
    date: '2013-02-26',
    scene: 'User 把第二作企划初稿放到桌上，内容已经足以成为实际行动的基础。',
    responses: [
      '漏掉标签的错误响应',
      proposal([
        {
          flagId: 'second_project_seed_ready',
          value: 'yes',
          evidenceQuote: '第二作企划初稿放到桌上，内容已经足以成为实际行动的基础',
        },
      ]),
    ],
  });
  assert(repaired.review?.status === 'accepted', '一次 repair 后应接受合法提案');
  assert(repaired.values.second_project_seed_ready === 'yes', 'repair 成功后应产生本地模拟写入');

  const unknown = await runRawReview({
    name: 'unknown-choice-injection',
    date: '2013-03-04',
    scene: 'User 明确说要把团队留下。',
    responses: [
      proposal([{ flagId: 'plotRoute.v07.choice', value: 'yes', evidenceQuote: 'User 明确说要把团队留下' }]),
      proposal([{ flagId: 'stay_route_viable', value: 'yes', evidenceQuote: 'User 明确说要把团队留下' }]),
    ],
  });
  assert(unknown.review?.status === 'rejected', '未知 flag 与 choice 注入必须连续失败');
  assert(unknown.reviewStatus === 'needs_review', '连续两次失败必须升级为 needs_review');
  assert(Object.keys(unknown.values).length === 0, '连续失败必须整批零写入');

  const contradictory = await runRawReview({
    name: 'duplicate-contradiction',
    date: '2013-03-04',
    scene: '第二作企划已经可以执行，但本轮也有人声称它还只是空话。',
    responses: [
      proposal([
        { flagId: 'second_project_seed_ready', value: 'yes', evidenceQuote: '第二作企划已经可以执行' },
        { flagId: 'second_project_seed_ready', value: 'no', evidenceQuote: '它还只是空话' },
      ]),
    ],
  });
  assert(contradictory.review?.status === 'rejected', '同批重复矛盾 flag 必须拒绝');

  const fakeEvidence = await runRawReview({
    name: 'fake-evidence',
    date: '2013-03-04',
    scene: '本轮只讨论天气。',
    responses: [proposal([{ flagId: 'solo_route_open', value: 'yes', evidenceQuote: 'User 决定独立制作自己的游戏' }])],
  });
  assert(fakeEvidence.review?.status === 'rejected', '伪造正文证据必须拒绝');

  const shortEvidence = await runRawReview({
    name: 'short-evidence',
    date: '2013-03-04',
    scene: 'User 说：单飞。',
    responses: [proposal([{ flagId: 'solo_route_open', value: 'yes', evidenceQuote: '单飞' }])],
  });
  assert(shortEvidence.review?.status === 'rejected', '少于四个可见字符的证据必须拒绝');

  const latched = await runRawReview({
    name: 'latched-yes',
    date: '2013-03-04',
    scene: '有人提出第二作现在还不能执行。',
    values: { second_project_seed_ready: 'yes' },
    responses: [
      proposal([{ flagId: 'second_project_seed_ready', value: 'no', evidenceQuote: '第二作现在还不能执行' }]),
    ],
  });
  assert(latched.review?.status === 'rejected', 'yes 闩锁不能被 AI 清除');

  const unavailable = await runRawReview({
    name: 'generate-only-no-route-write',
    date: '2013-03-04',
    scene: 'User 决定独立推进自己的创作路线。',
    responses: [proposal([{ flagId: 'solo_route_open', value: 'yes', evidenceQuote: '独立推进自己的创作路线' }])],
    rawAvailable: false,
  });
  assert(unavailable.review === null, '没有 generateRaw 时不得进入路线审查');
  assert(Object.keys(unavailable.values).length === 0, '没有 generateRaw 时必须零路线写入');

  const allRouteValues: Record<string, PlotFlagValue | undefined> = {
    megumi_coplanner: 'yes',
    second_project_seed_ready: 'yes',
    blackgold_counterwill: 'yes',
    eriri_high_battlefield_supported: 'yes',
    utaha_author_pride_supported: 'yes',
    akane_pressure_seen: 'yes',
    akane_route_open: 'yes',
    solo_route_open: 'yes',
  };
  const stayOnly = resolvePlotRoutes(V07_PLOT_MACHINE, {
    megumi_coplanner: 'yes',
    second_project_seed_ready: 'yes',
    blackgold_counterwill: 'yes',
    eriri_high_battlefield_supported: 'yes',
    utaha_author_pride_supported: 'yes',
  });
  assert(stayOnly.eligibleRouteIds.join(',') === 'stay', '只有留下条件齐全时必须仅 stay 可行');

  const akaneOnly = resolvePlotRoutes(V07_PLOT_MACHINE, {
    akane_pressure_seen: 'yes',
    akane_route_open: 'yes',
  });
  assert(akaneOnly.eligibleRouteIds.join(',') === 'akane', '只有朱音条件齐全时必须仅 akane 可行');

  const soloOnly = resolvePlotRoutes(V07_PLOT_MACHINE, { solo_route_open: 'yes' });
  assert(soloOnly.eligibleRouteIds.join(',') === 'solo', '只有单飞条件齐全时必须仅 solo 可行');

  const allRoutes = resolvePlotRoutes(V07_PLOT_MACHINE, allRouteValues as PlotFlagValueMap);
  assert(allRoutes.eligibleRouteIds.join(',') === 'stay,akane,solo', '三条 eligibility 必须能同时成立');
  assert(allRoutes.choice === null, '没有玩家 choice 时 resolver 不得自动选择');
  const chosenAkane = resolvePlotRoutes(V07_PLOT_MACHINE, allRouteValues, 'akane');
  assert(chosenAkane.choice === 'akane', '合法玩家 choice 应被读取');
  const invalidChoice = resolvePlotRoutes(V07_PLOT_MACHINE, { solo_route_open: 'yes' }, 'stay');
  assert(
    invalidChoice.choice === null && invalidChoice.rejectedChoice === 'stay',
    '不满足 eligibility 的 choice 必须按未确认处理',
  );

  const aiChoice = confirmPlotRouteChoice({
    machine: V07_PLOT_MACHINE,
    currentTime: '2013-03-04',
    flagValues: allRouteValues,
    routeId: 'stay',
    source: 'ai',
  });
  assert(aiChoice.status === 'rejected' && aiChoice.error.code === 'not_manual', 'AI choice 不能进入确认提交');

  const earlyChoice = confirmPlotRouteChoice({
    machine: V07_PLOT_MACHINE,
    currentTime: '2013-03-03',
    flagValues: allRouteValues,
    routeId: 'stay',
    source: 'manual',
  });
  assert(
    earlyChoice.status === 'rejected' && earlyChoice.error.code === 'outside_choice_window',
    '确认窗开始前不得选择路线',
  );

  const ineligibleChoice = confirmPlotRouteChoice({
    machine: V07_PLOT_MACHINE,
    currentTime: '2013-03-04',
    flagValues: { solo_route_open: 'yes' },
    routeId: 'stay',
    source: 'manual',
  });
  assert(
    ineligibleChoice.status === 'rejected' && ineligibleChoice.error.code === 'route_not_eligible',
    '缺少路线事实时不得确认',
  );

  const acceptedChoice = confirmPlotRouteChoice({
    machine: V07_PLOT_MACHINE,
    currentTime: '2013-03-04',
    flagValues: allRouteValues,
    routeId: 'stay',
    source: 'manual',
  });
  assert(acceptedChoice.status === 'accepted' && acceptedChoice.choice === 'stay', '玩家应能确认当前可行路线');
  assert(
    acceptedChoice.status === 'accepted' &&
      acceptedChoice.commit.targetId === 'route:v07' &&
      acceptedChoice.commit.key === 'plotRoute.v07.choice' &&
      acceptedChoice.commit.valueType === 'string' &&
      acceptedChoice.commit.source === 'manual',
    'choice commit 必须符合 attributes 存储契约',
  );

  const unchangedChoice = confirmPlotRouteChoice({
    machine: V07_PLOT_MACHINE,
    currentTime: '2013-03-31',
    flagValues: allRouteValues,
    storedChoice: 'stay',
    routeId: 'stay',
    source: 'manual',
  });
  assert(unchangedChoice.status === 'unchanged' && unchangedChoice.commit === null, '重复确认同一路线必须是 no-op');

  const lockedChoice = confirmPlotRouteChoice({
    machine: V07_PLOT_MACHINE,
    currentTime: '2013-03-31',
    flagValues: allRouteValues,
    storedChoice: 'stay',
    routeId: 'akane',
    source: 'manual',
  });
  assert(
    lockedChoice.status === 'rejected' && lockedChoice.error.code === 'choice_locked' && lockedChoice.choice === 'stay',
    '已有不同 choice 时必须拒绝覆盖',
  );

  const replaceInvalidStoredChoice = confirmPlotRouteChoice({
    machine: V07_PLOT_MACHINE,
    currentTime: '2013-03-31',
    flagValues: { solo_route_open: 'yes' },
    storedChoice: 'stay',
    routeId: 'solo',
    source: 'manual',
  });
  assert(
    replaceInvalidStoredChoice.status === 'accepted' && replaceInvalidStoredChoice.choice === 'solo',
    '不再可行的旧 choice 必须按未确认处理',
  );

  traces.push({
    case: 'manual-choice-confirmed',
    date: '2013-03-04',
    rawAvailable: true,
    promptCount: 2,
    attempts: 0,
    review: acceptedChoice.status,
    writes: acceptedChoice.status === 'accepted' ? [`${acceptedChoice.commit.key}:${acceptedChoice.commit.value}`] : [],
    eligible: acceptedChoice.resolution.eligibleRouteIds,
    choice: acceptedChoice.choice,
  });
  traces.push({
    case: 'choice-locked',
    date: '2013-03-31',
    rawAvailable: true,
    promptCount: 2,
    attempts: 0,
    review: lockedChoice.error.code,
    writes: [],
    eligible: lockedChoice.resolution.eligibleRouteIds,
    choice: lockedChoice.choice,
  });

  const choiceAfterWindow = resolvePlotRoutes(V07_PLOT_MACHINE, allRouteValues, 'solo');
  traces.push({
    case: 'choice-persists-prompt-off',
    date: '2013-04-01',
    rawAvailable: true,
    promptCount: buildPlotFlagProposalPrompts({
      machine: V07_PLOT_MACHINE,
      currentTime: '2013-04-01 09:00',
      sceneText: '窗口已经结束。',
      currentValues: allRouteValues,
    }).length,
    attempts: 0,
    review: 'outside_window',
    writes: [],
    eligible: choiceAfterWindow.eligibleRouteIds,
    choice: choiceAfterWindow.choice,
  });
  assert(choiceAfterWindow.choice === 'solo', '窗口结束后 choice 仍应可由代码读取');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ assertionCount, traces }, null, 2));
  } else {
    console.table(traces);
    console.log(`v07 simulation passed: ${assertionCount} assertions`);
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
