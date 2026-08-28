import type { IslandMemoryDB } from './memorydatabase/types';
import { readActivePlotRouteChoice, type PlotRouteFamilyId } from './plot-state-machine';
import { SAE_07_EPILOGUE_EVENT_ID } from './plot-state-machine/v07';
import type { PlotLibrary } from './types';

const FAMILY_LABELS: Record<PlotRouteFamilyId, string> = {
  stay: '留下',
  solo: '单飞',
  akane: '朱音',
};

const FALLBACK_COGNITION: Record<PlotRouteFamilyId, string> = {
  stay: 'User仍以原有创作据点的留下者自居；其他角色不能把送别理解为User离开旧体系。',
  solo: 'User已经以自己的名义离开旧体系；其他角色把User视为独立创作者，加入其新项目必须重新确认。',
  akane: 'User已经进入朱音的高压创作体系；其他角色把User视为同一大战场中的竞争者或合作者，但不会自动跟随加入。',
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function readRouteCognition(plotLibrary: PlotLibrary, familyId: PlotRouteFamilyId) {
  const event = plotLibrary.events[SAE_07_EPILOGUE_EVENT_ID];
  if (!event?.content) return null;

  let content: JsonRecord | null = null;
  try {
    content = asRecord(JSON.parse(event.content));
  } catch {
    return null;
  }
  if (!content) return null;

  const routeRoot = asRecord(content['路线认知覆盖']);
  const selected = asRecord(routeRoot?.[familyId]);
  if (!routeRoot || !selected) return null;

  return {
    rules: stringList(routeRoot['使用规则']),
    characters: Object.entries(selected)
      .map(([name, rawLines]) => ({ name, lines: stringList(rawLines) }))
      .filter(item => item.lines.length > 0),
  };
}

export function buildV07LastPromptInjection(input: {
  currentMainEventId?: string;
  plotLibrary?: PlotLibrary | null;
  memoryDB?: IslandMemoryDB | null;
}): string {
  if (input.currentMainEventId !== SAE_07_EPILOGUE_EVENT_ID) return '';

  const choice = input.memoryDB ? readActivePlotRouteChoice(input.memoryDB, 'v07') : null;
  if (!choice) {
    return [
      '【SAE_07-10终章路线认知】',
      '当前没有可验证的V07玩家路线回执。不得自行猜测stay、solo或akane，也不得把任一路线的角色认知写成既成事实；终章关键节点应等待有效路线状态。',
    ].join('\n');
  }

  const routeCognition = input.plotLibrary ? readRouteCognition(input.plotLibrary, choice.familyId) : null;
  const lines = [
    '【SAE_07-10终章路线认知｜本轮精确注入】',
    `玩家已选路线：${FAMILY_LABELS[choice.familyId]}（${choice.familyId}）。`,
    '终章在三条路线都会发生，但角色必须按下列认知理解User的组织归属、创作立场和未来关系；不得只替换台词表面措辞。',
  ];

  if (!routeCognition) {
    lines.push(`剧情卡缺少可读取的路线认知覆盖；本轮至少遵守：${FALLBACK_COGNITION[choice.familyId]}`);
    return lines.join('\n');
  }

  if (routeCognition.rules.length) {
    lines.push('覆盖规则：', ...routeCognition.rules.map(rule => `- ${rule}`));
  }
  if (routeCognition.characters.length) {
    lines.push('角色认知：');
    for (const character of routeCognition.characters) {
      lines.push(`[${character.name}]`, ...character.lines.map(item => `- ${item}`));
    }
  }
  lines.push('只在对应角色实际进入本轮镜头、发言、行动或产生即时反应时应用其认知；不得让未在场角色凭空插话或同步得知现场信息。');

  return lines.join('\n');
}
