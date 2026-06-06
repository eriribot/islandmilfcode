import type { DrawingSettings, TavernWindow } from '../types';

export const CHARACTER_DATA_IMPORT_REQUEST_EVENT = 'ch-char-data-import-request';
export const CHARACTER_DATA_IMPORT_RESPONSE_EVENT = 'ch-char-data-import-response';

const CHARACTER_DATA_BLOCK_PATTERN = /<(人物|服装)\b[^>]*>[\s\S]*?<\/\1>/g;

export type CharacterDataImportEmitResult = {
  sent: boolean;
  id?: string;
  blockCount: number;
  reason?: string;
};

type CharacterDataImportMetadata = {
  generationContext?: string;
  generationWorldBook?: string;
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

function createImportRequestId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `islandmilfcode-${random}`;
}

export function extractCharacterDataImportText(rawText: string) {
  const blocks = String(rawText ?? '').match(CHARACTER_DATA_BLOCK_PATTERN) ?? [];
  return blocks.map(block => block.trim()).filter(Boolean).join('\n');
}

export function stripCharacterDataImportText(rawText: string) {
  return String(rawText ?? '').replace(CHARACTER_DATA_BLOCK_PATTERN, '').trim();
}

export function buildCharacterDataImportPrompt(settings?: DrawingSettings | null) {
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
    '智慧姬角色/服装录入插件：',
    '当玩家明确要求生图、插图、立绘、CG、轻小说插画、换装参考，或本轮正文出现需要固定外观的新角色/新服装时，在可见正文 </content> 之后追加可被插件读取的资料块。',
    '资料块不要写进 <content> 正文内部；正文照常自然叙事，资料块只给插件读取。',
    '没有生图/插画/立绘/服装录入需求时不要输出资料块，避免每轮重复录入。',
    qualityPrompt ? `画风/质量提示词：${qualityPrompt}` : '',
    anchors.length
      ? ['角色外貌锚定（同一角色在不同插图中优先沿用这些固定标签）：', ...anchors].join('\n')
      : '',
    systemPrompt ? `系统指令（高级）：${systemPrompt}` : '',
    '',
    '人物资料格式（字段名必须完全照写）：',
    '<人物>',
    '中文名称: 角色中文名',
    '英文名称: Character English Name',
    '角色特征: English prompt tags, comma separated',
    '五官外貌: English prompt tags for face/front hair/eyes',
    '五官外貌背面: English prompt tags for back hair/nape',
    '上半身SFW: English prompt tags for safe upper body',
    '上半身SFW背面: English prompt tags for safe upper body back',
    '下半身SFW: English prompt tags for safe lower body',
    '下半身SFW背面: English prompt tags for safe lower body back',
    '上半身NSFW: English prompt tags for adult upper-body variant if needed, otherwise leave concise neutral anatomy tags',
    '上半身NSFW背面: English prompt tags for adult upper-body back variant if needed',
    '下半身NSFW: English prompt tags for adult lower-body variant if needed',
    '下半身NSFW背面: English prompt tags for adult lower-body back variant if needed',
    '</人物>',
    '',
    '服装资料格式（可归属某个角色，也可作为通用服装）：',
    '<服装>',
    '归属人: Character English Name（通用服装可留空）',
    '中文名称: 服装中文名',
    '英文名称: outfit english name',
    '上半身: English prompt tags for upper outfit',
    '上半身背面: English prompt tags for upper outfit back',
    '下半身: English prompt tags for lower outfit',
    '下半身背面: English prompt tags for lower outfit back',
    '</服装>',
    '',
    '写法要求：中文名称用中文；英文名称和提示词字段用英文逗号标签，保持二次元轻小说插画风格，优先写可复用的外观、发色、瞳色、体型、制服/便服/舞台服等视觉锚点。',
  ].join('\n');
}

export async function emitCharacterDataImportFromResponse(
  win: TavernWindow,
  rawText: string,
  metadata: CharacterDataImportMetadata = {},
): Promise<CharacterDataImportEmitResult> {
  const text = extractCharacterDataImportText(rawText);
  const blockCount = (text.match(CHARACTER_DATA_BLOCK_PATTERN) ?? []).length;
  if (!text) return { sent: false, blockCount: 0, reason: 'no-character-data-blocks' };

  const api = getEventApi(win);
  if (typeof api.eventEmit !== 'function') {
    return { sent: false, blockCount, reason: 'eventEmit-not-available' };
  }

  const id = createImportRequestId();
  const requestData = {
    id,
    mode: 'text',
    text,
    ...(metadata.generationContext || metadata.generationWorldBook
      ? {
          metadata: {
            ...(metadata.generationContext ? { generationContext: metadata.generationContext } : {}),
            ...(metadata.generationWorldBook ? { generationWorldBook: metadata.generationWorldBook } : {}),
          },
        }
      : {}),
  };

  let cleanup: (() => void) | null = null;
  if (typeof api.eventOn === 'function' && typeof api.eventRemoveListener === 'function') {
    const responseHandler = (responseData: unknown) => {
      const response = responseData as { id?: string; success?: boolean; message?: string } | null;
      if (!response || response.id !== id) return;
      cleanup?.();
      if (!response.success) {
        console.warn('[character-data-import] 智慧姬录入失败:', response.message ?? response);
      }
    };
    api.eventOn(CHARACTER_DATA_IMPORT_RESPONSE_EVENT, responseHandler);
    cleanup = () => api.eventRemoveListener?.(CHARACTER_DATA_IMPORT_RESPONSE_EVENT, responseHandler);
    // 中文注释：响应只用于清理监听；录入弹窗需要玩家确认，不能阻塞正文生成链路。
    setTimeout(() => cleanup?.(), 120_000);
  }

  await api.eventEmit(CHARACTER_DATA_IMPORT_REQUEST_EVENT, requestData);
  return { sent: true, id, blockCount };
}
