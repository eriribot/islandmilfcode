import type { ScenePresence, StatusData } from '../types';

export type DeepSeekModeOptions = {
  enabled: boolean;
  includeCacheHint?: boolean;
  includeFormatGuard?: boolean;
  includeWarmCharacterCapsules?: boolean;
};

export type DeepSeekModePromptInput = {
  statusData: StatusData;
  scenePresence?: ScenePresence | null;
  options?: DeepSeekModeOptions | null;
};

export function isDeepSeekModeEnabled(options?: DeepSeekModeOptions | null) {
  return Boolean(options?.enabled);
}

export function buildDeepSeekModePrompt(input: DeepSeekModePromptInput) {
  if (!isDeepSeekModeEnabled(input.options)) return '';

  const includeCacheHint = input.options?.includeCacheHint ?? true;
  const includeFormatGuard = input.options?.includeFormatGuard ?? true;
  const includeWarmCharacterCapsules = input.options?.includeWarmCharacterCapsules ?? true;
  const capsules = includeWarmCharacterCapsules
    ? buildWarmCharacterCapsules(input.statusData, input.scenePresence)
    : '';

  return [
    '[DeepSeek 模式适配层]',
    '定位：只调整上下文组织和格式护栏，不改写角色事实、世界书、剧情权威或当前镜头判定。',
    includeCacheHint
      ? '缓存原则：稳定规则优先保持顺序；当前时间、地点、玩家输入、镜头判定和工具结果属于动态尾部，不要把动态信息反向解释成全局设定。'
      : '',
    '注意力原则：优先读取本轮镜头判定、在场角色0层卡、局部关系指导、当前剧情卡和最近正文；长期摘要只补缺，不抢镜头焦点。',
    '后台角色原则：未在 present/focus 中的角色只作为后台状态存在，不得即时插话、旁听、吃醋或产生心理反应。',
    includeFormatGuard
      ? [
          '格式护栏：',
          '- 可见正文必须完整包在既有可见标签中。',
          '- 不输出检索过程、审计过程、系统解释或 DeepSeek 模式说明。',
          '- 不把后台胶囊、摘要、世界状态事实直接复述进正文。',
          '- 若信息不足，少写或保持模糊；不要凭模型印象补全 canon 细节。',
        ].join('\n')
      : '',
    capsules,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildWarmCharacterCapsules(statusData: StatusData, scenePresence?: ScenePresence | null) {
  const hotIds = new Set([...(scenePresence?.presentIds ?? []), ...(scenePresence?.focusIds ?? [])]);
  const capsules = statusData.targets
    .filter(target => !hotIds.has(target.id))
    .slice(0, 8)
    .map(target => {
      const recent = String(statusData.world.recentEvents?.[target.name] ?? '').trim();
      return [
        `[CHAR:${target.id}][后台胶囊]`,
        `姓名：${target.name}`,
        `关系温度：好感度 ${target.affinity}（${target.stage}）`,
        target.obsessionStage ? `旧线牵引：${target.obsession}（${target.obsessionStage}）` : '',
        recent ? `近期状态：${recent}` : '',
        '禁止：未被镜头判定为 present/focus 时，不得即时反应。',
      ]
        .filter(Boolean)
        .join('\n');
    });

  return capsules.length ? ['[DeepSeek 后台角色胶囊]', ...capsules].join('\n') : '';
}
