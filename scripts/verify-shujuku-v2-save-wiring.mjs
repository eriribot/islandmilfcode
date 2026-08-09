import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = fs.readFileSync(path.join(root, 'state', 'archive-repository.ts'), 'utf8');
const backup = fs.readFileSync(path.join(root, 'state', 'tavern-file-backup.ts'), 'utf8');
const saves = fs.readFileSync(path.join(root, 'state', 'saves.ts'), 'utf8');
const types = fs.readFileSync(path.join(root, 'types.ts'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
const actions = fs.readFileSync(path.join(root, 'actions', 'index.ts'), 'utf8');
const opening = fs.readFileSync(path.join(root, 'actions', 'opening.ts'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'shujuku', 'adapter.ts'), 'utf8');
const phone = fs.readFileSync(path.join(root, 'phone', 'render.ts'), 'utf8');
const render = fs.readFileSync(path.join(root, 'render.ts'), 'utf8');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `contract fixture missing: ${start}`);
  assert.notEqual(endIndex, -1, `contract fixture missing: ${end}`);
  return source.slice(startIndex, endIndex);
}

const commit = section(archive, 'export function commitRuntimeArchive(', 'export function migrateLegacySaveToArchive(');
assert.match(commit, /mergeRuntimeCompatibility[\s\S]*putHashed\('compatibility'[\s\S]*compatibilityHash/,
  'contract: runtime commits publish the current compatibility checkpoint');

const publish = section(archive, 'async function publish(', 'export function commitRuntimeArchive(');
assert.match(publish, /resolvedCompatibility !== undefined[\s\S]*applyArchiveShujukuCompatibilityToRuntimeFlags\(gameState\.runtimeFlags, resolvedCompatibility\?\.shujuku\)/,
  'contract: an explicit null compatibility clears the shujuku mirrors before the archived state block is hashed');
assert.match(publish, /resolvedCompatibility === null\s*\?\s*undefined\s*:\s*input\.previous\?\.root\.compatibilityHash/,
  'contract: an explicit null compatibility cannot inherit the stale root compatibility hash');

const fork = section(archive, 'export function forkArchiveSave(', 'export function deleteArchiveSave(');
assert.match(fork, /prepareArchiveCompatibilityForFork[\s\S]*applyArchiveShujukuCompatibilityToRuntimeFlags/,
  'contract: fork rewrites both the compatibility block and state-block mirror');

const portable = section(archive, 'export async function exportPortableArchive(', 'export async function exportReadonlyFutureArchive(');
assert.match(portable, /checkpoint \$\{hash\} is missing[\s\S]*compatibilityCheckpoints/,
  'contract: portable export includes every floor-bound compatibility checkpoint');

const importArchive = section(archive, 'export function importPortableArchive(', 'export function markArchiveLocalBackupResult(');
assert.match(importArchive, /missing its compatibility block/,
  'contract: import fails closed when the root-declared compatibility block is absent');
assert.match(importArchive, /compatibility: input\.compatibility \?\? null/,
  'contract: an import without compatibility clears destination state instead of inheriting it');

const rollback = section(archive, 'export function truncateArchiveFromAssistant(', 'export function replaceArchiveFloorAssistant(');
assert.match(rollback, /getFloorCompatibility\(target\.beforeTurnState\)[\s\S]*getFloorCompatibility\(target\.afterTurnState\)/,
  'contract: both rollback routes restore their floor-bound compatibility checkpoint');

assert.match(backup, /shujukuCompatibilityHash[\s\S]*compatibilityCheckpoints/,
  'contract: local Tavern archive transport includes rollback compatibility checkpoints');
assert.match(saves, /preserveMalformedEmptyMemory[\s\S]*!preserveMalformedEmptyMemory/,
  'contract: malformed memory input cannot trigger an empty normalization write-back');
assert.match(types, /shujukuCompatibilityHash\?: string/,
  'contract: floors store a compact checkpoint hash instead of copying table snapshots');
assert.match(index, /receipt\.shujukuCompatibility !== undefined[\s\S]*applyArchiveShujukuCompatibilityToRuntimeFlags/,
  'contract: a promoted fork/commit updates the active runtime branch mirror');

const rerollRestore = section(index, 'async function commitShujukuRerollCheckpoint(', 'function isExpectedCommittedShujukuCompatibility(');
assert.doesNotMatch(rerollRestore, /imported\.tableSnapshot\.tableHash\s*!==\s*snapshot\.tableHash/,
  'contract: reroll accepts a CDN-normalized readback after the transaction preserves every archived field');
assert.match(rerollRestore, /lastTableHash:\s*imported\.tableSnapshot\.tableHash[\s\S]*tableSnapshot:\s*imported\.tableSnapshot/,
  'contract: reroll persists the normalized CDN snapshot as the new authority');

const rollbackReader = section(index, 'async function rollbackReaderInputWithArchive(', 'async function rollbackToReaderInput(');
const baselineGuard = rollbackReader.indexOf('if (!shujukuBaselinePreparation)');
const timelineRollback = rollbackReader.indexOf('const target = await rollbackConversation');
assert(baselineGuard >= 0 && timelineRollback >= 0 && baselineGuard < timelineRollback,
  'contract: unavailable shujuku baselines stop before timeline or archive rollback');
const timeAuthorityGuard = rollbackReader.indexOf('!hasAuthoritativeFloorStatusData(floor.beforeTurnState)');
assert(timeAuthorityGuard >= 0 && timeAuthorityGuard < timelineRollback,
  'contract: automatic reroll rejects a fabricated time baseline before timeline mutation');

const rerunReader = section(index, 'async function rerunReaderMessage(', 'async function deleteReaderFloor(');
assert.match(rerunReader, /requireAuthoritativeStatusBaseline:\s*true/,
  'contract: reroll requires an authoritative before-turn time snapshot');
assert.match(rerunReader, /baseline\.kind === 'pre_handoff'[\s\S]*rerollRoute = 'island'[\s\S]*commitArchive\(null\)/,
  'contract: pre-handoff reroll atomically restores the historical Island route');
assert.doesNotMatch(rerunReader, /原生模式不再根据本地记忆库构造历史表/,
  'contract: pre-handoff reroll no longer stops before restoring the historical time baseline');

const virtualTurn = section(adapter, 'export async function runShujukuVirtualTurn(', 'function findSubsetDifference(');
assert.match(virtualTurn, /generateVirtual[\s\S]*VIRTUAL_TURN_TIMEOUT_MS/,
  'contract: shujuku narrative turns use the virtual relay endpoint');
assert.match(virtualTurn, /唯一当前 user[\s\S]*消息末尾/,
  'contract: virtual turns bind exactly one current user at the end of the timeline');
const normalizeVirtualTurn = section(adapter, 'async function normalizeVirtualTurnResult(', '/** Run one shujuku-owned');
assert.doesNotMatch(normalizeVirtualTurn, /未完成规划与数据库提交/,
  'contract: missing planning or database evidence cannot discard a returned narrative body');
assert.doesNotMatch(normalizeVirtualTurn, /(?:planningObserved|databaseCommitted)\s*!==\s*true/,
  'contract: adapter normalization keeps qrf/table booleans as independent evidence states');
const shujukuLogicalCommit = section(actions, '// v2 keeps the logical assistant in #0 state', '} else {');
assert.doesNotMatch(shujukuLogicalCommit, /未提供规划或数据库提交证据/,
  'contract: the main flow accepts a complete shujuku narrative independently of qrf/table status');
assert.doesNotMatch(shujukuLogicalCommit, /!\s*shujukuTurnResult\.(?:planningObserved|databaseCommitted)/,
  'contract: qrf/table booleans cannot re-enter the narrative acceptance gate');
assert.match(shujukuLogicalCommit, /databaseCommitted[\s\S]*tableSnapshot/,
  'contract: only a verified database commit advances the authoritative table snapshot');
assert.match(render, /qrf_plot[\s\S]*qrf_plot_tasks[\s\S]*qrf_plot_preset[\s\S]*reader-shujuku-plan/,
  'contract: the reader projects this turn qrf fields onto its logical user floor');
const restoreStart = adapter.indexOf('export async function restoreShujukuTablesForHandoff(');
assert.notEqual(restoreStart, -1, 'contract fixture missing: restoreShujukuTablesForHandoff');
const restoreTables = adapter.slice(restoreStart);
assert.doesNotMatch(restoreTables, /current\.tableHash\s*!==\s*snapshot\.tableHash/,
  'contract: restore accepts additive normalization by the global CDN');
assert.match(restoreTables, /findSubsetDifference\(snapshot\.tables, current\.tables\)/,
  'contract: restore still rejects changes to every archived field, array, and cell');

const routeToggle = section(index, '[data-field="shujuku-route-enabled"]', '[data-action="manual-save"]');
assert.match(routeToggle, /previousIsolationKey[\s\S]*activeIsolationKey \|\| previousIsolationKey/,
  'contract: a failed runtime probe retains the prior isolation binding as diagnostic state');
assert.doesNotMatch(routeToggle, /delete reviewCompatibility\.isolationKey/,
  'contract: a failed runtime probe does not erase the prior isolation binding');
assert.match(phone, /shujukuReviewReason[\s\S]*`需复核：\$\{shujukuReviewReason\}`/,
  'contract: the settings UI reports the actual shujuku review failure');
assert.doesNotMatch(phone, /需复核；未检测到 shujuku 隔离标识/,
  'contract: the settings UI does not invent a missing-isolation diagnosis');
assert.match(actions, /inspectCommittedShujukuBinding\(state\.runtimeFlags/,
  'contract:正文提交 uses the shared committed binding decision');
assert.match(actions, /readShujukuRouteDecision[\s\S]*route:\s*'blocked'[\s\S]*shujuku 路线需要复核/,
  'contract: a requested but invalid shujuku route fails closed instead of falling back to Island');
assert.match(opening, /inspectCommittedShujukuBinding\(state\.runtimeFlags/,
  'contract: AI opening uses the shared committed binding decision');
assert.match(opening, /runShujukuVirtualTurn[\s\S]*mode:\s*'opening'/,
  'contract: shujuku opening uses the virtual relay instead of host generate');
assert.match(phone, /inspectCommittedShujukuBinding\(state\.runtimeFlags/,
  'contract: settings UI uses the shared committed binding decision');
assert.match(index, /function captureShujukuRerollBinding\(\)[\s\S]*inspectCommittedShujukuBinding\(state\.runtimeFlags/,
  'contract: reroll uses the shared committed binding decision');
assert.match(index, /tableSnapshot:\s*ShujukuTableSnapshot;[\s\S]*tableHash:\s*input\.tableSnapshot\.tableHash/,
  'contract: a committed handoff cannot be constructed without its immutable table baseline');
assert.match(routeToggle, /tableSnapshot:\s*probeTableSnapshot[\s\S]*shujukuTableSnapshot = committed\.tableSnapshot/,
  'contract: enabling shujuku persists the probed before-turn table baseline');
assert.match(routeToggle, /shujuku 未返回可持久化的轮前表快照，已拒绝建立连接/,
  'contract: a connection without a before-turn table baseline fails closed');
assert.match(routeToggle, /routeStatePersisted[\s\S]*previousHandoff[\s\S]*previousTableSnapshot[\s\S]*已恢复切换前状态/,
  'contract: a failed toggle save restores the prior in-memory binding');

console.info('[shujuku-v2-save-wiring] 36 contracts passed');
