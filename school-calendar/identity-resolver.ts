import type { PlayerProfile, TargetStatus } from '../types';
import { CLASS_SPLIT_DATE, TOYOGASAKI_2013_SCHOOL_YEAR_DATE, UTAHA_GRADUATION_DATE } from './constants';
import {
  type EducationProfile,
  getGradeNumber,
  getPlayerEducationProfile,
  getTargetEducationProfile,
  normalizeClassName,
} from './education-profile';

export type SchoolIdentityKind = 'unknown' | 'not-yet-split' | 'student' | 'graduate';

export type SchoolIdentitySource = 'date-rule' | 'profile' | 'worldbook' | 'fallback' | 'unknown';

export type ResolvedSchoolIdentity = {
  id: string;
  name: string;
  kind: SchoolIdentityKind;
  schoolName: string;
  className: string;
  label: string;
  source: SchoolIdentitySource;
  facts: string[];
  grade: number | null;
};

type TargetIdentityInput = Pick<TargetStatus, 'id' | 'name' | 'alias' | 'meta'>;

type BuiltInEducationRule = {
  birthday: string;
  schoolName: string;
  universityName?: string;
  universityDepartment?: string;
  graduationDate?: string;
  steps: Array<{ date: string; className: string; schoolName?: string; rawText?: string }>;
};

const BUILT_IN_RULES: Record<string, BuiltInEducationRule> = {
  megumi: {
    birthday: '1995-09-23',
    schoolName: '私立丰之崎学园',
    steps: [
      { date: '', className: '2年B班' },
      { date: '', className: '3年A班' },
    ],
  },
  eriri: {
    birthday: '1996-03-20',
    schoolName: '私立丰之崎学园',
    steps: [
      { date: '', className: '2年G班' },
      { date: '', className: '3年F班' },
    ],
  },
  utaha: {
    birthday: '1995-01-31',
    schoolName: '私立丰之崎学园',
    universityName: '早应大学',
    universityDepartment: '文学系',
    graduationDate: UTAHA_GRADUATION_DATE,
    steps: [{ date: '', className: '3年C班' }],
  },
  izumi: {
    birthday: '1997-05-05',
    schoolName: '私立丰之崎学园',
    steps: [
      { date: '', className: '初3', schoolName: '中学' },
      { date: '', className: '1年C班', schoolName: '私立丰之崎学园' },
    ],
  },
  michiru: {
    birthday: '1995-12-18',
    schoolName: '县立椿姬女子高校',
    steps: [
      { date: '', className: '2年3班' },
      { date: '', className: '3年3班' },
    ],
  },
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function getDatePart(value: string | undefined): string {
  return text(value).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

function getSchoolYear(date: string): number | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month >= 4 ? year : year - 1;
}

function getHighSchoolStartYear(birthday: string): number | null {
  const match = birthday.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthDay = `${match[2]}-${match[3]}`;
  return year + (monthDay >= '04-02' ? 16 : 15);
}

function getHighSchoolGradeFromBirthday(birthday: string, date: string): number | null {
  const schoolYear = getSchoolYear(date);
  const highSchoolStartYear = getHighSchoolStartYear(birthday);
  if (schoolYear === null || highSchoolStartYear === null) return null;
  return schoolYear - highSchoolStartYear + 1;
}

function identityHaystack(target: Pick<TargetStatus, 'id' | 'name' | 'alias'>): string {
  return [target.id, target.name, target.alias].map(value => text(value).toLowerCase()).join('\n');
}

export function getTargetCharacterKey(target: Pick<TargetStatus, 'id' | 'name' | 'alias'>): string {
  const haystack = identityHaystack(target);
  if (/megumi|katou|kato|加藤|惠|恵/.test(haystack)) return 'megumi';
  if (/eriri|sawamura|英梨梨|英梨々|泽村|澤村/.test(haystack)) return 'eriri';
  if (/utaha|kasumigaoka|霞之丘|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子/.test(haystack)) return 'utaha';
  if (/izumi|hashima|波岛|波島|出海/.test(haystack)) return 'izumi';
  if (/michiru|hyodo|hyoudou|冰堂|氷堂|美智留/.test(haystack)) return 'michiru';
  if (/sayuri|小百合/.test(haystack)) return 'sayuri';
  if (/sonoko|machida|町田|苑子/.test(haystack)) return 'sonoko';
  if (/akane|kosaka|kousaka|kurenai|红坂|紅坂|朱音|高坂|茜/.test(haystack)) return 'akane';
  if (/shoko|shouko|nishimiya|西宫|西宮|硝子/.test(haystack)) return 'shoko';
  return '';
}

function makeIdentity(input: Omit<ResolvedSchoolIdentity, 'label' | 'grade'> & { label?: string }): ResolvedSchoolIdentity {
  const label = input.label ?? [input.schoolName, input.className].filter(Boolean).join(' ');
  return {
    ...input,
    label,
    grade: getGradeNumber(input.className),
  };
}

function resolveUnknown(id: string, name: string): ResolvedSchoolIdentity {
  return makeIdentity({
    id,
    name,
    kind: 'unknown',
    schoolName: '',
    className: '',
    source: 'unknown',
    facts: [],
  });
}

function isToyogasakiSchool(schoolName: string): boolean {
  return /丰之崎|丰崎|Toyogasaki/i.test(schoolName);
}

function advanceClassFor2013(className: string): { className: string; graduated: boolean } {
  const value = normalizeClassName(className);
  const match = value.match(/^([123])年(.*)$/);
  if (!match) return { className: value, graduated: false };
  const year = Number(match[1]);
  if (year >= 3) return { className: '', graduated: true };
  return { className: `${year + 1}年${match[2] ?? ''}`, graduated: false };
}

function selectClassStep(profile: EducationProfile, date: string): { schoolName: string; className: string; rawText: string } | null {
  const sorted = [...profile.classSteps].sort((left, right) => left.date.localeCompare(right.date));
  let selected: { schoolName: string; className: string; rawText: string } | null = null;
  for (const step of sorted) {
    if (step.date > date) continue;
    selected = {
      schoolName: step.schoolName || profile.schoolName,
      className: normalizeClassName(step.className),
      rawText: step.rawText,
    };
  }
  return selected;
}

function selectClassForGrade(
  profile: EducationProfile,
  grade: number,
): { schoolName: string; className: string; rawText: string } | null {
  for (const step of profile.classSteps) {
    if (getGradeNumber(step.className) !== grade) continue;
    return {
      schoolName: step.schoolName || profile.schoolName,
      className: normalizeClassName(step.className),
      rawText: step.rawText,
    };
  }
  return null;
}

function selectMiddleSchoolClass(profile: EducationProfile): { schoolName: string; className: string; rawText: string } | null {
  const step = profile.classSteps.find(item => normalizeClassName(item.className).startsWith('初'));
  if (!step) return null;
  return {
    schoolName: step.schoolName || profile.schoolName || '中学',
    className: normalizeClassName(step.className),
    rawText: step.rawText,
  };
}

function mergeWithBuiltInProfile(profile: EducationProfile, key: string): EducationProfile {
  const rule = BUILT_IN_RULES[key];
  if (!rule) return profile;

  if (profile.classSteps.length) {
    return {
      ...profile,
      birthday: profile.birthday || rule.birthday,
      schoolName: profile.schoolName || rule.schoolName,
      universityName: profile.universityName || rule.universityName || '',
      universityDepartment: profile.universityDepartment || rule.universityDepartment || '',
      graduationDate: profile.graduationDate || rule.graduationDate || '',
    };
  }

  return {
    ...profile,
    schoolName: profile.schoolName || rule.schoolName,
    birthday: profile.birthday || rule.birthday,
    universityName: profile.universityName || rule.universityName || '',
    universityDepartment: profile.universityDepartment || rule.universityDepartment || '',
    graduationDate: profile.graduationDate || rule.graduationDate || '',
    classSteps: rule.steps.map(step => ({
      date: step.date,
      className: normalizeClassName(step.className),
      schoolName: step.schoolName || rule.schoolName,
      rawText: step.rawText || step.className,
    })),
    source: 'fallback',
  };
}

function resolveProfileIdentity(input: {
  id: string;
  name: string;
  date: string;
  profile: EducationProfile;
  source: SchoolIdentitySource;
  beforeSplitApplies: boolean;
}): ResolvedSchoolIdentity {
  const profile = input.profile;

  if (!input.date) return resolveUnknown(input.id, input.name);

  if (profile.graduationDate && input.date >= profile.graduationDate) {
    const label =
      profile.universityName || profile.universityDepartment
        ? `${profile.schoolName || '私立丰之崎学园'} graduate / ${[profile.universityName, profile.universityDepartment]
            .filter(Boolean)
            .join('')}`
        : `${profile.schoolName || '私立丰之崎学园'} graduate`;
    return makeIdentity({
      id: input.id,
      name: input.name,
      kind: 'graduate',
      schoolName: profile.schoolName || '私立丰之崎学园',
      className: '',
      source: input.source,
      label,
      facts: [`${input.date}: ${input.name} is ${label}.`],
    });
  }

  if (input.beforeSplitApplies && input.date < CLASS_SPLIT_DATE) {
    return makeIdentity({
      id: input.id,
      name: input.name,
      kind: 'not-yet-split',
      schoolName: '私立丰之崎学园',
      className: '',
      source: 'date-rule',
      label: '私立丰之崎学园分班前',
      facts: [`Before 2012-04-05, ${input.name} must not be treated as already assigned to a Toyogasaki class.`],
    });
  }

  const birthdayGrade = getHighSchoolGradeFromBirthday(profile.birthday, input.date);
  if (birthdayGrade !== null) {
    if (birthdayGrade > 3) {
      const label =
        profile.universityName || profile.universityDepartment
          ? `${profile.schoolName || '私立丰之崎学园'} graduate / ${[profile.universityName, profile.universityDepartment]
              .filter(Boolean)
              .join('')}`
          : `${profile.schoolName || '私立丰之崎学园'} graduate`;
      return makeIdentity({
        id: input.id,
        name: input.name,
        kind: 'graduate',
        schoolName: profile.schoolName || '私立丰之崎学园',
        className: '',
        source: input.source,
        label,
        facts: [`${input.date}: ${input.name} is ${label}.`],
      });
    }

    if (birthdayGrade >= 1) {
      const classStep = selectClassForGrade(profile, birthdayGrade);
      const className = classStep?.className || `${birthdayGrade}年`;
      const schoolName = classStep?.schoolName || profile.schoolName || '私立丰之崎学园';
      return makeIdentity({
        id: input.id,
        name: input.name,
        kind: 'student',
        schoolName,
        className,
        source: input.source,
        facts: [`${input.date}: ${input.name} should be treated as ${[schoolName, className].filter(Boolean).join(' ')} by birthday-based school-year calculation.`],
      });
    }

    const middleSchool = selectMiddleSchoolClass(profile);
    if (middleSchool) {
      return makeIdentity({
        id: input.id,
        name: input.name,
        kind: 'student',
        schoolName: middleSchool.schoolName,
        className: middleSchool.className,
        source: input.source,
        facts: [`${input.date}: ${input.name} should be treated as ${[middleSchool.schoolName, middleSchool.className].filter(Boolean).join(' ')} by birthday-based school-year calculation.`],
      });
    }
  }

  const step = selectClassStep(profile, input.date);
  if (!step?.className) return resolveUnknown(input.id, input.name);

  return makeIdentity({
    id: input.id,
    name: input.name,
    kind: 'student',
    schoolName: step.schoolName || profile.schoolName,
    className: step.className,
    source: input.source,
    facts: [`${input.date}: ${input.name} should be treated as ${[step.schoolName || profile.schoolName, step.className].filter(Boolean).join(' ')}.`],
  });
}

export function resolvePlayerSchoolIdentity(
  profile: PlayerProfile | null | undefined,
  currentTime: string,
): ResolvedSchoolIdentity {
  const date = getDatePart(currentTime);
  const name = text(profile?.name) || 'User';
  const rawClassName = normalizeClassName(text(profile?.className));
  const educationProfile = getPlayerEducationProfile(profile);

  if (!rawClassName) return resolveUnknown('user', name);

  if (!date || date < CLASS_SPLIT_DATE) {
    return makeIdentity({
      id: 'user',
      name,
      kind: 'not-yet-split',
      schoolName: '私立丰之崎学园',
      className: '',
      source: 'date-rule',
      label: '私立丰之崎学园分班前',
      facts: ['Before 2012-04-05, User must not be treated as already assigned to a Toyogasaki class.'],
    });
  }

  const baseClass = educationProfile.classSteps[0]?.className || rawClassName;
  const rollover = date >= TOYOGASAKI_2013_SCHOOL_YEAR_DATE ? advanceClassFor2013(baseClass) : { className: baseClass, graduated: false };

  return makeIdentity({
    id: 'user',
    name,
    kind: rollover.graduated ? 'graduate' : 'student',
    schoolName: '私立丰之崎学园',
    className: rollover.className,
    source: 'profile',
    label: rollover.graduated ? '私立丰之崎学园 graduate' : undefined,
    facts: rollover.graduated
      ? [`${date}: User should be treated as a Toyogasaki graduate.`]
      : [`${date}: User should be treated as 私立丰之崎学园 ${rollover.className}.`],
  });
}

export function resolveTargetSchoolIdentity(target: TargetIdentityInput, currentTime: string): ResolvedSchoolIdentity {
  const date = getDatePart(currentTime);
  const id = text(target.id) || text(target.name) || 'unknown-target';
  const name = text(target.name) || id;
  const key = getTargetCharacterKey(target);
  const rawProfile = getTargetEducationProfile(target);
  const profile = mergeWithBuiltInProfile(rawProfile, key);
  const source: SchoolIdentitySource = rawProfile.source === 'worldbook' ? 'worldbook' : profile.source === 'fallback' ? 'fallback' : 'unknown';
  const schoolName = profile.schoolName || BUILT_IN_RULES[key]?.schoolName || '';
  const beforeSplitApplies = isToyogasakiSchool(schoolName) && key !== 'izumi';

  return resolveProfileIdentity({
    id,
    name,
    date,
    profile,
    source,
    beforeSplitApplies,
  });
}
