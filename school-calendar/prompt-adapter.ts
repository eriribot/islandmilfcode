import type { PlayerProfile, TargetStatus } from '../types';
import { isFinishedMainEventStatus } from '../plot-routing';
import { CLASS_SPLIT_DATE, TOYOGASAKI_2013_SCHOOL_YEAR_DATE, UTAHA_GRADUATION_DATE } from './constants';
import { buildSchoolRelationGuardLine } from './relationship-guards';
import { resolvePlayerSchoolIdentity, resolveTargetSchoolIdentity, type ResolvedSchoolIdentity } from './identity-resolver';

export const SAE_07_8_EVENT_ID = 'SAE_07-8';
const SAE_07_8_DATE = '2013-03-04';

export type SchoolCalendarFactInput = {
  currentTime: string;
  playerProfile?: PlayerProfile | null;
  targets?: TargetStatus[];
  currentMainEventId?: string;
  mainEvents?: Record<string, string>;
  eventTriggerCounts?: Record<string, number>;
};

function getDatePart(value: string | undefined): string {
  return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

export function shouldInjectSae078GraduationCeremony(input: SchoolCalendarFactInput): boolean {
  const date = getDatePart(input.currentTime);
  return (
    date === SAE_07_8_DATE &&
    input.currentMainEventId === SAE_07_8_EVENT_ID &&
    !isFinishedMainEventStatus(input.mainEvents?.[SAE_07_8_EVENT_ID]) &&
    (input.eventTriggerCounts?.[SAE_07_8_EVENT_ID] ?? 0) === 0
  );
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
    lines.push(
      '- School calendar: Utaha\'s ongoing identity is a graduate from 2013-03-04 onward; do not write her as a normal third-year student attending daily classes. This continuing identity does not mean the graduation ceremony repeats.',
    );
  }

  const graduationCeremonyActive = shouldInjectSae078GraduationCeremony(input);
  if (graduationCeremonyActive) {
    lines.push(
      '- School calendar: today (2013-03-04) is the active SAE_07-8 graduation ceremony. Treat it as a one-time story event that ends with the main-event state, not as an annually or per-turn repeating calendar event.',
    );

    for (const target of input.targets ?? []) {
      const identity = resolveTargetSchoolIdentity(target, input.currentTime);
      if (identity.kind === 'graduate') continue;
      const currentIdentity = formatSchoolIdentity(identity);
      lines.push(
        `- School calendar: today is the graduation ceremony, but ${identity.name} is NOT graduating${
          currentIdentity ? ` (current school identity: ${currentIdentity})` : ' and has no graduating-student identity'
        }. Do not write ${identity.name} as a graduate or as officially finishing school today.`,
      );
    }
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

