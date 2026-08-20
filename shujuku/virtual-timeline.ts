import type { UiMessage } from '../types';
import type { ShujukuVirtualMessageInput } from './adapter';

type LogicalUiMessage = UiMessage & { role: 'user' | 'assistant' };

export type ShujukuVirtualTimelineProjection = {
  rootMessage: ShujukuVirtualMessageInput | null;
  /** Complete archive timeline plus the current uncommitted user. */
  messages: ShujukuVirtualMessageInput[];
  /** Token-bounded history used only by the wrapped narrative generator. */
  promptMessages: ShujukuVirtualMessageInput[];
  archiveMessageCount: number;
  logicalAssistantCountBeforeGeneration: number;
};

export type BuildShujukuVirtualTimelineInput = {
  archiveMessages: readonly UiMessage[];
  runtimeMessages: readonly UiMessage[];
  promptMessages: readonly UiMessage[];
  currentUserId: string;
  currentUserPluginData?: Record<string, unknown>;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isLogicalMessage(message: UiMessage): message is LogicalUiMessage {
  return (message.role === 'user' || message.role === 'assistant') && !message.streaming;
}

function assertLogicalMessage(message: LogicalUiMessage, source: string): void {
  if (!message.id.trim()) throw new Error(`${source} contains an empty logical id`);
  if (!message.text.trim()) throw new Error(`${source} logical id ${message.id} has empty text`);
}

function collectUniqueMessages(messages: readonly UiMessage[], source: string): LogicalUiMessage[] {
  const result: LogicalUiMessage[] = [];
  const ids = new Set<string>();
  for (const message of messages) {
    if (!isLogicalMessage(message)) continue;
    assertLogicalMessage(message, source);
    if (ids.has(message.id)) throw new Error(`${source} contains duplicate logical id ${message.id}`);
    ids.add(message.id);
    result.push(cloneJson(message));
  }
  return result;
}

function mergeArchiveAndRuntime(
  archiveMessages: readonly UiMessage[],
  runtimeMessages: readonly UiMessage[],
): LogicalUiMessage[] {
  const merged = collectUniqueMessages(archiveMessages, 'archive timeline');
  const runtime = collectUniqueMessages(runtimeMessages, 'runtime timeline');
  const indexes = new Map(merged.map((message, index) => [message.id, index]));
  for (const message of runtime) {
    const existingIndex = indexes.get(message.id);
    if (existingIndex === undefined) {
      indexes.set(message.id, merged.length);
      merged.push(message);
    } else {
      const existing = merged[existingIndex];
      if (existing.role !== message.role) {
        throw new Error(`logical id ${message.id} changed role from ${existing.role} to ${message.role}`);
      }
      merged[existingIndex] = message;
    }
  }
  return merged;
}

function resolveExchangeId(
  user: LogicalUiMessage | null,
  assistant: LogicalUiMessage | null,
): string {
  if (user?.exchangeId && assistant?.exchangeId && user.exchangeId !== assistant.exchangeId) {
    throw new Error(
      `logical exchange mismatch: user ${user.id}=${user.exchangeId}, assistant ${assistant.id}=${assistant.exchangeId}`,
    );
  }
  return user?.exchangeId || assistant?.exchangeId || user?.id || assistant?.id || '';
}

function toVirtualMessage(
  message: LogicalUiMessage,
  identity: { exchangeId: string; floorIndex: number | null },
  currentUserId: string,
  currentUserPluginData?: Record<string, unknown>,
): ShujukuVirtualMessageInput {
  const isCurrent = message.id === currentUserId;
  const pluginData = {
    ...(message.pluginData ? cloneJson(message.pluginData) : {}),
    ...(isCurrent && currentUserPluginData ? cloneJson(currentUserPluginData) : {}),
  };
  return {
    role: message.role,
    name: message.speaker,
    text: message.text,
    ...(message.rawText !== undefined ? { rawText: message.rawText } : {}),
    ...(Object.keys(pluginData).length ? { pluginData } : {}),
    ...(isCurrent ? { current: true } : {}),
    logicalId: message.id,
    exchangeId: identity.exchangeId,
    floorIndex: identity.floorIndex,
  };
}

export function buildShujukuVirtualTimeline(
  input: BuildShujukuVirtualTimelineInput,
): ShujukuVirtualTimelineProjection {
  const currentUserId = String(input.currentUserId ?? '').trim();
  if (!currentUserId) throw new Error('current user logical id is required');

  const merged = mergeArchiveAndRuntime(input.archiveMessages, input.runtimeMessages);
  const currentIndex = merged.findIndex(message => message.id === currentUserId);
  if (currentIndex < 0) throw new Error(`current user logical id ${currentUserId} is missing from the timeline`);
  if (merged[currentIndex].role !== 'user') throw new Error(`current logical id ${currentUserId} is not a user`);
  if (currentIndex !== merged.length - 1) {
    throw new Error(`current user logical id ${currentUserId} must be the timeline tail`);
  }

  const rootUiMessage = merged[0]?.role === 'assistant' ? merged.shift() ?? null : null;
  const identityById = new Map<string, { exchangeId: string; floorIndex: number | null }>();
  let nextFloorIndex = rootUiMessage ? 1 : 0;
  if (rootUiMessage) identityById.set(rootUiMessage.id, { exchangeId: '', floorIndex: null });

  for (let index = 0; index < merged.length;) {
    const message = merged[index];
    if (message.role === 'user') {
      const assistant = merged[index + 1]?.role === 'assistant' ? merged[index + 1] : null;
      const exchangeId = resolveExchangeId(message, assistant);
      identityById.set(message.id, { exchangeId, floorIndex: nextFloorIndex });
      if (assistant) identityById.set(assistant.id, { exchangeId, floorIndex: nextFloorIndex });
      nextFloorIndex += 1;
      index += assistant ? 2 : 1;
      continue;
    }
    const exchangeId = resolveExchangeId(null, message);
    identityById.set(message.id, { exchangeId, floorIndex: nextFloorIndex });
    nextFloorIndex += 1;
    index += 1;
  }

  const rootMessage = rootUiMessage
    ? {
        ...toVirtualMessage(rootUiMessage, { exchangeId: '', floorIndex: null }, currentUserId),
        exchangeId: null,
        floorIndex: null,
      }
    : null;
  const messages = merged.map(message => {
    const identity = identityById.get(message.id);
    if (!identity) throw new Error(`logical id ${message.id} has no virtual identity`);
    return toVirtualMessage(message, identity, currentUserId, input.currentUserPluginData);
  });
  if (messages.filter(message => message.current).length !== 1 || messages.at(-1)?.current !== true) {
    throw new Error('the complete virtual timeline must end in exactly one current user');
  }

  const canonicalById = new Map(merged.map(message => [message.id, message]));
  const promptIds = new Set<string>();
  const promptMessages = collectUniqueMessages(input.promptMessages, 'prompt timeline')
    .filter(message => message.id !== rootUiMessage?.id && message.id !== currentUserId)
    .map(message => {
      if (promptIds.has(message.id)) throw new Error(`prompt timeline contains duplicate logical id ${message.id}`);
      promptIds.add(message.id);
      const canonical = canonicalById.get(message.id);
      const identity = identityById.get(message.id);
      if (!canonical || !identity) {
        throw new Error(`prompt logical id ${message.id} is absent from the complete timeline`);
      }
      return toVirtualMessage(canonical, identity, currentUserId);
    });

  return {
    rootMessage,
    messages,
    promptMessages,
    archiveMessageCount: input.archiveMessages.filter(isLogicalMessage).length,
    logicalAssistantCountBeforeGeneration: messages.filter(message => message.role === 'assistant').length,
  };
}
