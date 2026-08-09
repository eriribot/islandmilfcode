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

console.info('[shujuku-v2-reader-planning] 5 contracts passed');
