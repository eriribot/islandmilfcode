import type {
  GameDevelopmentActionId,
  GameDevelopmentActionInstanceId,
  GameDevelopmentAssistantReceipt,
  GameDevelopmentProject,
  GameDevelopmentSettlement,
  GameDevelopmentTurnPhase,
  PreparedGameDevelopmentTurn,
} from './types';

export const GAME_DEVELOPMENT_PROMPT_VERSION = 'game-development-turn.v1';

export type GameDevelopmentFrozenPayload = {
  readonly actionInstanceId: GameDevelopmentActionInstanceId;
  readonly routeConfirmationId: string;
  readonly routeFamily: string;
  readonly routeVariant: string;
  readonly routeEnteredAt: string;
  readonly week: number;
  readonly phase: GameDevelopmentTurnPhase;
  readonly actionId: GameDevelopmentActionId;
  readonly selectedTargetId: string | null;
  readonly intent: string;
  readonly draftRevision: number;
  readonly preparedAt: string;
  readonly settlement: GameDevelopmentSettlement;
  readonly promptVersion: string;
};

export function buildGameDevelopmentFrozenPayloadFingerprint(payload: GameDevelopmentFrozenPayload): string {
  return fingerprintGameDevelopmentValue(payload);
}

export function buildGameDevelopmentNarrativeContext(
  payload: GameDevelopmentFrozenPayload & { readonly frozenPayloadFingerprint: string },
  project: GameDevelopmentProject,
): string {
  return [
    '[GAME_DEVELOPMENT_TURN]',
    `action_instance_id=${payload.actionInstanceId}`,
    `route_confirmation_id=${payload.routeConfirmationId}`,
    `route_family=${payload.routeFamily}`,
    `route_variant=${payload.routeVariant}`,
    `route_entered_at=${payload.routeEnteredAt}`,
    `week=${payload.week}`,
    `phase=${payload.phase}`,
    `action_id=${payload.actionId}`,
    `target_id=${payload.selectedTargetId ?? 'none'}`,
    `intent=${singleLine(payload.intent) || 'none'}`,
    `project_title=${singleLine(project.title)}`,
    `project_phase_before_turn=${singleLine(project.phase)}`,
    `settlement_read_only=${canonicalStringify(payload.settlement)}`,
    `prompt_version=${payload.promptVersion}`,
    `frozen_payload_fingerprint=${payload.frozenPayloadFingerprint}`,
    'narrative_contract=只写本回合小说正文；不得改选行动、对象或意图；不得重算或修改 settlement。',
    payload.phase === 'workday'
      ? 'phase_boundary=只演出本周工作日开发，不提前演出周末安排。'
      : 'phase_boundary=只演出本周周末休息或约会，不追加第二次开发结算。',
    'channel_boundary=规划、调试文本、数值表和结算说明不得进入 Galgame 可见正文。',
    '[/GAME_DEVELOPMENT_TURN]',
  ].join('\n');
}

export function verifyGameDevelopmentTurnContext(turn: PreparedGameDevelopmentTurn): boolean {
  const payload = frozenPayloadFromTurn(turn);
  const fingerprint = buildGameDevelopmentFrozenPayloadFingerprint(payload);
  if (fingerprint !== turn.frozenPayloadFingerprint) return false;
  return (
    turn.context ===
    buildGameDevelopmentNarrativeContext(
      { ...payload, frozenPayloadFingerprint: fingerprint },
      turn.preTurnSnapshot.project,
    )
  );
}

export function buildGameDevelopmentSceneFingerprint(sceneText: string): string {
  return fingerprintGameDevelopmentValue({ sceneText: String(sceneText ?? '').trim() });
}

export function buildGameDevelopmentReceiptFingerprint(
  receipt: Omit<GameDevelopmentAssistantReceipt, 'receiptFingerprint'>,
): string {
  return fingerprintGameDevelopmentValue(receipt);
}

export function verifyGameDevelopmentAssistantReceipt(receipt: GameDevelopmentAssistantReceipt): boolean {
  const { receiptFingerprint, ...base } = receipt;
  return (
    receipt.frozenPayloadFingerprint.length > 0 &&
    receipt.sceneFingerprint.length > 0 &&
    buildGameDevelopmentReceiptFingerprint(base) === receiptFingerprint
  );
}

export function fingerprintGameDevelopmentValue(value: unknown): string {
  const input = canonicalStringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `gd-${hex(first)}${hex(second)}`;
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => canonicalStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(',')}}`;
}

function frozenPayloadFromTurn(turn: PreparedGameDevelopmentTurn): GameDevelopmentFrozenPayload {
  return {
    actionInstanceId: turn.actionInstanceId,
    routeConfirmationId: turn.routeConfirmationId,
    routeFamily: turn.routeFamily,
    routeVariant: turn.routeVariant,
    routeEnteredAt: turn.routeEnteredAt,
    week: turn.week,
    phase: turn.phase,
    actionId: turn.actionId,
    selectedTargetId: turn.selectedTargetId,
    intent: turn.intent,
    draftRevision: turn.draftRevision,
    preparedAt: turn.preparedAt,
    settlement: turn.settlement,
    promptVersion: turn.promptVersion,
  };
}

function singleLine(value: string): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
