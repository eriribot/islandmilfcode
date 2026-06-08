import { escapeHtml } from '../html';
import type { AppState, NotificationState, PhoneChatThread, PlotEventCard, StatusData, TargetStatus } from '../types';
import { formatDate, formatTime } from '../variables/normalize';
import { renderCharacterArchivePanel } from './archive';
import type { FloatingPhonePosition, MusicTrack, PhoneCharacterId, PhoneRoute, PhoneThemeCharacterId } from './types';
import { CHARACTER_QUICK_SEARCH, formatPlaybackTime } from './music';
import { renderMemoryEditor } from '../memorydatabase/editor';

type PhoneCharacterThemeId = PhoneThemeCharacterId;

const PHONE_CHARACTER_THEMES: Record<
  PhoneCharacterThemeId,
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
  izumi: {
    label: '波岛出海',
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg',
    wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_izumi.jpg',
    bgmUrl: 'https://eriribot.github.io/islandmilfcode/music/izumi.mp3',
  },
  michiru: {
    label: '美智留',
    avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Michiru_phone.jpg',
    wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_michiru.jpg',
    bgmUrl: 'https://eriribot.github.io/islandmilfcode/music/michiru.mp3',
  },
};

// 手机首页头像切换按钮的显示顺序；新增女主时需要把 id 放进这里。
const PHONE_CHARACTER_ORDER: PhoneThemeCharacterId[] = ['megumi', 'eriri', 'utaha', 'izumi', 'michiru'];

function getPhoneCharacterTheme(characterId: PhoneCharacterId) {
  if (characterId === 'sayuri') {
    return {
      label: '泽村小百合',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/sayuri_phone.jpg',
      wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/sayuri_phone.jpg',
      bgmUrl: '',
    };
  }
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
        <span class="ios-notification-icon">💬</span>
        <span>${escapeHtml(notification.title)}</span>
        <span class="ios-notification-time">${escapeHtml(notification.timestamp)}</span>
      </div>
      <div class="ios-notification-title-row">
        <strong>${escapeHtml(notification.preview)}</strong>
      </div>
    </button>
  `;
}

function renderFloatingPhoneStyle(position: FloatingPhonePosition) {
  return `left:${position.x}px;top:${position.y}px;`;
}

function renderResponsivePhoneFrameStyle() {
  if (typeof window === 'undefined') return '';

  const viewportWidth = Math.max(0, window.innerWidth || 0);
  const viewportHeight = Math.max(0, window.innerHeight || 0);
  const modalPad = viewportWidth <= 720 ? 8 : Math.max(6, Math.min(24, Math.min(viewportWidth, viewportHeight) * 0.024));
  const safeWidth = Math.max(0, viewportWidth - modalPad * 2);
  const safeHeight = Math.max(0, viewportHeight - modalPad * 2);
  const maxWidth = 380;
  const maxHeight = 680;
  const aspectWidth = 380;
  const aspectHeight = 680;

  let height = Math.min(maxHeight, safeHeight);
  let width = height * (aspectWidth / aspectHeight);
  const widthCap = Math.min(maxWidth, safeWidth);
  if (width > widthCap) {
    width = widthCap;
    height = width * (aspectHeight / aspectWidth);
  }

  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  return `--phone-shell-width:${width}px;--phone-shell-height:${height}px;`;
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

function renderMusicHero(state: AppState) {
  const { currentTrack, playing, loadingTrackId, currentTime, duration } = state.musicPlayer;
  const dateLabel = escapeHtml(formatDate(state.statusData.world.currentTime));

  // 极简 iOS 风：空态也是同样的卡片骨架，封面占位、控件 disable，避免出现"还没在播放"这种 UI 文字。
  const hasTrack = Boolean(currentTrack);
  const loading = hasTrack && loadingTrackId === currentTrack!.id;
  const playLabel = loading ? '…' : playing ? '⏸' : '▶';
  const playAria = playing ? '暂停' : '播放';
  const cover = currentTrack?.picUrl
    ? `<img src="${escapeHtml(currentTrack.picUrl)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="phone-music-cover-fallback" aria-hidden="true">♪</span>`;

  const safeDuration = duration > 0 && Number.isFinite(duration) ? duration : 0;
  const safeCurrent = Math.max(0, Math.min(currentTime || 0, safeDuration || currentTime || 0));
  // BGM 在 loop 模式下 duration 也会有有限值；进度条直接可用。loading 期间保留可视占位。
  const seekDisabled = !hasTrack || safeDuration <= 0;

  const titleText = currentTrack?.name ?? ' ';
  const subText = currentTrack
    ? `${currentTrack.artist}${currentTrack.album ? ' · ' + currentTrack.album : ''}`
    : ' ';

  return `
    <div class="phone-home-music ${hasTrack ? '' : 'phone-home-music--idle'}">
      <span class="phone-home-kicker">${dateLabel}</span>
      <div class="phone-music-hero-main">
        <span class="phone-music-cover">${cover}</span>
        <div class="phone-music-hero-meta">
          <h2>${escapeHtml(titleText)}</h2>
          <p>${escapeHtml(subText)}</p>
        </div>
      </div>
      <div class="phone-music-hero-progress">
        <input
          class="phone-music-seek"
          type="range"
          min="0"
          max="${safeDuration || 0}"
          step="0.1"
          value="${safeCurrent}"
          data-action="music-seek"
          aria-label="播放进度"
          ${seekDisabled ? 'disabled' : ''}
        />
        <div class="phone-music-time">
          <span data-music-current-time>${escapeHtml(formatPlaybackTime(safeCurrent))}</span>
          <span data-music-duration>${escapeHtml(formatPlaybackTime(safeDuration))}</span>
        </div>
      </div>
      <div class="phone-music-hero-controls">
        <button
          class="phone-music-ctrl"
          data-action="music-toggle-play"
          aria-label="${playAria}"
          ${hasTrack ? '' : 'disabled'}
          ${loading ? 'disabled' : ''}
        >${playLabel}</button>
        <button
          class="phone-music-ctrl"
          data-action="music-next"
          aria-label="下一首"
          ${hasTrack ? '' : 'disabled'}
        >⏭</button>
        <button class="phone-music-ctrl phone-music-ctrl--text" data-phone-route="app:music" aria-label="搜索音乐">🔍</button>
      </div>
    </div>
  `;
}

// 状态栏
function renderPhoneHome(state: AppState) {
  const playerMeta = state.playerProfile.className || state.playerProfile.gender || '主角档案';
  const selectedCharacter = getPhoneCharacterTheme(state.phoneCharacterId);
  const characterRows = [PHONE_CHARACTER_ORDER.slice(0, 3), PHONE_CHARACTER_ORDER.slice(3)];
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
      route: 'app:memory',
      icon: '🧠',
      label: '记忆库',
      // 中文注释：首页活跃数 = 记忆库编辑器首页可见的所有 tile 之和。
      // 7 个 fact category chip 共用 facts 表（一条 fact 命中一个 category，所以 facts 总数 = 全部 category 之和），
      // 加上 USER_VISIBLE_TABLES 里的 4 张系统表（tasks/items/phoneMessages/summaries）。
      // events 和 attributes 表不在首页 tile 显示，也不计入活跃数。
      meta: `${
        state.memoryDB.facts.filter(f => !f.expired).length +
        state.memoryDB.tasks.filter(t => !t.expired).length +
        state.memoryDB.items.filter(i => !i.expired).length +
        state.memoryDB.phoneMessages.filter(p => !p.expired).length +
        state.memoryDB.summaries.filter(s => !s.expired).length
      } 条活跃`,
    },
    {
      route: 'app:music',
      icon: '🎵',
      label: '音乐',
      meta: state.musicPlayer.currentTrack
        ? `${state.musicPlayer.playing ? '正在播放' : '已暂停'} · ${state.musicPlayer.currentTrack.name}`
        : '搜索想听的曲子',
    },
    {
      route: 'app:drawing',
      icon: '🎨',
      label: '画图',
      meta: state.drawingSettings.enabled ? '独立生图已启用' : '手动控制',
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
        ${renderMusicHero(state)}
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
            ${characterRows
              .filter(row => row.length)
              .map(
                row => `
                  <div class="phone-character-switcher__row" style="--phone-character-row-count:${row.length}">
                    ${row
                      .map(characterId => {
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
                      })
                      .join('')}
                  </div>
                `,
              )
              .join('')}
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
const WEEKDAY_HEADERS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

type CalendarEventItem = {
  id: string;
  title: string;
  date: string;
  endDate: string;
  timeSegments: string[];
  locations: string[];
  summary: string;
  status: string;
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatIsoDateKey(year: number, monthIndex: number, day: number) {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function formatCalendarDateLabel(dateKey: string) {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateKey;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

function formatCalendarDateRange(event: CalendarEventItem) {
  return event.endDate && event.endDate !== event.date
    ? `${formatCalendarDateLabel(event.date)} - ${formatCalendarDateLabel(event.endDate)}`
    : formatCalendarDateLabel(event.date);
}

function getCalendarStatusLabel(status: string) {
  const value = status.trim();
  if (value === '进行中') return '进行中';
  if (value === '已结束' || value === '已完成') return '已结束';
  if (value === '跳过' || value === '延后') return value;
  return '未开始';
}

function getCalendarStatusClass(status: string) {
  const label = getCalendarStatusLabel(status);
  if (label === '进行中') return 'is-running';
  if (label === '已结束') return 'is-finished';
  if (label === '跳过' || label === '延后') return 'is-muted';
  return 'is-upcoming';
}

function buildCalendarEventItem(
  event: PlotEventCard & { schedule: NonNullable<PlotEventCard['schedule']> },
  statusData: StatusData,
): CalendarEventItem {
  return {
    id: event.id,
    title: event.title || event.id,
    date: event.schedule.date,
    endDate:
      event.schedule.endDate && event.schedule.endDate >= event.schedule.date
        ? event.schedule.endDate
        : event.schedule.date,
    timeSegments: event.schedule.timeSegments ?? [],
    locations: event.schedule.locations ?? [],
    summary: event.summary ?? '',
    status: statusData.world.mainEvents?.[event.id] ?? '',
  };
}

function collectCalendarEvents(state: AppState): CalendarEventItem[] {
  return Object.values(state.plotLibrary.events)
    .filter((event): event is PlotEventCard & { schedule: NonNullable<PlotEventCard['schedule']> } =>
      Boolean(event.schedule?.date),
    )
    .map(event => buildCalendarEventItem(event, state.statusData))
    .sort((a, b) => a.date.localeCompare(b.date) || a.endDate.localeCompare(b.endDate) || a.id.localeCompare(b.id));
}

function eventTouchesDate(event: CalendarEventItem, dateKey: string) {
  return dateKey >= event.date && dateKey <= event.endDate;
}

function eventTouchesRange(event: CalendarEventItem, startDate: string, endDate: string) {
  return event.endDate >= startDate && event.date <= endDate;
}

/** 从游戏时间字符串解析年月日 */
function parseGameDate(timeStr: string): { year: number; month: number; day: number } {
  try {
    const d = new Date(timeStr.replace(/\s.*$/, ''));
    if (!isNaN(d.getTime())) return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  } catch {
    /* fallback */
  }
  return { year: 2012, month: 2, day: 31 };
}

function buildMonthEventMap(events: CalendarEventItem[], year: number, monthIndex: number, daysInMonth: number) {
  const map = new Map<string, CalendarEventItem[]>();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = formatIsoDateKey(year, monthIndex, day);
    const eventsForDay = events.filter(event => eventTouchesDate(event, dateKey));
    if (eventsForDay.length) map.set(dateKey, eventsForDay);
  }
  return map;
}

function renderCalendarDots(events: CalendarEventItem[]) {
  if (!events.length) return '';
  const dots = events
    .slice(0, 3)
    .map((event, index) => `<span class="phone-calendar__dot phone-calendar__dot--${index + 1}" title="${escapeHtml(event.title)}"></span>`)
    .join('');
  const extra = events.length > 3 ? `<span class="phone-calendar__more">+${events.length - 3}</span>` : '';
  return `<span class="phone-calendar__dots">${dots}${extra}</span>`;
}

function renderCalendarEventRow(event: CalendarEventItem) {
  const statusLabel = getCalendarStatusLabel(event.status);
  const statusClass = getCalendarStatusClass(event.status);
  const timeLine = [formatCalendarDateRange(event), event.timeSegments.join(' / ')].filter(Boolean).join(' · ');
  const locationLine = event.locations.join('、');
  return `
    <article class="phone-calendar-event phone-calendar-event--${statusClass}">
      <span class="phone-calendar-event__rail"></span>
      <span class="phone-calendar-event__body">
        <span class="phone-calendar-event__top">
          <strong>${escapeHtml(event.title)}</strong>
          <em>${escapeHtml(statusLabel)}</em>
        </span>
        <span class="phone-calendar-event__meta">${escapeHtml(timeLine || event.id)}</span>
        ${locationLine ? `<span class="phone-calendar-event__place">${escapeHtml(locationLine)}</span>` : ''}
        ${event.summary ? `<span class="phone-calendar-event__summary">${escapeHtml(event.summary)}</span>` : ''}
      </span>
    </article>
  `;
}

function renderCalendarAgenda(
  selectedDate: string,
  selectedEvents: CalendarEventItem[],
  monthEvents: CalendarEventItem[],
) {
  const fallbackToMonth = !selectedEvents.length;
  const events = fallbackToMonth ? monthEvents : selectedEvents;
  const title = fallbackToMonth ? '本月事件' : '当天事件';
  const subtitle = fallbackToMonth ? '本月日程' : formatCalendarDateLabel(selectedDate);

  return `
    <section class="phone-calendar-agenda">
      <div class="phone-calendar-agenda__header">
        <span>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(subtitle)}</small>
        </span>
      </div>
      ${
        events.length
          ? `<div class="phone-calendar-agenda__list">${events.map(renderCalendarEventRow).join('')}</div>`
          : '<div class="phone-calendar-agenda__empty">这个月份没有事件。</div>'
      }
    </section>
  `;
}

/** 渲染日历网格 */
function renderCalendarGrid(state: AppState, monthOffset: number): string {
  const gd = parseGameDate(state.statusData.world.currentTime);
  const viewDate = new Date(gd.year, gd.month + monthOffset, 1);
  const viewYear = viewDate.getFullYear();
  const viewMonth = viewDate.getMonth();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const monthStart = formatIsoDateKey(viewYear, viewMonth, 1);
  const monthEnd = formatIsoDateKey(viewYear, viewMonth, daysInMonth);
  const calendarEvents = collectCalendarEvents(state);
  const monthEvents = calendarEvents.filter(event => eventTouchesRange(event, monthStart, monthEnd));
  const eventMap = buildMonthEventMap(monthEvents, viewYear, viewMonth, daysInMonth);

  const monthLabel = `${viewYear}年${viewMonth + 1}月`;
  const isCurrentMonth = viewYear === gd.year && viewMonth === gd.month;
  const todayKey = formatIsoDateKey(gd.year, gd.month, gd.day);
  const selectedDate =
    calendarSelectedDateKey && calendarSelectedDateKey >= monthStart && calendarSelectedDateKey <= monthEnd
      ? calendarSelectedDateKey
      : isCurrentMonth
        ? todayKey
        : eventMap.keys().next().value ?? monthStart;

  let cells = '';
  // 前置空白
  for (let i = 0; i < firstDow; i++) {
    cells += '<span class="phone-calendar__cell phone-calendar__cell--empty"></span>';
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = formatIsoDateKey(viewYear, viewMonth, d);
    const isToday = dateKey === todayKey;
    const isSelected = dateKey === selectedDate;
    const events = eventMap.get(dateKey) ?? [];
    const todayCls = isToday ? ' phone-calendar__cell--today' : '';
    const selectedCls = isSelected ? ' phone-calendar__cell--selected' : '';
    const eventCls = events.length ? ' phone-calendar__cell--has-event' : '';
    cells += `
      <button class="phone-calendar__cell${todayCls}${selectedCls}${eventCls}" data-action="calendar-select-date" data-date="${escapeHtml(dateKey)}" type="button">
        <span class="phone-calendar__day-number">${d}</span>
        ${renderCalendarDots(events)}
      </button>
    `;
  }

  // 月份边界检查（不早于起始日期）
  const prevMonth = new Date(viewYear, viewMonth - 1, 1);
  const canPrev = prevMonth >= new Date(CALENDAR_EPOCH.getFullYear(), CALENDAR_EPOCH.getMonth(), 1);
  const selectedEvents = eventMap.get(selectedDate) ?? [];

  return `
    <div class="phone-calendar">
      <div class="phone-calendar__nav">
        <button class="phone-calendar__nav-btn" data-action="calendar-prev" ${canPrev ? '' : 'disabled'}>‹</button>
        <span class="phone-calendar__month">
          <strong>${escapeHtml(monthLabel)}</strong>
        </span>
        <button class="phone-calendar__nav-btn" data-action="calendar-next">›</button>
      </div>
      <div class="phone-calendar__header">
        ${WEEKDAY_HEADERS.map(h => `<span class="phone-calendar__weekday">${h}</span>`).join('')}
      </div>
      <div class="phone-calendar__grid">
        ${cells}
      </div>
    </div>
    ${renderCalendarAgenda(selectedDate, selectedEvents, monthEvents)}
  `;
}

/** 日历月份偏移量（由 index.ts 管理） */
let calendarMonthOffset = 0;
let calendarSelectedDateKey: string | null = null;

export function setCalendarMonthOffset(offset: number) {
  calendarMonthOffset = offset;
}

export function getCalendarMonthOffset(): number {
  return calendarMonthOffset;
}

export function setCalendarSelectedDate(dateKey: string | null) {
  calendarSelectedDateKey = dateKey;
}

function renderCalendarPhonePage(state: AppState) {
  const gd = parseGameDate(state.statusData.world.currentTime);
  const subtitle = `${gd.year}年${gd.month + 1}月${gd.day}日`;
  return `
    <section class="phone-route-page phone-app-page phone-app-page--calendar" data-phone-route-view="app:calendar">
      ${renderPhoneAppHeader(state, '日历', subtitle)}
      <div class="phone-page-scroll phone-calendar-scroll">
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
  const normalized = typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl.trim() : '';
  if (normalized === 'https://eriribot.github.io/islandmilfcode/picresource/izumi_film.jpg') {
    return 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg';
  }
  return normalized;
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
        <small>${escapeHtml(target.stage)} · 好感 ${target.affinity} · 执念 ${target.obsession}</small>
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
      ${renderPhoneAppHeader(state, getTargetName(target), `${target.stage} · 好感 ${target.affinity} · 执念 ${target.obsession}`)}
      <div class="phone-chat-log">
        ${
          messages.length
            ? messages
                .map(
                  message => `
                    <div class="phone-chat-bubble phone-chat-bubble--${message.role}">
                      <button
                        class="phone-chat-delete"
                        data-action="delete-phone-message"
                        data-target-id="${escapeHtml(target.id)}"
                        data-message-id="${escapeHtml(message.id)}"
                        title="删除短信"
                        aria-label="删除短信"
                        ${chatLocked ? 'disabled' : ''}
                      >×</button>
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
        ${renderCharacterArchivePanel(state.phoneCharacterId, state.statusData.targets, state.memoryDB)}
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
            <button class="settings-action" data-action="export-save" ${state.activeSaveId ? '' : 'disabled'}>
              <strong>导出当前存档</strong>
              <span>下载当前进度的 JSON 备份，含记录、记忆库与摘要。</span>
            </button>
            <button class="settings-action" data-action="import-saves">
              <strong>导入存档备份</strong>
              <span>选择之前导出的 JSON 文件，会合并或覆盖同名存档。</span>
            </button>
            <input type="file" data-field="import-saves-file" accept="application/json,.json" hidden />
          </div>
          ${renderers.renderSummaryConfigSection(state)}
        </div>
      </section>
    </section>
  `;
}

function renderMusicTrackRow(track: MusicTrack, isCurrent: boolean, isLoading: boolean) {
  // 当前曲目高亮、loading 期间禁用按钮，避免重复点击触发多个 fetchTrackStreamUrl。
  const stateClass = isCurrent ? ' phone-music-row--current' : '';
  return `
    <button
      class="phone-music-row${stateClass}"
      data-action="music-play-track"
      data-track-id="${escapeHtml(track.id)}"
      ${isLoading ? 'disabled' : ''}
    >
      <span class="phone-music-row__cover">
        ${track.picUrl ? `<img src="${escapeHtml(track.picUrl)}" alt="" loading="lazy" decoding="async" />` : '♪'}
      </span>
      <span class="phone-music-row__copy">
        <strong>${escapeHtml(track.name)}</strong>
        <small>${escapeHtml(track.artist)}${track.album ? ' · ' + escapeHtml(track.album) : ''}</small>
      </span>
      <span class="phone-music-row__state">${isLoading ? '…' : isCurrent ? '在播' : '播放'}</span>
    </button>
  `;
}

function renderMusicQuickEntries(currentCharacter: PhoneCharacterId) {
  // 五小只角色歌快捷搜索：点一下就把对应作品/角色名填进搜索框并触发搜索。
  const labels: Array<{ id: PhoneThemeCharacterId; label: string }> = [
    { id: 'megumi', label: '加藤惠' },
    { id: 'eriri', label: '英梨梨' },
    { id: 'utaha', label: '霞之丘诗羽' },
    { id: 'izumi', label: '波岛出海' },
    { id: 'michiru', label: '美智留' },
  ];
  return labels.map(item => `
    <button
      class="phone-music-quick ${item.id === currentCharacter ? 'is-current' : ''}"
      data-action="music-quick-search"
      data-character-id="${item.id}"
      data-quick-keyword="${escapeHtml(CHARACTER_QUICK_SEARCH[item.id])}"
      type="button"
    >${escapeHtml(item.label)}</button>
  `).join('');
}

function renderMusicPhonePage(state: AppState) {
  const { search, currentTrack, loadingTrackId } = state.musicPlayer;
  const subtitle = currentTrack
    ? `${currentTrack.name} · ${currentTrack.artist}`
    : '搜索想听的曲子';

  let resultsBlock = '';
  if (search.status === 'loading') {
    resultsBlock = '<div class="phone-music-empty">搜索中…</div>';
  } else if (search.status === 'error') {
    resultsBlock = `<div class="phone-music-empty phone-music-empty--error">${escapeHtml(search.error || '搜索失败')}</div>`;
  } else if (search.status === 'ready' && !search.results.length) {
    resultsBlock = '<div class="phone-music-empty">这个关键词没找到结果，换个词试试。</div>';
  } else if (search.status === 'ready') {
    resultsBlock = `<div class="phone-music-list">${search.results
      .map(track => renderMusicTrackRow(track, currentTrack?.id === track.id && currentTrack?.source === track.source, loadingTrackId === track.id))
      .join('')}</div>`;
  } else {
    resultsBlock = '<div class="phone-music-empty">还没搜索过。试试搜"加藤惠"、"恋爱循环"或任意你想听的歌名。</div>';
  }

  return `
    <section class="phone-route-page phone-app-page phone-app-page--music" data-phone-route-view="app:music">
      ${renderPhoneAppHeader(state, '音乐', subtitle)}
      <div class="phone-page-scroll phone-music-scroll">
        <form class="phone-music-search" data-action="music-search-submit" autocomplete="off">
          <input
            class="phone-music-search-input"
            data-field="music-search"
            type="search"
            value="${escapeHtml(search.query)}"
            placeholder="搜索歌名、艺人或专辑"
          />
          <button class="phone-music-search-btn" type="submit">搜索</button>
        </form>
        <div class="phone-music-quick-row" aria-label="角色歌快捷入口">
          <span class="phone-music-quick-label">路人女主</span>
          ${renderMusicQuickEntries(state.phoneCharacterId)}
        </div>
        ${resultsBlock}
      </div>
    </section>
  `;
}

function renderDrawingPhonePage(state: AppState) {
  const settings = state.drawingSettings;
  const anchorRows = settings.characterAnchors.length
    ? settings.characterAnchors
        .map(
          anchor => `
            <article class="phone-drawing-anchor" data-drawing-anchor-id="${escapeHtml(anchor.id)}">
              <button class="phone-drawing-anchor__remove" data-action="drawing-remove-anchor" data-anchor-id="${escapeHtml(anchor.id)}" aria-label="删除角色">×</button>
              <input
                class="phone-drawing-input"
                data-field="drawing-anchor-name"
                value="${escapeHtml(anchor.name)}"
                placeholder="角色名，例如 英梨梨"
              />
              <textarea
                class="phone-drawing-textarea phone-drawing-textarea--small"
                data-field="drawing-anchor-prompt"
                placeholder="固定外貌标签，例如 blonde twintails, blue eyes, petite body"
              >${escapeHtml(anchor.prompt)}</textarea>
            </article>
          `,
        )
        .join('')
    : '<div class="phone-drawing-empty">还没有固定角色外貌。</div>';
  const drawingControls = settings.enabled
    ? `
        <section class="phone-drawing-card">
          <label class="phone-drawing-label" for="drawing-manual-prompt">本次生图需求</label>
          <textarea
            id="drawing-manual-prompt"
            class="phone-drawing-textarea phone-drawing-textarea--manual"
            data-field="drawing-manual-prompt"
            placeholder="例如: 英梨梨在夕阳教室里脸红回头，轻小说插画风格"
          >${escapeHtml(settings.manualPrompt)}</textarea>
          <button class="phone-drawing-primary" data-action="drawing-generate-now" type="button">🎨 发送给智绘姬</button>
          <p class="phone-drawing-help">手动发送会使用下面的画风、宽高和角色锚定。</p>
        </section>

        <section class="phone-drawing-card">
          <label class="phone-drawing-label" for="drawing-quality-prompt">画风/质量提示词</label>
          <input
            id="drawing-quality-prompt"
            class="phone-drawing-input phone-drawing-input--large"
            data-field="drawing-quality-prompt"
            value="${escapeHtml(settings.qualityPrompt)}"
            placeholder="例如: masterpiece, anime style"
          />
          <p class="phone-drawing-help">这些词会自动添加到每次生图请求中。</p>
        </section>

        <section class="phone-drawing-card">
          <label class="phone-drawing-label" for="drawing-negative-prompt">负面提示词</label>
          <input
            id="drawing-negative-prompt"
            class="phone-drawing-input phone-drawing-input--large"
            data-field="drawing-negative-prompt"
            value="${escapeHtml(settings.negativePrompt)}"
            placeholder="例如: lowres, bad quality, worst quality"
          />
          <p class="phone-drawing-help">避免这些特征出现在生成的图片中。</p>
        </section>

        <section class="phone-drawing-card">
          <label class="phone-drawing-label" for="drawing-context-count">生图上下文层数: ${settings.contextMessageCount}</label>
          <input
            id="drawing-context-count"
            class="phone-drawing-range"
            data-field="drawing-context-count"
            type="range"
            min="0"
            max="20"
            step="1"
            value="${settings.contextMessageCount}"
          />
          <p class="phone-drawing-help">发送给生图 AI 的历史对话数量。</p>
        </section>

        <section class="phone-drawing-card">
          <div class="phone-drawing-grid">
            <label>
              <span class="phone-drawing-label">宽度</span>
              <input
                class="phone-drawing-input"
                data-field="drawing-width"
                type="number"
                min="256"
                max="2048"
                step="64"
                value="${settings.width}"
              />
            </label>
            <label>
              <span class="phone-drawing-label">高度</span>
              <input
                class="phone-drawing-input"
                data-field="drawing-height"
                type="number"
                min="256"
                max="2048"
                step="64"
                value="${settings.height}"
              />
            </label>
          </div>
          <p class="phone-drawing-help">默认竖图适合轻小说插画；实际尺寸由智绘姬后端模型决定。</p>
        </section>

        <section class="phone-drawing-card">
          <div class="phone-drawing-section-head">
            <strong>角色外貌锚定</strong>
            <small>确保同一角色在不同插图中外观一致。</small>
          </div>
          <div class="phone-drawing-anchor-list">
            ${anchorRows}
          </div>
          <button class="phone-drawing-link" data-action="drawing-add-anchor" type="button">+ 添加角色</button>
        </section>

        <section class="phone-drawing-card">
          <label class="phone-drawing-label" for="drawing-system-prompt">系统指令（高级）</label>
          <textarea
            id="drawing-system-prompt"
            class="phone-drawing-textarea"
            data-field="drawing-system-prompt"
            placeholder="可选：给生图识别器的额外规则"
          >${escapeHtml(settings.systemPrompt)}</textarea>
        </section>
      `
    : '';

  return `
    <section class="phone-route-page phone-app-page phone-app-page--drawing" data-phone-route-view="app:drawing">
      ${renderPhoneAppHeader(state, '独立生图', settings.enabled ? '已启用' : '未启用')}
      <div class="phone-page-scroll phone-drawing-scroll">
        <section class="phone-drawing-card">
          <label class="phone-drawing-toggle">
            <span>
              <strong>启用独立生图</strong>
              <small>需要安装智绘姬/生图插件；开启后剧情会自动递交插图请求</small>
            </span>
            <input type="checkbox" data-field="drawing-enabled" ${settings.enabled ? 'checked' : ''} />
          </label>
        </section>
        ${drawingControls}
      </div>
    </section>
  `;
}

function renderMemoryPhonePage(state: AppState) {
  const subtitle = state.memoryEditor.selectedTable === null
    ? ''
    : state.memoryEditor.selectedTable === '__trash'
      ? '回收站'
      : '';
  return `
    <section class="phone-route-page phone-app-page phone-app-page--memory" data-phone-route-view="app:memory">
      ${renderPhoneAppHeader(state, '记忆库', subtitle)}
      <div class="phone-page-scroll memory-phone-scroll">
        ${renderMemoryEditor(state)}
      </div>
    </section>
  `;
}

function renderPhoneRoute(state: AppState, renderers: PhoneRenderers) {
  if (state.phoneRoute === 'app:messages') return renderMessagesPhonePage(state);
  if (state.phoneRoute === 'app:chat') return renderPhoneChatPage(state);
  if (state.phoneRoute === 'app:calendar') return renderCalendarPhonePage(state);
  if (state.phoneRoute === 'app:summary') return renderSummaryPhonePage(state, renderers);
  if (state.phoneRoute === 'app:archive') return renderArchivePhonePage(state);
  if (state.phoneRoute === 'app:status') return renderStatusPhonePage(state, renderers);
  if (state.phoneRoute === 'app:inventory') return renderInventoryPhonePage(state.statusData, state, renderers);
  if (state.phoneRoute === 'app:memory') return renderMemoryPhonePage(state);
  if (state.phoneRoute === 'app:music') return renderMusicPhonePage(state);
  if (state.phoneRoute === 'app:drawing') return renderDrawingPhonePage(state);
  if (state.phoneRoute === 'app:settings') return renderSettingsPhonePage(state, renderers);
  return renderPhoneHome(state);
}

export function renderPhone(state: AppState, renderers: PhoneRenderers) {
  const selectedCharacter = getPhoneCharacterTheme(state.phoneCharacterId);
  const isGenerating = state.generating || state.phoneMessages.generating;
  const frameStyle = renderResponsivePhoneFrameStyle();
  return `
    <div class="phone-modal ${state.phoneOpen ? 'is-open' : ''} ${isGenerating ? 'generating' : ''}" aria-hidden="${state.phoneOpen ? 'false' : 'true'}">
      <button class="phone-backdrop" data-action="close-phone" aria-label="关闭手帐"></button>
      <section class="phone-shell" style="${frameStyle}">
        <div class="phone-notch"></div>
        <div
          class="phone-inner"
          style="--phone-wallpaper-url:url('${escapeHtml(selectedCharacter.wallpaperUrl)}');"
        >
          <header class="system-bar">
            <span class="system-time">${escapeHtml(formatTime(state.statusData.world.currentTime))}</span>
            <div class="system-icons">
              <span class="system-signal" aria-label="信号强度">
                <i></i><i></i><i></i><i></i>
              </span>
              <span>LTE</span>
              <span class="system-wifi" aria-label="Wi-Fi"></span>
              <span class="system-battery" aria-label="电量 76%">
                <span class="system-battery__level"></span>
              </span>
              <span>${escapeHtml(formatDate(state.statusData.world.currentTime))}</span>
            </div>
          </header>

          ${renderPhoneNotification(state.notification)}
          <div class="phone-screen">
            ${renderPhoneRoute(state, renderers)}
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
