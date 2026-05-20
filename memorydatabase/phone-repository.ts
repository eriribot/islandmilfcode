import type { PhoneChatMessage } from '../types';
import { commitBatch, isPhoneMessageIndexed } from './upsert';
import type { CommitSource, IslandMemoryDB } from './types';

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
    if (isPhoneMessageIndexed(db, message.id)) return;
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
          },
        ],
      },
    });
  });
}
