import {
  commitGameDevelopmentState,
  createGameDevelopmentProject,
  createInitialGameDevelopmentState,
  getGameDevelopmentFixedInput,
  isGameDevelopmentFixedInput,
  readGameDevelopmentState,
  submitGameDevelopmentTurn,
  updateGameDevelopmentDraft,
  type GameDevelopmentActionId,
  type GameDevelopmentState,
} from '../game-development';
import { isPlayerPhonePseudoTarget } from '../phone/types';
import { buildPlotRoutingContext } from '../plot-state-machine/routing-context';
import type { PlotRouteChoiceReceipt, PlotRouteResolution } from '../plot-state-machine/types';
import type { AppState, NotificationState } from '../types';

export type GameDevelopmentController = {
  readonly bind: (root: HTMLElement | null) => void;
  readonly initializeAfterRouteChoice: (
    receipt: PlotRouteChoiceReceipt,
    resolution: PlotRouteResolution,
  ) => Promise<void>;
  readonly resumePreparedTurnAfterRollback: (sourceUserText: string) => Promise<boolean>;
};

export function createGameDevelopmentController(dependencies: {
  readonly getState: () => AppState;
  readonly getRoot: () => HTMLElement | null;
  readonly render: () => void;
  readonly persist: () => void;
  readonly persistImmediately: () => Promise<void>;
  readonly submitMainMessage: Parameters<typeof submitGameDevelopmentTurn>[0]['submitMainMessage'];
  readonly notify: (notification: NotificationState) => void;
}): GameDevelopmentController {
  const readActiveState = (): GameDevelopmentState | null => {
    const appState = dependencies.getState();
    const routing = buildPlotRoutingContext(appState.statusData, appState.memoryDB);
    const receipt = routing.v07.resolution.choiceReceipt;
    if (!receipt || routing.v07.resolution.choiceState !== 'chosen') return null;
    return readGameDevelopmentState(
      appState.memoryDB,
      receipt,
      routing.v07.resolution,
      appState.statusData.world.currentTime || new Date().toISOString(),
    );
  };

  const writeState = (next: GameDevelopmentState) => {
    const appState = dependencies.getState();
    commitGameDevelopmentState(appState.memoryDB, next);
    dependencies.persist();
    dependencies.render();
  };

  const allowedTargetIds = () =>
    dependencies
      .getState()
      .statusData.targets.filter(target => !isPlayerPhonePseudoTarget(target))
      .map(target => target.id);

  const notify = (title: string, preview: string) => {
    const appState = dependencies.getState();
    dependencies.notify({
      kind: 'status',
      title,
      preview,
      targetTab: 'status',
      phoneRoute: 'app:game-development',
      timestamp: appState.statusData.world.currentTime,
    });
  };

  const submit = async () => {
    if (dependencies.getState().generating) {
      notify('当前正在生成正文', '请等待现有主正文请求结束后再开始游戏开发回合。');
      return;
    }
    const current = readActiveState();
    if (!current) {
      notify('游戏开发尚未开放', '请先完成第七卷路线确认。');
      return;
    }
    try {
      const result = await submitGameDevelopmentTurn({
        readState: () => readActiveState() ?? current,
        writeState,
        persistImmediately: dependencies.persistImmediately,
        submitMainMessage: dependencies.submitMainMessage,
        allowedTargetIds,
        runId: () => dependencies.getState().activeRunId ?? '',
        now: () => new Date().toISOString(),
      });
      if (result.status === 'rejected') {
        notify('本回合不能提交', result.reason);
        return;
      }
      const lastTurn = result.state.turnLedger[result.state.turnLedger.length - 1];
      notify(
        result.state.projectStatus === 'completed'
          ? '项目已经完成'
          : result.state.projectStatus === 'deadline_reached'
            ? '项目已到截止期限'
            : lastTurn?.phase === 'workday'
              ? '工作日正文与结算已完成'
              : '周末正文与结算已完成',
        result.state.projectStatus === 'active'
          ? `当前进入第 ${result.state.week} 周 ${result.state.activePhase === 'workday' ? '工作日' : '周末'}阶段。`
          : `当前完成度 ${result.state.project.progress}%。`,
      );
    } catch (error) {
      notify('游戏开发回合失败', error instanceof Error ? error.message : String(error));
      dependencies.render();
    }
  };

  const createProject = async () => {
    const current = readActiveState();
    if (!current) return;
    const root = dependencies.getRoot();
    const value = (field: string) => root?.querySelector<HTMLInputElement>(`[data-field="${field}"]`)?.value ?? '';
    const result = createGameDevelopmentProject(current, {
      title: value('game-project-title'),
      genre: value('game-project-genre'),
      theme: value('game-project-theme'),
      platform: value('game-project-platform'),
    });
    if (result.status === 'rejected') {
      notify('项目尚未建立', result.reason);
      return;
    }
    writeState(result.value);
    await dependencies.persistImmediately();
    notify('项目已建立', `${result.value.project.title} 已建立，可以开始第 1 周工作日回合。`);
  };

  const updateDraft = (patch: Parameters<typeof updateGameDevelopmentDraft>[1]) => {
    const current = readActiveState();
    if (!current) return;
    const result = updateGameDevelopmentDraft(current, patch, allowedTargetIds());
    if (result.status === 'rejected') {
      notify('行动不能修改', result.reason);
      return;
    }
    writeState(result.value);
  };

  return {
    bind(root) {
      root?.querySelector<HTMLButtonElement>('[data-action="game-create-project"]')?.addEventListener('click', () => {
        void createProject();
      });
      root?.querySelectorAll<HTMLButtonElement>('[data-action="game-select-action"]').forEach(button => {
        button.addEventListener('click', () => {
          const actionId = button.dataset.gameAction as GameDevelopmentActionId | undefined;
          if (actionId) updateDraft({ actionId });
        });
      });
      root?.querySelector<HTMLSelectElement>('[data-field="game-turn-target"]')?.addEventListener('change', event => {
        updateDraft({ selectedTargetId: (event.target as HTMLSelectElement).value || null });
      });
      root?.querySelector<HTMLTextAreaElement>('[data-field="game-turn-intent"]')?.addEventListener('change', event => {
        updateDraft({ intent: (event.target as HTMLTextAreaElement).value });
      });
      root?.querySelector<HTMLButtonElement>('[data-action="game-submit-turn"]')?.addEventListener('click', () => {
        void submit();
      });
      root?.querySelector<HTMLButtonElement>('[data-action="game-retry-turn"]')?.addEventListener('click', () => {
        void submit();
      });
    },

    async initializeAfterRouteChoice(receipt, resolution) {
      const appState = dependencies.getState();
      const initial = createInitialGameDevelopmentState(receipt, resolution);
      commitGameDevelopmentState(appState.memoryDB, initial);
      await dependencies.persistImmediately();
      dependencies.render();
    },

    async resumePreparedTurnAfterRollback(sourceUserText) {
      const current = readActiveState();
      if (!current?.pendingTurn || !isGameDevelopmentFixedInput(sourceUserText)) return false;
      if (sourceUserText.trim() !== getGameDevelopmentFixedInput(current.pendingTurn.phase)) return false;
      dependencies.getState().draft = '';
      await submit();
      return true;
    },
  };
}
