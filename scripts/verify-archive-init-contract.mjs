import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
const backupSource = fs.readFileSync(path.join(root, 'state', 'tavern-file-backup.ts'), 'utf8');
const archiveSource = fs.readFileSync(path.join(root, 'state', 'archive-repository.ts'), 'utf8');
const imageSource = fs.readFileSync(path.join(root, 'state', 'image-assets.ts'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(root, 'savesolt', 'IslandMilfCode本机存档桥.js'), 'utf8');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `contract fixture missing: ${start}`);
  assert.notEqual(endIndex, -1, `contract fixture missing: ${end}`);
  return source.slice(startIndex, endIndex);
}

const bridgeInstall = section(
  backupSource,
  'export function installArchiveBridgeSync()',
  'export async function deleteTavernArchiveSave',
);
assert.match(
  bridgeInstall,
  /probeTavernArchiveCapability\s*\(/,
  'contract: installing the bridge must probe the local islandmilfcode target before background sync',
);
assert.match(
  bridgeInstall,
  /subscribeArchiveCommits\s*\(/,
  'contract: every committed browser revision must be mirrored into user/files/islandmilfcode',
);

const manualBackup = section(
  backupSource,
  'export async function persistArchiveSaveToTavernFiles',
  'export async function readTavernArchiveBackup',
);
assert.match(
  manualBackup,
  /enqueueArchiveSync\(event, true, 'manual'/,
  'contract: explicit local backup must retain the archive sync path',
);

const localBackupList = section(
  backupSource,
  'export async function listTavernFileBackups',
  'export async function writeTavernFileBackup',
);
assert.doesNotMatch(
  localBackupList,
  /probeTavernArchiveCapability\s*\(|requestLegacy\s*\(/,
  'contract: listing local backups must remain read-only',
);
assert.match(
  localBackupList,
  /requestBridge<\{[\s\S]*registry: unknown;[\s\S]*\}>\('v3-read-registry'\)/,
  'contract: local backup listing must read the v3 registry directly',
);

const registryProjection = section(
  backupSource,
  'function registryEntriesToPublic',
  'export async function listTavernFileBackups',
);
assert.doesNotMatch(
  registryProjection,
  /user\/files\/islandmilfcode\/system\/islandmilfcode-archive-registry-v3\.json/,
  'contract: the title list must not claim a categorized path when the host negotiated flat-v3',
);

const registryRead = section(
  bridgeSource,
  'async function readArchiveRegistryFile()',
  'async function uploadJsonFile',
);
assert.match(
  registryRead,
  /archiveLayout === 'flat-v3'[\s\S]*\[ARCHIVE_REGISTRY_FILE, ARCHIVE_REGISTRY_PATH\]/,
  'contract: flat-v3 must read the current root registry before a stale categorized registry',
);
assert.match(
  registryRead,
  /archiveRegistryFreshness/,
  'contract: an unprobed bridge must select the freshest valid registry when both layouts exist',
);

const registryDispatch = section(
  bridgeSource,
  "case 'v3-read-registry':",
  'default:',
);
assert.match(
  registryDispatch,
  /storagePath:\s*archiveRegistryStoragePath\(\)/,
  'contract: registry reads must report the path selected by the negotiated layout',
);

const enterSave = section(indexSource, 'async function enterSave(', 'async function returnToTitle()');
assert.doesNotMatch(
  enterSave,
  /migrateLegacySaveToArchive\s*\(/,
  'contract: opening a legacy save must not migrate it into a v3 archive',
);
const firstRender = enterSave.search(/suppressRenderPersistence = true;\r?\n\s*render\(\);/);
assert.notEqual(firstRender, -1, 'contract: restore render must suppress autosave');
assert.ok(
  enterSave.indexOf('suppressRenderPersistence = false;', firstRender) > firstRender,
  'contract: autosave suppression must be released after initial restore work',
);

const render = section(indexSource, 'function render()', 'async function init(');
assert.match(
  render,
  /if \(!suppressRenderPersistence\) persistToSave\(\);/,
  'contract: render normalization persists only outside an initial restore',
);

const init = section(indexSource, 'async function init(', 'init();');
assert.equal(
  (init.match(/if \(autosaveTimer\) flushPendingAutosave\(\);/g) ?? []).length,
  2,
  'contract: hide/unload flush only an autosave that is already pending',
);

const localRestore = section(indexSource, 'async function restoreSaveFromTavernFiles()', 'function applyPlayerProfileDraftFromStatusPanel()');
assert.match(
  localRestore,
  /enterSave\(selected\.saveId, \{ archiveSource: 'local' \}\)/,
  'contract: selecting a v3 local save must enter its archive backend directly',
);
assert.doesNotMatch(
  localRestore,
  /readTavernArchiveBackup\s*\(/,
  'contract: selecting a v3 local save must not expand every chunk and image into a portable backup',
);

const archiveOpen = section(archiveSource, 'export async function openArchiveSave(', 'function validateArchiveFloorChunk');
assert.match(
  archiveOpen,
  /backend\.preferLocalRoot\(saveId\)/,
  'contract: a local save entry must resolve the Tavern registry root before reading its objects',
);
assert.match(
  archiveOpen,
  /loadAuxiliaryState === false/,
  'contract: archive opening can hydrate the bounded reader window before summary and memory blocks',
);

assert.match(
  imageSource,
  /readTavernArchiveImage\(assetId\)/,
  'contract: a missing image asset must be fetched lazily by its asset id',
);

const localRootRead = section(bridgeSource, 'async function readUsableArchiveRoot(rootHash)', 'async function probeArchiveStorage()');
assert.doesNotMatch(
  localRootRead,
  /kind: 'summary'|kind: 'memory'/,
  'contract: resolving a local root must not hydrate summary or memory blocks',
);

const requestEvent = 'islandmilfcode:tavern-backup:request:v2';
const responseEvent = 'islandmilfcode:tavern-backup:response:v2';
const registryName = 'islandmilfcode-archive-registry-v3.json';
const categorizedRegistryPath = `/user/files/islandmilfcode/system/${registryName}`;
const flatRegistryPath = `/user/files/${registryName}`;
const listeners = new Map();
const publicFiles = new Map([
  [categorizedRegistryPath, {
    format: 'islandmilfcode-archive-registry',
    formatVersion: 3,
    updatedAt: '2026-08-06T12:50:57.881Z',
    entries: { save: { saveId: 'save', revision: 30 } },
    gcTombstones: {},
    deletedSaves: {},
  }],
  [flatRegistryPath, {
    format: 'islandmilfcode-archive-registry',
    formatVersion: 3,
    updatedAt: '2026-08-06T11:07:14.221Z',
    entries: { save: { saveId: 'save', revision: 20 } },
    gcTombstones: {},
    deletedSaves: {},
  }],
]);

function eventOn(name, listener) {
  const group = listeners.get(name) ?? new Set();
  group.add(listener);
  listeners.set(name, group);
  return { stop: () => group.delete(listener) };
}

async function eventEmit(name, ...args) {
  for (const listener of [...(listeners.get(name) ?? [])]) await listener(...args);
}

async function mockFetch(input, init = {}) {
  const requestPath = String(input).split('?')[0];
  if (requestPath === '/api/files/upload') {
    const body = JSON.parse(String(init.body));
    const uploadedPath = `/user/files/${body.name}`;
    publicFiles.set(uploadedPath, JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')));
    return Response.json({ path: uploadedPath });
  }
  if (requestPath === '/api/files/delete') {
    const body = JSON.parse(String(init.body));
    const existed = publicFiles.delete(body.path);
    return new Response('', { status: existed ? 200 : 404 });
  }
  if (publicFiles.has(requestPath)) return Response.json(publicFiles.get(requestPath));
  return new Response('', { status: 404 });
}

const bridgeContext = {
  eventOn,
  eventEmit,
  fetch: mockFetch,
  SillyTavern: {
    getRequestHeaders: () => ({}),
    getCurrentChatId: () => 'contract-chat',
  },
  TextEncoder,
  Response,
  btoa,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console: { info() {}, warn() {}, error() {} },
};
vm.runInNewContext(bridgeSource, bridgeContext, { filename: 'IslandMilfCode本机存档桥.js' });

async function requestBridge(action) {
  const requestId = `contract-${action}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`bridge contract timed out: ${action}`)), 2_000);
    const subscription = eventOn(responseEvent, response => {
      if (response?.requestId !== requestId) return;
      clearTimeout(timeout);
      subscription.stop();
      if (!response.ok) reject(new Error(response.error?.message || `bridge request failed: ${action}`));
      else resolve(response.result);
    });
    void eventEmit(requestEvent, { protocolVersion: 2, requestId, action });
  });
}

const registryResult = await requestBridge('v3-read-registry');
assert.equal(
  registryResult.registry.entries.save.revision,
  30,
  'contract: an unprobed bridge reads the newest valid registry when both layouts exist',
);
assert.equal(
  registryResult.storagePath,
  `user/files/islandmilfcode/system/${registryName}`,
  'contract: an unprobed registry read reports the path it actually selected',
);
const probeResult = await requestBridge('probe');
assert.equal(probeResult.archiveLayout, 'flat-v3', 'contract: a host that ignores directory negotiates flat-v3');
assert.equal(probeResult.storagePath, `user/files/${registryName}`, 'contract: a flat probe reports its real root path');
const flatRegistryResult = await requestBridge('v3-read-registry');
assert.equal(
  flatRegistryResult.registry.entries.save.revision,
  20,
  'contract: negotiated flat-v3 reads the root registry even when a categorized copy has a newer revision',
);
assert.equal(
  publicFiles.has('/user/files/islandmilfcode-archive-probe-v3.json'),
  false,
  'contract: the fixed probe file is deleted after readback',
);
bridgeContext.__islandmilfcodeTavernBackupBridgeV2__?.stop?.();

console.info('[archive-init-contract] 24 contracts passed');
