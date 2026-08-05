import { extractContextReply } from '../message-format';
import type { UiMessage } from '../types';
import {
  HostTimelineAdapter,
  islandHostMarkersEqual,
  readIslandHostMarker,
  type HostMessageReadback,
  type HostTimelineMessage,
  type IslandHostMarkerV1,
} from './host-timeline-adapter';

export type HostSaveOpenIssueCode =
  | 'capability-unavailable'
  | 'missing-locator'
  | 'run-mismatch'
  | 'branch-mismatch'
  | 'role-mismatch'
  | 'duplicate-marker'
  | 'message-id-collision'
  | 'floor-pair-mismatch'
  | 'parent-chain-mismatch'
  | 'host-read-failed'
  | 'index-behind-host'
  | 'host-ahead-conflict'
  | 'host-scan-incomplete';

export type HostSaveOpenIssue = {
  code: HostSaveOpenIssueCode;
  reason: string;
  messageId?: string;
  floorId?: string;
};

export type HostSaveReconciliationResult =
  | {
      status: 'empty' | 'verified';
      messages: UiMessage[];
      issues: [];
      branchId: string | null;
      repairedLocatorCount: number;
    }
  | {
      status: 'degraded';
      messages: UiMessage[];
      issues: HostSaveOpenIssue[];
      branchId: null;
      repairedLocatorCount: number;
    }
  | {
      status: 'blocked';
      messages: UiMessage[];
      issues: HostSaveOpenIssue[];
      branchId: null;
      repairedLocatorCount: 0;
    };

type LocatedMessage = {
  index: number;
  message: UiMessage;
  marker: IslandHostMarkerV1;
};

type FloorGroup = {
  floorId: string;
  branchId: string;
  parentFloorId: string | null;
  exchangeId: string;
  firstIndex: number;
  userIndex: number | null;
  assistantIndex: number | null;
};

function blocked(messages: UiMessage[], issues: HostSaveOpenIssue[]): HostSaveReconciliationResult {
  return {
    status: 'blocked',
    messages,
    issues,
    branchId: null,
    repairedLocatorCount: 0,
  };
}

function localFallback(
  messages: UiMessage[],
  issues: HostSaveOpenIssue[],
  repairedLocatorCount = 0,
): HostSaveReconciliationResult {
  return {
    status: 'degraded',
    messages: messages.map(message => {
      const { hostLocator: _hostLocator, tavernMessageId: _tavernMessageId, ...localMessage } = message;
      return localMessage;
    }),
    issues,
    branchId: null,
    repairedLocatorCount,
  };
}

function markerPartKey(marker: IslandHostMarkerV1): string {
  return [marker.runId, marker.branchId, marker.floorId, marker.part].join('\u0000');
}

function floorKey(marker: IslandHostMarkerV1): string {
  return [marker.runId, marker.branchId, marker.floorId].join('\u0000');
}

function issueReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectHostAhead(
  messages: HostTimelineMessage[],
  runId: string,
  branchId: string,
  headFloorId: string,
): { floorCount: number; continuous: boolean; reason: string } {
  const relevant = messages
    .map(message => ({ message, marker: readIslandHostMarker(message) }))
    .filter((entry): entry is { message: HostTimelineMessage; marker: IslandHostMarkerV1 } => (
      Boolean(entry.marker && entry.marker.runId === runId)
    ))
    .sort((left, right) => left.message.message_id - right.message.message_id);
  if (!relevant.length) return { floorCount: 0, continuous: true, reason: '' };

  const groups = new Map<string, {
    marker: IslandHostMarkerV1;
    user: HostTimelineMessage | null;
    assistant: HostTimelineMessage | null;
    firstMessageId: number;
  }>();
  let continuous = true;
  let reason = '';
  for (const entry of relevant) {
    const { marker, message } = entry;
    if (
      marker.branchId !== branchId
      || message.role !== marker.part
      || message.is_hidden !== true
      || !String(message.message ?? '').trim()
    ) {
      continuous = false;
      reason ||= 'head 之后存在分支、角色、隐藏状态或正文不符合合同的宿主楼层。';
    }
    const key = floorKey(marker);
    const group = groups.get(key) ?? {
      marker,
      user: null,
      assistant: null,
      firstMessageId: message.message_id,
    };
    if (
      group.marker.exchangeId !== marker.exchangeId
      || group.marker.parentFloorId !== marker.parentFloorId
    ) {
      continuous = false;
      reason ||= 'head 之后同一 floor 的 exchange 或 parent 标记不一致。';
    }
    if (marker.part === 'user') {
      if (group.user) {
        continuous = false;
        reason ||= 'head 之后同一 floor 出现重复 user marker。';
      }
      group.user = message;
    } else {
      if (group.assistant) {
        continuous = false;
        reason ||= 'head 之后同一 floor 出现重复 assistant marker。';
      }
      group.assistant = message;
    }
    group.firstMessageId = Math.min(group.firstMessageId, message.message_id);
    groups.set(key, group);
  }

  let expectedParentFloorId: string | null = headFloorId;
  const orderedGroups = [...groups.values()].sort((left, right) => left.firstMessageId - right.firstMessageId);
  for (const group of orderedGroups) {
    if (
      !group.user
      || !group.assistant
      || group.user.message_id >= group.assistant.message_id
      || group.marker.parentFloorId !== expectedParentFloorId
    ) {
      continuous = false;
      reason ||= 'head 之后不是 parent 连续且完整的 user/assistant 配对。';
    }
    expectedParentFloorId = group.marker.floorId;
  }
  return { floorCount: orderedGroups.length, continuous, reason };
}

/**
 * Establishes the normal-open contract before enterSave mutates active state.
 * Local text before the first locator is a legacy prefix. From the first
 * locator onward, every message must resolve a complete host timeline.
 */
export async function reconcileHostIndexedSave(
  messages: UiMessage[],
  hostTimeline: HostTimelineAdapter,
  runId: string,
  expectedBranchId?: unknown,
  pendingMarkers: readonly IslandHostMarkerV1[] = [],
  options: { verifyHostTail?: boolean } = {},
): Promise<HostSaveReconciliationResult> {
  if (!messages.length) {
    return {
      status: 'empty',
      messages,
      issues: [],
      branchId: null,
      repairedLocatorCount: 0,
    };
  }

  const located: LocatedMessage[] = [];
  const localIssues: HostSaveOpenIssue[] = [];
  let firstLocatedIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const locator = message.hostLocator;
    if (!locator) {
      if (firstLocatedIndex >= 0) {
        localIssues.push({
          code: 'missing-locator',
          messageId: message.id,
          reason: '第一条 host locator 之后不能再出现无 locator 的本地消息。',
        });
      }
      continue;
    }
    if (firstLocatedIndex < 0) firstLocatedIndex = index;
    const marker = locator.marker;
    if (marker.runId !== runId) {
      localIssues.push({
        code: 'run-mismatch',
        messageId: message.id,
        floorId: marker.floorId,
        reason: 'locator 属于另一个 run。',
      });
    }
    if (message.role !== marker.part) {
      localIssues.push({
        code: 'role-mismatch',
        messageId: message.id,
        floorId: marker.floorId,
        reason: '本地消息角色与 host marker part 不一致。',
      });
    }
    located.push({ index, message, marker });
  }

  if (!located.length) {
    return {
      status: 'verified',
      messages,
      issues: [],
      branchId: null,
      repairedLocatorCount: 0,
    };
  }
  if (!hostTimeline.capabilities.boundedRead) {
    localIssues.push({
      code: 'capability-unavailable',
      reason: '当前宿主没有有界消息读取能力，无法验证真实楼层。',
    });
  }
  if (localIssues.length) return localFallback(messages, localIssues);

  const branches = new Set<string>();
  const markerParts = new Map<string, LocatedMessage>();
  const locatorIds = new Map<number, LocatedMessage>();
  const exchangeFloors = new Map<string, string>();
  const floors = new Map<string, FloorGroup>();
  for (const entry of located) {
    const locator = entry.message.hostLocator!;
    const { marker } = entry;
    branches.add(marker.branchId);

    const partKey = markerPartKey(marker);
    const duplicatePart = markerParts.get(partKey);
    if (duplicatePart) {
      localIssues.push({
        code: 'duplicate-marker',
        messageId: entry.message.id,
        floorId: marker.floorId,
        reason: '同一 floor/part 在本地索引中出现多次。',
      });
    } else {
      markerParts.set(partKey, entry);
    }

    const sameLocator = locatorIds.get(locator.lastKnownMessageId);
    if (sameLocator && !islandHostMarkersEqual(sameLocator.marker, marker)) {
      localIssues.push({
        code: 'message-id-collision',
        messageId: entry.message.id,
        floorId: marker.floorId,
        reason: '两个不同 marker 使用了同一个 lastKnownMessageId。',
      });
    } else {
      locatorIds.set(locator.lastKnownMessageId, entry);
    }

    const exchangeFloor = exchangeFloors.get(marker.exchangeId);
    if (exchangeFloor && exchangeFloor !== marker.floorId) {
      localIssues.push({
        code: 'floor-pair-mismatch',
        messageId: entry.message.id,
        floorId: marker.floorId,
        reason: '同一个 exchangeId 被多个 floor 使用。',
      });
    } else {
      exchangeFloors.set(marker.exchangeId, marker.floorId);
    }

    const key = floorKey(marker);
    const group = floors.get(key) ?? {
      floorId: marker.floorId,
      branchId: marker.branchId,
      parentFloorId: marker.parentFloorId,
      exchangeId: marker.exchangeId,
      firstIndex: entry.index,
      userIndex: null,
      assistantIndex: null,
    };
    if (group.parentFloorId !== marker.parentFloorId || group.exchangeId !== marker.exchangeId) {
      localIssues.push({
        code: 'floor-pair-mismatch',
        messageId: entry.message.id,
        floorId: marker.floorId,
        reason: '同一 floor 的 user/assistant marker 不一致。',
      });
    }
    if (marker.part === 'user') group.userIndex = entry.index;
    else group.assistantIndex = entry.index;
    group.firstIndex = Math.min(group.firstIndex, entry.index);
    floors.set(key, group);
  }

  if (branches.size !== 1) {
    localIssues.push({ code: 'branch-mismatch', reason: '一个存档索引不能同时包含多个 host branch。' });
  }
  const branchId = branches.size === 1 ? [...branches][0] : '';
  const normalizedExpectedBranch = typeof expectedBranchId === 'string' ? expectedBranchId.trim() : '';
  if (normalizedExpectedBranch && branchId && normalizedExpectedBranch !== branchId) {
    localIssues.push({
      code: 'branch-mismatch',
      reason: '存档 checkpoint 的 branchId 与楼层 locator 不一致。',
    });
  }

  const orderedFloors = [...floors.values()].sort((left, right) => left.firstIndex - right.firstIndex);
  let previousFloorId: string | undefined;
  for (let index = 0; index < orderedFloors.length; index += 1) {
    const floor = orderedFloors[index];
    const completePair = floor.userIndex !== null && floor.assistantIndex !== null;
    if (
      completePair
      && floor.userIndex !== null
      && floor.assistantIndex !== null
      && floor.userIndex >= floor.assistantIndex
    ) {
      localIssues.push({
        code: 'floor-pair-mismatch',
        floorId: floor.floorId,
        reason: '同一 floor 的 user 必须位于 assistant 之前。',
      });
    }
    const previousFloorStillIndexed = previousFloorId === undefined
      || orderedFloors.some(candidate => candidate.floorId === floor.parentFloorId);
    if (
      previousFloorId !== undefined
      && floor.parentFloorId !== previousFloorId
      && previousFloorStillIndexed
    ) {
      localIssues.push({
        code: 'parent-chain-mismatch',
        floorId: floor.floorId,
        reason: 'floor parent 链与存档消息顺序不连续。',
      });
    }
    previousFloorId = floor.floorId;
  }
  if (localIssues.length) return localFallback(messages, localIssues);

  const locators = located.map(entry => entry.message.hostLocator!);
  let batch = hostTimeline.readManyAtLocators(locators);
  let repairedHiddenCount = 0;
  if (batch.issues.some(issue => issue.error.code === 'readback-mismatch')) {
    repairedHiddenCount = await hostTimeline.repairVisibleReadbackIssues(batch.issues, 'affected');
    if (repairedHiddenCount > 0) batch = hostTimeline.readManyAtLocators(locators);
  }
  const readbacksByMessageIndex = new Map<number, HostMessageReadback>();
  for (const issue of batch.issues) {
    const entry = located[issue.index];
    localIssues.push({
      code: 'host-read-failed',
      messageId: entry?.message.id,
      floorId: entry?.marker.floorId,
      reason: issue.error.message,
    });
  }
  for (let index = 0; index < batch.readbacks.length; index += 1) {
    const readback = batch.readbacks[index];
    if (readback) readbacksByMessageIndex.set(located[index].index, readback);
  }
  if (readbacksByMessageIndex.size !== located.length && !localIssues.length) {
    localIssues.push({ code: 'host-read-failed', reason: '宿主回读数量与本地索引数量不一致。' });
  }

  const actualIds = new Map<number, number>();
  for (const [messageIndex, readback] of readbacksByMessageIndex) {
    const duplicateIndex = actualIds.get(readback.locator.lastKnownMessageId);
    if (duplicateIndex !== undefined && duplicateIndex !== messageIndex) {
      localIssues.push({
        code: 'message-id-collision',
        messageId: messages[messageIndex]?.id,
        floorId: readback.locator.marker.floorId,
        reason: '宿主回读把多个本地消息解析到了同一个真实 message id。',
      });
    } else {
      actualIds.set(readback.locator.lastKnownMessageId, messageIndex);
    }
  }
  let previousHostMessageId = -1;
  for (const floor of orderedFloors) {
    const firstIndex = floor.userIndex ?? floor.assistantIndex;
    const lastIndex = floor.assistantIndex ?? floor.userIndex;
    const firstReadback = firstIndex === null ? null : readbacksByMessageIndex.get(firstIndex);
    const lastReadback = lastIndex === null ? null : readbacksByMessageIndex.get(lastIndex);
    if (!firstReadback || !lastReadback) continue;
    if (firstReadback.locator.lastKnownMessageId <= previousHostMessageId) {
      localIssues.push({
        code: 'parent-chain-mismatch',
        floorId: floor.floorId,
        reason: '宿主 message id 顺序与 floor parent 链不一致。',
      });
    }
    if (
      floor.userIndex !== null
      && floor.assistantIndex !== null
      && firstReadback.locator.lastKnownMessageId >= lastReadback.locator.lastKnownMessageId
    ) {
      localIssues.push({
        code: 'floor-pair-mismatch',
        floorId: floor.floorId,
        reason: '真实 host user 必须位于配对 assistant 之前。',
      });
    }
    previousHostMessageId = lastReadback.locator.lastKnownMessageId;
  }
  if (localIssues.length) return localFallback(messages, localIssues, repairedHiddenCount);

  const headFloor = orderedFloors[orderedFloors.length - 1];
  const headIndex = headFloor?.assistantIndex ?? headFloor?.userIndex ?? null;
  const headReadback = headIndex !== null
    ? readbacksByMessageIndex.get(headIndex)
    : null;
  if (!headFloor || !headReadback) {
    return localFallback(messages, [{ code: 'floor-pair-mismatch', reason: '存档没有可验证的 head floor。' }], repairedHiddenCount);
  }

  if (options.verifyHostTail !== false) try {
    const forward = hostTimeline.readForwardAfter(headReadback.locator.lastKnownMessageId);
    const indexedAheadMessages = forward.messages.filter(message => {
      const marker = readIslandHostMarker(message);
      return !marker || !pendingMarkers.some(pending => islandHostMarkersEqual(pending, marker));
    });
    const ahead = inspectHostAhead(indexedAheadMessages, runId, branchId, headFloor.floorId);
    const aheadIssues: HostSaveOpenIssue[] = [];
    if (ahead.floorCount > 0) {
      aheadIssues.push({
        code: ahead.continuous ? 'index-behind-host' : 'host-ahead-conflict',
        reason: ahead.continuous
          ? `真实宿主在存档 head 之后还有 ${ahead.floorCount} 个完整楼层，但本地没有对应状态 checkpoint。`
          : ahead.reason,
      });
    }
    if (!forward.reachedTail) {
      aheadIssues.push({
        code: 'host-scan-incomplete',
        reason: `head 之后超过 ${hostTimeline.locatorRepairPageLimit} 个有界读取页，无法证明宿主 timeline 已完全核对。`,
      });
    }
    if (aheadIssues.length) return localFallback(messages, aheadIssues, repairedHiddenCount);
  } catch (error) {
    return localFallback(messages, [{ code: 'host-read-failed', reason: issueReason(error) }], repairedHiddenCount);
  }

  const reconciled = messages.map((message, index) => {
    const readback = readbacksByMessageIndex.get(index);
    if (!readback) return message;
    const rawText = readback.message.message;
    return {
      ...message,
      speaker: readback.message.name || message.speaker,
      rawText,
      text: message.role === 'assistant' ? extractContextReply(rawText) || rawText : rawText,
      tavernMessageId: readback.locator.lastKnownMessageId,
      hostLocator: readback.locator,
    };
  });
  return {
    status: 'verified',
    messages: reconciled,
    issues: [],
    branchId,
    repairedLocatorCount: Math.max(
      repairedHiddenCount,
      [...readbacksByMessageIndex.values()].filter(readback => readback.repaired).length,
    ),
  };
}
