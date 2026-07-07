import type {
  IslandMemoryDB,
  MemoryFactRow,
} from './types';
import { buildPlotMachinePromptBlock } from '../plot-state-machine';
import {
  getActiveFacts,
  getActiveTasks,
  getUnrevealedSecrets,
  getImpressionsForTarget,
  getWorldState,
} from './query';

/**
 * 记忆注入配置：控制摘要窗口和预算。
 */
export type MemoryInjectionConfig = {
  /** Token 预算（默认 15000，约 22500 字符）*/
  tokenBudget?: number;
  /** 保留多少条 minor 摘要（默认 8）*/
  minorWindowSize?: number;
  /** 保留多少条 major 摘要（默认 5）*/
  majorWindowSize?: number;
  /** 是否注入 facts（默认 true）*/
  includeFacts?: boolean;
  /** 是否注入 tasks（默认 true）*/
  includeTasks?: boolean;
  /** 是否注入 secrets（默认 true）*/
  includeSecrets?: boolean;
  /** 是否注入 impressions（默认 true）*/
  includeImpressions?: boolean;
  /** 是否注入物品变动（默认 true）*/
  includeItems?: boolean;
  /** 是否只注入有特殊含义的物品（默认 true）*/
  onlyPromptRelevantItems?: boolean;
};

/**
 * 记忆注入上下文：当前场景信息，用于筛选相关记忆。
 */
export type MemoryInjectionContext = {
  /** 当前游戏时间 */
  currentTime: string;
  /** 当前地点 */
  currentLocation: string;
  /** 当前在场角色 ID 列表 */
  currentTargetIds: string[];
  /** 当前主线事件 ID */
  currentMainEventId?: string;
  /** 用户最近输入（用于关键词匹配） */
  recentUserInput?: string;
  recallPlan?: {
    mustRecall?: Array<{ type?: string; queryHint: string; reason?: string; priority?: number }>;
    niceToRecall?: Array<{ type?: string; queryHint: string; reason?: string }>;
    summaryRecall?: Array<{
      sourceLevel?: 'global' | 'major' | 'minor';
      queryHint: string;
      content?: string;
      reason?: string;
      useInNextPage?: string;
    }>;
  };
  mustSuppress?: Array<{ queryHint: string; reason?: string }>;
  /** 配置参数 */
  config?: MemoryInjectionConfig;
};

/**
 * 结构化记忆块：用于注入到 prompt 的格式化文本块。
 */
type MemoryBlock = {
  /** 块标题 */
  title: string;
  /** 块内容 */
  content: string;
  /** 优先级（数字越大越重要） */
  priority: number;
  /** 估算字符数 */
  estimatedChars: number;
};

function rangeContains(outer: [number, number] | undefined, inner: [number, number] | undefined): boolean {
  if (!outer || !inner) return false;
  return inner[0] >= outer[0] && inner[1] <= outer[1];
}

/**
 * 从 memoryDB 构建结构化的 prompt 注入文本。
 *
 * 核心原则：
 * - **不删除任何记忆**：只读取，expired 标记由其他模块管理
 * - **整合而非分散**：facts/tasks/secrets/impressions 合并成精简块，避免屎山
 * - **可配置窗口**：minor/major 摘要数量可调
 * - **大 token 预算**：默认 15000 token（约 22500 字符）
 *
 * @param db IslandMemoryDB 实例
 * @param context 当前场景上下文
 * @returns 格式化的注入文本
 */
export function buildMemoryPromptInjection(
  db: IslandMemoryDB | null | undefined,
  context: MemoryInjectionContext,
): string {
  if (!db) return '';

  const config: Required<MemoryInjectionConfig> = {
    tokenBudget: context.config?.tokenBudget ?? 15000,
    minorWindowSize: context.config?.minorWindowSize ?? 8,
    majorWindowSize: context.config?.majorWindowSize ?? 5,
    includeFacts: context.config?.includeFacts ?? true,
    includeTasks: context.config?.includeTasks ?? true,
    includeSecrets: context.config?.includeSecrets ?? true,
    includeImpressions: context.config?.includeImpressions ?? true,
    includeItems: context.config?.includeItems ?? true,
    onlyPromptRelevantItems: context.config?.onlyPromptRelevantItems ?? true,
  };

  const blocks: MemoryBlock[] = [];
  buildTemporalAnchorBlock(db, blocks, context);
  buildPlotMachineBlock(db, blocks, context);

  if (context.recallPlan) {
    buildRelevantRecallBlock(blocks, context);
    return assembleBlocks(blocks, config.tokenBudget);
  }

  // ── 1. 摘要层：global > major > minor（可配置窗口大小）──
  buildSummaryBlocks(db, blocks, config);
  buildRelevantRecallBlock(blocks, context);

  // ── 2. 整合记忆块：facts + tasks + secrets 合并，避免分散 ──
  if (config.includeFacts || config.includeTasks || config.includeSecrets) {
    buildIntegratedMemoryBlock(db, blocks, context, config);
  }

  // ── 3. 角色印象（仅当前在场角色，精简）──
  if (config.includeImpressions) {
    buildImpressionBlocks(db, blocks, context);
  }

  // ── 4. 按优先级排序，应用 token 预算 ──
  return assembleBlocks(blocks, config.tokenBudget);
}

function buildPlotMachineBlock(
  db: IslandMemoryDB,
  blocks: MemoryBlock[],
  context: MemoryInjectionContext,
): void {
  const content = buildPlotMachinePromptBlock(db, context.currentMainEventId, context.currentTime);
  if (!content) return;

  blocks.push({
    title: '【剧情路线开关】',
    content,
    priority: 84,
    estimatedChars: content.length + 20,
  });
}

function buildTemporalAnchorBlock(
  db: IslandMemoryDB,
  blocks: MemoryBlock[],
  context: MemoryInjectionContext,
): void {
  const world = getWorldState(db);
  const currentTime = context.currentTime || world?.currentTime || '未知';
  const currentLocation = context.currentLocation || world?.currentLocation || '未知';
  const lines = [
    `当前故事时间: ${currentTime}`,
    `当前地点: ${currentLocation}`,
    '时间规则: 记忆行中的"发生时间/记录时间"是权威时序依据；只记得事件但没有时间时，不得把它自动归到昨天、今天或当前上午。',
  ];
  blocks.push({
    title: '【记忆时间锚点】',
    content: lines.join('\n'),
    priority: 98,
    estimatedChars: lines.join('\n').length + 20,
  });
}

/**
 * 构建摘要块（global / major / minor），窗口大小可配置。
 */
function buildSummaryBlocks(
  db: IslandMemoryDB,
  blocks: MemoryBlock[],
  config: Required<MemoryInjectionConfig>
): void {
  // Global 摘要：最高优先级
  const global = db.summaries
    .filter(s => !s.expired && s.level === 'global')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
  if (global?.text) {
    blocks.push({
      title: '【至今剧情背景】',
      content: global.text.trim(),
      priority: 100,
      estimatedChars: global.text.length + 20,
    });
  }

  // Major 摘要：高优先级，窗口大小可配置
  const majors = db.summaries
    .filter(s => !s.expired && s.level === 'major')
    .filter(s => !rangeContains(global?.range, s.range))
    .sort((a, b) => (b.range?.[0] ?? 0) - (a.range?.[0] ?? 0)) // 按时间倒序
    .slice(0, config.majorWindowSize);

  if (majors.length > 0) {
    const content = majors.map(m => m.text.trim()).join('\n\n');
    blocks.push({
      title: '【近期阶段总结】',
      content,
      priority: 90,
      estimatedChars: content.length + 20,
    });
  }

  // Minor 摘要：中优先级，窗口大小可配置
  const minors = db.summaries
    .filter(s => !s.expired && s.level === 'minor')
    .filter(s => !majors.some(m => rangeContains(m.range, s.range)))
    .sort((a, b) => (b.range?.[0] ?? 0) - (a.range?.[0] ?? 0))
    .slice(0, config.minorWindowSize);

  if (minors.length > 0) {
    const content = minors.map(m => m.text.trim()).join('\n\n');
    blocks.push({
      title: '【近期事件总结】',
      content,
      priority: 80,
      estimatedChars: content.length + 20,
    });
  }
}

function buildRelevantRecallBlock(
  blocks: MemoryBlock[],
  context: MemoryInjectionContext,
): void {
  const summaryRecall = (context.recallPlan?.summaryRecall ?? []).slice(0, 5);
  const mustRecall = (context.recallPlan?.mustRecall ?? []).slice(0, 5);
  if (!summaryRecall.length && !mustRecall.length) return;

  const lines = ['摘要召回（夏野雾姬已从全局/大总结/小总结裁决；正文只按这些写，不要自行补旧内容）:'];
  for (const item of summaryRecall) {
    lines.push(
      `  - 摘要注入[${item.sourceLevel || 'summary'}]: ${item.content || item.queryHint}${item.reason ? `（${item.reason}）` : ''}${
        item.useInNextPage ? `；正文用法：${item.useInNextPage}` : ''
      }`,
    );
  }
  for (const item of mustRecall) {
    lines.push(`  - 必须保护: ${item.queryHint}${item.reason ? `（${item.reason}）` : ''}`);
  }
  const content = lines.join('\n');
  blocks.push({
    title: '【摘要召回】',
    content,
    priority: 96,
    estimatedChars: content.length + 20,
  });
}

function buildIntegratedMemoryBlock(
  db: IslandMemoryDB,
  blocks: MemoryBlock[],
  context: MemoryInjectionContext,
  config: Required<MemoryInjectionConfig>
): void {
  const lines: string[] = [];

  // ── Tasks: 活跃任务（与当前场景相关）──
  if (config.includeTasks) {
    const tasks = getActiveTasks(db)
      .filter(t => {
        if (t.targetId && context.currentTargetIds.includes(t.targetId)) return true;
        if (t.ownerId && context.currentTargetIds.includes(t.ownerId)) return true;
        if (!t.targetId && !t.ownerId) return true; // 全局任务
        return false;
      })
      .slice(0, 5); // 最多 5 个

    if (tasks.length > 0) {
      lines.push('待办约定:');
      tasks.forEach(t => {
        const parts = [`  - ${formatMemoryTime(t.gameTime)} ${t.content}`];
        if (t.deadline) parts.push(` (截止: ${t.deadline})`);
        lines.push(parts.join(''));
      });
    }
  }

  // ── Secrets: 保密事项（当前知情者）──
  if (config.includeSecrets) {
    const secrets = getUnrevealedSecrets(db)
      .filter(s => s.knownBy.some(id => context.currentTargetIds.includes(id) || id === 'player'))
      .slice(0, 3); // 最多 3 个

    if (secrets.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('保密事项:');
      secrets.forEach(s => {
        const hidden = s.hiddenFrom?.length ? ` (对${s.hiddenFrom.join('、')}保密)` : '';
        lines.push(`  - ${formatMemoryTime(s.gameTime)} ${s.subject}: ${s.content}${hidden}`);
      });
    }
  }

  // ── Facts: 关键事实（只保留最重要的，精简）──
  if (config.includeFacts) {
    const facts = getActiveFacts(db);

    // 按类别分组，每类只取 top 3，优先保留有时间锚点的新近记录。
    const grouped = new Map<string, MemoryFactRow[]>();
    for (const fact of facts) {
      if (!grouped.has(fact.category)) {
        grouped.set(fact.category, []);
      }
      grouped.get(fact.category)!.push(fact);
    }

    const importantFacts: string[] = [];
    const priorityCategories = ['promise', 'secret', 'relation', 'event']; // 物品由 items 表按特殊含义单独控制

    for (const cat of priorityCategories) {
      const items = grouped.get(cat);
      if (items && items.length > 0) {
        sortRowsByMemoryTime(items).slice(0, 3).forEach(f => {
          importantFacts.push(`${formatMemoryTime(f.gameTime)} ${f.subject}: ${f.content}`);
        });
      }
    }

    if (importantFacts.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('关键事实:');
      importantFacts.forEach(f => lines.push(`  - ${f}`));
    }
  }

  if (lines.length > 0) {
    const content = lines.join('\n');
    blocks.push({
      title: '【关键记忆】',
      content,
      priority: 85,
      estimatedChars: content.length + 20,
    });
  }
}

/**
 * 构建印象块（当前在场角色，精简）
 */
function buildImpressionBlocks(
  db: IslandMemoryDB,
  blocks: MemoryBlock[],
  context: MemoryInjectionContext
): void {
  const lines: string[] = [];

  for (const targetId of context.currentTargetIds.slice(0, 3)) { // 最多 3 个角色
    const impressions = getImpressionsForTarget(db, targetId)
      .filter(i => Math.abs(i.weight) >= 3) // 只注入强印象（|weight| >= 3）
      .slice(0, 3); // 每个角色最多 3 条

    if (impressions.length > 0) {
      lines.push(`${targetId} 对玩家印象:`);
      impressions.forEach(i => {
        lines.push(`  - ${formatMemoryTime(i.gameTime)} ${i.label} (权重${i.weight > 0 ? '+' : ''}${i.weight})`);
      });
    }
  }

  if (lines.length > 0) {
    const content = lines.join('\n');
    blocks.push({
      title: '【角色印象】',
      content,
      priority: 75,
      estimatedChars: content.length + 20,
    });
  }
}

function formatMemoryTime(gameTime: string | undefined): string {
  const value = String(gameTime ?? '').trim();
  if (value.startsWith('记录时间')) return `[${value}]`;
  return value ? `[发生时间: ${value}]` : '[时间未记录]';
}

function compareRowsByMemoryTimeDesc(
  a: { gameTime?: string; createdAt?: string; updatedAt?: string },
  b: { gameTime?: string; createdAt?: string; updatedAt?: string },
): number {
  const ak = getMemorySortKey(a);
  const bk = getMemorySortKey(b);
  return bk.localeCompare(ak);
}

function sortRowsByMemoryTime<T extends { gameTime?: string; createdAt?: string; updatedAt?: string }>(rows: T[]): T[] {
  return [...rows].sort(compareRowsByMemoryTimeDesc);
}

function getMemorySortKey(row: { gameTime?: string; createdAt?: string; updatedAt?: string }): string {
  const gameTime = String(row.gameTime ?? '').trim();
  if (gameTime) return gameTime;
  return String(row.createdAt || row.updatedAt || '');
}

/**
 * 组装块，应用 token 预算，按优先级裁剪。
 */
function assembleBlocks(blocks: MemoryBlock[], tokenBudget: number): string {
  if (blocks.length === 0) return '';

  // 按优先级降序排序
  blocks.sort((a, b) => b.priority - a.priority);

  // 应用 token 预算（粗略估算：1 token ≈ 1.5 字符）
  const maxChars = tokenBudget * 1.5;
  let totalChars = 0;
  const selected: MemoryBlock[] = [];

  for (const block of blocks) {
    if (totalChars + block.estimatedChars > maxChars) {
      break; // 超出预算，停止添加
    }
    selected.push(block);
    totalChars += block.estimatedChars;
  }

  // 拼接成最终文本
  return selected.map(b => `${b.title}\n${b.content}`).join('\n\n');
}

/**
 * 从用户输入提取关键词（用于未来的相关性检索）
 */
export function extractKeywords(input: string): string[] {
  if (!input) return [];

  // 简单实现：提取 2-4 字的中文词组
  const words = input.match(/[一-龥]{2,4}/g) || [];
  return [...new Set(words)].slice(0, 10); // 去重，最多 10 个关键词
}


