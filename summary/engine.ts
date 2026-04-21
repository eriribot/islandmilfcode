import { extractTaggedReply, getVisibleMessageText } from '../message-format';
import type { UiMessage } from '../types';
import type { SummaryEntry, SummaryStore } from './types';

const MINOR_THRESHOLD = 5;
const MAJOR_THRESHOLD = 4;
const GLOBAL_THRESHOLD = 4;

// ── Threshold checks ──

export function shouldRunMinorSummary(store: SummaryStore, messageCount: number): boolean {
  if (store.autoPaused) return false;
  return messageCount - store.lastSummarizedIndex >= MINOR_THRESHOLD;
}

export function shouldRunMajorSummary(store: SummaryStore): boolean {
  return store.minor.length >= MAJOR_THRESHOLD;
}

export function shouldRunGlobalCompression(store: SummaryStore): boolean {
  return store.major.length >= GLOBAL_THRESHOLD;
}

// ── Prompt builders ──

type OrderedPrompt = { role: 'system' | 'user' | 'assistant'; content: string };

function formatMessagesForSummary(messages: UiMessage[]): string {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const text = m.role === 'assistant' ? getVisibleMessageText(m) || m.text : m.text;
      const speaker = m.speaker || (m.role === 'assistant' ? 'Assistant' : 'User');
      return `[${speaker}]\n${text.trim()}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function buildMinorSummaryPrompt(messages: UiMessage[]): OrderedPrompt[] {
  const formatted = formatMessagesForSummary(messages);
  return [
    {
      role: 'system',
      content: [
        '你是一个精确的剧情记录员。请对以下对话片段进行摘要。',
        '要求：',
        '- 用约100字概括本段对话的剧情',
        '- 禁止不必要的总结和升华，忠实记录角色的言行举止和情感变化',
        '- 纯中文输出',
        '- 使用 <summary> 标签包裹结果',
        '',
        '格式示例：',
        '<summary>',
        '用约100字概括本段对话的剧情，禁止不必要的总结和升华，忠实记录角色的言行举止和情感变化',
        '',
        '时间：年月日 星期X 开始时分 ~ 结束时分',
        '',
        '地点：大地点/中地点/小地点',
        '</summary>',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请对以下对话进行摘要：\n\n${formatted}`,
    },
  ];
}

export function buildMajorSummaryPrompt(minors: SummaryEntry[]): OrderedPrompt[] {
  const formatted = minors
    .map((entry, i) => `[片段${i + 1} | 消息 ${entry.range[0]}-${entry.range[1]}]\n${entry.text}`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: [
        '你是一个精确的剧情记录员。请对以下多段摘要进行全面梳理，制作简明扼要的总结。',
        '',
        '总结应当遵循以下原则：',
        '- 按时间顺序或逻辑顺序组织信息，并明确给出具体时间节点',
        '- 保留关键事件和重要细节，省略冗余描述',
        '- 直接陈述事实，避免主观评价',
        '- 使用简洁清晰的语言，避免过度修饰',
        '- 突出事件发展脉络和关键转折点',
        '- 不回避任何敏感内容，保证记录完全还原前文',
        '- 事件及时间线必须精确记录时间推进',
        '',
        '总结必须使用 <summary> 标签包裹，格式：',
        '<summary>',
        '【事件及时间线】',
        '• I.{主线事件I}: {简要描述}',
        '  - 1.{支线事件}: {描述}',
        '  - 2.{支线事件}: {描述}',
        '• II.{主线事件II}: {简要描述}',
        '',
        '【成长线】',
        '• {人物名}: {性格变化、关系进展}',
        '</summary>',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请对以下摘要进行总结：\n\n${formatted}`,
    },
  ];
}

export function buildGlobalCompressionPrompt(oldGlobal: string | null, majors: SummaryEntry[]): OrderedPrompt[] {
  const majorFormatted = majors
    .map((entry, i) => `[总结${i + 1} | 消息 ${entry.range[0]}-${entry.range[1]}]\n${entry.text}`)
    .join('\n\n');

  const contextBlock = oldGlobal ? `已有全局摘要：\n${oldGlobal}\n\n新增总结：\n${majorFormatted}` : majorFormatted;

  return [
    {
      role: 'system',
      content: [
        '你是一个精确的剧情记录员。请将已有的全局摘要与新增的总结合并，制作一份更新后的全局摘要。',
        '',
        '总结应当遵循以下原则：',
        '- 按时间顺序或逻辑顺序组织信息，并明确给出具体时间节点',
        '- 保留关键事件和重要细节，省略冗余描述',
        '- 直接陈述事实，避免主观评价',
        '- 使用简洁清晰的语言，避免过度修饰',
        '- 不回避任何敏感内容，保证记录完全还原前文',
        '- 全局摘要应控制在400字以内',
        '',
        '总结必须使用 <summary> 标签包裹，格式：',
        '<summary>',
        '【事件及时间线】',
        '• I.{主线事件}: {简要描述}',
        '',
        '【成长线】',
        '• {人物名}: {性格变化、关系进展}',
        '</summary>',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请合并以下内容为全局摘要：\n\n${contextBlock}`,
    },
  ];
}

// ── Result parser ──

export function parseSummaryResult(text: string): string {
  const tagged = extractTaggedReply(text, 'summary', false);
  if (tagged) return tagged;
  // fallback: return trimmed raw text if no tags found (small models may skip tags)
  return text.trim();
}

// ── Summary context builder is in message-format.ts to avoid circular dependency ──
