import type { SummaryApiConfig } from './summary/types';
import type { TavernWindow } from './types';

export type SecondaryPrompt = { role: string; content: string };

export type SecondaryTaskKind =
  | 'summary-minor'
  | 'summary-major'
  | 'summary-global'
  | 'progress'
  | 'phone-progress'
  | 'phone-directive-detect'
  | 'scene-presence'
  | 'phone-scene-extract'
  | 'custom';

export type SecondaryTaskCall = {
  win: TavernWindow;
  kind: SecondaryTaskKind;
  generationId: string;
  prompts: SecondaryPrompt[];
  apiConfig: SummaryApiConfig | null;
  allowEmpty?: boolean;
  isCancelled?: () => boolean;
};

export class SecondaryTaskCancelledError extends Error {
  constructor(kind: SecondaryTaskKind, generationId: string) {
    super(`secondary API task cancelled (${kind}, ${generationId})`);
    this.name = 'SecondaryTaskCancelledError';
  }
}

function throwIfCancelled(kind: SecondaryTaskKind, generationId: string, isCancelled?: () => boolean) {
  if (isCancelled?.()) {
    throw new SecondaryTaskCancelledError(kind, generationId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyTextParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .map(part => {
      if (typeof part === 'string') return part;
      if (!isRecord(part)) return '';
      const text = part.text;
      if (typeof text === 'string') return text;

      const content = part.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return stringifyTextParts(content);

      return '';
    })
    .filter(Boolean)
    .join('');
}

function readContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return stringifyTextParts(value);
}

function readGeminiCandidateText(candidate: unknown): string {
  if (!isRecord(candidate)) return '';

  const directText = readContentText(candidate.text);
  if (directText) return directText;

  const content = candidate.content;
  if (typeof content === 'string') return content;
  if (isRecord(content)) {
    const partsText = stringifyTextParts(content.parts);
    if (partsText) return partsText;

    const nestedText = readContentText(content.text);
    if (nestedText) return nestedText;
  }

  return '';
}

function readChoiceText(choice: unknown): string {
  if (!isRecord(choice)) return '';

  const message = choice.message;
  if (isRecord(message)) {
    const messageContent = readContentText(message.content);
    if (messageContent) return messageContent;
  }

  const delta = choice.delta;
  if (isRecord(delta)) {
    const deltaContent = readContentText(delta.content);
    if (deltaContent) return deltaContent;
  }

  const content = readContentText(choice.content);
  if (content) return content;

  const text = readContentText(choice.text);
  if (text) return text;

  return '';
}

function joinFirstNonEmpty(items: unknown[], reader: (item: unknown) => string): string {
  for (const item of items) {
    const text = reader(item);
    if (text.trim()) return text;
  }
  return '';
}

function formatJsonReasonField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectEmptyResponseHints(raw: unknown): string[] {
  const hints: string[] = [];
  if (!isRecord(raw)) return hints;

  const error = raw.error;
  if (typeof error === 'string' && error.trim()) {
    hints.push(`error=${error.trim()}`);
  } else if (isRecord(error)) {
    const message = formatJsonReasonField(error.message);
    const code = formatJsonReasonField(error.code);
    const status = formatJsonReasonField(error.status);
    if (message) hints.push(`error.message=${message}`);
    if (code) hints.push(`error.code=${code}`);
    if (status) hints.push(`error.status=${status}`);
  }

  const promptFeedback = raw.promptFeedback;
  if (isRecord(promptFeedback)) {
    const blockReason = formatJsonReasonField(promptFeedback.blockReason);
    const blockReasonMessage = formatJsonReasonField(promptFeedback.blockReasonMessage);
    if (blockReason) hints.push(`promptFeedback.blockReason=${blockReason}`);
    if (blockReasonMessage) hints.push(`promptFeedback.blockReasonMessage=${blockReasonMessage}`);
  }

  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const finishReason = formatJsonReasonField(candidate.finishReason);
    if (finishReason) hints.push(`candidate.finishReason=${finishReason}`);

    const finishMessage = formatJsonReasonField(candidate.finishMessage);
    if (finishMessage) hints.push(`candidate.finishMessage=${finishMessage}`);

    const safetyRatings = Array.isArray(candidate.safetyRatings)
      ? candidate.safetyRatings
          .map(rating => {
            if (!isRecord(rating)) return '';
            const category = formatJsonReasonField(rating.category);
            const probability = formatJsonReasonField(rating.probability);
            return [category, probability].filter(Boolean).join(':');
          })
          .filter(Boolean)
          .join(',')
      : '';
    if (safetyRatings) hints.push(`candidate.safetyRatings=${safetyRatings}`);
  }

  for (const key of ['response', 'result', 'output', 'data']) {
    const nestedHints = collectEmptyResponseHints(raw[key]);
    hints.push(...nestedHints.map(hint => `${key}.${hint}`));
  }

  return Array.from(new Set(hints));
}

export async function generateSecondaryRaw(input: {
  win: TavernWindow;
  generationId: string;
  prompts: SecondaryPrompt[];
  apiConfig: SummaryApiConfig | null;
  kind?: SecondaryTaskKind;
  allowEmpty?: boolean;
  isCancelled?: () => boolean;
}): Promise<string> {
  const { win, generationId, prompts, apiConfig, kind = 'custom', allowEmpty = false, isCancelled } = input;
  throwIfCancelled(kind, generationId, isCancelled);

  if (apiConfig && typeof win.generateRaw !== 'function') {
    throw new Error('generateRaw not available for secondary API');
  }

  const extractText = (raw: unknown): string => {
    if (typeof raw === 'string') return raw;
    if (raw == null) return '';
    if (typeof raw !== 'object') return String(raw);

    const record = raw as Record<string, unknown>;
    const content = readContentText(record.content);
    if (content) return content;

    const message = record.message as Record<string, unknown> | undefined;
    if (message) {
      const messageContent = readContentText(message.content);
      if (messageContent) return messageContent;
    }

    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choiceText = joinFirstNonEmpty(choices, readChoiceText);
    if (choiceText) return choiceText;

    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const candidateText = joinFirstNonEmpty(candidates, readGeminiCandidateText);
    if (candidateText) return candidateText;

    for (const key of ['response', 'result', 'output', 'data']) {
      const nestedText = extractText(record[key]);
      if (nestedText) return nestedText;
    }

    const text = readContentText(record.text);
    if (text) return text;

    return '';
  };

  const normalizeResult = (raw: unknown) => {
    const text = extractText(raw);
    if (!allowEmpty && !text.trim()) {
      const hints = collectEmptyResponseHints(raw);
      const suffix = hints.length ? `; ${hints.join('; ')}` : '';
      throw new Error(`secondary API returned empty content (${kind}, ${generationId})${suffix}`);
    }
    return text;
  };

  if (typeof win.generateRaw === 'function') {
    const config: Record<string, unknown> = {
      should_silence: true,
      should_stream: false,
      generation_id: generationId,
      ordered_prompts: prompts,
    };

    if (apiConfig) {
      config.custom_api = {
        apiurl: apiConfig.apiurl,
        key: apiConfig.key,
        model: apiConfig.model,
        source: apiConfig.source,
      };
    }

    const raw = await win.generateRaw(config);
    throwIfCancelled(kind, generationId, isCancelled);
    return normalizeResult(raw);
  }

  if (typeof win.generate === 'function') {
    const raw = await win.generate({
      should_silence: true,
      should_stream: false,
      generation_id: generationId,
      user_input: prompts.map(prompt => prompt.content).join('\n\n'),
    });
    throwIfCancelled(kind, generationId, isCancelled);
    return normalizeResult(raw);
  }

  throw new Error('generateRaw/generate not available');
}

export async function runSecondaryTask(input: SecondaryTaskCall): Promise<string> {
  return generateSecondaryRaw(input);
}
