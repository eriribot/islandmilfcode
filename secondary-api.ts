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
};

export async function generateSecondaryRaw(input: {
  win: TavernWindow;
  generationId: string;
  prompts: SecondaryPrompt[];
  apiConfig: SummaryApiConfig | null;
  kind?: SecondaryTaskKind;
  allowEmpty?: boolean;
}): Promise<string> {
  const { win, generationId, prompts, apiConfig, kind = 'custom', allowEmpty = false } = input;

  if (apiConfig && typeof win.generateRaw !== 'function') {
    throw new Error('generateRaw not available for secondary API');
  }

  const extractText = (raw: unknown): string => {
    if (typeof raw === 'string') return raw;
    if (raw == null) return '';
    if (typeof raw !== 'object') return String(raw);

    const record = raw as Record<string, unknown>;
    if (typeof record.content === 'string') return record.content;

    const message = record.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === 'string') return message.content;

    const choices = Array.isArray(record.choices) ? record.choices : [];
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    const choiceMessage = firstChoice?.message as Record<string, unknown> | undefined;
    if (choiceMessage && typeof choiceMessage.content === 'string') return choiceMessage.content;

    const delta = firstChoice?.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === 'string') return delta.content;

    const text = firstChoice?.text;
    if (typeof text === 'string') return text;

    return String(raw);
  };

  const normalizeResult = (raw: unknown) => {
    const text = extractText(raw);
    if (!allowEmpty && !text.trim()) {
      throw new Error(`secondary API returned empty content (${kind}, ${generationId})`);
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

    return normalizeResult(await win.generateRaw(config));
  }

  if (typeof win.generate === 'function') {
    return normalizeResult(
      await win.generate({
        should_silence: true,
        should_stream: false,
        generation_id: generationId,
        user_input: prompts.map(prompt => prompt.content).join('\n\n'),
      }),
    );
  }

  throw new Error('generateRaw/generate not available');
}

export async function runSecondaryTask(input: SecondaryTaskCall): Promise<string> {
  return generateSecondaryRaw(input);
}
