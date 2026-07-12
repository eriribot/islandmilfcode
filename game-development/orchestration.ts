import {
  completeGameDevelopmentTurn,
  failGameDevelopmentTurn,
  markGameDevelopmentTurnCommitPending,
  markGameDevelopmentTurnGenerating,
  prepareGameDevelopmentTurn,
  retryGameDevelopmentCommit,
} from './state';
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
  readonly requireCompleteMainAssistant: true;
  readonly reuseLatestUserMessage: true;
  readonly onMainAssistantAccepted: (receipt: MainAssistantAcceptedReceipt) => void | Promise<void>;
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
    await dependencies.submitMainMessage({
      text: getGameDevelopmentFixedInput(pending.phase),
      keepDraft: true,
      clearDraftOnSuccess: false,
      gameDevelopmentContext: pending.context,
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

export function getGameDevelopmentFixedInput(phase: PendingGameDevelopmentTurn['phase']): string {
  return phase === 'workday' ? '（游戏开发：生成本周工作日回合正文）' : '（游戏开发：生成本周周末回合正文）';
}

export function isGameDevelopmentFixedInput(value: string): boolean {
  const normalized = String(value ?? '').trim();
  return (
    normalized === getGameDevelopmentFixedInput('workday') || normalized === getGameDevelopmentFixedInput('weekend')
  );
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
