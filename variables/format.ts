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
