import type { StatusData, TargetStatus } from '../types';

export const defaultTarget: TargetStatus = {
  id: 'target',
  name: '未载入攻略对象',
  alias: '攻略对象',
  affinity: 0,
  stage: '资料未载入',
  titles: {
    资料占位: {
      effect: '等待从世界书读取攻略对象资料。',
      selfComment: '资料尚未载入。',
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
      初始记录: '新的记录已经建立，等待攻略对象资料载入。',
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
