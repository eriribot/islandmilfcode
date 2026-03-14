import type { StatusData, TavernWindow } from './types';

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
  baiya: {
    dependency: 72,
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
  },
  player: {
    inventory: {
      手机: { description: '仍在运行同层卡界面。', count: 1 },
      公寓钥匙: { description: '704 室的钥匙，边缘有磨损。', count: 1 },
      止痛药: { description: '应急备用，小瓶装。', count: 2 },
      纸币: { description: '夹在手机壳里的零钱。', count: 86 },
    },
  },
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function dependencyStage(value: number) {
  if (value < 20) return '消极自毁';
  if (value < 40) return '渴求注视';
  if (value < 60) return '暗中靠近';
  if (value < 80) return '忐忑相依';
  return '柔软依存';
}

export function normalizeStatusData(input: unknown): StatusData {
  const raw = typeof input === 'object' && input ? (input as Record<string, any>) : {};

  const dependency = clamp(Number(raw?.白娅?.依存度 ?? raw?.baiya?.dependency ?? defaultStatusData.baiya.dependency) || 0, 0, 100);
  const titlesInput = raw?.白娅?.称号 ?? raw?.baiya?.titles ?? {};
  const outfitsInput = raw?.白娅?.着装 ?? raw?.baiya?.outfits ?? {};
  const inventoryInput = raw?.主角?.物品栏 ?? raw?.player?.inventory ?? {};
  const eventsInput = raw?.世界?.近期事务 ?? raw?.world?.recentEvents ?? {};

  return {
    world: {
      currentTime: String(raw?.世界?.当前时间 ?? raw?.world?.currentTime ?? defaultStatusData.world.currentTime),
      currentLocation: String(raw?.世界?.当前地点 ?? raw?.world?.currentLocation ?? defaultStatusData.world.currentLocation),
      recentEvents: Object.fromEntries(
        Object.entries(eventsInput)
          .filter(([key]) => Boolean(key))
          .map(([key, value]) => [String(key), String(value)]),
      ),
    },
    baiya: {
      dependency,
      stage: String(raw?.白娅?.$依存度阶段 ?? raw?.baiya?.stage ?? dependencyStage(dependency)),
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
        Object.entries({ ...defaultStatusData.baiya.outfits, ...outfitsInput }).map(([key, value]) => [key, String(value)]),
      ),
    },
    player: {
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
    },
  };
}

export function loadStatusData(win: TavernWindow): StatusData {
  try {
    const messageId = typeof win.getCurrentMessageId === 'function' ? win.getCurrentMessageId() : 'latest';
    const variables =
      win.getVariables?.({ type: 'message', message_id: messageId }) ?? win.getVariables?.({ type: 'message' }) ?? {};
    if (variables.stat_data) {
      return normalizeStatusData(variables.stat_data);
    }
  } catch {
    // fallback
  }

  return normalizeStatusData(defaultStatusData);
}

export function saveStatusData(win: TavernWindow, statusData: StatusData) {
  try {
    const messageId = typeof win.getCurrentMessageId === 'function' ? win.getCurrentMessageId() : 'latest';
    win.updateVariablesWith?.(variables => {
      variables.stat_data = {
        世界: {
          当前时间: statusData.world.currentTime,
          当前地点: statusData.world.currentLocation,
          近期事务: statusData.world.recentEvents,
        },
        白娅: {
          依存度: statusData.baiya.dependency,
          $依存度阶段: statusData.baiya.stage,
          着装: statusData.baiya.outfits,
          称号: Object.fromEntries(
            Object.entries(statusData.baiya.titles).map(([name, detail]) => [
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
    }, { type: 'message', message_id: messageId });
  } catch {
    // ignore outside Tavern
  }
}

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
