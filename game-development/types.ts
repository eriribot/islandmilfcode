import type { PlotRouteFamilyId, PlotRouteVariantId } from '../plot-state-machine/types';

export type GameDevelopmentTurnPhase = 'workday' | 'weekend';

export type GameDevelopmentWorkActionId = 'art' | 'scenario' | 'music' | 'programming';

export type GameDevelopmentWeekendActionId = 'rest_date';

export type GameDevelopmentActionId = GameDevelopmentWorkActionId | GameDevelopmentWeekendActionId;

export type GameDevelopmentTurnStatus = 'draft' | 'prepared' | 'generating' | 'commit_pending' | 'failed' | 'completed';

export type GameDevelopmentTurnFailurePhase = 'generation' | 'accepted_commit';

export type GameDevelopmentProjectStatus = 'not_created' | 'active' | 'completed' | 'deadline_reached';

declare const gameDevelopmentActionInstanceIdBrand: unique symbol;
declare const gameDevelopmentAssistantMessageIdBrand: unique symbol;
declare const gameDevelopmentGenerationAttemptIdBrand: unique symbol;

export type GameDevelopmentActionInstanceId = string & {
  readonly [gameDevelopmentActionInstanceIdBrand]: true;
};

// This ID must survive save/load; a UiMessage ID regenerated during deserialization is not valid here.
export type GameDevelopmentAssistantMessageId = string & {
  readonly [gameDevelopmentAssistantMessageIdBrand]: true;
};

export type GameDevelopmentGenerationAttemptId = string & {
  readonly [gameDevelopmentGenerationAttemptIdBrand]: true;
};

export type GameDevelopmentAssistantMessageIdentity = {
  readonly schemaVersion: 1;
  readonly kind: 'persisted_app_message';
  readonly runId: string;
  readonly assistantMessageId: GameDevelopmentAssistantMessageId;
  readonly hostMessageId: number | null;
};

export type GameDevelopmentAssistantReceipt = {
  readonly schemaVersion: 1;
  readonly actionInstanceId: GameDevelopmentActionInstanceId;
  readonly frozenPayloadFingerprint: string;
  readonly generationAttemptId: GameDevelopmentGenerationAttemptId;
  readonly messageIdentity: GameDevelopmentAssistantMessageIdentity;
  readonly generationSource: 'tavern_generate' | 'tavern_generate_raw';
  readonly sceneFingerprint: string;
  readonly acceptedAt: string;
  readonly receiptFingerprint: string;
};

export type GameDevelopmentProject = {
  readonly title: string;
  readonly genre: string;
  readonly theme: string;
  readonly platform: string;
  // Display label only; GameDevelopmentState.projectStatus is the lifecycle authority.
  readonly phase: string;
  readonly weeksLeft: number;
  readonly budget: number;
  readonly progress: number;
  readonly fun: number;
  readonly creativity: number;
  readonly writing: number;
  readonly art: number;
  readonly music: number;
  readonly code: number;
  readonly polish: number;
  readonly hype: number;
  readonly bugs: number;
  readonly fatigue: number;
};

export type GameDevelopmentProjectMetric =
  | 'budget'
  | 'progress'
  | 'fun'
  | 'creativity'
  | 'writing'
  | 'art'
  | 'music'
  | 'code'
  | 'polish'
  | 'hype'
  | 'bugs'
  | 'fatigue';

export type GameDevelopmentProjectDeltas = Readonly<Partial<Record<GameDevelopmentProjectMetric, number>>>;

export type GameDevelopmentSettlement = {
  readonly deltas: GameDevelopmentProjectDeltas;
  readonly nextProjectPhaseLabel: string;
};

type GameDevelopmentTurnDraftFields = {
  readonly selectedTargetId: string | null;
  readonly intent: string;
  readonly revision: number;
};

export type GameDevelopmentTurnDraft = GameDevelopmentTurnDraftFields &
  (
    | {
        readonly phase: 'workday';
        readonly actionId: GameDevelopmentWorkActionId | null;
      }
    | {
        readonly phase: 'weekend';
        readonly actionId: GameDevelopmentWeekendActionId | null;
      }
  );

export type GameDevelopmentWorkdayTurnDraft = Extract<GameDevelopmentTurnDraft, { readonly phase: 'workday' }>;

export type GameDevelopmentWeekendTurnDraft = Extract<GameDevelopmentTurnDraft, { readonly phase: 'weekend' }>;

export type GameDevelopmentPreparedWorkdayDraft = Omit<GameDevelopmentWorkdayTurnDraft, 'actionId'> & {
  readonly actionId: GameDevelopmentWorkActionId;
};

export type GameDevelopmentPreparedWeekendDraft = Omit<GameDevelopmentWeekendTurnDraft, 'actionId'> & {
  readonly actionId: GameDevelopmentWeekendActionId;
};

type GameDevelopmentRollbackSnapshotFields = {
  readonly project: GameDevelopmentProject;
  readonly projectStatus: 'active';
  readonly week: number;
  readonly calendarWeekStart: string;
  readonly completedTurnCount: number;
  readonly completedTurnPrefixFingerprint: string;
  readonly migration: GameDevelopmentMigrationProvenance | null;
};

export type GameDevelopmentWorkdayRollbackSnapshot = GameDevelopmentRollbackSnapshotFields & {
  readonly activePhase: 'workday';
  readonly draft: GameDevelopmentPreparedWorkdayDraft;
};

export type GameDevelopmentWeekendRollbackSnapshot = GameDevelopmentRollbackSnapshotFields & {
  readonly activePhase: 'weekend';
  readonly draft: GameDevelopmentPreparedWeekendDraft;
};

export type GameDevelopmentRollbackSnapshot =
  | GameDevelopmentWorkdayRollbackSnapshot
  | GameDevelopmentWeekendRollbackSnapshot;

type GameDevelopmentMigrationProvenanceFields = {
  readonly sourceStorageKey: 'gameDevelopment.v1.state';
  readonly sourceWeek: number;
  readonly sourceStateFingerprint: string;
  readonly baselineStateFingerprint: string;
  readonly strategy: 'legacy_weekly_state_preserved_as_non_rollback_baseline';
  readonly draftSlotsDisposition: 'discarded_without_settlement';
  readonly migratedAt: string;
};

export type GameDevelopmentMigrationProvenance = GameDevelopmentMigrationProvenanceFields &
  (
    | {
        readonly sourceSchemaVersion: 1;
        readonly sourceRouteConfirmationId: null;
      }
    | {
        readonly sourceSchemaVersion: 2;
        readonly sourceRouteConfirmationId: string;
      }
  ) &
  (
    | {
        readonly sourceLastSubmissionId: null;
        readonly lastSubmissionDisposition: 'absent';
      }
    | {
        readonly sourceLastSubmissionId: string;
        readonly lastSubmissionDisposition: 'discarded_as_already_reflected_in_project_baseline';
      }
  );

type FrozenGameDevelopmentTurnFields = {
  readonly actionInstanceId: GameDevelopmentActionInstanceId;
  readonly routeConfirmationId: string;
  readonly routeFamily: PlotRouteFamilyId;
  readonly routeVariant: PlotRouteVariantId;
  readonly routeEnteredAt: string;
  readonly week: number;
  readonly selectedTargetId: string | null;
  readonly intent: string;
  readonly draftRevision: number;
  readonly preparedAt: string;
  readonly settlement: GameDevelopmentSettlement;
  readonly promptVersion: string;
  // Hash canonical frozen fields except context and this hash; rebuilt context must then byte-match context.
  readonly frozenPayloadFingerprint: string;
  readonly context: string;
};

type FrozenGameDevelopmentTurn = FrozenGameDevelopmentTurnFields &
  (
    | {
        readonly phase: 'workday';
        readonly actionId: GameDevelopmentWorkActionId;
        readonly preTurnSnapshot: GameDevelopmentWorkdayRollbackSnapshot;
      }
    | {
        readonly phase: 'weekend';
        readonly actionId: GameDevelopmentWeekendActionId;
        readonly preTurnSnapshot: GameDevelopmentWeekendRollbackSnapshot;
      }
  );

export type PreparedGameDevelopmentTurn =
  | (FrozenGameDevelopmentTurn & {
      readonly status: 'prepared';
      readonly generationAttemptId: null;
      readonly failurePhase: null;
      readonly assistantReceipt: null;
      readonly failureReason: null;
      readonly completedAt: null;
    })
  | (FrozenGameDevelopmentTurn & {
      readonly status: 'generating';
      readonly generationAttemptId: GameDevelopmentGenerationAttemptId;
      readonly failurePhase: null;
      readonly assistantReceipt: null;
      readonly failureReason: null;
      readonly completedAt: null;
    })
  | (FrozenGameDevelopmentTurn & {
      readonly status: 'commit_pending';
      readonly generationAttemptId: GameDevelopmentGenerationAttemptId;
      readonly failurePhase: null;
      readonly assistantReceipt: GameDevelopmentAssistantReceipt;
      readonly failureReason: null;
      readonly completedAt: null;
    })
  | (FrozenGameDevelopmentTurn & {
      readonly status: 'failed';
      readonly generationAttemptId: GameDevelopmentGenerationAttemptId;
      readonly failurePhase: 'generation';
      readonly assistantReceipt: null;
      readonly failureReason: string;
      readonly completedAt: null;
    })
  | (FrozenGameDevelopmentTurn & {
      readonly status: 'failed';
      readonly generationAttemptId: GameDevelopmentGenerationAttemptId;
      readonly failurePhase: 'accepted_commit';
      readonly assistantReceipt: GameDevelopmentAssistantReceipt;
      readonly failureReason: string;
      readonly completedAt: null;
    })
  | (FrozenGameDevelopmentTurn & {
      readonly status: 'completed';
      readonly generationAttemptId: GameDevelopmentGenerationAttemptId;
      readonly failurePhase: null;
      readonly assistantReceipt: GameDevelopmentAssistantReceipt;
      readonly failureReason: null;
      readonly completedAt: string;
    });

export type PendingGameDevelopmentTurn = Exclude<PreparedGameDevelopmentTurn, { readonly status: 'completed' }>;

export type CompletedGameDevelopmentTurn = Extract<PreparedGameDevelopmentTurn, { readonly status: 'completed' }>;

export type WorkdayPendingGameDevelopmentTurn = PendingGameDevelopmentTurn & {
  readonly phase: 'workday';
  readonly actionId: GameDevelopmentWorkActionId;
};

export type WeekendPendingGameDevelopmentTurn = PendingGameDevelopmentTurn & {
  readonly phase: 'weekend';
  readonly actionId: GameDevelopmentWeekendActionId;
};

type GameDevelopmentActionDefinitionFields = {
  readonly label: string;
  readonly hint: string;
};

export type GameDevelopmentActionDefinition = GameDevelopmentActionDefinitionFields &
  (
    | {
        readonly id: GameDevelopmentWorkActionId;
        readonly turnPhase: 'workday';
      }
    | {
        readonly id: GameDevelopmentWeekendActionId;
        readonly turnPhase: 'weekend';
      }
  );

type GameDevelopmentStateFields = {
  readonly schemaVersion: 3;
  readonly routeConfirmationId: string;
  readonly routeFamily: PlotRouteFamilyId;
  readonly routeVariant: PlotRouteVariantId;
  readonly routeEnteredAt: string;
  readonly calendarWeekStart: string;
  readonly project: GameDevelopmentProject;
  readonly week: number;
  // The completed ledger is the sole idempotency authority; applied IDs are derived from it.
  readonly turnLedger: readonly CompletedGameDevelopmentTurn[];
  readonly migration: GameDevelopmentMigrationProvenance | null;
};

type GameDevelopmentActivePhaseState =
  | {
      readonly activePhase: 'workday';
      readonly draft: GameDevelopmentWorkdayTurnDraft;
      readonly pendingTurn: WorkdayPendingGameDevelopmentTurn | null;
    }
  | {
      readonly activePhase: 'weekend';
      readonly draft: GameDevelopmentWeekendTurnDraft;
      readonly pendingTurn: WeekendPendingGameDevelopmentTurn | null;
    };

type GameDevelopmentTerminalPhaseState =
  | {
      readonly activePhase: 'workday';
      readonly draft: GameDevelopmentWorkdayTurnDraft;
      readonly pendingTurn: null;
    }
  | {
      readonly activePhase: 'weekend';
      readonly draft: GameDevelopmentWeekendTurnDraft;
      readonly pendingTurn: null;
    };

export type GameDevelopmentState =
  | (GameDevelopmentStateFields & {
      readonly projectStatus: 'not_created';
      readonly activePhase: 'workday';
      readonly draft: GameDevelopmentWorkdayTurnDraft;
      readonly pendingTurn: null;
    })
  | (GameDevelopmentStateFields &
      GameDevelopmentActivePhaseState & {
        readonly projectStatus: 'active';
      })
  | (GameDevelopmentStateFields &
      GameDevelopmentTerminalPhaseState & {
        readonly projectStatus: 'completed';
      })
  | (GameDevelopmentStateFields & {
      readonly projectStatus: 'deadline_reached';
      readonly activePhase: 'workday';
      readonly draft: GameDevelopmentWorkdayTurnDraft;
      readonly pendingTurn: null;
    });
