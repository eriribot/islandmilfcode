/**
 * Virtual host session manager for persistent shujuku provider overlay.
 * 
 * Core contract:
 * - Real Tavern host always sees exactly chat[0] (root assistant).
 * - 10 logical messages = 5 assistant turns.
 * - All ACU mutations commit only to Island archive, never to real host.
 * - Session lifecycle: open on archive enter, sync after generation, close on unload.
 */

import type { PersistedMessage } from '../types';

export type LogicalMessageIdentity = {
  /** Stable logical ID across archive revisions. */
  logicalId: string;
  /** Exchange ID groups user+assistant pair. */
  exchangeId: string;
  /** Role in the exchange. */
  role: 'user' | 'assistant';
  /** Original archive floor index (null for root). */
  floorIndex: number | null;
};

export type VirtualHostMessage = {
  identity: LogicalMessageIdentity;
  text: string;
  rawText?: string;
  speaker: string;
  pluginData?: Record<string, unknown>;
};

export type VirtualHostSession = {
  saveId: string;
  runId: string;
  isolationKey: string;
  /** Current session revision (monotonic). */
  revision: number;
  /** Complete timeline of logical messages. */
  timeline: VirtualHostMessage[];
  /** Root assistant message (always chat[0] in real host). */
  rootMessage: VirtualHostMessage | null;
  /** Pending mutations to flush back to archive. */
  pendingMutations: SessionMutation[];
  /** Session state. */
  state: 'open' | 'closed';
};

export type SessionMutation = {
  kind: 'update' | 'create' | 'delete';
  logicalId: string;
  message?: PersistedMessage;
  timestamp: number;
};

const activeSessions = new Map<string, VirtualHostSession>();

export function createVirtualHostSession(input: {
  saveId: string;
  runId: string;
  isolationKey: string;
  timeline: VirtualHostMessage[];
  rootMessage: VirtualHostMessage | null;
}): VirtualHostSession {
  const sessionKey = `${input.saveId}:${input.runId}`;
  if (activeSessions.has(sessionKey)) {
    throw new Error(`Virtual host session already exists: ${sessionKey}`);
  }
  const session: VirtualHostSession = {
    saveId: input.saveId,
    runId: input.runId,
    isolationKey: input.isolationKey,
    revision: 0,
    timeline: input.timeline,
    rootMessage: input.rootMessage,
    pendingMutations: [],
    state: 'open',
  };
  activeSessions.set(sessionKey, session);
  return session;
}

export function getVirtualHostSession(saveId: string, runId: string): VirtualHostSession | null {
  const sessionKey = `${saveId}:${runId}`;
  return activeSessions.get(sessionKey) ?? null;
}

export function updateVirtualHostSession(
  saveId: string,
  runId: string,
  updates: {
    timeline?: VirtualHostMessage[];
    pendingMutations?: SessionMutation[];
    revision?: number;
  },
): void {
  const session = getVirtualHostSession(saveId, runId);
  if (!session) throw new Error(`Virtual host session not found: ${saveId}:${runId}`);
  if (session.state === 'closed') throw new Error(`Virtual host session already closed: ${saveId}:${runId}`);
  if (updates.timeline) session.timeline = updates.timeline;
  if (updates.pendingMutations) session.pendingMutations = updates.pendingMutations;
  if (updates.revision !== undefined) session.revision = updates.revision;
}

export function closeVirtualHostSession(saveId: string, runId: string): SessionMutation[] {
  const sessionKey = `${saveId}:${runId}`;
  const session = activeSessions.get(sessionKey);
  if (!session) return [];
  session.state = 'closed';
  const pending = session.pendingMutations;
  activeSessions.delete(sessionKey);
  return pending;
}

export function recordSessionMutation(
  saveId: string,
  runId: string,
  mutation: Omit<SessionMutation, 'timestamp'>,
): void {
  const session = getVirtualHostSession(saveId, runId);
  if (!session) {
    console.warn(`[shujuku-session] Mutation recorded without active session: ${saveId}:${runId}`);
    return;
  }
  session.pendingMutations.push({ ...mutation, timestamp: Date.now() });
  session.revision += 1;
}

export function flushSessionMutations(saveId: string, runId: string): SessionMutation[] {
  const session = getVirtualHostSession(saveId, runId);
  if (!session) return [];
  const pending = session.pendingMutations;
  session.pendingMutations = [];
  return pending;
}
