import type { PlayerProfile, TargetStatus } from '../types';
import { CLASS_SPLIT_DATE, TOYOGASAKI_2013_SCHOOL_YEAR_DATE, UTAHA_GRADUATION_DATE } from './constants';
import { buildSchoolRelationGuardLine } from './relationship-guards';
import { resolvePlayerSchoolIdentity, resolveTargetSchoolIdentity, type ResolvedSchoolIdentity } from './identity-resolver';

export type SchoolCalendarFactInput = {
  currentTime: string;
  playerProfile?: PlayerProfile | null;
  targets?: TargetStatus[];
};

function getDatePart(value: string | undefined): string {
  return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

export function formatSchoolIdentity(identity: ResolvedSchoolIdentity): string {
  return identity.className || identity.label;
}

export function buildSchoolCalendarFactLines(input: SchoolCalendarFactInput): string[] {
  const date = getDatePart(input.currentTime);
  const lines: string[] = [];

  if (!date || date < CLASS_SPLIT_DATE) {
    lines.push(
      '- School calendar: Toyogasaki class assignments start on 2012-04-05; before that date, do not expose any concrete selected class. Concealed grade data may only decide whether User and a character are peers, senior, or junior.',
    );
  }

  if (date >= UTAHA_GRADUATION_DATE) {
    lines.push('- School calendar: 2013-03-04 is Utaha graduation ceremony day; after this date, do not write Utaha as a normal third-year student attending daily classes.');
  }

  if (date >= TOYOGASAKI_2013_SCHOOL_YEAR_DATE) {
    lines.push('- School calendar: after the 2013-04 new school year, Toyogasaki students must use their resolved current grade, not stale second-year class text.');
  }

  const playerIdentity = resolvePlayerSchoolIdentity(input.playerProfile, input.currentTime);
  if (playerIdentity.label) {
    lines.push(`- School identity: User = ${playerIdentity.label}.`);
  }

  for (const target of input.targets ?? []) {
    const identity = resolveTargetSchoolIdentity(target, input.currentTime);
    if (identity.label) {
      lines.push(`- School identity: ${identity.name} = ${identity.label}.`);
    }
    const relation = buildSchoolRelationGuardLine({ target, playerProfile: input.playerProfile, currentTime: input.currentTime });
    if (relation) {
      lines.push(`- School relation guard: ${relation}`);
    }
  }

  return Array.from(new Set(lines));
}

export function buildKirihimeSchoolIdentitySegment(input: {
  target: TargetStatus;
  playerProfile?: PlayerProfile | null;
  currentTime: string;
  relationToTomoya?: string;
}): string {
  const identity = resolveTargetSchoolIdentity(input.target, input.currentTime);
  const identityLabel = formatSchoolIdentity(identity);
  const relationGuard = buildSchoolRelationGuardLine({
    target: input.target,
    playerProfile: input.playerProfile,
    currentTime: input.currentTime,
  });
  return [
    identityLabel ? `当前身份=${identityLabel}` : '',
    relationGuard ? `与user学年关系=${relationGuard}` : '',
    input.relationToTomoya ? `原作关系(仅对安艺伦也)=${input.relationToTomoya}` : '',
  ]
    .filter(Boolean)
    .map(item => `；${item}`)
    .join('');
}

