import { getReaderMessages } from '../message-format';
import { escapeHtml } from '../html';
import type { AppState, NotificationState, StatusData } from '../types';
import type { FloatingPhonePosition, PhoneRoute } from './types';
import { getActiveTarget } from '../types';
import { formatDate, formatTime } from '../variables/normalize';
import { resolveWeatherRequest } from './weather';

export type PhoneRenderers = {
  renderInventoryPanel: (statusData: StatusData) => string;
  renderPaperWorkspace: (state: AppState, flipDir?: string, options?: { embedded?: boolean }) => string;
  renderStatusPanel: (state: AppState) => string;
  renderSummaryConfigSection: (state: AppState) => string;
  renderSummaryPanel: (state: AppState) => string;
};

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

function formatWeatherNumber(value: number | null, digits = 0) {
  if (value === null || Number.isNaN(value)) return '--';
  return value.toFixed(digits);
}

function renderWeatherHero(state: AppState) {
  const request = resolveWeatherRequest(state.statusData.world.currentTime, state.statusData.world.currentLocation);
  const report = state.weather.key === request.key ? state.weather.report : null;
  const status = state.weather.key === request.key ? state.weather.status : 'idle';

  if (!report) {
    const message = status === 'error' ? state.weather.error || '天气源暂时不可用' : '同步历史天气中...';
    return `
      <div class="phone-home-weather">
        <span class="phone-home-kicker">${escapeHtml(formatDate(state.statusData.world.currentTime))}</span>
        <h2>天气</h2>
        <p>${escapeHtml(request.locationLabel)} · ${escapeHtml(message)}</p>
      </div>
    `;
  }

  return `
    <div class="phone-home-weather">
      <span class="phone-home-kicker">${escapeHtml(report.date)} · ${escapeHtml(report.locationLabel)}</span>
      <div class="phone-weather-main">
        <span class="phone-weather-icon">${escapeHtml(report.icon)}</span>
        <div>
          <h2>${escapeHtml(report.conditionLabel)}</h2>
          <p>${formatWeatherNumber(report.temperatureMinC)}-${formatWeatherNumber(report.temperatureMaxC)}°C</p>
        </div>
      </div>
      <div class="phone-weather-details">
        <span>降水 ${formatWeatherNumber(report.precipitationMm, 1)}mm</span>
        <span>风速 ${formatWeatherNumber(report.windSpeedMaxKmh)}km/h</span>
      </div>
    </div>
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
        ${renderWeatherHero(state)}
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

function renderReaderPhonePage(state: AppState, flipDir: string, renderers: PhoneRenderers) {
  return `
    <section class="phone-route-page phone-app-page phone-app-page--reader" data-phone-route-view="app:reader">
      ${renderPhoneAppHeader(state, '阅读', state.generating ? '记录中' : '手帐')}
      <div class="phone-page-scroll phone-page-scroll--reader">
        ${renderers.renderPaperWorkspace(state, flipDir, { embedded: true })}
      </div>
    </section>
  `;
}

function renderSummaryPhonePage(state: AppState, renderers: PhoneRenderers) {
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:summary">
      ${renderPhoneAppHeader(state, '摘要 / 记忆', `${state.summaryStore.minor.length + state.summaryStore.major.length} 条摘要`)}
      ${renderers.renderSummaryPanel(state)}
    </section>
  `;
}

function renderStatusPhonePage(state: AppState, renderers: PhoneRenderers) {
  const target = getActiveTarget(state.statusData);
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:status">
      ${renderPhoneAppHeader(state, '状态', target?.stage ?? '')}
      ${renderers.renderStatusPanel(state)}
    </section>
  `;
}

function renderInventoryPhonePage(statusData: StatusData, state: AppState, renderers: PhoneRenderers) {
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:inventory">
      ${renderPhoneAppHeader(state, '背包', `${Object.keys(statusData.player.inventory).length} 件物品`)}
      ${renderers.renderInventoryPanel(statusData)}
    </section>
  `;
}

function renderSettingsPhonePage(state: AppState, renderers: PhoneRenderers) {
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
          ${renderers.renderSummaryConfigSection(state)}
        </div>
      </section>
    </section>
  `;
}

function renderPhoneRoute(state: AppState, flipDir: string, renderers: PhoneRenderers) {
  if (state.phoneRoute === 'app:reader') return renderReaderPhonePage(state, flipDir, renderers);
  if (state.phoneRoute === 'app:summary') return renderSummaryPhonePage(state, renderers);
  if (state.phoneRoute === 'app:status') return renderStatusPhonePage(state, renderers);
  if (state.phoneRoute === 'app:inventory') return renderInventoryPhonePage(state.statusData, state, renderers);
  if (state.phoneRoute === 'app:settings') return renderSettingsPhonePage(state, renderers);
  return renderPhoneHome(state);
}

export function renderPhone(state: AppState, renderers: PhoneRenderers, flipDir: string = '') {
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
            ${renderPhoneRoute(state, flipDir, renderers)}
          </div>
        </div>
      </section>
    </div>
  `;
}

export function renderFloatingPhone(state: AppState) {
  const unreadBadge = state.notification ? '<span class="floating-phone__badge">1</span>' : '';

  return `
    <button
      class="floating-phone"
      data-action="open-phone"
      data-drag-handle="true"
      style="${renderFloatingPhoneStyle(state.floatingPhone)}"
      aria-label="打开记事本"
    >
      ${unreadBadge}
    </button>
  `;
}
