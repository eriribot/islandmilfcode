import { buildSaenaiWorldStateFactLines } from '../saenai-world-facts';
import {
  buildEducationProfileFromText,
  buildKirihimeSchoolIdentitySegment,
  buildSchoolRelationGuardLine,
  resolvePlayerSchoolIdentity,
  resolveTargetSchoolIdentity,
  syncSchoolCalendarState,
} from '../school-calendar';
import type { PlayerProfile, TargetStatus } from '../types';

const BEFORE_SPLIT = '2012-03-31 09:00';
const AFTER_SPLIT = '2012-04-06 09:00';
const AFTER_2013_PROMOTION = '2013-04-01 09:00';
const AFTER_2014_GRADUATION = '2014-03-01 15:00';
const PROFILE_TEXT: Record<string, string> = {
  utaha: [
    '姓名:霞之丘诗羽',
    '生日:1995年1月31日',
    '年龄:17岁(开局为2012年3月31日,4月5日被分入私立丰之崎学园三年级C班,后升入早应大学文学系)',
  ].join('\n'),
  megumi: [
    '姓名:加藤惠',
    '生日:1995年9月23日',
    '年龄:16岁（私立丰之崎学园二年级B班，后升入三年级A班，毕业后升入大学文学系）。',
  ].join('\n'),
};

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function player(className: string): PlayerProfile {
  return {
    name: 'User',
    familyName: '',
    givenName: 'User',
    gender: '男',
    personality: '',
    appearance: '',
    className,
  };
}

function target(id: 'utaha' | 'megumi', name: string): TargetStatus {
  const profile = buildEducationProfileFromText({ name, content: PROFILE_TEXT[id] });
  return {
    id,
    name,
    alias: id,
    affinity: 0,
    obsession: 0,
    stage: '',
    obsessionStage: '',
    titles: {},
    outfits: {},
    meta: { schoolProfile: profile },
  };
}

function simulatedStudent(grade: 1 | 2 | 3): TargetStatus {
  const name = `模拟${grade}年级角色`;
  const profile = buildEducationProfileFromText({
    name,
    content: `身份:私立丰之崎学园${grade}年C班`,
  });
  return {
    id: `sim-grade-${grade}`,
    name,
    alias: `sim-grade-${grade}`,
    affinity: 0,
    obsession: 0,
    stage: '',
    obsessionStage: '',
    titles: {},
    outfits: {},
    meta: { schoolProfile: profile },
  };
}

const utaha = (): TargetStatus => target('utaha', '霞之丘诗羽');
const megumi = (): TargetStatus => target('megumi', '加藤惠');

function namedTarget(id: string, name: string, alias = id, profileText = ''): TargetStatus {
  const profile = profileText ? buildEducationProfileFromText({ name, content: profileText }) : undefined;
  return {
    id,
    name,
    alias,
    affinity: 0,
    obsession: 0,
    stage: '',
    obsessionStage: '',
    titles: {},
    outfits: {},
    meta: profile ? { schoolProfile: profile } : {},
  };
}

function assertNoConcreteClass(text: string): void {
  assert(!/[123]年[A-Z\d]+班/.test(text), `分班前不应泄露具体班级：${text}`);
}

function assertPeer(line: string): void {
  assert(line.includes('同辈'), `应判定为同辈，实际得到：${line}`);
  assert(line.includes('禁止 user 称其为“学姐/前辈”或“学妹/后辈”'), `应禁止给同辈套用上下级称呼：${line}`);
  assert(!line.includes('是 user 的学姐/前辈'), `同辈不应判为学姐：${line}`);
  assert(!line.includes('是 user 的学妹/后辈'), `同辈不应判为学妹：${line}`);
}

function assertSenior(line: string, gap = 1): void {
  assert(line.includes(`比 user 高 ${gap} 届`), `应判定角色比玩家高${gap}届，实际得到：${line}`);
  assert(line.includes('是 user 的学姐/前辈'), `应判定为玩家的学姐/前辈：${line}`);
  assert(!line.includes('是 user 的学妹/后辈'), `学姐不应判为学妹：${line}`);
}

function assertJunior(line: string, gap = 1): void {
  assert(line.includes(`比 user 低 ${gap} 届`), `应判定角色比玩家低${gap}届，实际得到：${line}`);
  assert(line.includes('是 user 的学妹/后辈'), `应判定为玩家的学妹/后辈：${line}`);
  assert(!line.includes('是 user 的学姐/前辈'), `学妹不应判为学姐：${line}`);
}

const playerBeforeSplit = resolvePlayerSchoolIdentity(player('3年A班'), BEFORE_SPLIT);
const utahaBeforeSplit = resolveTargetSchoolIdentity(utaha(), BEFORE_SPLIT);
assert(playerBeforeSplit.label === '私立丰之崎学园分班前', `玩家界面应显示分班前：${playerBeforeSplit.label}`);
assert(utahaBeforeSplit.label === '私立丰之崎学园分班前', `诗羽界面应显示分班前：${utahaBeforeSplit.label}`);
assert(!playerBeforeSplit.className && !utahaBeforeSplit.className, '分班前的公开身份不应带具体班级');
assert(playerBeforeSplit.grade === null && utahaBeforeSplit.grade === null, '分班前的公开年级应继续隐藏');
assert(playerBeforeSplit.relationGrade === 3, `内部应记得玩家选择三年级：${playerBeforeSplit.relationGrade}`);
assert(utahaBeforeSplit.relationGrade === 3, `内部应知道诗羽用于辈分判断的年级：${utahaBeforeSplit.relationGrade}`);
console.log('ok - 分班前界面隐藏班级，但内部保留辈分判断所需年级');

const syncedPlayer = player('3年A班');
syncSchoolCalendarState({ currentTime: BEFORE_SPLIT, playerProfile: syncedPlayer });
assert(syncedPlayer.className === '3年A班', `同步不应改掉玩家选择的班级：${syncedPlayer.className}`);
assert(syncedPlayer.schoolIdentityLabel === '私立丰之崎学园分班前', `页面仍应显示分班前：${syncedPlayer.schoolIdentityLabel}`);
console.log('ok - 页面继续显示分班前，玩家选择的三年级资料没有被改掉');

for (const currentTime of [BEFORE_SPLIT, AFTER_SPLIT]) {
  const phase = currentTime === BEFORE_SPLIT ? '分班前' : '分班后';
  const peerLine = buildSchoolRelationGuardLine({
    target: utaha(),
    playerProfile: player('3年A班'),
    currentTime,
  });
  const seniorLine = buildSchoolRelationGuardLine({
    target: utaha(),
    playerProfile: player('2年B班'),
    currentTime,
  });
  const juniorLine = buildSchoolRelationGuardLine({
    target: megumi(),
    playerProfile: player('3年A班'),
    currentTime,
  });

  assertPeer(peerLine);
  assertSenior(seniorLine);
  assertJunior(juniorLine);
  if (currentTime === BEFORE_SPLIT) {
    assertNoConcreteClass(peerLine);
    assertNoConcreteClass(seniorLine);
    assertNoConcreteClass(juniorLine);
  }
  console.log(`ok - ${phase}的同辈、学姐、学妹三种关系均正确`);
}

for (const currentTime of [BEFORE_SPLIT, AFTER_SPLIT]) {
  for (const playerGrade of [1, 2, 3] as const) {
    for (const targetGrade of [1, 2, 3] as const) {
      const line = buildSchoolRelationGuardLine({
        target: simulatedStudent(targetGrade),
        playerProfile: player(`${playerGrade}年A班`),
        currentTime,
      });
      if (targetGrade === playerGrade) assertPeer(line);
      else if (targetGrade > playerGrade) assertSenior(line, targetGrade - playerGrade);
      else assertJunior(line, playerGrade - targetGrade);
      if (currentTime === BEFORE_SPLIT) assertNoConcreteClass(line);
    }
  }
}
console.log('ok - 1、2、3年级全部18种分班前后组合均正确');

const sameClassLine = buildSchoolRelationGuardLine({
  target: utaha(),
  playerProfile: player('3年C班'),
  currentTime: AFTER_SPLIT,
});
assert(sameClassLine.includes('同班'), `应判定为同班，实际得到：${sameClassLine}`);
assertPeer(sameClassLine);
console.log('ok - 同班角色也明确属于同辈，不会套用学姐或学妹称呼');

const kirihimeSegment = buildKirihimeSchoolIdentitySegment({
  target: utaha(),
  playerProfile: player('3年A班'),
  currentTime: BEFORE_SPLIT,
  relationToTomoya: '安艺伦也的学姐（高一届）',
});
assert(kirihimeSegment.includes('当前身份=私立丰之崎学园分班前'), `桐姬输入应隐藏具体班级：${kirihimeSegment}`);
assertPeer(kirihimeSegment);
assertNoConcreteClass(kirihimeSegment);
assert(
  kirihimeSegment.includes('原作关系(仅对安艺伦也)=安艺伦也的学姐（高一届）'),
  `应保留只属于安艺伦也的原作关系：${kirihimeSegment}`,
);
console.log('ok - 分班前“学姐”只属于安艺伦也，不会套到三年级玩家身上');

const worldFactLines = buildSaenaiWorldStateFactLines({
  currentTime: BEFORE_SPLIT,
  playerProfile: player('3年A班'),
  targets: [utaha(), megumi()],
});
const utahaWorldFact = worldFactLines.find(line => line.includes('School relation guard') && line.includes('霞之丘诗羽')) ?? '';
const megumiWorldFact = worldFactLines.find(line => line.includes('School relation guard') && line.includes('加藤惠')) ?? '';
assertPeer(utahaWorldFact);
assertJunior(megumiWorldFact);
assertNoConcreteClass(worldFactLines.join('\n'));
console.log('ok - 实际送给生成流程的学校事实同时保留隐藏规则和正确辈分');

const graduatedUtahaVsStudent = buildSchoolRelationGuardLine({
  target: utaha(),
  playerProfile: player('2年B班'),
  currentTime: AFTER_2013_PROMOTION,
});
assert(graduatedUtahaVsStudent.includes('角色已经毕业、user 仍在校'), `应区分毕业角色和在校玩家：${graduatedUtahaVsStudent}`);
assert(graduatedUtahaVsStudent.includes('是 user 的学姐/前辈'), `毕业后的诗羽仍应是玩家学姐：${graduatedUtahaVsStudent}`);
assert(graduatedUtahaVsStudent.includes('user 是角色的学弟/后辈'), `在校玩家应是诗羽学弟：${graduatedUtahaVsStudent}`);
console.log('ok - 角色毕业后仍是在校玩家的学姐/前辈');

const graduatedPlayerVsStudent = buildSchoolRelationGuardLine({
  target: megumi(),
  playerProfile: player('3年A班'),
  currentTime: AFTER_2013_PROMOTION,
});
assert(graduatedPlayerVsStudent.includes('user 已经毕业、角色仍在校'), `应区分毕业玩家和在校角色：${graduatedPlayerVsStudent}`);
assert(graduatedPlayerVsStudent.includes('user 是角色的学长/前辈'), `毕业玩家仍应是角色学长：${graduatedPlayerVsStudent}`);
assert(graduatedPlayerVsStudent.includes('是 user 的学妹/后辈'), `在校角色应是毕业玩家的学妹：${graduatedPlayerVsStudent}`);
console.log('ok - 玩家毕业后仍是在校角色的学长/前辈');

const sameCohortGraduates = buildSchoolRelationGuardLine({
  target: utaha(),
  playerProfile: player('3年A班'),
  currentTime: AFTER_2013_PROMOTION,
});
assert(sameCohortGraduates.includes('双方均已毕业'), `应识别双方都已毕业：${sameCohortGraduates}`);
assertPeer(sameCohortGraduates);
console.log('ok - 同届双方毕业后仍是同辈');

const differentCohortGraduates = buildSchoolRelationGuardLine({
  target: megumi(),
  playerProfile: player('3年A班'),
  currentTime: AFTER_2014_GRADUATION,
});
assert(differentCohortGraduates.includes('双方均已毕业'), `应识别不同届双方都已毕业：${differentCohortGraduates}`);
assert(differentCohortGraduates.includes('user 是角色的学长/前辈'), `应按 baseClass 判定玩家是学长：${differentCohortGraduates}`);
assert(differentCohortGraduates.includes('角色比 user 低 1 届'), `应按 baseClass 保留一届差：${differentCohortGraduates}`);
console.log('ok - 不同届双方毕业后按 baseClass 保留学长/学妹关系');

const graduatedPlayerIdentity = resolvePlayerSchoolIdentity(player('3年A班'), AFTER_2013_PROMOTION);
assert(graduatedPlayerIdentity.label === '私立丰之崎学园 graduate', `页面应显示毕业生：${graduatedPlayerIdentity.label}`);
assert(!graduatedPlayerIdentity.className, `毕业页面不应重新显示旧班级：${graduatedPlayerIdentity.className}`);
assert(graduatedPlayerIdentity.baseGrade === 3, `内部应保留 baseClass 的三年级学届：${graduatedPlayerIdentity.baseGrade}`);
console.log('ok - 毕业页面不显示旧班级，内部仍保留 baseClass 学届');

const adultElders = [
  namedTarget('sayuri', '泽村小百合', '小百合 / 泽村夫人', '生日:1970年1月1日\n身份:已婚成人女性'),
  namedTarget('町田苑子', '町田苑子', '町田 / 苑子 / 霞诗子责编', '生日:1980年1月1日\n身份:成年职业女性'),
  namedTarget('akane', '高坂茜(红坂朱音)', '红坂朱音 / 朱音', '生日:1980年1月1日\n身份:成年职业女性'),
];
const adultFactLines = buildSaenaiWorldStateFactLines({
  currentTime: AFTER_SPLIT,
  playerProfile: player('2年G班'),
  targets: adultElders,
});
const adultFacts = adultFactLines.join('\n');
for (const adult of adultElders) {
  const identity = resolveTargetSchoolIdentity(adult, AFTER_SPLIT);
  const relation = adultFactLines.find(line => line.includes('School relation guard') && line.includes(adult.name)) ?? '';
  assert(identity.kind === 'unknown' && !identity.label, `${adult.name}不应被编造成学校毕业生：${identity.label}`);
  assert(!adultFacts.includes(`School identity: ${adult.name}`), `${adult.name}不应输出虚构学校身份：${adultFacts}`);
  assert(relation.includes('按成年人长辈处理'), `${adult.name}应明确按成年人长辈处理：${relation}`);
  assert(!relation.includes('是 user 的学姐/前辈'), `${adult.name}不应被判成 user 的学校学姐：${relation}`);
}
console.log('ok - 小百合、町田苑子、红坂朱音只按成年人长辈处理，不虚构丰之崎经历');

const shoko = namedTarget('shoko', '西宫硝子', '西宫 / 硝子 / Shoko Nishimiya');
for (const currentTime of [BEFORE_SPLIT, AFTER_SPLIT]) {
  const identity = resolveTargetSchoolIdentity(shoko, currentTime);
  const relation = buildSchoolRelationGuardLine({
    target: shoko,
    playerProfile: player('2年G班'),
    currentTime,
  });
  assert(identity.schoolName === '外校', `硝子应属于外校：${identity.label}`);
  assert(identity.className === '2年', `硝子应与伦也、惠同为二年级：${identity.label}`);
  assert(relation.includes('两者不同学校，不是同班'), `硝子不应被写成丰之崎同学：${relation}`);
  assert(relation.includes('处于同年级、同一学届'), `硝子应与二年级 user 同届：${relation}`);
  assertPeer(relation);
}
const shokoFacts = buildSaenaiWorldStateFactLines({
  currentTime: AFTER_SPLIT,
  playerProfile: player('2年G班'),
  targets: [shoko],
}).join('\n');
assert(shokoFacts.includes('School identity: 西宫硝子 = 外校 2年.'), `硝子应输出外校二年级身份：${shokoFacts}`);
assert(!shokoFacts.includes('西宫硝子 = 私立丰之崎学园'), `硝子不得被编入丰之崎：${shokoFacts}`);
const promotedShoko = resolveTargetSchoolIdentity(shoko, AFTER_2013_PROMOTION);
assert(promotedShoko.schoolName === '外校' && promotedShoko.className === '3年', `硝子应与惠同步升入三年级：${promotedShoko.label}`);
console.log('ok - 西宫硝子是外校学生，与伦也、加藤惠同届并同步升学');

const michiruPeerLine = buildSchoolRelationGuardLine({
  target: namedTarget('michiru', '冰堂美智留'),
  playerProfile: player('2年G班'),
  currentTime: AFTER_SPLIT,
});
assert(michiruPeerLine.includes('两者不同学校，不是同班'), `美智留应保持外校身份：${michiruPeerLine}`);
assertPeer(michiruPeerLine);
console.log('ok - 美智留和同年级玩家也明确是不同学校的同辈');
