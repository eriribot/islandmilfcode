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
assert.match(commit, /currentHandoff\.handoffId !== previousHandoffId[\s\S]*shujukuHandoffBaseline[\s\S]*stateWithCompatibility/,
  'contract: a new handoff exposes its captured table hash to the pending anchor floor writer');
const floorCompatibility = section(archive, 'export function decideArchiveFloorBeforeTurnShujukuHash(', 'function messagesToFloors(');
assert.match(floorCompatibility, /handoffBaseline\?\.userMessageId === input\.userMessageId[\s\S]*kind: 'set'/,
  'contract: a handoff anchor receives the new handoff table before-turn checkpoint even when persistence coalesces assistant completion');

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
assert.match(rollbackReader, /getArchiveFloorBeforeTurnShujukuBaseline\([\s\S]*handoffId/,
  'contract: checkpoint lookup receives the active handoff identity instead of classifying by cutoff alone');

const plainReaderRollback = section(index, 'async function rollbackToReaderInput(', 'function isV07RouteChoiceBlockingMainText(');
assert.match(plainReaderRollback, /rollbackReaderInputToCheckpoint/,
  'contract: the plain reader rollback restores the target turn shujuku table checkpoint');
assert.doesNotMatch(plainReaderRollback, /rollbackReaderInputWithArchive/,
  'contract: the plain reader rollback cannot bypass the shared table checkpoint transaction');

const sharedReaderRollback = section(index, 'async function rollbackReaderInputToCheckpoint(', 'async function rerunReaderMessage(');
assert.match(sharedReaderRollback, /captureShujukuRerollBinding[\s\S]*prepareShujukuBaseline[\s\S]*commitShujukuRerollCheckpoint/,
  'contract: the shared rollback path binds the live shujuku route and restores its archived table snapshot');
assert.match(sharedReaderRollback, /shujukuHandoffId:\s*shujukuRerollBinding\.handoff\.handoffId/,
  'contract: checkpoint lookup receives the active handoff identity so a pending anchor user can outrank the raw cutoff boundary');
assert.match(sharedReaderRollback, /baseline\.kind === 'missing_post_handoff'[\s\S]*return null/,
  'contract: a missing post-handoff table checkpoint fails closed before timeline mutation');
assert.match(sharedReaderRollback, /baseline\.kind === 'pre_handoff'[\s\S]*rollbackRoute = 'island'[\s\S]*commitArchive\(null\)/,
  'contract: pre-handoff rollback atomically restores the historical Island route');
assert.doesNotMatch(sharedReaderRollback, /原生模式不再根据本地记忆库构造历史表/,
  'contract: pre-handoff rollback no longer stops before restoring the historical time baseline');

const completedFloorRollback = section(index, 'async function rollbackAfterReaderFloor(', 'function growComposerInput(');
assert.match(completedFloorRollback, /getArchiveFloorAfterTurnShujukuBaseline[\s\S]*commitShujukuRerollCheckpoint/,
  'contract: keeping a completed floor restores its after-turn shujuku checkpoint before discarding the future');
assert.match(completedFloorRollback, /captureReaderRollbackState[\s\S]*restoreReaderRollbackState/,
  'contract: a failed completed-floor table/archive transaction restores the local Reader state');

const rerunReader = section(index, 'async function rerunReaderMessage(', 'async function deleteReaderFloor(');
assert.match(rerunReader, /rollbackReaderInputToCheckpoint/,
  'contract: regenerate uses the same target-turn table restore as plain rollback');
assert.match(rerunReader, /requireAuthoritativeStatusBaseline:\s*true/,
  'contract: reroll requires an authoritative before-turn time snapshot');

const virtualTurn = section(adapter, 'export async function runShujukuVirtualTurn(', 'function findSubsetDifference(');
assert.match(virtualTurn, /generateVirtual[\s\S]*VIRTUAL_TURN_TIMEOUT_MS/,
  'contract: shujuku narrative turns use the virtual relay endpoint');
assert.match(virtualTurn, /唯一当前 user[\s\S]*消息末尾/,
  'contract: virtual turns bind exactly one current user at the end of the timeline');
assert.match(virtualTurn, /normalizeVirtualPlanningProgress[\s\S]*callbacks\.onPlanningReady/,
  'contract: the adapter exposes the bridge planning checkpoint before the final turn result');
assert.match(adapter, /PROGRESS_ACK_EVENT[\s\S]*await onProgress[\s\S]*eventEmit\(PROGRESS_ACK_EVENT/,
  'contract: the adapter returns an awaited projection acknowledgement to the bridge');
const planningRender = section(actions, 'shujukuTurnResult = await runShujukuVirtualTurn(', 'rawResult = shujukuTurnResult.rawText;');
assert.match(planningRender, /onPlanningReady:\s*async[\s\S]*currentUser\.plannedText[\s\S]*ctx\.persistConversation\(\)[\s\S]*ctx\.render\(\)[\s\S]*bodyContext/,
  'contract: the current logical user persists and renders planning before returning the body authority appendix');
const normalizeVirtualTurn = section(adapter, 'async function normalizeVirtualTurnResult(', 'function normalizeVirtualPlanningProgress(');
assert.match(normalizeVirtualTurn, /planningObserved\s*!==\s*true[\s\S]*databaseCommitted\s*!==\s*true/,
  'contract: a shujuku turn is incomplete until planning and database commit are both proven');
const shujukuLogicalCommit = section(actions, '// v2 keeps the logical assistant in #0 state', '} else {');
assert.match(planningRender, /!shujukuTurnResult\.planningObserved[\s\S]*!shujukuTurnResult\.databaseCommitted/,
  'contract: the logical assistant cannot complete while planning or table commit is missing');
assert.match(shujukuLogicalCommit, /databaseCommitted[\s\S]*tableSnapshot/,
  'contract: only a verified database commit advances the authoritative table snapshot');
const scenePreflight = section(actions, 'let scenePresence: ScenePresence | null = null;', 'syncSchoolCalendarState({');
assert.doesNotMatch(scenePreflight, /narrativeRoute === 'shujuku'/,
  'contract: shujuku does not duplicate Island preflight before its own planning authority runs');
assert.match(planningRender, /buildIslandBodyContextFromPlanning[\s\S]*scenePresence\s*=[\s\S]*bodyContext/,
  'contract: selected role-0 cards and current plot are derived from committed shujuku planning for the final body');
assert.match(actions, /cancelShujukuVirtualTurn\(generationId\)/,
  'contract: player cancellation invalidates the matching bridge generation instead of only dropping local UI state');
assert.match(render, /qrf_plot[\s\S]*qrf_plot_tasks[\s\S]*qrf_plot_preset[\s\S]*reader-shujuku-plan/,
  'contract: the reader projects this turn qrf fields onto its logical user floor');
const planningProjection = section(render, 'const SHUJUKU_PLANNING_SECTIONS', 'function renderIllustrationFigures(');
assert.match(planningProjection, /kirihime_review/,
  'contract: Kirihime review remains visible when Tavern regex formatting is unavailable');
assert.match(planningProjection, /以下是夏野雾姬规划B64:[\s\S]*formatAsTavernRegexedString\(regexInput,\s*'user_input',\s*'display',\s*\{ depth: 0 \}\)/,
  'contract: the reader calls the dedicated Kirihime display regex through Tavern Helper formatting');
assert.match(planningProjection, /regexed\.trim\(\) === regexInput\.trim\(\)[\s\S]*return ''/,
  'contract: an unchanged formatter result falls back instead of displaying raw planning tags');
assert.doesNotMatch(planningProjection, /globalThis[\s\S]*formatAsTavernRegexedString/,
  'contract: planning rendering does not look for the formatter on the isolated #0 iframe global');
const restoreStart = adapter.indexOf('export async function restoreShujukuTablesForHandoff(');
assert.notEqual(restoreStart, -1, 'contract fixture missing: restoreShujukuTablesForHandoff');
const restoreTables = adapter.slice(restoreStart);
assert.doesNotMatch(restoreTables, /current\.tableHash\s*!==\s*snapshot\.tableHash/,
  'contract: restore accepts additive normalization by the global CDN');
assert.match(restoreTables, /beforeRestore[\s\S]*findSubsetDifference\(durableExpected, beforeRestore\.tables, PROJECTION_V1\)[\s\S]*if \(!existingDifference\) return/,
  'contract: an already hydrated runtime is not rewritten before every planning turn');
assert.match(restoreTables, /findSubsetDifference\(durableExpected, current\.tables, PROJECTION_V1\)/,
  'contract: restore still rejects changes to every archived field, array, and cell');

const enterSave = section(index, 'async function enterSave(', 'async function returnToTitle(');
assert.match(index, /async function restoreLoadedShujukuTableSnapshot\([\s\S]*inspectCommittedShujukuBinding[\s\S]*restoreShujukuTablesForHandoff/,
  'contract: loading a save hydrates its committed table snapshot into the shujuku runtime');
assert.match(enterSave, /loadArchiveAuxiliaryState[\s\S]*restoreLoadedShujukuTableSnapshot/,
  'contract: save hydration waits for the authoritative archive compatibility block');
const shujukuMainTurn = section(actions, "let shujukuTurnResult: Awaited<ReturnType<typeof runShujukuVirtualTurn>>", "recordSubmissionDebug('submit:generate-returned'");
assert.match(shujukuMainTurn, /restoreShujukuTablesForHandoff[\s\S]*runShujukuVirtualTurn/,
  'contract: every shujuku正文 turn restores the saved table authority before qrf planning');
const openingVirtualTurn = section(opening, "let shujukuTurnResult: Awaited<ReturnType<typeof runShujukuVirtualTurn>>", "recordGenerationDebug(ctx, 'opening:generate-returned'");
assert.match(openingVirtualTurn, /restoreShujukuTablesForHandoff[\s\S]*runShujukuVirtualTurn/,
  'contract: an AI opening restores the saved table authority before qrf planning');

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

console.info('[shujuku-v2-save-wiring] 59 contracts passed');
