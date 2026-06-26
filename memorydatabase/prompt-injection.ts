import type {
  IslandMemoryDB,
  MemoryFactRow,
} from './types';
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

  // ── 1. 摘要层：global > major > minor（可配置窗口大小）──
  buildSummaryBlocks(db, blocks, config);
  buildRelevantRecallBlock(db, blocks, context, config);

  // ── 2. 整合记忆块：facts + tasks + secrets 合并，避免分散 ──
  if (config.includeFacts || config.includeTasks || config.includeSecrets) {
    buildIntegratedMemoryBlock(db, blocks, context, config);
  }

  buildTimelineBlock(db, blocks, context, config);

  // ── 3. 角色印象（仅当前在场角色，精简）──
  if (config.includeImpressions) {
    buildImpressionBlocks(db, blocks, context);
  }

  // ── 4. 按优先级排序，应用 token 预算 ──
  return assembleBlocks(blocks, config.tokenBudget);
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

/**
 * 构建整合记忆块：facts + tasks + secrets 合并成一个精简块，避免屎山。
 */
type RecallCandidate = {
  key: string;
  text: string;
  score: number;
  sortKey: string;
};

function buildRelevantRecallBlock(
  db: IslandMemoryDB,
  blocks: MemoryBlock[],
  context: MemoryInjectionContext,
  config: Required<MemoryInjectionConfig>,
): void {
  const needles = buildRecallNeedles(context);
  if (!needles.length) return;

  const currentTargetIds = new Set(context.currentTargetIds);
  const candidates = new Map<string, RecallCandidate>();
  const pushCandidate = (
    key: string,
    text: string,
    score: number,
    row?: { gameTime?: string; createdAt?: string; updatedAt?: string },
  ) => {
    if (score <= 0 || !text.trim()) return;
    const sortKey = getMemorySortKey(row ?? {});
    const existing = candidates.get(key);
    if (!existing || score > existing.score || (score === existing.score && sortKey > existing.sortKey)) {
      candidates.set(key, { key, text, score, sortKey });
    }
  };

  for (const fact of getActiveFacts(db)) {
    const text = [fact.category, fact.subject, fact.content, fact.gameTime, fact.relatedEntityIds?.join(' ')].join(' ');
    let score = scoreRecallText(text, needles);
    if (fact.relatedEntityIds?.some(id => currentTargetIds.has(id))) score += 3;
    pushCandidate(
      'fact:' + fact.id,
      '事实/' + fact.category + ': ' + formatMemoryTime(fact.gameTime) + ' ' + fact.subject + ': ' + fact.content,
      score,
      fact,
    );
  }

  for (const event of db.events.filter(e => !e.expired)) {
    const text = [
      event.title,
      event.description,
      event.outcome,
      event.location,
      event.relatedMainEventId,
      event.involvedTargetIds?.join(' '),
    ].join(' ');
    let score = scoreRecallText(text, needles);
    if (context.currentMainEventId && event.relatedMainEventId === context.currentMainEventId) score += 5;
    if (event.involvedTargetIds?.some(id => currentTargetIds.has(id))) score += 3;
    if (context.currentLocation && event.location?.includes(context.currentLocation)) score += 2;
    const place = event.location ? ' @' + event.location : '';
    const outcome = event.outcome ? ' => ' + event.outcome : '';
    pushCandidate(
      'event:' + event.id,
      '事件: ' + formatMemoryTime(event.gameTime) + place + ' ' + event.title + ': ' + event.description + outcome,
      score,
      event,
    );
  }

  for (const summary of db.summaries.filter(s => !s.expired)) {
    const text = [summary.level, summary.text].join(' ');
    const score = scoreRecallText(text, needles);
    pushCandidate(
      'summary:' + summary.id,
      '摘要/' + summary.level + ' [' + summary.range.join('-') + ']: ' + summary.text.trim(),
      score,
      summary,
    );
  }

  if (config.includeItems) {
    for (const item of db.items.filter(i => !i.expired)) {
      if (config.onlyPromptRelevantItems && item.promptRelevant !== true) continue;
      const text = [item.name, item.state, item.location, item.ownerId, item.holderId, item.action].join(' ');
      let score = scoreRecallText(text, needles);
      if (item.ownerId && currentTargetIds.has(item.ownerId)) score += 2;
      if (item.holderId && currentTargetIds.has(item.holderId)) score += 2;
      if (context.currentLocation && item.location?.includes(context.currentLocation)) score += 2;
      const action = item.action ? item.action + ' ' : '';
      const count = item.count !== undefined ? ' x' + item.count : '';
      const state = item.state ? ' - ' + item.state : '';
      pushCandidate(
        'item:' + item.id,
        '物品: ' + formatMemoryTime(item.gameTime) + ' ' + action + item.name + count + state,
        score,
        item,
      );
    }
  }

  if (config.includeImpressions) {
    for (const impression of db.impressions.filter(i => !i.expired)) {
      const text = [impression.targetId, impression.subject, impression.label, impression.reason].join(' ');
      let score = scoreRecallText(text, needles);
      if (currentTargetIds.has(impression.targetId)) score += 3;
      pushCandidate(
        'impression:' + impression.id,
        '印象: ' + formatMemoryTime(impression.gameTime) + ' ' + impression.targetId + ' -> ' + impression.subject + ': ' + impression.label,
        score,
        impression,
      );
    }
  }

  const selected = [...candidates.values()]
    .sort((a, b) => b.score - a.score || b.sortKey.localeCompare(a.sortKey))
    .slice(0, 10);
  if (!selected.length) return;

  const lines = ['相关旧记忆:'];
  selected.forEach(item => lines.push('  - ' + item.text));
  const content = lines.join('\n');
  blocks.push({
    title: '【相关召回】',
    content,
    priority: 96,
    estimatedChars: content.length + 20,
  });
}

function buildRecallNeedles(context: MemoryInjectionContext): string[] {
  const seeds = [
    context.recentUserInput,
    context.currentLocation,
    context.currentMainEventId,
    ...context.currentTargetIds,
    ...extractKeywords(context.recentUserInput ?? ''),
  ];
  const needles = new Set<string>();
  for (const seed of seeds) {
    const value = String(seed ?? '').trim().toLowerCase();
    if (!value) continue;
    if (value.length >= 2 && value.length <= 80) needles.add(value);
    for (const token of splitRecallTokens(value)) {
      if (token.length >= 2) needles.add(token);
    }
  }
  return [...needles].slice(0, 24);
}

function splitRecallTokens(value: string): string[] {
  return [
    ...(value.match(/[a-z0-9_:-]{2,}/gi) ?? []),
    ...(value.match(/[\u4E00-\u9FFF]{2,6}/g) ?? []),
  ].map(token => token.toLowerCase());
}

function scoreRecallText(text: string, needles: string[]): number {
  const haystack = text.toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  for (const needle of needles) {
    if (!needle || !haystack.includes(needle)) continue;
    score += Math.min(8, Math.max(1, Math.ceil(needle.length / 2)));
  }
  return score;
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

function buildTimelineBlock(
  db: IslandMemoryDB,
  blocks: MemoryBlock[],
  context: MemoryInjectionContext,
  config: Required<MemoryInjectionConfig>,
): void {
  const currentTargetIds = new Set(context.currentTargetIds);
  const currentEventId = context.currentMainEventId;

  const events = db.events
    .filter(e => !e.expired)
    .filter(e => {
      if (currentEventId && e.relatedMainEventId === currentEventId) return true;
      if (e.involvedTargetIds?.some(id => currentTargetIds.has(id))) return true;
      return Boolean(e.gameTime || e.relatedMainEventId);
    })
    .sort(compareRowsByMemoryTimeDesc)
    .slice(0, 8);

  const eventFacts = getActiveFacts(db, { category: 'event' })
    .sort(compareRowsByMemoryTimeDesc)
    .slice(0, 6);

  const items = config.includeItems
    ? db.items
        .filter(i => !i.expired)
        .filter(i => !config.onlyPromptRelevantItems || i.promptRelevant === true)
        .sort(compareRowsByMemoryTimeDesc)
        .slice(0, 6)
    : [];

  const lines: string[] = [];
  if (events.length) {
    lines.push('事件时间线:');
    for (const event of events) {
      const place = event.location ? ` @${event.location}` : '';
      const outcome = event.outcome ? ` => ${event.outcome}` : '';
      lines.push(`  - ${formatMemoryTime(event.gameTime)}${place} ${event.title}: ${event.description}${outcome}`);
    }
  }

  if (eventFacts.length) {
    if (lines.length) lines.push('');
    lines.push('事件事实:');
    for (const fact of eventFacts) {
      lines.push(`  - ${formatMemoryTime(fact.gameTime)} ${fact.subject}: ${fact.content}`);
    }
  }

  if (items.length) {
    if (lines.length) lines.push('');
    lines.push('物品变动:');
    for (const item of items) {
      const action = item.action ? `${item.action} ` : '';
      const count = item.count !== undefined ? ` x${item.count}` : '';
      const state = item.state ? ` - ${item.state}` : '';
      lines.push(`  - ${formatMemoryTime(item.gameTime)} ${action}${item.name}${count}${state}`);
    }
  }

  if (!lines.length) return;
  const content = lines.join('\n');
  blocks.push({
    title: '【近期时间线】',
    content,
    priority: 88,
    estimatedChars: content.length + 20,
  });
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


