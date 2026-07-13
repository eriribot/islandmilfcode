import {
  commitGameDevelopmentState,
  createInitialGameDevelopmentState,
  readGameDevelopmentState,
} from '../game-development';
import { createGameDevelopmentController } from '../index/game-development';
import { upsertAttribute } from '../memorydatabase/upsert';
import {
  buildPlotRoutingContext,
  commitPlotRouteChoice,
  V07_PLOT_MACHINE,
  type PlotRouteChoiceReceipt,
} from '../plot-state-machine';
import { renderPhone, type PhoneRenderers } from '../phone/render';
import { createInitialState } from '../state/store';
import type { AppState } from '../types';

function assert(condition: unknown, contract: string): asserts condition {
  if (condition) return;
  throw new Error(contract);
}

function assertEqual<T>(actual: T, expected: T, contract: string) {
  if (Object.is(actual, expected)) return;
  throw new Error(`${contract}: expected ${String(expected)}, received ${String(actual)}`);
}

const renderers: PhoneRenderers = {
  renderInventoryPanel: () => '',
  renderPaperWorkspace: () => '',
  renderStatusPanel: () => '',
  renderSummaryConfigSection: () => '',
  renderSummaryPanel: () => '',
};

function createChosenSoloState(confirmationId: string): {
  state: AppState;
  receipt: PlotRouteChoiceReceipt;
} {
  const state = createInitialState({ x: 0, y: 0 });
  state.activeRunId = 'game-development-contract-run';
  state.phoneOpen = true;
  state.phoneRoute = 'app:game-development';
  state.statusData.world.currentTime = '2013-03-31 12:00';
  state.statusData.world.currentMainEventId = '';
  state.statusData.world.mainEvents['SAE_07-8'] = '已结束';

  const receipt: PlotRouteChoiceReceipt = {
    schemaVersion: 2,
    machineId: 'v07',
    familyId: 'solo',
    confirmationId,
    anchorFloorIndex: 0,
    confirmedAt: state.statusData.world.currentTime,
    source: 'manual',
  };
  commitPlotRouteChoice(state.memoryDB, {
    targetId: V07_PLOT_MACHINE.targetId,
    key: V07_PLOT_MACHINE.choiceStorageKey,
    value: JSON.stringify(receipt),
    valueType: 'json',
    source: 'manual',
    receipt,
  });
  return { state, receipt };
}

async function verifyLegacyActiveProjectRenders() {
  const { state, receipt } = createChosenSoloState('legacy-active-project');
  upsertAttribute(state.memoryDB, {
    targetId: V07_PLOT_MACHINE.targetId,
    key: 'gameDevelopment.v1.state',
    value: JSON.stringify({
      schemaVersion: 2,
      routeConfirmationId: receipt.confirmationId,
      routeFamily: 'solo',
      routeVariant: 'solo_user_exit',
      project: {
        created: true,
        title: '旧存档第二作',
        genre: '青春创作文字冒险',
        theme: '旧企划迁移合同',
        platform: '电脑同人游戏',
        phase: '正式开发',
        weeksLeft: 12,
        budget: 88,
        progress: 42,
        fun: 30,
        creativity: 31,
        writing: 32,
        art: 33,
        code: 34,
        polish: 35,
        hype: 36,
        bugs: 7,
        fatigue: 8,
      },
      week: 4,
      selectedDay: 'mon',
      slots: {},
      lastSubmission: null,
    }),
    valueType: 'json',
    source: 'manual',
    reason: 'contract fixture: legacy v2 active project',
  });

  const routing = buildPlotRoutingContext(state.statusData, state.memoryDB);
  const migrated = readGameDevelopmentState(
    state.memoryDB,
    receipt,
    routing.v07.resolution,
    state.statusData.world.currentTime,
  );
  assertEqual(migrated.schemaVersion, 3, 'contract: a legacy v2 project migrates to schema v3');
  assertEqual(migrated.projectStatus, 'active', 'contract: a created legacy project remains active after migration');
  assertEqual(migrated.project.title, '旧存档第二作', 'contract: migration preserves the project title');
  assertEqual(migrated.week, 4, 'contract: migration preserves the project week');

  const html = renderPhone(state, renderers);
  assert(
    html.includes('data-phone-route-view="app:game-development"'),
    'contract: an active project renders the production game-development route',
  );
  assert(html.includes('旧存档第二作'), 'contract: the active project page renders the migrated project');
  assert(html.includes('开发档案：'), 'contract: the active project page renders its route profile label');
  assert(!html.includes('data-action="game-create-project"'), 'contract: an active project never falls back to the form');
}

async function verifyCreateProjectRendersOnceAndRejectsDoubleClick() {
  const { state, receipt } = createChosenSoloState('single-render-project');
  const routing = buildPlotRoutingContext(state.statusData, state.memoryDB);
  commitGameDevelopmentState(
    state.memoryDB,
    createInitialGameDevelopmentState(receipt, routing.v07.resolution),
  );

  let clickHandler: (() => void) | null = null;
  let renderCount = 0;
  let persistCount = 0;
  let immediatePersistCount = 0;
  let notificationCount = 0;
  let releasePersistence: (() => void) | null = null;
  const persistenceGate = new Promise<void>(resolve => {
    releasePersistence = resolve;
  });
  const fields: Record<string, string> = {
    'game-project-title': '单次渲染企划',
    'game-project-genre': '文字冒险',
    'game-project-theme': '渲染合同',
    'game-project-platform': 'PC',
  };
  const fakeRoot = {
    querySelector(selector: string) {
      if (selector === '[data-action="game-create-project"]') {
        return {
          addEventListener(type: string, listener: () => void) {
            if (type === 'click') clickHandler = listener;
          },
        };
      }
      const field = selector.match(/^\[data-field="([^"]+)"\]$/)?.[1];
      return field && Object.prototype.hasOwnProperty.call(fields, field) ? { value: fields[field] } : null;
    },
    querySelectorAll() {
      return [];
    },
  } as unknown as HTMLElement;

  const controller = createGameDevelopmentController({
    getState: () => state,
    getRoot: () => fakeRoot,
    render: () => {
      renderCount += 1;
    },
    persist: () => {
      persistCount += 1;
    },
    persistImmediately: async () => {
      immediatePersistCount += 1;
      await persistenceGate;
    },
    submitMainMessage: async () => {},
    notify: notification => {
      state.notification = notification;
      notificationCount += 1;
      renderCount += 1;
    },
  });
  controller.bind(fakeRoot);
  const click = clickHandler as (() => void) | null;
  assert(click, 'contract: the create-project button binds one click handler');

  click();
  click();
  await Promise.resolve();
  assertEqual(persistCount, 1, 'contract: a rapid double click commits only one project');
  assertEqual(immediatePersistCount, 1, 'contract: a rapid double click starts one durable write');
  assertEqual(renderCount, 0, 'contract: project creation does not render an intermediate state before durability');

  const release = releasePersistence as (() => void) | null;
  release?.();
  await persistenceGate;
  await Promise.resolve();
  assertEqual(notificationCount, 1, 'contract: successful project creation emits one notification');
  assertEqual(renderCount, 1, 'contract: successful project creation performs one visible render');
}

function verifyClosedPhoneSkipsHiddenRouteRendering() {
  const state = createInitialState({ x: 0, y: 0 });
  state.phoneOpen = false;
  state.phoneRoute = 'app:summary';
  let summaryRenderCount = 0;
  renderPhone(state, {
    ...renderers,
    renderSummaryPanel: () => {
      summaryRenderCount += 1;
      return 'summary-heavy-content';
    },
  });
  assertEqual(summaryRenderCount, 0, 'contract: a closed phone does not render its hidden route');
}

async function main() {
  await verifyLegacyActiveProjectRenders();
  await verifyCreateProjectRendersOnceAndRejectsDoubleClick();
  verifyClosedPhoneSkipsHiddenRouteRendering();
  console.info('[game-development-contracts] 15 contracts passed');
}

void main();
