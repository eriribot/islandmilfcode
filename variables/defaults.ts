import type { StatusData, TargetStatus } from '../types';

export const defaultTarget: TargetStatus = {
  id: 'target',
  name: localStorage.getItem('characterName') || '角色',
  alias: localStorage.getItem('characterName') || '角色',
  affinity: 50,
  stage: '熟悉彼此',
  titles: {
    初始联系人: {
      effect: '记录第一次稳定联系后的基础状态。',
      selfComment: '我们还在了解彼此。',
    },
  },
  outfits: {
    上装: '日常外套。',
    下装: '便于行动的日常服装。',
    饰品: '随身小物。',
  },
};

export const defaultStatusData: StatusData = {
  world: {
    currentTime: '2012-03-31 08:30',
    currentLocation: '\u4fa6\u63a2\u5761',
    recentEvents: {
      初始记录: '新的记录已经建立。',
    },
  },
  targets: [defaultTarget],
  activeTargetId: defaultTarget.id,
  player: {
    inventory: {
      私立丰之崎学园学生证: { description: '身为丰之崎学园的学生的证明。', count: 1 },
    },
  },
};
