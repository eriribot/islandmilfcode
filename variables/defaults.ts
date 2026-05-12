import type { StatusData, TargetStatus } from '../types';

const DEFAULT_TARGET_OUTFITS = {
  上装: '日常外套。',
  下装: '便于行动的日常服装。',
  饰品: '随身小物。',
};

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
    ...DEFAULT_TARGET_OUTFITS,
  },
};

export const builtInTargetSeeds: TargetStatus[] = [
  {
    id: '加藤惠',
    name: '加藤惠',
    alias: '加藤 / 惠 / 小惠 / 路人女 / 圣人惠 / Megumi Kato',
    affinity: 0,
    stage: '疏离戒备',
    titles: {},
    outfits: { ...DEFAULT_TARGET_OUTFITS },
    meta: {
      source: 'built-in-startup',
      worldbookEntryName: '加藤惠',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/megumi_phone.jpg',
    },
  },
  {
    id: '泽村-斯宾塞-英梨梨',
    name: '泽村·斯宾塞·英梨梨',
    alias: '英梨梨 / 泽村 / 柏木英理 / Eriri Sawamura',
    affinity: 0,
    stage: '疏离戒备',
    titles: {},
    outfits: { ...DEFAULT_TARGET_OUTFITS },
    meta: {
      source: 'built-in-startup',
      worldbookEntryName: '泽村·斯宾塞·英梨梨',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/eriri_phone.jpg',
    },
  },
  {
    id: '霞之丘诗羽',
    name: '霞之丘诗羽',
    alias: '霞之丘 / 诗羽 / 霞诗子 / Utaha Kasumigaoka',
    affinity: 0,
    stage: '疏离戒备',
    titles: {},
    outfits: { ...DEFAULT_TARGET_OUTFITS },
    meta: {
      source: 'built-in-startup',
      worldbookEntryName: '霞之丘诗羽',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/utaha_phone.jpg',
    },
  },
  {
    id: '波岛出海',
    name: '波岛出海',
    alias: '波岛 / 出海 / Hashima Izumi / Izumi Hashima',
    affinity: 0,
    stage: '疏离戒备',
    titles: {},
    outfits: { ...DEFAULT_TARGET_OUTFITS },
    meta: {
      source: 'built-in-startup',
      worldbookEntryName: '波岛出海',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg',
    },
  },
  {
    id: '冰堂美智留',
    name: '冰堂美智留',
    alias: '冰堂 / 美智留 / 氷堂 / Hyodo Michiru / Hyoudou Michiru',
    affinity: 0,
    stage: '疏离戒备',
    titles: {},
    outfits: { ...DEFAULT_TARGET_OUTFITS },
    meta: {
      source: 'built-in-startup',
      worldbookEntryName: '冰堂美智留',
      avatarUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Michiru_phone.jpg',
    },
  },
];

export const defaultStatusData: StatusData = {
  world: {
    currentTime: '2012-03-31 08:30',
    currentLocation: '\u4fa6\u63a2\u5761',
    currentMainEventId: '',
    mainEvents: {
      'SAE_01-1': '未进行',
      'SAE_01-2': '未进行',
    },
    recentEvents: {
      初始记录: '新的记录已经建立，等待攻略对象资料载入。',
    },
  },
  // 中文注释：内置可攻略角色先作为变量种子存在；世界书载入后会按姓名合并并保留好感。
  targets: builtInTargetSeeds,
  // 中文注释：变量目标只作为数组保存，不默认选中任何角色，避免首位角色污染变量更新。
  activeTargetId: null,
  player: {
    inventory: {
      私立丰之崎学园学生证: { description: '身为丰之崎学园的学生的证明。', count: 1 },
    },
  },
};
