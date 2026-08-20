// src/islandmilfcode/scripts/verify-shujuku-v2-adapter-lifecycle.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// src/islandmilfcode/shujuku/adapter.ts
var PROTOCOL_VERSION = 1;
var REQUEST_EVENT = "islandmilfcode:shujuku-relay:request:v1";
var RESPONSE_EVENT = "islandmilfcode:shujuku-relay:response:v1";
var PROGRESS_ACK_EVENT = "islandmilfcode:shujuku-relay:progress-ack:v1";
var CANCEL_EVENT = "islandmilfcode:shujuku-relay:cancel:v1";
var RELAY_BACKEND = "islandmilfcode";
var READ_TIMEOUT_MS = 1e4;
var VIRTUAL_TURN_TIMEOUT_MS = 3e5;
var activeVirtualRelays = /* @__PURE__ */ new Map();
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function stableJson(value) {
  return JSON.stringify(stableValue(value));
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : stableJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function createRequestId(action) {
  const random = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `islandmilfcode-shujuku-${action}-${random}`;
}
function getEventApi(win2) {
  const candidates = [];
  try {
    candidates.push(win2);
  } catch {
  }
  try {
    candidates.push(globalThis);
  } catch {
  }
  for (const candidate of candidates) {
    if (typeof candidate?.eventEmit === "function" && typeof candidate?.eventOn === "function") {
      return {
        eventEmit: candidate.eventEmit.bind(candidate),
        eventOn: candidate.eventOn.bind(candidate)
      };
    }
    const helper = candidate?.TavernHelper;
    if (isRecord(helper) && typeof helper.eventEmit === "function" && typeof helper.eventOn === "function") {
      return {
        eventEmit: helper.eventEmit.bind(helper),
        eventOn: helper.eventOn.bind(helper)
      };
    }
  }
  return null;
}
function relayError(response, action) {
  const error = response.error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "SHUJUKU_RELAY_FAILED";
  const message = isRecord(error) && typeof error.message === "string" ? error.message : `shujuku \u8F6C\u53D1\u6865\u62D2\u7EDD ${action}`;
  const result2 = new Error(message);
  Object.assign(result2, { code });
  return result2;
}
async function requestRelay(win2, action, fields = {}, timeoutMs = READ_TIMEOUT_MS, onProgress, generationId) {
  const api = getEventApi(win2);
  if (!api) throw new Error("Tavern Helper \u4E8B\u4EF6\u63A5\u53E3\u4E0D\u53EF\u7528\uFF1B\u8BF7\u628A IslandMilfCode \u6570\u636E\u5E93\u8F6C\u53D1\u6865\u7ED1\u5B9A\u5230\u5F53\u524D\u89D2\u8272");
  const requestId = createRequestId(action);
  if (generationId && activeVirtualRelays.has(generationId)) {
    throw new Error(`shujuku generationId \u6B63\u5728\u6267\u884C\u4E2D\uFF1A${generationId}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription;
    let progressChain = Promise.resolve();
    let timer;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.stop?.();
      if (generationId && activeVirtualRelays.get(generationId)?.requestId === requestId) {
        activeVirtualRelays.delete(generationId);
      }
    };
    const cancel = () => {
      if (settled) return;
      cleanup();
      reject(new Error(`shujuku \u865A\u62DF\u56DE\u5408\u5DF2\u53D6\u6D88\uFF1A${generationId ?? requestId}`));
    };
    if (generationId) activeVirtualRelays.set(generationId, { requestId, cancel, eventEmit: api.eventEmit });
    timer = globalThis.setTimeout(() => {
      if (generationId) {
        void Promise.resolve(api.eventEmit(CANCEL_EVENT, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          action,
          backend: RELAY_BACKEND,
          generationId,
          reason: "relay-timeout"
        })).catch(() => void 0);
      }
      cleanup();
      reject(new Error(`shujuku \u8F6C\u53D1\u6865\u672A\u54CD\u5E94\uFF1A${action}`));
    }, timeoutMs);
    subscription = api.eventOn(RESPONSE_EVENT, async (...args) => {
      const response = args[0];
      if (!isRecord(response) || response.protocolVersion !== PROTOCOL_VERSION || response.requestId !== requestId || response.action !== action || response.backend !== "shujuku-role-bridge") return;
      if (response.progress === true) {
        const phase = typeof response.phase === "string" ? response.phase : "";
        progressChain = progressChain.then(async () => {
          if (settled) return;
          try {
            const acknowledgement = await onProgress?.(phase, response.result);
            await api.eventEmit(PROGRESS_ACK_EVENT, {
              protocolVersion: PROTOCOL_VERSION,
              requestId,
              action,
              backend: RELAY_BACKEND,
              phase,
              ok: true,
              result: acknowledgement === void 0 ? null : cloneJson(acknowledgement)
            });
          } catch (error) {
            try {
              await api.eventEmit(PROGRESS_ACK_EVENT, {
                protocolVersion: PROTOCOL_VERSION,
                requestId,
                action,
                backend: RELAY_BACKEND,
                phase,
                ok: false,
                error: {
                  code: "PLANNING_PROJECTION_FAILED",
                  message: error instanceof Error ? error.message : String(error)
                }
              });
            } catch {
            }
            cleanup();
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            reject(normalizedError);
          }
        });
        await progressChain;
        return;
      }
      try {
        await progressChain;
        if (settled) return;
        cleanup();
        if (response.ok === true) resolve(response.result);
        else reject(relayError(response, action));
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    Promise.resolve(api.eventEmit(REQUEST_EVENT, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      action,
      ...fields
    })).catch((error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
async function cancelShujukuVirtualTurn(generationId) {
  const key = String(generationId ?? "").trim();
  if (!key) return;
  const active = activeVirtualRelays.get(key);
  if (!active) return;
  const notification = Promise.resolve(active.eventEmit(CANCEL_EVENT, {
    protocolVersion: PROTOCOL_VERSION,
    requestId: active.requestId,
    action: "generateVirtual",
    backend: RELAY_BACKEND,
    generationId: key,
    reason: "cancelled-by-user"
  })).catch(() => void 0);
  active.cancel();
  void notification;
}
async function normalizeVirtualTurnResult(value) {
  if (!isRecord(value) || typeof value.rawText !== "string" || !value.rawText.trim()) {
    throw new Error("shujuku \u865A\u62DF\u56DE\u5408\u6CA1\u6709\u8FD4\u56DE\u5B8C\u6574\u6B63\u6587");
  }
  if (value.planningObserved !== true || value.databaseCommitted !== true) {
    throw new Error(
      `shujuku \u865A\u62DF\u56DE\u5408\u672A\u5B8C\u6210\u5FC5\u8981\u63D0\u4EA4\uFF1Aplanning=${String(value.planningObserved)} database=${String(value.databaseCommitted)}`
    );
  }
  const rawTable = isRecord(value.tableSnapshot) ? value.tableSnapshot : null;
  const table = rawTable && isRecord(rawTable.tables) && Object.keys(rawTable.tables).length > 0 && typeof rawTable.tableHash === "string" && rawTable.tableHash.trim().length > 0 && typeof rawTable.capturedAt === "string" ? {
    ...cloneJson(rawTable),
    tables: cloneJson(rawTable.tables)
  } : void 0;
  if (!table) throw new Error("shujuku \u865A\u62DF\u56DE\u5408\u7F3A\u5C11\u8868\u5FEB\u7167");
  const expectedHash = await sha256(table.tables);
  if (expectedHash !== table.tableHash) throw new Error("shujuku \u865A\u62DF\u56DE\u5408\u8868\u5FEB\u7167 hash \u4E0D\u5339\u914D");
  if (!isRecord(value.diagnostics) || value.diagnostics.adapterRestored !== true) {
    throw new Error("shujuku \u865A\u62DF runtime \u672A\u786E\u8BA4\u6062\u590D");
  }
  return {
    rawText: value.rawText,
    ...typeof value.plannedText === "string" && value.plannedText.trim() ? { plannedText: value.plannedText } : {},
    ...isRecord(value.userPluginData) ? { userPluginData: cloneJson(value.userPluginData) } : {},
    ...isRecord(value.assistantPluginData) ? { assistantPluginData: cloneJson(value.assistantPluginData) } : {},
    tableSnapshot: table,
    planningObserved: value.planningObserved,
    databaseCommitted: value.databaseCommitted,
    diagnostics: isRecord(value.diagnostics) ? cloneJson(value.diagnostics) : {}
  };
}
function normalizeVirtualPlanningProgress(value) {
  if (!isRecord(value) || value.planningObserved !== true || typeof value.plannedText !== "string" || !value.plannedText.trim()) {
    throw new Error("shujuku \u865A\u62DF\u56DE\u5408\u6536\u5230\u65E0\u6548\u7684\u89C4\u5212\u8FDB\u5EA6");
  }
  return {
    plannedText: value.plannedText,
    ...isRecord(value.userPluginData) ? { userPluginData: cloneJson(value.userPluginData) } : {},
    planningObserved: true
  };
}
async function runShujukuVirtualTurn(win2, input2, callbacks) {
  if (typeof input2.generationId !== "string" || !input2.generationId.trim()) {
    throw new Error("shujuku \u865A\u62DF\u56DE\u5408\u7F3A\u5C11 generationId");
  }
  if (typeof input2.userInput !== "string" || !input2.userInput.trim()) {
    throw new Error("shujuku \u865A\u62DF\u56DE\u5408\u7F3A\u5C11 userInput");
  }
  if (!Array.isArray(input2.messages)) throw new Error("shujuku \u865A\u62DF\u56DE\u5408\u6D88\u606F\u4E0D\u662F\u6570\u7EC4");
  const currentUsers = input2.messages.filter((message) => message?.role === "user" && message.current === true);
  if (currentUsers.length !== 1 || input2.messages[input2.messages.length - 1] !== currentUsers[0]) {
    throw new Error("shujuku \u865A\u62DF\u56DE\u5408\u5FC5\u987B\u628A\u552F\u4E00\u5F53\u524D user \u653E\u5728\u6D88\u606F\u672B\u5C3E");
  }
  const result2 = await requestRelay(
    win2,
    "generateVirtual",
    {
      inputJson: JSON.stringify({
        rootText: input2.rootText ?? "",
        messages: input2.messages,
        userInput: input2.userInput,
        systemPrompt: input2.systemPrompt ?? "",
        generationId: input2.generationId,
        mode: input2.mode ?? "turn"
      })
    },
    VIRTUAL_TURN_TIMEOUT_MS,
    async (phase, progress) => {
      if (phase !== "planning") return { projectionCommitted: true };
      const normalized = normalizeVirtualPlanningProgress(progress);
      const acknowledgement = await callbacks.onPlanningReady(normalized);
      if (!isRecord(acknowledgement) || acknowledgement.projectionCommitted !== true || typeof acknowledgement.bodyContext !== "string" || !acknowledgement.bodyContext.trim()) {
        throw new Error("shujuku \u89C4\u5212\u6295\u5F71\u6CA1\u6709\u8FD4\u56DE\u5DF2\u63D0\u4EA4\u7684\u6B63\u6587\u4E0A\u4E0B\u6587");
      }
      return {
        bodyContext: acknowledgement.bodyContext.trim(),
        projectionCommitted: true
      };
    },
    input2.generationId
  );
  return normalizeVirtualTurnResult(result2);
}
var tableOperationTail = Promise.resolve();

// src/islandmilfcode/scripts/verify-shujuku-v2-adapter-lifecycle.ts
var REQUEST_EVENT2 = "islandmilfcode:shujuku-relay:request:v1";
var RESPONSE_EVENT2 = "islandmilfcode:shujuku-relay:response:v1";
var PROGRESS_ACK_EVENT2 = "islandmilfcode:shujuku-relay:progress-ack:v1";
var CANCEL_EVENT2 = "islandmilfcode:shujuku-relay:cancel:v1";
var listeners = /* @__PURE__ */ new Map();
var order = [];
var acknowledgements = [];
var cancellations = [];
function eventOn(name, listener) {
  const group = listeners.get(name) ?? /* @__PURE__ */ new Set();
  group.add(listener);
  listeners.set(name, group);
  return { stop: () => group.delete(listener) };
}
async function eventEmit(name, ...args) {
  for (const listener of [...listeners.get(name) ?? []]) await listener(...args);
}
eventOn(PROGRESS_ACK_EVENT2, (acknowledgement) => {
  order.push("ack");
  acknowledgements.push(acknowledgement);
});
eventOn(CANCEL_EVENT2, (cancellation) => {
  cancellations.push(cancellation);
});
eventOn(CANCEL_EVENT2, () => new Promise(() => void 0));
var tables = { story: { revision: 2 } };
var tableHash = `sha256:${createHash("sha256").update(JSON.stringify(tables)).digest("hex")}`;
var requestCount = 0;
eventOn(REQUEST_EVENT2, async (request) => {
  requestCount += 1;
  if (requestCount > 1) return new Promise(() => void 0);
  await eventEmit(RESPONSE_EVENT2, {
    protocolVersion: 1,
    requestId: request.requestId,
    action: request.action,
    backend: "shujuku-role-bridge",
    ok: true,
    progress: true,
    phase: "planning",
    result: {
      plannedText: "<kirihime_review>camera:\n- present: \u52A0\u85E4\u60E0</kirihime_review>",
      userPluginData: { qrf_plot: "QRF_COMMITTED" },
      planningObserved: true
    }
  });
  order.push("final");
  await eventEmit(RESPONSE_EVENT2, {
    protocolVersion: 1,
    requestId: request.requestId,
    action: request.action,
    backend: "shujuku-role-bridge",
    ok: true,
    result: {
      rawText: "<content>\u6B63\u6587</content>",
      plannedText: "<kirihime_review>camera:\n- present: \u52A0\u85E4\u60E0</kirihime_review>",
      userPluginData: { qrf_plot: "QRF_COMMITTED" },
      assistantPluginData: { TavernDB_ACU_IsolatedData: { active: { storageFrame: { version: 2 } } } },
      tableSnapshot: {
        capturedAt: "2026-08-10T00:00:00.000Z",
        tableHash,
        tables
      },
      planningObserved: true,
      databaseCommitted: true,
      diagnostics: { adapterRestored: true }
    }
  });
});
var win = { eventOn, eventEmit };
var input = {
  rootText: "ROOT",
  messages: [{ role: "user", text: "\u7EE7\u7EED", current: true }],
  userInput: "\u7EE7\u7EED",
  systemPrompt: "SYSTEM",
  generationId: "adapter-lifecycle-1"
};
var result = await runShujukuVirtualTurn(win, input, {
  onPlanningReady: async (progress) => {
    order.push("callback:start");
    assert.equal(progress.userPluginData?.qrf_plot, "QRF_COMMITTED");
    await Promise.resolve();
    order.push("callback:end");
    return {
      bodyContext: "SELECTED_ROLE_ZERO\nCURRENT_PLOT",
      projectionCommitted: true
    };
  }
});
assert.equal(result.databaseCommitted, true);
assert.deepEqual(
  order,
  ["callback:start", "callback:end", "ack", "final"],
  "contract: the relay final response cannot overtake the awaited planning projection acknowledgement"
);
assert.equal(acknowledgements.length, 1);
assert.equal(acknowledgements[0].ok, true);
assert.equal(acknowledgements[0].result.bodyContext, "SELECTED_ROLE_ZERO\nCURRENT_PLOT");
assert.equal(acknowledgements[0].result.projectionCommitted, true);
var cancelled = runShujukuVirtualTurn(win, {
  ...input,
  generationId: "adapter-lifecycle-cancelled"
}, {
  onPlanningReady: async () => ({
    bodyContext: "CANCELLED_BODY_CONTEXT",
    projectionCommitted: true
  })
});
await Promise.resolve();
var cancelledContract = assert.rejects(
  cancelled,
  /cancel/i,
  "contract: cancelling a generation rejects its outstanding relay instead of permitting a late publish"
);
var cancelOutcome = await Promise.race([
  cancelShujukuVirtualTurn("adapter-lifecycle-cancelled").then(() => "resolved"),
  new Promise((resolve) => setTimeout(() => resolve("timed-out"), 250))
]);
assert.equal(cancelOutcome, "resolved", "contract: a stalled cancellation listener cannot delay local queue release");
await cancelledContract;
assert.equal(cancellations.length, 1);
assert.equal(cancellations[0].generationId, "adapter-lifecycle-cancelled");
console.info("[shujuku-v2-adapter-lifecycle] 11 contracts passed");
