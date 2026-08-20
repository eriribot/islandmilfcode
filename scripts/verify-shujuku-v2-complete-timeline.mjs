import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'shujuku', 'virtual-timeline.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, console }, { filename: sourcePath });
const { buildShujukuVirtualTimeline } = module.exports;

const message = (id, role, exchangeId, text = id) => ({
  id,
  role,
  speaker: role === 'user' ? 'User' : 'Assistant',
  text,
  ...(exchangeId ? { exchangeId } : {}),
});

const archiveMessages = [message('root', 'assistant', null, 'ROOT')];
for (let turn = 1; turn <= 4; turn += 1) {
  archiveMessages.push(message(`u${turn}`, 'user', `e${turn}`));
  archiveMessages.push(message(`a${turn}`, 'assistant', `e${turn}`));
}
const currentUser = {
  ...message('u5', 'user', 'e5', 'CURRENT'),
  pluginData: { existing: true },
};
const projection = buildShujukuVirtualTimeline({
  archiveMessages,
  runtimeMessages: [
    message('u4', 'user', 'e4', 'RUNTIME_U4'),
    message('a4', 'assistant', 'e4', 'RUNTIME_A4'),
    currentUser,
    { ...message('streaming-a5', 'assistant', 'e5'), streaming: true },
  ],
  promptMessages: [
    message('u4', 'user', 'e4', 'RUNTIME_U4'),
    message('a4', 'assistant', 'e4', 'RUNTIME_A4'),
    currentUser,
  ],
  currentUserId: currentUser.id,
  currentUserPluginData: { planning: 'CURRENT_ONLY' },
});

assert.equal(projection.rootMessage.logicalId, 'root',
  'contract: the archive opening assistant remains virtual chat[0]');
assert.equal(projection.rootMessage.floorIndex, null,
  'contract: the real #0 root is not counted as a logical exchange floor');
assert.equal(projection.messages.length + 1, 10,
  'contract: four completed exchanges plus the current user and generated assistant produce ten logical messages');
assert.equal(
  projection.messages.filter(item => item.role === 'assistant').length + 1,
  5,
  'contract: the post-generation virtual timeline contains five logical assistants',
);
assert.deepEqual(
  [...projection.messages].map(item => item.logicalId),
  ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5'],
  'contract: the complete archive order survives the lazy runtime window',
);
assert.equal(projection.messages.find(item => item.logicalId === 'u4').text, 'RUNTIME_U4',
  'contract: newer runtime state overlays the same stable archive logical id');
assert.equal(projection.messages.at(-1).current, true,
  'contract: exactly the current logical user is marked at the complete timeline tail');
assert.equal(projection.messages.at(-1).pluginData.existing, true);
assert.equal(projection.messages.at(-1).pluginData.planning, 'CURRENT_ONLY');
assert.equal(projection.messages.at(-1).floorIndex, 5,
  'contract: the current user keeps the next absolute archive floor index');
assert.deepEqual(
  [...projection.promptMessages].map(item => item.logicalId),
  ['u4', 'a4'],
  'contract: the token-bounded prompt window excludes the separately supplied current user',
);
assert.equal(projection.promptMessages.some(item => item.current), false,
  'contract: user_input is never duplicated inside prompt history');

assert.throws(
  () => buildShujukuVirtualTimeline({
    archiveMessages: [message('root', 'assistant'), message('same', 'user'), message('same', 'assistant')],
    runtimeMessages: [message('same', 'user')],
    promptMessages: [],
    currentUserId: 'same',
  }),
  /logical id/i,
  'contract: duplicate stable ids fail closed instead of silently remapping ACU writes',
);

const thousandFloorArchive = [message('perf-root', 'assistant', null, 'ROOT')];
for (let turn = 1; turn < 1000; turn += 1) {
  thousandFloorArchive.push(message(`perf-u${turn}`, 'user', `perf-e${turn}`));
  thousandFloorArchive.push(message(`perf-a${turn}`, 'assistant', `perf-e${turn}`));
}
const thousandthUser = message('perf-u1000', 'user', 'perf-e1000');
const startedAt = performance.now();
const largeProjection = buildShujukuVirtualTimeline({
  archiveMessages: thousandFloorArchive,
  runtimeMessages: [thousandthUser],
  promptMessages: [message('perf-u999', 'user', 'perf-e999'), message('perf-a999', 'assistant', 'perf-e999'), thousandthUser],
  currentUserId: thousandthUser.id,
});
const elapsedMs = performance.now() - startedAt;
assert.equal(largeProjection.messages.length, 1999,
  'contract: the projection does not truncate a 1000-floor archive at the old 256-message window');
assert.equal(elapsedMs < 2000, true,
  `contract: pure 1000-floor projection completes within 2000ms (actual ${elapsedMs.toFixed(1)}ms)`);

console.info(`[shujuku-v2-complete-timeline] 16 contracts passed (${elapsedMs.toFixed(1)}ms for 1000 floors)`);
