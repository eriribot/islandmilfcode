import type { MemoryInjectionConfig } from './memorydatabase/prompt-injection';

/**
 * 记忆配置：包含注入配置和摘要触发配置。
 */
export type FullMemoryConfig = {
  /** 注入配置：控制注入到 prompt 的内容 */
  injection: MemoryInjectionConfig;
  /** 摘要触发配置：控制多久进行一次摘要 */
  summaryTrigger: SummaryTriggerConfig;
};

/**
 * 摘要触发配置：控制摘要的触发频率。
 */
export type SummaryTriggerConfig = {
  /** Minor 摘要触发阈值（默认 5 条消息） */
  minorThreshold?: number;
  /** Major 摘要触发阈值（默认 4 条 minor） */
  majorThreshold?: number;
  /** Global 压缩触发阈值（默认 4 条 major） */
  globalThreshold?: number;
};

const MEMORY_CONFIG_KEY = 'islandmilfcode:memory-config';

/**
 * 默认配置
 */
export const DEFAULT_MEMORY_CONFIG: Required<FullMemoryConfig> = {
  injection: {
    tokenBudget: 15000,
    minorWindowSize: 8,
    majorWindowSize: 5,
    includeFacts: true,
    includeTasks: true,
    includeSecrets: true,
    includeImpressions: true,
  },
  summaryTrigger: {
    minorThreshold: 5,
    majorThreshold: 4,
    globalThreshold: 4,
  },
};

/**
 * 从 localStorage 读取完整配置。
 */
export function loadFullMemoryConfig(): Required<FullMemoryConfig> {
  try {
    const stored = localStorage.getItem(MEMORY_CONFIG_KEY);
    if (!stored) return DEFAULT_MEMORY_CONFIG;

    const parsed = JSON.parse(stored);
    return {
      injection: {
        tokenBudget: parsed.injection?.tokenBudget ?? DEFAULT_MEMORY_CONFIG.injection.tokenBudget,
        minorWindowSize: parsed.injection?.minorWindowSize ?? DEFAULT_MEMORY_CONFIG.injection.minorWindowSize,
        majorWindowSize: parsed.injection?.majorWindowSize ?? DEFAULT_MEMORY_CONFIG.injection.majorWindowSize,
        includeFacts: parsed.injection?.includeFacts ?? DEFAULT_MEMORY_CONFIG.injection.includeFacts,
        includeTasks: parsed.injection?.includeTasks ?? DEFAULT_MEMORY_CONFIG.injection.includeTasks,
        includeSecrets: parsed.injection?.includeSecrets ?? DEFAULT_MEMORY_CONFIG.injection.includeSecrets,
        includeImpressions: parsed.injection?.includeImpressions ?? DEFAULT_MEMORY_CONFIG.injection.includeImpressions,
      },
      summaryTrigger: {
        minorThreshold: parsed.summaryTrigger?.minorThreshold ?? DEFAULT_MEMORY_CONFIG.summaryTrigger.minorThreshold,
        majorThreshold: parsed.summaryTrigger?.majorThreshold ?? DEFAULT_MEMORY_CONFIG.summaryTrigger.majorThreshold,
        globalThreshold: parsed.summaryTrigger?.globalThreshold ?? DEFAULT_MEMORY_CONFIG.summaryTrigger.globalThreshold,
      },
    };
  } catch (error) {
    console.warn('[memory-config] Failed to load config:', error);
    return DEFAULT_MEMORY_CONFIG;
  }
}

/**
 * 只读取注入配置（向后兼容）。
 */
export function loadMemoryConfig(): Required<MemoryInjectionConfig> {
  return loadFullMemoryConfig().injection;
}

/**
 * 只读取摘要触发配置。
 */
export function loadSummaryTriggerConfig(): Required<SummaryTriggerConfig> {
  return loadFullMemoryConfig().summaryTrigger;
}

/**
 * 保存完整配置到 localStorage。
 */
export function saveFullMemoryConfig(config: Partial<FullMemoryConfig>): void {
  try {
    const current = loadFullMemoryConfig();
    const updated = {
      injection: { ...current.injection, ...config.injection },
      summaryTrigger: { ...current.summaryTrigger, ...config.summaryTrigger },
    };
    localStorage.setItem(MEMORY_CONFIG_KEY, JSON.stringify(updated, null, 2));
  } catch (error) {
    console.error('[memory-config] Failed to save config:', error);
  }
}

/**
 * 保存注入配置（向后兼容）。
 */
export function saveMemoryConfig(config: Partial<MemoryInjectionConfig>): void {
  saveFullMemoryConfig({ injection: config });
}

/**
 * 保存摘要触发配置。
 */
export function saveSummaryTriggerConfig(config: Partial<SummaryTriggerConfig>): void {
  saveFullMemoryConfig({ summaryTrigger: config });
}

/**
 * 重置配置到默认值。
 */
export function resetMemoryConfig(): void {
  try {
    localStorage.removeItem(MEMORY_CONFIG_KEY);
  } catch (error) {
    console.error('[memory-config] Failed to reset config:', error);
  }
}

