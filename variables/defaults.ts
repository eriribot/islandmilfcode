import type { StatusData, TargetStatus } from '../types';

export const defaultTarget: TargetStatus = {
  id: 'target',
  name: '同伴',
  alias: '同伴',
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
    currentTime: '2026-03-13 22:10',
    currentLocation: '未记录地点',
    recentEvents: {
      初始记录: '新的记录已经建立。',
    },
  },
  targets: [defaultTarget],
  activeTargetId: defaultTarget.id,
  player: {
    inventory: {
      手机: { description: '用于查看记录、状态与摘要。', count: 1 },
    },
  },
};
