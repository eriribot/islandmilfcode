export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function affinityStage(value: number) {
  if (value < 10) return '疏离戒备';
  if (value < 40) return '试探靠近';
  if (value < 60) return '熟悉彼此';
  if (value < 80) return '信任依赖';
  return '亲密相伴';
}

// 旧情度（obsession）= 角色对伦也旧线的牵挂程度，越高越偏向回到伦也身边。
// 阶段命名按"危险度"读：还在他怀里 → 已经放下，玩家的目标是把它降下去。
export function obsessionStage(value: number) {
  if (value < 10) return '已经放下';
  if (value < 30) return '旧线松动';
  if (value < 60) return '仍有牵挂';
  if (value < 85) return '心还系着他';
  return '还在他怀里';
}

/** @deprecated Compatibility alias for older imports. */
export const dependencyStage = affinityStage;

// ── 依恋值（attachment）：从已有的亲密接触计数 + 结缘闩锁“派生”的刻度，不是独立 AI 变量。 ──
// 设计意图：加深玩家与角色的依恋感，而非征服式战绩。单一真相源 = bodyCounters + virginity，
// 因此天然不会与正文脱钩，回滚整体替换 statusData 时也自动回退，无需单独存储或同步。

/** 各类亲密接触对依恋值的边际权重（每次的“首次冲击”权重，后续递减）。 */
const ATTACHMENT_WEIGHTS: Record<string, number> = {
  接吻次数: 6,
  口交次数: 5,
  乳交次数: 5,
  性交次数: 10,
  被内射次数: 8,
  肛交次数: 6,
};
/** 未列出的自定义字段（特殊玩法）按此基础权重计入。 */
const ATTACHMENT_DEFAULT_WEIGHT = 4;
/** 结缘（贞操闩锁失去）一次性奠定的依恋基底。 */
const ATTACHMENT_BOND_BASE = 18;

/**
 * 把一个计数 n 折算成边际递减的贡献：第 1 次给满权重，之后每次衰减。
 * 用 w * ln(1+n) 的离散近似实现“首次最重、越往后越平”，避免线性堆到爆表。
 */
function diminishingContribution(weight: number, n: number): number {
  if (n <= 0) return 0;
  return weight * Math.log1p(n);
}

/**
 * 计算依恋值（0~100，四舍五入取整）。
 * @param counters 亲密接触计数（经验人数等已废弃字段调用方应先剔除）
 * @param bonded   是否已结缘（贞操闩锁 lost）
 */
export function attachmentValue(
  counters: Record<string, number> | null | undefined,
  bonded: boolean,
): number {
  let raw = bonded ? ATTACHMENT_BOND_BASE : 0;
  if (counters) {
    for (const [field, value] of Object.entries(counters)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      const weight = ATTACHMENT_WEIGHTS[field] ?? ATTACHMENT_DEFAULT_WEIGHT;
      raw += diminishingContribution(weight, n);
    }
  }
  return clamp(Math.round(raw), 0, 100);
}

/** 依恋值阶段命名（暖向，依恋感而非征服）。 */
export function attachmentStage(value: number) {
  if (value <= 0) return '尚无肌肤之亲';
  if (value < 25) return '初尝亲密';
  if (value < 50) return '渐生依恋';
  if (value < 75) return '难分难舍';
  return '彻底沦陷';
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
