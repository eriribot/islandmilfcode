import { getReaderMessages, getVisibleMessageText } from './message-format';
import type { SummaryStore } from './summary/types';
import type {
  AppState,
  FloatingPhonePosition,
  NotificationState,
  PhoneRoute,
  ReaderContextMenuState,
  StatusData,
  UiMessage,
} from './types';
import { getActiveTarget } from './types';
import { formatDate, formatTime, getInventoryIcon } from './variables/normalize';

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPhoneNotification(notification: NotificationState | null) {
  if (!notification) return '';

  return `
    <button class="ios-notification" data-action="open-notification">
      <div class="ios-notification-app">
        <span class="ios-notification-icon">通知</span>
        <span>手帐记录</span>
        <span class="ios-notification-time">${escapeHtml(notification.timestamp)}</span>
      </div>
      <div class="ios-notification-title-row">
        <strong>${escapeHtml(notification.title)}</strong>
        <span class="ios-notification-pill">新记录</span>
      </div>
      <div class="ios-notification-preview">${escapeHtml(notification.preview)}</div>
    </button>
  `;
}

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

function renderReaderContextMenu(menu: ReaderContextMenuState | null, generating: boolean) {
  if (!menu) return '';

  const floorLabel = String(menu.readerIndex + 1).padStart(2, '0');
  const hasRollbackSource = Boolean(menu.sourceUserText);
  const promptPreview = hasRollbackSource
    ? escapeHtml(menu.sourceUserText.slice(0, 54).trim() + (menu.sourceUserText.length > 54 ? '…' : ''))
    : '该楼层暂时没有可回溯的输入。';
  const actionHtml = hasRollbackSource
    ? `
      <button
        class="reader-context-menu__action"
        data-action="reader-rollback"
      >
        回溯楼层输入
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
      <div class="reader-context-menu__meta">楼层 ${floorLabel}</div>
      <div class="reader-context-menu__preview">${promptPreview}</div>
      ${actionHtml}
    </div>
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
          <div class="reader-card__body">
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
    return `<section class="paper-reader">${topLane}${bottomLane}</section>`;
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
          <div class="reader-card__hint-group reader-card__hint-group--right">
            ${renderReaderHint('next', Boolean(model.nextMessage))}
          </div>
        </div>
        <div class="reader-card__body">
          <p class="reader-card__text">${pageText}</p>
        </div>
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
    /* ignore */
  }
  return '';
}

function renderJournalHeader(state: AppState) {
  const dateStr = formatDate(state.statusData.world.currentTime);
  const weekday = getWeekday(state.statusData.world.currentTime);
  const target = getActiveTarget(state.statusData);

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
        阶段 ${escapeHtml(target?.stage ?? '')}
      </div>
    </header>
  `;
}

function renderPaperWorkspace(state: AppState, flipDir: string = '', options: { embedded?: boolean } = {}) {
  const embedded = options.embedded ?? false;
  const composerId = embedded ? 'islandmilfcode-phone-composer' : 'islandmilfcode-composer';
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
          ${state.generating ? '<span class="composer-tip">写入中……</span>' : ''}
          <button class="send-btn" data-action="send" ${state.generating ? 'disabled' : ''}>记录</button>
        </div>
      </div>
    </section>
  `;
}

function renderSummaryPanel(state: AppState) {
  const recentEvents = Object.entries(state.statusData.world.recentEvents).slice(0, 3);
  const lastMessage = state.uiMessages[state.uiMessages.length - 1];
  const target = getActiveTarget(state.statusData);
  const alias = target?.alias ?? target?.name ?? '角色';
  const store = state.summaryStore;

  return `
    <section class="panel-card panel-card--generic">
      <div class="panel-title">角色总结</div>
      <div class="panel-scroll" data-scroll-region="summary">
        <div class="hero-card">
          <div class="hero-row">
            <div class="avatar-badge">${escapeHtml(alias)}</div>
            <div>
              <div class="hero-name">${escapeHtml(target?.stage ?? '')}</div>
              <div class="hero-sub">${escapeHtml(state.statusData.world.currentLocation)}</div>
            </div>
          </div>
          <div class="meter-head">
            <span>依赖度</span>
            <strong>${target?.affinity ?? 0}%</strong>
          </div>
          <div class="meter-track"><div class="meter-fill" style="width:${target?.affinity ?? 0}%"></div></div>
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

        ${renderMemorySummarySection(store, state.summarizing)}
      </div>
    </section>
  `;
}

function renderMemorySummarySection(store: SummaryStore, summarizing: boolean): string {
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
          .map(
            (e, i) =>
              `<div class="chip-card" style="border-left:3px solid var(--accent-primary,#7c6ca8)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <strong>#${i + 1} · 消息 ${e.range[0]}-${e.range[1]}</strong>
                  <button class="mini-btn" data-action="summary-reroll" data-reroll-level="major" data-reroll-index="${i}" style="font-size:10px;padding:2px 6px" ${summarizing ? 'disabled' : ''}>重roll</button>
                </div>
                <p>${escapeHtml(e.text)}</p>
                <div style="font-size:10px;opacity:0.45;margin-top:4px">${escapeHtml(e.createdAt.slice(0, 16).replace('T', ' '))}</div>
              </div>`,
          )
          .join('')}
        </div>
      </div>`
    : '';

  const minorHtml = store.minor.length
    ? `<div class="subsection">
        <div class="subsection-title">小总结 <span style="opacity:0.5;font-size:11px">(${store.minor.length}条)</span></div>
        <div class="chip-list">${store.minor
          .map(
            (e, i) =>
              `<div class="chip-card">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <strong>#${i + 1} · 消息 ${e.range[0]}-${e.range[1]}</strong>
                  <button class="mini-btn" data-action="summary-reroll" data-reroll-level="minor" data-reroll-index="${i}" style="font-size:10px;padding:2px 6px" ${summarizing ? 'disabled' : ''}>重roll</button>
                </div>
                <p>${escapeHtml(e.text)}</p>
                <div style="font-size:10px;opacity:0.45;margin-top:4px">${escapeHtml(e.createdAt.slice(0, 16).replace('T', ' '))}</div>
              </div>`,
          )
          .join('')}
        </div>
      </div>`
    : '';

  const hasAny = store.global || store.major.length || store.minor.length;
  const statusLine = `已总结到第 ${store.lastSummarizedIndex} 条 · 小总结 ${store.minor.length} · 大总结 ${store.major.length} · 全局 ${store.global ? '有' : '无'}`;

  return `
    <div class="subsection">
      <div class="subsection-title">记忆摘要 ${summarizing ? '<span style="opacity:0.6">总结中…</span>' : ''}</div>
      <div class="summary-status" style="font-size:11px;opacity:0.7;margin-bottom:8px">${statusLine}</div>
      ${errorHtml}
      ${hasAny ? [globalHtml, majorHtml, minorHtml].filter(Boolean).join('') : '<div class="empty-card">还没有生成过摘要。</div>'}
      <div class="summary-actions" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="mini-btn" data-action="summary-minor" style="white-space:nowrap;flex:1;min-height:30px" ${summarizing ? 'disabled' : ''}>小总结</button>
        <button class="mini-btn" data-action="summary-major" style="white-space:nowrap;flex:1;min-height:30px" ${summarizing ? 'disabled' : ''}>大总结</button>
      </div>
    </div>`;
}

function renderSummaryConfigSection(state: AppState): string {
  const config = state.summaryApiConfig;
  const useCustom = config !== null;

  return `
    <div class="subsection">
      <div class="subsection-title">总结 API 设置</div>
      <div class="chip-list">
        <div class="chip-card">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-action="summary-toggle-custom" ${useCustom ? 'checked' : ''}>
            <span>使用独立 API</span>
          </label>
        </div>
        ${
          useCustom
            ? `
          <div class="chip-card">
            <label>API URL<br><input type="text" data-field="summary-apiurl" value="${escapeHtml(config?.apiurl ?? '')}" style="width:100%;box-sizing:border-box" placeholder="https://..."></label>
          </div>
          <div class="chip-card">
            <label>API Key<br><input type="password" data-field="summary-key" value="${escapeHtml(config?.key ?? '')}" style="width:100%;box-sizing:border-box" placeholder="sk-..."></label>
          </div>
          <div class="chip-card">
            <label>Model<br><input type="text" data-field="summary-model" value="${escapeHtml(config?.model ?? '')}" style="width:100%;box-sizing:border-box" placeholder="gpt-4o-mini"></label>
          </div>
          <div class="chip-card">
            <label>Source<br><input type="text" data-field="summary-source" value="${escapeHtml(config?.source ?? 'openai')}" style="width:100%;box-sizing:border-box" placeholder="openai"></label>
          </div>
          <button class="summary-config-save" data-action="summary-save-config">保存配置</button>
        `
            : ''
        }
      </div>
    </div>`;
}

function renderStatusPanel(state: AppState) {
  const statusData = state.statusData;
  const target = getActiveTarget(statusData);
  const titles = target ? Object.entries(target.titles) : [];
  const recentEvents = Object.entries(statusData.world.recentEvents);

  return `
    <section class="panel-card panel-card--generic">
      <div class="panel-title">状态面板</div>
      <div class="panel-scroll" data-scroll-region="status">
        <div class="hero-card">
          <div class="hero-row">
            <div class="avatar-badge">${escapeHtml(target?.name ?? '角色')}</div>
            <div>
              <div class="hero-name">角色状态</div>
              <div class="hero-sub">当前阶段：${escapeHtml(target?.stage ?? '')}</div>
            </div>
          </div>
          <div class="meter-head">
            <span>依赖度</span>
            <strong>${target?.affinity ?? 0}%</strong>
          </div>
          <div class="meter-track"><div class="meter-fill" style="width:${target?.affinity ?? 0}%"></div></div>
          <div class="meter-actions">
            <button class="mini-btn" data-action="dep-down">-</button>
            <button class="mini-btn" data-action="dep-up">+</button>
          </div>
        </div>

        <section class="variable-sheet">
          <div class="variable-sheet__title">变量快照</div>
          <div class="variable-list">
            <div class="variable-row"><span>world.currentTime</span><strong>${escapeHtml(statusData.world.currentTime)}</strong></div>
            <div class="variable-row"><span>world.currentLocation</span><strong>${escapeHtml(statusData.world.currentLocation)}</strong></div>
            <div class="variable-row"><span>activeTarget.stage</span><strong>${escapeHtml(target?.stage ?? '')}</strong></div>
            <div class="variable-row"><span>activeTarget.affinity</span><strong>${target?.affinity ?? 0}</strong></div>
            <div class="variable-row"><span>activeTarget.titleCount</span><strong>${titles.length}</strong></div>
            <div class="variable-row"><span>world.eventCount</span><strong>${recentEvents.length}</strong></div>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderInventoryPanel(statusData: StatusData) {
  const inventory = Object.entries(statusData.player.inventory);
  const target = getActiveTarget(statusData);
  const outfits = target ? Object.entries(target.outfits) : [];
  const alias = target?.alias ?? target?.name ?? '角色';

  return `
    <section class="panel-card panel-card--generic">
      <div class="panel-title">物品 / 装扮</div>
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

        <div class="subsection">
          <div class="subsection-title">${escapeHtml(alias)}装扮</div>
          <div class="outfit-list">
            ${
              outfits.length
                ? outfits
                    .map(
                      ([slot, detail]) => `
                        <div class="outfit-item">
                          <strong>${escapeHtml(slot)}</strong>
                          <p>${escapeHtml(detail)}</p>
                        </div>
                      `,
                    )
                    .join('')
                : '<div class="empty-card">还没有记录装扮。</div>'
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderFloatingPhoneStyle(position: FloatingPhonePosition) {
  return `left:${position.x}px;top:${position.y}px;`;
}

function renderPhoneAppHeader(state: AppState, title: string, subtitle = '') {
  const canGoBack = state.phoneRoute !== 'home';

  return `
    <header class="phone-page-header">
      <button
        class="phone-nav-btn"
        data-action="phone-back"
        aria-label="返回"
        ${canGoBack ? '' : 'disabled'}
      >‹</button>
      <div class="phone-page-title">
        <strong>${escapeHtml(title)}</strong>
        ${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}
      </div>
      <button class="phone-nav-btn" data-action="close-phone" aria-label="关闭">×</button>
    </header>
  `;
}

function renderPhoneHome(state: AppState) {
  const target = getActiveTarget(state.statusData);
  const alias = target?.alias ?? target?.name ?? '角色';
  const readerCount = Math.max(getReaderMessages(state.uiMessages).length, 0);
  const summaryCount = state.summaryStore.minor.length + state.summaryStore.major.length + (state.summaryStore.global ? 1 : 0);
  const inventoryCount = Object.keys(state.statusData.player.inventory).length;
  const apps: Array<{ route: PhoneRoute; icon: string; label: string; meta: string; dock?: boolean }> = [
    { route: 'app:reader', icon: 'RD', label: '阅读', meta: `${readerCount} 条记录`, dock: true },
    { route: 'app:status', icon: 'ST', label: '状态', meta: `${target?.affinity ?? 0}%`, dock: true },
    { route: 'app:inventory', icon: 'BG', label: '背包', meta: `${inventoryCount} 件` },
    { route: 'app:summary', icon: 'MM', label: '摘要', meta: `${summaryCount} 条记忆`, dock: true },
    { route: 'app:settings', icon: 'SV', label: '设置', meta: state.activeSaveId ? '已连接存档' : '未保存' },
  ];
  const dockApps = apps.filter(app => app.dock);

  return `
    <section class="phone-home phone-route-page" data-phone-route-view="home">
      <div class="phone-home-hero">
        <div>
          <span class="phone-home-kicker">${escapeHtml(formatDate(state.statusData.world.currentTime))}</span>
          <h2>口袋手帐</h2>
          <p>${escapeHtml(state.statusData.world.currentLocation)}</p>
        </div>
        <div class="phone-home-avatar">${escapeHtml(alias)}</div>
      </div>

      <div class="phone-app-grid">
        ${apps
          .map(
            app => `
              <button class="phone-app-icon" data-phone-route="${app.route}">
                <span class="phone-app-icon__glyph">${escapeHtml(app.icon)}</span>
                <span class="phone-app-icon__label">${escapeHtml(app.label)}</span>
                <span class="phone-app-icon__meta">${escapeHtml(app.meta)}</span>
              </button>
            `,
          )
          .join('')}
      </div>

      <nav class="phone-dock" aria-label="常用应用">
        ${dockApps
          .map(
            app => `
              <button class="phone-dock-btn" data-phone-route="${app.route}" aria-label="${escapeHtml(app.label)}">
                ${escapeHtml(app.icon)}
              </button>
            `,
          )
          .join('')}
      </nav>
    </section>
  `;
}

function renderReaderPhonePage(state: AppState, flipDir: string) {
  return `
    <section class="phone-route-page phone-app-page phone-app-page--reader" data-phone-route-view="app:reader">
      ${renderPhoneAppHeader(state, '阅读', state.generating ? '记录中' : '手帐')}
      <div class="phone-page-scroll phone-page-scroll--reader">
        ${renderPaperWorkspace(state, flipDir, { embedded: true })}
      </div>
    </section>
  `;
}

function renderSummaryPhonePage(state: AppState) {
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:summary">
      ${renderPhoneAppHeader(state, '摘要 / 记忆', `${state.summaryStore.minor.length + state.summaryStore.major.length} 条摘要`)}
      ${renderSummaryPanel(state)}
    </section>
  `;
}

function renderStatusPhonePage(state: AppState) {
  const target = getActiveTarget(state.statusData);
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:status">
      ${renderPhoneAppHeader(state, '状态', target?.stage ?? '')}
      ${renderStatusPanel(state)}
    </section>
  `;
}

function renderInventoryPhonePage(state: AppState) {
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:inventory">
      ${renderPhoneAppHeader(state, '背包', `${Object.keys(state.statusData.player.inventory).length} 件物品`)}
      ${renderInventoryPanel(state.statusData)}
    </section>
  `;
}

function renderSettingsPhonePage(state: AppState) {
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:settings">
      ${renderPhoneAppHeader(state, '设置 / 保存', state.activeSaveId ? '存档已连接' : '未保存')}
      <section class="panel-card panel-card--generic">
        <div class="panel-title">操作</div>
        <div class="panel-scroll">
          <div class="settings-actions">
            <button class="settings-action" data-action="manual-save">
              <strong>手动保存</strong>
              <span>写入当前记录、状态与摘要。</span>
            </button>
            <button class="settings-action" data-action="return-to-title">
              <strong>返回标题</strong>
              <span>回到存档选择与角色创建。</span>
            </button>
          </div>
          ${renderSummaryConfigSection(state)}
        </div>
      </section>
    </section>
  `;
}

function renderPhoneRoute(state: AppState, flipDir: string) {
  if (state.phoneRoute === 'app:reader') return renderReaderPhonePage(state, flipDir);
  if (state.phoneRoute === 'app:summary') return renderSummaryPhonePage(state);
  if (state.phoneRoute === 'app:status') return renderStatusPhonePage(state);
  if (state.phoneRoute === 'app:inventory') return renderInventoryPhonePage(state);
  if (state.phoneRoute === 'app:settings') return renderSettingsPhonePage(state);
  return renderPhoneHome(state);
}

function renderPhone(state: AppState, flipDir: string = '') {
  return `
    <div class="phone-modal ${state.phoneOpen ? 'is-open' : ''}" aria-hidden="${state.phoneOpen ? 'false' : 'true'}">
      <button class="phone-backdrop" data-action="close-phone" aria-label="关闭手帐"></button>
      <section class="phone-shell">
        <div class="phone-notch"></div>
        <div class="phone-inner">
          <header class="system-bar">
            <span class="system-time">${escapeHtml(formatTime(state.statusData.world.currentTime))}</span>
            <div class="system-icons">
              <span>LTE</span>
              <span>${escapeHtml(formatDate(state.statusData.world.currentTime))}</span>
            </div>
          </header>

          ${renderPhoneNotification(state.notification)}
          <div class="phone-screen">
            ${renderPhoneRoute(state, flipDir)}
          </div>
        </div>
      </section>
    </div>
  `;
}

export function renderApp(state: AppState, flipDir: string = '') {
  const unreadBadge = state.notification ? '<span class="floating-phone__badge">1</span>' : '';

  return `
    <main class="islandmilfcode-scene">
      ${renderPaperWorkspace(state, flipDir)}
      ${renderReaderContextMenu(state.readerContextMenu, state.generating)}

      <button
        class="floating-phone"
        data-action="open-phone"
        data-drag-handle="true"
        style="${renderFloatingPhoneStyle(state.floatingPhone)}"
        aria-label="打开记事本"
      >
        ${unreadBadge}
      </button>

      ${renderPhone(state, flipDir)}
    </main>
  `;
}
