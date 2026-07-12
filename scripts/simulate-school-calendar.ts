import { buildSaenaiWorldStateFactLines } from '../saenai-world-facts';
import { getCharacterAnchorGuidance } from '../relationship';
import {
  buildEducationProfileFromText,
  buildKirihimeSchoolIdentitySegment,
  buildSchoolRelationGuardLine,
  getSchoolYearCount,
  resolvePlayerSchoolIdentity,
  resolveTargetSchoolIdentity,
  syncSchoolCalendarState,
} from '../school-calendar';
import type { PlayerProfile, StatusData, TargetStatus } from '../types';

type SimulationCase = {
  name: string;
  run: () => void;
};

const CLASS_1_A = '1年A班';
const CLASS_1_C = '1年C班';
const CLASS_2_B = '2年B班';
const CLASS_2_G = '2年G班';
const CLASS_3_A = '3年A班';
const CLASS_3_C = '3年C班';
const CLASS_3_F = '3年F班';

const SAMPLE_PROFILES: Record<string, string> = {
  eriri: [
    '姓名:泽村·斯宾塞·英梨梨',
    '生日:1996年3月20日',
    '年龄:16岁(开局为2012年3月31日,4月5日被分入私立丰之崎学园二年级G班,后升入3年级F班)',
    '2013年升入高三,开学后与伦也分到同班甚至同桌。',
  ].join('\n'),
  megumi: [
    '姓名:加藤惠',
    '生日:1995年9月23日',
    '年龄:16岁（私立丰之崎学园二年级B班，后升入三年级A班,毕业后升入大学文学系）。',
  ].join('\n'),
  utaha: [
    '姓名:霞之丘诗羽',
    '生日:1995年1月31日',
    '年龄:17岁(开局为2012年3月31日,4月5日被分入私立丰之崎学园三年级C班,后升入早应大学文学系)',
  ].join('\n'),
  izumi: [
    '姓名:波岛出海',
    '生日:1997年5月5日',
    '年龄:15岁(2012年为初三学生2013年升入丰崎学园1年C组)',
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
    personality: '',
    appearance: '',
    className,
  };
}

function target(id: string, name: string, content = SAMPLE_PROFILES[id] ?? ''): TargetStatus {
  const profile = buildEducationProfileFromText({ name, content });
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
    meta: {
      schoolProfile: profile,
      ageText: profile.ageText,
      birthday: profile.birthday,
      educationText: profile.educationText,
      className: profile.classSteps[0]?.className ?? '',
    },
  };
}

function makeStatus(currentTime: string, targets: TargetStatus[]): StatusData {
  return {
    world: {
      currentTime,
      currentLocation: 'Toyogasaki Academy',
      currentMainEventId: '',
      recentEvents: {},
      mainEvents: {},
      eventTriggerCounts: {},
    },
    targets,
    activeTargetId: null,
    player: { inventory: {} },
  };
}

function simulateKirihimeTargetLine(currentTime: string, profile: PlayerProfile, item: TargetStatus): string {
  return `id=${item.id};name=${item.name}${buildKirihimeSchoolIdentitySegment({
    target: item,
    playerProfile: profile,
    currentTime,
    relationToTomoya: item.id === 'utaha' ? '安艺伦也的学姐（高一届）' : '',
  })}`;
}

const cases: SimulationCase[] = [
  {
    name: 'worldbook sample parser reads birthday and class timeline',
    run: () => {
      const eriri = target('eriri', '泽村·斯宾塞·英梨梨');
      const profile = eriri.meta?.schoolProfile as { birthday?: string; classSteps?: Array<{ className: string }> };
      assert(profile.birthday === '1996-03-20', `expected Eriri birthday, got ${profile.birthday}`);
      assert(profile.classSteps?.some(step => step.className === CLASS_2_G), `expected ${CLASS_2_G}`);
      assert(profile.classSteps?.some(step => step.className === CLASS_3_F), `expected ${CLASS_3_F}`);
    },
  },
  {
    name: 'player selected first-year class remains first-year before 2013 rollover',
    run: () => {
      const identity = resolvePlayerSchoolIdentity(player(CLASS_1_A), '2012-04-06 09:00');
      assert(identity.className === CLASS_1_A, `expected ${CLASS_1_A}, got ${identity.className}`);
    },
  },
  {
    name: '2012-03-31 is before Toyogasaki class split',
    run: () => {
      const identity = resolveTargetSchoolIdentity(target('megumi', '加藤惠'), '2012-03-31 09:00');
      assert(identity.kind === 'not-yet-split', `expected not-yet-split, got ${identity.kind}`);
      assert(!identity.className, `expected no current class, got ${identity.className}`);
    },
  },
  {
    name: '2012-04-05 uses worldbook classes',
    run: () => {
      const megumi = resolveTargetSchoolIdentity(target('megumi', '加藤惠'), '2012-04-05 09:00');
      const eriri = resolveTargetSchoolIdentity(target('eriri', '泽村·斯宾塞·英梨梨'), '2012-04-05 09:00');
      const utaha = resolveTargetSchoolIdentity(target('utaha', '霞之丘诗羽'), '2012-04-05 09:00');
      assert(megumi.className === CLASS_2_B, `expected Megumi ${CLASS_2_B}, got ${megumi.className}`);
      assert(eriri.className === CLASS_2_G, `expected Eriri ${CLASS_2_G}, got ${eriri.className}`);
      assert(utaha.className === CLASS_3_C, `expected Utaha ${CLASS_3_C}, got ${utaha.className}`);
    },
  },
  {
    name: 'third-year user is same-grade with Utaha before graduation',
    run: () => {
      const line = buildSchoolRelationGuardLine({
        target: target('utaha', '霞之丘诗羽'),
        playerProfile: player(CLASS_3_C),
        currentTime: '2012-04-06 09:00',
      });
      assert(line.includes('同班') || line.includes('同年级'), `expected same grade/class relation, got ${line}`);
      assert(!line.includes('是 user 的学姐'), `must not call Utaha user senpai: ${line}`);
    },
  },
  {
    name: 'Utaha graduates on 2013-03-04',
    run: () => {
      const identity = resolveTargetSchoolIdentity(target('utaha', '霞之丘诗羽'), '2013-03-04 15:00');
      assert(identity.kind === 'graduate', `expected graduate, got ${identity.kind}`);
      assert(identity.label.includes('早应大学文学系'), `expected university label, got ${identity.label}`);
      assert(!identity.className, `expected no class, got ${identity.className}`);
    },
  },
  {
    name: '2013-04 uses worldbook promotion classes',
    run: () => {
      const user = resolvePlayerSchoolIdentity(player(CLASS_2_B), '2013-04-01 09:00');
      const megumi = resolveTargetSchoolIdentity(target('megumi', '加藤惠'), '2013-04-01 09:00');
      const eriri = resolveTargetSchoolIdentity(target('eriri', '泽村·斯宾塞·英梨梨'), '2013-04-01 09:00');
      const izumi = resolveTargetSchoolIdentity(target('izumi', '波岛出海'), '2013-04-01 09:00');
      assert(user.className === '3年B班', `expected User 3年B班, got ${user.className}`);
      assert(megumi.className === CLASS_3_A, `expected Megumi ${CLASS_3_A}, got ${megumi.className}`);
      assert(eriri.className === CLASS_3_F, `expected Eriri ${CLASS_3_F}, got ${eriri.className}`);
      assert(izumi.className === CLASS_1_C, `expected Izumi ${CLASS_1_C}, got ${izumi.className}`);
    },
  },
  {
    name: 'player graduation supports first-year, second-year, and third-year starting classes',
    run: () => {
      const firstYear = player(CLASS_1_A);
      assert(resolvePlayerSchoolIdentity(firstYear, '2012-04-05 09:00').className === CLASS_1_A, 'first-year base must remain first-year in 2012');
      assert(resolvePlayerSchoolIdentity(firstYear, '2013-04-01 09:00').className === '2年A班', 'first-year base must advance to second-year in 2013');
      assert(resolvePlayerSchoolIdentity(firstYear, '2014-04-01 09:00').className === '3年A班', 'first-year base must advance to third-year in 2014');
      assert(resolvePlayerSchoolIdentity(firstYear, '2015-03-03 09:00').kind === 'student', 'first-year base must remain a student before the 2015 ceremony');
      assert(resolvePlayerSchoolIdentity(firstYear, '2015-03-04 09:00').kind === 'graduate', 'first-year base must graduate in 2015');

      const secondYear = player(CLASS_2_B);
      assert(resolvePlayerSchoolIdentity(secondYear, '2012-04-05 09:00').className === CLASS_2_B, 'second-year base must remain second-year in 2012');
      assert(resolvePlayerSchoolIdentity(secondYear, '2013-04-01 09:00').className === '3年B班', 'second-year base must advance to third-year in 2013');
      assert(resolvePlayerSchoolIdentity(secondYear, '2014-03-03 09:00').kind === 'student', 'second-year base must remain a student before the 2014 ceremony');
      assert(resolvePlayerSchoolIdentity(secondYear, '2014-03-04 09:00').kind === 'graduate', 'second-year base must graduate in 2014');

      const thirdYear = player(CLASS_3_C);
      assert(resolvePlayerSchoolIdentity(thirdYear, '2013-03-03 09:00').className === CLASS_3_C, 'third-year base must remain third-year before the 2013 ceremony');
      assert(resolvePlayerSchoolIdentity(thirdYear, '2013-03-04 09:00').kind === 'graduate', 'third-year base must graduate in 2013');
    },
  },
  {
    name: 'state sync does not rewrite selected class or target meta className',
    run: () => {
      const profile = player(CLASS_2_B);
      const megumi = target('megumi', '加藤惠');
      const status = makeStatus('2013-04-01 09:00', [megumi]);
      const beforeTargetClass = String(megumi.meta?.className ?? '');
      syncSchoolCalendarState({ currentTime: status.world.currentTime, playerProfile: profile, statusData: status });
      assert(profile.className === CLASS_2_B, `sync must not rewrite player class, got ${profile.className}`);
      assert(megumi.meta?.className === beforeTargetClass, `sync must not rewrite target className, got ${megumi.meta?.className}`);
      assert(profile.schoolIdentityLabel === '私立丰之崎学园 3年B班', `expected player label, got ${profile.schoolIdentityLabel}`);
      assert(megumi.meta?.schoolIdentityLabel === `私立丰之崎学园 ${CLASS_3_A}`, `expected target label, got ${megumi.meta?.schoolIdentityLabel}`);
    },
  },
  {
    name: 'opening and UI should prefer resolved player identity label over selected base class',
    run: () => {
      const profile = player(CLASS_2_B);
      syncSchoolCalendarState({
        currentTime: '2013-04-01 09:00',
        playerProfile: profile,
        statusData: makeStatus('2013-04-01 09:00', []),
      });
      const identity = resolvePlayerSchoolIdentity(profile, '2013-04-01 09:00');
      assert(profile.className === CLASS_2_B, `selected base class must stay ${CLASS_2_B}, got ${profile.className}`);
      assert(profile.schoolIdentityLabel === '私立丰之崎学园 3年B班', `expected synced identity label, got ${profile.schoolIdentityLabel}`);
      assert(identity.className === '3年B班', `expected resolved class 3年B班, got ${identity.className}`);
    },
  },
  {
    name: 'world state facts expose resolved identities',
    run: () => {
      const facts = buildSaenaiWorldStateFactLines({
        currentTime: '2013-04-01 09:00',
        playerProfile: player(CLASS_2_B),
        targets: [target('megumi', '加藤惠'), target('eriri', '泽村·斯宾塞·英梨梨'), target('utaha', '霞之丘诗羽')],
      }).join('\n');
      assert(facts.includes(`加藤惠 = 私立丰之崎学园 ${CLASS_3_A}`), 'expected Megumi resolved fact');
      assert(facts.includes(`泽村·斯宾塞·英梨梨 = 私立丰之崎学园 ${CLASS_3_F}`), 'expected Eriri resolved fact');
      assert(facts.includes('霞之丘诗羽 = 私立丰之崎学园 graduate / 早应大学文学系'), 'expected Utaha graduate fact');
    },
  },
  {
    name: 'school-year count advances only at the April boundary',
    run: () => {
      assert(getSchoolYearCount('2012-12-07') === 0, 'expected 2012 school year count 0');
      assert(getSchoolYearCount('2013-03-04') === 0, 'expected graduation day to remain in 2012 school year');
      assert(getSchoolYearCount('2013-03-31') === 0, 'expected March 31 count 0');
      assert(getSchoolYearCount('2013-04-01') === 1, 'expected April 1 count 1');
    },
  },
  {
    name: 'school-age targets never become high-school fourth-years',
    run: () => {
      const megumi = resolveTargetSchoolIdentity(target('megumi', '加藤惠'), '2014-04-01 09:00');
      const eriri = resolveTargetSchoolIdentity(target('eriri', '泽村·斯宾塞·英梨梨'), '2014-04-01 09:00');
      assert(megumi.kind === 'graduate', `expected Megumi graduate instead of high-school fourth-year, got ${megumi.label}`);
      assert(eriri.kind === 'graduate', `expected Eriri graduate instead of high-school fourth-year, got ${eriri.label}`);
      assert(!megumi.className.includes('4年'), `must not create Megumi high-school fourth-year: ${megumi.className}`);
      assert(!eriri.className.includes('4年'), `must not create Eriri high-school fourth-year: ${eriri.className}`);
    },
  },
  {
    name: 'DLC school profiles use the same grade boundary',
    run: () => {
      const shoko = target('shoko', '西宫硝子');
      const thirdYear = resolveTargetSchoolIdentity(shoko, '2013-04-01 09:00');
      const graduate = resolveTargetSchoolIdentity(shoko, '2014-03-01 09:00');
      assert(thirdYear.className === '3年', `expected DLC third-year identity, got ${thirdYear.label}`);
      assert(graduate.kind === 'graduate', `expected DLC graduate boundary, got ${graduate.label}`);
      assert(!graduate.className.includes('4年'), `must not create DLC high-school fourth-year: ${graduate.className}`);
    },
  },
  {
    name: 'Utaha graduation identity rolls back with story date',
    run: () => {
      const utaha = target('utaha', '霞之丘诗羽');
      const after = resolveTargetSchoolIdentity(utaha, '2013-03-10 09:00');
      const before = resolveTargetSchoolIdentity(utaha, '2013-03-01 09:00');
      assert(after.kind === 'graduate', `expected graduate after ceremony, got ${after.kind}`);
      assert(before.kind === 'student', `expected rollback to student identity, got ${before.kind}`);
    },
  },
  {
    name: 'cached school sync time is never used to guess current grade',
    run: () => {
      const megumi = target('megumi', '加藤惠');
      megumi.meta = { ...megumi.meta, schoolCalendarSyncedAt: '2013-04-01' };
      const guidance = getCharacterAnchorGuidance({ target: megumi, playerProfile: player(CLASS_2_B) });
      assert(!guidance.includes('School relation guard'), `must not use cached school time: ${guidance}`);
      assert(!guidance.includes('3年'), `must not infer a current grade without current story time: ${guidance}`);
    },
  },
  {
    name: 'SAE-07-8 ceremony is active only before its successful trigger count increments',
    run: () => {
      const targets = [
        target('utaha', '霞之丘诗羽'),
        target('izumi', '波岛出海'),
        target('shoko', '西宫硝子'),
        target('akane', '红坂朱音'),
        target('sonoko', '町田苑子'),
        target('sayuri', '泽村小百合'),
      ];
      const baseInput = {
        currentTime: '2013-03-04 15:00',
        playerProfile: player(CLASS_2_B),
        targets,
        currentMainEventId: 'SAE_07-8',
        mainEvents: { 'SAE_07-8': '进行中' },
      };
      const firstTrigger = buildSaenaiWorldStateFactLines({
        ...baseInput,
        eventTriggerCounts: { 'SAE_07-8': 0 },
      }).join('\n');
      const alreadyTriggered = buildSaenaiWorldStateFactLines({
        ...baseInput,
        eventTriggerCounts: { 'SAE_07-8': 1 },
      }).join('\n');
      assert(firstTrigger.includes('active SAE_07-8 graduation ceremony'), 'expected first ceremony trigger');
      for (const name of ['波岛出海', '西宫硝子', '红坂朱音', '町田苑子', '泽村小百合']) {
        assert(firstTrigger.includes(`${name} is NOT graduating`), `expected explicit non-graduate guard for ${name}`);
      }
      assert(!firstTrigger.includes('霞之丘诗羽 is NOT graduating'), 'Utaha must remain the graduating participant');
      assert(!alreadyTriggered.includes('active SAE_07-8 graduation ceremony'), 'count 1 must block repeated ceremony');
    },
  },
  {
    name: 'SAE-07-8 ceremony requires the active unfinished event on the exact date',
    run: () => {
      const baseInput = {
        playerProfile: player(CLASS_2_B),
        targets: [target('utaha', '霞之丘诗羽'), target('izumi', '波岛出海')],
        eventTriggerCounts: { 'SAE_07-8': 0 },
      };
      const inactive = buildSaenaiWorldStateFactLines({
        ...baseInput,
        currentTime: '2013-03-04 15:00',
        currentMainEventId: 'SAE_07-7',
        mainEvents: { 'SAE_07-8': '未触发' },
      }).join('\n');
      const finished = buildSaenaiWorldStateFactLines({
        ...baseInput,
        currentTime: '2013-03-04 15:00',
        currentMainEventId: 'SAE_07-8',
        mainEvents: { 'SAE_07-8': '已结束' },
      }).join('\n');
      const later = buildSaenaiWorldStateFactLines({
        ...baseInput,
        currentTime: '2013-03-05 09:00',
        currentMainEventId: 'SAE_07-8',
        mainEvents: { 'SAE_07-8': '进行中' },
      }).join('\n');
      assert(!inactive.includes('active SAE_07-8 graduation ceremony'), 'inactive event must not trigger ceremony');
      assert(!finished.includes('active SAE_07-8 graduation ceremony'), 'finished event must not trigger ceremony');
      assert(!later.includes('active SAE_07-8 graduation ceremony'), 'later date must not trigger ceremony');
    },
  },
  {
    name: 'Kirihime input separates current user relation from Tomoya relation',
    run: () => {
      const line = simulateKirihimeTargetLine('2012-04-06 09:00', player(CLASS_3_C), target('utaha', '霞之丘诗羽'));
      assert(line.includes('当前身份=3年C班'), `expected current identity, got ${line}`);
      assert(line.includes('同班') || line.includes('同年级'), `expected user relation, got ${line}`);
      assert(line.includes('原作关系(仅对安艺伦也)=安艺伦也的学姐'), `expected Tomoya-only relation, got ${line}`);
      assert(!line.includes('与user学年关系=学年身份：角色=3年C班，user=3年C班；比 user 高'), `must not treat same-grade user as junior: ${line}`);
    },
  },
  {
    name: 'Kirihime input uses graduation identity after 2013-03-04',
    run: () => {
      const line = simulateKirihimeTargetLine('2013-03-04 15:00', player(CLASS_2_B), target('utaha', '霞之丘诗羽'));
      assert(line.includes('当前身份=私立丰之崎学园 graduate / 早应大学文学系'), `expected graduate identity, got ${line}`);
      assert(!line.includes('当前身份=3年C班'), `must not leak old class, got ${line}`);
    },
  },
];

for (const item of cases) {
  item.run();
  console.log(`ok - ${item.name}`);
}
