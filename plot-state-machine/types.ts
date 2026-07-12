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

/** 玩家最终选择只保留三条 family；variant 仅用于剧情倾向和旧存档兼容。 */
export type PlotRouteId = PlotRouteFamilyId;

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
  /**
   * @deprecated 只供尚未迁移的预览/合同调用方读取；当前 DDL 由 SAE_07-8 权威生命周期决定。
   */
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

export type PlotRouteFamilyAdvisory = {
  id: PlotRouteFamilyId;
  label: string;
  /** 当前事实最接近的内部剧情细分，只用于提示玩家，不是选择资格。 */
  bestVariantId: PlotRouteVariantId;
  satisfiedFlagIds: string[];
  missingFlagIds: string[];
};

type PlotRouteChoiceReceiptBase = {
  machineId: PlotMachineId;
  familyId: PlotRouteFamilyId;
  confirmedAt: string;
  source: 'manual';
};

export type PlotRouteChoiceReceipt =
  | (PlotRouteChoiceReceiptBase & {
      /** 旧五变体 receipt；这些字段在 v1 必须完整存在，才能安全读取旧存档。 */
      schemaVersion: 1;
      variantId: PlotRouteVariantId;
      basisHash: string;
      basisFlagIds: string[];
      confirmationId?: never;
      anchorFloorIndex?: never;
    })
  | (PlotRouteChoiceReceiptBase & {
      /** 当前三线玩家选择；确认实例和楼层锚点共同隔离回退后的新时间线。 */
      schemaVersion: 2;
      confirmationId: string;
      anchorFloorIndex: number;
      /** 兼容早期候选数据；v2 的权威选择仍只看 familyId。 */
      variantId?: PlotRouteVariantId;
      basisHash?: string;
      basisFlagIds?: string[];
    });

export type PlotRouteResolution = {
  machineId: PlotMachineId;
  routes: PlotRouteEligibility[];
  families: PlotRouteFamilyAdvisory[];
  eligibleRouteIds: PlotRouteVariantId[];
  choice: PlotRouteFamilyId | null;
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

// 中文注释：outside_choice_window / route_not_eligible 只为旧预览和合同脚本保留。
// 当前三线确认不按日期上界或 flag eligibility 拒绝玩家，生产路径不再产生这两个错误码。
export type PlotRouteChoiceConfirmationErrorCode =
  | 'not_manual'
  | 'missing_date'
  | 'missing_anchor'
  | 'outside_choice_window'
  | 'ddl_not_reached'
  | 'unknown_route'
  | 'route_not_eligible'
  | 'choice_locked';

export type PlotRouteChoiceConfirmationResult =
  | {
      status: 'accepted';
      changed: true;
      choice: PlotRouteFamilyId;
      commit: PlotRouteChoiceCommit;
      resolution: PlotRouteResolution;
    }
  | {
      status: 'unchanged';
      changed: false;
      choice: PlotRouteFamilyId;
      commit: null;
      resolution: PlotRouteResolution;
    }
  | {
      status: 'rejected';
      changed: false;
      choice: PlotRouteFamilyId | null;
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
