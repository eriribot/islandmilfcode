import type { IslandMemoryDB } from '../memorydatabase/types';

export type PlotMachineId = 'v07';

export type PlotFlagValue = 'yes' | 'no';

export type PlotRouteFamilyId = 'stay' | 'akane' | 'solo';

export type PlotRouteVariantId =
  | 'stay_blackgold'
  | 'stay_user_only'
  | 'akane_core'
  | 'solo_user_exit'
  | 'solo_group_exit_except_tomoya';

/** 兼容旧调用方的类型名；权威 choice 已从 family 升级为具体 variant。 */
export type PlotRouteId = PlotRouteVariantId;

export type PlotDateWindow = {
  start: string;
  end: string;
};

export type PlotFlagDefinition = {
  id: string;
  storageKey: `plotFlag.${string}`;
  earliestDate: string;
  label: string;
  yesMeaning: string;
  noMeaning: string;
};

export type PlotRouteDefinition = {
  id: PlotRouteVariantId;
  familyId: PlotRouteFamilyId;
  label: string;
  requiredFlagIds: readonly string[];
};

export type PlotMachineDefinition = {
  id: PlotMachineId;
  targetId: string;
  title: string;
  proposalWindow: PlotDateWindow;
  promptWindow: PlotDateWindow;
  choiceStorageKey: `plotRoute.${string}.choice`;
  routes: readonly PlotRouteDefinition[];
  flags: readonly PlotFlagDefinition[];
};

export type PlotFlagDelta = {
  machineId: PlotMachineId;
  flagId: string;
  storageKey: `plotFlag.${string}`;
  value: PlotFlagValue;
};

export type PlotFlagSnapshot = {
  definition: PlotFlagDefinition;
  value: PlotFlagValue;
};

export type PlotFlagValueMap = Readonly<Record<string, PlotFlagValue | undefined>>;

export type PlotFlagProposalDelta = {
  flagId: string;
  value: PlotFlagValue;
  evidenceQuote: string;
};

export type PlotFlagProposal = {
  checked: true;
  deltas: PlotFlagProposalDelta[];
};

export type ValidatedPlotFlagDelta = PlotFlagProposalDelta & {
  machineId: PlotMachineId;
  storageKey: `plotFlag.${string}`;
};

export type PlotFlagReviewErrorCode =
  | 'outside_proposal_window'
  | 'missing_date'
  | 'missing_tag'
  | 'multiple_tags'
  | 'unexpected_text'
  | 'invalid_json'
  | 'invalid_shape'
  | 'unknown_field'
  | 'unknown_flag'
  | 'duplicate_flag'
  | 'invalid_value'
  | 'flag_date_locked'
  | 'evidence_too_short'
  | 'evidence_not_found'
  | 'latched_yes_cannot_clear';

export type PlotFlagReviewError = {
  code: PlotFlagReviewErrorCode;
  message: string;
  flagId?: string;
};

export type PlotFlagReviewResult =
  | {
      status: 'accepted' | 'accepted_no_change';
      proposal: PlotFlagProposal;
      deltas: ValidatedPlotFlagDelta[];
      errors: [];
    }
  | {
      status: 'rejected';
      proposal: PlotFlagProposal | null;
      deltas: [];
      errors: PlotFlagReviewError[];
    };

export type PlotRouteEligibility = {
  id: PlotRouteVariantId;
  familyId: PlotRouteFamilyId;
  label: string;
  eligible: boolean;
  satisfiedFlagIds: string[];
  missingFlagIds: string[];
};

export type PlotRouteChoiceReceipt = {
  schemaVersion: 1;
  machineId: PlotMachineId;
  familyId: PlotRouteFamilyId;
  variantId: PlotRouteVariantId;
  confirmedAt: string;
  source: 'manual';
  basisHash: string;
  basisFlagIds: string[];
};

export type PlotRouteResolution = {
  machineId: PlotMachineId;
  routes: PlotRouteEligibility[];
  eligibleRouteIds: PlotRouteVariantId[];
  choice: PlotRouteVariantId | null;
  choiceReceipt: PlotRouteChoiceReceipt | null;
  choiceState: 'unchosen' | 'chosen' | 'needs_review';
  needsReviewReason: string | null;
  rejectedChoice: string | null;
};

export type PlotRouteChoiceCommit = {
  targetId: string;
  key: `plotRoute.${string}.choice`;
  value: string;
  valueType: 'json';
  source: 'manual';
  receipt: PlotRouteChoiceReceipt;
};

export type PlotRouteChoiceConfirmationErrorCode =
  | 'not_manual'
  | 'missing_date'
  | 'outside_choice_window'
  | 'unknown_route'
  | 'route_not_eligible'
  | 'choice_locked';

export type PlotRouteChoiceConfirmationResult =
  | {
      status: 'accepted';
      changed: true;
      choice: PlotRouteVariantId;
      commit: PlotRouteChoiceCommit;
      resolution: PlotRouteResolution;
    }
  | {
      status: 'unchanged';
      changed: false;
      choice: PlotRouteVariantId;
      commit: null;
      resolution: PlotRouteResolution;
    }
  | {
      status: 'rejected';
      changed: false;
      choice: PlotRouteVariantId | null;
      commit: null;
      error: {
        code: PlotRouteChoiceConfirmationErrorCode;
        message: string;
      };
      resolution: PlotRouteResolution;
    };

export type PlotFlagCommitContext = {
  db: IslandMemoryDB;
  currentTime?: string;
  sourceRange?: [number, number];
};
