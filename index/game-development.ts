import {
  commitGameDevelopmentState,
  createGameDevelopmentProject,
  createInitialGameDevelopmentState,
  GAME_DEVELOPMENT_ACTIONS,
  getGameDevelopmentTargetLabel,
  readGameDevelopmentState,
  restorePendingGameDevelopmentTurnForRollback,
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
  readonly submitFromMainDraft: (sourceUserText: string) => Promise<boolean>;
  readonly restoreEditorAfterRollback: (sourceUserText: string) => boolean;
  readonly submitRestoredTurn: (sourceUserText: string, timelineMutationOwner?: symbol) => Promise<boolean>;
};

export function createGameDevelopmentController(dependencies: {
  readonly getState: () => AppState;
  readonly getRoot: () => HTMLElement | null;
  readonly render: () => void;
  readonly persist: () => void;
  readonly persistImmediately: () => Promise<void>;
  readonly submitMainMessage: (
    options: Parameters<Parameters<typeof submitGameDevelopmentTurn>[0]['submitMainMessage']>[0]
      & { timelineMutationOwner?: symbol },
  ) => Promise<void>;
  readonly notify: (notification: NotificationState) => void;
  readonly focusComposer: () => void;
}): GameDevelopmentController {
  const gameChoiceEditFlag = 'gameDevelopmentChoiceEdit';
  let projectCreationPending = false;

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
      { recoverInterruptedTurn: !appState.generating },
    );
  };

  const writeState = (next: GameDevelopmentState, shouldRender = true) => {
    const appState = dependencies.getState();
    commitGameDevelopmentState(appState.memoryDB, next);
    dependencies.persist();
    if (shouldRender) dependencies.render();
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

  const clearGameChoiceEdit = () => {
    delete dependencies.getState().runtimeFlags[gameChoiceEditFlag];
  };

  const getTurnTargetLabel = (selectedTargetId: string | null, phase: GameDevelopmentState['activePhase']) => {
    if (!selectedTargetId) return phase === 'weekend' ? '独自休息' : '独自工作';
    const target = dependencies.getState().statusData.targets.find(item => item.id === selectedTargetId);
    return getGameDevelopmentTargetLabel(
      [target?.id ?? selectedTargetId, target?.name, target?.alias].filter(Boolean).join(' / '),
    );
  };

  const setGameChoiceEdit = (current: GameDevelopmentState) => {
    const turn = current.pendingTurn ?? current.draft;
    if (!turn.actionId) return false;
    dependencies.getState().runtimeFlags[gameChoiceEditFlag] = {
      routeConfirmationId: current.routeConfirmationId,
      week: current.week,
      phase: turn.phase,
      actionId: turn.actionId,
      actionLabel: GAME_DEVELOPMENT_ACTIONS.find(action => action.id === turn.actionId)?.label ?? '待选择',
      selectedTargetId: turn.selectedTargetId,
      targetLabel: getTurnTargetLabel(turn.selectedTargetId, turn.phase),
    };
    return true;
  };

  const hasCurrentGameChoiceEdit = (current: GameDevelopmentState) => {
    const raw = dependencies.getState().runtimeFlags[gameChoiceEditFlag];
    if (!raw || typeof raw !== 'object') return false;
    const flag = raw as Record<string, unknown>;
    const turn = current.pendingTurn ?? current.draft;
    return (
      flag.routeConfirmationId === current.routeConfirmationId &&
      Number(flag.week) === current.week &&
      flag.phase === turn.phase &&
      flag.actionId === turn.actionId &&
      String(flag.selectedTargetId ?? '') === String(turn.selectedTargetId ?? '')
    );
  };

  const submit = async (timelineMutationOwner?: symbol) => {
    if (dependencies.getState().generating) {
      notify('当前正在生成正文', '请等待现有主正文请求结束后再开始游戏开发回合。');
      return false;
    }
    const current = readActiveState();
    if (!current) {
      notify('游戏开发尚未开放', '请先完成第七卷路线确认。');
      return false;
    }
    try {
      const result = await submitGameDevelopmentTurn({
        readState: () => readActiveState() ?? current,
        writeState,
        persistImmediately: dependencies.persistImmediately,
        submitMainMessage: options => dependencies.submitMainMessage({ ...options, timelineMutationOwner }),
        allowedTargetIds,
        runId: () => dependencies.getState().activeRunId ?? '',
        now: () => new Date().toISOString(),
      });
      if (result.status === 'rejected') {
        notify('本回合不能提交', result.reason);
        return false;
      }
      clearGameChoiceEdit();
      dependencies.persist();
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
      return true;
    } catch (error) {
      notify('游戏开发回合失败', error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const createProject = async () => {
    if (projectCreationPending) return;
    const current = readActiveState();
    if (!current) return;
    const root = dependencies.getRoot();
    const value = (field: string) => root?.querySelector<HTMLInputElement>(`[data-field="${field}"]`)?.value ?? '';
    const result = createGameDevelopmentProject(
      current,
      {
        title: value('game-project-title'),
        genre: value('game-project-genre'),
        theme: value('game-project-theme'),
        platform: value('game-project-platform'),
      },
      dependencies.getState().statusData.world.currentTime,
    );
    if (result.status === 'rejected') {
      notify('项目尚未建立', result.reason);
      return;
    }
    projectCreationPending = true;
    try {
      writeState(result.value, false);
      await dependencies.persistImmediately();
      notify('项目已建立', `${result.value.project.title} 已建立，可以开始第 1 周工作日回合。`);
    } catch (error) {
      notify('项目已建立，但保存失败', error instanceof Error ? error.message : String(error));
    } finally {
      projectCreationPending = false;
    }
  };

  const updateDraft = (patch: Parameters<typeof updateGameDevelopmentDraft>[1]) => {
    const current = readActiveState();
    if (!current) return;
    const result = updateGameDevelopmentDraft(current, patch, allowedTargetIds());
    if (result.status === 'rejected') {
      notify('行动不能修改', result.reason);
      return;
    }
    clearGameChoiceEdit();
    writeState(result.value);
  };

  const reviewInComposer = () => {
    const current = readActiveState();
    if (!current?.draft.actionId) {
      notify('尚未选择行动', '请先选择本回合的开发行动。');
      return;
    }
    const appState = dependencies.getState();
    const body = appState.draft.trim();
    const updated = updateGameDevelopmentDraft(current, { intent: body }, allowedTargetIds());
    if (updated.status === 'rejected') {
      notify('记录框不能打开', updated.reason);
      return;
    }
    commitGameDevelopmentState(appState.memoryDB, updated.value);
    setGameChoiceEdit(updated.value);
    appState.draft = body;
    dependencies.persist();
    appState.phoneOpen = false;
    appState.phoneRoute = 'home';
    appState.phoneRouteHistory = [];
    dependencies.render();
    dependencies.focusComposer();
  };

  const restoreEditorAfterRollback = (sourceUserText: string) => {
    let current = readActiveState();
    const body = String(sourceUserText ?? '')
      .replace(/^（游戏开发：[^\r\n]*）\s*/, '')
      .trim();
    if (current?.pendingTurn && current.pendingTurn.intent.trim() === body) {
      current = restorePendingGameDevelopmentTurnForRollback(current);
      commitGameDevelopmentState(dependencies.getState().memoryDB, current);
      dependencies.persist();
    }
    if (!current || current.pendingTurn || !current.draft.actionId || current.draft.intent.trim() !== body) {
      clearGameChoiceEdit();
      return false;
    }
    dependencies.getState().draft = body;
    return setGameChoiceEdit(current);
  };

  const submitRestoredTurn = async (sourceUserText: string, timelineMutationOwner?: symbol) => {
    if (!restoreEditorAfterRollback(sourceUserText)) return false;
    const current = readActiveState();
    if (!current || !hasCurrentGameChoiceEdit(current)) return false;
    const body = dependencies.getState().draft.trim();
    if (!body) return false;
    const updated = updateGameDevelopmentDraft(current, { intent: body }, allowedTargetIds());
    if (updated.status === 'rejected') return false;
    writeState(updated.value, false);
    clearGameChoiceEdit();
    dependencies.persist();
    await submit(timelineMutationOwner);
    return true;
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
      root?.querySelector<HTMLButtonElement>('[data-action="game-submit-turn"]')?.addEventListener('click', () => {
        reviewInComposer();
      });
      root?.querySelector<HTMLButtonElement>('[data-action="game-retry-turn"]')?.addEventListener('click', () => {
        void submit();
      });
    },

    async initializeAfterRouteChoice(receipt, resolution) {
      const appState = dependencies.getState();
      clearGameChoiceEdit();
      const initial = createInitialGameDevelopmentState(receipt, resolution);
      commitGameDevelopmentState(appState.memoryDB, initial);
      await dependencies.persistImmediately();
    },

    async submitFromMainDraft(sourceUserText) {
      const current = readActiveState();
      if (!current) return false;
      if (!hasCurrentGameChoiceEdit(current)) return false;
      if (!current.pendingTurn && !current.draft.actionId) return false;
      const body = String(sourceUserText ?? '').trim();
      if (!body) {
        notify('正文尚未填写', '请在游戏开发选择框下方补充本回合正文或大纲后再记录。');
        dependencies.focusComposer();
        return true;
      }
      if (current.pendingTurn && body !== current.pendingTurn.intent.trim()) {
        dependencies.getState().draft = current.pendingTurn.intent;
        notify('回合内容已经冻结', '重试时不能改动已冻结的正文或大纲。');
        dependencies.focusComposer();
        return true;
      }
      if (!current.pendingTurn) {
        const updated = updateGameDevelopmentDraft(current, { intent: body }, allowedTargetIds());
        if (updated.status === 'rejected') {
          notify('正文不能提交', updated.reason);
          return true;
        }
        writeState(updated.value, false);
      }
      clearGameChoiceEdit();
      dependencies.persist();
      const submitted = await submit();
      if (!submitted) {
        const latest = readActiveState();
        if (latest && !latest.pendingTurn) setGameChoiceEdit(latest);
      }
      return true;
    },

    restoreEditorAfterRollback,
    submitRestoredTurn,
  };
}
