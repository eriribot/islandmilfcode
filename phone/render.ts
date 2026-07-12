import { escapeHtml } from '../html';
import { renderMemoryEditor } from '../memorydatabase/editor';
import type { IslandMemoryDB } from '../memorydatabase/types';
import { getReaderMessages } from '../message-format';
import {
  GAME_DEVELOPMENT_ACTIONS,
  GAME_DEVELOPMENT_DAYS,
  getGameDevelopmentActions,
  isGameDevelopmentRouteChoice,
  isGameDevelopmentWeekReady,
  readGameDevelopmentState,
  type GameDevelopmentProject,
} from '../game-development';
import {
  buildPlotRoutingContext,
  getPlotMachine,
  isPlotRouteReviewEnabled,
  readActivePlotFlagSnapshots,
  type PlotFlagDefinition,
  type PlotFlagSnapshot,
  type PlotMachineDefinition,
  type PlotRouteEligibility,
  type PlotRouteFamilyId,
  type PlotRouteVariantId,
} from '../plot-state-machine';
import { isV07RouteChoiceRequired } from '../plot-state-machine/choice';
import type {
  AppState,
  NotificationState,
  PhoneChatThread,
  PhoneMessageStore,
  PlotEventCard,
  StatusData,
  TargetStatus,
} from '../types';
import { formatDate, formatTime } from '../variables/normalize';
import { renderCharacterArchivePanel } from './archive';
import { getPhoneHomePageItems } from './home-pagination';
import { CHARACTER_QUICK_SEARCH, formatPlaybackTime } from './music';
import type { FloatingPhonePosition, MusicTrack, PhoneCharacterId, PhoneRoute, PhoneThemeCharacterId } from './types';
import { isPlayerPhonePseudoTarget } from './types';

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
      wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_sayuri.png',
      bgmUrl: '',
    };
  }
  if (characterId === 'sonoko') {
    return {
      label: '町田苑子',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Sonoko_phone.png',
      wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_sayuri.png',
      bgmUrl: '',
    };
  }
  if (characterId === 'akane') {
    return {
      label: '高坂茜',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Akane_phone.png',
      wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_akane.jpg',
      bgmUrl: '',
    };
  }
  if (characterId === 'shoko') {
    return {
      label: '西宫硝子',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/shoko_phone.jpg',
      wallpaperUrl: 'https://eriribot.github.io/islandmilfcode/picresource/bizhi_shoko.jpg',
      bgmUrl: '',
    };
  }
  return PHONE_CHARACTER_THEMES[characterId] ?? PHONE_CHARACTER_THEMES.megumi;
}

export type PhoneRenderers = {
  renderInventoryPanel: (statusData: StatusData, memoryDB?: IslandMemoryDB) => string;
  renderPaperWorkspace: (state: AppState, flipDir?: string, options?: { embedded?: boolean }) => string;
  renderStatusPanel: (state: AppState) => string;
  renderSummaryConfigSection: (state: AppState) => string;
  renderSummaryPanel: (state: AppState) => string;
};

function renderPhoneNotification(notification: NotificationState | null) {
  if (!notification) return '';
  const appLabel = notification.kind === 'status' ? '剧情系统' : '新消息';
  const icon = notification.kind === 'status' ? '!' : '💬';

  return `
    <button class="ios-notification" data-action="open-notification" aria-label="${escapeHtml(`${notification.title}：${notification.preview}`)}">
      <div class="ios-notification-app">
        <span class="ios-notification-icon">${icon}</span>
        <span>${escapeHtml(appLabel)}</span>
        <span class="ios-notification-time">${escapeHtml(notification.timestamp)}</span>
      </div>
      <div class="ios-notification-title-row">
        <strong>${escapeHtml(notification.title)}</strong>
        <span class="ios-notification-pill">查看</span>
      </div>
      <p class="ios-notification-preview">${escapeHtml(notification.preview)}</p>
    </button>
  `;
}

function renderFloatingPhoneStyle(position: FloatingPhonePosition) {
  return `left:${position.x}px;top:${position.y}px;`;
}

function getRenderedPhoneMessageStore(state: AppState): PhoneMessageStore {
  const readerMessages = getReaderMessages(state.uiMessages);
  const latestFloorIndex = Math.max(readerMessages.length - 1, 0);
  const focusedFloorIndex = Math.max(0, Math.min(state.focusedMessageIndex, latestFloorIndex));

  if (focusedFloorIndex >= latestFloorIndex) {
    return state.phoneMessages;
  }

  const threads: PhoneMessageStore['threads'] = {};
  for (const [targetId, thread] of Object.entries(state.phoneMessages.threads)) {
    const messages = thread.messages.filter(message => {
      if (typeof message.floorIndex !== 'number') return true;
      return message.floorIndex <= focusedFloorIndex;
    });
    threads[targetId] = {
      ...thread,
      messages,
      unread: Math.min(thread.unread, messages.length),
    };
  }

  return {
    ...state.phoneMessages,
    threads,
  };
}

function renderResponsivePhoneFrameStyle() {
  if (typeof window === 'undefined') return '';

  const viewportWidth = Math.max(0, window.innerWidth || 0);
  const viewportHeight = Math.max(0, window.innerHeight || 0);
  const modalPad =
    viewportWidth <= 720 ? 8 : Math.max(6, Math.min(24, Math.min(viewportWidth, viewportHeight) * 0.024));
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
  const homeAvatarSize = Math.floor(Math.max(48, Math.min(70, Math.min(width * 0.21, height * 0.11))));
  const characterOptionSize = Math.floor(Math.max(20, Math.min(28, width * 0.075)));
  const chatAvatarSize = Math.floor(Math.max(34, Math.min(42, width * 0.12)));
  const embeddedReaderHeight = Math.floor(Math.max(168, Math.min(280, height * 0.34)));
  const embeddedIllustrationHeight = Math.floor(Math.max(150, Math.min(260, height * 0.3)));
  return [
    `--phone-shell-width:${width}px`,
    `--phone-shell-height:${height}px`,
    `--phone-home-avatar-size:${homeAvatarSize}px`,
    `--phone-character-option-size:${characterOptionSize}px`,
    `--phone-chat-avatar-size:${chatAvatarSize}px`,
    `--phone-reader-body-height:${embeddedReaderHeight}px`,
    `--phone-illustration-max-height:${embeddedIllustrationHeight}px`,
  ].join(';');
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
  const subText = currentTrack ? `${currentTrack.artist}${currentTrack.album ? ' · ' + currentTrack.album : ''}` : ' ';

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
  const playerMeta = state.playerProfile.schoolIdentityLabel || state.playerProfile.className || state.playerProfile.gender || '主角档案';
  const selectedCharacter = getPhoneCharacterTheme(state.phoneCharacterId);
  const characterRows = [PHONE_CHARACTER_ORDER.slice(0, 3), PHONE_CHARACTER_ORDER.slice(3)];
  const phoneThreadCount = Object.values(state.phoneMessages.threads).filter(thread => thread.messages.length).length;
  const summaryCount =
    state.summaryStore.minor.length + state.summaryStore.major.length + (state.summaryStore.global ? 1 : 0);
  const inventoryCount = getPhoneInventoryCount(state);
  const studioMeta = getV07StudioHomeMeta(state);
  const gameDevelopmentMeta = getGameDevelopmentHomeMeta(state);
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
      route: 'app:studio',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIxMCIgZmlsbD0iIzQ4NmI2ZSIvPjxwYXRoIGZpbGw9IiNjMjhhNTgiIGQ9Ik0wIDMxIDQ4IDl2MzlIMHoiLz48cGF0aCBmaWxsPSIjZmZmN2ViIiBkPSJNMTMgMTJoMTZjNSAwIDkgMy42IDkgOC4zcy00IDguMi05IDguMmgtOVYzNmgtN3ptNyA2djQuNWg4LjdjMS40IDAgMi40LS45IDIuNC0yLjJTMzAuMSAxOCAyOC43IDE4eiIvPjxwYXRoIGZpbGw9IiNmZmY3ZWIiIG9wYWNpdHk9Ii43NSIgZD0iTTEyIDQwaDI0djNIMTJ6Ii8+PC9zdmc+',
      iconType: 'image',
      label: '企划',
      meta: studioMeta,
    },
    {
      route: 'app:game-development',
      icon: '🎮',
      label: '开发',
      meta: gameDevelopmentMeta,
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
    ...(state.deepSeekModeEnabled
      ? [
          {
            route: 'app:deepseek-web' as PhoneRoute,
            icon: 'https://img.icons8.com/color/512/deepseek.png',
            iconType: 'image' as const,
            label: '联网',
            meta: 'DeepSeek 插件',
          },
        ]
      : []),
    {
      route: 'app:settings',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBmaWxsPSIjNjA3ZDhiIiBkPSJNMzkuNiAyNy4yYy4xLS43LjItMS40LjItMi4ycy0uMS0xLjUtLjItMi4ybDQuNS0zLjJjLjQtLjMuNi0uOS4zLTEuNEw0MCAxMC44Yy0uMy0uNS0uOC0uNy0xLjMtLjRsLTUgMi4zYy0xLjItLjktMi40LTEuNi0zLjgtMi4yTDI5LjQgNWMtLjEtLjUtLjUtLjktMS0uOWgtOC42Yy0uNSAwLTEgLjQtMSAuOWwtLjUgNS41Yy0xLjQuNi0yLjcgMS4zLTMuOCAyLjJsLTUtMi4zYy0uNS0uMi0xLjEgMC0xLjMuNGwtNC4zIDcuNGMtLjMuNS0uMSAxLjEuMyAxLjRsNC41IDMuMmMtLjEuNy0uMiAxLjQtLjIgMi4ycy4xIDEuNS4yIDIuMkw0IDMwLjRjLS40LjMtLjYuOS0uMyAxLjRMOCAzOS4yYy4zLjUuOC43IDEuMy40bDUtMi4zYzEuMi45IDIuNCAxLjYgMy44IDIuMmwuNSA1LjVjLjEuNS41LjkgMSAuOWg4LjZjLjUgMCAxLS40IDEtLjlsLjUtNS41YzEuNC0uNiAyLjctMS4zIDMuOC0yLjJsNSAyLjNjLjUuMiAxLjEgMCAxLjMtLjRsNC4zLTcuNGMuMy0uNS4xLTEuMS0uMy0xLjR6TTI0IDM1Yy01LjUgMC0xMC00LjUtMTAtMTBzNC41LTEwIDEwLTEwczEwIDQuNSAxMCAxMHMtNC41IDEwLTEwIDEwIi8+PHBhdGggZmlsbD0iIzQ1NWE2NCIgZD0iTTI0IDEzYy02LjYgMC0xMiA1LjQtMTIgMTJzNS40IDEyIDEyIDEyczEyLTUuNCAxMi0xMnMtNS40LTEyLTEyLTEybTAgMTdjLTIuOCAwLTUtMi4yLTUtNXMyLjItNSA1LTVzNSAyLjIgNSA1cy0yLjIgNS01IDUiLz48L3N2Zz4=',
      iconType: 'image',
      label: '设置',
      meta: state.activeSaveId ? '已连接存档' : '未保存',
    },
  ];
  const dockApps = apps.filter(app => app.dock);
  const homePage = getPhoneHomePageItems(apps, state.phoneHomePage);
  const homePages = Array.from({ length: homePage.pageCount }, (_, pageIndex) =>
    getPhoneHomePageItems(apps, pageIndex),
  );

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

      <div
        class="phone-app-viewport"
        data-phone-home-swipe
        data-phone-home-page-count="${homePage.pageCount}"
        data-phone-home-active-page="${homePage.activePage}"
        style="--phone-home-page:${homePage.activePage};"
      >
        <div class="phone-app-track">
          ${homePages
            .map(page => {
              const isActivePage = page.activePage === homePage.activePage;
              return `
                <div
                  class="phone-app-grid"
                  data-phone-home-page-panel="${page.activePage}"
                  aria-label="应用第 ${page.activePage + 1} 页，共 ${page.pageCount} 页"
                  aria-hidden="${isActivePage ? 'false' : 'true'}"
                  ${isActivePage ? '' : 'inert'}
                >
                  ${page.items
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
              `;
            })
            .join('')}
        </div>
      </div>

      <nav class="phone-home-pagination" aria-label="桌面分页">
        ${Array.from({ length: homePage.pageCount }, (_, pageIndex) => {
          const isActive = pageIndex === homePage.activePage;
          return `
            <button
              type="button"
              class="phone-home-page-dot ${isActive ? 'is-active' : ''}"
              data-action="phone-home-page"
              data-phone-home-page="${pageIndex}"
              aria-label="前往桌面第 ${pageIndex + 1} 页"
              ${isActive ? 'aria-current="page"' : ''}
            ></button>
          `;
        }).join('')}
      </nav>

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
  content: string;
  date: string;
  endDate: string;
  timeSegments: string[];
  locations: string[];
  summary: string;
  status: string;
  sourceEntryName: string;
  sourceEntryUid: number;
  volumeId: string;
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatIsoDateKey(year: number, monthIndex: number, day: number) {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function isCalendarDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function safeCalendarText(value: unknown, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function safeCalendarTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => safeCalendarText(item).trim()).filter(Boolean) : [];
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
  const date = isCalendarDateKey(event.schedule.date) ? event.schedule.date : '2012-03-31';
  const endDate =
    isCalendarDateKey(event.schedule.endDate) && event.schedule.endDate >= date ? event.schedule.endDate : date;
  const id = safeCalendarText(event.id, 'unknown-event');
  return {
    id,
    title: safeCalendarText(event.title, id) || id,
    content: safeCalendarText(event.content),
    date,
    endDate,
    timeSegments: safeCalendarTextArray(event.schedule.timeSegments),
    locations: safeCalendarTextArray(event.schedule.locations),
    summary: safeCalendarText(event.summary),
    status: safeCalendarText(statusData.world.mainEvents?.[event.id]),
    sourceEntryName: safeCalendarText(event.sourceEntryName),
    sourceEntryUid: Number.isFinite(event.sourceEntryUid) ? event.sourceEntryUid : 0,
    volumeId: safeCalendarText(event.volumeId),
  };
}

function collectCalendarEvents(state: AppState): CalendarEventItem[] {
  return Object.values(state.plotLibrary.events)
    .filter((event): event is PlotEventCard & { schedule: NonNullable<PlotEventCard['schedule']> } =>
      isCalendarDateKey(event.schedule?.date),
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
    .map(
      (event, index) =>
        `<span class="phone-calendar__dot phone-calendar__dot--${index + 1}" title="${escapeHtml(event.title)}"></span>`,
    )
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
    <article
      class="phone-calendar-event phone-calendar-event--${statusClass}"
      data-action="calendar-open-event"
      data-event-id="${escapeHtml(event.id)}"
      role="button"
      tabindex="0"
    >
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

function renderCalendarDetailRow(label: string, value: string) {
  const text = value.trim();
  if (!text) return '';
  return `
    <div class="phone-calendar-popup__detail">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(text)}</strong>
    </div>
  `;
}

function renderCalendarEventPopup(state: AppState) {
  if (!calendarOpenEventId) return '';
  const event = collectCalendarEvents(state).find(item => item.id === calendarOpenEventId);
  if (!event) return '';

  const statusLabel = getCalendarStatusLabel(event.status);
  const timeLine = [formatCalendarDateRange(event), event.timeSegments.join(' / ')].filter(Boolean).join(' · ');
  const locationLine = event.locations.join('、');
  const sourceLine = [event.sourceEntryName, event.sourceEntryUid ? `#${event.sourceEntryUid}` : '']
    .filter(Boolean)
    .join(' ');
  const bodyText = event.content || event.summary || '（无详细正文）';

  return `
    <div class="phone-calendar-popup" role="dialog" aria-modal="true" aria-label="${escapeHtml(event.title)}">
      <button class="phone-calendar-popup__backdrop" data-action="calendar-close-event" type="button" aria-label="关闭"></button>
      <article class="phone-calendar-popup__panel">
        <header class="phone-calendar-popup__header">
          <div>
            <small>${escapeHtml(statusLabel)}</small>
            <h3>${escapeHtml(event.title)}</h3>
          </div>
          <button class="phone-calendar-popup__close" data-action="calendar-close-event" type="button" aria-label="关闭">×</button>
        </header>
        <div class="phone-calendar-popup__details">
          ${renderCalendarDetailRow('时间', timeLine || event.id)}
          ${renderCalendarDetailRow('地点', locationLine)}
          ${renderCalendarDetailRow('事件 ID', event.id)}
          ${renderCalendarDetailRow('来源', sourceLine)}
          ${renderCalendarDetailRow('卷 ID', event.volumeId)}
        </div>
        ${
          event.summary
            ? `<section class="phone-calendar-popup__summary"><span>摘要</span><p>${escapeHtml(event.summary)}</p></section>`
            : ''
        }
        <section class="phone-calendar-popup__content">
          <span>正文</span>
          <p>${escapeHtml(bodyText)}</p>
        </section>
      </article>
    </div>
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
        : (eventMap.keys().next().value ?? monthStart);

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
let calendarOpenEventId: string | null = null;

export function setCalendarMonthOffset(offset: number) {
  calendarMonthOffset = offset;
}

export function getCalendarMonthOffset(): number {
  return calendarMonthOffset;
}

export function setCalendarSelectedDate(dateKey: string | null) {
  calendarSelectedDateKey = dateKey;
}

export function setCalendarOpenEventId(eventId: string | null) {
  calendarOpenEventId = eventId;
}

export function getCalendarOpenEventId(): string | null {
  return calendarOpenEventId;
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
  if (normalized) return normalized;
  const haystack = [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .map(value => String(value ?? '').toLowerCase())
    .join('\n');
  if (/西宫硝子|西宮硝子|西宫|西宮|硝子|shoko|shouko|nishimiya/.test(haystack)) {
    return 'https://eriribot.github.io/islandmilfcode/picresource/shoko_phone.jpg';
  }
  return '';
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
  const contactTargets = state.statusData.targets.filter(target => !isPlayerPhonePseudoTarget(target));
  const targetsById = new Map(contactTargets.map(target => [target.id, target]));
  const threads = Object.values(state.phoneMessages.threads)
    .filter(thread => thread.messages.length)
    .filter(thread => targetsById.has(thread.targetId))
    .sort((a, b) => b.updatedAt - a.updatedAt);

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
  if (!target || isPlayerPhonePseudoTarget(target)) {
    return renderMessagesPhonePage(state);
  }

  const thread = state.phoneMessages.threads[target.id];
  const messages = thread?.messages ?? [];
  // 正文生成期间锁住手机输入，防止后台手机生成抢占正文流式事件。
  const inputLocked = state.phoneMessages.generating || state.generating;
  const sendDisabled = state.generating && !state.phoneMessages.generating;

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
                        ${inputLocked ? 'disabled' : ''}
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
          ${inputLocked ? 'disabled' : ''}
        >${escapeHtml(state.phoneMessages.draft)}</textarea>
        <button
          class="phone-chat-send"
          ${state.phoneMessages.generating ? 'data-phone-cancel="1"' : ''}
          data-action="send-phone-message"
          data-target-id="${escapeHtml(target.id)}"
          ${sendDisabled ? 'disabled' : ''}
        >${state.phoneMessages.generating ? '取消' : '发送'}</button>
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
  const profileSubtitle = state.playerProfile.schoolIdentityLabel || state.playerProfile.className || state.playerProfile.gender || '';
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
  const inventoryCount = getPhoneInventoryCount(state);
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:inventory">
      ${renderPhoneAppHeader(state, '背包', `${inventoryCount} 件物品`)}
      ${renderers.renderInventoryPanel(statusData, state.memoryDB)}
    </section>
  `;
}

function getPhoneInventoryCount(state: AppState): number {
  const playerMemoryItems = state.memoryDB.items.filter(item => (item.ownerId ?? 'player') === 'player');
  if (!playerMemoryItems.length) return Object.keys(state.statusData.player.inventory).length;
  return playerMemoryItems.filter(item => !item.expired && (item.count ?? 0) > 0).length;
}

const V07_STUDIO_MACHINE_ID = 'v07';
const V07_STUDIO_UNLOCK_DATE = '2013-02-25';

const V07_STUDIO_GATE_LABELS: Record<string, string> = {
  '2013-02-25': '朱音压力',
  '2013-02-26': '第二作准备',
  '2013-03-01': '惠共同企划',
  '2013-03-04': '英梨梨、诗羽反击',
};

function getDatePart(value: string | undefined): string {
  return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

function isV07StudioUnlocked(state: AppState): boolean {
  const currentEventId = state.statusData.world.currentMainEventId ?? '';
  const currentDate = getDatePart(state.statusData.world.currentTime);
  return currentEventId.startsWith('SAE_07-') || currentDate >= V07_STUDIO_UNLOCK_DATE;
}

function getV07StudioSnapshots(state: AppState): Map<string, PlotFlagSnapshot> {
  return new Map(readActivePlotFlagSnapshots(state.memoryDB, V07_STUDIO_MACHINE_ID).map(snapshot => [snapshot.definition.id, snapshot]));
}

function getV07StudioHomeMeta(state: AppState): string {
  const machine = getPlotMachine(V07_STUDIO_MACHINE_ID);
  if (!machine) return '暂不可用';
  if (!isV07StudioUnlocked(state)) return '第七卷后开放';
  const resolution = buildPlotRoutingContext(state.statusData, state.memoryDB).v07.resolution;
  if (resolution.choice) return `已选${V07_FAMILY_LABELS[resolution.choice]}`;
  const required = isV07RouteChoiceRequired({
    currentTime: state.statusData.world.currentTime,
    currentMainEventId: state.statusData.world.currentMainEventId,
    mainEvents: state.statusData.world.mainEvents,
    hasChoice: false,
  });
  return required ? '等待你的决定' : '记录剧情倾向';
}

const V07_FAMILY_LABELS: Record<PlotRouteFamilyId, string> = {
  stay: '留下',
  akane: '朱音',
  solo: '单飞',
};

const V07_ROUTE_LABELS: Record<PlotRouteVariantId, string> = {
  stay_blackgold: '和英梨梨、诗羽一起留下',
  stay_user_only: '自己留下继续创作',
  akane_core: '加入朱音的团队',
  solo_user_exit: '自己离开并独立创作',
  solo_group_exit_except_tomoya: '和伙伴们一起离开',
};

const V07_FLAG_LABELS: Record<string, string> = {
  akane_pressure_seen: '你已察觉朱音带来的压力',
  akane_formal_offer_seen: '你已知道朱音的正式邀请',
  blackgold_shaken: '英梨梨和诗羽受到朱音吸引',
  akane_route_open: '你开始真正了解朱音',
  akane_repulsed: '朱音的挖角已经失败',
  second_project_seed_ready: '第二作已有可执行的初稿',
  eriri_high_battlefield_supported: '你支持英梨梨挑战更高目标',
  utaha_author_pride_supported: '你认可诗羽作为作者的坚持',
  megumi_coplanner: '惠已加入共同企划',
  blackgold_counterwill: '英梨梨和诗羽决定一起拒绝朱音',
  user_knows_counterwill: '你已经知道英梨梨和诗羽的决定',
  solo_route_open: '你已准备独立创作',
  user_stay_commitment_grounded: '你已经用实际行动决定留下',
  blackgold_not_staying_confirmed: '英梨梨和诗羽不会固定留下',
  user_stay_position_available: '你仍可以留在当前团队',
  user_exit_commitment_grounded: '你已经用实际行动决定离开',
  group_exit_without_tomoya_grounded: '伙伴们已经分别确认离开',
  group_exit_participant_snapshot_ready: '已经确认哪些伙伴会一起离开',
};

export function getV07RouteLabel(route: Pick<PlotRouteEligibility, 'id' | 'label'>): string {
  return V07_ROUTE_LABELS[route.id];
}

export function getV07FamilyLabel(familyId: PlotRouteFamilyId): string {
  return V07_FAMILY_LABELS[familyId];
}

export function getV07FlagLabel(flagId: string, machine: PlotMachineDefinition): string {
  return V07_FLAG_LABELS[flagId] ?? machine.flags.find(flag => flag.id === flagId)?.label ?? '未知剧情条件';
}

function renderStudioRoutePlanning(state: AppState) {
  const context = buildPlotRoutingContext(state.statusData, state.memoryDB);
  const { resolution } = context.v07;
  const choiceRequired = isV07RouteChoiceRequired({
    currentTime: context.evaluationTime,
    currentMainEventId: state.statusData.world.currentMainEventId,
    mainEvents: state.statusData.world.mainEvents,
    hasChoice: Boolean(resolution.choiceReceipt),
  });
  const selectedFamily = resolution.choice;

  const choiceSummary = selectedFamily
    ? `已选择：${V07_FAMILY_LABELS[selectedFamily]}`
    : choiceRequired
      ? '第七章已结束，请决定最终路线'
      : 'SAE_07-8 结束后由你亲自选择';

  return `
    <section class="phone-studio-route-planning">
      <header class="phone-studio-route-planning__head">
        <div>
          <span>选择最终路线</span>
          <strong>${escapeHtml(choiceSummary)}</strong>
        </div>
        <small>${resolution.choice ? '选择后只能通过楼层回退重选' : '剧情事实只作参考，不限制选择'}</small>
      </header>
      <div class="phone-studio-family-list">
        ${resolution.families
          .map(family => {
            const satisfied = family.satisfiedFlagIds.length;
            const total = satisfied + family.missingFlagIds.length;
            const isChosen = selectedFamily === family.id;
            const disabled = Boolean(selectedFamily) || !choiceRequired;
            const tendency = total ? `${satisfied}/${total} 项剧情倾向` : '暂无剧情倾向记录';
            return `
              <section class="phone-studio-family ${isChosen ? 'is-chosen' : ''}">
                <header>
                  <strong>${escapeHtml(V07_FAMILY_LABELS[family.id])}</strong>
                  <span>${escapeHtml(tendency)}</span>
                </header>
                <div class="phone-studio-family__progress" aria-label="${satisfied}/${total}">
                  <span style="width:${total ? Math.round((satisfied / total) * 100) : 0}%"></span>
                </div>
                <div class="phone-studio-variant-list">
                  <article class="phone-studio-variant ${isChosen ? 'is-chosen' : ''}">
                    <div>
                      <strong>${escapeHtml(V07_FAMILY_LABELS[family.id])}</strong>
                      <small>${family.id === 'stay' ? '剧情路线' : '剧情路线 · 开启对应游戏开发模式'}</small>
                    </div>
                    <p>${escapeHtml(
                      family.missingFlagIds.length
                        ? `此前剧情还有 ${family.missingFlagIds.length} 项倾向未记录，但不影响你的决定。`
                        : '此前剧情倾向记录完整；最终决定仍只属于玩家。',
                    )}</p>
                    <button
                      type="button"
                      data-action="confirm-v07-route"
                      data-route-family="${escapeHtml(family.id)}"
                      ${disabled ? 'disabled' : ''}
                    >${escapeHtml(isChosen ? '已选择' : choiceRequired ? '选择这条路线' : '等待第七章结束')}</button>
                  </article>
                </div>
              </section>
            `;
          })
          .join('')}
      </div>
      <p class="phone-studio-route-note">副 API、自由输入和剧情倾向都不能替你选线。SAE_07-8 结束后必须在这里亲自确认。</p>
    </section>
  `;
}

function renderStudioGatePreview(flags: readonly PlotFlagDefinition[]) {
  const dates = Array.from(new Set(flags.map(flag => flag.earliestDate)));
  return `
    <div class="phone-studio-preview-grid">
      ${dates
        .map(
          date => `
            <div class="phone-studio-preview-tile">
              <span>${escapeHtml(date)}</span>
              <strong>${escapeHtml(V07_STUDIO_GATE_LABELS[date] ?? '关键剧情')}</strong>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderStudioFlagRow(
  flag: PlotFlagDefinition,
  snapshot: PlotFlagSnapshot | undefined,
  currentDate: string,
  lockedByDate: boolean,
) {
  const className = [
    'phone-studio-flag',
    lockedByDate ? 'is-date-locked' : '',
    snapshot?.value === 'yes' ? 'is-yes' : '',
    snapshot?.value === 'no' ? 'is-no' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const statusText = lockedByDate
    ? '未到日期'
    : snapshot?.value === 'yes'
      ? '已满足'
      : snapshot?.value === 'no'
        ? '未满足'
        : '等待剧情推进';
  const conditionLabel = V07_FLAG_LABELS[flag.id] ?? flag.label;
  const detailText = lockedByDate
    ? `这项条件会在 ${flag.earliestDate} 后开始记录。`
    : snapshot?.value === 'yes'
      ? '当前剧情已经满足这项条件。'
      : snapshot?.value === 'no'
        ? '当前剧情还没有满足这项条件。'
        : '继续推进剧情后，这里的进度会自动更新。';

  return `
    <article class="${className}">
      <div class="phone-studio-flag__main">
        <strong>${escapeHtml(conditionLabel)}</strong>
        <span>剧情条件</span>
      </div>
      <div class="phone-studio-flag__state">
        <span>${escapeHtml(statusText)}</span>
        <small>开放：${escapeHtml(flag.earliestDate)}${currentDate ? ` · 当前：${escapeHtml(currentDate)}` : ''}</small>
      </div>
      <p>${escapeHtml(detailText)}</p>
    </article>
  `;
}

function renderStudioGateGroup(
  date: string,
  flags: readonly PlotFlagDefinition[],
  snapshots: Map<string, PlotFlagSnapshot>,
  currentDate: string,
) {
  const lockedByDate = !currentDate || currentDate < date;
  const groupClass = `phone-studio-group ${lockedByDate ? 'is-date-locked' : ''}`;
  return `
    <section class="${groupClass}">
      <header class="phone-studio-group__head">
        <span>${escapeHtml(date)}</span>
        <strong>${escapeHtml(V07_STUDIO_GATE_LABELS[date] ?? '关键剧情')}</strong>
      </header>
      <div class="phone-studio-flag-list">
        ${flags.map(flag => renderStudioFlagRow(flag, snapshots.get(flag.id), currentDate, lockedByDate)).join('')}
      </div>
    </section>
  `;
}

function renderStudioPhonePage(state: AppState) {
  const machine = getPlotMachine(V07_STUDIO_MACHINE_ID);
  if (!machine) return renderPhoneHome(state);

  const currentDate = getDatePart(state.statusData.world.currentTime);
  const unlocked = isV07StudioUnlocked(state);
  const snapshots = getV07StudioSnapshots(state);
  const activeYesCount = [...snapshots.values()].filter(snapshot => snapshot.value === 'yes').length;
  const grouped = machine.flags.reduce<Record<string, PlotFlagDefinition[]>>((acc, flag) => {
    (acc[flag.earliestDate] ??= []).push(flag);
    return acc;
  }, {});
  const gateDates = Object.keys(grouped).sort();

  if (!unlocked) {
    return `
      <section class="phone-route-page phone-app-page phone-app-page--studio is-locked" data-phone-route-view="app:studio">
        ${renderPhoneAppHeader(state, '企划', '第七卷路线预览')}
        <div class="phone-page-scroll phone-studio-scroll">
          <section class="phone-studio-lock">
            <div class="phone-studio-lock__mark" aria-hidden="true">
              <span class="phone-studio-lock__shackle"></span>
              <span class="phone-studio-lock__body"></span>
            </div>
            <div class="phone-studio-lock__copy">
              <strong>进入第七卷后开放</strong>
              <span>现在可以先查看关键剧情日期。</span>
            </div>
          </section>
          ${renderStudioGatePreview(machine.flags)}
          <section class="phone-studio-card phone-studio-card--dim">
            <span>当前时间</span>
            <strong>${escapeHtml(state.statusData.world.currentTime || '未记录')}</strong>
          </section>
        </div>
      </section>
    `;
  }

  return `
    <section class="phone-route-page phone-app-page phone-app-page--studio" data-phone-route-view="app:studio">
      ${renderPhoneAppHeader(state, '企划', '第七卷路线选择')}
      <div class="phone-page-scroll phone-studio-scroll">
        <section class="phone-studio-hero">
          <div>
            <span class="phone-studio-kicker">你的独立企划</span>
            <strong>第七卷路线选择</strong>
            <small>当前剧情日期：${escapeHtml(currentDate || '未记录')}</small>
          </div>
          <div class="phone-studio-score">
            <strong>${activeYesCount}</strong>
            <span>已满足</span>
          </div>
        </section>
        <section class="phone-studio-card">
          <span>路线进度</span>
          <strong>${activeYesCount}/${machine.flags.length} 项剧情条件已满足</strong>
        </section>
        ${renderStudioRoutePlanning(state)}
        ${gateDates.map(date => renderStudioGateGroup(date, grouped[date], snapshots, currentDate)).join('')}
      </div>
    </section>
  `;
}

const GAME_DEVELOPMENT_METRICS: Array<[keyof GameDevelopmentProject, string]> = [
  ['progress', '完成度'],
  ['fun', '好玩程度'],
  ['creativity', '创意'],
  ['writing', '剧本'],
  ['art', '美术'],
  ['code', '程序'],
  ['polish', '打磨度'],
  ['hype', '期待度'],
  ['bugs', '待修问题'],
  ['fatigue', '疲劳'],
];

function getGameDevelopmentHomeMeta(state: AppState): string {
  const context = buildPlotRoutingContext(state.statusData, state.memoryDB);
  const { resolution } = context.v07;
  if (!resolution.choiceReceipt) return '等待路线确认';
  if (!isGameDevelopmentRouteChoice(resolution.choiceReceipt)) return '当前路线未开启';
  const game = readGameDevelopmentState(state.memoryDB, resolution.choiceReceipt);
  return game.project.created ? `第 ${game.week} 周 · ${game.project.progress}%` : '等待建立项目';
}

function renderGameDevelopmentLock(state: AppState, reason: string) {
  return `
    <section class="phone-route-page phone-app-page phone-app-page--game-development" data-phone-route-view="app:game-development">
      ${renderPhoneAppHeader(state, '游戏开发', '尚未开放')}
      <div class="phone-page-scroll phone-game-development-scroll">
        <section class="phone-game-lock">
          <span aria-hidden="true">🎮</span>
          <strong>请先选择创作路线</strong>
          <p>${escapeHtml(reason)}</p>
          <button type="button" data-phone-route="app:studio">前往企划页</button>
        </section>
      </div>
    </section>
  `;
}

function renderGameDevelopmentProjectForm(state: AppState, routeLabel: string) {
  return `
    <section class="phone-route-page phone-app-page phone-app-page--game-development" data-phone-route-view="app:game-development">
      ${renderPhoneAppHeader(state, '游戏开发', routeLabel)}
      <div class="phone-page-scroll phone-game-development-scroll">
        <section class="phone-game-hero">
          <span>已选择创作路线</span>
          <strong>${escapeHtml(routeLabel)}</strong>
          <p>填写游戏信息并建立项目后，就可以安排周一到周末的开发计划。</p>
        </section>
        <section class="phone-game-project-form">
          <label>游戏名<input data-field="game-project-title" value="第二作" maxlength="40" /></label>
          <label>类型<input data-field="game-project-genre" value="青春创作文字冒险" maxlength="40" /></label>
          <label>主题<input data-field="game-project-theme" value="社团 / 创作者 / 关系修复" maxlength="80" /></label>
          <label>平台<input data-field="game-project-platform" value="电脑同人游戏" maxlength="40" /></label>
          <button type="button" data-action="game-create-project">建立项目</button>
        </section>
      </div>
    </section>
  `;
}

function renderGameDevelopmentPhonePage(state: AppState) {
  const context = buildPlotRoutingContext(state.statusData, state.memoryDB);
  const { resolution } = context.v07;
  const receipt = resolution.choiceReceipt;
  if (!receipt || resolution.choiceState !== 'chosen') {
    return renderGameDevelopmentLock(state, '先去企划页选择接下来的创作路线，确认后就能开始开发游戏。');
  }
  if (!isGameDevelopmentRouteChoice(receipt)) {
    return renderGameDevelopmentLock(state, '“留下”是剧情路线，不会自动开启单飞或朱音的游戏开发模式。');
  }

  const game = readGameDevelopmentState(state.memoryDB, receipt);
  const routeLabel = V07_FAMILY_LABELS[receipt.familyId];
  if (!game.project.created) return renderGameDevelopmentProjectForm(state, routeLabel);

  const selectedSlot = game.slots[game.selectedDay];
  const availableActions = getGameDevelopmentActions(game, selectedSlot.kind);
  const plannedCount = GAME_DEVELOPMENT_DAYS.filter(day => Boolean(game.slots[day.id].actionId)).length;
  const ready = isGameDevelopmentWeekReady(game);
  const targetOptions = [
    { id: '', label: selectedSlot.kind === 'weekend' ? '独处休整' : '独自推进' },
    ...state.statusData.targets
      .filter(target => !isPlayerPhonePseudoTarget(target))
      .map(target => ({ id: target.id, label: target.alias || target.name || '未命名角色' })),
  ];

  return `
    <section class="phone-route-page phone-app-page phone-app-page--game-development" data-phone-route-view="app:game-development">
      ${renderPhoneAppHeader(state, '游戏开发', routeLabel)}
      <div class="phone-page-scroll phone-game-development-scroll">
        <section class="phone-game-hero">
          <span>第 ${game.week} 周 · ${escapeHtml(game.project.phase)}</span>
          <strong>${escapeHtml(game.project.title)}</strong>
          <p>${escapeHtml(game.project.genre)} · ${escapeHtml(game.project.theme)} · ${escapeHtml(game.project.platform)}</p>
          <div><em>剩余 ${game.project.weeksLeft} 周</em><em>预算 ${game.project.budget}</em></div>
        </section>

        <section class="phone-game-metrics">
          ${GAME_DEVELOPMENT_METRICS.map(([key, label]) => {
            const value = Number(game.project[key]) || 0;
            return `<div><span>${label}</span><strong>${value}</strong><i><b style="width:${Math.max(0, Math.min(100, value))}%"></b></i></div>`;
          }).join('')}
        </section>

        <section class="phone-game-week">
          <header><span>本周计划</span><strong>${plannedCount}/6</strong></header>
          <div class="phone-game-days" role="tablist">
            ${GAME_DEVELOPMENT_DAYS.map(day => {
              const slot = game.slots[day.id];
              const action = GAME_DEVELOPMENT_ACTIONS.find(item => item.id === slot.actionId);
              return `
                <button
                  type="button"
                  data-action="game-select-day"
                  data-game-day="${day.id}"
                  class="${game.selectedDay === day.id ? 'is-selected' : ''} ${slot.actionId ? 'is-planned' : ''}"
                ><span>${day.label}</span><small>${escapeHtml(action?.label ?? '待安排')}</small></button>
              `;
            }).join('')}
          </div>
        </section>

        <section class="phone-game-slot-editor">
          <header>
            <span>${escapeHtml(selectedSlot.label)} · ${selectedSlot.kind === 'weekend' ? '周末行动' : '开发行动'}</span>
            <strong>${escapeHtml(GAME_DEVELOPMENT_ACTIONS.find(item => item.id === selectedSlot.actionId)?.label ?? '未安排')}</strong>
          </header>
          <div class="phone-game-actions">
            ${availableActions.map(action => `
              <button
                type="button"
                data-action="game-select-action"
                data-game-day="${selectedSlot.dayId}"
                data-game-action="${action.id}"
                class="${selectedSlot.actionId === action.id ? 'is-selected' : ''}"
              ><strong>${escapeHtml(action.label)}</strong><small>${escapeHtml(action.hint)}</small></button>
            `).join('')}
          </div>
          <label>
            和谁一起
            <select data-field="game-slot-target" data-game-day="${selectedSlot.dayId}" ${selectedSlot.actionId ? '' : 'disabled'}>
              ${targetOptions.map(target => `<option value="${escapeHtml(target.id)}" ${selectedSlot.targetId === target.id || (!selectedSlot.targetId && !target.id) ? 'selected' : ''}>${escapeHtml(target.label)}</option>`).join('')}
            </select>
          </label>
          <label>
            今天想完成什么
            <textarea data-field="game-slot-intent" data-game-day="${selectedSlot.dayId}" maxlength="240" ${selectedSlot.actionId ? '' : 'disabled'}>${escapeHtml(selectedSlot.intent)}</textarea>
          </label>
        </section>

        <section class="phone-game-summary">
          ${GAME_DEVELOPMENT_DAYS.map(day => {
            const slot = game.slots[day.id];
            const action = GAME_DEVELOPMENT_ACTIONS.find(item => item.id === slot.actionId);
            return `<div class="${slot.actionId ? 'is-planned' : ''}"><span>${day.label}</span><strong>${escapeHtml(action?.label ?? '待安排')}</strong></div>`;
          }).join('')}
          <button type="button" data-action="game-submit-week" ${ready ? '' : 'disabled'}>
            ${ready ? '完成本周计划' : `还有 ${6 - plannedCount} 天未安排`}
          </button>
        </section>

        ${game.lastSubmission ? `
          <details class="phone-game-last-submission">
            <summary>上周安排：第 ${game.lastSubmission.week} 周</summary>
            <div class="phone-game-last-submission__days">
              ${game.lastSubmission.slots
                .map(slot => {
                  const action = GAME_DEVELOPMENT_ACTIONS.find(item => item.id === slot.actionId);
                  const target = state.statusData.targets.find(item => item.id === slot.targetId);
                  const partner =
                    target?.alias ||
                    target?.name ||
                    (slot.targetId ? '未识别角色' : slot.kind === 'weekend' ? '独处休整' : '独自推进');
                  return `<div><span>${escapeHtml(slot.label)}</span><strong>${escapeHtml(action?.label ?? '未记录')}</strong><small>${escapeHtml(partner)}</small></div>`;
                })
                .join('')}
            </div>
          </details>
        ` : ''}
      </div>
    </section>
  `;
}

function renderSettingsPhonePage(state: AppState, renderers: PhoneRenderers) {
  const plotRouteReviewEnabled = isPlotRouteReviewEnabled(state.runtimeFlags);
  return `
    <section class="phone-route-page phone-app-page" data-phone-route-view="app:settings">
      ${renderPhoneAppHeader(state, '设置 / 保存', state.activeSaveId ? '存档已连接' : '未保存')}
      <section class="panel-card panel-card--generic">
        <div class="panel-title">操作</div>
        <div class="panel-scroll">
          <label class="phone-settings-toggle">
            <span>
              <strong>自动路线事实核对</strong>
              <small>正文完成后核对路线条件。关闭后仍会更新普通变量，但不会自动写入路线事实。</small>
            </span>
            <input
              type="checkbox"
              data-field="plot-route-review-enabled"
              ${plotRouteReviewEnabled ? 'checked' : ''}
              aria-label="自动路线事实核对"
            />
          </label>
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

function isMusicTrackCurrent(track: MusicTrack, activeTrack: MusicTrack | null | undefined): boolean {
  if (!activeTrack) return false;
  if (activeTrack.id !== track.id) return false;
  return activeTrack.source === track.source;
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
  return labels
    .map(
      item => `
    <button
      class="phone-music-quick ${item.id === currentCharacter ? 'is-current' : ''}"
      data-action="music-quick-search"
      data-character-id="${item.id}"
      data-quick-keyword="${escapeHtml(CHARACTER_QUICK_SEARCH[item.id])}"
      type="button"
    >${escapeHtml(item.label)}</button>
  `,
    )
    .join('');
}

function renderMusicPhonePage(state: AppState) {
  const { search, loadingTrackId } = state.musicPlayer;
  const activeTrack = state.musicPlayer.currentTrack;
  const subtitle = activeTrack ? `${activeTrack.name} · ${activeTrack.artist}` : '搜索想听的曲子';

  let resultsBlock = '';
  if (search.status === 'loading') {
    resultsBlock = '<div class="phone-music-empty">搜索中…</div>';
  } else if (search.status === 'error') {
    resultsBlock = `<div class="phone-music-empty phone-music-empty--error">${escapeHtml(search.error || '搜索失败')}</div>`;
  } else if (search.status === 'ready' && !search.results.length) {
    resultsBlock = '<div class="phone-music-empty">这个关键词没找到结果，换个词试试。</div>';
  } else if (search.status === 'ready') {
    resultsBlock = `<div class="phone-music-list">${search.results
      .map(track =>
        renderMusicTrackRow(
          track,
          isMusicTrackCurrent(track, activeTrack),
          loadingTrackId === track.id,
        ),
      )
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
  const subtitle =
    state.memoryEditor.selectedTable === null ? '' : state.memoryEditor.selectedTable === '__trash' ? '回收站' : '';
  return `
    <section class="phone-route-page phone-app-page phone-app-page--memory" data-phone-route-view="app:memory">
      ${renderPhoneAppHeader(state, '记忆库', subtitle)}
      <div class="phone-page-scroll memory-phone-scroll">
        ${renderMemoryEditor(state)}
      </div>
    </section>
  `;
}

function renderDeepSeekWebPhonePage(state: AppState) {
  if (!state.deepSeekModeEnabled) return renderPhoneHome(state);
  const webLookup =
    state.runtimeFlags.deepSeekWebLookup && typeof state.runtimeFlags.deepSeekWebLookup === 'object'
      ? (state.runtimeFlags.deepSeekWebLookup as Record<string, unknown>)
      : {};
  const webLookupEnabled = Boolean(webLookup.enabled);
  const searchSource = String(webLookup.searchSource || 'ddg');
  const ddgRegion = String(webLookup.searchDdgRegion || 'wt-wt');
  const timeoutMs = Math.max(1000, Math.min(30_000, Math.round(Number(webLookup.timeoutMs ?? 12_000) || 12_000)));
  const maxResults = Math.max(1, Math.min(8, Math.round(Number(webLookup.maxEvidencePacks ?? 4) || 4)));

  return `
    <section class="phone-route-page phone-app-page phone-app-page--deepseek-web" data-phone-route-view="app:deepseek-web">
      ${renderPhoneAppHeader(state, 'DeepSeek 联网', '正文校准')}
      <div class="phone-page-scroll phone-deepseek-scroll">
        <section class="phone-deepseek-card phone-deepseek-card--hero">
          <span class="phone-deepseek-logo" aria-hidden="true">DS</span>
          <div class="phone-deepseek-copy">
            <strong>联网插件</strong>
            <span>默认关闭，勾选后随正文校准</span>
          </div>
        </section>
        <section class="phone-deepseek-card">
          <div class="phone-deepseek-row">
            <span>模式状态</span>
            <strong>已启用</strong>
          </div>
          <div class="phone-deepseek-row">
            <span>路由可见性</span>
            <strong>仅 DS 模式</strong>
          </div>
          <div class="phone-deepseek-row">
            <span>正文随查</span>
            <strong>${webLookupEnabled ? '已启用' : '关闭'}</strong>
          </div>
        </section>
        <section class="phone-deepseek-card phone-deepseek-card--fan">
          <label class="phone-deepseek-toggle">
            <span>
              <strong>正文外貌/时间点校准</strong>
              <small>生成前直接用 DuckDuckGo 查公开网页，校准时间线、外貌和用户输入里的店名/地点等事实，不写世界书。</small>
            </span>
            <input type="checkbox" data-field="deepseek-web-enabled" ${webLookupEnabled ? 'checked' : ''} />
          </label>
        </section>
        <details class="phone-deepseek-card phone-deepseek-card--fan" open>
          <summary>正文搜索配置</summary>
          <div class="phone-deepseek-empty">DuckDuckGo 不用 API key。“百科优先”会按路人女主 Wiki、百度百科、萌娘百科的顺序找资料；查不到再换普通 DDG。</div>
          <div class="phone-deepseek-form">
            <label>
              <span>搜索范围</span>
              <select data-field="deepseek-web-search-source">
                <option value="ddg" ${searchSource === 'ddg' ? 'selected' : ''}>DuckDuckGo 全网</option>
                <option value="encyclopedia" ${searchSource === 'encyclopedia' ? 'selected' : ''}>路人女主Wiki/百度/萌娘优先</option>
              </select>
            </label>
            <label>
              <span>DDG 地区</span>
              <input data-field="deepseek-web-ddg-region" value="${escapeHtml(ddgRegion)}" placeholder="wt-wt / jp-jp / cn-zh" />
            </label>
            <label>
              <span>超时 ms</span>
              <input data-field="deepseek-web-timeout" type="number" min="1000" max="30000" step="1000" value="${timeoutMs}" />
            </label>
            <label>
              <span>结果数</span>
              <input data-field="deepseek-web-max-results" type="number" min="1" max="8" step="1" value="${maxResults}" />
            </label>
          </div>
        </details>
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
  if (state.phoneRoute === 'app:studio') return renderStudioPhonePage(state);
  if (state.phoneRoute === 'app:game-development') return renderGameDevelopmentPhonePage(state);
  if (state.phoneRoute === 'app:music') return renderMusicPhonePage(state);
  if (state.phoneRoute === 'app:drawing') return renderDrawingPhonePage(state);
  if (state.phoneRoute === 'app:deepseek-web') return renderDeepSeekWebPhonePage(state);
  if (state.phoneRoute === 'app:settings') return renderSettingsPhonePage(state, renderers);
  return renderPhoneHome(state);
}

export function renderPhone(state: AppState, renderers: PhoneRenderers) {
  const selectedCharacter = getPhoneCharacterTheme(state.phoneCharacterId);
  const isGenerating = state.generating || state.phoneMessages.generating;
  const frameStyle = renderResponsivePhoneFrameStyle();
  const renderedPhoneMessages = getRenderedPhoneMessageStore(state);
  const renderedState =
    renderedPhoneMessages === state.phoneMessages
      ? state
      : {
          ...state,
          phoneMessages: renderedPhoneMessages,
        };
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
            ${renderPhoneRoute(renderedState, renderers)}
          </div>
        </div>
      </section>
      ${state.phoneOpen ? renderCalendarEventPopup(renderedState) : ''}
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
