import type { PlayerProfile, TargetStatus } from '../types';
import { resolvePlayerSchoolIdentity, resolveTargetSchoolIdentity, type ResolvedSchoolIdentity } from './identity-resolver';

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function isSameSchool(left: ResolvedSchoolIdentity, right: ResolvedSchoolIdentity): boolean {
  return Boolean(left.schoolName && right.schoolName && left.schoolName === right.schoolName);
}

export function buildSchoolRelationGuardLine(input: {
  target: TargetStatus;
  playerProfile?: PlayerProfile | null;
  currentTime: string;
}): string {
  const date = text(input.currentTime).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  if (!date) return '';

  const player = resolvePlayerSchoolIdentity(input.playerProfile, input.currentTime);
  const target = resolveTargetSchoolIdentity(input.target, input.currentTime);

  if (player.kind === 'not-yet-split' || target.kind === 'not-yet-split') {
    return `学年身份：当前为分班前状态；不得把 user 或 ${input.target.name} 写成已经确定同班、B班、G班或固定座位关系。`;
  }

  if (target.kind === 'graduate') {
    return `学年身份：${input.target.name} 当前身份=${target.label}；不得写成正常上课的在校三年级学生，也不得仅因原作称呼默认是 user 的学姐。`;
  }

  if (player.kind === 'graduate') {
    return `学年身份：user 当前身份=${player.label}；${input.target.name} 当前身份=${target.label || target.className || '未知'}，不得按旧在校班级强行套同班/学姐关系。`;
  }

  if (!player.className || !target.className || player.grade === null || target.grade === null) {
    return target.label ? `学年身份：${input.target.name} 当前身份=${target.label}。` : '';
  }

  if (!isSameSchool(player, target)) {
    return `学年身份：角色=${target.label}，user=${player.label}；两者不同学校，不存在同班/同年级关系。`;
  }

  if (player.className === target.className) {
    return `学年身份：角色=${target.className}，user=${player.className}；与 user 同班。`;
  }

  if (player.grade === target.grade) {
    return `学年身份：角色=${target.className}，user=${player.className}；与 user 同年级、不同班，是同级生而非学姐/学妹，禁止 user 称其为“学姐”或“前辈”。`;
  }

  if (target.grade > player.grade) {
    return `学年身份：角色=${target.className}，user=${player.className}；比 user 高 ${target.grade - player.grade} 届，是 user 的学姐/前辈。`;
  }

  return `学年身份：角色=${target.className}，user=${player.className}；比 user 低 ${player.grade - target.grade} 届，是 user 的学妹/后辈，不要让 user 称其为“学姐/前辈”。`;
}

