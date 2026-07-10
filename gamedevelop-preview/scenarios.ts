import type { PlotFlagValue } from '../plot-state-machine/types';

export type LabScenario = {
  id: string;
  label: string;
  date: string;
  sceneText: string;
  responses: string[];
  rawAvailable: boolean;
};

type ProposalDelta = {
  flagId: string;
  value: PlotFlagValue;
  evidenceQuote: string;
};

function proposal(deltas: ProposalDelta[]): string {
  return `<plot_flag_proposal>${JSON.stringify({ checked: true, deltas })}</plot_flag_proposal>`;
}

const stayScene = [
  'User 把第二作企划初稿摊在桌上，这已经足够成为实际行动的基础。',
  '惠接过排期表，以共同企划和副代表的身份拥有否决与纠正权。',
  'User 给英梨梨的不是保护，而是足够让她燃烧的高强度创作战场。',
  '他也明确承认诗羽作为霞诗子的作者自尊，不把她当作附属工具。',
  '英梨梨和诗羽把朱音的压力转成了共同击退她的创作意志。',
].join('\n');

const akaneScene = [
  'User 已经看见红坂朱音带来的正式压力。',
  '他承认朱音的创作强度、危险和自毁性，开始与她进行不扁平的对话。',
].join('\n');

const soloScene = 'User 明确拒绝依附 blessing software 或朱音体系，准备独立推进自己的创作路线。';

export const LAB_SCENARIOS: LabScenario[] = [
  {
    id: 'valid-stay',
    label: '合规：留下路线',
    date: '2013-03-04',
    sceneText: stayScene,
    rawAvailable: true,
    responses: [
      proposal([
        {
          flagId: 'second_project_seed_ready',
          value: 'yes',
          evidenceQuote: '第二作企划初稿摊在桌上，这已经足够成为实际行动的基础',
        },
        {
          flagId: 'megumi_coplanner',
          value: 'yes',
          evidenceQuote: '共同企划和副代表的身份拥有否决与纠正权',
        },
        {
          flagId: 'eriri_high_battlefield_supported',
          value: 'yes',
          evidenceQuote: '足够让她燃烧的高强度创作战场',
        },
        {
          flagId: 'utaha_author_pride_supported',
          value: 'yes',
          evidenceQuote: '承认诗羽作为霞诗子的作者自尊',
        },
        {
          flagId: 'blackgold_counterwill',
          value: 'yes',
          evidenceQuote: '共同击退她的创作意志',
        },
      ]),
    ],
  },
  {
    id: 'valid-akane',
    label: '合规：朱音路线',
    date: '2013-03-04',
    sceneText: akaneScene,
    rawAvailable: true,
    responses: [
      proposal([
        {
          flagId: 'akane_pressure_seen',
          value: 'yes',
          evidenceQuote: '已经看见红坂朱音带来的正式压力',
        },
        {
          flagId: 'akane_route_open',
          value: 'yes',
          evidenceQuote: '承认朱音的创作强度、危险和自毁性',
        },
      ]),
    ],
  },
  {
    id: 'valid-solo',
    label: '合规：单飞路线',
    date: '2013-03-04',
    sceneText: soloScene,
    rawAvailable: true,
    responses: [
      proposal([
        {
          flagId: 'solo_route_open',
          value: 'yes',
          evidenceQuote: '准备独立推进自己的创作路线',
        },
      ]),
    ],
  },
  {
    id: 'checked-empty',
    label: '合规：检查后无变化',
    date: '2013-03-04',
    sceneText: '本轮只是普通的放学闲聊，没有发生路线事实变化。',
    rawAvailable: true,
    responses: [proposal([])],
  },
  {
    id: 'repair-success',
    label: '首次漏标签，repair 成功',
    date: '2013-02-26',
    sceneText: 'User 的第二作企划初稿已经足以成为实际行动基础。',
    rawAvailable: true,
    responses: [
      '这里漏掉了要求的标签。',
      proposal([
        {
          flagId: 'second_project_seed_ready',
          value: 'yes',
          evidenceQuote: '第二作企划初稿已经足以成为实际行动基础',
        },
      ]),
    ],
  },
  {
    id: 'missing-tag',
    label: '连续漏标签：needs_review',
    date: '2013-03-04',
    sceneText: 'User 明确准备独立推进自己的创作路线。',
    rawAvailable: true,
    responses: ['第一次漏掉标签。', '第二次仍然漏掉标签。'],
  },
  {
    id: 'unknown-choice',
    label: '越权：AI 尝试写 choice',
    date: '2013-03-04',
    sceneText: 'User 说自己倾向留下，但还没有进行最终确认。',
    rawAvailable: true,
    responses: [
      proposal([
        {
          flagId: 'plotRoute.v07.choice',
          value: 'yes',
          evidenceQuote: '自己倾向留下，但还没有进行最终确认',
        },
      ]),
      proposal([
        {
          flagId: 'stay_route_viable',
          value: 'yes',
          evidenceQuote: '自己倾向留下，但还没有进行最终确认',
        },
      ]),
    ],
  },
  {
    id: 'contradiction',
    label: '错误：同批矛盾 flag',
    date: '2013-03-04',
    sceneText: '第二作企划已经可以执行，但也有人声称它还只是空话。',
    rawAvailable: true,
    responses: [
      proposal([
        {
          flagId: 'second_project_seed_ready',
          value: 'yes',
          evidenceQuote: '第二作企划已经可以执行',
        },
        {
          flagId: 'second_project_seed_ready',
          value: 'no',
          evidenceQuote: '它还只是空话',
        },
      ]),
      proposal([
        {
          flagId: 'second_project_seed_ready',
          value: 'yes',
          evidenceQuote: '第二作企划已经可以执行',
        },
        {
          flagId: 'second_project_seed_ready',
          value: 'no',
          evidenceQuote: '它还只是空话',
        },
      ]),
    ],
  },
  {
    id: 'fake-evidence',
    label: '错误：伪造正文证据',
    date: '2013-03-04',
    sceneText: '本轮只讨论了天气和回家路线。',
    rawAvailable: true,
    responses: [
      proposal([
        {
          flagId: 'solo_route_open',
          value: 'yes',
          evidenceQuote: 'User 决定独立制作自己的游戏',
        },
      ]),
      proposal([
        {
          flagId: 'solo_route_open',
          value: 'yes',
          evidenceQuote: 'User 决定独立制作自己的游戏',
        },
      ]),
    ],
  },
  {
    id: 'before-window',
    label: '边界：日期早于下界',
    date: '2013-02-24',
    sceneText: soloScene,
    rawAvailable: true,
    responses: [
      proposal([
        {
          flagId: 'solo_route_open',
          value: 'yes',
          evidenceQuote: '准备独立推进自己的创作路线',
        },
      ]),
    ],
  },
  {
    id: 'no-generate-raw',
    label: '能力缺失：无 generateRaw',
    date: '2013-03-04',
    sceneText: soloScene,
    rawAvailable: false,
    responses: [],
  },
];
