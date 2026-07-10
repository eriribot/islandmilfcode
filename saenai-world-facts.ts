import type { PlayerProfile, TargetStatus } from './types';
import { buildSchoolCalendarFactLines } from './school-calendar';

export type SaenaiWorldFactInput = {
  currentTime: string;
  playerProfile?: PlayerProfile | null;
  targets?: TargetStatus[];
};

function getDatePart(value: string): string {
  return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

export function buildSaenaiWorldStateFactLines(input: SaenaiWorldFactInput): string[] {
  const date = getDatePart(input.currentTime);
  const lines = [
    '- Canon fact: Koisuru Metronome ended in 2011; current scenes may reference sales, reader aftermath, and creative wounds, but must not treat it as still serialized.',
    ...buildSchoolCalendarFactLines({
      currentTime: input.currentTime,
      playerProfile: input.playerProfile,
      targets: input.targets,
    }),
  ];

  if (!date || date < '2013-02-01') {
    lines.push(
      '- Canon timing: Akane Kosaka starts pressuring the black-gold duo in February 2013; before then, keep her as industry/future-pressure background rather than an already active poacher.',
    );
  }

  return Array.from(new Set(lines));
}

