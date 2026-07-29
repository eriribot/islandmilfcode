import { buildPrompt } from '../message-format';
import { resolvePlayerSchoolIdentity } from '../school-calendar';
import { createRollbackSnapshot } from '../state/store';
import type { SummaryStore } from '../summary/types';
import type { IslandMemoryDB } from '../memorydatabase/types';
import type { AppState } from '../types';
import { formatTime } from '../variables/normalize';
import {
  discardStreamingMessage,
  ensureStreamingMessage,
  finalizeStreamingText,
  recordGenerationDebug,
  type StreamingContext,
  updateStreamingText,
} from './streaming';

type OpeningActionContext = StreamingContext & {
  summaryStore: SummaryStore;
  readonly memoryDB: IslandMemoryDB;
  clearNotification: (shouldRender: boolean) => void;
};

const OPENING_USER_INPUT =
  '新建角色后的 AI 自动开场生成请求。这里没有玩家角色的主动发言、指令或行动；请只根据已经创建好的玩家档案与当前世界状态生成第一幕开场正文。';

function buildOpeningPresetInput(state: AppState, ctx: Pick<OpeningActionContext, 'summaryStore' | 'memoryDB'>) {
  const promptHistory = state.uiMessages[state.uiMessages.length - 1]?.streaming
    ? state.uiMessages.slice(0, -1)
    : state.uiMessages;
  const basePrompt = buildPrompt(state.statusData, promptHistory, OPENING_USER_INPUT, ctx.summaryStore, {
    playerProfile: state.playerProfile,
    plotLibrary: state.plotLibrary,
    characterCardLibrary: state.characterCardLibrary,
    skipProgress: true,
    suppressUserInputLine: true,
    memoryDB: ctx.memoryDB,
    drawingSettings: state.drawingSettings,
  });

  const openingContract = [
    '你正在执行“新建角色后的 AI 自动开场生成”。这是系统级开场请求，不是玩家角色在剧情中的发言。',
    '',
    '任务：根据当前玩家档案、班级、背景经历、初始世界状态、剧情卡、角色卡和关系指导，生成游戏第一幕开场正文。',
    '',
    '必须做到：',
    '- 只写自然的开场剧情，不要提到“帮我生成开场白”“按钮”“系统”“玩家请求”等元信息。',
    '- 玩家角色已经存在于世界中，但本回合没有主动说话或行动；不要替玩家做重大决定。',
    '- 开场要把玩家放入一个可继续互动的具体场景，结尾留下明确可接话的位置。',
    '- 可以描写时间、地点、环境、在场角色的自然反应。',
    '- 可见正文必须放在 <content>...</content> 中。',
    '',
    '禁止：',
    '- 不要结算好感度、执念度、亲密计数、物品、数值或时间推进。',
    '- 不要生成手机聊天内容。',
    '- 不要输出 <progress>、规划、分析、解释、摘要或调试文本。',
  ].join('\n');

  return `${openingContract}\n\n${basePrompt}`;
}

async function simulateOpeningGeneration(
  ctx: OpeningActionContext,
  generationId: string,
  isCurrentOpening: () => boolean,
) {
  const { state } = ctx;
  const profile = state.playerProfile;
  const name = profile.name || [profile.familyName, profile.givenName].filter(Boolean).join('') || '你';
  const schoolIdentity = resolvePlayerSchoolIdentity(profile, state.statusData.world.currentTime);
  const className = schoolIdentity.className || schoolIdentity.label || profile.schoolIdentityLabel || profile.className || '新的班级';
  const location = state.statusData.world.currentLocation || '校园';
  const lines = [
    `${location}的空气还带着清晨未散的凉意。`,
    `${name}站在${className}的门前，指尖刚碰到门把手，教室里的谈话声便像被风拂开的书页一样涌了出来。`,
    '有人抬头看向门口，短暂的安静给这一天留下了第一个可以接上的空白。',
  ];

  let built = '';
  for (const line of lines) {
    if (!isCurrentOpening()) return false;
    built = built ? `${built}\n${line}` : line;
    updateStreamingText(ctx, `<content>${built}</content>`);
    await new Promise(resolve => window.setTimeout(resolve, 180));
    if (!isCurrentOpening()) return false;
  }
  if (!isCurrentOpening()) return false;
  finalizeStreamingText(ctx, `<content>${built}</content>`, generationId);
  return true;
}

export async function generateOpeningScene(ctx: OpeningActionContext) {
  const { state, win } = ctx;
  if (state.generating) return false;
  state.generating = true;
  state.openingGenerationError = null;
  state.currentGenerationId = `opening-${crypto.randomUUID()}`;
  state.finalizedGenerationId = '';
  state.focusedMessagePage = 0;
  const generationId = state.currentGenerationId;
  const openingRunId = state.activeRunId;
  const openingSaveId = state.activeSaveId;
  let ownsOpeningState = true;
  const isSameRunIdentity = () =>
    state.activeRunId === openingRunId && state.activeSaveId === openingSaveId;
  const isCurrentOpening = () =>
    isSameRunIdentity()
    && (state.currentGenerationId === generationId || state.finalizedGenerationId === generationId);
  const abandonIfStale = () => {
    if (isCurrentOpening()) return false;
    ownsOpeningState = false;
    return true;
  };
  const hasPresetGenerate = typeof win.generate === 'function';
  const hasRawGenerate = typeof win.generateRaw === 'function';

  ctx.clearNotification(false);
  recordGenerationDebug(ctx, 'opening:start', {
    generationId,
    hasPresetGenerate,
    hasRawGenerate,
    playerName: state.playerProfile.name,
    className: state.playerProfile.className ?? '',
    backgroundCount: state.playerProfile.backgrounds?.length ?? 0,
  });

  try {
    ensureStreamingMessage(ctx);
    ctx.render();

    if (!hasPresetGenerate) {
      const simulated = await simulateOpeningGeneration(ctx, generationId, isCurrentOpening);
      if (!simulated || abandonIfStale()) {
        ownsOpeningState = false;
        return false;
      }
    } else {
      const userInput = buildOpeningPresetInput(state, ctx);
      // Opening generation must enter Tavern's preset stack; never use generateRaw/ordered_prompts here.
      const result = await win.generate({
        should_stream: true,
        should_silence: true,
        generation_id: generationId,
        user_input: userInput,
      });

      if (abandonIfStale()) return false;
      recordGenerationDebug(ctx, 'opening:generate-returned', {
        generationId,
        resultLength: String(result ?? '').length,
      });
      finalizeStreamingText(ctx, String(result ?? ''), generationId);
    }

    const lastMsg = state.uiMessages[state.uiMessages.length - 1];
    if (lastMsg?.role === 'assistant') {
      lastMsg.statusSnapshot = createRollbackSnapshot(state);
      ctx.persistConversation();
    }
    state.openingGenerationError = null;
    recordGenerationDebug(ctx, 'opening:success', { generationId });
    return true;
  } catch (error) {
    if (abandonIfStale()) return false;
    recordGenerationDebug(ctx, 'opening:catch', {
      generationId,
      error: error instanceof Error ? error.message : String(error),
    });
    const currentStreamingMessage = state.uiMessages[state.uiMessages.length - 1];
    // Avoid `&& current...`: the Tavern regex replacement path HTML-decodes `&curren` prefixes.
    const hasStreamingText = Boolean(
      currentStreamingMessage?.streaming ? currentStreamingMessage.text.trim() : '',
    );
    const removedStreamingMessage = discardStreamingMessage(ctx);
    if (hasStreamingText && !removedStreamingMessage) {
      const lastMsg = state.uiMessages[state.uiMessages.length - 1];
      if (lastMsg?.role === 'assistant') {
        lastMsg.statusSnapshot = createRollbackSnapshot(state);
        ctx.persistConversation();
      }
      state.openingGenerationError = null;
      recordGenerationDebug(ctx, 'opening:catch-preserved-as-success', { generationId });
      return true;
    }
    state.openingGenerationError =
      (error instanceof Error ? error.message : String(error ?? '')).trim() || '开场生成失败，请重新试一次。';
    ctx.showNotification({
      kind: 'status',
      title: 'AI 开场生成失败',
      preview: state.openingGenerationError,
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return false;
  } finally {
    const canFinalizeOpeningState =
      ownsOpeningState
      && isSameRunIdentity()
      && (!state.currentGenerationId || state.currentGenerationId === generationId)
      && (!state.finalizedGenerationId || state.finalizedGenerationId === generationId);
    if (canFinalizeOpeningState) {
      if (state.currentGenerationId === generationId) {
        state.currentGenerationId = '';
      }
      state.generating = false;
      ctx.render();
    }
  }
}
