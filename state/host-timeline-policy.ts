import type { PersistedMessage, UiMessage } from '../types';

/**
 * IslandMilfCode owns one visible Tavern floor: the #0 iframe host.
 * Story messages live in the v3 archive and render only inside that iframe.
 */
export function usesRealHostTimeline(): boolean {
  return false;
}

export function detachHostTimelineIdentity<T extends UiMessage>(message: T): T {
  const { hostLocator: _hostLocator, tavernMessageId: _tavernMessageId, ...local } = message;
  return local as T;
}

export function detachPersistedHostTimelineIdentity<T extends PersistedMessage>(message: T): T {
  const { hostLocator: _hostLocator, ...local } = message;
  return local as T;
}
