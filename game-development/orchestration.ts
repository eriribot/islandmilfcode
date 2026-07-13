import {
  completeGameDevelopmentTurn,
  failGameDevelopmentTurn,
  markGameDevelopmentTurnCommitPending,
  markGameDevelopmentTurnGenerating,
  prepareGameDevelopmentTurn,
  retryGameDevelopmentCommit,
} from './state';
import { getGameDevelopmentPhaseCalendarRange } from './rules';
import type { GameDevelopmentState, PendingGameDevelopmentTurn } from './types';

type MainAssistantAcceptedReceipt = {
  readonly assistantMessageId: string;
  readonly hostMessageId: number | null;
  readonly sceneText: string;
  readonly generationSource: 'tavern_generate' | 'tavern_generate_raw';
  readonly acceptedAt: string;
};

export type GameDevelopmentSubmitMessageOptions = {
  readonly text: string;
  readonly keepDraft: boolean;
  readonly clearDraftOnSuccess: boolean;
  readonly gameDevelopmentContext: string;
  readonly gameDevelopmentTimeRange: GameDevelopmentTurnTimeRange;
  readonly requireCompleteMainAssistant: true;
  readonly reuseLatestUserMessage: true;
  readonly onMainAssistantAccepted: (receipt: MainAssistantAcceptedReceipt) => void | Promise<void>;
};

export type GameDevelopmentTurnTimeRange = {
  readonly startDate: string;
  readonly endDate: string;
  readonly completionTime: string;
};

export type GameDevelopmentOrchestrationDependencies = {
  readonly readState: () => GameDevelopmentState;
  readonly writeState: (state: GameDevelopmentState) => void;
  readonly persistImmediately: () => Promise<void>;
  readonly submitMainMessage: (options: GameDevelopmentSubmitMessageOptions) => Promise<void>;
  readonly allowedTargetIds: () => Iterable<string>;
  readonly runId: () => string;
  readonly now: () => string;
};

export type GameDevelopmentSubmissionResult =
  | { readonly status: 'accepted'; readonly state: GameDevelopmentState }
  | { readonly status: 'rejected'; readonly reason: string };

export async function submitGameDevelopmentTurn(
  dependencies: GameDevelopmentOrchestrationDependencies,
): Promise<GameDevelopmentSubmissionResult> {
  let state = dependencies.readState();
  if (state.projectStatus !== 'active') return rejected('项目当前不可推进。');

  if (!state.pendingTurn) {
    const prepared = prepareGameDevelopmentTurn(state, dependencies.now(), dependencies.allowedTargetIds());
    if (prepared.status === 'rejected') return prepared;
    state = prepared.value.state;
    dependencies.writeState(state);
    await dependencies.persistImmediately();
  }

  const pending = state.pendingTurn;
  if (!pending) return rejected('回合冻结失败。');

  if (
    pending.status === 'commit_pending' ||
    (pending.status === 'failed' && pending.failurePhase === 'accepted_commit')
  ) {
    return retryAcceptedCommit(dependencies, pending);
  }
  if (pending.status === 'generating') return rejected('这个回合正在生成，请等待当前请求结束。');

  const generating = markGameDevelopmentTurnGenerating(state, pending.actionInstanceId);
  if (generating.status === 'rejected') return generating;
  dependencies.writeState(generating.value);
  await dependencies.persistImmediately();

  try {
    const dateRange = getGameDevelopmentPhaseCalendarRange(
      {
        calendarWeekStart: pending.calendarWeekStart ?? pending.preTurnSnapshot.calendarWeekStart,
        routeEnteredAt: pending.routeEnteredAt,
        week: pending.week,
      },
      pending.phase,
    );
    await dependencies.submitMainMessage({
      text: pending.intent.trim(),
      keepDraft: true,
      clearDraftOnSuccess: true,
      gameDevelopmentContext: pending.context,
      gameDevelopmentTimeRange: {
        startDate: dateRange.start,
        endDate: dateRange.end,
        completionTime: pending.phase === 'workday' ? '18:00' : '22:00',
      },
      requireCompleteMainAssistant: true,
      reuseLatestUserMessage: true,
      onMainAssistantAccepted: receipt =>
        acceptAndCommitGameDevelopmentTurn(dependencies, pending.actionInstanceId, receipt),
    });
  } catch (error) {
    const latest = dependencies.readState();
    if (latest.turnLedger.some(turn => turn.actionInstanceId === pending.actionInstanceId)) {
      // Main narrative and deterministic settlement are already authoritative; secondary failures
      // must not make this turn eligible for narration again.
      return { status: 'accepted', state: latest };
    }
    {
      const failed = failGameDevelopmentTurn(latest, pending.actionInstanceId, errorMessage(error));
      if (failed.status === 'accepted') {
        dependencies.writeState(failed.value);
        try {
          await dependencies.persistImmediately();
        } catch {
          // The original persistence/generation error remains the user-visible cause.
        }
      }
    }
    throw error;
  }

  return { status: 'accepted', state: dependencies.readState() };
}

export async function retryGameDevelopmentCommitOnly(
  dependencies: GameDevelopmentOrchestrationDependencies,
): Promise<GameDevelopmentSubmissionResult> {
  const state = dependencies.readState();
  const pending = state.pendingTurn;
  if (!pending || pending.status !== 'failed' || pending.failurePhase !== 'accepted_commit') {
    return rejected('当前没有只需重试结算的回合。');
  }
  return retryAcceptedCommit(dependencies, pending);
}

export function getGameDevelopmentTargetLabel(value: string): string {
  const source = String(value ?? '').trim();
  const normalized = source.toLowerCase();
  if (/泽村小百合|澤村小百合|小百合|sayuri/.test(normalized)) return '泽村小百合';
  if (/町田苑子|町田|苑子|sonoko|machida/.test(normalized)) return '町田苑子';
  if (/高坂茜|红坂朱音|紅坂朱音|朱音|akane|kosaka|kousaka|kurenai/.test(normalized)) return '红坂朱音';
  if (/西宫硝子|西宮硝子|西宫|西宮|硝子|shoko|shouko|nishimiya/.test(normalized)) return '西宫硝子';
  if (/英梨梨|eriri|sawamura/.test(normalized)) return '泽村·斯宾塞·英梨梨';
  if (/加藤|惠|恵|megumi|katou|kato/.test(normalized)) return '加藤惠';
  if (/霞之丘|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(normalized)) return '霞之丘诗羽';
  if (/波岛|波島|出海|izumi|hashima/.test(normalized)) return '波岛出海';
  if (/冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(normalized)) return '冰堂美智留';
  return source.match(/[\u3400-\u9fff]+/g)?.join('') || '未命名角色';
}

async function acceptAndCommitGameDevelopmentTurn(
  dependencies: GameDevelopmentOrchestrationDependencies,
  actionInstanceId: string,
  receipt: MainAssistantAcceptedReceipt,
): Promise<void> {
  const latest = dependencies.readState();
  const commitPending = markGameDevelopmentTurnCommitPending(latest, actionInstanceId, {
    ...receipt,
    runId: dependencies.runId(),
  });
  if (commitPending.status === 'rejected') throw new Error(commitPending.reason);

  // The accepted assistant message and commit_pending receipt share this durable boundary.
  dependencies.writeState(commitPending.value);
  await dependencies.persistImmediately();

  const completed = completeGameDevelopmentTurn(commitPending.value, actionInstanceId, dependencies.now());
  if (completed.status === 'rejected') throw new Error(completed.reason);
  dependencies.writeState(completed.value);
  await dependencies.persistImmediately();
}

async function retryAcceptedCommit(
  dependencies: GameDevelopmentOrchestrationDependencies,
  pending: PendingGameDevelopmentTurn,
): Promise<GameDevelopmentSubmissionResult> {
  const state = dependencies.readState();
  const completed =
    pending.status === 'commit_pending'
      ? completeGameDevelopmentTurn(state, pending.actionInstanceId, dependencies.now())
      : retryGameDevelopmentCommit(state, dependencies.now());
  if (completed.status === 'rejected') return completed;
  dependencies.writeState(completed.value);
  await dependencies.persistImmediately();
  return { status: 'accepted', state: completed.value };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知失败');
}

function rejected(reason: string): GameDevelopmentSubmissionResult {
  return { status: 'rejected', reason };
}
