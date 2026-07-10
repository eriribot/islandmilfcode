import { extractPlotDate, isPlotDateInWindow } from './date-window';
import type { PlotFlagValueMap, PlotMachineDefinition } from './types';

export type PlotFlagProposalPrompt = {
  role: 'system' | 'user';
  content: string;
};

export function buildPlotFlagProposalPrompts(input: {
  machine: PlotMachineDefinition;
  currentTime?: string;
  currentEventId?: string;
  sceneText: string;
  currentValues?: PlotFlagValueMap;
}): PlotFlagProposalPrompt[] {
  const currentDate = extractPlotDate(input.currentTime);
  if (!isPlotDateInWindow(currentDate, input.machine.proposalWindow)) return [];

  const availableFlags = input.machine.flags.filter(flag => currentDate >= flag.earliestDate);
  const flagLines = availableFlags.map(flag => {
    const currentValue = input.currentValues?.[flag.id] ?? 'unset';
    return `- ${flag.id}（当前:${currentValue}；yes=${flag.yesMeaning}；no=${flag.noMeaning}）`;
  });

  return [
    {
      role: 'system',
      content: [
        `你是 ${input.machine.title} 的剧情事实审查器。你只能提出事实变化，不能选择最终路线。`,
        `当前日期:${currentDate}；当前事件:${input.currentEventId || '无'}。`,
        '只依据 user 消息中给出的本轮主正文。不得引用旧回合、规划文字、系统说明或常识补全。',
        '每条 evidenceQuote 必须逐字复制本轮正文中的连续原句，至少四个可见字符。',
        '已经是 yes 的事实不可降回 no。没有变化也必须明确 checked:true。',
        '只允许以下 flagId：',
        ...flagLines,
        '',
        '只输出一个标签，不要代码围栏、解释或额外文字：',
        '<plot_flag_proposal>',
        '{"checked":true,"deltas":[{"flagId":"允许的flagId","value":"yes或no","evidenceQuote":"本轮正文逐字原句"}]}',
        '</plot_flag_proposal>',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请检查以下本轮主正文：\n\n${input.sceneText.trim()}`,
    },
  ];
}
