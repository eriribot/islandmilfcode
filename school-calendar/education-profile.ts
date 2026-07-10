import type { PlayerProfile, TargetStatus } from '../types';

export type EducationClassStep = {
  date: string;
  schoolName: string;
  className: string;
  rawText: string;
};

export type EducationProfile = {
  birthday: string;
  ageText: string;
  identityText: string;
  educationText: string;
  schoolName: string;
  universityName: string;
  universityDepartment: string;
  graduationDate: string;
  classSteps: EducationClassStep[];
  source: 'worldbook' | 'fallback' | 'player' | 'unknown';
};

const EMPTY_PROFILE: EducationProfile = {
  birthday: '',
  ageText: '',
  identityText: '',
  educationText: '',
  schoolName: '',
  universityName: '',
  universityDepartment: '',
  graduationDate: '',
  classSteps: [],
  source: 'unknown',
};

const CHINESE_NUMBER_MAP: Record<string, string> = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  十: '10',
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeNumber(raw: string): string {
  const value = text(raw);
  if (/^\d+$/.test(value)) return value;
  if (CHINESE_NUMBER_MAP[value]) return CHINESE_NUMBER_MAP[value];
  if (value.startsWith('十') && value.length === 2) return `1${CHINESE_NUMBER_MAP[value[1] ?? ''] ?? ''}`;
  return value;
}

export function normalizeClassName(raw: string): string {
  const value = text(raw);
  if (!value) return '';

  const direct = value.match(/([一二三四五六七八九十\d]+)\s*年(?:级)?\s*([A-Za-z\d一二三四五六七八九十]+)\s*[班组]/);
  if (direct) {
    return `${normalizeNumber(direct[1] ?? '')}年${text(direct[2]).toUpperCase()}班`;
  }

  const highSchool = value.match(/高\s*([一二三四五六七八九十\d])/);
  if (highSchool) {
    return `${normalizeNumber(highSchool[1] ?? '')}年`;
  }

  const middleSchool = value.match(/初\s*([一二三四五六七八九十\d])/);
  if (middleSchool) {
    return `初${normalizeNumber(middleSchool[1] ?? '')}`;
  }

  return value;
}

export function getGradeNumber(className: string): number | null {
  const normalized = normalizeClassName(className);
  const match = normalized.match(/^([1-9]\d*)年/);
  if (!match) return null;
  const grade = Number(match[1]);
  return Number.isFinite(grade) ? grade : null;
}

function normalizeDate(rawYear: string, rawMonth: string, rawDay: string): string {
  const year = rawYear.padStart(4, '0');
  const month = rawMonth.padStart(2, '0');
  const day = rawDay.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLineField(source: string, label: string): string {
  return source.match(new RegExp(`${label}[:：]\\s*([^\\n]+)`))?.[1]?.trim() ?? '';
}

function extractBirthday(source: string): string {
  const match = source.match(/生日[:：]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  return match ? normalizeDate(match[1] ?? '', match[2] ?? '', match[3] ?? '') : '';
}

function splitRelevantSentences(source: string): string[] {
  return source
    .split(/[\n。；;]/)
    .map(line => line.trim())
    .filter(line => /生日|年龄|年级|班|组|升入|分入|高三|初三|丰之崎|丰崎|早应大学|县立椿姬|毕业/.test(line));
}

function detectSchoolName(sentence: string): string {
  if (/县立椿姬|椿姬女子/.test(sentence)) return '县立椿姬女子高校';
  if (/丰之崎|丰崎/.test(sentence)) return '私立丰之崎学园';
  return '';
}

function extractClassSteps(source: string): EducationClassStep[] {
  const steps: EducationClassStep[] = [];
  const seen = new Set<string>();

  for (const sentence of splitRelevantSentences(source)) {
    const matches = sentence.matchAll(/([一二三四五六七八九十\d]+)\s*年(?:级)?\s*([A-Za-z\d一二三四五六七八九十]+)\s*[班组]/g);
    for (const match of matches) {
      const className = normalizeClassName(match[0] ?? '');
      if (!className) continue;
      const date = '';
      const schoolName = detectSchoolName(sentence);
      const key = `${date}|${schoolName}|${className}`;
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push({ date, schoolName, className, rawText: sentence });
    }

    if (/升入高三|高三/.test(sentence) && !/[班组]/.test(sentence)) {
      const key = '||3年';
      if (!seen.has(key)) {
        seen.add(key);
        steps.push({ date: '', schoolName: detectSchoolName(sentence), className: '3年', rawText: sentence });
      }
    }

    if (/2012.*初三|初三/.test(sentence) && !/[班组]/.test(sentence)) {
      const key = '||初3';
      if (!seen.has(key)) {
        seen.add(key);
        steps.push({ date: '', schoolName: detectSchoolName(sentence), className: '初3', rawText: sentence });
      }
    }
  }

  return steps.sort((left, right) => left.date.localeCompare(right.date));
}

function extractUniversity(source: string): { universityName: string; universityDepartment: string } {
  const match = source.match(/([一-鿿]{2,8}大学)([一-鿿]{1,12}(?:系|学部|学科))/);
  const universityName = (match?.[1] ?? '').replace(/^(?:后|毕业后)?(?:升入|进入|就读|保送)/, '');
  return {
    universityName,
    universityDepartment: match?.[2] ?? '',
  };
}

function inferGraduationDate(name: string, source: string, classSteps: EducationClassStep[]): string {
  const haystack = [name, source].join('\n').toLowerCase();
  if (/utaha|霞之丘|霞ヶ丘|诗羽|詩羽/.test(haystack)) return '2013-03-04';
  if (/毕业/.test(source) && classSteps.some(step => getGradeNumber(step.className) === 3)) return '2014-03-01';
  return '';
}

export function buildEducationProfileFromText(input: {
  name?: string;
  content?: string;
  ageText?: string;
  identityText?: string;
  classText?: string;
}): EducationProfile {
  const source = [input.content, input.ageText, input.identityText, input.classText].map(text).filter(Boolean).join('\n');
  const classSteps = extractClassSteps(source);
  const university = extractUniversity(source);
  const schoolName = classSteps.find(step => step.schoolName)?.schoolName || detectSchoolName(source);
  const profile: EducationProfile = {
    birthday: extractBirthday(source),
    ageText: text(input.ageText) || getLineField(source, '年龄'),
    identityText: text(input.identityText) || getLineField(source, '身份'),
    educationText: splitRelevantSentences(source).join(' / '),
    schoolName,
    universityName: university.universityName,
    universityDepartment: university.universityDepartment,
    graduationDate: inferGraduationDate(text(input.name), source, classSteps),
    classSteps,
    source: 'worldbook',
  };

  if (
    !profile.birthday &&
    !profile.ageText &&
    !profile.identityText &&
    !profile.educationText &&
    !profile.schoolName &&
    !profile.universityName &&
    !profile.classSteps.length
  ) {
    return { ...EMPTY_PROFILE };
  }

  return profile;
}

function getMetaEducationProfile(meta: Record<string, unknown> | undefined): EducationProfile | null {
  const value = meta?.schoolProfile;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<EducationProfile>;
  return {
    ...EMPTY_PROFILE,
    ...raw,
    classSteps: Array.isArray(raw.classSteps) ? raw.classSteps : [],
    source: raw.source ?? 'worldbook',
  };
}

export function getTargetEducationProfile(target: Pick<TargetStatus, 'id' | 'name' | 'alias' | 'meta'>): EducationProfile {
  const fromMeta = getMetaEducationProfile(target.meta);
  if (fromMeta) return fromMeta;

  const meta = target.meta ?? {};
  const fallback = buildEducationProfileFromText({
    name: target.name,
    content: [meta.schoolProfileText, meta.educationText, meta.ageText, meta.identityText, meta.className].map(text).join('\n'),
  });
  if (fallback.source !== 'unknown') return fallback;

  return { ...EMPTY_PROFILE };
}

export function getPlayerEducationProfile(profile: PlayerProfile | null | undefined): EducationProfile {
  const className = normalizeClassName(text(profile?.className));
  if (!className) return { ...EMPTY_PROFILE };
  return {
    ...EMPTY_PROFILE,
    schoolName: '私立丰之崎学园',
    classSteps: [{ date: '2012-04-05', schoolName: '私立丰之崎学园', className, rawText: className }],
    source: 'player',
  };
}

export function getFirstClassMention(profile: EducationProfile): string {
  return profile.classSteps[0]?.className ?? '';
}
