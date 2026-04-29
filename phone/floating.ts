import type { AppState } from '../types';
import type { FloatingPhonePosition, PhoneRoute } from './types';
import { clamp } from '../variables/normalize';

const FLOATING_PHONE_STORAGE_KEY = 'islandmilfcode-floating-phone-position-v3';
const FLOATING_PHONE_CUSTOMIZED_KEY = 'islandmilfcode-floating-phone-customized-v3';
const FLOATING_PHONE_EDGE_GAP = 18;
const FLOATING_PHONE_DRAG_THRESHOLD = 6;

let dragState: {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
} | null = null;

let suppressFloatingPhoneClick = false;

function getFloatingPhoneSize() {
  const isCompact = window.innerWidth <= 720;
  return {
    width: isCompact ? 84 : 82,
    height: isCompact ? 98 : 96,
    edgeGap: isCompact ? 12 : FLOATING_PHONE_EDGE_GAP,
  };
}

export function clampFloatingPhonePosition(position: FloatingPhonePosition): FloatingPhonePosition {
  const { width, height, edgeGap } = getFloatingPhoneSize();
  const maxX = Math.max(edgeGap, window.innerWidth - width - edgeGap);
  const maxY = Math.max(edgeGap, window.innerHeight - height - edgeGap);
  return {
    x: clamp(position.x, edgeGap, maxX),
    y: clamp(position.y, edgeGap, maxY),
  };
}

export function getDefaultFloatingPhonePosition(): FloatingPhonePosition {
  const { width, height, edgeGap } = getFloatingPhoneSize();
  return clampFloatingPhonePosition({
    x: window.innerWidth - width - edgeGap,
    y: window.innerHeight * 0.5 - height * 0.5,
  });
}

export function loadFloatingPhonePosition(): FloatingPhonePosition {
  try {
    const customized = window.localStorage.getItem(FLOATING_PHONE_CUSTOMIZED_KEY) === '1';
    if (!customized) return getDefaultFloatingPhonePosition();
    const raw = window.localStorage.getItem(FLOATING_PHONE_STORAGE_KEY);
    if (!raw) return getDefaultFloatingPhonePosition();
    const parsed = JSON.parse(raw) as Partial<FloatingPhonePosition>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
      return getDefaultFloatingPhonePosition();
    }
    return clampFloatingPhonePosition({ x: parsed.x, y: parsed.y });
  } catch {
    return getDefaultFloatingPhonePosition();
  }
}

function persistFloatingPhonePosition(position: FloatingPhonePosition) {
  try {
    window.localStorage.setItem(FLOATING_PHONE_STORAGE_KEY, JSON.stringify(position));
  } catch {
    /* ignore */
  }
}

function markFloatingPhoneCustomized() {
  try {
    window.localStorage.setItem(FLOATING_PHONE_CUSTOMIZED_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function hasCustomizedFloatingPhonePosition() {
  try {
    return window.localStorage.getItem(FLOATING_PHONE_CUSTOMIZED_KEY) === '1';
  } catch {
    return false;
  }
}

function applyFloatingPhonePosition(button: HTMLElement, position: FloatingPhonePosition) {
  button.style.left = `${position.x}px`;
  button.style.top = `${position.y}px`;
}

export function bindFloatingPhoneEvents(
  root: HTMLElement | null,
  state: AppState,
  openPhone: (targetRoute?: PhoneRoute) => void,
) {
  const button = root?.querySelector<HTMLButtonElement>('[data-action="open-phone"]');
  if (!button) return;
  applyFloatingPhonePosition(button, state.floatingPhone);

  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: state.floatingPhone.x,
      originY: state.floatingPhone.y,
      moved: false,
    };
    suppressFloatingPhoneClick = false;
    button.setPointerCapture(event.pointerId);
    button.classList.add('is-dragging');
    document.body.classList.add('floating-phone-dragging');
  });

  button.addEventListener('pointermove', event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.abs(dx) > FLOATING_PHONE_DRAG_THRESHOLD || Math.abs(dy) > FLOATING_PHONE_DRAG_THRESHOLD) {
      dragState.moved = true;
    }
    if (!dragState.moved) return;
    state.floatingPhone = clampFloatingPhonePosition({ x: dragState.originX + dx, y: dragState.originY + dy });
    applyFloatingPhonePosition(button, state.floatingPhone);
  });

  const finishDrag = (event: PointerEvent) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
    button.classList.remove('is-dragging');
    document.body.classList.remove('floating-phone-dragging');
    if (dragState.moved) {
      markFloatingPhoneCustomized();
      persistFloatingPhonePosition(state.floatingPhone);
      suppressFloatingPhoneClick = true;
    }
    dragState = null;
  };
  button.addEventListener('pointerup', finishDrag);
  button.addEventListener('pointercancel', finishDrag);

  button.addEventListener('click', event => {
    if (suppressFloatingPhoneClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressFloatingPhoneClick = false;
      return;
    }
    openPhone();
  });
}

export function syncFloatingPhoneAfterResize(state: AppState) {
  state.floatingPhone = hasCustomizedFloatingPhonePosition()
    ? clampFloatingPhonePosition(state.floatingPhone)
    : getDefaultFloatingPhonePosition();
  if (hasCustomizedFloatingPhonePosition()) persistFloatingPhonePosition(state.floatingPhone);
}
