import {
  buildActiveCharacterCards,
  buildCurrentPlotContext,
  buildRelationshipGuidanceList,
  buildScenePresenceContext,
} from '../message-format';
import { isPhoneArchiveGoldImpression } from '../phone/types';
import { getCharacterRelationToTomoya } from '../relationship';
import { buildSaenaiWorldStateFactLines } from '../saenai-world-facts';
import { buildKirihimeSchoolIdentitySegment, resolvePlayerSchoolIdentity } from '../school-calendar';
import type { IslandMemoryDB } from '../memorydatabase/types';
import type {
  CharacterCardLibrary,
  DrawingSettings,
  PlayerProfile,
  PlotLibrary,
  ScenePresence,
  ShujukuTableSnapshot,
  StatusData,
  TargetStatus,
} from '../types';

export const ISLAND_PLANNING_CONTEXT_PLUGIN_KEY = '_islandmilfcode_planning_context_v1';
export const ISLAND_PLANNING_CONTEXT_VERSION = 1 as const;
export const ISLAND_BODY_CONTEXT_VERSION = 1 as const;
export const SHUJUKU_PLANNING_DISPLAY_PLUGIN_KEY = '_islandmilfcode_planning_display_v1';

export const SCENE_CAMERA_EVIDENCE_RULES = [
  '当前镜头只以最近可见正文和本轮用户输入为即时证据；表里的“在场/离场”只算旧元数据。',
  'present：角色确实处在当前镜头内，能够立刻说话、行动、沉默或产生即时反应。',
  'focus：用户正在追上、寻找、靠近、转向或当面处理该角色，下一页可以自然转向她。',
  'absent：角色已经离开、没有到场，或隔着距离无法立刻参与当前互动。',
  'uncertain：角色只是被提到、回忆、议论或记录在旧信息中，不能据此判定当前在场。',
  '地点冲突、关系亲密、曾经登场或剧情常识都不能单独证明当前在场；最近正文明确离场时必须承认离场。',
] as const;

export const USER_CAUSALITY_RULES = [
  '原作只提供人物骨架和主题母本，不是必须返回的剧情铁轨。',
  '用户本轮行动、已经发生的关系变化和既成事件都是有效新变量，下一页必须承认其直接后果。',
  '先写清“用户造成了什么变化 -> 谁会立刻受影响 -> 下一页必须承认什么偏转”，再决定推进方向。',
  '原作惯性与已发生的新因果冲突时，应抑制旧轨回流，不能无因果地把关系或事件复位。',
] as const;

export const CHARACTER_CONSISTENCY_RULES = [
  '角色与安艺伦也的原作关系只属于安艺伦也，不能移植成角色与 user 的既定关系。',
  '已成立的 user 关系、约定、身份和锁定印象优先于原作初始关系；不得把它们降格为猜测。',
  '好感度、剧情重要性、地点记录或“她应该出现”都不能替代当前镜头证据。',
  '不在镜头内的角色不得获得即时动作、台词或读心式反应；需要时只能作为后续影响处理。',
] as const;

export const APPEARANCE_CONSISTENCY_RULES = [
  '外观只能采用角色卡、世界书、最近正文或本附录明确给出的可靠锚点；不知道就保持未知。',
  '不能用常见动漫模板补发色、体型、胸围、服装或身体细节，也不能把其他角色的特征串过来。',
  '只记录本轮确实可能被描写角色的有依据约束；旧衣着记录若与最近正文冲突，应服从最近正文。',
] as const;

export const ISLAND_WORK_RULES = [
  '安艺伦也不是阴暗跟踪者；他的核心驱动力是制作符合自身御宅审美的美少女游戏，以及对创作理想的偏执。',
  '英梨梨、美智留等人与伦也的原作青梅竹马或亲属关系，默认不适用于 user。',
  '夏野雾姬只担任审稿与规划人格，不作为 Island 剧情角色，不得让她进入镜头、关系表或正文事件。',
] as const;

export type IslandPlanningContextPayloadV1 = {
  readonly version: typeof ISLAND_PLANNING_CONTEXT_VERSION;
  readonly content: string;
  readonly userIdentity?: {
    readonly name: string;
    readonly persona: string;
  };
};

export type IslandBodyContextPayloadV1 = {
  readonly version: typeof ISLAND_BODY_CONTEXT_VERSION;
  readonly scenePresence: ScenePresence;
  readonly content: string;
};

export type ShujukuPlanningDisplaySnapshotV1 = {
  readonly version: 1;
  readonly recallEntries: Record<string, {
    title: string;
    body: string;
    source: string;
  }>;
};

export type IslandPlanningContextInput = {
  readonly statusData: StatusData;
  readonly playerProfile: PlayerProfile;
  readonly memoryDB: IslandMemoryDB;
  readonly scenePresence?: ScenePresence | null;
  readonly plotLibrary?: PlotLibrary | null;
  readonly characterCardLibrary?: CharacterCardLibrary | null;
  readonly drawingSettings?: DrawingSettings | null;
  readonly appearanceGuards?: ScenePresence['appearanceGuards'];
  readonly gameDevelopmentContext?: string;
};

/**
 * The shujuku runtime resolves `$U` from the Tavern user profile, while the
 * Island route resolves the player from `PlayerProfile`.  Keep one explicit
 * identity block at the handoff boundary so the two routes cannot silently
 * substitute the default card protagonist (安艺伦也) for the current player.
 */
export function buildIslandUserIdentityContext(
  playerProfile: PlayerProfile,
  currentTime?: string,
): string {
  const school = resolvePlayerSchoolIdentity(playerProfile, currentTime ?? '');
  const name = compactPlanningText(playerProfile.name, 80) || '未命名用户';
  const gender = compactPlanningText(playerProfile.gender, 40) || '男（Island 当前规则）';
  const className = compactPlanningText(school.className || school.label || playerProfile.className, 80) || '未知';
  const background = (playerProfile.backgrounds ?? [])
    .map(item => compactPlanningText(item, 160))
    .filter(Boolean)
    .slice(0, 8);
  const lines = [
    '【当前玩家 User 身份（权威）】',
    `- User 姓名：${name}`,
    `- User 性别：${gender}`,
    `- User 班级/身份：${className}`,
    playerProfile.familyName || playerProfile.givenName
      ? `- User 姓名拆分：${compactPlanningText(playerProfile.familyName, 40)}${playerProfile.givenName ? ` ${compactPlanningText(playerProfile.givenName, 40)}` : ''}`
      : '',
    playerProfile.personality ? `- User 性格：${compactPlanningText(playerProfile.personality, 240)}` : '',
    playerProfile.appearance ? `- User 外观：${compactPlanningText(playerProfile.appearance, 320)}` : '',
    background.length ? `- User 背景：${background.join('；')}` : '',
    '- User/主角只指当前玩家；正文中的玩家行动、关系和身份都归属于该 User。',
    '- 安艺伦也是独立 NPC，不是 User，不得把安艺伦也的姓名、身份、关系或原作位置填入 User 栏。',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Planning receives only the current Island player identity. Character cards,
 * relationships, and plot authority are selected after shujuku commits its
 * `present` camera result and belong to the正文 boundary instead.
 */
export function buildIslandPlanningIdentityPayload(
  playerProfile: PlayerProfile,
  currentTime?: string,
): IslandPlanningContextPayloadV1 {
  const content = buildIslandUserIdentityContext(playerProfile, currentTime);
  return {
    version: ISLAND_PLANNING_CONTEXT_VERSION,
    content,
    userIdentity: {
      name: compactPlanningText(playerProfile.name, 80) || '用户',
      persona: content,
    },
  };
}

const DEFAULT_OUTFIT_TEXT = new Set(['日常外套。', '便于行动的日常服装。', '随身小物。']);
const RUNTIME_CONTEXT_CLOSE_TAG = '</island_runtime_planning_context>';

function compactPlanningText(value: unknown, maximumLength = 240) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replaceAll(RUNTIME_CONTEXT_CLOSE_TAG, '&lt;/island_runtime_planning_context&gt;')
    .trim();
  if (!text) return '';
  return text.length > maximumLength ? `${text.slice(0, Math.max(1, maximumLength - 3))}...` : text;
}

function compactPlanningBlock(value: unknown, maximumLength = 12_000) {
  const text = String(value ?? '')
    .replaceAll(RUNTIME_CONTEXT_CLOSE_TAG, '&lt;/island_runtime_planning_context&gt;')
    .trim();
  if (!text) return '';
  return text.length > maximumLength ? `${text.slice(0, Math.max(1, maximumLength - 3))}...` : text;
}

function isPlayerMemoryId(value: string | undefined) {
  return /^(user|player|玩家|主角)$/i.test(String(value ?? '').trim());
}

function mentionsPlayer(value: string | undefined) {
  return /\buser\b|\bplayer\b|玩家|主角/i.test(String(value ?? ''));
}

function targetAliases(target: TargetStatus) {
  return String(target.alias ?? '')
    .split(/[/|,，、;；]+/)
    .map(alias => compactPlanningText(alias, 48))
    .filter(Boolean)
    .filter(alias => alias !== target.id && alias !== target.name)
    .slice(0, 8);
}

export function buildIslandPlanningCharacterLines(
  statusData: StatusData,
  playerProfile: PlayerProfile,
): string[] {
  return statusData.targets.map(target => {
    const aliases = targetAliases(target);
    const relationToTomoya = getCharacterRelationToTomoya(target);
    const schoolSegment = buildKirihimeSchoolIdentitySegment({
      target,
      playerProfile,
      currentTime: statusData.world.currentTime,
      relationToTomoya,
    });
    return compactPlanningText(
      `- id=${target.id}；姓名=${target.name}${aliases.length ? `；别名=${aliases.join('、')}` : ''}${schoolSegment}`,
      420,
    );
  });
}

export function buildEstablishedRelationshipFactLines(
  targets: readonly TargetStatus[],
  memoryDB: IslandMemoryDB,
): string[] {
  const targetNames = new Map(targets.map(target => [target.id, target.name]));
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const text = compactPlanningText(value, 160);
    if (!text || seen.has(text) || lines.length >= 8) return;
    seen.add(text);
    lines.push(`- ${text}`);
  };

  for (const fact of memoryDB.facts.filter(row => !row.expired)) {
    if (fact.category !== 'relation' && fact.category !== 'profile') continue;
    if (
      fact.category !== 'relation'
      && !mentionsPlayer(fact.subject)
      && !mentionsPlayer(fact.content)
      && !fact.relatedEntityIds?.some(isPlayerMemoryId)
    ) {
      continue;
    }
    push(`${fact.subject}: ${fact.content}`);
  }

  for (const relation of memoryDB.relations.filter(row => !row.expired)) {
    if (!isPlayerMemoryId(relation.fromId) && !isPlayerMemoryId(relation.toId)) continue;
    const from = targetNames.get(relation.fromId) ?? relation.fromId;
    const to = targetNames.get(relation.toId) ?? relation.toId;
    const stage = relation.stage ? `（${relation.stage}）` : '';
    const reason = relation.reason ? `；${relation.reason}` : '';
    push(`${from} -> ${to}: ${relation.label}${stage}${reason}`);
  }

  for (const impression of memoryDB.impressions.filter(row => !row.expired)) {
    if (!isPlayerMemoryId(impression.subject) || !isPhoneArchiveGoldImpression(impression)) continue;
    const target = targetNames.get(impression.targetId) ?? impression.targetId;
    push(`${target}对user的锁定印象: ${impression.label}`);
  }

  return lines;
}

function buildAppearanceConstraintLines(input: IslandPlanningContextInput) {
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const text = compactPlanningText(value, 300);
    if (!text || seen.has(text) || lines.length >= 16) return;
    seen.add(text);
    lines.push(`- ${text}`);
  };

  if (input.playerProfile.appearance?.trim()) {
    push(`user：${input.playerProfile.appearance}`);
  }
  for (const guard of input.appearanceGuards ?? []) {
    const mustFollow = guard.mustFollow.filter(item => item && item !== 'unknown').join('；');
    const mustNotInvent = guard.mustNotInvent.filter(Boolean).join('；');
    if (mustFollow) push(`${guard.id} 已知锚点：${mustFollow}`);
    if (mustNotInvent) push(`${guard.id} 禁止脑补：${mustNotInvent}`);
  }
  for (const anchor of input.drawingSettings?.characterAnchors ?? []) {
    if (anchor.prompt?.trim()) push(`${anchor.name || anchor.id} 绘图锚点：${anchor.prompt}`);
  }
  for (const target of input.statusData.targets) {
    const outfit = Object.entries(target.outfits ?? {})
      .map(([part, description]) => [compactPlanningText(part, 32), compactPlanningText(description, 120)] as const)
      .filter(([, description]) => description && !DEFAULT_OUTFIT_TEXT.has(description))
      .map(([part, description]) => `${part}=${description}`)
      .join('；');
    if (outfit) push(`${target.name} 当前衣着记录：${outfit}`);
  }

  return lines;
}

function addRuleSection(lines: string[], title: string, rules: readonly string[]) {
  lines.push('', title, ...rules.map(rule => `- ${rule}`));
}

function normalizePlanningName(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\u3000·・.。'"“”‘’`]/g, '');
}

function splitPlanningNames(value: string) {
  const text = String(value ?? '')
    .replace(/^\s*(?:无|none|null|n\/a)\s*$/i, '')
    .replace(/[（(].*?[）)]/g, '')
    .trim();
  if (!text) return [];
  return text
    .split(/[、,，;；|/]+/)
    .map(item => item.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function readPlanningCameraField(review: string, field: 'present' | 'focus' | 'absent' | 'uncertain') {
  const match = String(review ?? '').match(
    new RegExp(`(?:^|\\n)\\s*-\\s*${field}\\s*:\\s*([^\\n]*)`, 'i'),
  );
  return match?.[1]?.trim() ?? '';
}

function readKirihimeReview(plannedText: string) {
  const match = String(plannedText ?? '').match(/<kirihime_review>\s*([\s\S]*?)\s*<\/kirihime_review>/i);
  return match?.[1] ?? '';
}

function resolvePlanningTargetIds(value: string, targets: readonly TargetStatus[]) {
  const candidates = targets.map(target => {
    const aliases = String(target.alias ?? '')
      .split(/[/|,，、;；]+/)
      .map(alias => alias.trim())
      .filter(Boolean);
    return {
      id: target.id,
      names: [target.id, target.name, ...aliases]
        .map(normalizePlanningName)
        .filter(Boolean),
    };
  });
  const resolved: string[] = [];
  for (const token of splitPlanningNames(value)) {
    const normalized = normalizePlanningName(token);
    if (!normalized) continue;
    const exact = candidates.find(candidate => candidate.names.includes(normalized));
    const partial = exact ?? candidates
      .filter(candidate => candidate.names.some(name => normalized.includes(name) || name.includes(normalized)))
      .sort((left, right) => Math.max(...right.names.map(name => name.length)) - Math.max(...left.names.map(name => name.length)))[0];
    if (partial && !resolved.includes(partial.id)) resolved.push(partial.id);
  }
  return resolved;
}

export function parseIslandScenePresenceFromPlanning(
  plannedText: string,
  targets: readonly TargetStatus[],
): ScenePresence {
  const review = readKirihimeReview(plannedText);
  const presentIds = resolvePlanningTargetIds(readPlanningCameraField(review, 'present'), targets);
  const focusIds = resolvePlanningTargetIds(readPlanningCameraField(review, 'focus'), targets)
    .filter(id => !presentIds.includes(id));
  const absentIds = resolvePlanningTargetIds(readPlanningCameraField(review, 'absent'), targets)
    .filter(id => !presentIds.includes(id) && !focusIds.includes(id));
  const uncertainIds = resolvePlanningTargetIds(readPlanningCameraField(review, 'uncertain'), targets)
    .filter(id => !presentIds.includes(id) && !focusIds.includes(id) && !absentIds.includes(id));
  const evidence: Record<string, string> = {};
  for (const id of presentIds) evidence[id] = 'Shujuku kirihime_review: present';
  for (const id of focusIds) evidence[id] = 'Shujuku kirihime_review: focus';
  for (const id of absentIds) evidence[id] = 'Shujuku kirihime_review: absent';
  for (const id of uncertainIds) evidence[id] = 'Shujuku kirihime_review: uncertain';
  return { presentIds, focusIds, absentIds, uncertainIds, evidence };
}

export function buildIslandBodyContextFromPlanning(input: {
  plannedText: string;
  statusData: StatusData;
  playerProfile: PlayerProfile;
  plotLibrary?: PlotLibrary | null;
  characterCardLibrary?: CharacterCardLibrary | null;
}): IslandBodyContextPayloadV1 {
  const scenePresence = parseIslandScenePresenceFromPlanning(input.plannedText, input.statusData.targets);
  const scene = buildScenePresenceContext(input.statusData, scenePresence, input.playerProfile);
  const cards = buildActiveCharacterCards(
    input.statusData,
    scenePresence,
    input.characterCardLibrary,
    { targetIds: scenePresence.presentIds },
  );
  const relationship = buildRelationshipGuidanceList(input.statusData, input.playerProfile, scenePresence);
  const plot = buildCurrentPlotContext(input.statusData, input.plotLibrary);
  const content = [
    '[Island post-planning authority: use only the selected current scene]',
    buildIslandUserIdentityContext(input.playerProfile, input.statusData.world.currentTime),
    scene,
    cards,
    relationship ? `角色局部关系指导：\n${relationship}` : '',
    plot ? `当前剧情大纲：\n${plot}` : '',
  ].filter(Boolean).join('\n\n').trim();
  return { version: ISLAND_BODY_CONTEXT_VERSION, scenePresence, content };
}

function clonePlanningSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function extractPlanningRecallCodes(plannedText: string) {
  return [...new Set((String(plannedText ?? '').match(/AM\d+/gi) ?? []).map(code => code.toUpperCase()))];
}

export function buildShujukuPlanningDisplaySnapshot(
  plannedText: string,
  tableSnapshot: ShujukuTableSnapshot | null | undefined,
): ShujukuPlanningDisplaySnapshotV1 {
  const recallEntries: ShujukuPlanningDisplaySnapshotV1['recallEntries'] = {};
  const tables = tableSnapshot?.tables;
  if (!tables || typeof tables !== 'object') return { version: 1, recallEntries };
  const codes = extractPlanningRecallCodes(plannedText);
  for (const sheet of Object.values(tables)) {
    if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) continue;
    const record = sheet as Record<string, unknown>;
    if (record.name !== '纪要表' && record.name !== '总结表') continue;
    const rows = record.content;
    if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0])) continue;
    const headers = rows[0].map(value => String(value ?? ''));
    const codeIndex = headers.indexOf('编码索引');
    if (codeIndex < 0) continue;
    const titleIndex = headers.indexOf('标题');
    const bodyIndex = headers.indexOf('纪要');
    rows.slice(1).forEach(row => {
      if (!Array.isArray(row)) return;
      const code = String(row[codeIndex] ?? '').trim().toUpperCase();
      if (!codes.includes(code) || recallEntries[code]) return;
      recallEntries[code] = {
        title: String(titleIndex >= 0 ? row[titleIndex] ?? code : code),
        body: String(bodyIndex >= 0 ? row[bodyIndex] ?? '' : ''),
        source: `${String(record.name)} · 卷${rows.indexOf(row)}`,
      };
    });
  }
  return clonePlanningSnapshot({ version: 1 as const, recallEntries });
}

export function buildIslandPlanningContextPayload(
  input: IslandPlanningContextInput,
): IslandPlanningContextPayloadV1 {
  const currentTime = compactPlanningText(input.statusData.world.currentTime, 64) || '未知';
  const currentLocation = compactPlanningText(input.statusData.world.currentLocation, 120) || '未知';
  const playerSchoolIdentity = resolvePlayerSchoolIdentity(input.playerProfile, input.statusData.world.currentTime);
  const playerClass = compactPlanningText(playerSchoolIdentity.className || playerSchoolIdentity.label, 80) || '未知';
  const characterLines = buildIslandPlanningCharacterLines(input.statusData, input.playerProfile);
  const relationshipLines = buildEstablishedRelationshipFactLines(input.statusData.targets, input.memoryDB);
  const appearanceLines = buildAppearanceConstraintLines(input);
  const worldStateLines = buildSaenaiWorldStateFactLines({
    currentTime: input.statusData.world.currentTime,
    playerProfile: input.playerProfile,
    targets: input.statusData.targets,
    currentMainEventId: input.statusData.world.currentMainEventId,
    mainEvents: input.statusData.world.mainEvents,
    eventTriggerCounts: input.statusData.world.eventTriggerCounts,
  })
    .map(line => compactPlanningText(line, 300))
    .filter(Boolean)
    .slice(0, 12);
  const gameDevelopmentContext = compactPlanningBlock(input.gameDevelopmentContext);
  const scenePresenceContext = compactPlanningBlock(
    buildScenePresenceContext(input.statusData, input.scenePresence, input.playerProfile),
    16_000,
  );
  const activeCharacterCards = compactPlanningBlock(
    buildActiveCharacterCards(input.statusData, input.scenePresence, input.characterCardLibrary),
    64_000,
  );
  const relationshipGuidance = input.scenePresence
    ? compactPlanningBlock(
        buildRelationshipGuidanceList(input.statusData, input.playerProfile, input.scenePresence),
        16_000,
      )
    : '';
  const plotContext = compactPlanningBlock(
    buildCurrentPlotContext(input.statusData, input.plotLibrary),
    32_000,
  );

  const lines = [
    '用途：Island 本轮 qrf 规划附录。它只提供审稿约束，不是用户台词、故事正文、记忆召回或世界书。',
    '',
    buildIslandUserIdentityContext(input.playerProfile, input.statusData.world.currentTime),
    '',
    '【当前状态锚点】',
    `- 时间：${currentTime}`,
    `- 地点：${currentLocation}`,
    `- user 班级：${playerClass}`,
    '',
    '【可识别角色名单】',
    ...(characterLines.length ? characterLines : ['- 无']),
  ];

  if (relationshipLines.length) {
    lines.push('', '【已成立关系事实】', ...relationshipLines);
  }
  if (worldStateLines.length) {
    lines.push('', '【作品状态事实】', ...worldStateLines);
  }
  if (appearanceLines.length) {
    lines.push('', '【有依据的外观约束】', ...appearanceLines);
  }
  if (scenePresenceContext) {
    lines.push('', '【本轮镜头判定】', scenePresenceContext);
  }
  if (activeCharacterCards) {
    lines.push('', activeCharacterCards);
  }
  if (relationshipGuidance) {
    lines.push('', '【在场角色局部关系约束】', relationshipGuidance);
  }
  if (plotContext) {
    lines.push('', '【当前剧情大纲】', plotContext);
  }

  addRuleSection(lines, '【当前镜头证据规则】', SCENE_CAMERA_EVIDENCE_RULES);
  addRuleSection(lines, '【新因果规则】', USER_CAUSALITY_RULES);
  addRuleSection(lines, '【人物一致性规则】', CHARACTER_CONSISTENCY_RULES);
  addRuleSection(lines, '【外观一致性规则】', APPEARANCE_CONSISTENCY_RULES);
  addRuleSection(lines, '【Island 作品规则】', ISLAND_WORK_RULES);

  if (gameDevelopmentContext) {
    lines.push(
      '',
      '【本轮游戏开发上下文】',
      gameDevelopmentContext,
      '- 以上只约束本轮规划，不得伪装成用户说过的话。',
    );
  }

  return {
    version: ISLAND_PLANNING_CONTEXT_VERSION,
    content: lines.join('\n').trim(),
    userIdentity: {
      name: compactPlanningText(input.playerProfile.name, 80) || '用户',
      persona: buildIslandUserIdentityContext(input.playerProfile, input.statusData.world.currentTime),
    },
  };
}
