import type { TavernWindow } from '../types';

export const ISLAND_HOST_SOURCE = 'islandmilfcode' as const;
export const DEFAULT_HOST_READ_LIMIT = 32;
export const DEFAULT_LOCATOR_REPAIR_PAGE_LIMIT = 5;

export type IslandHostMessagePart = 'user' | 'assistant';

export type IslandHostMarkerV1 = {
  v: 1;
  source: typeof ISLAND_HOST_SOURCE;
  runId: string;
  branchId: string;
  floorId: string;
  parentFloorId: string | null;
  exchangeId: string;
  part: IslandHostMessagePart;
};

export type IslandHostMarkerInput = Omit<IslandHostMarkerV1, 'v' | 'source'>;

export type HostTimelineMessage = ReturnType<NonNullable<TavernWindow['getChatMessages']>>[number];

type HostTimelineWindow = TavernWindow & {
  getLastMessageId?: () => number;
};

export type VerifiedIslandHostMessage = Omit<HostTimelineMessage, 'role' | 'is_hidden' | 'data'> & {
  role: IslandHostMessagePart;
  is_hidden: true;
  data: Record<string, unknown> & {
    islandmilfcode_source: typeof ISLAND_HOST_SOURCE;
    islandmilfcode: IslandHostMarkerV1;
  };
};

export type HostMessageLocator = {
  marker: IslandHostMarkerV1;
  lastKnownMessageId: number;
};

export type HostMessageReadback = {
  locator: HostMessageLocator;
  message: VerifiedIslandHostMessage;
  repaired: boolean;
};

export type HostLocatorBatchReadIssue = {
  index: number;
  locator: HostMessageLocator;
  error: HostTimelineError;
};

export type HostLocatorBatchReadResult = {
  readbacks: Array<HostMessageReadback | null>;
  issues: HostLocatorBatchReadIssue[];
};

export type HostTimelineForwardWindow = {
  messages: HostTimelineMessage[];
  tailMessageId: number;
  reachedTail: boolean;
};

export type HostTimelineCapabilities = {
  boundedRead: boolean;
  createMessages: boolean;
  updateMessages: boolean;
  deleteMessages: boolean;
};

export type HostTimelineAdapterOptions = {
  maxReadMessages?: number;
  locatorRepairPageLimit?: number;
};

export type CreateHostMessageInput = {
  marker: IslandHostMarkerV1;
  message: string;
  refresh?: 'none' | 'affected' | 'all';
  acceptExistingHostText?: boolean;
};

export type UpdateHostMessageInput = {
  message: string;
  refresh?: 'none' | 'affected' | 'all';
};

export type DeleteHostMessageResult = {
  marker: IslandHostMarkerV1;
  deletedMessageId: number;
};

export type HostTimelineErrorCode =
  | 'capability-unavailable'
  | 'invalid-marker'
  | 'invalid-range'
  | 'host-read-failed'
  | 'host-write-failed'
  | 'message-not-found'
  | 'ambiguous-marker'
  | 'readback-mismatch'
  | 'delete-readback-failed';

export class HostTimelineError extends Error {
  readonly code: HostTimelineErrorCode;
  readonly detail: Record<string, unknown>;
  readonly cause: unknown;

  constructor(
    code: HostTimelineErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = 'HostTimelineError';
    this.code = code;
    this.detail = detail;
    this.cause = cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isMessageId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export function isIslandHostMarkerV1(value: unknown): value is IslandHostMarkerV1 {
  if (!isRecord(value)) return false;
  return (
    value.v === 1
    && value.source === ISLAND_HOST_SOURCE
    && isNonEmptyString(value.runId)
    && isNonEmptyString(value.branchId)
    && isNonEmptyString(value.floorId)
    && (value.parentFloorId === null || isNonEmptyString(value.parentFloorId))
    && isNonEmptyString(value.exchangeId)
    && (value.part === 'user' || value.part === 'assistant')
  );
}

export function parseIslandHostMarker(value: unknown): IslandHostMarkerV1 | null {
  return isIslandHostMarkerV1(value) ? { ...value } : null;
}

export function parseHostMessageLocator(value: unknown): HostMessageLocator | null {
  if (!isRecord(value)) return null;
  const marker = parseIslandHostMarker(value.marker);
  if (!marker || !isMessageId(value.lastKnownMessageId)) return null;
  return {
    marker,
    lastKnownMessageId: value.lastKnownMessageId,
  };
}

export function createIslandHostMarker(input: IslandHostMarkerInput): IslandHostMarkerV1 {
  const marker: IslandHostMarkerV1 = {
    ...input,
    v: 1,
    source: ISLAND_HOST_SOURCE,
  };
  assertMarker(marker);
  return marker;
}

function assertMarker(marker: unknown): asserts marker is IslandHostMarkerV1 {
  if (!isIslandHostMarkerV1(marker)) {
    throw new HostTimelineError('invalid-marker', 'Invalid IslandMilfCode host message marker.');
  }
}

export function islandHostMarkersEqual(left: IslandHostMarkerV1, right: IslandHostMarkerV1): boolean {
  return (
    left.v === right.v
    && left.source === right.source
    && left.runId === right.runId
    && left.branchId === right.branchId
    && left.floorId === right.floorId
    && left.parentFloorId === right.parentFloorId
    && left.exchangeId === right.exchangeId
    && left.part === right.part
  );
}

export function readIslandHostMarker(message: HostTimelineMessage): IslandHostMarkerV1 | null {
  if (!isRecord(message?.data)) return null;
  if (message.data.islandmilfcode_source !== ISLAND_HOST_SOURCE) return null;
  return parseIslandHostMarker(message.data.islandmilfcode);
}

function toLocator(message: HostTimelineMessage, marker: IslandHostMarkerV1): HostMessageLocator {
  return {
    marker: { ...marker },
    lastKnownMessageId: message.message_id,
  };
}

export class HostTimelineAdapter {
  readonly maxReadMessages: number;
  readonly locatorRepairPageLimit: number;

  constructor(
    private readonly win: HostTimelineWindow,
    options: HostTimelineAdapterOptions = {},
  ) {
    const maxReadMessages = options.maxReadMessages ?? DEFAULT_HOST_READ_LIMIT;
    const locatorRepairPageLimit = options.locatorRepairPageLimit ?? DEFAULT_LOCATOR_REPAIR_PAGE_LIMIT;
    if (!Number.isInteger(maxReadMessages) || maxReadMessages < 1 || maxReadMessages > DEFAULT_HOST_READ_LIMIT) {
      throw new HostTimelineError('invalid-range', 'maxReadMessages must be between 1 and 32.', {
        maxReadMessages,
      });
    }
    if (!Number.isInteger(locatorRepairPageLimit) || locatorRepairPageLimit < 1) {
      throw new HostTimelineError('invalid-range', 'locatorRepairPageLimit must be a positive integer.', {
        locatorRepairPageLimit,
      });
    }
    this.maxReadMessages = maxReadMessages;
    this.locatorRepairPageLimit = locatorRepairPageLimit;
  }

  get capabilities(): HostTimelineCapabilities {
    return {
      boundedRead: typeof this.win.getChatMessages === 'function',
      createMessages: typeof this.win.createChatMessages === 'function',
      updateMessages: typeof this.win.setChatMessages === 'function',
      deleteMessages: typeof this.win.deleteChatMessages === 'function',
    };
  }

  readBounded(startMessageId: number, endMessageId = startMessageId): HostTimelineMessage[] {
    if (!isMessageId(startMessageId) || !isMessageId(endMessageId) || endMessageId < startMessageId) {
      throw new HostTimelineError('invalid-range', 'Host message range is invalid.', {
        startMessageId,
        endMessageId,
      });
    }
    const requestedCount = endMessageId - startMessageId + 1;
    if (requestedCount > this.maxReadMessages) {
      throw new HostTimelineError('invalid-range', 'Host message range exceeds the bounded-read limit.', {
        startMessageId,
        endMessageId,
        requestedCount,
        maxReadMessages: this.maxReadMessages,
      });
    }
    const getChatMessages = this.requireCapability('getChatMessages');
    const range = startMessageId === endMessageId ? startMessageId : `${startMessageId}-${endMessageId}`;
    try {
      const messages = getChatMessages(range, {
        hide_state: 'all',
        include_swipes: false,
      });
      if (!Array.isArray(messages)) {
        throw new HostTimelineError('host-read-failed', 'Host returned a non-array message readback.', {
          startMessageId,
          endMessageId,
        });
      }
      return messages.filter(message => (
        message
        && isMessageId(message.message_id)
        && message.message_id >= startMessageId
        && message.message_id <= endMessageId
      ));
    } catch (error) {
      if (error instanceof HostTimelineError) throw error;
      throw new HostTimelineError(
        'host-read-failed',
        'Failed to read host messages.',
        { startMessageId, endMessageId },
        error,
      );
    }
  }

  readAtLocator(locator: HostMessageLocator, expectedText?: string): HostMessageReadback {
    this.assertLocator(locator);
    const exact = this.readBounded(locator.lastKnownMessageId).find(
      message => message.message_id === locator.lastKnownMessageId,
    );
    if (exact) {
      const marker = readIslandHostMarker(exact);
      if (marker && islandHostMarkersEqual(marker, locator.marker)) {
        return this.assertReadback(exact, locator.marker, expectedText, false);
      }
    }
    return this.repairLocator(locator, expectedText);
  }

  /**
   * Resolve many locator hints without issuing one exact host read per message.
   * Exact hints sharing a 32-message page reuse one host request; only misses
   * enter the bounded repair search.
   */
  readManyAtLocators(locators: readonly HostMessageLocator[]): HostLocatorBatchReadResult {
    const readbacks: Array<HostMessageReadback | null> = Array.from({ length: locators.length }, () => null);
    const issues: HostLocatorBatchReadIssue[] = [];
    const pageCache = new Map<string, HostTimelineMessage[]>();
    const pageErrors = new Map<string, HostTimelineError>();
    const locatorPageKeys: string[] = [];

    for (let index = 0; index < locators.length; index += 1) {
      const locator = locators[index];
      try {
        this.assertLocator(locator);
        const start = Math.floor(locator.lastKnownMessageId / this.maxReadMessages) * this.maxReadMessages;
        const end = start + this.maxReadMessages - 1;
        const key = this.getWindowKey(start, end);
        locatorPageKeys[index] = key;
        if (pageCache.has(key) || pageErrors.has(key)) continue;
        try {
          pageCache.set(key, this.readBounded(start, end));
        } catch (error) {
          pageErrors.set(key, this.asTimelineError(error));
        }
      } catch (error) {
        issues.push({ index, locator, error: this.asTimelineError(error) });
      }
    }

    let batchTailMessageId: number;
    try {
      batchTailMessageId = this.getLastMessageId();
    } catch (error) {
      const timelineError = this.asTimelineError(error);
      for (let index = 0; index < locators.length; index += 1) {
        if (!issues.some(issue => issue.index === index)) {
          issues.push({ index, locator: locators[index], error: timelineError });
        }
      }
      return { readbacks, issues };
    }
    for (let index = 0; index < locators.length; index += 1) {
      if (issues.some(issue => issue.index === index)) continue;
      const locator = locators[index];
      const key = locatorPageKeys[index];
      const pageError = pageErrors.get(key);
      if (pageError) {
        issues.push({ index, locator, error: pageError });
        continue;
      }

      try {
        const resolved = this.findMarkerNear(
          locator.marker,
          locator.lastKnownMessageId,
          pageCache,
          batchTailMessageId,
        );
        if (!resolved) {
          throw new HostTimelineError('message-not-found', 'Marked host message was not found in the repair window.', {
            marker: locator.marker,
            lastKnownMessageId: locator.lastKnownMessageId,
            maxReadMessages: this.maxReadMessages,
            locatorRepairPageLimit: this.locatorRepairPageLimit,
          });
        }
        readbacks[index] = this.assertReadback(
          resolved,
          locator.marker,
          undefined,
          resolved.message_id !== locator.lastKnownMessageId,
        );
      } catch (error) {
        issues.push({ index, locator, error: this.asTimelineError(error) });
      }
    }

    return { readbacks, issues };
  }

  readForwardAfter(
    afterMessageId: number,
    pageLimit = this.locatorRepairPageLimit,
  ): HostTimelineForwardWindow {
    if (!Number.isInteger(afterMessageId) || afterMessageId < -1) {
      throw new HostTimelineError('invalid-range', 'Forward host scan requires a message id of -1 or greater.', {
        afterMessageId,
      });
    }
    this.assertPageLimit(pageLimit);
    const tailMessageId = this.getLastMessageId();
    if (tailMessageId < 0 || afterMessageId >= tailMessageId) {
      return { messages: [], tailMessageId, reachedTail: true };
    }

    const messages: HostTimelineMessage[] = [];
    let nextMessageId = Math.max(0, afterMessageId + 1);
    for (let page = 0; page < pageLimit && nextMessageId <= tailMessageId; page += 1) {
      const end = Math.min(tailMessageId, nextMessageId + this.maxReadMessages - 1);
      messages.push(...this.readBounded(nextMessageId, end));
      nextMessageId = end + 1;
    }
    return { messages, tailMessageId, reachedTail: nextMessageId > tailMessageId };
  }

  repairLocator(locator: HostMessageLocator, expectedText?: string): HostMessageReadback {
    this.assertLocator(locator);
    const repaired = this.findMarkerNear(locator.marker, locator.lastKnownMessageId);
    if (!repaired) {
      throw new HostTimelineError('message-not-found', 'Marked host message was not found in the repair window.', {
        marker: locator.marker,
        lastKnownMessageId: locator.lastKnownMessageId,
        maxReadMessages: this.maxReadMessages,
        locatorRepairPageLimit: this.locatorRepairPageLimit,
      });
    }
    return this.assertReadback(repaired, locator.marker, expectedText, true);
  }

  async createAndReadBack(input: CreateHostMessageInput): Promise<HostMessageReadback> {
    assertMarker(input.marker);
    if (!isNonEmptyString(input.message)) {
      throw new HostTimelineError('readback-mismatch', 'A real host floor cannot contain empty text.', {
        marker: input.marker,
      });
    }
    const tailBeforeCreate = this.getLastMessageId();
    const existing = tailBeforeCreate >= 0
      ? this.findMarkerNear(input.marker, tailBeforeCreate)
      : null;
    if (existing) {
      return this.assertOrRepairHiddenReadback(
        existing,
        input.marker,
        input.acceptExistingHostText ? undefined : input.message,
        true,
        input.refresh ?? 'none',
      );
    }
    const createChatMessages = this.requireCapability('createChatMessages');
    const data = {
      islandmilfcode_source: ISLAND_HOST_SOURCE,
      islandmilfcode: { ...input.marker },
    };
    try {
      await createChatMessages(
        [{
          role: input.marker.part,
          message: input.message,
          is_hidden: true,
          data,
        }],
        { refresh: input.refresh ?? 'none', insert_before: 'end' },
      );
    } catch (error) {
      throw new HostTimelineError('host-write-failed', 'Failed to create a real host message.', {
        marker: input.marker,
      }, error);
    }

    const tailMessageId = this.getLastMessageId();
    const created = this.findMarkerNear(input.marker, tailMessageId);
    if (!created) {
      throw new HostTimelineError('readback-mismatch', 'Created host message could not be read back by marker.', {
        marker: input.marker,
        tailMessageId,
      });
    }
    return this.assertOrRepairHiddenReadback(
      created,
      input.marker,
      input.message,
      false,
      input.refresh ?? 'none',
    );
  }

  /**
   * Repair only the compatibility bug where Tavern Helper preserved marker,
   * role and text but ignored `is_hidden` during message creation. Any other
   * mismatch remains an error so this helper cannot retarget another floor.
   */
  async repairVisibleReadbackIssues(
    issues: readonly HostLocatorBatchReadIssue[],
    refresh: 'none' | 'affected' | 'all' = 'affected',
  ): Promise<number> {
    const repairs = new Map<number, { message_id: number; is_hidden: true }>();
    for (const issue of issues) {
      const detail = issue.error.detail;
      const actualMarker = parseIslandHostMarker(detail.actualMarker);
      const messageId = detail.messageId;
      if (
        issue.error.code !== 'readback-mismatch'
        || !actualMarker
        || !islandHostMarkersEqual(actualMarker, issue.locator.marker)
        || detail.actualRole !== issue.locator.marker.part
        || detail.actualHidden === true
        || !isNonEmptyString(detail.actualText)
        || !isMessageId(messageId)
      ) {
        continue;
      }
      repairs.set(messageId, { message_id: messageId, is_hidden: true });
    }
    if (!repairs.size) return 0;

    const setChatMessages = this.requireCapability('setChatMessages');
    try {
      await setChatMessages([...repairs.values()], { refresh });
    } catch (error) {
      throw new HostTimelineError('host-write-failed', 'Failed to hide marked host messages.', {
        messageIds: [...repairs.keys()],
      }, error);
    }
    return repairs.size;
  }

  async updateAndReadBack(
    locator: HostMessageLocator,
    input: UpdateHostMessageInput,
  ): Promise<HostMessageReadback> {
    if (!isNonEmptyString(input.message)) {
      throw new HostTimelineError('readback-mismatch', 'A real host floor cannot contain empty text.', {
        marker: locator.marker,
      });
    }
    const current = this.readAtLocator(locator);
    const setChatMessages = this.requireCapability('setChatMessages');
    try {
      await setChatMessages(
        [{
          message_id: current.message.message_id,
          message: input.message,
        }],
        { refresh: input.refresh ?? 'none' },
      );
    } catch (error) {
      throw new HostTimelineError('host-write-failed', 'Failed to update a real host message.', {
        marker: locator.marker,
        messageId: current.message.message_id,
      }, error);
    }

    return this.readAtLocator(current.locator, input.message);
  }

  async deleteAndReadBack(
    locator: HostMessageLocator,
    refresh: 'none' | 'affected' | 'all' = 'none',
  ): Promise<DeleteHostMessageResult> {
    const results = await this.deleteManyAndReadBack([locator], refresh);
    return results[0];
  }

  async deleteManyAndReadBack(
    locators: readonly HostMessageLocator[],
    refresh: 'none' | 'affected' | 'all' = 'none',
  ): Promise<DeleteHostMessageResult[]> {
    if (!locators.length) return [];
    const currentMessages = locators.map(locator => this.readAtLocator(locator));
    const messageIds = [...new Set(currentMessages.map(current => current.message.message_id))];
    const deleteChatMessages = this.requireCapability('deleteChatMessages');
    try {
      await deleteChatMessages(messageIds, { refresh });
    } catch (error) {
      throw new HostTimelineError('host-write-failed', 'Failed to delete real host messages.', {
        messageIds,
      }, error);
    }

    for (const current of currentMessages) {
      const remaining = this.findMarkerNear(current.locator.marker, current.message.message_id);
      if (remaining) {
        throw new HostTimelineError('delete-readback-failed', 'Deleted host marker is still present after readback.', {
          marker: current.locator.marker,
          deletedMessageId: current.message.message_id,
          remainingMessageId: remaining.message_id,
        });
      }
    }
    return currentMessages.map(current => ({
      marker: { ...current.locator.marker },
      deletedMessageId: current.message.message_id,
    }));
  }

  private assertLocator(locator: HostMessageLocator): void {
    assertMarker(locator?.marker);
    if (!isMessageId(locator?.lastKnownMessageId)) {
      throw new HostTimelineError('invalid-range', 'Host message locator contains an invalid message id.', {
        lastKnownMessageId: locator?.lastKnownMessageId,
      });
    }
  }

  private assertReadback(
    message: HostTimelineMessage,
    expectedMarker: IslandHostMarkerV1,
    expectedText?: string,
    repaired = false,
  ): HostMessageReadback {
    const actualMarker = readIslandHostMarker(message);
    if (
      !actualMarker
      || !islandHostMarkersEqual(actualMarker, expectedMarker)
      || message.role !== expectedMarker.part
      || message.is_hidden !== true
      || !isNonEmptyString(message.message)
      || (expectedText !== undefined && message.message !== expectedText)
    ) {
      throw new HostTimelineError('readback-mismatch', 'Host message readback does not match its marker contract.', {
        expectedMarker,
        actualMarker,
        expectedText,
        actualText: message.message,
        actualRole: message.role,
        actualHidden: message.is_hidden,
        messageId: message.message_id,
      });
    }
    const verifiedMarker = actualMarker;
    const verified = message as VerifiedIslandHostMessage;
    return {
      locator: toLocator(message, verifiedMarker),
      message: verified,
      repaired,
    };
  }

  private async assertOrRepairHiddenReadback(
    message: HostTimelineMessage,
    expectedMarker: IslandHostMarkerV1,
    expectedText: string | undefined,
    repaired: boolean,
    refresh: 'none' | 'affected' | 'all',
  ): Promise<HostMessageReadback> {
    const actualMarker = readIslandHostMarker(message);
    const onlyHiddenStateIsWrong = Boolean(
      actualMarker
      && islandHostMarkersEqual(actualMarker, expectedMarker)
      && message.role === expectedMarker.part
      && message.is_hidden !== true
      && isNonEmptyString(message.message)
      && (expectedText === undefined || message.message === expectedText),
    );
    if (!onlyHiddenStateIsWrong) {
      return this.assertReadback(message, expectedMarker, expectedText, repaired);
    }

    const setChatMessages = this.requireCapability('setChatMessages');
    try {
      await setChatMessages(
        [{ message_id: message.message_id, is_hidden: true }],
        { refresh: refresh === 'none' ? 'affected' : refresh },
      );
    } catch (error) {
      throw new HostTimelineError('host-write-failed', 'Failed to hide a marked host message.', {
        marker: expectedMarker,
        messageId: message.message_id,
      }, error);
    }
    const readBack = this.readBounded(message.message_id).find(
      candidate => candidate.message_id === message.message_id,
    );
    if (!readBack) {
      throw new HostTimelineError('readback-mismatch', 'Hidden host message disappeared during readback.', {
        marker: expectedMarker,
        messageId: message.message_id,
      });
    }
    return this.assertReadback(readBack, expectedMarker, expectedText, true);
  }

  private findMarkerNear(
    marker: IslandHostMarkerV1,
    centerMessageId: number,
    pageCache?: Map<string, HostTimelineMessage[]>,
    knownLastMessageId?: number,
  ): HostTimelineMessage | null {
    const lastMessageId = knownLastMessageId ?? this.getLastMessageId();
    if (lastMessageId < 0) return null;
    const center = Math.min(Math.max(0, centerMessageId), lastMessageId);
    const pageStart = Math.floor(center / this.maxReadMessages) * this.maxReadMessages;
    const windows: Array<[number, number]> = [];

    // Search the locator page first, then alternate backward and forward pages.
    for (let distance = 0; windows.length < this.locatorRepairPageLimit; distance += 1) {
      const candidates = distance === 0
        ? [pageStart]
        : [pageStart - distance * this.maxReadMessages, pageStart + distance * this.maxReadMessages];
      let added = false;
      for (const start of candidates) {
        if (start < 0 || start > lastMessageId) continue;
        windows.push([start, Math.min(lastMessageId, start + this.maxReadMessages - 1)]);
        added = true;
        if (windows.length >= this.locatorRepairPageLimit) break;
      }
      if (!added && pageStart - distance * this.maxReadMessages < 0 && pageStart + distance * this.maxReadMessages > lastMessageId) {
        break;
      }
    }

    const matches: HostTimelineMessage[] = [];
    for (const [start, end] of windows) {
      const pageMatches = this.readWindow(start, end, pageCache).filter(message => {
        const candidate = readIslandHostMarker(message);
        return Boolean(candidate && islandHostMarkersEqual(candidate, marker));
      });
      matches.push(...pageMatches);
    }
    if (matches.length > 1) {
      throw new HostTimelineError('ambiguous-marker', 'Multiple host messages share the same immutable marker.', {
        marker,
        messageIds: matches.map(message => message.message_id),
      });
    }
    return matches[0] ?? null;
  }

  private readWindow(
    startMessageId: number,
    endMessageId: number,
    pageCache?: Map<string, HostTimelineMessage[]>,
  ): HostTimelineMessage[] {
    if (!pageCache) return this.readBounded(startMessageId, endMessageId);
    const key = this.getWindowKey(startMessageId, endMessageId);
    const cached = pageCache.get(key);
    if (cached) return cached;
    const messages = this.readBounded(startMessageId, endMessageId);
    pageCache.set(key, messages);
    return messages;
  }

  private getWindowKey(startMessageId: number, endMessageId: number): string {
    return `${startMessageId}:${endMessageId}`;
  }

  private assertPageLimit(pageLimit: number): void {
    if (!Number.isInteger(pageLimit) || pageLimit < 1) {
      throw new HostTimelineError('invalid-range', 'Host page limit must be a positive integer.', { pageLimit });
    }
  }

  private asTimelineError(error: unknown): HostTimelineError {
    return error instanceof HostTimelineError
      ? error
      : new HostTimelineError('host-read-failed', 'Failed to resolve a host message locator.', {}, error);
  }

  private getLastMessageId(): number {
    if (typeof this.win.getLastMessageId === 'function') {
      try {
        const current = this.win.getLastMessageId();
        if (isMessageId(current)) return current;
      } catch (error) {
        throw new HostTimelineError('host-read-failed', 'Failed to read the last host message id.', {}, error);
      }
    }

    const getChatMessages = this.requireCapability('getChatMessages');
    try {
      const tail = getChatMessages('{{lastMessageId}}', {
        hide_state: 'all',
        include_swipes: false,
      });
      if (!Array.isArray(tail) || !tail.length) return -1;
      const ids = tail.map(message => message?.message_id).filter(isMessageId);
      return ids.length ? Math.max(...ids) : -1;
    } catch (error) {
      throw new HostTimelineError('host-read-failed', 'Failed to locate the host timeline tail.', {}, error);
    }
  }

  private requireCapability<K extends 'getChatMessages' | 'createChatMessages' | 'setChatMessages' | 'deleteChatMessages'>(
    name: K,
  ): NonNullable<TavernWindow[K]> {
    const capability = this.win[name];
    if (typeof capability !== 'function') {
      throw new HostTimelineError('capability-unavailable', `Host capability ${name} is unavailable.`, {
        capability: name,
      });
    }
    return capability as NonNullable<TavernWindow[K]>;
  }
}
