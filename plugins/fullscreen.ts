import type { AppState } from '../types';

const PAPER_FULLSCREEN_FLAG = 'paperWorkspaceFullscreen';
const HOST_STYLE_ATTR = 'data-islandmilfcode-fullscreen-host';
const HOST_STYLE_ID = 'islandmilfcode-paper-fullscreen-host-style';
const HOST_CHAIN_SELECTOR = '#chat, #sheld, .mes, .mes_block, .mes_text, .mes_text_display, .TH-render';

type HostStyleSnapshot = {
  element: HTMLElement;
  style: string | null;
};

let hostSnapshots: HostStyleSnapshot[] = [];
let injectedHostDocument: Document | null = null;

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

export function isPaperWorkspaceFullscreen(state: AppState) {
  return Boolean(state.runtimeFlags[PAPER_FULLSCREEN_FLAG]);
}

export function setPaperWorkspaceFullscreen(state: AppState, enabled: boolean) {
  const current = isPaperWorkspaceFullscreen(state);
  if (current === enabled) return false;
  state.runtimeFlags[PAPER_FULLSCREEN_FLAG] = enabled;
  syncPaperFullscreenHost(enabled);
  return true;
}

export function togglePaperWorkspaceFullscreen(state: AppState) {
  return setPaperWorkspaceFullscreen(state, !isPaperWorkspaceFullscreen(state));
}

export function isPaperFullscreenToggleShortcut(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isEditableTarget(event.target)) return false;
  return event.key.toLowerCase() === 'f';
}

export function renderPaperFullscreenButton(state: AppState) {
  const active = isPaperWorkspaceFullscreen(state);
  const label = active ? '退出全屏模式' : '进入全屏模式';
  const title = active ? '退出全屏模式 (Esc)' : '全屏模式 (F)';

  return `
    <button
      class="paper-fullscreen-btn ${active ? 'is-active' : ''}"
      data-action="toggle-paper-fullscreen"
      type="button"
      title="${title}"
      aria-label="${label}"
      aria-pressed="${active ? 'true' : 'false'}"
    >
      <span class="paper-fullscreen-btn__icon" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
      </span>
    </button>
  `;
}

function getFrameElement() {
  try {
    const frame = window.frameElement;
    return frame && frame.nodeType === Node.ELEMENT_NODE ? (frame as HTMLElement) : null;
  } catch {
    return null;
  }
}

function isTauriTavernHost() {
  const hasMarker = (value: unknown) => Boolean(value && typeof value === 'object');
  try {
    if (hasMarker((window as typeof window & { __TAURITAVERN__?: unknown }).__TAURITAVERN__)) return true;
  } catch {
    /* ignore */
  }
  try {
    if (window.parent && hasMarker((window.parent as typeof window & { __TAURITAVERN__?: unknown }).__TAURITAVERN__)) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function isMobileFullscreenHost() {
  try {
    if (window.matchMedia?.('(pointer: coarse), (max-width: 720px)').matches) return true;
  } catch {
    /* ignore */
  }
  return window.innerWidth <= 720;
}

function shouldUseConservativeHostStyles() {
  return isTauriTavernHost() || isMobileFullscreenHost();
}

function getDirectHostChain() {
  const scene = document.querySelector<HTMLElement>('.islandmilfcode-scene');
  if (!scene) return [];

  const chain: HTMLElement[] = [scene];
  let cursor = scene.parentElement;
  while (cursor && cursor !== document.body && chain.length < 6) {
    chain.push(cursor);
    const style = window.getComputedStyle(cursor);
    const isLikelyMessageHost =
      cursor.matches('.mes, .mes_block, .mes_text, .mes_text_display, .custom-content, .stscript') ||
      style.overflow !== 'visible' ||
      style.transform !== 'none' ||
      style.contain !== 'none' ||
      style.position !== 'static';
    if (isLikelyMessageHost && cursor.matches('.mes, .mes_block, .mes_text, .mes_text_display')) break;
    cursor = cursor.parentElement;
  }

  return chain;
}

function getHostChain() {
  const frame = getFrameElement();
  if (!frame) return getDirectHostChain();

  const conservativeHost = shouldUseConservativeHostStyles();
  const chain: HTMLElement[] = [frame];
  const parentDocument = frame.ownerDocument;

  parentDocument.querySelectorAll<HTMLElement>(HOST_CHAIN_SELECTOR).forEach(element => {
    if (conservativeHost && element.matches('#chat, #sheld')) return;
    if (element.contains(frame)) chain.push(element);
  });

  let cursor = frame.parentElement;
  while (cursor && cursor !== parentDocument.body && chain.length < 8) {
    const style = parentDocument.defaultView?.getComputedStyle(cursor);
    const isMessageWrapper = cursor.matches(
      '.mes, .mes_block, .mes_text, .mes_text_display, .custom-content, .stscript, .TH-render',
    );
    const isAllowedWrapper = !conservativeHost || isMessageWrapper;
    if (style && isAllowedWrapper && (style.overflow !== 'visible' || style.transform !== 'none' || style.position !== 'static')) {
      chain.push(cursor);
    }
    cursor = cursor.parentElement;
  }

  return Array.from(new Set(chain));
}

function snapshotHostStyles(elements: HTMLElement[]) {
  hostSnapshots = elements.map(element => ({
    element,
    style: element.getAttribute('style'),
  }));
}

function applyFullscreenHostStyles(elements: HTMLElement[]) {
  const hostDocument = elements[0]?.ownerDocument;
  injectFullscreenHostStyle(hostDocument);
  const frame = getFrameElement();
  const directFullscreenTarget = frame ? null : document.querySelector<HTMLElement>('.islandmilfcode-scene');
  const conservativeWrappers = shouldUseConservativeHostStyles();

  elements.forEach(element => {
    const isFrame = Boolean(frame && element === frame);
    const isDirectTarget = Boolean(directFullscreenTarget && element === directFullscreenTarget);
    element.setAttribute(HOST_STYLE_ATTR, isFrame ? 'frame' : 'wrapper');

    if (isFrame || isDirectTarget || !conservativeWrappers) {
      element.setAttribute(HOST_STYLE_ATTR, isFrame ? 'frame' : isDirectTarget ? 'direct' : 'host-fixed');
      Object.assign(element.style, {
        position: 'fixed',
        inset: '0',
        top: '0',
        right: '0',
        bottom: '0',
        left: '0',
        zIndex: isFrame ? '2147483646' : '2147483645',
        width: '100vw',
        height: '100dvh',
        maxWidth: '100vw',
        maxHeight: '100dvh',
        margin: '0',
        padding: '0',
        border: '0',
        borderRadius: '0',
        overflow: 'visible',
        transform: 'none',
        contain: 'none',
        display: 'block',
      });
      return;
    }

    Object.assign(element.style, {
      overflow: 'visible',
      transform: 'none',
      contain: 'none',
      filter: 'none',
      clipPath: 'none',
      zIndex: '2147483645',
    });

    if (window.getComputedStyle(element).position === 'static') {
      element.style.position = 'relative';
    }
  });
}

function restoreFullscreenHostStyles() {
  hostSnapshots.forEach(({ element, style }) => {
    if (style == null) {
      element.removeAttribute('style');
    } else {
      element.setAttribute('style', style);
    }
    element.removeAttribute(HOST_STYLE_ATTR);
  });
  hostSnapshots = [];
  removeFullscreenHostStyle();
  injectedHostDocument = null;
}

function injectFullscreenHostStyle(hostDocument: Document | undefined) {
  if (!hostDocument) return;
  if (injectedHostDocument === hostDocument && hostDocument.getElementById(HOST_STYLE_ID)) return;
  if (hostDocument.getElementById(HOST_STYLE_ID)) {
    injectedHostDocument = hostDocument;
    return;
  }

  const style = hostDocument.createElement('style');
  style.id = HOST_STYLE_ID;
  style.textContent = `
    [${HOST_STYLE_ATTR}="frame"],
    [${HOST_STYLE_ATTR}="direct"],
    [${HOST_STYLE_ATTR}="host-fixed"] {
      position: fixed !important;
      inset: 0 !important;
      top: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      left: 0 !important;
      z-index: 2147483646 !important;
      width: 100vw !important;
      height: 100dvh !important;
      max-width: 100vw !important;
      max-height: 100dvh !important;
      min-width: 100vw !important;
      min-height: 100dvh !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
      overflow: visible !important;
      transform: none !important;
      contain: none !important;
      display: block !important;
      box-sizing: border-box !important;
    }
    [${HOST_STYLE_ATTR}="direct"] {
      z-index: 2147483645 !important;
    }
    [${HOST_STYLE_ATTR}="host-fixed"] {
      z-index: 2147483645 !important;
    }
    [${HOST_STYLE_ATTR}="wrapper"] {
      overflow: visible !important;
      transform: none !important;
      contain: none !important;
      filter: none !important;
      clip-path: none !important;
      z-index: 2147483645 !important;
      box-sizing: border-box !important;
    }
  `;
  hostDocument.head.appendChild(style);
  injectedHostDocument = hostDocument;
}

function removeFullscreenHostStyle() {
  const documents = [document];
  try {
    const frame = getFrameElement();
    if (frame?.ownerDocument && frame.ownerDocument !== document) documents.push(frame.ownerDocument);
  } catch {
    /* ignore */
  }
  documents.forEach(doc => doc.getElementById(HOST_STYLE_ID)?.remove());
}

export function syncPaperFullscreenHost(enabled: boolean) {
  if (typeof window === 'undefined') return;

  if (!enabled) {
    restoreFullscreenHostStyles();
    document.documentElement.classList.remove('islandmilfcode-paper-fullscreen-root');
    document.body.classList.remove('islandmilfcode-paper-fullscreen-root');
    return;
  }

  document.documentElement.classList.add('islandmilfcode-paper-fullscreen-root');
  document.body.classList.add('islandmilfcode-paper-fullscreen-root');

  const hostChain = getHostChain();
  if (!hostChain.length) return;
  if (!hostSnapshots.length) snapshotHostStyles(hostChain);
  applyFullscreenHostStyles(hostChain);
}
