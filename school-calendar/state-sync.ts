import type { PlayerProfile, StatusData, TargetStatus } from '../types';
import { resolvePlayerSchoolIdentity, resolveTargetSchoolIdentity } from './identity-resolver';

const SYNCED_AT_KEY = 'schoolCalendarSyncedAt';
const IDENTITY_KIND_KEY = 'schoolIdentityKind';
const IDENTITY_LABEL_KEY = 'schoolIdentityLabel';

function getDatePart(value: string | undefined): string {
  return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function setMetaValue(meta: Record<string, unknown>, key: string, value: string): boolean {
  if (text(meta[key]) === value) return false;
  meta[key] = value;
  return true;
}

function syncPlayerIdentityLabel(profile: PlayerProfile | null | undefined, currentTime: string): boolean {
  if (!profile) return false;
  const date = getDatePart(currentTime);
  if (!date) return false;
  let changed = false;

  if (!text(profile.schoolCalendarBaseClassName) && text(profile.className)) {
    profile.schoolCalendarBaseClassName = text(profile.className);
    changed = true;
  }

  const identity = resolvePlayerSchoolIdentity(profile, currentTime);

  if (profile.schoolIdentityKind !== identity.kind) {
    profile.schoolIdentityKind = identity.kind;
    changed = true;
  }
  if (profile.schoolIdentityLabel !== identity.label) {
    profile.schoolIdentityLabel = identity.label;
    changed = true;
  }
  if (profile.schoolCalendarSyncedAt !== date) {
    profile.schoolCalendarSyncedAt = date;
    changed = true;
  }

  return changed;
}

function syncTargetIdentityLabel(target: TargetStatus, currentTime: string): boolean {
  const date = getDatePart(currentTime);
  if (!date) return false;
  const meta = (target.meta ??= {});
  const identity = resolveTargetSchoolIdentity(target, currentTime);
  let changed = false;

  changed = setMetaValue(meta, IDENTITY_KIND_KEY, identity.kind) || changed;
  changed = setMetaValue(meta, IDENTITY_LABEL_KEY, identity.label) || changed;
  changed = setMetaValue(meta, SYNCED_AT_KEY, date) || changed;

  return changed;
}

export function syncSchoolCalendarState(input: {
  currentTime: string;
  playerProfile?: PlayerProfile | null;
  statusData?: StatusData | null;
}): boolean {
  let changed = false;
  changed = syncPlayerIdentityLabel(input.playerProfile, input.currentTime) || changed;

  for (const target of input.statusData?.targets ?? []) {
    changed = syncTargetIdentityLabel(target, input.currentTime) || changed;
  }

  return changed;
}

