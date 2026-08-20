import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cancelShujukuVirtualTurn,
  runShujukuVirtualTurn,
  type ShujukuVirtualTurnInput,
} from '../shujuku/adapter.ts';
import type { TavernWindow } from '../types';

const REQUEST_EVENT = 'islandmilfcode:shujuku-relay:request:v1';
const RESPONSE_EVENT = 'islandmilfcode:shujuku-relay:response:v1';
const PROGRESS_ACK_EVENT = 'islandmilfcode:shujuku-relay:progress-ack:v1';
const CANCEL_EVENT = 'islandmilfcode:shujuku-relay:cancel:v1';
const listeners = new Map<string, Set<(...args: any[]) => unknown>>();
const order: string[] = [];
const acknowledgements: Record<string, any>[] = [];
const cancellations: Record<string, any>[] = [];

function eventOn(name: string, listener: (...args: any[]) => unknown) {
  const group = listeners.get(name) ?? new Set();
  group.add(listener);
  listeners.set(name, group);
  return { stop: () => group.delete(listener) };
}

async function eventEmit(name: string, ...args: any[]) {
  for (const listener of [...(listeners.get(name) ?? [])]) await listener(...args);
}

eventOn(PROGRESS_ACK_EVENT, acknowledgement => {
  order.push('ack');
  acknowledgements.push(acknowledgement);
});
eventOn(CANCEL_EVENT, cancellation => {
  cancellations.push(cancellation);
});
// A third-party event listener is allowed to stall. Local cancellation must
// still release Island immediately after the cancellation event is invoked.
eventOn(CANCEL_EVENT, () => new Promise(() => undefined));

const tables = { story: { revision: 2 } };
const tableHash = `sha256:${createHash('sha256').update(JSON.stringify(tables)).digest('hex')}`;
let requestCount = 0;
eventOn(REQUEST_EVENT, async request => {
  requestCount += 1;
  if (requestCount > 1) return new Promise(() => undefined);
  const relayedInput = JSON.parse(request.inputJson);
  assert.deepEqual(relayedInput.isolationKeyHandoff, {
    sourceIsolationKey: 'adapter-isolation',
    targetIsolationKey: 'adapter-isolation',
  }, 'contract: the adapter relays the explicit isolationKey handoff without inference');
  await eventEmit(RESPONSE_EVENT, {
    protocolVersion: 1,
    requestId: request.requestId,
    action: request.action,
    backend: 'shujuku-role-bridge',
    ok: true,
    progress: true,
    phase: 'planning',
    result: {
      plannedText: '<kirihime_review>camera:\n- present: 加藤惠</kirihime_review>',
      userPluginData: { qrf_plot: 'QRF_COMMITTED' },
      planningObserved: true,
    },
  });
  order.push('final');
  await eventEmit(RESPONSE_EVENT, {
    protocolVersion: 1,
    requestId: request.requestId,
    action: request.action,
    backend: 'shujuku-role-bridge',
    ok: true,
    result: {
      rawText: '<content>正文</content>',
      plannedText: '<kirihime_review>camera:\n- present: 加藤惠</kirihime_review>',
      userPluginData: { qrf_plot: 'QRF_COMMITTED' },
      assistantPluginData: { TavernDB_ACU_IsolatedData: { active: { storageFrame: { version: 2 } } } },
      tableSnapshot: {
        capturedAt: '2026-08-10T00:00:00.000Z',
        tableHash,
        tables,
      },
      planningObserved: true,
      databaseCommitted: true,
      diagnostics: { adapterRestored: true },
    },
  });
});

const win = { eventOn, eventEmit } as unknown as TavernWindow;
const input: ShujukuVirtualTurnInput = {
  rootMessage: {
    role: 'assistant',
    text: 'ROOT',
    logicalId: 'root-assistant',
    exchangeId: null,
    floorIndex: null,
  },
  messages: [{
    role: 'user',
    text: '继续',
    current: true,
    logicalId: 'current-user',
    exchangeId: 'current-exchange',
    floorIndex: 1,
  }],
  promptMessages: [],
  assistantTarget: {
    logicalId: 'current-assistant',
    exchangeId: 'current-exchange',
    floorIndex: 1,
  },
  userInput: '继续',
  systemPrompt: 'SYSTEM',
  generationId: 'adapter-lifecycle-1',
  isolationKeyHandoff: {
    sourceIsolationKey: 'adapter-isolation',
    targetIsolationKey: 'adapter-isolation',
  },
};

const result = await runShujukuVirtualTurn(win, input, {
  onPlanningReady: async progress => {
    order.push('callback:start');
    assert.equal(progress.userPluginData?.qrf_plot, 'QRF_COMMITTED');
    await Promise.resolve();
    order.push('callback:end');
    return {
      bodyContext: 'SELECTED_ROLE_ZERO\nCURRENT_PLOT',
      projectionCommitted: true,
    };
  },
});

assert.equal(result.databaseCommitted, true);
assert.deepEqual(order, ['callback:start', 'callback:end', 'ack', 'final'],
  'contract: the relay final response cannot overtake the awaited planning projection acknowledgement');
assert.equal(acknowledgements.length, 1);
assert.equal(acknowledgements[0].ok, true);
assert.equal(acknowledgements[0].result.bodyContext, 'SELECTED_ROLE_ZERO\nCURRENT_PLOT');
assert.equal(acknowledgements[0].result.projectionCommitted, true);

const cancelled = runShujukuVirtualTurn(win, {
  ...input,
  generationId: 'adapter-lifecycle-cancelled',
}, {
  onPlanningReady: async () => ({
    bodyContext: 'CANCELLED_BODY_CONTEXT',
    projectionCommitted: true,
  }),
});
await Promise.resolve();
const cancelledContract = assert.rejects(cancelled, /cancel/i,
  'contract: cancelling a generation rejects its outstanding relay instead of permitting a late publish');
const cancelOutcome = await Promise.race([
  cancelShujukuVirtualTurn('adapter-lifecycle-cancelled').then(() => 'resolved'),
  new Promise(resolve => setTimeout(() => resolve('timed-out'), 250)),
]);
assert.equal(cancelOutcome, 'resolved',
  'contract: a stalled cancellation listener cannot delay local queue release');
await cancelledContract;
assert.equal(cancellations.length, 1);
assert.equal(cancellations[0].generationId, 'adapter-lifecycle-cancelled');

console.info('[shujuku-v2-adapter-lifecycle] 11 contracts passed');
