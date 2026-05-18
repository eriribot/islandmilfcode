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
};

export async function generateSecondaryRaw(input: {
  win: TavernWindow;
  generationId: string;
  prompts: SecondaryPrompt[];
  apiConfig: SummaryApiConfig | null;
}): Promise<string> {
  const { win, generationId, prompts, apiConfig } = input;

  if (apiConfig && typeof win.generateRaw !== 'function') {
    throw new Error('generateRaw not available for secondary API');
  }

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

    return String((await win.generateRaw(config)) ?? '');
  }

  if (typeof win.generate === 'function') {
    return String(
      (await win.generate({
        should_silence: true,
        should_stream: false,
        generation_id: generationId,
        user_input: prompts.map(prompt => prompt.content).join('\n\n'),
      })) ?? '',
    );
  }

  throw new Error('generateRaw/generate not available');
}

export async function runSecondaryTask(input: SecondaryTaskCall): Promise<string> {
  return generateSecondaryRaw(input);
}
