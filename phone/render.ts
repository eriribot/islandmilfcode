import { escapeHtml } from '../html';
import type { AppState, NotificationState, PhoneChatThread, StatusData, TargetStatus } from '../types';
import { formatDate, formatTime } from '../variables/normalize';
import { renderCharacterArchivePanel } from './archive';
import type { FloatingPhonePosition, PhoneCharacterId, PhoneRoute } from './types';
import { resolveWeatherRequest } from './weather';

const PHONE_CHARACTER_THEMES: Record<
  PhoneCharacterId,
  {
    label: string;
    avatarUrl: string;
    wallpaperUrl: string;
    // 每个女主的 BGM 地址跟主题资源放在同一处维护；渲染头像按钮时会写进 data-bgm-url。
    // 点击事件只读取这个地址播放音乐，不再额外维护一份容易不同步的角色/音乐映射。
    bgmUrl: string;
  }
> = {
  megumi: {
    label: '加藤惠',
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/megumi_phone.jpg',
    wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_megumi.png',
    bgmUrl: 'https://eriribot.github.io/islandmilfcode/music/megumi.mp3',
  },
  eriri: {
    label: '英梨梨',
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/eriri_phone.jpg',
    wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_eriri.png',
    bgmUrl: 'https://eriribot.github.io/islandmilfcode/music/eriri.mp3',
  },
  utaha: {
    label: '霞之丘诗羽',
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/utaha_phone.jpg',
    wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_utaha.png',
    bgmUrl: 'https://eriribot.github.io/islandmilfcode/music/utaha.mp3',
  },
};

const PHONE_CHARACTER_ORDER: PhoneCharacterId[] = ['megumi', 'eriri', 'utaha'];

function getPhoneCharacterTheme(characterId: PhoneCharacterId) {
  return PHONE_CHARACTER_THEMES[characterId] ?? PHONE_CHARACTER_THEMES.megumi;
}

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

function renderWeatherIcon(iconCode: string, label: string) {
  const safeIconCode = /^[0-9]+$/.test(iconCode) ? iconCode : '999';
  const safeLabel = escapeHtml(label);
  return `
    <span class="phone-weather-icon">
      <img
        src="https://cdn.jsdelivr.net/npm/qweather-icons@1.6.0/icons/${safeIconCode}.svg"
        alt="${safeLabel}"
        loading="lazy"
        decoding="async"
      />
    </span>
  `;
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
        ${renderWeatherIcon(report.icon, report.conditionLabel)}
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

// 状态栏
function renderPhoneHome(state: AppState) {
  const playerMeta = state.playerProfile.className || state.playerProfile.gender || '主角档案';
  const selectedCharacter = getPhoneCharacterTheme(state.phoneCharacterId);
  const phoneThreadCount = Object.values(state.phoneMessages.threads).filter(thread => thread.messages.length).length;
  const summaryCount =
    state.summaryStore.minor.length + state.summaryStore.major.length + (state.summaryStore.global ? 1 : 0);
  const inventoryCount = Object.keys(state.statusData.player.inventory).length;
  const apps: Array<{
    route: PhoneRoute;
    icon: string;
    iconType?: 'text' | 'image';
    label: string;
    meta: string;
    dock?: boolean;
  }> = [
    {
      route: 'app:messages',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBmaWxsPSIjOGJjMzRhIiBkPSJNMzcgMzlIMTFsLTYgNlYxMWMwLTMuMyAyLjctNiA2LTZoMjZjMy4zIDAgNiAyLjcgNiA2djIyYzAgMy4zLTIuNyA2LTYgNiIvPjwvc3ZnPg==',
      iconType: 'image',
      label: '消息',
      meta: phoneThreadCount ? `${phoneThreadCount} 个会话` : '暂无会话',
      dock: true,
    },
    {
      route: 'app:calendar',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBmaWxsPSIjY2ZkOGRjIiBkPSJNNSAzOFYxNGgzOHYyNGMwIDIuMi0xLjggNC00IDRIOWMtMi4yIDAtNC0xLjgtNC00Ii8+PHBhdGggZmlsbD0iI2Y0NDMzNiIgZD0iTTQzIDEwdjZINXYtNmMwLTIuMiAxLjgtNCA0LTRoMzBjMi4yIDAgNCAxLjggNCA0Ii8+PGcgZmlsbD0iI2I3MWMxYyI+PGNpcmNsZSBjeD0iMzMiIGN5PSIxMCIgcj0iMyIvPjxjaXJjbGUgY3g9IjE1IiBjeT0iMTAiIHI9IjMiLz48L2c+PHBhdGggZmlsbD0iI2IwYmVjNSIgZD0iTTMzIDNjLTEuMSAwLTIgLjktMiAydjVjMCAxLjEuOSAyIDIgMnMyLS45IDItMlY1YzAtMS4xLS45LTItMi0yTTE1IDNjLTEuMSAwLTIgLjktMiAydjVjMCAxLjEuOSAyIDIgMnMyLS45IDItMlY1YzAtMS4xLS45LTItMi0ybS0yIDE4aDZ2NmgtNnptOCAwaDZ2NmgtNnptOCAwaDZ2NmgtNnptLTE2IDhoNnY2aC02em04IDBoNnY2aC02eiIvPjxwYXRoIGZpbGw9IiNmNDQzMzYiIGQ9Ik0yOSAyOWg2djZoLTZ6Ii8+PC9zdmc+',
      iconType: 'image',
      label: '日历',
      meta: escapeHtml(formatDate(state.statusData.world.currentTime)),
    },
    {
      route: 'app:archive',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBmaWxsPSIjNDU1YTY0IiBkPSJNMzYgNEgyNmMwIDEuMS0uOSAyLTIgMnMtMi0uOS0yLTJIMTJDOS44IDQgOCA1LjggOCA4djMyYzAgMi4yIDEuOCA0IDQgNGgyNGMyLjIgMCA0LTEuOCA0LTRWOGMwLTIuMi0xLjgtNC00LTQiLz48cGF0aCBmaWxsPSIjZmZmIiBkPSJNMzYgNDFIMTJjLS42IDAtMS0uNC0xLTFWOGMwLS42LjQtMSAxLTFoMjRjLjYgMCAxIC40IDEgMXYzMmMwIC42LS40IDEtMSAxIi8+PGcgZmlsbD0iIzkwYTRhZSI+PHBhdGggZD0iTTI2IDRjMCAxLjEtLjkgMi0yIDJzLTItLjktMi0yaC03djRjMCAxLjEuOSAyIDIgMmgxNGMxLjEgMCAyLS45IDItMlY0eiIvPjxwYXRoIGQ9Ik0yNCAwYy0yLjIgMC00IDEuOC00IDRzMS44IDQgNCA0czQtMS44IDQtNHMtMS44LTQtNC00bTAgNmMtMS4xIDAtMi0uOS0yLTJzLjktMiAyLTJzMiAuOSAyIDJzLS45IDItMiAyIi8+PC9nPjxwYXRoIGZpbGw9IiM0Y2FmNTAiIGQ9Im0zMC42IDE4LjZsLTkgOWwtNC4yLTQuM2wtMi41IDIuNWw2LjggNi43bDExLjQtMTEuNHoiLz48L3N2Zz4=',
      iconType: 'image',
      label: '档案',
      meta: selectedCharacter.label,
    },
    {
      route: 'app:status',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBmaWxsPSIjOTBjYWY5IiBkPSJNMzMgNDJINVY0aDE5bDkgOXoiLz48cGF0aCBmaWxsPSIjZTFmNWZlIiBkPSJNMzEuNSAxNEgyM1Y1LjV6Ii8+PHBhdGggZmlsbD0iIzYxNjE2MSIgZD0ibTM0LjUwNSAzNy41OGwxLjk4LTEuOThsOC40ODMgOC40ODVsLTEuOTggMS45OHoiLz48Y2lyY2xlIGN4PSIyOCIgY3k9IjI5IiByPSIxMSIgZmlsbD0iIzYxNjE2MSIvPjxjaXJjbGUgY3g9IjI4IiBjeT0iMjkiIHI9IjkiIGZpbGw9IiM5MGNhZjkiLz48cGF0aCBmaWxsPSIjMzc0NzRmIiBkPSJtMzYuODQ5IDM5Ljg4bDEuOTgtMS45OGw2LjE1IDYuMTUxbC0xLjk4IDEuOTh6Ii8+PHBhdGggZmlsbD0iIzE5NzZkMiIgZD0iTTMwIDMxaC05LjdjLjQgMS42IDEuMyAzIDIuNSA0SDMwem0tOS43LTRIMzB2LTRoLTcuM2MtMS4yIDEtMiAyLjQtMi40IDRtLS4yLTdIMTF2Mmg3LjNjLjUtLjcgMS4xLTEuNCAxLjgtMm0tMyA0SDExdjJoNS40Yy4yLS43LjQtMS40LjctMk0xNiAyOWMwLS4zIDAtLjcuMS0xSDExdjJoNS4xYy0uMS0uMy0uMS0uNy0uMS0xbS40IDNIMTF2Mmg2LjFjLS4zLS42LS41LTEuMy0uNy0yIi8+PC9zdmc+',
      iconType: 'image',
      label: '状态',
      meta: playerMeta,
      dock: true,
    },
    {
      route: 'app:inventory',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBmaWxsPSIjNDI0MjQyIiBkPSJNMjcgN2gtNmMtMS43IDAtMyAxLjMtMyAzdjNoMnYtM2MwLS42LjQtMSAxLTFoNmMuNiAwIDEgLjQgMSAxdjNoMnYtM2MwLTEuNy0xLjMtMy0zLTMiLz48cGF0aCBmaWxsPSIjZTY1MTAwIiBkPSJNNDAgNDNIOGMtMi4yIDAtNC0xLjgtNC00VjE1YzAtMi4yIDEuOC00IDQtNGgzMmMyLjIgMCA0IDEuOCA0IDR2MjRjMCAyLjItMS44IDQtNCA0Ii8+PHBhdGggZmlsbD0iI2ZmNmU0MCIgZD0iTTQwIDI4SDhjLTIuMiAwLTQtMS44LTQtNHYtOWMwLTIuMiAxLjgtNCA0LTRoMzJjMi4yIDAgNCAxLjggNCA0djljMCAyLjItMS44IDQtNCA0Ii8+PHBhdGggZmlsbD0iI2ZmZjNlMCIgZD0iTTI2IDI2aC00Yy0uNiAwLTEtLjQtMS0xdi0yYzAtLjYuNC0xIDEtMWg0Yy42IDAgMSAuNCAxIDF2MmMwIC42LS40IDEtMSAxIi8+PC9zdmc+',
      iconType: 'image',
      label: '背包',
      meta: `${inventoryCount} 件`,
    },
    {
      route: 'app:summary',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBmaWxsPSIjZmZjMTA3IiBkPSJtMjEuMiA0NC44bC0xOC0xOGMtMS42LTEuNi0xLjYtNC4xIDAtNS43bDE4LTE4YzEuNi0xLjYgNC4xLTEuNiA1LjcgMGwxOCAxOGMxLjYgMS42IDEuNiA0LjEgMCA1LjdsLTE4IDE4Yy0xLjYgMS42LTQuMiAxLjYtNS43IDAiLz48ZyBmaWxsPSIjMzc0NzRmIj48Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIyIi8+PGNpcmNsZSBjeD0iMzIiIGN5PSIyNCIgcj0iMiIvPjxjaXJjbGUgY3g9IjE2IiBjeT0iMjQiIHI9IjIiLz48L2c+PC9zdmc+',
      iconType: 'image',
      label: '摘要',
      meta: `${summaryCount} 条记忆`,
      dock: true,
    },
    {
      route: 'app:settings',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBmaWxsPSIjNjA3ZDhiIiBkPSJNMzkuNiAyNy4yYy4xLS43LjItMS40LjItMi4ycy0uMS0xLjUtLjItMi4ybDQuNS0zLjJjLjQtLjMuNi0uOS4zLTEuNEw0MCAxMC44Yy0uMy0uNS0uOC0uNy0xLjMtLjRsLTUgMi4zYy0xLjItLjktMi40LTEuNi0zLjgtMi4yTDI5LjQgNWMtLjEtLjUtLjUtLjktMS0uOWgtOC42Yy0uNSAwLTEgLjQtMSAuOWwtLjUgNS41Yy0xLjQuNi0yLjcgMS4zLTMuOCAyLjJsLTUtMi4zYy0uNS0uMi0xLjEgMC0xLjMuNGwtNC4zIDcuNGMtLjMuNS0uMSAxLjEuMyAxLjRsNC41IDMuMmMtLjEuNy0uMiAxLjQtLjIgMi4ycy4xIDEuNS4yIDIuMkw0IDMwLjRjLS40LjMtLjYuOS0uMyAxLjRMOCAzOS4yYy4zLjUuOC43IDEuMy40bDUtMi4zYzEuMi45IDIuNCAxLjYgMy44IDIuMmwuNSA1LjVjLjEuNS41LjkgMSAuOWg4LjZjLjUgMCAxLS40IDEtLjlsLjUtNS41YzEuNC0uNiAyLjctMS4zIDMuOC0yLjJsNSAyLjNjLjUuMiAxLjEgMCAxLjMtLjRsNC4zLTcuNGMuMy0uNS4xLTEuMS0uMy0xLjR6TTI0IDM1Yy01LjUgMC0xMC00LjUtMTAtMTBzNC41LTEwIDEwLTEwczEwIDQuNSAxMCAxMHMtNC41IDEwLTEwIDEwIi8+PHBhdGggZmlsbD0iIzQ1NWE2NCIgZD0iTTI0IDEzYy02LjYgMC0xMiA1LjQtMTIgMTJzNS40IDEyIDEyIDEyczEyLTUuNCAxMi0xMnMtNS40LTEyLTEyLTEybTAgMTdjLTIuOCAwLTUtMi4yLTUtNXMyLjItNSA1LTVzNSAyLjIgNSA1cy0yLjIgNS01IDUiLz48L3N2Zz4=',
      iconType: 'image',
      label: '设置',
      meta: state.activeSaveId ? '已连接存档' : '未保存',
    },
  ];
  const dockApps = apps.filter(app => app.dock);

  return `
    <section class="phone-home phone-route-page" data-phone-route-view="home">
      <div class="phone-home-hero">
        ${renderWeatherHero(state)}
        <div class="phone-character-panel" aria-label="角色切换">
          <div class="phone-home-avatar">
            <img
              src="${escapeHtml(selectedCharacter.avatarUrl)}"
              alt="${escapeHtml(selectedCharacter.label)}"
              loading="lazy"
              decoding="async"
            />
          </div>
          <div class="phone-character-switcher">
            ${PHONE_CHARACTER_ORDER.map(characterId => {
              const theme = getPhoneCharacterTheme(characterId);
              const selected = characterId === state.phoneCharacterId;
              return `
                <button
                  class="phone-character-option ${selected ? 'is-active' : ''}"
                  data-action="switch-phone-character"
                  data-character-id="${characterId}"
                  data-bgm-url="${escapeHtml(theme.bgmUrl)}"
                  aria-label="切换到${escapeHtml(theme.label)}"
                  aria-pressed="${selected ? 'true' : 'false'}"
                >
                  <img src="${escapeHtml(theme.avatarUrl)}" alt="${escapeHtml(theme.label)}" loading="lazy" decoding="async" />
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>

      <div class="phone-app-grid">
        ${apps
          .map(
            app => `
              <button class="phone-app-icon" data-phone-route="${app.route}">
                <span class="phone-app-icon__glyph">${renderAppIcon(app)}</span>
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
                ${renderAppIcon(app)}
              </button>
            `,
          )
          .join('')}
      </nav>
    </section>
  `;
}

function renderAppIcon(app: { icon: string; iconType?: 'text' | 'image'; label: string }) {
  if (app.iconType === 'image') {
    // 这里用于渲染图片图标；icon 可以填 data:image、https 链接或本地资源路径。
    return `<img class="phone-app-icon__image" src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.label)}" loading="lazy" decoding="async" />`;
  }
  return escapeHtml(app.icon);
}

/** 日历起始日期 */
const CALENDAR_EPOCH = new Date(2012, 2, 31);
const WEEKDAY_HEADERS = ['日', '月', '火', '水', '木', '金', '土'];

/** 从游戏时间字符串解析年月日 */
function parseGameDate(timeStr: string): { year: number; month: number; day: number } {
  try {
    const d = new Date(timeStr.replace(/\s.*$/, ''));
    if (!isNaN(d.getTime())) return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  } catch { /* fallback */ }
  return { year: 2012, month: 2, day: 31 };
}

/** 收集有事件的日期集合（格式 "YYYY-M-D"） */
function collectEventDates(state: AppState): Set<string> {
  const dates = new Set<string>();
  for (const key of Object.keys(state.statusData.world.recentEvents)) {
    try {
      const d = new Date(key.replace(/\s.*$/, ''));
      if (!isNaN(d.getTime())) dates.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    } catch { /* skip */ }
  }
  return dates;
}

/** 渲染日历网格 */
function renderCalendarGrid(state: AppState, monthOffset: number): string {
  const gd = parseGameDate(state.statusData.world.currentTime);
  const viewDate = new Date(gd.year, gd.month + monthOffset, 1);
  const viewYear = viewDate.getFullYear();
  const viewMonth = viewDate.getMonth();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const eventDates = collectEventDates(state);

  const monthLabel = `${viewYear}年${viewMonth + 1}月`;
  const isCurrentMonth = viewYear === gd.year && viewMonth === gd.month;

  let cells = '';
  // 前置空白
  for (let i = 0; i < firstDow; i++) {
    cells += '<span class="phone-calendar__cell phone-calendar__cell--empty"></span>';
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = isCurrentMonth && d === gd.day;
    const dateKey = `${viewYear}-${viewMonth}-${d}`;
    const hasEvent = eventDates.has(dateKey);
    const todayCls = isToday ? ' phone-calendar__cell--today' : '';
    const dot = hasEvent ? '<span class="phone-calendar__dot"></span>' : '';
    cells += `<span class="phone-calendar__cell${todayCls}">${d}${dot}</span>`;
  }

  // 月份边界检查（不早于起始日期）
  const prevMonth = new Date(viewYear, viewMonth - 1, 1);
  const canPrev = prevMonth >= new Date(CALENDAR_EPOCH.getFullYear(), CALENDAR_EPOCH.getMonth(), 1);

  return `
    <div class="phone-calendar">
      <div class="phone-calendar__nav">
        <button class="phone-calendar__nav-btn" data-action="calendar-prev" ${canPrev ? '' : 'disabled'}>‹</button>
        <span class="phone-calendar__month">${escapeHtml(monthLabel)}</span>
        <button class="phone-calendar__nav-btn" data-action="calendar-next">›</button>
      </div>
      <div class="phone-calendar__header">
        ${WEEKDAY_HEADERS.map(h => `<span class="phone-calendar__weekday">${h}</span>`).join('')}
      </div>
      <div class="phone-calendar__grid">
        ${cells}
      </div>
    </div>
  `;
}

/** 日历月份偏移量（由 index.ts 管理） */
let calendarMonthOffset = 0;

export function setCalendarMonthOffset(offset: number) {
  calendarMonthOffset = offset;
}

export function getCalendarMonthOffset(): number {
  return calendarMonthOffset;
}

function renderCalendarPhonePage(state: AppState) {
  const gd = parseGameDate(state.statusData.world.currentTime);
  const subtitle = `${gd.year}年${gd.month + 1}月${gd.day}日`;
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:calendar">
      ${renderPhoneAppHeader(state, '日历', subtitle)}
      <div class="phone-page-scroll">
        ${renderCalendarGrid(state, calendarMonthOffset)}
      </div>
    </section>
  `;
}

function getTargetName(target: TargetStatus) {
  return target.name || target.alias || '角色';
}

function getTargetAvatarUrl(target: TargetStatus) {
  const avatarUrl = target.meta?.avatarUrl;
  return typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl.trim() : '';
}

function renderTargetAvatar(target: TargetStatus) {
  const avatarUrl = getTargetAvatarUrl(target);
  const targetName = getTargetName(target);
  if (avatarUrl) {
    return `
      <span class="phone-chat-avatar phone-chat-avatar--image">
        <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(targetName)}" loading="lazy" decoding="async" />
      </span>
    `;
  }
  return `<span class="phone-chat-avatar">${escapeHtml(targetName.slice(0, 1))}</span>`;
}

function getThreadPreview(thread: PhoneChatThread) {
  const last = thread.messages[thread.messages.length - 1];
  return last?.text?.trim() || '还没有消息。';
}

function renderPhoneThreadRow(target: TargetStatus, thread: PhoneChatThread) {
  const unread = thread.unread > 0 ? `<span class="phone-chat-unread">${thread.unread}</span>` : '';
  const last = thread.messages[thread.messages.length - 1];
  const timestamp = last?.timestamp || '';
  return `
    <button class="phone-chat-row" data-action="open-phone-thread" data-target-id="${escapeHtml(target.id)}">
      ${renderTargetAvatar(target)}
      <span class="phone-chat-copy">
        <strong>${escapeHtml(getTargetName(target))}</strong>
        <small>${escapeHtml(getThreadPreview(thread))}</small>
      </span>
      <span class="phone-chat-meta">
        ${timestamp ? `<small>${escapeHtml(timestamp)}</small>` : ''}
        ${unread}
      </span>
    </button>
  `;
}

function renderPhoneContactRow(target: TargetStatus, hasThread: boolean) {
  return `
    <button class="phone-contact-row" data-action="open-phone-thread" data-target-id="${escapeHtml(target.id)}">
      ${renderTargetAvatar(target)}
      <span class="phone-chat-copy">
        <strong>${escapeHtml(getTargetName(target))}</strong>
        <small>${escapeHtml(target.stage)} · 好感度 ${target.affinity}</small>
      </span>
      <span class="phone-contact-state">${hasThread ? '继续' : '发消息'}</span>
    </button>
  `;
}

function renderMessagesPhonePage(state: AppState) {
  const threads = Object.values(state.phoneMessages.threads)
    .filter(thread => thread.messages.length)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const targetsById = new Map(state.statusData.targets.map(target => [target.id, target]));
  const contactTargets = state.statusData.targets;

  return `
    <section class="phone-route-page phone-app-page phone-app-page--messages" data-phone-route-view="app:messages">
      ${renderPhoneAppHeader(state, '消息', threads.length ? `${threads.length} 个会话` : '没有会话')}
      <div class="phone-page-scroll phone-message-scroll">
        <section class="phone-chat-section">
          <div class="phone-chat-section-title">最近消息</div>
          ${
            threads.length
              ? threads
                  .map(thread => {
                    const target = targetsById.get(thread.targetId);
                    return target ? renderPhoneThreadRow(target, thread) : '';
                  })
                  .join('')
              : '<div class="phone-chat-empty">还没有开始任何聊天。</div>'
          }
        </section>
        <section class="phone-chat-section">
          <div class="phone-chat-section-title">联系人</div>
          ${
            contactTargets.length
              ? contactTargets
                  .map(target =>
                    renderPhoneContactRow(target, Boolean(state.phoneMessages.threads[target.id]?.messages.length)),
                  )
                  .join('')
              : '<div class="phone-chat-empty">当前没有可联系的角色。</div>'
          }
        </section>
      </div>
    </section>
  `;
}

function renderPhoneChatPage(state: AppState) {
  const targetId = state.phoneMessages.activeThreadId;
  const target = targetId ? state.statusData.targets.find(item => item.id === targetId) : null;
  if (!target) {
    return renderMessagesPhonePage(state);
  }

  const thread = state.phoneMessages.threads[target.id];
  const messages = thread?.messages ?? [];
  // 正文生成期间锁住手机输入，防止后台手机生成抢占正文流式事件。
  const chatLocked = state.phoneMessages.generating || state.generating;

  return `
    <section class="phone-route-page phone-app-page phone-app-page--chat" data-phone-route-view="app:chat">
      ${renderPhoneAppHeader(state, getTargetName(target), `${target.stage} · ${target.affinity}`)}
      <div class="phone-chat-log">
        ${
          messages.length
            ? messages
                .map(
                  message => `
                    <div class="phone-chat-bubble phone-chat-bubble--${message.role}">
                      <span>${escapeHtml(message.text)}</span>
                      <small>${escapeHtml(message.timestamp)}</small>
                    </div>
                  `,
                )
                .join('')
            : '<div class="phone-chat-empty phone-chat-empty--log">发送第一条消息。</div>'
        }
      </div>
      <div class="phone-chat-composer">
        <textarea
          class="phone-chat-input"
          data-field="phone-chat-draft"
          placeholder="输入消息"
          ${chatLocked ? 'disabled' : ''}
        >${escapeHtml(state.phoneMessages.draft)}</textarea>
        <button
          class="phone-chat-send"
          data-action="send-phone-message"
          data-target-id="${escapeHtml(target.id)}"
          ${chatLocked ? 'disabled' : ''}
        >${state.phoneMessages.generating ? '…' : '发送'}</button>
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
  const profileSubtitle = state.playerProfile.className || state.playerProfile.gender || '';
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:status">
      ${renderPhoneAppHeader(state, '状态', profileSubtitle)}
      ${renderers.renderStatusPanel(state)}
    </section>
  `;
}

function renderArchivePhonePage(state: AppState) {
  const selectedCharacter = getPhoneCharacterTheme(state.phoneCharacterId);
  return `
    <section class="phone-route-page phone-app-page phone-app-page--archive" data-phone-route-view="app:archive">
      ${renderPhoneAppHeader(state, '人物档案', selectedCharacter.label)}
      <div class="phone-page-scroll archive-phone-scroll">
        ${renderCharacterArchivePanel(state.phoneCharacterId, state.statusData.targets)}
      </div>
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
  if (state.phoneRoute === 'app:messages') return renderMessagesPhonePage(state);
  if (state.phoneRoute === 'app:chat') return renderPhoneChatPage(state);
  if (state.phoneRoute === 'app:calendar') return renderCalendarPhonePage(state);
  if (state.phoneRoute === 'app:summary') return renderSummaryPhonePage(state, renderers);
  if (state.phoneRoute === 'app:archive') return renderArchivePhonePage(state);
  if (state.phoneRoute === 'app:status') return renderStatusPhonePage(state, renderers);
  if (state.phoneRoute === 'app:inventory') return renderInventoryPhonePage(state.statusData, state, renderers);
  if (state.phoneRoute === 'app:settings') return renderSettingsPhonePage(state, renderers);
  return renderPhoneHome(state);
}

export function renderPhone(state: AppState, renderers: PhoneRenderers, flipDir: string = '') {
  const selectedCharacter = getPhoneCharacterTheme(state.phoneCharacterId);
  return `
    <div class="phone-modal ${state.phoneOpen ? 'is-open' : ''}" aria-hidden="${state.phoneOpen ? 'false' : 'true'}">
      <button class="phone-backdrop" data-action="close-phone" aria-label="关闭手帐"></button>
      <section class="phone-shell">
        <div class="phone-notch"></div>
        <div
          class="phone-inner"
          style="--phone-wallpaper-url:url('${escapeHtml(selectedCharacter.wallpaperUrl)}');"
        >
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
