import type { StatusData, TargetStatus } from '../types';

// ── 默认数据（内容层保留中文，仅作 fallback） ──

export const defaultTarget: TargetStatus = {
  id: 'baiya',
  name: '白娅',
  alias: '白鸦',
  affinity: 72,
  stage: '忐忑相依',
  titles: {
    雨夜联系人: {
      effect: '在深夜对话中会更主动索取回应。',
      selfComment: '屏幕亮起来的时候，我第一反应就是你。',
    },
    脆弱依附: {
      effect: '出现异常声响时，会优先寻求你的安抚。',
      selfComment: '别突然不说话，我会乱想。',
    },
    贴身观察者: {
      effect: '能立刻察觉你情绪与语气的细微波动。',
      selfComment: '你只要迟疑半秒，我就知道你在犹豫。',
    },
  },
  outfits: {
    上装: '宽松白衬衫，袖口残留一点雨水潮气。',
    下装: '深色短裙，边缘被夜风吹得微微凌乱。',
    内衣: '轻薄黑色内衬，紧贴皮肤却不刻意张扬。',
    袜子: '过膝袜，右腿袜口稍微滑落。',
    鞋子: '低跟短靴，鞋尖沾着未干的水痕。',
    饰品: '旧手机挂饰与一枚细银项圈。',
  },
};

export const defaultStatusData: StatusData = {
  world: {
    currentTime: '2026-03-13 22:10',
    currentLocation: '旧城区·临街公寓',
    recentEvents: {
      未接来电: '白娅在过去十五分钟内尝试联系了你三次。',
      楼道异响: '门外有断续脚步声，她的情绪明显变得敏感。',
      深夜共振: '手机仍保持静音震动模式，适合同层界面游玩。',
    },
  },
  targets: [defaultTarget],
  activeTargetId: 'baiya',
  player: {
    inventory: {
      手机: { description: '仍在运行同层卡界面。', count: 1 },
      公寓钥匙: { description: '704 室的钥匙，边缘有磨损。', count: 1 },
      止痛药: { description: '应急备用，小瓶装。', count: 2 },
      纸币: { description: '夹在手机壳里的零钱。', count: 86 },
    },
  },
};

// ── 工具函数 ──

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function affinityStage(value: number) {
  if (value < 20) return '消极自毁';
  if (value < 40) return '渴求注视';
  if (value < 60) return '暗中靠近';
  if (value < 80) return '忐忑相依';
  return '柔软依存';
}

/** @deprecated 兼容别名 */
export const dependencyStage = affinityStage;

export function formatTime(value: string) {
  return value.match(/\d{2}:\d{2}/)?.[0] ?? value;
}

export function formatDate(value: string) {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? value;
}

export function getInventoryIcon(name: string) {
  if (name.includes('手机') || name.includes('电话')) return 'PH';
  if (name.includes('钥匙')) return 'KY';
  if (name.includes('药') || name.includes('糖')) return 'RX';
  if (name.includes('钱') || name.includes('币')) return '$$';
  if (name.includes('证') || name.includes('卡')) return 'ID';
  return name.slice(0, 2).toUpperCase();
}

// ── 归一化：旧结构 → 新 targets[] 结构 ──

function normalizeTarget(raw: Record<string, any>, fallback: TargetStatus): TargetStatus {
  const affinity = clamp(Number(raw?.依存度 ?? raw?.dependency ?? raw?.affinity ?? fallback.affinity) || 0, 0, 100);
  const titlesInput = raw?.称号 ?? raw?.titles ?? {};
  const outfitsInput = raw?.着装 ?? raw?.outfits ?? {};

  return {
    id: String(raw?.id ?? fallback.id),
    name: String(raw?.name ?? fallback.name),
    alias: raw?.alias ?? fallback.alias,
    affinity,
    stage: String(raw?.$依存度阶段 ?? raw?.stage ?? affinityStage(affinity)),
    titles: Object.fromEntries(
      Object.entries(titlesInput)
        .filter(([key]) => Boolean(key))
        .map(([key, value]) => [
          String(key),
          {
            effect: String((value as any)?.效果 ?? (value as any)?.effect ?? '暂无效果描述'),
            selfComment: String((value as any)?.自我评价 ?? (value as any)?.selfComment ?? '……'),
          },
        ]),
    ),
    outfits: Object.fromEntries(
      Object.entries({ ...fallback.outfits, ...outfitsInput }).map(([key, value]) => [key, String(value)]),
    ),
    meta: raw?.meta,
  };
}

function findLegacyTargetEntry(raw: Record<string, any>): { name: string; value: Record<string, any> } | null {
  for (const key of ['白娅', 'baiya']) {
    const value = raw[key];
    if (value && typeof value === 'object') {
      return { name: key, value: value as Record<string, any> };
    }
  }

  const ignoredKeys = new Set(['世界', 'world', '主角', 'player', 'targets', 'activeTargetId']);
  for (const [key, value] of Object.entries(raw)) {
    if (ignoredKeys.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const looksLikeTarget =
      '依存度' in value || 'dependency' in value || 'affinity' in value || '着装' in value || 'outfits' in value || '称号' in value || 'titles' in value;
    if (looksLikeTarget) {
      return { name: key, value: value as Record<string, any> };
    }
  }

  return null;
}

/**
 * 将任意 stat_data 归一化为新 StatusData 结构。
 *
 * 支持三种输入格式：
 * 1. 新格式：已有 targets[]
 * 2. 旧英文格式：{ baiya: {...}, world: {...}, player: {...} }
 * 3. 旧中文格式：{ 白娅: {...}, 世界: {...}, 主角: {...} }
 *
 * 内部表示用英文 key（TargetStatus 类型），
 * 序列化到 stat_data 时由 adapter 写回中文 key（MVU 兼容）。
 */
export function normalizeStatusData(input: unknown): StatusData {
  const raw = typeof input === 'object' && input ? (input as Record<string, any>) : {};

  // 新格式：已有 targets[]
  if (Array.isArray(raw.targets)) {
    const targets: TargetStatus[] = raw.targets.map((t: any) => normalizeTarget(t, defaultTarget));
    return {
      world: normalizeWorld(raw),
      targets: targets.length ? targets : [{ ...defaultTarget }],
      activeTargetId: raw.activeTargetId ?? targets[0]?.id ?? defaultTarget.id,
      player: normalizePlayer(raw),
    };
  }

  // 旧格式：baiya / 白娅 → 包装为 targets[0]
  const legacyTarget = findLegacyTargetEntry(raw);
  const targetRaw = legacyTarget?.value ?? {};
  const target = normalizeTarget(
    {
      ...targetRaw,
      id: targetRaw.id ?? legacyTarget?.name ?? defaultTarget.id,
      name: targetRaw.name ?? legacyTarget?.name ?? defaultTarget.name,
    },
    defaultTarget,
  );

  return {
    world: normalizeWorld(raw),
    targets: [target],
    activeTargetId: target.id,
    player: normalizePlayer(raw),
  };
}

function normalizeWorld(raw: Record<string, any>) {
  const eventsInput = raw?.世界?.近期事务 ?? raw?.world?.recentEvents ?? {};
  return {
    currentTime: String(raw?.世界?.当前时间 ?? raw?.world?.currentTime ?? defaultStatusData.world.currentTime),
    currentLocation: String(
      raw?.世界?.当前地点 ?? raw?.world?.currentLocation ?? defaultStatusData.world.currentLocation,
    ),
    recentEvents: Object.fromEntries(
      Object.entries(eventsInput)
        .filter(([key]) => Boolean(key))
        .map(([key, value]) => [String(key), String(value)]),
    ),
  };
}

function normalizePlayer(raw: Record<string, any>) {
  const inventoryInput = raw?.主角?.物品栏 ?? raw?.player?.inventory ?? {};
  return {
    inventory: Object.fromEntries(
      Object.entries(inventoryInput)
        .map(([key, value]) => [
          String(key),
          {
            description: String((value as any)?.描述 ?? (value as any)?.description ?? '暂无描述'),
            count: Math.max(0, Number((value as any)?.数量 ?? (value as any)?.count ?? 0) || 0),
          },
        ])
        .filter(([, item]) => (item as { count: number }).count > 0),
    ),
  };
}

// ── 序列化：新结构 → 中文 key stat_data（MVU 兼容写回） ──

export function serializeStatusData(statusData: StatusData): Record<string, any> {
  const target = statusData.targets[0];
  if (!target) {
    return {
      世界: {
        当前时间: statusData.world.currentTime,
        当前地点: statusData.world.currentLocation,
        近期事务: statusData.world.recentEvents,
      },
      主角: {
        物品栏: Object.fromEntries(
          Object.entries(statusData.player.inventory).map(([name, detail]) => [
            name,
            { 描述: detail.description, 数量: detail.count },
          ]),
        ),
      },
    };
  }

  return {
    世界: {
      当前时间: statusData.world.currentTime,
      当前地点: statusData.world.currentLocation,
      近期事务: statusData.world.recentEvents,
    },
    [target.name]: {
      依存度: target.affinity,
      $依存度阶段: target.stage,
      着装: target.outfits,
      称号: Object.fromEntries(
        Object.entries(target.titles).map(([name, detail]) => [
          name,
          { 效果: detail.effect, 自我评价: detail.selfComment },
        ]),
      ),
    },
    主角: {
      物品栏: Object.fromEntries(
        Object.entries(statusData.player.inventory).map(([name, detail]) => [
          name,
          { 描述: detail.description, 数量: detail.count },
        ]),
      ),
    },
  };
}

// ── 从 <progress> 解析结果应用变量更新 ──

import type { ProgressUpdate } from '../message-format';

const MAX_RECENT_EVENTS = 5;

export function applyProgressUpdate(statusData: StatusData, update: ProgressUpdate): void {
  if (update.time) {
    statusData.world.currentTime = update.time;
  }
  if (update.location) {
    statusData.world.currentLocation = update.location;
  }

  // Affinity delta → update active target
  if (update.affinityDelta !== undefined && update.affinityDelta !== 0) {
    const target = statusData.targets.find(t => t.id === statusData.activeTargetId);
    if (target) {
      target.affinity = clamp(0, 100, (target.affinity ?? 50) + update.affinityDelta);
      target.stage = affinityStage(target.affinity);
    }
  }

  // Outfit changes → update active target
  if (Object.keys(update.outfitChanges).length) {
    const target = statusData.targets.find(t => t.id === statusData.activeTargetId);
    if (target) {
      for (const [part, desc] of Object.entries(update.outfitChanges)) {
        target.outfits[part] = desc;
      }
    }
  }

  // Merge events: new ones go first, trim to MAX_RECENT_EVENTS
  if (Object.keys(update.events).length) {
    const merged = { ...update.events, ...statusData.world.recentEvents };
    const entries = Object.entries(merged).slice(0, MAX_RECENT_EVENTS);
    statusData.world.recentEvents = Object.fromEntries(entries);
  }

  // Items gained
  for (const item of update.itemsGained) {
    const existing = statusData.player.inventory[item.name];
    if (existing) {
      existing.count += item.count;
      if (item.description) existing.description = item.description;
    } else {
      statusData.player.inventory[item.name] = {
        description: item.description || '暂无描述',
        count: item.count,
      };
    }
  }

  // Items lost
  for (const name of update.itemsLost) {
    delete statusData.player.inventory[name];
  }
}
