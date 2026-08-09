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
  ].join('\n'),
}];
plannedState.focusedMessageIndex = 0;

const plannedHtml = renderPaperWorkspace(plannedState);
assertIncludes(plannedHtml, 'reader-shujuku-plan', 'contract: plannedText alone adds a projection to the logical user floor');
assertIncludes(plannedHtml, '调查 &lt;script&gt;旧校舍&lt;/script&gt;', 'contract: planned user input is rendered and escaped');
assertIncludes(plannedHtml, 'AM12（天台约定）', 'contract: planned recall is rendered on the logical user floor');
assertIncludes(plannedHtml, '- [地点] 旧校舍 &amp; 天台', 'contract: planned supplement is rendered and escaped');
assertExcludes(plannedHtml, '<recall>', 'contract: plannedText wrapper tags do not leak into reader HTML');

console.info('[shujuku-v2-reader-planning] 10 contracts passed');
