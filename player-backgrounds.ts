import { commitBatch, upsertAttribute } from './memorydatabase/upsert';
import type { IslandMemoryDB } from './memorydatabase/types';
import {
  PHONE_ARCHIVE_IMPRESSION_GOLD_TAG,
  PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG,
} from './phone/types';
import type { StatusData, TargetStatus } from './types';
import { affinityStage, clamp, obsessionStage } from './variables/normalize';

type PlayerBackgroundEffect = {
  targetId: string;
  affinityDelta?: number;
  obsessionDelta?: number;
  impression: string;
  reason: string;
};

export type PlayerBackgroundOption = {
  id: string;
  label: string;
  cost: number;
  description: string;
  effects: PlayerBackgroundEffect[];
};

export const PLAYER_BACKGROUND_OPTIONS: PlayerBackgroundOption[] = [
  {
    id: 'creator-circle',
    label: '同人制作圈',
    cost: 40,
    description: '做过社团企划、摊位和修罗场，创作者会先把你当圈内人。',
    effects: [
      { targetId: '泽村-斯宾塞-英梨梨', affinityDelta: 25, obsessionDelta: -25, impression: '同人现场里能说人话的同行', reason: '开局背景：同人制作圈' },
      { targetId: '霞之丘诗羽', affinityDelta: 25, obsessionDelta: -20, impression: '懂创作规矩的读者', reason: '开局背景：同人制作圈' },
      { targetId: '波岛出海', affinityDelta: 20, obsessionDelta: -15, impression: '熟悉同人活动的前辈', reason: '开局背景：同人制作圈' },
      { targetId: '冰堂美智留', affinityDelta: 15, obsessionDelta: -15, impression: '会认真陪朋友做企划的人', reason: '开局背景：同人制作圈' },
    ],
  },
  {
    id: 'toyogasaki-network',
    label: '丰之崎人脉',
    cost: 40,
    description: '在丰之崎有口碑和熟人，校园线开局少一层陌生感。',
    effects: [
      { targetId: '加藤惠', affinityDelta: 25, impression: '校内风评不错的熟人', reason: '开局背景：丰之崎人脉' },
      { targetId: '泽村-斯宾塞-英梨梨', affinityDelta: 15, obsessionDelta: -15, impression: '校内名声还过得去的人', reason: '开局背景：丰之崎人脉' },
      { targetId: '霞之丘诗羽', affinityDelta: 15, obsessionDelta: -15, impression: '知道分寸的学弟', reason: '开局背景：丰之崎人脉' },
    ],
  },
  {
    id: 'editorial-parttime',
    label: '出版社打工',
    cost: 40,
    description: '在出版社打过杂，见过催稿、校样和作者爆炸现场。',
    effects: [
      { targetId: '町田苑子', affinityDelta: 30, impression: '能马上派活的打工战力', reason: '开局背景：出版社打工' },
      { targetId: '霞之丘诗羽', affinityDelta: 30, obsessionDelta: -25, impression: '见过截稿现场的协力者', reason: '开局背景：出版社打工' },
      { targetId: '高坂茜(红坂朱音)', affinityDelta: 20, impression: '懂一点业界规矩的新人', reason: '开局背景：出版社打工' },
    ],
  },
  {
    id: 'art-assistant',
    label: '美术协力',
    cost: 40,
    description: '会修图、扫图、整理素材，也知道画稿修罗场有多难熬。',
    effects: [
      { targetId: '泽村-斯宾塞-英梨梨', affinityDelta: 40, obsessionDelta: -35, impression: '画稿修罗场里的熟练助手', reason: '开局背景：美术协力' },
      { targetId: '泽村小百合', affinityDelta: 20, impression: '会照看英梨梨创作状态的孩子', reason: '开局背景：美术协力' },
    ],
  },
  {
    id: 'band-scene',
    label: '乐队熟人',
    cost: 40,
    description: '混过排练室和Live现场，美智留不会把你当纯外行。',
    effects: [
      { targetId: '冰堂美智留', affinityDelta: 40, obsessionDelta: -35, impression: '能跟上乐队节奏的熟人', reason: '开局背景：乐队熟人' },
    ],
  },
  {
    id: 'family-friend',
    label: '泽村家熟客',
    cost: 40,
    description: '和泽村家有旧交，能自然出入家门和画室。',
    effects: [
      { targetId: '泽村小百合', affinityDelta: 35, impression: '可以放心招待的熟客', reason: '开局背景：泽村家熟客' },
      { targetId: '泽村-斯宾塞-英梨梨', affinityDelta: 30, obsessionDelta: -30, impression: '避不开也不讨厌的旧熟人', reason: '开局背景：泽村家熟客' },
    ],
  },
  {
    id: 'industry-producer',
    label: '业界制作资源',
    cost: 40,
    description: '手里有制作资源和执行经验，成人组会更早把你放进视野。',
    effects: [
      { targetId: '高坂茜(红坂朱音)', affinityDelta: 35, impression: '值得试探的制作资源', reason: '开局背景：业界制作资源' },
      { targetId: '町田苑子', affinityDelta: 25, impression: '能推进企划的现实派', reason: '开局背景：业界制作资源' },
    ],
  },
  {
    id: 'quiet-supporter',
    label: '低调同席者',
    cost: 40,
    description: '不抢镜，但会听完别人说话；加藤惠和出海更容易记住你。',
    effects: [
      { targetId: '加藤惠', affinityDelta: 40, impression: '不抢镜但会认真看见她的人', reason: '开局背景：低调同席者' },
      { targetId: '波岛出海', affinityDelta: 20, obsessionDelta: -15, impression: '愿意认真听她说话的人', reason: '开局背景：低调同席者' },
    ],
  },
];

const BACKGROUND_BY_ID = new Map(PLAYER_BACKGROUND_OPTIONS.map(option => [option.id, option]));

export function normalizePlayerBackgroundIds(input: unknown): string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\s]+/)
      : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of values) {
    const id = String(value ?? '').trim();
    if (!id || seen.has(id) || !BACKGROUND_BY_ID.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function normalizePlayerBackgroundLabels(input: unknown, ids: string[] = []): string[] {
  const labelsById = getPlayerBackgroundLabels(ids);
  if (labelsById.length) return labelsById;
  const labels = Array.isArray(input)
    ? input.map(value => String(value ?? '').trim()).filter(Boolean)
    : [];
  return labels;
}

export function getPlayerBackgroundOptions(ids: string[]): PlayerBackgroundOption[] {
  return normalizePlayerBackgroundIds(ids)
    .map(id => BACKGROUND_BY_ID.get(id))
    .filter((option): option is PlayerBackgroundOption => Boolean(option));
}

export function getPlayerBackgroundCost(ids: string[]): number {
  return getPlayerBackgroundOptions(ids).reduce((total, option) => total + option.cost, 0);
}

export function getPlayerBackgroundLabels(ids: string[]): string[] {
  return getPlayerBackgroundOptions(ids).map(option => option.label);
}

function hasObsessionAxis(target: TargetStatus) {
  return target.meta?.noObsessionAxis !== true;
}

export function applyPlayerBackgroundsToInitialState(
  statusData: StatusData,
  memoryDB: IslandMemoryDB,
  backgroundIds: string[],
): { ids: string[]; labels: string[]; cost: number } {
  const options = getPlayerBackgroundOptions(backgroundIds);
  const changedTargetReasons = new Map<string, Set<string>>();
  const impressions: any[] = [];

  for (const option of options) {
    for (const effect of option.effects) {
      const target = statusData.targets.find(item => item.id === effect.targetId);
      if (!target) continue;

      let changed = false;
      if (effect.affinityDelta) {
        target.affinity = clamp((target.affinity ?? 0) + effect.affinityDelta, 0, 100);
        target.stage = affinityStage(target.affinity);
        changed = true;
      }
      if (effect.obsessionDelta && hasObsessionAxis(target)) {
        const nextObsession = clamp((target.obsession ?? 0) + effect.obsessionDelta, 0, 100);
        if (nextObsession !== target.obsession) {
          target.obsession = nextObsession;
          target.obsessionStage = obsessionStage(target.obsession);
          changed = true;
        }
      }
      if (!changed) continue;

      const reasons = changedTargetReasons.get(target.id) ?? new Set<string>();
      reasons.add(effect.reason);
      changedTargetReasons.set(target.id, reasons);
      impressions.push({
        targetId: target.id,
        subject: 'user',
        label: effect.impression,
        polarity: 1,
        weight: 5,
        reason: effect.reason,
        gameTime: statusData.world.currentTime,
        importance: 5,
        confidence: 'certain',
        tags: [PHONE_ARCHIVE_IMPRESSION_GOLD_TAG, PHONE_ARCHIVE_IMPRESSION_LOCKED_TAG],
        extra: { backgroundId: option.id, cost: option.cost },
      });
    }
  }

  for (const [targetId, reasons] of changedTargetReasons) {
    const target = statusData.targets.find(item => item.id === targetId);
    if (!target) continue;
    const reason = [...reasons].join('；');
    upsertAttribute(memoryDB, {
      targetId,
      key: 'affinity',
      value: String(target.affinity),
      valueType: 'number',
      reason,
      importance: 4,
      source: 'manual',
    });
    if (hasObsessionAxis(target)) {
      upsertAttribute(memoryDB, {
        targetId,
        key: 'obsession',
        value: String(target.obsession),
        valueType: 'number',
        reason,
        importance: 4,
        source: 'manual',
      });
    }
  }

  if (impressions.length) {
    commitBatch(memoryDB, {
      source: 'manual',
      inserts: { impressions },
    });
  }

  return {
    ids: options.map(option => option.id),
    labels: options.map(option => option.label),
    cost: options.reduce((total, option) => total + option.cost, 0),
  };
}
