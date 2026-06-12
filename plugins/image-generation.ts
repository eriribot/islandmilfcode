import { generateSecondaryRaw } from '../secondary-api';
import type { SummaryApiConfig } from '../summary/types';
import type { DrawingSettings, TavernWindow } from '../types';

export const IMAGE_GENERATION_REQUEST_EVENT = 'generate-image-request';
export const IMAGE_GENERATION_RESPONSE_EVENT = 'generate-image-response';
const CHATU8_LLM_IMAGE_GEN_REQUEST_EVENT = 'ch-llm-image-gen-request';
const CHATU8_LLM_IMAGE_GEN_RESPONSE_EVENT = 'ch-llm-image-gen-response';

const GENERATE_IMAGE_PAIR_TAG_PATTERN = /<generate_image\b([^>]*)>[\s\S]*?<\/generate_image>/gi;
const GENERATE_IMAGE_SELF_CLOSING_TAG_PATTERN = /<generate_image\b([^>]*)\/>/gi;
const LEGACY_IMAGE_PAIR_TAG_PATTERN = /<image\b[^>]*>[\s\S]*?<\/image>/gi;
const LEGACY_IMAGE_PAYLOAD_PATTERN = /\bimage\s*###([\s\S]*?)###/gi;
const PROMPT_ATTR_PATTERN = /\bprompt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CHANGE_ATTR_PATTERN = /\bchange\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const IMAGE_INTENT_PATTERN =
  /(生图|画图|出图|配图|插图|立绘|CG|cg|轻小说插画|生成图片|生成一张图|来一张图|画一张|画出来|插画|角色图|场景图|事件图)/i;

export type ImageGenerationPrompt = {
  prompt: string;
  change?: string;
  anchorIndex?: number;
};

export type ImageGenerationRequestContext = {
  sceneText?: string;
  rawText?: string;
  generationContext?: string;
  generationWorldBook?: string;
  userInput?: string;
  summaryApiConfig?: SummaryApiConfig | null;
};

export type ImageGenerationResult = {
  sent: boolean;
  id?: string;
  prompt?: string;
  imageData?: string;
  reason?: string;
  error?: string;
};

export type ImageGenerationTextSegment = {
  text: string;
  anchorIndex?: number;
};

type TavernEventApi = Pick<TavernWindow, 'eventEmit' | 'eventOn' | 'eventRemoveListener'>;
type ImageGenerationSettings = Pick<DrawingSettings, 'width' | 'height' | 'negativePrompt'> &
  Partial<Pick<DrawingSettings, 'qualityPrompt' | 'manualPrompt' | 'characterAnchors' | 'systemPrompt'>>;
type ImagePromptMessage = { role: string; content: string };

function stripImageThinkBlocks(text: string) {
  return String(text ?? '').replace(/<imgthink\b[^>]*>[\s\S]*?<\/imgthink>/gi, '').trim();
}

function getEventApi(win: TavernWindow): TavernEventApi {
  const globalApi = globalThis as Partial<TavernEventApi>;
  return {
    eventEmit: win.eventEmit ?? globalApi.eventEmit,
    eventOn: win.eventOn ?? globalApi.eventOn,
    eventRemoveListener: win.eventRemoveListener ?? globalApi.eventRemoveListener,
  };
}

export function isImageGenerationPluginAvailable(win: TavernWindow) {
  const api = getEventApi(win);
  if (typeof api.eventEmit !== 'function' || typeof api.eventOn !== 'function') {
    return false;
  }

  // 检查 SillyTavern 的扩展系统
  const globalScope = globalThis as {
    chatu8ImagePluginInstalled?: boolean;
    extensions?: string[];
    extensionNames?: string[];
    getContext?: () => { extensionNames?: string[]; extensions?: Record<string, unknown> };
    SillyTavern?: {
      extensions?: string[] | Record<string, unknown>;
      getContext?: () => { extensionNames?: string[]; extensions?: Record<string, unknown> };
    };
  };

  // 优先检查插件特有的标记
  if (globalScope.chatu8ImagePluginInstalled === true) {
    return true;
  }

  // 检查扩展名称数组
  const extensionNames =
    globalScope.extensions ||
    globalScope.extensionNames ||
    globalScope.getContext?.()?.extensionNames ||
    globalScope.SillyTavern?.extensions ||
    (Array.isArray(globalScope.SillyTavern?.getContext?.()?.extensionNames)
      ? globalScope.SillyTavern.getContext().extensionNames
      : []);

  // 智绘姬插件可能的扩展名
  const possibleNames = [
    'chatu8',
    'st-chatu8',
    'third-party-chatu8',
    'SillyTavern-Chatu8',
    'third-party/chatu8',
  ];

  if (Array.isArray(extensionNames)) {
    const found = possibleNames.some(name =>
      extensionNames.some(ext =>
        typeof ext === 'string' && ext.toLowerCase().includes(name.toLowerCase())
      )
    );
    if (found) return true;
  }

  // 检查扩展对象
  if (typeof extensionNames === 'object' && extensionNames !== null) {
    const extensionKeys = Object.keys(extensionNames);
    const found = possibleNames.some(name =>
      extensionKeys.some(key => key.toLowerCase().includes(name.toLowerCase()))
    );
    if (found) return true;
  }

  // 方法 2: 检查 DOM 中的扩展元素
  try {
    const extensionElements = document.querySelectorAll('[data-extension-name], .extension-block, [id*="chatu8"]');
    for (const element of extensionElements) {
      const extensionName = (
        element.getAttribute('data-extension-name') ||
        element.id ||
        element.className ||
        element.textContent
      )?.toLowerCase();

      if (extensionName && possibleNames.some(name => extensionName.includes(name.toLowerCase()))) {
        return true;
      }
    }

    // 检查扩展列表容器
    const extensionContainers = document.querySelectorAll('#extensions_list, .extensions-list, [class*="extensions"]');
    for (const container of extensionContainers) {
      const text = container.textContent?.toLowerCase() || '';
      if (possibleNames.some(name => text.includes(name.toLowerCase()))) {
        return true;
      }
    }
  } catch (e) {
    console.warn('[image-generation] DOM 检测失败:', e);
  }

  return false;
}

function createImageRequestId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `islandmilfcode-image-${random}`;
}

function stripThinkingBlocks(text: string) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

function extractGeneratedImagePrompt(raw: string) {
  const text = stripThinkingBlocks(String(raw ?? '')).trim();
  if (!text) return '';

  const tagged = text.match(/<imagePrompt>([\s\S]*?)<\/imagePrompt>/i)?.[1]
    ?? text.match(/<prompt>([\s\S]*?)<\/prompt>/i)?.[1];
  if (tagged) return normalizeGeneratedImagePrompt(tagged);

  const fenced = text.match(/```(?:json|text|txt)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || text;
  try {
    const parsed = JSON.parse(candidate) as { prompt?: unknown; positive?: unknown };
    const value = typeof parsed.prompt === 'string' ? parsed.prompt : typeof parsed.positive === 'string' ? parsed.positive : '';
    if (value) return normalizeGeneratedImagePrompt(value);
  } catch {
    /* fall through */
  }

  return normalizeGeneratedImagePrompt(candidate);
}

function normalizeGeneratedImagePrompt(prompt: string) {
  return String(prompt ?? '')
    .replace(/^\s*(positive prompt|prompt|nai prompt)\s*[:\uFF1A]\s*/i, '')
    .replace(/^\s*["'\u201C\u201D]+|["'\u201C\u201D]+\s*$/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^negative prompt\s*[:\uFF1A]/i.test(line))
    .join(', ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildSceneToNaiPrompt(settings: ImageGenerationSettings, change: string, context: ImageGenerationRequestContext) {
  const anchors = settings.characterAnchors
    ?.map(anchor => [anchor.name?.trim(), anchor.prompt?.trim()].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('\n');

  return [
    'You convert a Chinese visual-novel scene into one final NovelAI positive prompt.',
    '',
    'Rules:',
    '- Output only <imagePrompt>...</imagePrompt>.',
    '- The content inside the tag must be English comma-separated NAI/anime tags.',
    '- Do not repeat the prose scene. Do not explain. Do not write a negative prompt.',
    '- Capture the most drawable current moment: characters, appearance, clothing, pose, expression, setting, lighting, camera, mood.',
    '- Preserve important character anchors and style anchors exactly when useful.',
    '- Avoid story spoilers or abstract narration; describe visible image details.',
    '',
    settings.qualityPrompt?.trim() ? `Quality/style anchors:\n${settings.qualityPrompt.trim()}` : '',
    settings.manualPrompt?.trim() ? `Manual image requirement:\n${settings.manualPrompt.trim()}` : '',
    settings.systemPrompt?.trim() ? `Additional image instructions:\n${settings.systemPrompt.trim()}` : '',
    anchors ? `Character anchors:\n${anchors}` : '',
    change.trim() ? `Requested local change:\n${change.trim()}` : '',
    context.generationWorldBook?.trim() ? `World/state hints:\n${context.generationWorldBook.trim()}` : '',
    context.userInput?.trim() ? `Latest user input:\n${context.userInput.trim()}` : '',
    context.generationContext?.trim() ? `Recent context:\n${context.generationContext.trim()}` : '',
    context.sceneText?.trim() ? `Current scene to illustrate:\n${context.sceneText.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function formatEventError(error: unknown) {
  if (!error) return 'unknown-image-prompt-generation-error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return String(error);
}

function requestChatu8LlmImagePrompt(win: TavernWindow, prompts: ImagePromptMessage[], timeoutMs = 90_000) {
  const api = getEventApi(win);
  if (typeof api.eventEmit !== 'function' || typeof api.eventOn !== 'function') {
    return Promise.reject(new Error('chatu8 LLM event API not available'));
  }

  const id = createImageRequestId();
  return new Promise<string>((resolve, reject) => {
    let handled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let stopListening: { stop?: () => void } | undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      stopListening?.stop?.();
      api.eventRemoveListener?.(CHATU8_LLM_IMAGE_GEN_RESPONSE_EVENT, responseHandler);
    };

    const finish = (callback: () => void) => {
      if (handled) return;
      handled = true;
      cleanup();
      callback();
    };

    const responseHandler = (responseData: unknown) => {
      const response = responseData as {
        id?: string;
        success?: boolean;
        result?: unknown;
        prompt?: unknown;
        content?: unknown;
        error?: unknown;
      } | null;
      if (!response || response.id !== id) return;

      finish(() => {
        if (response.success === false) {
          reject(new Error(formatEventError(response.error ?? response.result)));
          return;
        }
        const raw =
          typeof response.result === 'string'
            ? response.result
            : typeof response.prompt === 'string'
              ? response.prompt
              : typeof response.content === 'string'
                ? response.content
                : '';
        resolve(raw);
      });
    };

    timeoutId = setTimeout(() => {
      finish(() => reject(new Error('chatu8 LLM image prompt request timeout')));
    }, timeoutMs);

    stopListening = api.eventOn(CHATU8_LLM_IMAGE_GEN_RESPONSE_EVENT, responseHandler);
    Promise.resolve(api.eventEmit(CHATU8_LLM_IMAGE_GEN_REQUEST_EVENT, { id, prompt: prompts })).catch(error => {
      finish(() => reject(new Error(formatEventError(error))));
    });
  });
}

async function generateNaiPromptFromScene(
  win: TavernWindow,
  settings: ImageGenerationSettings,
  change: string,
  context: ImageGenerationRequestContext,
) {
  const prompts = [
    {
      role: 'system',
      content: buildSceneToNaiPrompt(settings, change, context),
    },
  ];
  let raw = '';
  try {
    raw = await requestChatu8LlmImagePrompt(win, prompts);
  } catch (error) {
    console.warn('[image-generation] chatu8 LLM prompt generation failed, fallback to Tavern generateRaw:', error);
    raw = await generateSecondaryRaw({
      win,
      kind: 'custom',
      generationId: `image-prompt-${createImageRequestId()}`,
      apiConfig: context.summaryApiConfig ?? null,
      prompts,
    });
  }
  return extractGeneratedImagePrompt(raw);
}

function readAttr(attrs: string, pattern: RegExp) {
  const match = attrs.match(pattern);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function extractLegacyImagePrompts(rawText: string, startAnchorIndex: number): ImageGenerationPrompt[] {
  const prompts: ImageGenerationPrompt[] = [];
  let anchorIndex = startAnchorIndex;
  let blockMatch: RegExpExecArray | null;
  LEGACY_IMAGE_PAIR_TAG_PATTERN.lastIndex = 0;

  while ((blockMatch = LEGACY_IMAGE_PAIR_TAG_PATTERN.exec(rawText))) {
    const block = blockMatch[0] ?? '';
    const currentAnchorIndex = anchorIndex;
    anchorIndex += 1;
    let payloadMatch: RegExpExecArray | null;
    LEGACY_IMAGE_PAYLOAD_PATTERN.lastIndex = 0;

    while ((payloadMatch = LEGACY_IMAGE_PAYLOAD_PATTERN.exec(block))) {
      const payload = String(payloadMatch[1] ?? '').trim();
      if (!payload) continue;
      prompts.push({ prompt: stripImageThinkBlocks(`image###${payload}###`), anchorIndex: currentAnchorIndex });
    }
  }

  return prompts;
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
      prompts.push({ prompt, change: change || undefined, anchorIndex: prompts.length });
    }
  };

  collect(GENERATE_IMAGE_PAIR_TAG_PATTERN);
  collect(GENERATE_IMAGE_SELF_CLOSING_TAG_PATTERN);
  prompts.push(...extractLegacyImagePrompts(text, prompts.length));
  return prompts;
}

export function splitTextByImageGenerationAnchors(rawText: string): ImageGenerationTextSegment[] {
  const text = String(rawText ?? '');
  const matches = [
    ...Array.from(text.matchAll(GENERATE_IMAGE_PAIR_TAG_PATTERN)),
    ...Array.from(text.matchAll(GENERATE_IMAGE_SELF_CLOSING_TAG_PATTERN)),
    ...Array.from(text.matchAll(LEGACY_IMAGE_PAIR_TAG_PATTERN)),
  ]
    .filter((match): match is RegExpMatchArray & { index: number } => typeof match.index === 'number')
    .sort((a, b) => a.index - b.index);

  if (!matches.length) return [{ text }];

  const segments: ImageGenerationTextSegment[] = [];
  let cursor = 0;
  matches.forEach((match, anchorIndex) => {
    const before = text.slice(cursor, match.index);
    segments.push({ text: before });
    segments.push({ text: '', anchorIndex });
    cursor = match.index + match[0].length;
  });
  segments.push({ text: text.slice(cursor) });
  return segments;
}

export function getImageGenerationPromptAtAnchor(rawText: string, anchorIndex: number) {
  return extractImageGenerationPrompts(rawText).find(prompt => prompt.anchorIndex === anchorIndex) ?? null;
}

export function hasExplicitImageGenerationIntent(text: string) {
  return IMAGE_INTENT_PATTERN.test(String(text ?? ''));
}

export function stripImageGenerationTags(rawText: string) {
  return String(rawText ?? '')
    .replace(GENERATE_IMAGE_PAIR_TAG_PATTERN, '')
    .replace(GENERATE_IMAGE_SELF_CLOSING_TAG_PATTERN, '')
    .replace(LEGACY_IMAGE_PAIR_TAG_PATTERN, '')
    .trim();
}

export function buildImageGenerationPrompt(settings?: DrawingSettings | null) {
  if (!settings?.enabled) return '';

  return [
    '智绘姬生图插件：',
    '当玩家明确要求生图、插图、立绘、CG、轻小说插画，或本轮正文出现非常适合配图的关键镜头时，在可见正文 </content> 之后追加一个生图标签。',
    '生图标签不要写进 <content> 正文内部；正文自然叙事即可。',
    '标签只用于插件读取，最终会被前端剥离，不会进入可见正文或后续历史上下文。',
    '优先使用单行格式：<generate_image />',
    '如果需要一次生成多张图，可以连续输出多个 <generate_image />；如果世界书已经输出 <image>image###...###</image> 格式，前端也会逐张读取。',
    '不要为了生图在正文里编写英文提示词、画面参数或插件说明；智绘姬会在正文生成完成后读取正文并调用自己的 LLM 生成图像提示词。',
    '如果玩家明确给了局部修改要求，可写成：<generate_image change="玩家要求的局部修改" />',
    '没有明确生图价值时不要输出生图标签，避免每轮乱画。',
  ].join('\n');
}

export async function requestImageGeneration(
  win: TavernWindow,
  prompt: string,
  settings: ImageGenerationSettings,
  change = '',
  context: ImageGenerationRequestContext = {},
): Promise<ImageGenerationResult> {
  const sceneText = String(context.sceneText ?? '').trim();
  const generationContext = String(context.generationContext ?? '').trim();
  const generationWorldBook = String(context.generationWorldBook ?? '').trim();
  const rawText = String(context.rawText ?? '').trim();
  const userInput = String(context.userInput ?? '').trim();
  const explicitPrompt = prompt.trim();
  const promptSourceText = explicitPrompt || sceneText || generationContext;
  if (!promptSourceText) return { sent: false, reason: 'empty-prompt' };

  const api = getEventApi(win);
  if (!isImageGenerationPluginAvailable(win)) {
    return { sent: false, prompt: promptSourceText, reason: 'image-plugin-event-api-not-available' };
  }

  let cleanPrompt = explicitPrompt;
  if (!cleanPrompt) {
    try {
      cleanPrompt = await generateNaiPromptFromScene(win, settings, change, {
        sceneText,
        rawText,
        generationContext,
        generationWorldBook,
        userInput,
        summaryApiConfig: context.summaryApiConfig ?? null,
      });
    } catch (error) {
      return {
        sent: false,
        prompt: promptSourceText,
        reason: 'image-prompt-generation-failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!cleanPrompt) {
    return {
      sent: false,
      prompt: promptSourceText,
      reason: 'empty-generated-image-prompt',
    };
  }

  const id = createImageRequestId();
  const width = Number(settings.width);
  const height = Number(settings.height);
  const requestData = {
    id,
    prompt: cleanPrompt,
    negative_prompt: settings.negativePrompt?.trim() || '',
    change: change.trim(),
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    source: explicitPrompt ? 'prompt-attr' : 'scene-prompt-llm',
    ...(sceneText ? { sceneText } : {}),
    ...(generationContext ? { generationContext } : {}),
    ...(generationWorldBook ? { generationWorldBook } : {}),
    ...(rawText ? { rawText } : {}),
    ...(userInput ? { userInput } : {}),
  };

  return new Promise(resolve => {
    let handled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let stopListening: { stop?: () => void } | undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      stopListening?.stop?.();
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

    // 智绘姬实际生成可能很慢；超时只结束本侧等待，不取消插件里的任务。
    timeoutId = setTimeout(() => {
      if (handled) return;
      handled = true;
      cleanup();
      resolve({ sent: true, id, prompt: cleanPrompt, reason: 'timeout' });
    }, 120_000);

    stopListening = api.eventOn(IMAGE_GENERATION_RESPONSE_EVENT, responseHandler);
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
