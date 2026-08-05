import { getReaderMessages, getSummaryMessages } from '../message-format';
import type { AppState, MessageWindowState, UiMessage } from '../types';

export const EMPTY_MESSAGE_WINDOW: MessageWindowState = {
  startFloor: 0,
  endFloorExclusive: 0,
  startMessage: 0,
  endMessageExclusive: 0,
  totalFloorCount: 0,
  totalMessageCount: 0,
};

function natural(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function normalizeMessageWindow(input?: Partial<MessageWindowState> | null): MessageWindowState {
  const totalFloorCount = natural(input?.totalFloorCount);
  const totalMessageCount = natural(input?.totalMessageCount);
  const startFloor = Math.min(natural(input?.startFloor), totalFloorCount);
  const startMessage = Math.min(natural(input?.startMessage), totalMessageCount);
  return {
    startFloor,
    endFloorExclusive: Math.min(
      Math.max(startFloor, natural(input?.endFloorExclusive)),
      totalFloorCount,
    ),
    startMessage,
    endMessageExclusive: Math.min(
      Math.max(startMessage, natural(input?.endMessageExclusive)),
      totalMessageCount,
    ),
    totalFloorCount,
    totalMessageCount,
  };
}

export function createCompleteMessageWindow(messages: readonly UiMessage[]): MessageWindowState {
  const messageCount = getReaderMessages(messages as UiMessage[], true).length;
  return {
    startFloor: 0,
    endFloorExclusive: messageCount,
    startMessage: 0,
    endMessageExclusive: messageCount,
    totalFloorCount: messageCount,
    totalMessageCount: messageCount,
  };
}

export function isMessageWindowAtHead(window: MessageWindowState) {
  return window.endFloorExclusive >= window.totalFloorCount;
}

export function hasPreviousMessageWindow(window: MessageWindowState) {
  return window.startFloor > 0;
}

export function hasNextMessageWindow(window: MessageWindowState) {
  return window.endFloorExclusive < window.totalFloorCount;
}

export function toGlobalReaderIndex(state: Pick<AppState, 'messageWindow'>, localIndex: number) {
  return state.messageWindow.startMessage + Math.max(0, Math.floor(localIndex));
}

export function getRuntimeWindowMessageEnd(state: Pick<AppState, 'messageWindow' | 'uiMessages'>) {
  return state.messageWindow.startMessage + getReaderMessages(state.uiMessages).length;
}

export function getRuntimeWindowSummaryEnd(state: Pick<AppState, 'messageWindow' | 'uiMessages'>) {
  return state.messageWindow.startMessage + getSummaryMessages(state.uiMessages).length;
}

export function getGlobalReaderMessageCount(state: Pick<AppState, 'messageWindow' | 'uiMessages'>) {
  return isMessageWindowAtHead(state.messageWindow)
    ? Math.max(state.messageWindow.totalMessageCount, getRuntimeWindowMessageEnd(state))
    : state.messageWindow.totalMessageCount;
}

export function getGlobalSummaryMessageCount(state: Pick<AppState, 'messageWindow' | 'uiMessages'>) {
  return isMessageWindowAtHead(state.messageWindow)
    ? Math.max(state.messageWindow.totalMessageCount, getRuntimeWindowSummaryEnd(state))
    : state.messageWindow.totalMessageCount;
}

export function updateMessageWindowAfterCommit(
  state: Pick<AppState, 'messageWindow' | 'uiMessages'>,
  receipt: { floorCount: number; messageCount: number },
) {
  if (!isMessageWindowAtHead(state.messageWindow)) return;
  const totalFloorCount = natural(receipt.floorCount);
  const totalMessageCount = natural(receipt.messageCount);
  state.messageWindow = {
    ...state.messageWindow,
    endFloorExclusive: totalFloorCount,
    endMessageExclusive: totalMessageCount,
    totalFloorCount,
    totalMessageCount,
  };
}
