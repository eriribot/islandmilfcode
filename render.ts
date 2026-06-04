import { escapeHtml } from './html';
import { extractOptionsBlock, extractTucaoBlocks, getReaderMessages, getVisibleMessageText } from './message-format';
import { renderFloatingPhone, renderPhone, type PhoneRenderers } from './phone/render';
import type { SummaryStore } from './summary/types';
import type { AppState, BackgroundTaskState, ReaderContextMenuState, StatusData, UiMessage } from './types';
import { loadFullMemoryConfig } from './memory-config';

/**
 * 把摘要 range（对话序号，不含系统/streaming 楼层）映射成 UI 楼层号（getReaderMessages 渲染出的 #N）。
 * 摘要内部存的 range 用对话序号是为了让 rerollSummaryEntry 能正确切片，不能改；
 * 但展示给用户看的应当是 UI 上能看到的楼层号，否则 #155 与"消息 140-144"对不上。
 */
function mapConversationRangeToUiRange(
  uiMessages: UiMessage[],
  range: [number, number],
): [number, number] {
  // 与 summary/run.ts 的 getConversationMessages 保持一致：!streaming && (user|assistant)
  const conversationUiIndices: number[] = [];
  uiMessages.forEach((m, idx) => {
    if (!m.streaming && (m.role === 'user' || m.role === 'assistant')) {
      conversationUiIndices.push(idx);
    }
  });
  // UI 楼层号从 1 开始（与渲染里 #${i+1} 对齐），所以 +1。
  const startUi = (conversationUiIndices[range[0]] ?? range[0]) + 1;
  const endUi = (conversationUiIndices[range[1]] ?? range[1]) + 1;
  return [startUi, endUi];
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
    <button class="reader-preview reader-preview--${side}" data-action="jump-message" data-index="${index}">
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
  const sourceUserText = getRollbackSourceForReaderIndex(state, readerIndex);
  if (!sourceUserText) return '';

  return `
    <button
      class="${className}"
      data-action="reader-actions-open"
      data-reader-index="${readerIndex}"
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
      <section class="paper-reader">
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

  if (!visibleText && !message.streaming) {
    return `
      <section class="paper-reader">
        ${topLane}

        <article
          class="reader-card reader-card--${message.role} reader-card--empty"
          data-reader-index="${model.currentIndex}"
          ${flipDir ? ` data-flip="${flipDir}"` : ''}
        >
          <div class="reader-card__chrome">
            <div class="reader-card__hint-group reader-card__hint-group--left">
              ${renderReaderHint('prev', Boolean(model.previousMessage))}
            </div>
            <span class="reader-card__index">${String(model.currentIndex + 1).padStart(2, '0')}</span>
            <button class="reader-card__edit" data-action="reader-edit" data-reader-index="${model.currentIndex}" title="编辑原文" aria-label="编辑原文">✎</button>
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

  const pageText = escapeHtml(visibleText || '……');

  return `
    <section class="paper-reader">
      ${topLane}

      <article
        class="reader-card reader-card--${message.role}"
        data-reader-index="${model.currentIndex}"
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
              : `<button class="reader-card__edit" data-action="reader-edit" data-reader-index="${model.currentIndex}" title="编辑原文" aria-label="编辑原文">✎</button>`
          }
          <div class="reader-card__hint-group reader-card__hint-group--right">
            ${renderReaderHint('next', Boolean(model.nextMessage))}
          </div>
        </div>
        <div class="reader-card__body" tabindex="0">
          <p class="reader-card__text">${pageText}</p>
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

function renderJournalHeader(state: AppState) {
  const dateStr = formatDate(state.statusData.world.currentTime);
  const weekday = getWeekday(state.statusData.world.currentTime);

  return `
    <header class="journal-header">
      <div class="journal-date-block">
        <span class="journal-weekday">${escapeHtml(weekday)}</span>
        <div class="journal-date">
          ${escapeHtml(dateStr)}<small>${escapeHtml(formatTime(state.statusData.world.currentTime))}</small>
        </div>
        <div class="journal-location">地点 ${escapeHtml(state.statusData.world.currentLocation)}</div>
      </div>
      <div class="journal-sticker">
        ${escapeHtml(state.playerProfile.className || '主角档案')}
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
  return `
    <section class="paper-workspace ${embedded ? 'paper-workspace--phone' : ''}">
      ${embedded ? '' : '<div class="washi-strip washi-strip--top" aria-hidden="true"></div>'}
      ${embedded ? '' : '<div class="washi-strip washi-strip--side" aria-hidden="true"></div>'}

      ${embedded ? '' : renderJournalHeader(state)}

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
          ${composerActionsButton}
          ${state.generating ? '<span class="composer-tip">写入中……</span>' : ''}
          <button class="send-btn" data-action="send" ${state.generating ? 'disabled' : ''}>记录</button>
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
  const recentEvents = Object.entries(state.statusData.world.recentEvents).slice(0, 3);
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

        <div class="subsection">
          <div class="subsection-title">最近事件</div>
          <div class="chip-list">
            ${
              recentEvents.length
                ? recentEvents
                    .map(
                      ([name, text]) => `
                        <div class="chip-card">
                          <strong>${escapeHtml(name)}</strong>
                          <p>${escapeHtml(text)}</p>
                        </div>
                      `,
                    )
                    .join('')
                : '<div class="empty-card">还没有可展示的事件。</div>'
            }
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

  const globalHtml = store.global
    ? `<div class="subsection">
        <div class="subsection-title">全局摘要</div>
        <div class="chip-card"><p>${escapeHtml(store.global)}</p></div>
      </div>`
    : '';

  const majorHtml = store.major.length
    ? `<div class="subsection">
        <div class="subsection-title">大总结 <span style="opacity:0.5;font-size:11px">(${store.major.length}条)</span></div>
        <div class="chip-list">${store.major
          .map((e, i) => {
            const [uiStart, uiEnd] = mapConversationRangeToUiRange(uiMessages, e.range);
            return `<div class="chip-card" style="border-left:3px solid var(--accent-primary,#7c6ca8)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <strong>#${i + 1} · 楼层 ${uiStart}-${uiEnd}</strong>
                  <button class="mini-btn" data-action="summary-reroll" data-reroll-level="major" data-reroll-index="${i}" style="font-size:10px;padding:2px 6px" ${summarizing ? 'disabled' : ''}>🎲</button>
                </div>
                <p>${escapeHtml(e.text)}</p>
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
            const [uiStart, uiEnd] = mapConversationRangeToUiRange(uiMessages, e.range);
            return `<div class="chip-card">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <strong>#${i + 1} · 楼层 ${uiStart}-${uiEnd}</strong>
                  <button class="mini-btn" data-action="summary-reroll" data-reroll-level="minor" data-reroll-index="${i}" style="font-size:10px;padding:2px 6px" ${summarizing ? 'disabled' : ''}>🎲</button>
                </div>
                <p>${escapeHtml(e.text)}</p>
                <div style="font-size:10px;opacity:0.45;margin-top:4px">${escapeHtml(e.createdAt.slice(0, 16).replace('T', ' '))}</div>
              </div>`;
          })
          .join('')}
        </div>
      </div>`
    : '';

  const hasAny = store.global || store.major.length || store.minor.length;
  // lastSummarizedIndex 是对话序号，把它也映射成 UI 楼层号让用户能直接对上 #N。
  const lastSummarizedUi = store.lastSummarizedIndex > 0
    ? mapConversationRangeToUiRange(uiMessages, [store.lastSummarizedIndex - 1, store.lastSummarizedIndex - 1])[1]
    : 0;
  // 计算未总结的对话差额。conversationCount 是非 streaming 的 user/assistant 消息数。
  // pending 是当前对话总数减去已总结进度。pending >= 5 时显示提醒，让用户能手动点小总结补救。
  const conversationCount = uiMessages.filter(
    m => !m.streaming && (m.role === 'user' || m.role === 'assistant'),
  ).length;
  const pendingCount = Math.max(0, conversationCount - store.lastSummarizedIndex);
  const statusLine = `已总结到楼层 #${lastSummarizedUi} · 小总结 ${store.minor.length} · 大总结 ${store.major.length} · 全局 ${store.global ? '有' : '无'}`;
  const pendingHint = pendingCount >= 5
    ? `<div class="summary-pending" style="font-size:11px;color:#c97c5d;margin-bottom:8px;padding:4px 8px;background:rgba(201,124,93,0.08);border-radius:6px">还有 <strong>${pendingCount}</strong> 条对话未被小总结吞掉，可点下方「小总结」补救。</div>`
    : '';
  // 大总结补救提示：minor 堆到 4 条以上就该升级 major。
  const majorPendingHint = store.minor.length >= 4
    ? `<div class="summary-pending" style="font-size:11px;color:#7c6ca8;margin-bottom:8px;padding:4px 8px;background:rgba(124,108,168,0.08);border-radius:6px">小总结已堆 <strong>${store.minor.length}</strong> 条，可点下方「大总结」一次性消化。</div>`
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
      </div>
    </div>`;
}

export function renderSummaryConfigSection(state: AppState): string {
  const memoryConfig = loadFullMemoryConfig();

  return `
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

  // 过滤掉已结束的事件，但保留当前进行中的事件
  const mainEvents = Object.entries(statusData.world.mainEvents || {})
    .filter(([id, status]) => {
      // 如果是当前事件，总是显示（即使只有一轮）
      if (id === currentMainEventId) return true;
      // 否则只显示未进行或进行中的事件（排除已结束）
      return status !== '已结束';
    });

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
      <div class="chip-card" style="display:flex;gap:8px">
        <button class="profile-save-btn" data-action="save-player-profile-edit">保存</button>
        <button class="profile-cancel-btn" data-action="cancel-player-profile-edit">取消</button>
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
              <p>${escapeHtml(currentMainEventId ? `${currentMainEventId}：${currentMainEventStatus || '状态未知'}` : '无')}</p>
            </div>
            ${
              mainEvents.length
                ? mainEvents
                    .map(
                      ([id, eventStatus]) => `
                        <div class="chip-card">
                          <strong>${escapeHtml(id)}</strong>
                          <p>${escapeHtml(eventStatus)}${id === currentMainEventId ? ' · 当前' : ''}</p>
                        </div>
                      `,
                    )
                    .join('')
                : '<div class="empty-card">还没有主线事件记录。</div>'
            }
          </div>
        </section>
      </div>
    </section>
  `;
}

export function renderInventoryPanel(statusData: StatusData) {
  const inventory = Object.entries(statusData.player.inventory);

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
  return `
    <main class="islandmilfcode-scene">
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
