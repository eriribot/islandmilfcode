import type { PhoneChatMessage } from '../types';
import { commitBatch } from './upsert';
import type { CommitSource, IslandMemoryDB } from './types';
import { isPhoneMessageIndexed as isPhoneMessageIndexedFromIndex } from './indexes';

class MutationQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue(fn: () => void): void {
    this.chain = this.chain
      .then(() => {
        fn();
      })
      .catch(error => {
        console.warn('[memorydb:mutation-queue]', error);
      });
  }
}

const queue = new MutationQueue();

export function indexPhoneMessage(
  db: IslandMemoryDB | null | undefined,
  message: PhoneChatMessage,
  targetId: string,
  source: CommitSource,
): void {
  if (!db) return;
  queue.enqueue(() => {
    // 使用索引优化去重检查（O(1) vs O(n)）
    if (isPhoneMessageIndexedFromIndex(db, message.id)) return;
    commitBatch(db, {
      source,
      inserts: {
        phoneMessages: [
          {
            targetId,
            role: message.role,
            messageId: message.id,
            textPreview: message.text.slice(0, 200),
            time: message.timestamp,
            ...(typeof message.floorIndex === 'number'
              ? { sourceRange: [message.floorIndex, message.floorIndex] as [number, number] }
              : {}),
          },
        ],
      },
    });
  });
}
