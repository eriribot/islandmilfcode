import { getReaderMessages, getVisibleMessageText } from './message-format';
import type { SummaryStore } from './summary/types';
import type {
  AppState,
  FloatingPhonePosition,
  NotificationState,
  ReaderContextMenuState,
  StatusData,
  TabKey,
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

function renderPhoneTabs(activeTab: TabKey) {
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'summary', label: '总结' },
    { key: 'status', label: '状态' },
    { key: 'inventory', label: '物品' },
  ];

  return tabs
    .map(
      tab =>
        `<button class="tab-btn ${tab.key === activeTab ? 'active' : ''}" data-tab="${tab.key}">${tab.label}</button>`,
    )
    .join('');
}

function renderPhoneNotification(notification: NotificationState | null) {
  if (!notification) return '';

  return `
    <button class="ios-notification" data-action="open-notification">
      <div class="ios-notification-app">
        <span class="ios-notification-icon">✦</span>
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
  const label = direction === 'prev' ? '前层' : '后层';

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
  const promptPreview = menu.sourceUserText
    ? escapeHtml(menu.sourceUserText.slice(0, 54).trim() + (menu.sourceUserText.length > 54 ? '…' : ''))
    : '该楼层暂时没有可回溯的输入。';

  return `
    <div class="reader-context-menu" style="left:${menu.x}px;top:${menu.y}px;" data-reader-context-menu="true">
      <div class="reader-context-menu__meta">楼层 ${floorLabel}</div>
      <div class="reader-context-menu__preview">${promptPreview}</div>
      <button
        class="reader-context-menu__action"
        data-action="reader-rollback"
        ${menu.sourceUserText ? '' : 'disabled'}
      >
        回溯楼层输入
      </button>
      <button
        class="reader-context-menu__action reader-context-menu__action--primary"
        data-action="reader-regenerate"
        ${menu.sourceUserText && !generating ? '' : 'disabled'}
      >
        ${generating ? '生成中…' : '重新生成该楼层'}
      </button>
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
            <p class="reader-card__text">等待新的记录写入。</p>
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

  // Empty text: show only preview lanes, no card body
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
          ${message.streaming ? '<span class="reader-card__streaming">記録中…</span>' : ''}
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
    if (!isNaN(d.getTime())) return days[d.getDay()] + '曜日';
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
        <div class="journal-location">📍 ${escapeHtml(state.statusData.world.currentLocation)}</div>
      </div>
      <div class="journal-sticker">
        ✿ ${escapeHtml(target?.stage ?? '')}
      </div>
    </header>
  `;
}

function renderPaperWorkspace(state: AppState, flipDir: string = '') {
  return `
    <section class="paper-workspace">
      <div class="washi-strip washi-strip--top" aria-hidden="true"></div>
      <div class="washi-strip washi-strip--side" aria-hidden="true"></div>

      ${renderJournalHeader(state)}

      <div class="section-tab">
        <span class="section-tab__label">対話ログ</span>
        <span class="section-tab__status">${state.generating ? '✎ 記録中…' : '✓ 落筆済み'}</span>
      </div>

      ${renderReaderDeck(state, flipDir)}

      <div class="section-tab" style="margin-top:16px">
        <span class="section-tab__label" style="background:var(--washi-mint)">続きを書く</span>
      </div>

      <div class="paper-composer-card">
        <label class="paper-composer-card__label" for="islandmilfcode-composer">この物語の続き…</label>
        <textarea
          id="islandmilfcode-composer"
          class="composer-input"
          name="islandmilfcode-composer"
          placeholder="ここに書き続ける……"
          ${state.generating ? 'disabled' : ''}
        >${escapeHtml(state.draft)}</textarea>

        <div class="composer-actions">
          ${state.generating ? '<span class="composer-tip">✎ 書き込み中……</span>' : ''}
          <button class="send-btn" data-action="send" ${state.generating ? 'disabled' : ''}>記録する ❋</button>
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
        ${renderSummaryConfigSection(state)}
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

  // ── 全局摘要 ──
  const globalHtml = store.global
    ? `<div class="subsection">
        <div class="subsection-title">全局摘要</div>
        <div class="chip-card"><p>${escapeHtml(store.global)}</p></div>
      </div>`
    : '';

  // ── 大总结列表 ──
  const majorHtml = store.major.length
    ? `<div class="subsection">
        <div class="subsection-title">大总结 <span style="opacity:0.5;font-size:11px">(${store.major.length}条)</span></div>
        <div class="chip-list">${store.major
          .map(
            (e, i) =>
              `<div class="chip-card" style="border-left:3px solid var(--accent-primary,#7c6ca8)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <strong>#${i + 1} · 消息 ${e.range[0]}–${e.range[1]}</strong>
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

  // ── 小总结列表 ──
  const minorHtml = store.minor.length
    ? `<div class="subsection">
        <div class="subsection-title">小总结 <span style="opacity:0.5;font-size:11px">(${store.minor.length}条)</span></div>
        <div class="chip-list">${store.minor
          .map(
            (e, i) =>
              `<div class="chip-card">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <strong>#${i + 1} · 消息 ${e.range[0]}–${e.range[1]}</strong>
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
  const statusLine = `已总结到第 ${store.lastSummarizedIndex} 条 · 小总结 ${store.minor.length} · 大总结 ${store.major.length} · 全局 ${store.global ? '✓' : '—'}`;

  return `
    <div class="subsection">
      <div class="subsection-title">记忆摘要 ${summarizing ? '<span style="opacity:0.6">⏳ 总结中…</span>' : ''}</div>
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
          <button class="mini-btn" data-action="summary-save-config">保存配置</button>
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
  const alias = target?.alias ?? target?.name ?? '角色';

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

function renderPhonePanel(state: AppState) {
  if (state.activeTab === 'status') return renderStatusPanel(state);
  if (state.activeTab === 'inventory') return renderInventoryPanel(state.statusData);
  return renderSummaryPanel(state);
}

function renderFloatingPhoneStyle(position: FloatingPhonePosition) {
  return `left:${position.x}px;top:${position.y}px;`;
}

function renderPhone(state: AppState) {
  const target = getActiveTarget(state.statusData);
  const alias = target?.alias ?? target?.name ?? '角色';

  return `
    <div class="phone-modal ${state.phoneOpen ? 'is-open' : ''}" aria-hidden="${state.phoneOpen ? 'false' : 'true'}">
      <button class="phone-backdrop" data-action="close-phone" aria-label="关闭手帐"></button>
      <section class="phone-shell">
        <div class="phone-notch"></div>
        <div class="phone-inner">
          <header class="system-bar">
            <span class="system-time">${escapeHtml(formatTime(state.statusData.world.currentTime))}</span>
            <div class="system-icons">
              <span>✿</span>
              <span>${escapeHtml(formatDate(state.statusData.world.currentTime))}</span>
            </div>
          </header>

          ${renderPhoneNotification(state.notification)}

          <section class="same-layer-card">
            <header class="top-card">
              <div class="contact-block">
                <div class="contact-avatar">${escapeHtml(alias)}</div>
                <div>
                  <div class="contact-title">口袋手帐</div>
                  <div class="contact-meta">${escapeHtml(state.statusData.world.currentLocation)}</div>
                </div>
              </div>
              <div class="top-card__actions">
                <div class="contact-stage">${escapeHtml(target?.stage ?? '')}</div>
                <button class="return-title-btn" data-action="return-to-title" aria-label="回到标题" title="タイトルに戻る">⌂</button>
                <button class="close-phone-btn" data-action="close-phone" aria-label="关闭手帐">×</button>
              </div>
            </header>

            <nav class="tab-bar">
              ${renderPhoneTabs(state.activeTab)}
            </nav>

            ${renderPhonePanel(state)}
          </section>
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
        aria-label="打开口袋手帐"
      >
        ${unreadBadge}
        <span class="floating-phone__grip">··· ···</span>
        <span class="floating-phone__icon">📓</span>
        <span class="floating-phone__label">手帐</span>
      </button>

      ${renderPhone(state)}
    </main>
  `;
}
