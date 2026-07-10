import type { PlayerProfile, TargetStatus } from '../types';
import {
  isAdultElderTarget,
  resolvePlayerSchoolIdentity,
  resolveTargetSchoolIdentity,
  type ResolvedSchoolIdentity,
} from './identity-resolver';

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function isSameSchool(left: ResolvedSchoolIdentity, right: ResolvedSchoolIdentity): boolean {
  return Boolean(left.schoolName && right.schoolName && left.schoolName === right.schoolName);
}

function getPlayerSeniorTitle(profile: PlayerProfile | null | undefined): string {
  const gender = text(profile?.gender);
  if (/女/.test(gender)) return '学姐/前辈';
  if (/男/.test(gender)) return '学长/前辈';
  return '前辈';
}

function getPlayerJuniorTitle(profile: PlayerProfile | null | undefined): string {
  const gender = text(profile?.gender);
  if (/女/.test(gender)) return '学妹/后辈';
  if (/男/.test(gender)) return '学弟/后辈';
  return '后辈';
}

function describeGradeRelation(
  targetGrade: number,
  playerGrade: number,
  playerProfile: PlayerProfile | null | undefined,
): string {
  if (targetGrade === playerGrade) {
    return '角色与 user 同辈，是同级生而非学姐/学妹；禁止 user 称其为“学姐/前辈”或“学妹/后辈”。';
  }

  if (targetGrade > playerGrade) {
    return `角色比 user 高 ${targetGrade - playerGrade} 届，是 user 的学姐/前辈；user 是角色的${getPlayerJuniorTitle(playerProfile)}，不得写成同辈或学妹/后辈。`;
  }

  return `角色比 user 低 ${playerGrade - targetGrade} 届，是 user 的学妹/后辈；user 是角色的${getPlayerSeniorTitle(playerProfile)}，不得写成同辈或学姐/前辈；禁止 user 称其为“学姐/前辈”。`;
}

function describeDifferentSchoolRelation(
  targetGrade: number | null,
  playerGrade: number | null,
  playerProfile: PlayerProfile | null | undefined,
): string {
  if (targetGrade === null || playerGrade === null) {
    return '两者不同学校，不套用同校的学姐、学长或学妹关系。';
  }

  if (targetGrade === playerGrade) {
    return `两者不同学校，不是同班，但处于同年级、同一学届；${describeGradeRelation(targetGrade, playerGrade, playerProfile)}`;
  }

  const direction = targetGrade > playerGrade ? '高' : '低';
  return `两者不同学校，不套用同校的学姐、学长或学妹关系；角色学年比 user ${direction} ${Math.abs(targetGrade - playerGrade)} 届，这只表示学届差。`;
}

export function buildSchoolRelationGuardLine(input: {
  target: TargetStatus;
  playerProfile?: PlayerProfile | null;
  currentTime: string;
}): string {
  const date = text(input.currentTime).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  if (!date) return '';

  if (isAdultElderTarget(input.target)) {
    return `学年身份：${input.target.name}按成年人长辈处理；不为其虚构丰之崎在校或毕业经历，也不套用学校里的学姐或学妹关系。`;
  }

  const player = resolvePlayerSchoolIdentity(input.playerProfile, input.currentTime);
  const target = resolveTargetSchoolIdentity(input.target, input.currentTime);

  const playerGrade = player.relationGrade;
  const targetGrade = target.relationGrade;
  const playerBaseGrade = player.baseGrade;
  const targetBaseGrade = target.baseGrade;

  if (player.kind === 'graduate' || target.kind === 'graduate') {
    if (!isSameSchool(player, target)) {
      const targetComparisonGrade = target.kind === 'graduate' ? targetBaseGrade : targetGrade;
      const playerComparisonGrade = player.kind === 'graduate' ? playerBaseGrade : playerGrade;
      return `学年身份：角色=${target.label || target.className || '未知'}，user=${player.label || player.className || '未知'}；${describeDifferentSchoolRelation(targetComparisonGrade, playerComparisonGrade, input.playerProfile)}`;
    }

    if (player.kind === 'graduate' && target.kind === 'graduate') {
      if (playerBaseGrade === null || targetBaseGrade === null) {
        return '学年身份：双方均已毕业，但 baseClass 资料不足；不得凭空判定同辈、前辈或后辈。';
      }
      return `学年身份：双方均已毕业，具体旧班级不再用于当前身份显示；按 baseClass 所属学届判断；${describeGradeRelation(targetBaseGrade, playerBaseGrade, input.playerProfile)}`;
    }

    if (target.kind === 'graduate') {
      return `学年身份：角色已经毕业、user 仍在校；${input.target.name} 当前身份=${target.label}，是 user 的学姐/前辈；user 是角色的${getPlayerJuniorTitle(input.playerProfile)}。不得把角色写成仍在正常上课的三年级学生。`;
    }

    return `学年身份：user 已经毕业、角色仍在校；user 是角色的${getPlayerSeniorTitle(input.playerProfile)}；${input.target.name} 是 user 的学妹/后辈；user 当前身份=${player.label}。不得用旧班级写成当前同班。`;
  }

  if (player.kind === 'not-yet-split' || target.kind === 'not-yet-split') {
    const hiddenClassGuard = `当前为分班前状态；不得公开 user 或 ${input.target.name} 的具体班级，也不得写成已经确定同班或固定座位关系`;
    if (playerGrade === null || targetGrade === null) {
      return `学年身份：${hiddenClassGuard}；辈分资料不足时不得沿用原作中其他人物的学姐/学妹称呼。`;
    }
    if (!isSameSchool(player, target)) {
      return `学年身份：${hiddenClassGuard}；${describeDifferentSchoolRelation(targetGrade, playerGrade, input.playerProfile)}`;
    }
    return `学年身份：${hiddenClassGuard}；具体年级只用于辈分判断；${describeGradeRelation(targetGrade, playerGrade, input.playerProfile)}`;
  }

  if (!player.className || !target.className || playerGrade === null || targetGrade === null) {
    return target.label ? `学年身份：${input.target.name} 当前身份=${target.label}。` : '';
  }

  if (!isSameSchool(player, target)) {
    return `学年身份：角色=${target.label}，user=${player.label}；${describeDifferentSchoolRelation(targetGrade, playerGrade, input.playerProfile)}`;
  }

  if (player.className === target.className) {
    return `学年身份：角色=${target.className}，user=${player.className}；与 user 同班；${describeGradeRelation(targetGrade, playerGrade, input.playerProfile)}`;
  }

  if (playerGrade === targetGrade) {
    return `学年身份：角色=${target.className}，user=${player.className}；与 user 同年级、不同班；${describeGradeRelation(targetGrade, playerGrade, input.playerProfile)}`;
  }

  return `学年身份：角色=${target.className}，user=${player.className}；${describeGradeRelation(targetGrade, playerGrade, input.playerProfile)}`;
}

