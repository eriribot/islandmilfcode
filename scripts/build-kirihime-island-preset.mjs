import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const downloads = path.join(process.env.USERPROFILE || process.cwd(), 'Downloads');
const sourcePath = path.resolve(process.argv[2] || path.join(downloads, '新预设.plot-preset.json'));
const outputPath = path.resolve(
  process.argv[3] || path.join(downloads, '新预设-夏野雾姬-Island.plot-preset.json'),
);
const presetName = '新预设-夏野雾姬-Island';
const marker = 'islandPlanningContext:v1';

assert.notEqual(sourcePath, outputPath, 'contract: fused preset must be a new copy');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const imported = JSON.parse(sourceText);
assert.equal(Array.isArray(imported), true, 'contract: imported preset is an array');
assert.equal(imported.length, 1, 'contract: this builder expects exactly one preset');

const mainPrompt = [
  '你是夏野雾姬，冷峻、毒舌、判断锋利的小说编辑。你只担任审稿与规划人格，不是故事角色。',
  '原作只提供人物骨架和主题母本；user 的行动、选择、关系与既成事件都是有效新变量。你的工作是保护新因果，不是把故事拖回旧轨。',
  '',
  '<background>',
  '<user_profile>',
  '$U',
  '</user_profile>',
  '<character_and_runtime_context>',
  '$C',
  '</character_and_runtime_context>',
  '<worldbook_context>',
  '$1',
  '</worldbook_context>',
  '</background>',
  '',
  '<recent_assistant_story>',
  '$7',
  '</recent_assistant_story>',
  '',
  '<memory_index>',
  '$5',
  '</memory_index>',
  '',
  '<current_user_input>',
  '$8',
  '</current_user_input>',
].join('\n');

const taskPrompt = [
  '执行一次夏野雾姬式页边审稿。只返回下列三个 XML 标签，不得输出标签外文字、思维过程、确认语或故事续写。',
  '',
  '一、<recall>',
  '- 唯一来源是 <memory_index> 中真实存在的 AM 编码。',
  '- 按本轮相关性选择，不超过 zhaohui 条；编码之外不得附理由、标题、计数或说明。',
  '- 不得从背景、近期正文或常识发明 AM 编码；无可用编码时标签保持为空。',
  '- 格式示例：<recall>AM0003, AM0017</recall>。',
  '',
  '二、<supplement>',
  '- 只从 <background> 提取会实际约束下一页的既有事实，允许 0-6 条。',
  '- 每条一行，以“- ”开头；没有真正相关事实时标签保持为空，不凑数。',
  '- 不得把近期正文、本轮输入、推测、AM 编码或审稿意见混入 supplement。',
  '',
  '三、<kirihime_review>',
  '- 当前镜头证据只看 <recent_assistant_story> + <current_user_input>。背景或表中的“在场/离场”仅是旧元数据。',
  '- 地点冲突、被提及、曾经登场、关系亲密或“她应该出现”都不能单独证明当前在场。最近正文明确离场时必须判为 absent；只被提及时应判 uncertain。',
  '- camera 必须分别列 present、focus、absent、uncertain；没有证据的栏位写“无”，不得把不确定者塞进 present。',
  '- causal_change 只写 user 本轮造成的新因果；没有新变化时写“无新增因果”，不得虚构变化。',
  '- next_page 写下一页应顺着哪条已成立因果推进，不代写台词或正文。',
  '- suppress_canon_return 写本轮必须抑制的旧剧情回轨；原作关系与已成立的新关系冲突时，抑制原作惯性。没有时写“无”。',
  '- appearance_constraints 只写背景、近期正文或 Island 运行附录有依据的外观锚点；不知道就写“无可靠约束”，严禁补发色、体型、胸围或服装。',
  '- 原作中的青梅竹马、学姐、表姐等关系只锚定到安艺伦也，不能自动移植给 user。',
  '- 不在镜头内的角色不得获得即时动作、台词或心理反应。夏野雾姬不得进入故事镜头。',
  '',
  '<kirihime_review> 内严格使用以下字段：',
  'camera:',
  '- present: ...',
  '- focus: ...',
  '- absent: ...',
  '- uncertain: ...',
  'causal_change: ...',
  'next_page: ...',
  'suppress_canon_return: ...',
  'appearance_constraints: ...',
  '',
  '最终输出骨架：',
  '<recall></recall>',
  '<supplement></supplement>',
  '<kirihime_review></kirihime_review>',
].join('\n');

const finalDirective = [
  '[SYSTEM_DIRECTIVE: Follow the planning evidence below while writing the next story page. Do not expose planning tags or planning commentary in the visible story.]',
  '',
  '<current_user_input>',
  '$8',
  '</current_user_input>',
  '',
  '<planning_evidence>',
  '{{kirihime_review}}',
  '{{recall}}',
  '{{supplement}}',
  '</planning_evidence>',
  '',
  '把 kirihime_review 当作镜头与因果约束；recall 只是待召回的 AM 索引；supplement 只是相关背景事实。不得让夏野雾姬作为角色进入正文。',
].join('\n');

const promptGroup = [
  {
    role: 'SYSTEM',
    content: mainPrompt,
    deletable: false,
    mainSlot: 'A',
    isMain: true,
  },
  {
    role: 'USER',
    content: taskPrompt,
    deletable: false,
    mainSlot: 'B',
    isMain2: true,
  },
];

const preset = structuredClone(imported[0]);
preset.name = presetName;
preset.description = marker;
preset.extractTags = 'recall,supplement,kirihime_review';
preset.finalSystemDirective = finalDirective;
preset.promptGroup = structuredClone(promptGroup);
preset.prompts = [
  {
    id: 'mainPrompt',
    name: '主系统提示词',
    role: 'system',
    content: mainPrompt,
    deletable: false,
  },
  {
    id: 'systemPrompt',
    name: '夏野雾姬审稿指令',
    role: 'user',
    content: taskPrompt,
    deletable: false,
  },
  {
    id: 'finalSystemDirective',
    name: '最终注入指令',
    role: 'system',
    content: finalDirective,
    deletable: false,
  },
];

assert.equal(Array.isArray(preset.plotTasks), true, 'contract: source preset exposes plotTasks');
assert.equal(preset.plotTasks.length, 1, 'contract: fused preset keeps one planning task');
const task = preset.plotTasks[0];
task.name = '夏野雾姬审稿';
task.description = marker;
task.promptGroup = structuredClone(promptGroup);
task.extractTags = preset.extractTags;
task.extractInjectTags = '';
task.finalDirectiveTemplate = finalDirective;

function countToken(text, token) {
  return String(text).split(token).length - 1;
}

function verifyFusedPreset(candidate) {
  const [only] = candidate;
  const onlyTask = only.plotTasks[0];
  const planningText = onlyTask.promptGroup.map(item => item.content).join('\n');
  const legacyPlanningText = only.promptGroup.map(item => item.content).join('\n');
  const forbidden = [/<thought>/i, /故事发展推测/, /收到(?:命令|指令|，我将)/, /6\s*[-–—]\s*8\s*条/];

  assert.equal(only.name, presetName);
  assert.equal(only.description, marker);
  assert.equal(onlyTask.description, marker);
  assert.equal(only.extractTags, 'recall,supplement,kirihime_review');
  assert.equal(onlyTask.extractTags, only.extractTags);
  assert.deepEqual(only.promptGroup, onlyTask.promptGroup, 'contract: top-level and task prompt groups stay mirrored');
  assert.equal(legacyPlanningText, planningText, 'contract: legacy and task planning calls are identical');
  assert.equal(only.finalSystemDirective, onlyTask.finalDirectiveTemplate);
  assert.equal(only.prompts.find(item => item.id === 'mainPrompt')?.content, mainPrompt);
  assert.equal(only.prompts.find(item => item.id === 'systemPrompt')?.content, taskPrompt);
  assert.equal(only.prompts.find(item => item.id === 'finalSystemDirective')?.content, finalDirective);
  assert.equal(countToken(planningText, '$8'), 1, 'contract: planning sees current user input exactly once');
  assert.equal(countToken(only.finalSystemDirective, '$8'), 1, 'contract: final generation sees current input exactly once');
  assert.equal(countToken(planningText, '$1'), 1, 'contract: shujuku remains the sole worldbook placeholder owner');
  assert.equal(countToken(planningText, '$5'), 1);
  assert.equal(countToken(planningText, '$7'), 1);
  assert.equal(countToken(planningText, '$C'), 1);
  assert.equal(countToken(planningText, '$U'), 1);
  assert.deepEqual(
    onlyTask.promptGroup.map(item => item.role),
    ['SYSTEM', 'USER'],
    'contract: planning has no acknowledgement assistant turns',
  );
  assert.equal(countToken(only.finalSystemDirective, '{{recall}}'), 1);
  assert.equal(countToken(only.finalSystemDirective, '{{supplement}}'), 1);
  assert.equal(countToken(only.finalSystemDirective, '{{kirihime_review}}'), 1);
  const expandedDirective = only.finalSystemDirective.replace(
    /\{\{(\w+)\}\}/g,
    (_placeholder, tagName) => `<${tagName}>VALUE</${tagName}>`,
  );
  for (const tagName of ['recall', 'supplement', 'kirihime_review']) {
    assert.equal(
      countToken(expandedDirective, `<${tagName}>`),
      1,
      `contract: shujuku expansion produces exactly one ${tagName} wrapper`,
    );
    assert.equal(countToken(expandedDirective, `</${tagName}>`), 1);
  }
  for (const pattern of forbidden) {
    assert.doesNotMatch(planningText, pattern, `contract: planning prompt excludes ${pattern}`);
  }
  assert.match(planningText, /允许 0-6 条/);
  assert.match(planningText, /无可用编码时标签保持为空/);
  assert.match(planningText, /表中的“在场\/离场”仅是旧元数据/);
  assert.match(planningText, /抑制原作惯性/);
}

const output = [preset];
verifyFusedPreset(output);
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceText, 'contract: source preset remains unchanged');
verifyFusedPreset(JSON.parse(fs.readFileSync(outputPath, 'utf8')));

console.info(`[kirihime-island-preset] generated and verified: ${outputPath}`);
