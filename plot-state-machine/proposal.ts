import { extractPlotDate, isPlotDateInWindow } from './date-window';
import { buildPlotEvidenceUnits } from './proposal-prompt';
import type {
  PlotFlagProposal,
  PlotFlagProposalDelta,
  PlotFlagReviewError,
  PlotFlagReviewResult,
  PlotFlagValueMap,
  PlotMachineDefinition,
  ValidatedPlotFlagDelta,
} from './types';

const PROPOSAL_TAG_RE = /<plot_flag_proposal>([\s\S]*?)<\/plot_flag_proposal>/gi;
const EVIDENCE_REFERENCE_TOKEN_RE = /^E(\d{4,})$/i;
const EVIDENCE_REFERENCE_LIKE_RE = /^E[^\p{L}\p{N}]*\d/iu;
const PROPOSAL_FIELDS = new Set(['checked', 'deltas']);
const DELTA_FIELDS = new Set(['flagId', 'value', 'evidenceQuote']);

export type PlotFlagReviewContext = {
  machine: PlotMachineDefinition;
  currentTime?: string;
  sceneText: string;
  currentValues?: PlotFlagValueMap;
};

export function reviewPlotFlagProposal(rawResponse: string, context: PlotFlagReviewContext): PlotFlagReviewResult {
  const currentDate = extractPlotDate(context.currentTime);
  if (!currentDate) {
    return rejected(null, [{ code: 'missing_date', message: '当前剧情时间没有合法 YYYY-MM-DD 日期。' }]);
  }
  if (!isPlotDateInWindow(currentDate, context.machine.proposalWindow)) {
    return rejected(null, [
      {
        code: 'outside_proposal_window',
        message: `日期 ${currentDate} 不在 ${context.machine.proposalWindow.start} 至 ${context.machine.proposalWindow.end} 的提案窗内。`,
      },
    ]);
  }

  const raw = String(rawResponse ?? '');
  const matches = [...raw.matchAll(PROPOSAL_TAG_RE)];
  if (!matches.length) {
    return rejected(null, [{ code: 'missing_tag', message: '缺少 <plot_flag_proposal> 标签。' }]);
  }
  if (matches.length !== 1) {
    return rejected(null, [{ code: 'multiple_tags', message: '一次响应只能包含一个提案标签。' }]);
  }

  const outside = raw.replace(matches[0][0], '').trim();
  if (outside) {
    return rejected(null, [{ code: 'unexpected_text', message: '提案标签外存在额外文本。' }]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0][1]);
  } catch {
    return rejected(null, [{ code: 'invalid_json', message: '提案标签内不是合法 JSON。' }]);
  }

  const shape = parseProposalShape(parsed);
  if (shape.errors.length || !shape.proposal) return rejected(null, shape.errors);

  const proposal = shape.proposal;
  const errors: PlotFlagReviewError[] = [];
  const validated: ValidatedPlotFlagDelta[] = [];
  const seen = new Set<string>();
  const evidenceUnits = buildPlotEvidenceUnits(context.sceneText);
  const evidenceUnitMap = new Map(evidenceUnits.map(unit => [unit.id, unit.text]));

  for (const delta of proposal.deltas) {
    if (seen.has(delta.flagId)) {
      errors.push({ code: 'duplicate_flag', flagId: delta.flagId, message: `同一提案重复声明 ${delta.flagId}。` });
      continue;
    }
    seen.add(delta.flagId);

    const definition = context.machine.flags.find(flag => flag.id === delta.flagId);
    if (!definition) {
      errors.push({ code: 'unknown_flag', flagId: delta.flagId, message: `未知剧情事实 ${delta.flagId}。` });
      continue;
    }
    if (currentDate < definition.earliestDate) {
      errors.push({
        code: 'flag_date_locked',
        flagId: delta.flagId,
        message: `${delta.flagId} 最早只能在 ${definition.earliestDate} 写入。`,
      });
    }

    const resolvedEvidence = resolveEvidenceQuote(delta.evidenceQuote, evidenceUnitMap);
    const normalizedQuote = normalizeEvidence(resolvedEvidence.quote ?? '');
    let evidenceQuoteForCommit = resolvedEvidence.quote;
    if (resolvedEvidence.isReference && !resolvedEvidence.quote) {
      errors.push({
        code: 'evidence_not_found',
        flagId: delta.flagId,
        message: `${delta.flagId} 引用了不存在、重复或超量的证据单元。`,
      });
    } else if ([...normalizedQuote].length < 4) {
      errors.push({
        code: 'evidence_too_short',
        flagId: delta.flagId,
        message: `${delta.flagId} 的证据少于四个可见字符。`,
      });
    } else if (!resolvedEvidence.isReference) {
      const sourceUnit = findNormalizedEvidenceUnit(delta.evidenceQuote, evidenceUnits.map(unit => unit.text));
      if (sourceUnit) {
        evidenceQuoteForCommit = sourceUnit;
      } else {
        errors.push({
          code: 'evidence_not_found',
          flagId: delta.flagId,
          message: `${delta.flagId} 的证据在本轮正文中没有可核对的来源。`,
        });
      }
    }

    const currentValue = context.currentValues?.[delta.flagId];
    if (currentValue === 'yes' && delta.value === 'no') {
      errors.push({
        code: 'latched_yes_cannot_clear',
        flagId: delta.flagId,
        message: `${delta.flagId} 已成立，不能由 AI 降回 no。`,
      });
    }

    if (currentValue !== delta.value && evidenceQuoteForCommit) {
      validated.push({
        machineId: context.machine.id,
        flagId: definition.id,
        storageKey: definition.storageKey,
        value: delta.value,
        evidenceQuote: evidenceQuoteForCommit,
      });
    }
  }

  if (errors.length) return rejected(proposal, errors);
  return {
    status: validated.length ? 'accepted' : 'accepted_no_change',
    proposal,
    deltas: validated,
    errors: [],
  };
}

function parseProposalShape(value: unknown): { proposal: PlotFlagProposal | null; errors: PlotFlagReviewError[] } {
  if (!isRecord(value)) {
    return { proposal: null, errors: [{ code: 'invalid_shape', message: '提案必须是 JSON object。' }] };
  }

  const errors: PlotFlagReviewError[] = [];
  for (const key of Object.keys(value)) {
    if (!PROPOSAL_FIELDS.has(key)) errors.push({ code: 'unknown_field', message: `提案包含未知字段 ${key}。` });
  }
  if (value.checked !== true || !Array.isArray(value.deltas)) {
    errors.push({ code: 'invalid_shape', message: '提案必须包含 checked:true 和 deltas 数组。' });
    return { proposal: null, errors };
  }

  const deltas: PlotFlagProposalDelta[] = [];
  value.deltas.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push({ code: 'invalid_shape', message: `deltas[${index}] 必须是 object。` });
      return;
    }
    for (const key of Object.keys(item)) {
      if (!DELTA_FIELDS.has(key))
        errors.push({ code: 'unknown_field', message: `deltas[${index}] 包含未知字段 ${key}。` });
    }
    if (typeof item.flagId !== 'string' || typeof item.evidenceQuote !== 'string') {
      errors.push({ code: 'invalid_shape', message: `deltas[${index}] 缺少字符串 flagId/evidenceQuote。` });
      return;
    }
    if (item.value !== 'yes' && item.value !== 'no') {
      errors.push({ code: 'invalid_value', flagId: item.flagId, message: `${item.flagId} 的 value 只能是 yes/no。` });
      return;
    }
    deltas.push({ flagId: item.flagId, value: item.value, evidenceQuote: item.evidenceQuote });
  });

  return errors.length ? { proposal: null, errors } : { proposal: { checked: true, deltas }, errors: [] };
}

function normalizeEvidence(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .trim();
}

function resolveEvidenceQuote(
  rawEvidence: string,
  evidenceUnitMap: ReadonlyMap<string, string>,
): { quote: string | null; isReference: boolean } {
  const rawValue = String(rawEvidence ?? '').trim();
  const value = rawValue.normalize('NFKC');
  if (!EVIDENCE_REFERENCE_LIKE_RE.test(value)) return { quote: rawValue, isReference: false };

  const parts = value.split(/[,，、]/).map(part => part.trim());
  const matches = parts.map(part => part.match(EVIDENCE_REFERENCE_TOKEN_RE));
  if (!parts.length || parts.length > 4 || matches.some(match => !match)) {
    return { quote: null, isReference: true };
  }
  const ids = parts.map(part => part.toUpperCase());
  const positions = matches.map(match => Number(match?.[1]));
  if (
    new Set(ids).size !== ids.length ||
    positions.some((position, index) => index > 0 && position <= positions[index - 1])
  ) {
    return { quote: null, isReference: true };
  }
  const units = ids.map(id => evidenceUnitMap.get(id));
  if (units.some(unit => unit === undefined)) return { quote: null, isReference: true };
  return { quote: units.join('\n'), isReference: true };
}

function findNormalizedEvidenceUnit(rawQuote: string, unitTexts: readonly string[]): string | null {
  const quote = normalizeEvidence(rawQuote);
  if (!quote) return null;
  for (const unitText of unitTexts) {
    if (normalizeEvidence(unitText).includes(quote)) return unitText;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejected(proposal: PlotFlagProposal | null, errors: PlotFlagReviewError[]): PlotFlagReviewResult {
  return { status: 'rejected', proposal, deltas: [], errors };
}
