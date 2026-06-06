import type { DrawingSettings, TavernWindow } from '../types';

export const IMAGE_GENERATION_REQUEST_EVENT = 'generate-image-request';
export const IMAGE_GENERATION_RESPONSE_EVENT = 'generate-image-response';

const GENERATE_IMAGE_PAIR_TAG_PATTERN = /<generate_image\b([^>]*)>[\s\S]*?<\/generate_image>/gi;
const GENERATE_IMAGE_SELF_CLOSING_TAG_PATTERN = /<generate_image\b([^>]*)\/>/gi;
const PROMPT_ATTR_PATTERN = /\bprompt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CHANGE_ATTR_PATTERN = /\bchange\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export type ImageGenerationPrompt = {
  prompt: string;
  change?: string;
};

export type ImageGenerationResult = {
  sent: boolean;
  id?: string;
  prompt?: string;
  imageData?: string;
  reason?: string;
  error?: string;
};

type TavernEventApi = Pick<TavernWindow, 'eventEmit' | 'eventOn' | 'eventRemoveListener'>;

function getEventApi(win: TavernWindow): TavernEventApi {
  const globalApi = globalThis as Partial<TavernEventApi>;
  return {
    eventEmit: win.eventEmit ?? globalApi.eventEmit,
    eventOn: win.eventOn ?? globalApi.eventOn,
    eventRemoveListener: win.eventRemoveListener ?? globalApi.eventRemoveListener,
  };
}

function createImageRequestId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `islandmilfcode-image-${random}`;
}

function readAttr(attrs: string, pattern: RegExp) {
  const match = attrs.match(pattern);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

export function extractImageGenerationPrompts(rawText: string): ImageGenerationPrompt[] {
  const prompts: ImageGenerationPrompt[] = [];
  const text = String(rawText ?? '');
  const collect = (pattern: RegExp) => {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text))) {
      const attrs = match[1] ?? '';
      const prompt = readAttr(attrs, PROMPT_ATTR_PATTERN);
      const change = readAttr(attrs, CHANGE_ATTR_PATTERN);
      if (prompt) prompts.push({ prompt, change: change || undefined });
    }
  };

  collect(GENERATE_IMAGE_PAIR_TAG_PATTERN);
  collect(GENERATE_IMAGE_SELF_CLOSING_TAG_PATTERN);
  return prompts;
}

export function stripImageGenerationTags(rawText: string) {
  return String(rawText ?? '')
    .replace(GENERATE_IMAGE_PAIR_TAG_PATTERN, '')
    .replace(GENERATE_IMAGE_SELF_CLOSING_TAG_PATTERN, '')
    .trim();
}

export function buildImageGenerationPrompt(settings?: DrawingSettings | null) {
  if (!settings?.enabled) return '';

  const qualityPrompt = settings.qualityPrompt.trim();
  const systemPrompt = settings.systemPrompt.trim();
  const anchors = settings.characterAnchors
    .map(anchor => {
      const name = anchor.name.trim();
      const prompt = anchor.prompt.trim();
      if (!name && !prompt) return '';
      return `- ${name || '未命名角色'}: ${prompt || '沿用当前正文描写'}`;
    })
    .filter(Boolean);

  return [
    '智绘姬生图插件：',
    '当玩家明确要求生图、插图、立绘、CG、轻小说插画，或本轮正文出现非常适合配图的关键镜头时，在可见正文 </content> 之后追加一个生图标签。',
    '生图标签不要写进 <content> 正文内部；正文自然叙事即可。',
    '没有明确生图价值时不要输出生图标签，避免每轮乱画。',
    '标签格式必须是单行：<generate_image prompt="English prompt tags" />',
    'prompt 必须使用英文逗号标签，包含人物、动作、表情、场景、构图、光线、画风，不要写中文。',
    qualityPrompt ? `固定画风/质量提示词必须并入 prompt：${qualityPrompt}` : '',
    anchors.length
      ? ['角色外貌锚定（画到对应角色时必须原样并入 prompt）：', ...anchors].join('\n')
      : '',
    systemPrompt ? `系统指令（高级）：${systemPrompt}` : '',
    '示例：<generate_image prompt="masterpiece, best quality, anime style, light novel illustration, 1girl, blonde twintails, blue eyes, school uniform, sunset classroom, embarrassed smile" />',
  ].filter(Boolean).join('\n');
}

export async function requestImageGeneration(
  win: TavernWindow,
  prompt: string,
  settings: Pick<DrawingSettings, 'width' | 'height'>,
  change = '',
): Promise<ImageGenerationResult> {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) return { sent: false, reason: 'empty-prompt' };

  const api = getEventApi(win);
  if (typeof api.eventEmit !== 'function' || typeof api.eventOn !== 'function' || typeof api.eventRemoveListener !== 'function') {
    return { sent: false, prompt: cleanPrompt, reason: 'image-plugin-event-api-not-available' };
  }

  const id = createImageRequestId();
  const requestData = {
    id,
    prompt: cleanPrompt,
    change: change.trim(),
    width: Number.isFinite(settings.width) && settings.width > 0 ? Math.round(settings.width) : null,
    height: Number.isFinite(settings.height) && settings.height > 0 ? Math.round(settings.height) : null,
  };

  return new Promise(resolve => {
    let handled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      api.eventRemoveListener?.(IMAGE_GENERATION_RESPONSE_EVENT, responseHandler);
    };

    const responseHandler = (responseData: unknown) => {
      const response = responseData as { id?: string; success?: boolean; imageData?: string; error?: string } | null;
      if (!response || response.id !== id || handled) return;
      handled = true;
      cleanup();

      if (response.success) {
        resolve({ sent: true, id, prompt: cleanPrompt, imageData: response.imageData });
        return;
      }

      resolve({ sent: true, id, prompt: cleanPrompt, error: response.error || 'unknown-image-generation-error' });
    };

    // 中文注释：智绘姬实际生成可能很慢；超时只结束本侧等待，不取消插件里的任务。
    timeoutId = setTimeout(() => {
      if (handled) return;
      handled = true;
      cleanup();
      resolve({ sent: true, id, prompt: cleanPrompt, reason: 'timeout' });
    }, 120_000);

    api.eventOn(IMAGE_GENERATION_RESPONSE_EVENT, responseHandler);
    Promise.resolve(api.eventEmit(IMAGE_GENERATION_REQUEST_EVENT, requestData)).catch(error => {
      if (handled) return;
      handled = true;
      cleanup();
      resolve({
        sent: false,
        id,
        prompt: cleanPrompt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
