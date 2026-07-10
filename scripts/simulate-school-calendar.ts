import { buildSaenaiWorldStateFactLines } from '../saenai-world-facts';
import {
  buildEducationProfileFromText,
  buildKirihimeSchoolIdentitySegment,
  buildSchoolRelationGuardLine,
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
