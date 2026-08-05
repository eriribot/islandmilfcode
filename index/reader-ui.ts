import { getReaderMessages } from '../message-format';
import type { AppState } from '../types';
import { hasNextMessageWindow, hasPreviousMessageWindow } from '../state/message-window';

type ReaderState = Pick<AppState, 'focusedMessageIndex' | 'messageWindow' | 'uiMessages'>;

export type ReaderBodyScrollSnapshot = {
  readerIndex: number;
  scrollTop: number;
  wasAtBottom: boolean;
};

export function canFlipReader(state: ReaderState, direction: 'prev' | 'next') {
  const readerMessages = getReaderMessages(state.uiMessages);
  if (direction === 'prev') {
    return state.focusedMessageIndex > 0 || hasPreviousMessageWindow(state.messageWindow);
  }
  return state.focusedMessageIndex < readerMessages.length - 1 || hasNextMessageWindow(state.messageWindow);
}

export function resetReaderCardTransform(reader: HTMLElement) {
  const card = reader.querySelector<HTMLElement>('.reader-card');
  if (!card) return;
  card.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease';
  card.style.transform = '';
  card.style.opacity = '';
}

export function captureReaderBodyScroll(root: HTMLElement | null): ReaderBodyScrollSnapshot | null {
  const body = root?.querySelector<HTMLElement>('.reader-card__body');
  const card = body?.closest<HTMLElement>('.reader-card[data-reader-index]');
  const readerIndex = Number(card?.dataset.readerIndex);
  if (!body || !Number.isFinite(readerIndex)) return null;
  const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
  return {
    readerIndex,
    scrollTop: body.scrollTop,
    wasAtBottom: distanceFromBottom <= 24,
  };
}

export function restoreReaderBodyScroll(root: HTMLElement | null, snapshot: ReaderBodyScrollSnapshot | null) {
  if (!snapshot) return;
  const body = root?.querySelector<HTMLElement>(
    `.reader-card[data-reader-index="${snapshot.readerIndex}"] .reader-card__body`,
  );
  if (!body) return;
  const restore = () => {
    body.scrollTop = snapshot.wasAtBottom
      ? body.scrollHeight
      : Math.min(snapshot.scrollTop, Math.max(0, body.scrollHeight - body.clientHeight));
  };
  restore();
  window.requestAnimationFrame(restore);
}

export function resolveReaderIndex(state: ReaderState, readerIndex: number, readerId?: string | null) {
  if (readerId) {
    const byId = getReaderMessages(state.uiMessages).findIndex(message => message.id === readerId);
    if (byId >= 0) return byId;
  }
  if (Number.isFinite(readerIndex)) return readerIndex;
  return state.focusedMessageIndex;
}
