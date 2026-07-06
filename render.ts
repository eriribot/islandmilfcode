import { escapeHtml } from './html';
import {
  extractContextReplyWithImageGenerationTags,
  extractOptionsBlock,
  extractTucaoBlocks,
  getReaderMessages,
  getSummaryMessages,
  getVisibleMessageText,
} from './message-format';
import { splitTextByImageGenerationAnchors } from './plugins/image-generation';
import { isPaperWorkspaceFullscreen, renderPaperFullscreenButton } from './plugins/fullscreen';
import { getCachedImageAssetObjectUrl } from './state/image-assets';
import { renderFloatingPhone, renderPhone, type PhoneRenderers } from './phone/render';
import type { SummaryStore } from './summary/types';
import type {
  AppState,
  BackgroundTaskState,
  MessageIllustration,
  ReaderContextMenuState,
  StatusData,
  UiMessage,
} from './types';
import { loadFullMemoryConfig } from './memory-config';
import type { IslandMemoryDB } from './memorydatabase/types';

type PaperTheme = 'classic' | 'eye-care' | 'night';

const PAPER_THEMES: Array<{ id: PaperTheme; label: string; title: string }> = [
  { id: 'classic', label: '原纸', title: '使用默认手帐纸面' },
  { id: 'eye-care', label: '护眼', title: '切换为低亮度绿调纸面' },
  { id: 'night', label: '夜读', title: '切换为深色夜读纸面' },
];

function getPaperTheme(state: AppState): PaperTheme {
  const raw = state.runtimeFlags.paperTheme;
  return raw === 'eye-care' || raw === 'night' ? raw : 'classic';
}

function renderPaperThemeControls(state: AppState) {
  const activeTheme = getPaperTheme(state);
  return `
    <div class="paper-theme-switch" role="group" aria-label="纸张颜色">
      ${PAPER_THEMES.map(
        theme => `
          <button
            class="paper-theme-switch__btn ${theme.id === activeTheme ? 'is-active' : ''}"
            data-action="set-paper-theme"
            data-paper-theme="${theme.id}"
            type="button"
            title="${escapeHtml(theme.title)}"
            aria-pressed="${theme.id === activeTheme ? 'true' : 'false'}"
          >
            ${escapeHtml(theme.label)}
          </button>
        `,
      ).join('')}
    </div>
  `;
}

/**
 * 摘要 range 使用 Reader 可见且已完成楼层的 0-based 下标。
 * UI 展示只需要 +1，对齐读者界面里的 #N。
 */
function mapSummaryRangeToUiRange(range: [number, number]): [number, number] {
  return [range[0] + 1, range[1] + 1];
}
import { formatDate, formatTime, getInventoryIcon } from './variables/normalize';

export function paginateMessage(text: string, role: UiMessage['role']) {
  const normalized = text.replace(/\r\n/g, '\n').trim() || '……';
  const maxChars = role === 'assistant' ? 145 : role === 'user' ? 88 : 120;
  const softMin = Math.floor(maxChars * 0.62);
  const pages: string[] = [];
  let remaining = normalized;

  const findBreak = (segment: string) => {
    const slice = segment.slice(0, maxChars + 1);
    const collectMatches = (pattern: RegExp) => {
      const indices: number[] = [];
      let match: RegExpExecArray | null;
      const regex = new RegExp(pattern.source, pattern.flags);
      while ((match = regex.exec(slice))) {
        indices.push(match.index);
      }
      return indices;
    };

    const preferred = collectMatches(/[。！？；.!?]/g)
      .filter(index => index >= softMin)
      .pop();
    if (preferred != null && preferred >= 0) return preferred + 1;

    const commaBreak = collectMatches(/[，、,:：；;）)]/g)
      .filter(index => index >= softMin)
      .pop();
    if (commaBreak != null && commaBreak >= 0) return commaBreak + 1;

    const newlineIndex = slice.lastIndexOf('\n');
    if (newlineIndex >= softMin) return newlineIndex + 1;

    const spaceIndex = slice.lastIndexOf(' ');
    if (spaceIndex >= softMin) return spaceIndex + 1;

    return Math.min(maxChars, segment.length);
  };

  while (remaining.length > maxChars) {
    const breakpoint = findBreak(remaining);
    const page = remaining.slice(0, breakpoint).trim();
    if (page) pages.push(page);
    remaining = remaining.slice(breakpoint).trim();
  }

  if (remaining) pages.push(remaining);
  return pages.length ? pages : ['……'];
}

function getReaderModel(state: AppState) {
  const readerMessages = getReaderMessages(state.uiMessages);
  const total = readerMessages.length;

  if (!total) {
    return {
      currentMessage: null,
      currentIndex: 0,
      previousMessage: null,
      nextMessage: null,
      total,
    };
  }

  const safeIndex = Math.min(Math.max(state.focusedMessageIndex, 0), Math.max(total - 1, 0));
  const currentMessage = readerMessages[safeIndex]!;
  const previousMessage = safeIndex > 0 ? readerMessages[safeIndex - 1] : null;
  const nextMessage = safeIndex < total - 1 ? readerMessages[safeIndex + 1] : null;

  return {
    currentMessage,
    currentIndex: safeIndex,
    previousMessage,
    nextMessage,
    total,
  };
}

function renderPreviewCard(message: UiMessage, index: number, side: 'before' | 'after') {
  const visibleText = getVisibleMessageText(message);
  if (!visibleText) return `<div class="reader-preview reader-preview--ghost"></div>`;

  const preview = escapeHtml(visibleText.slice(0, 72).trim() + (visibleText.length > 72 ? '……' : ''));

  return `
    <button class="reader-preview reader-preview--${side}" data-action="jump-message" data-index="${index}" data-reader-id="${escapeHtml(message.id)}">
      <span class="reader-preview__index">${String(index + 1).padStart(2, '0')}</span>
      <span class="reader-preview__text">${preview}</span>
    </button>
  `;
}

function renderReaderHint(direction: 'prev' | 'next', enabled: boolean) {
  const icon = direction === 'prev' ? '←' : '→';
  const label = direction === 'prev' ? '前页' : '后页';

  return `
    <span class="reader-card__hint ${enabled ? 'is-active' : 'is-disabled'}" aria-hidden="true">
      <span class="reader-card__hint-icon">${icon}</span>
      <span class="reader-card__hint-label">${label}</span>
    </span>
  `;
}

function renderTucaoPanel(message: UiMessage) {
  if (message.role !== 'assistant') return '';

  const blocks = extractTucaoBlocks(message.rawText || message.text, { streaming: message.streaming });
  if (!blocks.length) return '';

  return `
    <aside class="reader-tucao" aria-label="此方的脑内剧场">
      <div class="reader-tucao__list">
        ${blocks
          .map(
            block => `
              <div class="reader-tucao__item">${escapeHtml(block)}</div>
            `,
          )
          .join('')}
      </div>
    </aside>
  `;
}

function renderOptionsPanel(message: UiMessage) {
  if (message.role !== 'assistant') return '';
  if (message.streaming) return '';

  const options = extractOptionsBlock(message.rawText || message.text, { streaming: false });
  if (!options.length) return '';

  return `
    <aside class="reader-options" aria-label="快捷回复选项">
      <div class="reader-options__list">
        ${options
          .map(
            (option, index) => `
              <button
                class="reader-options__item"
                data-action="select-option"
                data-option-text="${escapeHtml(option)}"
                data-option-index="${index}"
              >
                ${escapeHtml(option)}
              </button>
            `,
          )
          .join('')}
      </div>
    </aside>
  `;
}

function renderIllustrationFigures(
  messageId: string,
  illustrations: MessageIllustration[],
  editing: AppState['imageRerollEditing'],
) {
  if (!illustrations.length) return '';

  return illustrations
    .map(illustration => {
      const isEditing = editing?.messageId === messageId && editing.illustrationId === illustration.id;
      const assetId = illustration.assetId?.trim();
      const cachedUrl = assetId ? getCachedImageAssetObjectUrl(assetId) : '';
      const inlineSrc = illustration.imageData?.trim() || '';
      const imageSrc = cachedUrl || inlineSrc;
      return `
        <figure class="reader-illustration">
          <button
            class="reader-illustration__reroll"
            data-action="reader-reroll-image"
            data-message-id="${escapeHtml(messageId)}"
            data-illustration-id="${escapeHtml(illustration.id)}"
            type="button"
            aria-label="重 roll 图片"
            title="重 roll 图片"
          >重 roll</button>
          <img
            class="reader-illustration__image${imageSrc ? ' is-loaded' : ' is-pending'}"
            ${imageSrc ? `src="${escapeHtml(imageSrc)}"` : ''}
            ${assetId ? `data-image-asset-id="${escapeHtml(assetId)}"` : ''}
            alt="${escapeHtml(illustration.prompt || 'generated illustration')}"
            loading="lazy"
          />
          ${
            isEditing
              ? `<div class="reader-illustration__prompt-editor">
                  <textarea
                    class="reader-illustration__prompt-field"
                    data-field="image-reroll-prompt"
                    aria-label="正向提示词"
                    spellcheck="false"
                  >${escapeHtml(editing.prompt)}</textarea>
                  <textarea
                    class="reader-illustration__prompt-field reader-illustration__prompt-field--negative"
                    data-field="image-reroll-negative-prompt"
                    aria-label="负向提示词"
                    placeholder="负向提示词（可留空）"
                    spellcheck="false"
                  >${escapeHtml(editing.negativePrompt)}</textarea>
                  <div class="reader-illustration__prompt-actions">
                    <button class="reader-illustration__prompt-btn" data-action="image-reroll-cancel" type="button">取消</button>
                    <button class="reader-illustration__prompt-btn reader-illustration__prompt-btn--primary" data-action="image-reroll-save" type="button">发送</button>
                  </div>
                </div>`
              : ''
          }
        </figure>
      `;
    })
    .join('');
}

function renderIllustrationPanel(messageId: string, illustrations: MessageIllustration[], editing: AppState['imageRerollEditing']) {
  if (!illustrations.length) return '';

  return `
    <div class="reader-illustrations">
      ${renderIllustrationFigures(messageId, illustrations, editing)}
    </div>
  `;
}

function hasRenderableIllustrations(message: UiMessage | undefined) {
  return Boolean(message?.illustrations?.some(illustration => Boolean(illustration.assetId?.trim() || illustration.imageData?.trim())));
}

type SaenaiSpriteId = 'megumi' | 'eriri' | 'utaha' | 'izumi' | 'michiru';
type SaenaiProfileId = 'sayuri' | 'sonoko' | 'akane';
type SaenaiAvatarId = SaenaiSpriteId | SaenaiProfileId;

interface SaenaiDialogueLine {
  characterName: string;
  mood: string;
  text: string;
  avatar: SaenaiAvatarId | null;
}

const SAENAI_AVATAR_ALIASES: Record<SaenaiAvatarId, string[]> = {
  megumi: ['加藤惠', '加藤恵', '惠', '恵', 'Megumi'],
  eriri: ['泽村·斯宾塞·英梨梨', '澤村·斯賓塞·英梨梨', '泽村英梨梨', '澤村英梨梨', '英梨梨', '英梨々', 'Eriri'],
  utaha: ['霞之丘诗羽', '霞之丘詩羽', '霞ヶ丘詩羽', '霞丘诗羽', '诗羽', '詩羽', 'Utaha'],
  izumi: ['波岛出海', '波島出海', '出海', 'Izumi'],
  michiru: ['冰堂美智留', '氷堂美智留', '美智留', 'Michiru'],
  sayuri: ['泽村小百合', '澤村小百合', '小百合', '小百合太太', 'Sayuri'],
  sonoko: ['町田苑子', '町田', '苑子', '町田编辑', '町田編輯', 'Sonoko', 'Machida'],
  akane: ['高坂茜', '红坂朱音', '紅坂朱音', '红坂', '紅坂', '朱音', '茜', 'Akane', 'Kosaka', 'Kousaka'],
};

const SAENAI_PROFILE_AVATARS = new Set<SaenaiAvatarId>(['sayuri', 'sonoko', 'akane']);

function normalizeSaenaiName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[·・\s　._-]/g, '');
}

function stripSaenaiDialogueBrackets(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1).trim();
  if (trimmed.startsWith('【') && trimmed.endsWith('】')) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function escapeSaenaiRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSaenaiAvatar(characterName: string): SaenaiAvatarId | null {
  const normalized = normalizeSaenaiName(characterName);
  for (const [avatar, aliases] of Object.entries(SAENAI_AVATAR_ALIASES) as Array<[SaenaiAvatarId, string[]]>) {
    if (aliases.some(alias => normalizeSaenaiName(alias) === normalized)) return avatar;
  }
  return null;
}

function getSaenaiAvatarClass(avatar: SaenaiAvatarId) {
  return [
    SAENAI_PROFILE_AVATARS.has(avatar) ? 'saenai-dialogue__avatar--profile' : '',
    `saenai-dialogue__avatar--${avatar}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function extractSaenaiBody(line: string) {
  const match = line.trim().match(/^[＠@]\s*saenai\s*[:：]\s*([\s\S]*)$/i);
  return match?.[1]?.trim() ?? '';
}

function extractWrappedSaenaiNarration(line: string) {
  const match = line.trim().match(/^[{｛]\s*[＠@]\s*saenai\s*[:：]\s*([\s\S]*?)\s*[}｝]\s*$/i);
  if (!match) return null;

  const body = match[1]?.trim() ?? '';
  const dialogue = parseSaenaiDialogueLine(`@saenai:${body}`);
  if (dialogue?.text) return dialogue.text;

  return body || null;
}

// Saenai 对话解析：五小只走雪碧图，成年组走 profile 头像；雪碧图第 0 格安艺伦也不参与映射。
function parseSaenaiDialogueLine(line: string): SaenaiDialogueLine | null {
  const body = extractSaenaiBody(line);
  if (!body) return null;

  const inline = body.match(/^([^|「『“"\[\]【】]+?)(?:\|([^「『“"\[\]【】]+))?([「『“"\[\]【】][\s\S]+)$/);
  if (inline) {
    const characterName = inline[1]?.trim() ?? '';
    const mood = inline[2]?.trim() ?? '';
    const text = stripSaenaiDialogueBrackets(inline[3] ?? '');
    if (!characterName || !text) return null;

    return {
      characterName,
      mood,
      text,
      avatar: getSaenaiAvatar(characterName),
    };
  }

  const double = body.match(/^([^|]+)\|([\s\S]+)$/);
  const triple = body.match(/^([^|]+)\|([^|]*)\|([\s\S]+)$/);
  const quad = body.match(/^([^|]+)\|([^|]+)\|([^|]*)\|([\s\S]+)$/);
  const match = quad ?? triple ?? double;
  if (!match) return null;

  const characterName = (quad ? match[2] : match[1])?.trim() ?? '';
  const mood = (quad ? match[3] : triple ? match[2] : '')?.trim() ?? '';
  const text = stripSaenaiDialogueBrackets((quad ? match[4] : triple ? match[3] : match[2]) ?? '');
  if (!characterName || !text) return null;

  return {
    characterName,
    mood,
    text,
    avatar: getSaenaiAvatar(characterName),
  };
}

function parseSaenaiDialogueTriggerLine(line: string): Omit<SaenaiDialogueLine, 'text'> | null {
  const body = extractSaenaiBody(line);
  if (!body || body.includes('[')) return null;

  const parts = body.split('|').map(part => part.trim());
  if (parts.length > 2) return null;

  const characterName = parts[0] ?? '';
  if (!characterName) return null;

  return {
    characterName,
    mood: parts[1] ?? '',
    avatar: getSaenaiAvatar(characterName),
  };
}

function splitSaenaiTriggeredDialogue(line: string) {
  const trimmed = line.trim();
  const quoted = trimmed.match(/^[「『“"]([\s\S]*?)[」』”"]\s*([\s\S]*)$/);
  if (quoted) {
    return {
      text: quoted[1]?.trim() ?? '',
      trailing: quoted[2]?.trim() ?? '',
    };
  }

  return {
    text: stripSaenaiDialogueBrackets(trimmed),
    trailing: '',
  };
}

function hasUnclosedSaenaiQuote(text: string) {
  const openIndex = text.search(/[「『“"]/);
  if (openIndex < 0) return false;

  const quotePairs: Array<[string, string]> = [
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
    ['"', '"'],
  ];

  return quotePairs.some(([open, close]) => {
    const opens = Array.from(text.matchAll(new RegExp(escapeSaenaiRegExp(open), 'g'))).length;
    const closes = Array.from(text.matchAll(new RegExp(escapeSaenaiRegExp(close), 'g'))).length;
    return opens > closes;
  });
}

function renderReaderTextBlock(text: string) {
  return text.trim() ? `<p class="reader-card__text">${escapeHtml(text.trim())}</p>` : '';
}

type ReaderHtmlContentSegment =
  | { kind: 'text'; value: string }
  | { kind: 'html'; value: string };

function splitReaderHtmlContent(text: string): ReaderHtmlContentSegment[] {
  const segments: ReaderHtmlContentSegment[] = [];
  const blockPattern = /<htmlcontent\b[^>]*>([\s\S]*?)(?:<\/htmlcontent\s*>|$)/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(text))) {
    if (match.index > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, match.index) });
    }
    segments.push({ kind: 'html', value: match[1] ?? '' });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', value: text.slice(cursor) });
  }

  return segments.length ? segments : [{ kind: 'text', value: text }];
}

function sanitizeReaderHtmlContent(html: string) {
  return String(html ?? '')
    .replace(/<!doctype\b[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<(?:iframe|object|embed|link|meta|base)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|link|meta|base)\s*>/gi, '')
    .replace(/<\/?(?:iframe|object|embed|link|meta|base|html|head|body)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src|xlink:href|formaction)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '')
    .replace(/\s+(?:href|src|xlink:href|formaction)\s*=\s*javascript:[^\s>]*/gi, '')
    .replace(/\s+style\s*=\s*(["'])([\s\S]*?)\1/gi, (_raw, quote: string, style: string) =>
      /(?:expression\s*\(|javascript:|-moz-binding)/i.test(style) ? '' : ` style=${quote}${style}${quote}`,
    );
}

function renderReaderHtmlContentBlock(html: string) {
  const safeHtml = sanitizeReaderHtmlContent(html).trim();
  return safeHtml ? `<div class="reader-htmlcontent">${safeHtml}</div>` : '';
}

function renderSaenaiDialogueLine(dialogue: SaenaiDialogueLine) {
  const avatar = dialogue.avatar
    ? `<span class="saenai-dialogue__avatar ${getSaenaiAvatarClass(dialogue.avatar)}" aria-hidden="true"></span>`
    : `<span class="saenai-dialogue__avatar saenai-dialogue__avatar--placeholder" aria-hidden="true">${escapeHtml(dialogue.characterName.slice(0, 1) || '?')}</span>`;
  const mood = dialogue.mood ? `<span class="saenai-dialogue__mood">${escapeHtml(dialogue.mood)}</span>` : '';

  return `
    <div class="saenai-dialogue">
      ${avatar}
      <div class="saenai-dialogue__content">
        <div class="saenai-dialogue__header">
          <span class="saenai-dialogue__name">${escapeHtml(dialogue.characterName)}</span>
          ${mood}
        </div>
        <div class="saenai-dialogue__text">${escapeHtml(dialogue.text)}</div>
      </div>
    </div>
  `;
}

function renderSaenaiDialoguePlainBody(text: string, fallback = false) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return fallback ? `<p class="reader-card__text">……</p>` : '';

  const blocks: string[] = [];
  const textBuffer: string[] = [];
  let pendingTrigger: Omit<SaenaiDialogueLine, 'text'> | null = null;
  let pendingDialogueLine = '';
  const flushText = () => {
    const rendered = renderReaderTextBlock(textBuffer.join('\n'));
    if (rendered) blocks.push(rendered);
    textBuffer.length = 0;
  };

  normalized.split('\n').forEach(line => {
    if (pendingDialogueLine) {
      pendingDialogueLine = `${pendingDialogueLine}${line.trim()}`;
      if (hasUnclosedSaenaiQuote(pendingDialogueLine)) return;

      const dialogue = parseSaenaiDialogueLine(pendingDialogueLine);
      if (dialogue) {
        flushText();
        blocks.push(renderSaenaiDialogueLine(dialogue));
      } else {
        textBuffer.push(pendingDialogueLine);
      }
      pendingDialogueLine = '';
      return;
    }

    const dialogue = parseSaenaiDialogueLine(line);
    if (dialogue && hasUnclosedSaenaiQuote(line)) {
      pendingDialogueLine = line.trim();
      return;
    }
    if (!dialogue) {
      const wrappedNarration = extractWrappedSaenaiNarration(line);
      if (wrappedNarration != null) {
        textBuffer.push(wrappedNarration);
        return;
      }

      const trigger = parseSaenaiDialogueTriggerLine(line);
      if (trigger) {
        flushText();
        pendingTrigger = trigger;
        return;
      }

      if (pendingTrigger && line.trim()) {
        const triggered = splitSaenaiTriggeredDialogue(line);
        if (triggered.text) {
          flushText();
          blocks.push(renderSaenaiDialogueLine({ ...pendingTrigger, text: triggered.text }));
          if (triggered.trailing) textBuffer.push(triggered.trailing);
          pendingTrigger = null;
          return;
        }
        pendingTrigger = null;
      }

      textBuffer.push(line);
      return;
    }

    flushText();
    pendingTrigger = null;
    blocks.push(renderSaenaiDialogueLine(dialogue));
  });

  if (pendingDialogueLine) {
    const dialogue = parseSaenaiDialogueLine(pendingDialogueLine);
    if (dialogue) {
      flushText();
      blocks.push(renderSaenaiDialogueLine(dialogue));
    } else {
      textBuffer.push(pendingDialogueLine);
    }
  }

  if (pendingTrigger) {
    textBuffer.unshift(`@saenai:${pendingTrigger.characterName}${pendingTrigger.mood ? `|${pendingTrigger.mood}` : ''}`);
  }

  flushText();
  return blocks.join('') || (fallback ? `<p class="reader-card__text">……</p>` : '');
}

function renderSaenaiDialogueBody(text: string) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return `<p class="reader-card__text">……</p>`;

  const segments = splitReaderHtmlContent(normalized);
  if (segments.length === 1 && segments[0]?.kind === 'text') {
    return renderSaenaiDialoguePlainBody(normalized, true);
  }

  const blocks = segments
    .map(segment =>
      segment.kind === 'html'
        ? renderReaderHtmlContentBlock(segment.value)
        : renderSaenaiDialoguePlainBody(segment.value, false),
    )
    .filter(Boolean);

  return blocks.join('') || `<p class="reader-card__text">……</p>`;
}

function renderAnchoredMessageBody(
  message: UiMessage,
  visibleText: string,
  editing: AppState['imageRerollEditing'],
) {
  const illustrations = message.illustrations?.filter(illustration => illustration.assetId?.trim() || illustration.imageData?.trim()) ?? [];
  const anchored = new Map<number, MessageIllustration[]>();
  const trailing: MessageIllustration[] = [];

  illustrations.forEach(illustration => {
    const anchorIndex = Number(illustration.anchorIndex);
    if (Number.isFinite(anchorIndex) && anchorIndex >= 0) {
      const key = Math.floor(anchorIndex);
      anchored.set(key, [...(anchored.get(key) ?? []), illustration]);
      return;
    }
    trailing.push(illustration);
  });

  const sourceWithAnchors =
    message.role === 'assistant'
      ? extractContextReplyWithImageGenerationTags(message.rawText || message.text, { streaming: message.streaming })
      : message.text;
  const hasImageAnchors = /<(?:generate_image|image)\b/i.test(sourceWithAnchors);
  const hasInlineAnchors = (anchored.size > 0 || hasImageAnchors) && hasImageAnchors;
  if (!hasInlineAnchors) {
    return `
      ${renderSaenaiDialogueBody(visibleText || '……')}
      ${renderIllustrationPanel(message.id, illustrations, editing)}
    `;
  }

  const usedAnchors = new Set<number>();
  const chunks = splitTextByImageGenerationAnchors(sourceWithAnchors)
    .map(segment => {
      if (segment.anchorIndex != null) {
        const figures = anchored.get(segment.anchorIndex) ?? [];
        usedAnchors.add(segment.anchorIndex);
        const button = message.streaming
          ? ''
          : `<button class="reader-image-generate" data-action="reader-generate-image" data-message-id="${escapeHtml(message.id)}" data-anchor-index="${segment.anchorIndex}" type="button">生成图片</button>`;
        const renderedFigures = figures.length
          ? `<div class="reader-illustrations reader-illustrations--inline">${renderIllustrationFigures(message.id, figures, editing)}</div>`
          : '';
        return `<div class="reader-image-anchor">${button}${renderedFigures}</div>`;
      }

      const text = segment.text.trim();
      return text ? renderSaenaiDialogueBody(text) : '';
    })
    .filter(Boolean);

  for (const [anchorIndex, figures] of anchored) {
    if (!usedAnchors.has(anchorIndex)) trailing.push(...figures);
  }

  return `
    ${chunks.join('') || renderSaenaiDialogueBody(visibleText || '……')}
    ${renderIllustrationPanel(message.id, trailing, editing)}
  `;
}

function renderReaderEditor(state: AppState) {
  const editing = state.readerEditing;
  if (!editing) return '';

  const readerMessages = getReaderMessages(state.uiMessages);
  const message = readerMessages[editing.readerIndex];
  if (!message) return '';

  const floorLabel = String(editing.readerIndex + 1).padStart(2, '0');
  const roleLabel = message.role === 'assistant' ? '助手' : message.role === 'user' ? '玩家' : '系统';
  const speakerLabel = escapeHtml(message.speaker || roleLabel);

  return `
    <div class="reader-editor" data-reader-editor="true">
      <div class="reader-editor__backdrop" data-action="reader-edit-cancel"></div>
      <div class="reader-editor__panel" role="dialog" aria-modal="true" aria-label="编辑楼层原文">
        <header class="reader-editor__header">
          <span class="reader-editor__meta">楼层 ${floorLabel} · ${speakerLabel}</span>
          <button class="reader-editor__close" data-action="reader-edit-cancel" aria-label="关闭">×</button>
        </header>
        <p class="reader-editor__hint">显示的是楼层的原始文本（含 ${escapeHtml('<content>')} 等标签）。修改后保存会同步回酒馆楼层。</p>
        <textarea
          class="reader-editor__textarea"
          data-field="reader-edit-draft"
          spellcheck="false"
        >${escapeHtml(editing.draft)}</textarea>
        <footer class="reader-editor__actions">
          <button class="reader-editor__action" data-action="reader-edit-cancel">取消</button>
          <button class="reader-editor__action reader-editor__action--primary" data-action="reader-edit-save">保存</button>
        </footer>
      </div>
    </div>
  `;
}

function renderReaderContextMenu(menu: ReaderContextMenuState | null, generating: boolean) {
  if (!menu) return '';

  const hasRollbackSource = Boolean(menu.sourceUserText);
  const actionHtml = hasRollbackSource
    ? `
      <button
        class="reader-context-menu__action"
        data-action="reader-rollback"
      >
        回溯输出
      </button>
      <button
        class="reader-context-menu__action reader-context-menu__action--primary"
        data-action="reader-regenerate"
        ${generating ? 'disabled' : ''}
      >
        ${generating ? '生成中…' : '重新生成该楼层'}
      </button>
    `
    : `
      <button
        class="reader-context-menu__action reader-context-menu__action--primary"
        data-action="reader-delete"
        ${menu.canDeleteMessage ? '' : 'disabled'}
      >
        删除该楼层
      </button>
    `;

  return `
    <div class="reader-context-menu" style="left:${menu.x}px;top:${menu.y}px;" data-reader-context-menu="true">
      ${actionHtml}
    </div>
  `;
}

function getRollbackSourceForReaderIndex(state: AppState, readerIndex: number) {
  const readerMessages = getReaderMessages(state.uiMessages);
  const targetMessage = readerMessages[readerIndex];
  if (!targetMessage) return '';

  const targetUiIndex = state.uiMessages.findIndex(message => message.id === targetMessage.id);
  if (targetUiIndex < 0) return '';

  if (targetMessage.role === 'user') return targetMessage.text.trim();

  for (let cursor = targetUiIndex - 1; cursor >= 0; cursor -= 1) {
    const candidate = state.uiMessages[cursor];
    if (candidate?.role === 'user' && candidate.text.trim()) return candidate.text.trim();
  }

  return '';
}

function renderReaderActionsButton(state: AppState, readerIndex: number, className: string) {
  const readerMessages = getReaderMessages(state.uiMessages);
  const message = readerMessages[readerIndex];
  if (!message) return '';

  const sourceUserText = getRollbackSourceForReaderIndex(state, readerIndex);
  if (!sourceUserText) return '';

  return `
    <button
      class="${className}"
      data-action="reader-actions-open"
      data-reader-index="${readerIndex}"
      data-reader-id="${escapeHtml(message.id)}"
      title="楼层操作"
      aria-label="打开楼层操作"
    >
      +
    </button>
  `;
}

function renderReaderDeck(state: AppState, flipDir: string = '') {
  const model = getReaderModel(state);
  if (!model.currentMessage) {
    return `
      <section class="paper-reader paper-reader--empty">
        <div class="paper-reader__lane paper-reader__lane--top"><div class="reader-preview reader-preview--ghost"></div></div>
        <article class="reader-card reader-card--system">
          <div class="reader-card__chrome">
            <div class="reader-card__hint-group reader-card__hint-group--left">
              ${renderReaderHint('prev', false)}
            </div>
            <span class="reader-card__index">00</span>
            <div class="reader-card__hint-group reader-card__hint-group--right">
              ${renderReaderHint('next', false)}
            </div>
          </div>
          <div class="reader-card__body" tabindex="0">
            <p class="reader-card__text">等待着你的故事开始。</p>
          </div>
        </article>
        <div class="paper-reader__lane paper-reader__lane--bottom"><div class="reader-preview reader-preview--ghost"></div></div>
      </section>
    `;
  }

  const message = model.currentMessage;
  const visibleText = getVisibleMessageText(message);
  const illustrations = message.illustrations?.filter(illustration => illustration.assetId?.trim() || illustration.imageData?.trim()) ?? [];
  const hasIllustrations = hasRenderableIllustrations(message);
  const deckClasses = ['paper-reader'];
  if (hasIllustrations) deckClasses.push('paper-reader--with-illustrations');

  const topLane = `
    <div class="paper-reader__lane paper-reader__lane--top">
      ${model.previousMessage ? renderPreviewCard(model.previousMessage, model.currentIndex - 1, 'before') : '<div class="reader-preview reader-preview--ghost"></div>'}
    </div>
  `;
  const bottomLane = `
    <div class="paper-reader__lane paper-reader__lane--bottom">
      ${model.nextMessage ? renderPreviewCard(model.nextMessage, model.currentIndex + 1, 'after') : '<div class="reader-preview reader-preview--ghost"></div>'}
    </div>
  `;

  if (!visibleText && !hasIllustrations && !message.streaming) {
    return `
      <section class="${deckClasses.join(' ')}">
        ${topLane}

        <article
          class="reader-card reader-card--${message.role} reader-card--empty"
          data-reader-index="${model.currentIndex}"
          data-reader-id="${escapeHtml(message.id)}"
          data-has-illustrations="${hasIllustrations ? 'true' : 'false'}"
          ${flipDir ? ` data-flip="${flipDir}"` : ''}
        >
          <div class="reader-card__chrome">
            <div class="reader-card__hint-group reader-card__hint-group--left">
              ${renderReaderHint('prev', Boolean(model.previousMessage))}
            </div>
            <span class="reader-card__index">${String(model.currentIndex + 1).padStart(2, '0')}</span>
            <button class="reader-card__edit" data-action="reader-edit" data-reader-index="${model.currentIndex}" data-reader-id="${escapeHtml(message.id)}" title="编辑原文" aria-label="编辑原文">✎</button>
            <div class="reader-card__hint-group reader-card__hint-group--right">
              ${renderReaderHint('next', Boolean(model.nextMessage))}
            </div>
          </div>
          <div class="reader-card__body" tabindex="0">
            <p class="reader-card__text reader-card__text--empty">这条楼层没有可显示的正文，点右上角✎查看或修复原文。</p>
          </div>
        </article>

        ${bottomLane}
      </section>
    `;
  }

  return `
    <section class="${deckClasses.join(' ')}">
      ${topLane}

      <article
        class="reader-card reader-card--${message.role}${hasIllustrations ? ' reader-card--with-illustrations' : ''}"
        data-reader-index="${model.currentIndex}"
        data-reader-id="${escapeHtml(message.id)}"
        data-has-illustrations="${hasIllustrations ? 'true' : 'false'}"
        ${flipDir ? ` data-flip="${flipDir}"` : ''}
      >
        <div class="reader-card__chrome">
          <div class="reader-card__hint-group reader-card__hint-group--left">
            ${renderReaderHint('prev', Boolean(model.previousMessage))}
          </div>
          <span class="reader-card__index">${String(model.currentIndex + 1).padStart(2, '0')}</span>
          ${message.streaming ? '<span class="reader-card__streaming">记录中…</span>' : ''}
          ${
            message.streaming
              ? ''
              : `<button class="reader-card__edit" data-action="reader-edit" data-reader-index="${model.currentIndex}" data-reader-id="${escapeHtml(message.id)}" title="编辑原文" aria-label="编辑原文">✎</button>`
          }
          <div class="reader-card__hint-group reader-card__hint-group--right">
            ${renderReaderHint('next', Boolean(model.nextMessage))}
          </div>
        </div>
        <div class="reader-card__body" tabindex="0">
          ${renderAnchoredMessageBody(message, visibleText, state.imageRerollEditing)}
        </div>
        ${renderOptionsPanel(message)}
      </article>

      ${bottomLane}
    </section>
  `;
}

function getWeekday(dateStr: string) {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  try {
    const d = new Date(dateStr.replace(/\s.*$/, ''));
    if (!isNaN(d.getTime())) return `${days[d.getDay()]}曜日`;
  } catch {
    /* 忽略 */
  }
  return '';
}

function renderJournalHeader(state: AppState, controlsHtml = '') {
  const dateStr = formatDate(state.statusData.world.currentTime);
  const weekday = getWeekday(state.statusData.world.currentTime);
  const jumpComposerButton = `
    <button
      class="paper-fullscreen-btn paper-jump-composer-btn"
      data-action="jump-to-composer"
      type="button"
      title="直达底部输入框"
      aria-label="直达底部输入框"
    >
      <span class="paper-jump-composer-btn__icon" aria-hidden="true"></span>
    </button>
  `;

  return `
    <header class="journal-header">
      <div class="journal-date-block">
        <span class="journal-weekday">${escapeHtml(weekday)}</span>
        <div class="journal-date">
          ${escapeHtml(dateStr)}<small>${escapeHtml(formatTime(state.statusData.world.currentTime))}</small>
        </div>
        <div class="journal-location">地点 ${escapeHtml(state.statusData.world.currentLocation)}</div>
      </div>
      <div class="journal-header__actions">
        ${jumpComposerButton}
        ${controlsHtml}
        <div class="journal-sticker">
          ${escapeHtml(state.playerProfile.className || '主角档案')}
        </div>
      </div>
    </header>
  `;
}

export function renderPaperWorkspace(state: AppState, flipDir: string = '', options: { embedded?: boolean } = {}) {
  const embedded = options.embedded ?? false;
  const composerId = embedded ? 'islandmilfcode-phone-composer' : 'islandmilfcode-composer';
  const readerMessages = getReaderMessages(state.uiMessages);
  const currentReaderIndex = Math.min(Math.max(state.focusedMessageIndex, 0), Math.max(readerMessages.length - 1, 0));
  const composerActionsButton = renderReaderActionsButton(state, currentReaderIndex, 'composer-floor-actions');
  const composerTopButton = embedded
    ? ''
    : `
      <button
        class="composer-top-btn"
        data-action="jump-to-paper-top"
        type="button"
        title="回到顶部"
        aria-label="回到顶部"
      >
        <span class="composer-top-btn__icon" aria-hidden="true"></span>
      </button>
    `;
  const fullscreenClass = !embedded && isPaperWorkspaceFullscreen(state) ? ' is-paper-fullscreen' : '';
  const fullscreenButton = embedded ? '' : renderPaperFullscreenButton(state);
  const readerFocusMessage = readerMessages[currentReaderIndex];
  const readerHasIllustrations = hasRenderableIllustrations(readerFocusMessage);
  const paperTheme = getPaperTheme(state);
  const workspaceClasses = ['paper-workspace'];
  workspaceClasses.push(`paper-theme--${paperTheme}`);
  if (embedded) workspaceClasses.push('paper-workspace--phone');
  if (fullscreenClass) workspaceClasses.push('is-paper-fullscreen');
  if (readerHasIllustrations) workspaceClasses.push('paper-workspace--with-illustrations');
  return `
    <section class="${workspaceClasses.join(' ')}">
      ${embedded ? '' : '<div class="washi-strip washi-strip--top" aria-hidden="true"></div>'}
      ${embedded ? '' : '<div class="washi-strip washi-strip--side" aria-hidden="true"></div>'}

      ${embedded ? '' : renderJournalHeader(state, fullscreenButton)}

      ${embedded ? '' : renderPaperThemeControls(state)}

      <div class="section-tab">
        <span class="section-tab__label">对话记录</span>
        <span class="section-tab__status">${state.generating ? '记录中…' : '已落笔'}</span>
      </div>

      ${renderReaderDeck(state, flipDir)}

      <div class="section-tab" style="margin-top:16px">
        <span class="section-tab__label" style="background:var(--washi-mint)">继续书写</span>
      </div>

      <div class="paper-composer-card">
        <label class="paper-composer-card__label" for="${composerId}">这个故事的后续…</label>
        <textarea
          id="${composerId}"
          class="composer-input"
          name="islandmilfcode-composer"
          placeholder="在这里写下接下来的内容……"
          ${state.generating ? 'disabled' : ''}
        >${escapeHtml(state.draft)}</textarea>

        <div class="composer-actions">
          ${composerTopButton}
          ${composerActionsButton}
          ${state.generating ? '<span class="composer-tip">写入中……</span>' : ''}
          <button class="send-btn" data-action="send">${state.generating ? '取消' : '记录'}</button>
        </div>
      </div>
    </section>
  `;
}

function getTucaoFloatState(state: AppState) {
  const raw =
    typeof state.runtimeFlags.tucaoFloat === 'object' && state.runtimeFlags.tucaoFloat
      ? (state.runtimeFlags.tucaoFloat as Record<string, unknown>)
      : {};
  return {
    x: Math.max(8, Number(raw.x ?? 28) || 28),
    y: Math.max(8, Number(raw.y ?? 92) || 92),
    collapsed: Boolean(raw.collapsed),
  };
}

function renderTucaoFloatingPanel(state: AppState) {
  const readerMessages = getReaderMessages(state.uiMessages);
  const safeIndex = Math.min(Math.max(state.focusedMessageIndex, 0), Math.max(readerMessages.length - 1, 0));
  const message = readerMessages[safeIndex];
  if (!message || message.role !== 'assistant') return '';

  const blocks = extractTucaoBlocks(message.rawText || message.text, { streaming: message.streaming });
  if (!blocks.length) return '';

  const floatState = getTucaoFloatState(state);
  const collapsedClass = floatState.collapsed ? ' is-collapsed' : '';

  return `
    <aside
      class="reader-tucao-float${collapsedClass}"
      style="left:${floatState.x}px;top:${floatState.y}px"
      data-tucao-float="true"
      aria-label="此方的脑内剧场"
    >
      <header class="reader-tucao-float__header" data-tucao-drag-handle="true">
        <span class="reader-tucao-float__title">此方的脑内剧场</span>
        <button
          class="reader-tucao-float__toggle"
          data-action="toggle-tucao-float"
          aria-label="${floatState.collapsed ? '展开吐槽浮窗' : '折叠吐槽浮窗'}"
          title="${floatState.collapsed ? '展开' : '折叠'}"
        >
          ${floatState.collapsed ? '💬' : '-'}
        </button>
      </header>
      <div class="reader-tucao-float__body">
        ${renderTucaoPanel(message)}
      </div>
    </aside>
  `;
}

function renderBackgroundTaskToast(task: BackgroundTaskState) {
  const isFailed = task.status === 'failed';
  return `
    <section class="background-task background-task--${task.status}">
      <div class="background-task__status">
        <span class="background-task__spinner" aria-hidden="true"></span>
        <div class="background-task__copy">
          <strong>${escapeHtml(task.label)}</strong>
          ${task.detail ? `<span>${escapeHtml(task.detail)}</span>` : ''}
        </div>
      </div>
      ${
        isFailed
          ? `<button class="background-task__retry" data-action="retry-background-task" data-task-kind="${escapeHtml(task.kind)}">重试</button>`
          : '<div class="background-task__bar" aria-hidden="true"><span></span></div>'
      }
    </section>
  `;
}

function renderBackgroundTasks(tasks: BackgroundTaskState[]) {
  if (!tasks.length) return '';
  const orderedTasks = [...tasks].sort((a, b) => {
    if (a.kind === b.kind) return b.updatedAt - a.updatedAt;
    return a.kind === 'progress' ? -1 : 1;
  });
  return `
    <aside class="background-task-stack" aria-live="polite">
      ${orderedTasks.map(renderBackgroundTaskToast).join('')}
    </aside>
  `;
}

export function renderSummaryPanel(state: AppState) {
  const lastMessage = state.uiMessages[state.uiMessages.length - 1];
  const playerName = state.playerProfile.name.trim() || '主角';
  const playerMeta =
    [state.playerProfile.className, state.playerProfile.gender].filter(Boolean).join(' · ') || '主角档案';
  const store = state.summaryStore;

  return `
    <section class="panel-card panel-card--generic">
      <div class="panel-title">角色总结</div>
      <div class="panel-scroll" data-scroll-region="summary">
        <div class="hero-card">
          <div class="hero-row">
            <div class="avatar-badge">${escapeHtml(playerName)}</div>
            <div>
              <div class="hero-name">${escapeHtml(playerName)}</div>
              <div class="hero-sub">${escapeHtml(playerMeta)}</div>
            </div>
          </div>
        </div>

        <div class="subsection">
          <div class="subsection-title">最近一句</div>
          <div class="summary-card">
            <strong>${lastMessage ? escapeHtml(lastMessage.speaker) : '暂无对白'}</strong>
            <p>${lastMessage ? escapeHtml(getVisibleMessageText(lastMessage) || '……') : '等待新的记录写入。'}</p>
          </div>
        </div>

        ${renderMemorySummarySection(store, state.summarizing, state.uiMessages)}
      </div>
    </section>
  `;
}

function renderMemorySummarySection(store: SummaryStore, summarizing: boolean, uiMessages: UiMessage[]): string {
  let errorHtml = '';
  if (store.lastError) {
    errorHtml = `
      <div class="chip-card" style="border-left:3px solid var(--accent-warm,#e74c3c)">
        <strong>总结失败 (${escapeHtml(store.lastError.level)})</strong>
        <p>${escapeHtml(store.lastError.message)}</p>
        <button class="mini-btn" data-action="summary-retry">重试</button>
      </div>`;
  }

  if (store.autoPaused) {
    errorHtml += `
      <div class="chip-card" style="border-left:3px solid #f39c12">
        <strong>自动总结已暂停</strong>
        <p>连续失败 ${store.consecutiveFailures} 次</p>
        <button class="mini-btn" data-action="summary-resume">恢复自动总结</button>
      </div>`;
  }

  const renderInlineEditor = (level: 'global' | 'major' | 'minor', index: number, text: string) => `
    <div class="summary-inline-editor">
      <textarea
        class="summary-inline-editor__field"
        data-field="summary-edit-text"
        data-edit-level="${level}"
        data-edit-index="${index}"
        rows="4"
      >${escapeHtml(text)}</textarea>
      <div class="summary-inline-editor__actions">
        <button class="summary-edit-btn summary-edit-btn--primary" data-action="summary-save-edit" data-edit-level="${level}" data-edit-index="${index}" ${summarizing ? 'disabled' : ''}>保存</button>
        <button class="summary-edit-btn" data-action="summary-cancel-edit" type="button">取消</button>
      </div>
    </div>
  `;

  const globalHtml = store.global
    ? `<div class="subsection">
        <div class="subsection-title">全局摘要</div>
        <div class="chip-card summary-edit-card" data-summary-card>
          <div class="summary-edit-card__body">
            <p class="summary-edit-card__text">${escapeHtml(store.global)}</p>
            <button class="mini-btn summary-edit-card__icon" data-action="summary-edit" data-edit-level="global" ${summarizing ? 'disabled' : ''}>✏️</button>
          </div>
          ${renderInlineEditor('global', -1, store.global)}
        </div>
      </div>`
    : '';

  const majorHtml = store.major.length
    ? `<div class="subsection">
        <div class="subsection-title">大总结 <span style="opacity:0.5;font-size:11px">(${store.major.length}条)</span></div>
        <div class="chip-list">${store.major
          .map((e, i) => {
            const [uiStart, uiEnd] = mapSummaryRangeToUiRange(e.range);
            return `<div class="chip-card summary-edit-card" data-summary-card style="border-left:3px solid var(--accent-primary,#7c6ca8)">
                <div class="summary-edit-card__header">
                  <strong>#${i + 1} · 楼层 ${uiStart}-${uiEnd}</strong>
                  <div class="summary-edit-card__tools">
                    <button class="mini-btn summary-edit-card__icon" data-action="summary-edit" data-edit-level="major" data-edit-index="${i}" ${summarizing ? 'disabled' : ''}>✏️</button>
                    <button class="mini-btn summary-edit-card__icon" data-action="summary-reroll" data-reroll-level="major" data-reroll-index="${i}" ${summarizing ? 'disabled' : ''}>🎲</button>
                  </div>
                </div>
                <p class="summary-edit-card__text">${escapeHtml(e.text)}</p>
                ${renderInlineEditor('major', i, e.text)}
                <div style="font-size:10px;opacity:0.45;margin-top:4px">${escapeHtml(e.createdAt.slice(0, 16).replace('T', ' '))}</div>
              </div>`;
          })
          .join('')}
        </div>
      </div>`
    : '';

  const minorHtml = store.minor.length
    ? `<div class="subsection">
        <div class="subsection-title">小总结 <span style="opacity:0.5;font-size:11px">(${store.minor.length}条)</span></div>
        <div class="chip-list">${store.minor
          .map((e, i) => {
            const [uiStart, uiEnd] = mapSummaryRangeToUiRange(e.range);
            return `<div class="chip-card summary-edit-card" data-summary-card>
                <div class="summary-edit-card__header">
                  <strong>#${i + 1} · 楼层 ${uiStart}-${uiEnd}</strong>
                  <div class="summary-edit-card__tools">
                    <button class="mini-btn summary-edit-card__icon" data-action="summary-edit" data-edit-level="minor" data-edit-index="${i}" ${summarizing ? 'disabled' : ''}>✏️</button>
                    <button class="mini-btn summary-edit-card__icon" data-action="summary-reroll" data-reroll-level="minor" data-reroll-index="${i}" ${summarizing ? 'disabled' : ''}>🎲</button>
                  </div>
                </div>
                <p class="summary-edit-card__text">${escapeHtml(e.text)}</p>
                ${renderInlineEditor('minor', i, e.text)}
                <div style="font-size:10px;opacity:0.45;margin-top:4px">${escapeHtml(e.createdAt.slice(0, 16).replace('T', ' '))}</div>
              </div>`;
          })
          .join('')}
        </div>
      </div>`
    : '';

  const hasAny = store.global || store.major.length || store.minor.length;
  const rangeContains = (outer: [number, number], inner: [number, number]) =>
    inner[0] >= outer[0] && inner[1] <= outer[1];
  const unmergedMinorCount = store.minor.filter(
    minor => !store.major.some(major => rangeContains(major.range, minor.range)),
  ).length;
  // lastSummarizedIndex 是已覆盖的 Reader 可见完成楼层数，直接等于 UI 上“已总结到 #N”的 N。
  const lastSummarizedUi = store.lastSummarizedIndex;
  const summaryFloorCount = getSummaryMessages(uiMessages).length;
  const pendingCount = Math.max(0, summaryFloorCount - store.lastSummarizedIndex);
  const minorThreshold = Math.max(1, Number(loadFullMemoryConfig().summaryTrigger.minorThreshold) || 5);
  const pendingMinorText =
    pendingCount >= minorThreshold
      ? `待小总结 ${pendingCount}/${minorThreshold}（可触发）`
      : `待小总结 ${pendingCount}/${minorThreshold}（未触发）`;
  const statusLine = `已总结到楼层 #${lastSummarizedUi} · ${pendingMinorText} · 小总结 ${store.minor.length}（待大总结 ${unmergedMinorCount}） · 大总结 ${store.major.length} · 全局 ${store.global ? '有' : '无'}`;
  const pendingHint = pendingCount
    ? pendingCount >= minorThreshold
      ? `<div class="summary-pending" style="font-size:11px;color:#c97c5d;margin-bottom:8px;padding:4px 8px;background:rgba(201,124,93,0.08);border-radius:6px">还有 <strong>${pendingCount}</strong> 个楼层未被小总结吞掉，可点下方「小总结」推进摘要游标。</div>`
      : `<div class="summary-pending" style="font-size:11px;color:#8a7a62;margin-bottom:8px;padding:4px 8px;background:rgba(138,122,98,0.08);border-radius:6px">小总结还差 <strong>${minorThreshold - pendingCount}</strong> 条触发；大总结只消化已有小总结，不推进楼层游标。</div>`
    : '';
  // 大总结补救提示：只计算尚未被大总结覆盖的小总结，历史小总结仍保留展示。
  const majorPendingHint = unmergedMinorCount >= 4
    ? `<div class="summary-pending" style="font-size:11px;color:#7c6ca8;margin-bottom:8px;padding:4px 8px;background:rgba(124,108,168,0.08);border-radius:6px">待大总结的小总结还有 <strong>${unmergedMinorCount}</strong> 条，可点下方「大总结」一次性消化。</div>`
    : '';

  return `
    <div class="subsection">
      <div class="subsection-title">记忆摘要 ${summarizing ? '<span style="opacity:0.6">总结中…</span>' : ''}</div>
      <div class="summary-status" style="font-size:11px;opacity:0.7;margin-bottom:8px">${statusLine}</div>
      ${pendingHint}
      ${majorPendingHint}
      ${errorHtml}
      ${hasAny ? [globalHtml, majorHtml, minorHtml].filter(Boolean).join('') : '<div class="empty-card">还没有生成过摘要。</div>'}
      <div class="summary-actions" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="mini-btn" data-action="summary-minor" style="white-space:nowrap;flex:1;min-height:30px" ${summarizing ? 'disabled' : ''}>小总结</button>
        <button class="mini-btn" data-action="summary-major" style="white-space:nowrap;flex:1;min-height:30px" ${summarizing ? 'disabled' : ''}>大总结</button>
        <button class="mini-btn" data-action="summary-global" style="white-space:nowrap;flex:1;min-height:30px" ${summarizing ? 'disabled' : ''}>全局摘要</button>
      </div>
    </div>`;
}

export function renderSummaryConfigSection(state: AppState): string {
  const memoryConfig = loadFullMemoryConfig();
  const secondaryApiConfig = state.summaryApiConfig;
  const secondaryApiEnabled = !!secondaryApiConfig;
  const secondaryApiUrl = secondaryApiConfig?.apiurl ?? '';
  const secondaryApiKey = secondaryApiConfig?.key ?? '';
  const secondaryApiModel = secondaryApiConfig?.model ?? '';
  const secondaryApiSource = secondaryApiConfig?.source ?? 'openai';
  const modelFetch = state.summaryModelFetch;
  const modelOptions = modelFetch.models
    .map(model => {
      const label = model.ownedBy ? `${model.id} · ${model.ownedBy}` : model.id;
      return `<option value="${escapeHtml(model.id)}" ${model.id === secondaryApiModel ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');
  const modelFetchHint = modelFetch.error
    ? `<p style="font-size:11px;color:#b85c6e;margin:6px 0 0">${escapeHtml(modelFetch.error)}</p>`
    : modelFetch.fetchedAt
      ? `<p style="font-size:11px;opacity:0.65;margin:6px 0 0">已获取 ${modelFetch.models.length} 个模型。</p>`
      : '<p style="font-size:11px;opacity:0.65;margin:6px 0 0">可从兼容 OpenAI /models 的端点拉取模型列表。</p>';

  return `
    <div class="subsection">
      <div class="subsection-title">副 API 配置</div>
      <div class="chip-list">
        <div class="chip-card">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-action="summary-toggle-custom" ${secondaryApiEnabled ? 'checked' : ''}>
            <span>启用副 API 处理摘要、变量与手机后台分析</span>
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">关闭时会回落到主 API；开启后后台任务走这里配置的模型。</p>
        </div>

        <div class="chip-card">
          <label>
            API URL<br>
            <input type="text" data-field="summary-apiurl" value="${escapeHtml(secondaryApiUrl)}" placeholder="https://api.openai.com/v1/chat/completions" ${secondaryApiEnabled ? '' : 'disabled'} style="width:100%;box-sizing:border-box">
          </label>
        </div>

        <div class="chip-card">
          <label>
            API Key<br>
            <input type="password" data-field="summary-key" value="${escapeHtml(secondaryApiKey)}" placeholder="sk-..." ${secondaryApiEnabled ? '' : 'disabled'} style="width:100%;box-sizing:border-box">
          </label>
        </div>

        <div class="chip-card">
          <label>
            Source<br>
            <input type="text" data-field="summary-source" value="${escapeHtml(secondaryApiSource)}" placeholder="openai" ${secondaryApiEnabled ? '' : 'disabled'} style="width:100%;box-sizing:border-box">
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">通常填 openai；保持和酒馆 custom_api source 约定一致。</p>
        </div>

        <div class="chip-card">
          <label>
            Model<br>
            <input type="text" data-field="summary-model" value="${escapeHtml(secondaryApiModel)}" placeholder="gpt-4.1-mini" ${secondaryApiEnabled ? '' : 'disabled'} style="width:100%;box-sizing:border-box">
          </label>
          ${
            modelOptions
              ? `<select data-field="summary-model-select" ${secondaryApiEnabled ? '' : 'disabled'} style="width:100%;box-sizing:border-box;margin-top:8px">
                  <option value="">选择已获取的模型</option>
                  ${modelOptions}
                </select>`
              : ''
          }
          ${modelFetchHint}
          <button class="mini-btn" data-action="summary-fetch-models" ${secondaryApiEnabled || modelFetch.loading ? '' : 'disabled'} style="width:100%;margin-top:8px">${modelFetch.loading ? '获取中...' : '获取模型列表'}</button>
        </div>

        <button class="summary-config-save" data-action="summary-save-config" ${secondaryApiEnabled ? '' : 'disabled'}>保存副 API 配置</button>
      </div>
    </div>

    <div class="subsection">
      <div class="subsection-title">摘要触发配置</div>
      <div class="chip-list">
        <div class="chip-card">
          <label>
            Minor 摘要触发阈值（条消息）<br>
            <input type="number" data-trigger-field="minorThreshold" value="${memoryConfig.summaryTrigger.minorThreshold}" min="1" max="20" style="width:100%;box-sizing:border-box">
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">默认 5 条，每累积 N 条新消息触发一次 minor 摘要</p>
        </div>

        <div class="chip-card">
          <label>
            Major 摘要触发阈值（条 minor）<br>
            <input type="number" data-trigger-field="majorThreshold" value="${memoryConfig.summaryTrigger.majorThreshold}" min="2" max="10" style="width:100%;box-sizing:border-box">
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">默认 4 条，每累积 N 条 minor 摘要触发一次 major 摘要</p>
        </div>

        <div class="chip-card">
          <label>
            Global 压缩触发阈值（条 major）<br>
            <input type="number" data-trigger-field="globalThreshold" value="${memoryConfig.summaryTrigger.globalThreshold}" min="2" max="10" style="width:100%;box-sizing:border-box">
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">默认 4 条，每累积 N 条 major 摘要触发一次 global 压缩</p>
        </div>
      </div>
    </div>

    <div class="subsection">
      <div class="subsection-title">记忆注入配置</div>
      <div class="chip-list">
        <div class="chip-card">
          <label>
            Token 预算<br>
            <input type="number" data-injection-field="tokenBudget" value="${memoryConfig.injection.tokenBudget}" min="5000" max="50000" step="1000" style="width:100%;box-sizing:border-box">
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">默认 15000，约 22500 字符，控制注入到 prompt 的记忆总量</p>
        </div>

        <div class="chip-card">
          <label>
            Minor 摘要注入窗口<br>
            <input type="number" data-injection-field="minorWindowSize" value="${memoryConfig.injection.minorWindowSize}" min="3" max="20" style="width:100%;box-sizing:border-box">
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">默认 8 条，注入到 prompt 时保留最近多少条 minor 摘要</p>
        </div>

        <div class="chip-card">
          <label>
            Major 摘要注入窗口<br>
            <input type="number" data-injection-field="majorWindowSize" value="${memoryConfig.injection.majorWindowSize}" min="2" max="10" style="width:100%;box-sizing:border-box">
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">默认 5 条，注入到 prompt 时保留最近多少条 major 摘要</p>
        </div>

        <div class="chip-card">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-injection-field="includeFacts" ${memoryConfig.injection.includeFacts ? 'checked' : ''}>
            <span>注入关键事实</span>
          </label>
        </div>

        <div class="chip-card">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-injection-field="includeTasks" ${memoryConfig.injection.includeTasks ? 'checked' : ''}>
            <span>注入待办任务</span>
          </label>
        </div>

        <div class="chip-card">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-injection-field="includeSecrets" ${memoryConfig.injection.includeSecrets ? 'checked' : ''}>
            <span>注入保密事项</span>
          </label>
        </div>

        <div class="chip-card">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-injection-field="includeImpressions" ${memoryConfig.injection.includeImpressions ? 'checked' : ''}>
            <span>注入角色印象</span>
          </label>
        </div>

        <div class="chip-card">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-injection-field="includeItems" ${memoryConfig.injection.includeItems ? 'checked' : ''}>
            <span>注入物品变动</span>
          </label>
        </div>

        <div class="chip-card">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-injection-field="onlyPromptRelevantItems" ${memoryConfig.injection.onlyPromptRelevantItems ? 'checked' : ''}>
            <span>只注入特殊含义物品</span>
          </label>
          <p style="font-size:11px;opacity:0.65;margin:6px 0 0">默认开启，普通库存不会占用 prompt</p>
        </div>

        <button class="summary-config-save" data-action="memory-config-save">保存记忆配置</button>
        <button class="mini-btn" data-action="memory-config-reset" style="width:100%;margin-top:8px">重置为默认</button>
      </div>
    </div>`;
}

export function renderStatusPanel(state: AppState): string {
  const { statusData, playerProfile } = state;
  const playerName = playerProfile.name.trim() || '主角';
  const playerClass = playerProfile.className || '未知';
  const playerGender = playerProfile.gender || '未知';
  const playerFamilyName = playerProfile.familyName;
  const playerGivenName = playerProfile.givenName;
  const playerPersonality = playerProfile.personality || '待补充';
  const playerAppearance = playerProfile.appearance || '待补充';
  const profileEditing = state.playerProfileEditing || false;
  const currentMainEventId = statusData.world.currentMainEventId;
  const currentMainEventStatus = statusData.world.mainEvents[currentMainEventId];
  const isRunningMainEventStatus = (status: string) => {
    const normalized = String(status ?? '').trim();
    return normalized === '进行中';
  };
  const visibleCurrentMainEventId = isRunningMainEventStatus(currentMainEventStatus) ? currentMainEventId : '';

  // 手机状态页只展示正在进行的主线；已结束、未触发、延后/跳过都不占页面。
  const mainEvents = Object.entries(statusData.world.mainEvents || {}).filter(
    ([id, status]) => id !== visibleCurrentMainEventId && isRunningMainEventStatus(status),
  );

  const profileBody = profileEditing
    ? `
      <div class="chip-card">
        <label>
          姓氏<br>
          <input type="text" data-profile-field="familyName" value="${escapeHtml(playerFamilyName || '')}" style="width:100%;box-sizing:border-box">
        </label>
      </div>
      <div class="chip-card">
        <label>
          名字<br>
          <input type="text" data-profile-field="givenName" value="${escapeHtml(playerGivenName || '')}" style="width:100%;box-sizing:border-box">
        </label>
      </div>
      <div class="chip-card">
        <label>
          主角性格<br>
          <textarea data-profile-field="personality" style="width:100%;box-sizing:border-box;min-height:60px">${escapeHtml(playerPersonality)}</textarea>
        </label>
      </div>
      <div class="chip-card">
        <label>
          主角相貌<br>
          <textarea data-profile-field="appearance" style="width:100%;box-sizing:border-box;min-height:60px">${escapeHtml(playerAppearance)}</textarea>
        </label>
      </div>
      <div class="chip-card profile-edit-actions">
        <button class="profile-save-btn" data-action="save-player-profile-edit" type="button">保存</button>
        <button class="profile-cancel-btn" data-action="cancel-player-profile-edit" type="button">取消</button>
      </div>
    `
    : `
      <div class="chip-card">
        <strong>姓氏</strong>
        <p>${escapeHtml(playerFamilyName || '未记录')}</p>
      </div>
      <div class="chip-card">
        <strong>名字</strong>
        <p>${escapeHtml(playerGivenName || '未记录')}</p>
      </div>
      <div class="chip-card">
        <strong>主角性格</strong>
        <p>${escapeHtml(playerPersonality)}</p>
      </div>
      <div class="chip-card">
        <strong>主角相貌</strong>
        <p>${escapeHtml(playerAppearance)}</p>
      </div>
    `;

  return `
    <section class="panel-card panel-card--generic">
      <div class="panel-title">状态面板</div>
      <div class="panel-scroll" data-scroll-region="status">
        <div class="hero-card">
          <div class="hero-row">
            <div class="avatar-badge">${escapeHtml(playerName)}</div>
            <div>
              <div class="hero-name">${escapeHtml(playerName)}</div>
              <div class="hero-sub">${escapeHtml(playerClass)} · ${escapeHtml(playerGender)}</div>
            </div>
          </div>
        </div>

        <section class="variable-sheet">
          <div class="profile-sheet-header">
            <div class="variable-sheet__title">主角档案</div>
            ${
              profileEditing
                ? ''
                : '<button class="profile-edit-btn" data-action="edit-player-profile" aria-label="编辑主角档案" title="编辑主角档案">✎</button>'
            }
          </div>
          <div class="chip-list">
            ${profileBody}
          </div>
        </section>

        <section class="variable-sheet">
          <div class="variable-sheet__title">主角能力</div>
          <div class="radar-chart-container" id="status-radar"></div>
        </section>

        <section class="variable-sheet">
          <div class="variable-sheet__title">主线事件</div>
          <div class="chip-list">
            <div class="chip-card">
              <strong>当前事件</strong>
              <p>${escapeHtml(visibleCurrentMainEventId ? `${visibleCurrentMainEventId}：进行中` : '无')}</p>
            </div>
            ${
              mainEvents.length
                ? mainEvents
                    .map(
                      ([id, eventStatus]) => `
                        <div class="chip-card">
                          <strong>${escapeHtml(id)}</strong>
                          <p>${escapeHtml(eventStatus)}${id === visibleCurrentMainEventId ? ' · 当前' : ''}</p>
                        </div>
                      `,
                    )
                    .join('')
                : ''
            }
          </div>
        </section>
      </div>
    </section>
  `;
}

function getDisplayInventory(statusData: StatusData, memoryDB?: IslandMemoryDB) {
  const playerMemoryItems = memoryDB?.items?.filter(item => (item.ownerId ?? 'player') === 'player');
  if (!playerMemoryItems?.length) return Object.entries(statusData.player.inventory);

  return playerMemoryItems
    .filter(item => !item.expired && (item.count ?? 0) > 0)
    .map(item => [
      item.name,
      {
        description: item.state || statusData.player.inventory[item.name]?.description || '暂无描述',
        count: item.count ?? 1,
      },
    ] as const);
}

export function renderInventoryPanel(statusData: StatusData, memoryDB?: IslandMemoryDB) {
  const inventory = getDisplayInventory(statusData, memoryDB);

  return `
    <section class="panel-card panel-card--generic">
      <div class="panel-title">物品</div>
      <div class="panel-scroll" data-scroll-region="inventory">
        <div class="subsection">
          <div class="subsection-title">玩家物品</div>
          <div class="inventory-list">
            ${
              inventory.length
                ? inventory
                    .map(
                      ([name, detail]) => `
                        <div class="inventory-item">
                          <div class="inventory-icon">${getInventoryIcon(name)}</div>
                          <div class="inventory-copy">
                            <strong>${escapeHtml(name)}</strong>
                            <p>${escapeHtml(detail.description)}</p>
                          </div>
                          <span class="inventory-count">x${detail.count}</span>
                        </div>
                      `,
                    )
                    .join('')
                : '<div class="empty-card">物品栏还是空的。</div>'
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

const phoneRenderers: PhoneRenderers = {
  renderInventoryPanel,
  renderPaperWorkspace,
  renderStatusPanel,
  renderSummaryConfigSection,
  renderSummaryPanel,
};

export function renderApp(state: AppState, flipDir: string = '') {
  const fullscreenClass = isPaperWorkspaceFullscreen(state) ? ' is-paper-fullscreen' : '';
  const paperThemeClass = ` paper-theme--${getPaperTheme(state)}`;
  return `
    <main class="islandmilfcode-scene${fullscreenClass}${paperThemeClass}">
      ${renderPaperWorkspace(state, flipDir)}
      ${renderTucaoFloatingPanel(state)}
      ${renderBackgroundTasks(state.backgroundTasks)}
      ${renderReaderContextMenu(state.readerContextMenu, state.generating)}
      ${renderReaderEditor(state)}
      ${renderFloatingPhone(state)}
      ${renderPhone(state, phoneRenderers)}
    </main>
  `;
}
