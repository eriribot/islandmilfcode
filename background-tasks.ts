import type { AppState, BackgroundTaskKind } from './types';

const BACKGROUND_TASK_LABELS: Record<BackgroundTaskKind, string> = {
  progress: '变量更新中',
  summary: '总结中',
};

export function setBackgroundTaskRunning(state: AppState, kind: BackgroundTaskKind, detail?: string) {
  const now = Date.now();
  const existing = state.backgroundTasks.find(task => task.kind === kind);
  if (existing) {
    existing.status = 'running';
    existing.label = BACKGROUND_TASK_LABELS[kind];
    existing.detail = detail;
    existing.updatedAt = now;
    return;
  }

  state.backgroundTasks = [
    ...state.backgroundTasks,
    {
      kind,
      label: BACKGROUND_TASK_LABELS[kind],
      status: 'running',
      detail,
      startedAt: now,
      updatedAt: now,
    },
  ];
}

export function clearBackgroundTask(state: AppState, kind: BackgroundTaskKind) {
  state.backgroundTasks = state.backgroundTasks.filter(task => task.kind !== kind);
}

export function setBackgroundTaskFailed(state: AppState, kind: BackgroundTaskKind, error: unknown) {
  const now = Date.now();
  const detail = error instanceof Error ? error.message : String(error);
  const existing = state.backgroundTasks.find(task => task.kind === kind);
  if (existing) {
    existing.status = 'failed';
    existing.label = `${BACKGROUND_TASK_LABELS[kind].replace(/中$/, '')}失败`;
    existing.detail = detail;
    existing.updatedAt = now;
    return;
  }

  state.backgroundTasks = [
    ...state.backgroundTasks,
    {
      kind,
      label: `${BACKGROUND_TASK_LABELS[kind].replace(/中$/, '')}失败`,
      status: 'failed',
      detail,
      startedAt: now,
      updatedAt: now,
    },
  ];
}
