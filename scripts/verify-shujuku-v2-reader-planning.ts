import fs from 'node:fs';
import path from 'node:path';
import { renderPaperWorkspace } from '../render';
import { createInitialState } from '../state/store';

function assertIncludes(actual: string, expected: string, contract: string) {
  if (actual.includes(expected)) return;
  throw new Error(`${contract}: missing ${expected}`);
}

function assertExcludes(actual: string, expected: string, contract: string) {
  if (!actual.includes(expected)) return;
  throw new Error(`${contract}: unexpectedly included ${expected}`);
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  },
});

const state = createInitialState({ x: 0, y: 0 });
state.uiMessages = [{
  id: 'shujuku-user-1',
  role: 'user',
  speaker: 'User',
  text: '自由发挥写剧情',
  pluginData: {
    qrf_plot: '让本轮正文承接玩家输入',
    qrf_plot_tasks: { continuity: '读取正文历史' },
    extra: { qrf_plot_preset: '<unsafe-preset>' },
  },
}];
state.focusedMessageIndex = 0;

const html = renderPaperWorkspace(state);
assertIncludes(html, '自由发挥写剧情', 'contract: the user input remains visible on its reader floor');
assertIncludes(html, 'reader-shujuku-plan', 'contract: real qrf data adds a planning projection to the user floor');
assertIncludes(html, '让本轮正文承接玩家输入', 'contract: qrf_plot is rendered on the matching user floor');
assertIncludes(html, '读取正文历史', 'contract: qrf_plot_tasks is rendered on the matching user floor');
assertExcludes(html, '<unsafe-preset>', 'contract: planning content is escaped before entering reader HTML');

const plannedState = createInitialState({ x: 0, y: 0 });
plannedState.uiMessages = [{
  id: 'shujuku-user-planned-1',
  role: 'user',
  speaker: 'User',
  text: '调查旧校舍',
  plannedText: [
    '以下是用户',
    '<本轮用户输入>调查 <script>旧校舍</script></本轮用户输入>',
    '<recall>AM12（天台约定）</recall>',
    '<supplement>- [地点] 旧校舍 & 天台</supplement>',
    '<kirihime_review>维持町田苑子在场连续性</kirihime_review>',
  ].join('\n'),
}];
plannedState.focusedMessageIndex = 0;

const plannedHtml = renderPaperWorkspace(plannedState);
assertIncludes(plannedHtml, 'reader-shujuku-plan', 'contract: plannedText alone adds a projection to the logical user floor');
assertIncludes(plannedHtml, '调查 &lt;script&gt;旧校舍&lt;/script&gt;', 'contract: planned user input is rendered and escaped');
assertIncludes(plannedHtml, 'AM12（天台约定）', 'contract: planned recall is rendered on the logical user floor');
assertIncludes(plannedHtml, '- [地点] 旧校舍 &amp; 天台', 'contract: planned supplement is rendered and escaped');
assertIncludes(plannedHtml, '维持町田苑子在场连续性', 'contract: Kirihime review survives the built-in fallback projection');
assertIncludes(plannedHtml, '雾姬朱批', 'contract: the built-in fallback uses the dedicated Kirihime review label');
assertIncludes(plannedHtml, 'reader-shujuku-plan--fallback', 'contract: the built-in fallback is a collapsible details panel');
assertIncludes(plannedHtml, '点击展开', 'contract: the built-in fallback exposes an explicit expand affordance');
assertExcludes(plannedHtml, '桐姬复核', 'contract: the fallback does not expose the obsolete misspelled reviewer label');
assertExcludes(plannedHtml, '<recall>', 'contract: plannedText wrapper tags do not leak into reader HTML');

const currentProtocolState = createInitialState({ x: 0, y: 0 });
currentProtocolState.uiMessages = [{
  id: 'shujuku-user-current-protocol-1',
  role: 'user',
  speaker: 'User',
  text: '离开侦探坡',
  pluginData: {
    _islandmilfcode_planning_display_v1: {
      version: 1,
      recallEntries: {
        AM21: {
          title: '坡道告别',
          body: '冻结在规划时点的召回正文',
          source: '纪要表 · 卷21',
        },
      },
    },
  },
  plannedText: [
    '[SYSTEM_DIRECTIVE: output planning evidence]',
    '<current_user_input>听着 mp3 离开侦探坡</current_user_input>',
    '<planning_evidence>',
    '<recall>AM21（坡道告别）</recall>',
    '<kirihime_review>camera: user; focus: 侦探坡</kirihime_review>',
    '<supplement>- [因果] 玩家已经离场</supplement>',
    '</planning_evidence>',
  ].join('\n'),
}];
currentProtocolState.focusedMessageIndex = 0;

const currentProtocolFallback = renderPaperWorkspace(currentProtocolState);
assertIncludes(currentProtocolFallback, '听着 mp3 离开侦探坡', 'contract: current_user_input renders through the built-in fallback');
assertIncludes(currentProtocolFallback, 'camera: user; focus: 侦探坡', 'contract: nested Kirihime planning evidence renders through the built-in fallback');
assertExcludes(currentProtocolFallback, '<planning_evidence>', 'contract: current planning protocol wrapper tags do not leak into reader HTML');

const tavernCalls: unknown[][] = [];
(globalThis as any).formatAsTavernRegexedString = (...args: unknown[]) => {
  tavernCalls.push(args);
  const source = String(args[0] ?? '');
  if (!/^以下是夏野雾姬规划B64:[A-Za-z0-9+/=]+$/.test(source)) return source;
  return [
    '酒馆普通文本前缀 <script data-unsafe="true">bad()</script>',
    '```html',
    '<!doctype html><html><body><div data-tavern-regex="true">酒馆原生规划</div></body></html>',
    '```',
    '酒馆普通文本尾部',
  ].join('\n');
};
const tavernHtml = renderPaperWorkspace(currentProtocolState);
delete (globalThis as any).formatAsTavernRegexedString;

const fixedRendererPath = path.resolve(
  __dirname,
  '../shujuku/导入到酒馆中/regex-夏野雾姬Island规划页边审稿.json',
);
const fixedRenderer = JSON.parse(fs.readFileSync(fixedRendererPath, 'utf8')) as { replaceString?: unknown };
const fixedRendererHtml = String(fixedRenderer.replaceString ?? '');

assertIncludes(tavernHtml, 'reader-shujuku-plan--tavern-regex', 'contract: Tavern regex output replaces the built-in planning fallback');
assertIncludes(tavernHtml, 'data-shujuku-regex-frame="true"', 'contract: Tavern HTML fences render through an iframe srcdoc');
assertIncludes(fixedRendererHtml, 'collapseAllBtn', 'contract: the importable Kirihime renderer exposes a collapse-all control');
assertIncludes(fixedRendererHtml, 'expandAllBtn', 'contract: the importable Kirihime renderer exposes an expand-all control');
assertIncludes(fixedRendererHtml, 'data-section="review"', 'contract: the importable Kirihime renderer exposes per-section collapse state');
assertIncludes(fixedRendererHtml, 'data-default-open="true"', 'contract: only the review section defaults open');
assertExcludes(fixedRendererHtml, 'AutoCardUpdaterAPI', 'contract: the importable planning renderer never reads live plugin state');
assertIncludes(tavernHtml, 'data-tavern-regex', 'contract: Tavern regex replacement is preserved in the iframe source');
assertIncludes(tavernHtml, '酒馆普通文本前缀', 'contract: text before a Tavern HTML fence remains visible');
assertIncludes(tavernHtml, '酒馆普通文本尾部', 'contract: text after a Tavern HTML fence remains visible');
assertExcludes(tavernHtml, '<script data-unsafe="true">', 'contract: non-HTML Tavern segments cannot inject markup into srcdoc');
assertExcludes(tavernHtml, 'reader-shujuku-plan__title', 'contract: Tavern regex rendering does not duplicate the built-in planning header');
assertExcludes(tavernHtml, '<p class="reader-card__text">调查旧校舍</p>', 'contract: Tavern planning owns the user-input display without an outer duplicate');
if (JSON.stringify(tavernCalls[0]?.slice(1)) !== JSON.stringify(['user_input', 'display', { depth: 0 }])) {
  throw new Error('contract: plannedText runs through Tavern regexes as depth-0 user display text');
}
const tavernInput = String(tavernCalls[0]?.[0] ?? '');
assertIncludes(tavernInput, '以下是夏野雾姬规划B64:', 'contract: current planning targets the dedicated Kirihime display regex');
const encodedPayload = tavernInput.match(/^以下是夏野雾姬规划B64:([A-Za-z0-9+/=]+)$/)?.[1];
if (!encodedPayload) throw new Error('contract: dedicated Kirihime display payload is missing');
const tavernPayload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8')) as Record<string, any>;
if (tavernPayload.currentUserInput !== '听着 mp3 离开侦探坡') {
  throw new Error('contract: current_user_input survives the dedicated display projection');
}
if (tavernPayload.kirihimeReview !== 'camera: user; focus: 侦探坡') {
  throw new Error('contract: Kirihime review survives the dedicated display projection');
}
if (tavernPayload.recall !== 'AM21（坡道告别）' || tavernPayload.supplement !== '- [因果] 玩家已经离场') {
  throw new Error('contract: recall and supplement survive the dedicated display projection');
}
if (tavernPayload.recallEntries?.AM21?.body !== '冻结在规划时点的召回正文') {
  throw new Error('contract: the dedicated renderer receives the immutable recall snapshot captured at planning');
}
assertExcludes(JSON.stringify(tavernPayload), 'AutoCardUpdaterAPI',
  'contract: planning display data contains no live plugin capability');
assertExcludes(tavernInput, '<planning_evidence>', 'contract: display payload contains no raw protocol scaffolding');

(globalThis as any).formatAsTavernRegexedString = (source: string) => source;
const noOpRegexHtml = renderPaperWorkspace(currentProtocolState);
delete (globalThis as any).formatAsTavernRegexedString;
assertExcludes(noOpRegexHtml, 'reader-shujuku-plan--tavern-regex', 'contract: an unchanged Tavern formatter result is a no-op, not a beautified render');
assertIncludes(noOpRegexHtml, 'reader-shujuku-plan__title', 'contract: a Tavern no-op falls back to the built-in structured planning projection');
assertExcludes(noOpRegexHtml, '<current_user_input>', 'contract: Tavern no-op fallback never exposes raw current-protocol tags');

const assistantPlanState = createInitialState({ x: 0, y: 0 });
assistantPlanState.uiMessages = [{
  id: 'assistant-plan-must-not-render',
  role: 'assistant',
  speaker: 'Assistant',
  text: '正文',
  plannedText: '<kirihime_review>不得投影到 assistant 楼层</kirihime_review>',
  pluginData: { qrf_plot: '不得投影' },
}];
assistantPlanState.focusedMessageIndex = 0;
const assistantPlanHtml = renderPaperWorkspace(assistantPlanState);
assertExcludes(assistantPlanHtml, 'reader-shujuku-plan', 'contract: planning display belongs only to the logical user floor');

console.info('[shujuku-v2-reader-planning] 40 contracts passed');
