import { buildPlotFlagProposalPrompts, type PlotFlagProposalPrompt } from './proposal-prompt';
import { reviewPlotFlagProposal } from './proposal';
import type { PlotFlagReviewResult, PlotFlagValueMap, PlotMachineDefinition } from './types';

export type PlotFlagReviewRunResult = {
  status: 'skipped' | 'cancelled' | 'accepted' | 'accepted_no_change' | 'failed';
  attempts: number;
  review: PlotFlagReviewResult | null;
  failureMessages: string[];
};

export async function runPlotFlagReviewWithRetry(input: {
  machine: PlotMachineDefinition;
  currentTime?: string;
  currentEventId?: string;
  sceneText: string;
  currentValues?: PlotFlagValueMap;
  generate: (prompts: PlotFlagProposalPrompt[], attempt: number) => Promise<string>;
  isCancelled?: () => boolean;
}): Promise<PlotFlagReviewRunResult> {
  const prompts = buildPlotFlagProposalPrompts(input);
  if (!prompts.length) {
    return { status: 'skipped', attempts: 0, review: null, failureMessages: [] };
  }

  let review: PlotFlagReviewResult | null = null;
  let attemptPrompts = prompts;
  const failureMessages: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (input.isCancelled?.()) {
      return { status: 'cancelled', attempts: attempt - 1, review, failureMessages };
    }
    try {
      const raw = await input.generate(attemptPrompts, attempt);
      if (input.isCancelled?.()) {
        return { status: 'cancelled', attempts: attempt, review, failureMessages };
      }
      review = reviewPlotFlagProposal(raw, input);
      if (attempt === 1) {
        if (review.status === 'rejected') {
          failureMessages.push(...review.errors.map(error => `${error.code}: ${error.message}`));
        }
        attemptPrompts = buildFinalSemanticAdjudicationPrompts(prompts, review);
        continue;
      }
      if (review.status !== 'rejected') {
        return { status: review.status, attempts: attempt, review, failureMessages };
      }
      failureMessages.push(...review.errors.map(error => `${error.code}: ${error.message}`));
    } catch (error) {
      if (input.isCancelled?.()) {
        return { status: 'cancelled', attempts: attempt, review, failureMessages };
      }
      failureMessages.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { status: 'failed', attempts: 2, review, failureMessages };
}

function buildFinalSemanticAdjudicationPrompts(
  prompts: PlotFlagProposalPrompt[],
  draftReview: PlotFlagReviewResult,
): PlotFlagProposalPrompt[] {
  const deterministicErrors =
    draftReview.status === 'rejected'
      ? draftReview.errors.map(error => `- ${error.code}: ${error.message}`)
      : ['- 无；这不代表草稿语义正确。'];
  const finalInstruction = [
    'FINAL_SEMANTIC_ADJUDICATION_V3',
    '这是第二次且最终的盲审语义裁决。第一轮只是未展示给你的不可信草稿，最终输出才可能写入状态。',
    '重新执行 system 中步骤1至步骤9，独立阅读完整本轮正文和每个 flag 的完整 yes/no 含义。不得猜测或复原第一轮给过哪些值。',
    '不要做逐字模板或关键词命中。根据上下文、否定范围、时态、主体、因果和已完成程度判断正文结束时的真实状态。',
    '独立检查全部可用 flag；可以输出正文蕴含的变化，也可以在没有变化时输出 checked:true 与空 deltas。',
    'evidenceQuote 只证明证据来自本轮正文，不负责替代语义判断；只引用 user JSON 中现有的 E 编号，不得抄写、翻译、改字或用省略号拼接正文。',
    '第一轮确定性协议错误：',
    ...deterministicErrors,
    '只输出一个最终 <plot_flag_proposal> 标签，不要解释。',
  ].join('\n');
  return prompts.map((prompt, index) =>
    index === 0 ? { ...prompt, content: `${prompt.content}\n\n${finalInstruction}` } : prompt,
  );
}
