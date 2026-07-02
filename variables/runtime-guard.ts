import type { StatusData, TargetStatus } from '../types';
import { affinityStage } from './format';

function normalizeTargetIdentity(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[·・\s　._-]/g, '');
}

function getBuiltInTargetKey(target: Pick<TargetStatus, 'id' | 'name' | 'alias' | 'meta'>) {
  const identityHaystack = [target.id, target.name, target.meta?.worldbookEntryName]
    .map(normalizeTargetIdentity)
    .join('\n');
  const haystack = [identityHaystack, target.alias].map(normalizeTargetIdentity).join('\n');
  if (/泽村小百合|澤村小百合|小百合|sayuri/.test(identityHaystack)) return 'sayuri';
  if (/町田苑子|町田|苑子|まちだそのこ|sonoko|machida/.test(haystack)) return 'sonoko';
  if (/加藤|惠|恵|megumi|katou|kato/.test(haystack)) return 'megumi';
  if (/英梨梨|英梨々|泽村|澤村|eriri|sawamura/.test(haystack)) return 'eriri';
  if (/霞之丘|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(haystack)) return 'utaha';
  if (/波岛|波島|出海|izumi|hashima/.test(haystack)) return 'izumi';
  if (/冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(haystack)) return 'michiru';
  if (/西宫硝子|西宮硝子|西宫|西宮|硝子|shoko|shouko|nishimiya/.test(haystack)) return 'shoko';
  if (/高坂茜|红坂朱音|紅坂朱音|高坂|红坂|紅坂|朱音|茜|akane|kosaka|kousaka|kurenai/.test(identityHaystack)) {
    return 'akane';
  }
  return '';
}

function getTargetRecoveryKeys(target: TargetStatus) {
  return [
    `built:${getBuiltInTargetKey(target)}`,
    `id:${normalizeTargetIdentity(target.id)}`,
    `name:${normalizeTargetIdentity(target.name)}`,
    `wb:${normalizeTargetIdentity(target.meta?.worldbookEntryName)}`,
  ].filter(key => !key.endsWith(':'));
}

function buildPreviousTargetMap(previousStatusData: StatusData | null | undefined) {
  const map = new Map<string, TargetStatus>();
  for (const target of previousStatusData?.targets ?? []) {
    for (const key of getTargetRecoveryKeys(target)) {
      if (!map.has(key)) map.set(key, target);
    }
  }
  return map;
}

function shouldRecoverAffinity(previous: number, next: number) {
  return previous >= 10 && next === 0;
}

export function protectTargetAffinityReset(
  nextStatusData: StatusData,
  previousStatusData: StatusData | null | undefined,
  source: string,
): StatusData {
  const previousTargets = buildPreviousTargetMap(previousStatusData);
  if (!previousTargets.size || !nextStatusData.targets.length) return nextStatusData;

  let recovered = false;
  const targets = nextStatusData.targets.map(target => {
    const previous = getTargetRecoveryKeys(target)
      .map(key => previousTargets.get(key))
      .find(Boolean);
    if (!previous) return target;

    const previousAffinity = Number(previous.affinity ?? 0);
    const nextAffinity = Number(target.affinity ?? 0);
    if (!shouldRecoverAffinity(previousAffinity, nextAffinity)) return target;

    recovered = true;
    return {
      ...target,
      affinity: previous.affinity,
      stage: previous.stage || affinityStage(previous.affinity),
    };
  });

  if (!recovered) return nextStatusData;
  // 中文注释：部分楼层快照/变量会把角色 affinity 写成空值并归一成 0；已有非零好感不能被坏楼层覆盖。
  console.warn(`[status-guard] recovered target affinity reset from ${source}`);
  return {
    ...nextStatusData,
    targets,
  };
}
