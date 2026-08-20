import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultMemoryDB } from '../memorydatabase/defaults';
import {
  buildIslandBodyContextFromPlanning,
  buildIslandPlanningIdentityPayload,
  buildIslandPlanningContextPayload,
  buildShujukuPlanningDisplaySnapshot,
  ISLAND_BODY_CONTEXT_VERSION,
  ISLAND_PLANNING_CONTEXT_PLUGIN_KEY,
  ISLAND_PLANNING_CONTEXT_VERSION,
  SHUJUKU_PLANNING_DISPLAY_PLUGIN_KEY,
} from '../shujukuinject';
import { defaultStatusData } from '../variables/defaults';
import { getTargetCharacterKey } from '../relationship';
import type {
  CharacterCardLibrary,
  DrawingSettings,
  PlayerProfile,
  PlotLibrary,
  ScenePresence,
} from '../types';

const root = path.resolve(__dirname, '..');
const statusData = structuredClone(defaultStatusData);
statusData.world.currentTime = '2012-04-08 16:30';
statusData.world.currentLocation = '视听教室';
statusData.targets = statusData.targets.slice(0, 3);

const playerProfile: PlayerProfile = {
  name: '结城理',
  familyName: '结城',
  givenName: '理',
  gender: 'male',
  personality: '冷静',
  appearance: '黑发，校服外套。',
  className: '2年B班',
};
const memoryDB = createDefaultMemoryDB('planning-context-contract');
memoryDB.relations.push({
  id: 'relation-1',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  source: 'manual',
  fromId: 'player',
  toId: statusData.targets[0].id,
  label: '已经确认恋人关系',
  stage: '稳定交往',
  reason: '用户此前明确告白并被接受',
});
memoryDB.events.push({
  id: 'event-should-not-leak',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  source: 'manual',
  title: 'MEMORY_EVENT_SENTINEL',
  description: '不应复制到规划附录',
});

const drawingSettings: DrawingSettings = {
  enabled: false,
  qualityPrompt: '',
  negativePrompt: '',
  contextMessageCount: 0,
  width: 832,
  height: 1216,
  manualPrompt: '',
  characterAnchors: [{ id: statusData.targets[0].id, name: statusData.targets[0].name, prompt: '茶色短发' }],
  systemPrompt: '',
};

const presentTarget = statusData.targets[0];
const focusTarget = statusData.targets[1];
const absentTarget = statusData.targets[2];
const presentKey = getTargetCharacterKey(presentTarget);
const focusKey = getTargetCharacterKey(focusTarget);
const absentKey = getTargetCharacterKey(absentTarget);
assert.ok(presentKey && focusKey && absentKey, 'contract fixture: test targets resolve to character-card keys');
const scenePresence: ScenePresence = {
  presentIds: [presentTarget.id],
  focusIds: [focusTarget.id],
  absentIds: [absentTarget.id],
  uncertainIds: [],
  evidence: {
    [presentTarget.id]: '最近正文中正在与 user 当面交谈',
    [focusTarget.id]: '用户准备去找该角色',
    [absentTarget.id]: '最近正文明确写明已经离开',
  },
};
const characterCardLibrary: CharacterCardLibrary = {
  loadedAt: 1,
  cards: {
    [presentKey]: {
      key: presentKey,
      name: presentTarget.name,
      content: 'PRESENT_CHARACTER_CARD_SENTINEL',
      sourceEntryUid: 1,
      sourceEntryName: `${presentTarget.name} 0层卡`,
    },
    [focusKey]: {
      key: focusKey,
      name: focusTarget.name,
      content: 'FOCUS_CHARACTER_CARD_SENTINEL',
      sourceEntryUid: 2,
      sourceEntryName: `${focusTarget.name} 0层卡`,
    },
    [absentKey]: {
      key: absentKey,
      name: absentTarget.name,
      content: 'ABSENT_CHARACTER_CARD_SENTINEL',
      sourceEntryUid: 3,
      sourceEntryName: `${absentTarget.name} 0层卡`,
    },
  },
};
const plotEventId = 'SAE_TEST_CURRENT';
statusData.world.currentMainEventId = plotEventId;
statusData.world.mainEvents[plotEventId] = '进行中';
const plotLibrary: PlotLibrary = {
  loadedAt: 1,
  sourceEntryNames: ['剧情测试卷'],
  events: {
    [plotEventId]: {
      id: plotEventId,
      title: '当前剧情测试大纲',
      summary: 'PLOT_OUTLINE_SENTINEL',
      previousIds: [],
      nextIds: [],
      content: 'PLOT_CARD_CONTENT_SENTINEL',
      sourceEntryUid: 4,
      sourceEntryName: '剧情测试卷',
    },
  },
};

const payload = buildIslandPlanningContextPayload({
  statusData,
  playerProfile,
  memoryDB,
  scenePresence,
  plotLibrary,
  characterCardLibrary,
  drawingSettings,
  gameDevelopmentContext: '[GAME_DEVELOPMENT_TURN]\naction_id=write_script\ntarget_id=加藤惠',
});

assert.equal(ISLAND_PLANNING_CONTEXT_PLUGIN_KEY, '_islandmilfcode_planning_context_v1');
assert.equal(payload.version, ISLAND_PLANNING_CONTEXT_VERSION);
assert.match(payload.content, /时间：2012-04-08 16:30/);
assert.match(payload.content, /地点：视听教室/);
assert.match(payload.content, /已经确认恋人关系（稳定交往）/);
assert.match(payload.content, /茶色短发/);
assert.match(payload.content, /action_id=write_script/);
assert.match(payload.content, /表里的“在场\/离场”只算旧元数据/);
assert.match(payload.content, /最近正文明确离场时必须承认离场/);
assert.match(payload.content, /用户本轮行动、已经发生的关系变化和既成事件都是有效新变量/);
assert.match(payload.content, /原作惯性与已发生的新因果冲突时，应抑制旧轨回流/);
assert.match(payload.content, /夏野雾姬只担任审稿与规划人格，不作为 Island 剧情角色/);
assert.match(payload.content, /【本轮镜头判定】/);
assert.match(payload.content, /PRESENT_CHARACTER_CARD_SENTINEL/);
assert.match(payload.content, /FOCUS_CHARACTER_CARD_SENTINEL/);
assert.doesNotMatch(payload.content, /ABSENT_CHARACTER_CARD_SENTINEL/);
assert.match(payload.content, /【当前剧情大纲】/);
assert.match(payload.content, /PLOT_OUTLINE_SENTINEL/);
assert.match(payload.content, /PLOT_CARD_CONTENT_SENTINEL/);
assert.match(payload.content, /最近正文中正在与 user 当面交谈/);
assert.doesNotMatch(payload.content, /MEMORY_EVENT_SENTINEL/);
assert.doesNotMatch(payload.content, /timeProposal|webLookupPlan|recallPlan/);
assert.doesNotMatch(payload.content, /\$8|最近4条可见正文/);
assert.doesNotMatch(payload.content, /日常外套。|便于行动的日常服装。|随身小物。/);

const identityPayload = buildIslandPlanningIdentityPayload(playerProfile, statusData.world.currentTime);
assert.equal(identityPayload.version, ISLAND_PLANNING_CONTEXT_VERSION);
assert.equal(identityPayload.userIdentity?.name, '结城理');
assert.match(identityPayload.content, /User 姓名：结城理/);
assert.doesNotMatch(identityPayload.content, /PRESENT_CHARACTER_CARD_SENTINEL|FOCUS_CHARACTER_CARD_SENTINEL/,
  'contract: planning identity payload cannot preselect role-0 cards');
assert.doesNotMatch(identityPayload.content, /PLOT_OUTLINE_SENTINEL|PLOT_CARD_CONTENT_SENTINEL/,
  'contract: planning identity payload cannot inject plot authority before qrf commits present');
assert.doesNotMatch(identityPayload.content, /已经确认恋人关系/,
  'contract: planning identity payload contains no relationship authority');

const emptyPayload = buildIslandPlanningContextPayload({
  statusData: { ...statusData, targets: [] },
  playerProfile,
  memoryDB: createDefaultMemoryDB('planning-context-empty'),
});
assert.match(emptyPayload.content, /【可识别角色名单】\n- 无/);
assert.doesNotMatch(emptyPayload.content, /【已成立关系事实】/);

const plannedText = [
  '<current_user_input>继续当前场景</current_user_input>',
  '<recall>AM0042</recall>',
  '<supplement>- 已有旁证</supplement>',
  '<kirihime_review>',
  'camera:',
  `- present: ${presentTarget.name}`,
  `- focus: ${focusTarget.name}`,
  `- absent: ${absentTarget.name}`,
  '- uncertain: 无',
  'causal_change: user 决定继续交谈',
  'next_page: 承认当前镜头',
  'suppress_canon_return: 无',
  'appearance_constraints: 无可靠约束',
  '</kirihime_review>',
].join('\n');
const bodyContext = buildIslandBodyContextFromPlanning({
  plannedText,
  statusData,
  playerProfile,
  plotLibrary,
  characterCardLibrary,
});
assert.equal(bodyContext.version, ISLAND_BODY_CONTEXT_VERSION);
assert.deepEqual(bodyContext.scenePresence.presentIds, [presentTarget.id]);
assert.deepEqual(bodyContext.scenePresence.absentIds, [absentTarget.id]);
assert.match(bodyContext.content, /PRESENT_CHARACTER_CARD_SENTINEL/);
assert.doesNotMatch(bodyContext.content, /FOCUS_CHARACTER_CARD_SENTINEL/,
  'contract: qrf focus can guide the scene but cannot select a role-0 card');
assert.doesNotMatch(bodyContext.content, /ABSENT_CHARACTER_CARD_SENTINEL/);
assert.match(bodyContext.content, /PLOT_OUTLINE_SENTINEL/);
assert.match(bodyContext.content, /PLOT_CARD_CONTENT_SENTINEL/);
assert.equal(bodyContext.content.split('PRESENT_CHARACTER_CARD_SENTINEL').length - 1, 1,
  'contract: selected role-0 card enters the body appendix exactly once');
assert.equal(bodyContext.content.split('PLOT_CARD_CONTENT_SENTINEL').length - 1, 1,
  'contract: current plot enters the body appendix exactly once');
assert.doesNotMatch(bodyContext.content, /<current_user_input>|<recall>|<supplement>|<kirihime_review>/,
  'contract: the body appendix contains selected authority, not planning protocol wrappers');

const focusOnlyBodyContext = buildIslandBodyContextFromPlanning({
  plannedText: plannedText
    .replace(`- present: ${presentTarget.name}`, '- present: 无')
    .replace(`- absent: ${absentTarget.name}`, `- absent: ${presentTarget.name}、${absentTarget.name}`),
  statusData,
  playerProfile,
  plotLibrary,
  characterCardLibrary,
});
assert.deepEqual(focusOnlyBodyContext.scenePresence.presentIds, []);
assert.deepEqual(focusOnlyBodyContext.scenePresence.focusIds, [focusTarget.id]);
assert.doesNotMatch(focusOnlyBodyContext.content, /CHARACTER_CARD_SENTINEL/,
  'contract: an explicit empty qrf present list selects no role-0 card and never falls back to focus');

const tableSnapshot = {
  capturedAt: '2026-08-10T00:00:00.000Z',
  tableHash: 'sha256:test',
  tables: {
    memories: {
      name: '纪要表',
      content: [
        ['编码索引', '标题', '纪要'],
        ['AM0042', '天台约定', '本轮规划应读取的冻结召回正文'],
        ['AM9999', '无关记录', '不得进入本轮规划显示快照'],
      ],
    },
  },
};
const displaySnapshot = buildShujukuPlanningDisplaySnapshot(plannedText, tableSnapshot);
assert.equal(SHUJUKU_PLANNING_DISPLAY_PLUGIN_KEY, '_islandmilfcode_planning_display_v1');
assert.deepEqual(Object.keys(displaySnapshot.recallEntries), ['AM0042']);
assert.equal(displaySnapshot.recallEntries.AM0042.body, '本轮规划应读取的冻结召回正文');
(tableSnapshot.tables.memories.content[1] as string[])[2] = 'MUTATED_AFTER_CAPTURE';
assert.equal(displaySnapshot.recallEntries.AM0042.body, '本轮规划应读取的冻结召回正文',
  'contract: planning display consumes an immutable captured snapshot');

const actions = fs.readFileSync(path.join(root, 'actions', 'index.ts'), 'utf8');
const opening = fs.readFileSync(path.join(root, 'actions', 'opening.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'shujuku', 'IslandMilfCode数据库转发桥.js'), 'utf8');
const scenePreflight = actions.slice(
  actions.indexOf('let scenePresence: ScenePresence | null = null;'),
  actions.indexOf(
    'const sae078CeremonyEligibleAtPromptBuild',
    actions.indexOf('let scenePresence: ScenePresence | null = null;'),
  ),
);
assert.match(
  scenePreflight,
  /narrativeRoute === 'island' && hasHostGenerate/,
  'contract: only the direct Island route runs the old scene-presence preflight',
);
assert.doesNotMatch(scenePreflight, /narrativeRoute === 'shujuku'/,
  'contract: shujuku present is selected only by its committed qrf planning');
assert.match(actions, /message\.pluginData \?\? \{\}[\s\S]*ISLAND_PLANNING_CONTEXT_PLUGIN_KEY/);
assert.match(opening, /current:\s*true[\s\S]*ISLAND_PLANNING_CONTEXT_PLUGIN_KEY/);
assert.match(actions, /buildIslandPlanningIdentityPayload\([\s\S]*state\.playerProfile/);
assert.match(opening, /provisionalAssistant\.pluginData = \{[\s\S]*provisionalAssistant\.pluginData \?\? \{\}/,
  'contract: opening database metadata merges with the already-rendered planning projection');
assert.match(actions, /shujukuTurnResult\.databaseCommitted[\s\S]*provisionalAssistant\.pluginData = \{[\s\S]*provisionalAssistant\.pluginData \?\? \{\}/,
  'contract: normal shujuku assistant metadata cannot replace previously committed same-layer metadata');
assert.doesNotMatch(
  actions.slice(actions.indexOf("if (narrativeRoute === 'shujuku')"), actions.indexOf("} else {", actions.indexOf("if (narrativeRoute === 'shujuku')"))),
  /buildIslandPlanningContextPayload/,
  'contract: shujuku planning receives identity only, never the preselected role/plot payload',
);
assert.match(bridge, /takePlanningContext\(initialVirtualUser\)/);
assert.match(bridge, /delete candidate\[PLANNING_CONTEXT_PLUGIN_KEY\]/);
assert.doesNotMatch(bridge, /PLANNING_CONTEXT_TAG = 'island_runtime_planning_context'/);
assert.doesNotMatch(bridge, /installPlanningContextOverlay/,
  'contract: character/plot context is never injected before qrf present commits');
assert.match(bridge, /installUserIdentityOverlay[\s\S]*planningContext\.userIdentity/,
  'contract: planning still resolves $U to the current Island player');
assert.match(bridge, /planningContextRestoredBeforeBody/);
assert.match(bridge, /bodyOverrides[\s\S]*char_description:\s*bodyDescription/,
  'contract: acknowledged present-role and plot authority enters the documented final body prompt override');
assert.match(bridge, /persona_description:\s*String\(userIdentity\.persona\)/,
  'contract: final body prompt preserves the current Island User identity');

console.info('[island-planning-context] present-only planning contracts passed');
