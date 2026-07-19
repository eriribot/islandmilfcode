import { escapeHtml } from '../html';
import { getTargetCharacterKey } from '../school-calendar/identity-resolver';
import type { AppState, TargetStatus } from '../types';
import { renderPhoneAvatar, getPhoneTargetAvatarData, type PhoneAvatarData } from './avatars';
import {
  getPhoneArchiveImpressionSemanticKey,
  isPlayerPhonePseudoTarget,
} from './types';

export type PhoneRelationshipLayer = 'all' | 'current' | 'original';
type PhoneRelationshipSource = Exclude<PhoneRelationshipLayer, 'all'>;
type PhoneRelationshipTone = 'positive' | 'negative' | 'neutral' | 'mixed';

type PhoneRelationshipNode = {
  id: string;
  name: string;
  kind: 'target' | 'player';
  target?: TargetStatus;
  avatarAssetId?: string;
};

type PhoneRelationshipRecord = {
  fromId: string;
  toId: string;
  label: string;
  source: PhoneRelationshipSource;
  tone: PhoneRelationshipTone;
  stage?: string;
  affinity?: number;
  reason?: string;
  time?: string;
  rank: number;
  timestamp: number;
};

type PhoneRelationshipPair = {
  key: string;
  aId: string;
  bId: string;
  records: PhoneRelationshipRecord[];
  tone: PhoneRelationshipTone;
};

type PhoneRelationshipGraph = {
  nodes: PhoneRelationshipNode[];
  pairs: PhoneRelationshipPair[];
};

const PLAYER_NODE_ID = '__phone_relationship_player__';
const RELATION_KEY_SEPARATOR = '\u0000';

const viewState: {
  runId: string | null;
  focusId: string | null;
  selectedPairKey: string | null;
  layer: PhoneRelationshipLayer;
  showPlayer: boolean;
} = {
  runId: null,
  focusId: null,
  selectedPairKey: null,
  layer: 'all',
  showPlayer: false,
};

type OriginalRelationDefinition = {
  from: string;
  to: string;
  label: string;
  reason: string;
  tone: PhoneRelationshipTone;
};

// 只保留项目现有角色规则明确写出的关系；这里是 UI 底色，不写回存档。
const ORIGINAL_RELATIONS: OriginalRelationDefinition[] = [
  { from: 'eriri', to: 'utaha', label: '熟人冤家', reason: '互相揭短、创作竞争，也会以毒舌方式关心对方。', tone: 'mixed' },
  { from: 'utaha', to: 'eriri', label: '创作者同伴', reason: '表面针锋相对，危机时仍会把对方视作需要保护的同伴。', tone: 'mixed' },
  { from: 'eriri', to: 'izumi', label: '创作竞争', reason: '面对追赶自己的后辈创作者，警惕与竞争心都很强。', tone: 'negative' },
  { from: 'izumi', to: 'eriri', label: '前辈与追赶目标', reason: '憧憬前辈的才能，同时希望用作品证明自己。', tone: 'mixed' },
  { from: 'sayuri', to: 'eriri', label: '母女 / 守护', reason: '以母亲身份守护并引导英梨梨。', tone: 'positive' },
  { from: 'eriri', to: 'sayuri', label: '母女', reason: '英梨梨与母亲小百合的家庭关系。', tone: 'positive' },
  { from: 'sonoko', to: 'utaha', label: '责编 / 护犊', reason: '既负责催稿与出版，也以编辑身份保护诗羽。', tone: 'positive' },
  { from: 'utaha', to: 'sonoko', label: '作者与责编', reason: '长期合作的作者与责任编辑关系。', tone: 'positive' },
  { from: 'sonoko', to: 'akane', label: '旧交损友', reason: '熟人之间的互怼带着火药味，也保留旧日情谊。', tone: 'mixed' },
  { from: 'akane', to: 'sonoko', label: '旧交互怼', reason: '会直戳彼此痛点的业界旧识。', tone: 'mixed' },
];

function normalizeIdentity(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[·・•\s　._'"“”‘’()（）【】\[\]{}<>《》,，、:：;；!?！？-]/g, '');
}

function splitAliases(value: unknown): string[] {
  const raw = String(value ?? '').trim();
  return raw ? [raw, ...raw.split(/[\/／,，、|；;]/g)] : [];
}

function pairKey(aId: string, bId: string): string {
  return [aId, bId].sort().map(encodeURIComponent).join('|');
}

function rowTimestamp(row: { lastSeenAt?: string; updatedAt?: string; createdAt?: string }): number {
  const parsed = Date.parse(row.lastSeenAt || row.updatedAt || row.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function inferTone(label: string): PhoneRelationshipTone {
  const positive = /信任|亲密|同伴|母女|守护|关心|喜欢|爱慕|恋人|朋友|合作|责编|作者|旧交|在意|憧憬|引导|依赖|认可/.test(label);
  const negative = /敌视|敌对|戒备|嫉妒|冲突|威胁|厌恶|紧张|竞争|损友|互怼|疏离|背叛/.test(label);
  if (positive && negative) return 'mixed';
  if (negative) return 'negative';
  if (positive) return 'positive';
  return 'neutral';
}

function combineTones(records: PhoneRelationshipRecord[]): PhoneRelationshipTone {
  const tones = new Set(records.map(record => record.tone));
  if (tones.has('mixed') || (tones.has('positive') && tones.has('negative'))) return 'mixed';
  if (tones.has('negative')) return 'negative';
  if (tones.has('positive')) return 'positive';
  return 'neutral';
}

function createNodes(state: AppState, showPlayer: boolean): PhoneRelationshipNode[] {
  const seen = new Set<string>();
  const nodes: PhoneRelationshipNode[] = [];
  for (const target of state.statusData.targets) {
    if (!target.id || isPlayerPhonePseudoTarget(target) || seen.has(target.id)) continue;
    seen.add(target.id);
    nodes.push({ id: target.id, name: target.name || target.alias || '角色', kind: 'target', target });
  }
  if (showPlayer) {
    nodes.push({
      id: PLAYER_NODE_ID,
      name: state.playerProfile.name.trim() || '玩家',
      kind: 'player',
      avatarAssetId: state.playerProfile.avatarAssetId,
    });
  }
  return nodes;
}

function createIdentityResolver(state: AppState, nodes: PhoneRelationshipNode[]) {
  const identities = new Map<string, string>();
  const register = (value: unknown, id: string) => {
    for (const candidate of splitAliases(value)) {
      const normalized = normalizeIdentity(candidate);
      if (normalized && !identities.has(normalized)) identities.set(normalized, id);
    }
  };

  for (const node of nodes) {
    register(node.id, node.id);
    register(node.name, node.id);
    if (node.target) {
      register(node.target.alias, node.id);
      register(node.target.meta?.worldbookEntryName, node.id);
    }
  }
  if (nodes.some(node => node.id === PLAYER_NODE_ID)) {
    ['user', 'player', '玩家', '主角', '你', state.playerProfile.name, state.playerProfile.familyName, state.playerProfile.givenName]
      .forEach(value => register(value, PLAYER_NODE_ID));
  }
  return (value: unknown): string | null => identities.get(normalizeIdentity(value)) ?? null;
}

function splitRelationSubject(subject: string): [string, string] | null {
  const match = subject.trim().match(/^(.+?)\s*(?:→|->|＞|对|与)\s*(.+)$/);
  if (!match) return null;
  const from = match[1].trim();
  const to = match[2].trim();
  return from && to ? [from, to] : null;
}

function collectGraph(
  state: AppState,
  showPlayer: boolean,
  layer: PhoneRelationshipLayer,
): PhoneRelationshipGraph {
  const nodes = createNodes(state, showPlayer);
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const resolveIdentity = createIdentityResolver(state, nodes);
  const records: PhoneRelationshipRecord[] = [];
  const addRecord = (record: PhoneRelationshipRecord) => {
    if (record.fromId === record.toId || !nodesById.has(record.fromId) || !nodesById.has(record.toId)) return;
    const label = record.label.trim();
    if (!label) return;
    records.push({ ...record, label });
  };

  const nodeIdByCharacterKey = new Map<string, string>();
  for (const node of nodes) {
    if (!node.target) continue;
    const key = getTargetCharacterKey(node.target);
    if (key && !nodeIdByCharacterKey.has(key)) nodeIdByCharacterKey.set(key, node.id);
  }
  for (const definition of ORIGINAL_RELATIONS) {
    const fromId = nodeIdByCharacterKey.get(definition.from);
    const toId = nodeIdByCharacterKey.get(definition.to);
    if (!fromId || !toId) continue;
    addRecord({
      fromId,
      toId,
      label: definition.label,
      reason: definition.reason,
      source: 'original',
      tone: definition.tone,
      rank: 100,
      timestamp: 0,
    });
  }

  const seenExclusiveRelations = new Set<string>();
  for (const relation of state.memoryDB.relations
    .filter(row => !row.expired)
    .sort((a, b) => rowTimestamp(b) - rowTimestamp(a))) {
    const fromId = resolveIdentity(relation.fromId);
    const toId = resolveIdentity(relation.toId);
    if (!fromId || !toId) continue;
    if (relation.exclusiveGroup) {
      const exclusiveKey = `${fromId}${RELATION_KEY_SEPARATOR}${toId}${RELATION_KEY_SEPARATOR}${relation.exclusiveGroup}`;
      if (seenExclusiveRelations.has(exclusiveKey)) continue;
      seenExclusiveRelations.add(exclusiveKey);
    }
    addRecord({
      fromId,
      toId,
      label: relation.label,
      stage: relation.stage,
      affinity: relation.affinity,
      reason: relation.reason,
      time: relation.gameTime,
      source: 'current',
      tone: inferTone([relation.label, relation.stage].filter(Boolean).join(' ')),
      rank: 400,
      timestamp: rowTimestamp(relation),
    });
  }

  for (const impression of state.memoryDB.impressions.filter(row => !row.expired)) {
    const fromId = resolveIdentity(impression.targetId);
    const toId = resolveIdentity(impression.subject);
    if (!fromId || !toId) continue;
    addRecord({
      fromId,
      toId,
      label: impression.label,
      reason: impression.reason,
      time: impression.gameTime,
      source: 'current',
      tone: impression.polarity > 0 ? 'positive' : impression.polarity < 0 ? 'negative' : 'neutral',
      rank: 300,
      timestamp: rowTimestamp(impression),
    });
  }

  for (const fact of state.memoryDB.facts.filter(row => !row.expired && row.category === 'relation')) {
    const direction = splitRelationSubject(fact.subject);
    if (!direction) continue;
    const fromId = resolveIdentity(direction[0]);
    const toId = resolveIdentity(direction[1]);
    if (!fromId || !toId) continue;
    addRecord({
      fromId,
      toId,
      label: fact.content,
      time: fact.gameTime,
      source: 'current',
      tone: inferTone(fact.content),
      rank: 200,
      timestamp: rowTimestamp(fact),
    });
  }

  if (showPlayer && nodesById.has(PLAYER_NODE_ID)) {
    for (const node of nodes) {
      if (!node.target) continue;
      const affinity = Math.max(0, Math.min(100, Math.round(Number(node.target.affinity) || 0)));
      addRecord({
        fromId: node.id,
        toId: PLAYER_NODE_ID,
        label: node.target.stage || '当前关系',
        stage: node.target.stage,
        affinity,
        reason: '来自当前存档的角色关系变量。',
        source: 'current',
        tone: affinity >= 70 ? 'positive' : affinity >= 30 ? 'mixed' : 'neutral',
        rank: 500,
        timestamp: 0,
      });
    }
  }

  const selectedRecords = records.filter(record => layer === 'all' || record.source === layer);
  const deduped = new Map<string, PhoneRelationshipRecord>();
  for (const record of selectedRecords) {
    const semanticKey = getPhoneArchiveImpressionSemanticKey(record.label) || normalizeIdentity(record.label);
    const key = [record.fromId, record.toId, record.source, semanticKey].join(RELATION_KEY_SEPARATOR);
    const existing = deduped.get(key);
    if (!existing || record.rank > existing.rank || (record.rank === existing.rank && record.timestamp > existing.timestamp)) {
      deduped.set(key, record);
    }
  }

  const pairMap = new Map<string, PhoneRelationshipPair>();
  for (const record of deduped.values()) {
    const key = pairKey(record.fromId, record.toId);
    const existing = pairMap.get(key);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    const [aId, bId] = [record.fromId, record.toId].sort();
    pairMap.set(key, { key, aId, bId, records: [record], tone: 'neutral' });
  }

  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const pairs = [...pairMap.values()]
    .map(pair => ({
      ...pair,
      records: pair.records.sort((a, b) => b.rank - a.rank || b.timestamp - a.timestamp),
      tone: combineTones(pair.records),
    }))
    .sort((a, b) => {
      const aStart = Math.min(nodeOrder.get(a.aId) ?? 999, nodeOrder.get(a.bId) ?? 999);
      const bStart = Math.min(nodeOrder.get(b.aId) ?? 999, nodeOrder.get(b.bId) ?? 999);
      if (aStart !== bStart) return aStart - bStart;
      const aEnd = Math.max(nodeOrder.get(a.aId) ?? 999, nodeOrder.get(a.bId) ?? 999);
      const bEnd = Math.max(nodeOrder.get(b.aId) ?? 999, nodeOrder.get(b.bId) ?? 999);
      return aEnd - bEnd;
    });

  return { nodes, pairs };
}

function syncViewState(state: AppState): void {
  const runId = state.activeRunId || state.memoryDB.runId || null;
  if (viewState.runId === runId) return;
  viewState.runId = runId;
  viewState.focusId = null;
  viewState.selectedPairKey = null;
  viewState.layer = 'all';
  viewState.showPlayer = false;
}

function chooseFocusId(state: AppState, graph: PhoneRelationshipGraph): string | null {
  if (viewState.focusId && graph.nodes.some(node => node.id === viewState.focusId)) return viewState.focusId;
  const themedTarget = graph.nodes.find(
    node => node.target && getTargetCharacterKey(node.target) === state.phoneCharacterId,
  );
  if (themedTarget) return themedTarget.id;
  const connectedId = graph.pairs[0]?.aId;
  return connectedId ?? graph.nodes[0]?.id ?? null;
}

function nodeAvatarData(node: PhoneRelationshipNode): PhoneAvatarData {
  return node.target
    ? getPhoneTargetAvatarData(node.target)
    : { name: node.name, avatarAssetId: node.avatarAssetId };
}

function pairHasDirection(pair: PhoneRelationshipPair, fromId: string, toId: string): boolean {
  return pair.records.some(record => record.fromId === fromId && record.toId === toId);
}

function renderGraphNode(node: PhoneRelationshipNode, xPercent: number, yPercent: number, center = false): string {
  return `
    <button
      type="button"
      class="phone-relationship-node ${center ? 'is-focus' : ''}"
      data-action="relationship-focus"
      data-relationship-node-id="${escapeHtml(node.id)}"
      style="--relationship-x:${xPercent}%;--relationship-y:${yPercent}%"
      aria-label="查看${escapeHtml(node.name)}的关系"
    >
      ${renderPhoneAvatar(nodeAvatarData(node), 'phone-relationship-avatar')}
      <span class="phone-relationship-node__name">${escapeHtml(node.name)}</span>
    </button>
  `;
}

function renderFocusGraph(
  graph: PhoneRelationshipGraph,
  focus: PhoneRelationshipNode,
  focusPairs: PhoneRelationshipPair[],
): string {
  const visiblePairs = focusPairs.slice(0, 10);
  const neighbors = visiblePairs
    .map(pair => graph.nodes.find(node => node.id === (pair.aId === focus.id ? pair.bId : pair.aId)))
    .filter((node): node is PhoneRelationshipNode => Boolean(node));
  const width = 320;
  const height = 292;
  const cx = 160;
  const cy = 142;
  const rx = 122;
  const ry = 104;
  const positions = neighbors.map((_, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, neighbors.length);
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });

  const lines = visiblePairs.map((pair, index) => {
    const neighbor = neighbors[index];
    const position = positions[index];
    if (!neighbor || !position) return '';
    const outgoing = pairHasDirection(pair, focus.id, neighbor.id);
    const incoming = pairHasDirection(pair, neighbor.id, focus.id);
    const marker = `url(#phone-relationship-arrow-${pair.tone})`;
    const markerStart = incoming ? `marker-start="${marker}"` : '';
    const markerEnd = outgoing ? `marker-end="${marker}"` : '';
    return `<line class="phone-relationship-line phone-relationship-line--${pair.tone}" x1="${cx}" y1="${cy}" x2="${position.x.toFixed(1)}" y2="${position.y.toFixed(1)}" ${markerStart} ${markerEnd}></line>`;
  }).join('');

  const edgeButtons = visiblePairs.map((pair, index) => {
    const neighbor = neighbors[index];
    const position = positions[index];
    if (!neighbor || !position) return '';
    const outgoing = pairHasDirection(pair, focus.id, neighbor.id);
    const incoming = pairHasDirection(pair, neighbor.id, focus.id);
    const icon = outgoing && incoming ? '↔' : outgoing ? '→' : '←';
    return `
      <button
        type="button"
        class="phone-relationship-edge-hit phone-relationship-edge-hit--${pair.tone}"
        data-action="relationship-select-pair"
        data-relationship-pair-key="${escapeHtml(pair.key)}"
        style="--relationship-x:${(((cx + position.x) / 2 / width) * 100).toFixed(2)}%;--relationship-y:${(((cy + position.y) / 2 / height) * 100).toFixed(2)}%"
        aria-label="查看${escapeHtml(focus.name)}与${escapeHtml(neighbor.name)}的关系"
      >${icon}</button>
    `;
  }).join('');

  const nodeButtons = neighbors.map((node, index) => {
    const position = positions[index];
    return renderGraphNode(node, (position.x / width) * 100, (position.y / height) * 100);
  }).join('');

  if (!focusPairs.length) {
    return `
      <div class="phone-relationship-graph phone-relationship-graph--empty">
        ${renderGraphNode(focus, 50, 48, true)}
        <p>当前筛选下还没有与她相连的关系词条。</p>
      </div>
    `;
  }

  return `
    <div class="phone-relationship-graph" aria-label="${escapeHtml(focus.name)}的焦点关系网">
      <svg class="phone-relationship-lines" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <defs>
          <marker id="phone-relationship-arrow-positive" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto-start-reverse"><path d="M0,0 L7,3.5 L0,7 z"></path></marker>
          <marker id="phone-relationship-arrow-negative" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto-start-reverse"><path d="M0,0 L7,3.5 L0,7 z"></path></marker>
          <marker id="phone-relationship-arrow-neutral" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto-start-reverse"><path d="M0,0 L7,3.5 L0,7 z"></path></marker>
          <marker id="phone-relationship-arrow-mixed" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto-start-reverse"><path d="M0,0 L7,3.5 L0,7 z"></path></marker>
        </defs>
        ${lines}
      </svg>
      ${edgeButtons}
      ${nodeButtons}
      ${renderGraphNode(focus, 50, (cy / height) * 100, true)}
      ${focusPairs.length > visiblePairs.length ? `<span class="phone-relationship-more">另有 ${focusPairs.length - visiblePairs.length} 组见下方列表</span>` : ''}
    </div>
  `;
}

function renderRecord(record: PhoneRelationshipRecord): string {
  const sourceLabel = record.source === 'current' ? '当前剧情' : '原作底色';
  const affinity = typeof record.affinity === 'number' ? `<span>亲密 ${record.affinity}</span>` : '';
  return `
    <div class="phone-relationship-record">
      <div class="phone-relationship-record__head">
        <strong>${escapeHtml(record.label)}</strong>
        <span class="phone-relationship-source phone-relationship-source--${record.source}">${sourceLabel}</span>
      </div>
      ${record.stage || affinity ? `<div class="phone-relationship-record__meta">${record.stage ? `<span>${escapeHtml(record.stage)}</span>` : ''}${affinity}</div>` : ''}
      ${record.reason ? `<p>${escapeHtml(record.reason)}</p>` : ''}
      ${record.time ? `<time>${escapeHtml(record.time)}</time>` : ''}
    </div>
  `;
}

function renderDirectionBubble(
  from: PhoneRelationshipNode,
  to: PhoneRelationshipNode,
  records: PhoneRelationshipRecord[],
  side: 'left' | 'right',
): string {
  if (!records.length) return '';
  return `
    <div class="phone-relationship-dialogue phone-relationship-dialogue--${side}">
      ${renderPhoneAvatar(nodeAvatarData(from), 'phone-relationship-dialogue__avatar')}
      <div class="phone-relationship-bubble">
        <div class="phone-relationship-bubble__title">${escapeHtml(from.name)} 对 ${escapeHtml(to.name)}</div>
        ${records.map(renderRecord).join('')}
      </div>
    </div>
  `;
}

function renderPairDetails(
  pair: PhoneRelationshipPair | null,
  graph: PhoneRelationshipGraph,
  focusId: string,
): string {
  if (!pair) return '<div class="phone-relationship-detail-empty">选择一条关系查看双方记录。</div>';
  const focus = graph.nodes.find(node => node.id === focusId);
  const otherId = pair.aId === focusId ? pair.bId : pair.aId;
  const other = graph.nodes.find(node => node.id === otherId);
  if (!focus || !other) return '';
  const outgoing = pair.records.filter(record => record.fromId === focus.id && record.toId === other.id);
  const incoming = pair.records.filter(record => record.fromId === other.id && record.toId === focus.id);
  const singleDirection = !outgoing.length || !incoming.length;
  return `
    <section class="phone-relationship-details" aria-label="关系详情">
      <div class="phone-relationship-section-title">双方记录</div>
      ${renderDirectionBubble(focus, other, outgoing, 'left')}
      ${renderDirectionBubble(other, focus, incoming, 'right')}
      ${singleDirection ? '<div class="phone-relationship-one-way">当前仅记录到单向关系</div>' : ''}
    </section>
  `;
}

function renderPairList(graph: PhoneRelationshipGraph, selectedPairKey: string | null): string {
  if (!graph.pairs.length) return '<div class="phone-relationship-list-empty">当前筛选下没有可显示的关系。</div>';
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  return `
    <section class="phone-relationship-list" aria-label="完整关系列表">
      <div class="phone-relationship-section-title">全部关系 · ${graph.pairs.length}</div>
      ${graph.pairs.map(pair => {
        const a = nodesById.get(pair.aId);
        const b = nodesById.get(pair.bId);
        if (!a || !b) return '';
        const labels = [...new Set(pair.records.map(record => record.label))].slice(0, 2).join(' · ');
        return `
          <button
            type="button"
            class="phone-relationship-list-row phone-relationship-list-row--${pair.tone} ${pair.key === selectedPairKey ? 'is-active' : ''}"
            data-action="relationship-select-pair"
            data-relationship-pair-key="${escapeHtml(pair.key)}"
          >
            <span class="phone-relationship-list-row__people">
              ${renderPhoneAvatar(nodeAvatarData(a), 'phone-relationship-list-avatar')}
              <span aria-hidden="true">↔</span>
              ${renderPhoneAvatar(nodeAvatarData(b), 'phone-relationship-list-avatar')}
            </span>
            <span class="phone-relationship-list-row__copy">
              <strong>${escapeHtml(a.name)} · ${escapeHtml(b.name)}</strong>
              <small>${escapeHtml(labels)}</small>
            </span>
          </button>
        `;
      }).join('')}
    </section>
  `;
}

export function getPhoneRelationshipPairCount(state: AppState): number {
  return collectGraph(state, false, 'all').pairs.length;
}

export function renderPhoneRelationships(state: AppState, headerHtml: string): string {
  syncViewState(state);
  const graph = collectGraph(state, viewState.showPlayer, viewState.layer);
  const focusId = chooseFocusId(state, graph);
  viewState.focusId = focusId;
  const focus = graph.nodes.find(node => node.id === focusId) ?? null;
  const focusPairs = focus ? graph.pairs.filter(pair => pair.aId === focus.id || pair.bId === focus.id) : [];
  if (!viewState.selectedPairKey || !focusPairs.some(pair => pair.key === viewState.selectedPairKey)) {
    viewState.selectedPairKey = focusPairs[0]?.key ?? null;
  }
  const selectedPair = graph.pairs.find(pair => pair.key === viewState.selectedPairKey) ?? null;

  const layerOptions: Array<{ value: PhoneRelationshipLayer; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'current', label: '当前' },
    { value: 'original', label: '原作' },
  ];

  return `
    <section class="phone-route-page phone-app-page phone-app-page--relationships" data-phone-route-view="app:relationships">
      ${headerHtml}
      <div class="phone-page-scroll phone-relationship-scroll">
        <div class="phone-relationship-controls">
          <div class="phone-relationship-segments" aria-label="关系来源筛选">
            ${layerOptions.map(option => `
              <button
                type="button"
                class="${viewState.layer === option.value ? 'is-active' : ''}"
                data-action="relationship-layer"
                data-relationship-layer="${option.value}"
                aria-pressed="${viewState.layer === option.value}"
              >${option.label}</button>
            `).join('')}
          </div>
          <button
            type="button"
            class="phone-relationship-player-toggle ${viewState.showPlayer ? 'is-active' : ''}"
            data-action="relationship-toggle-player"
            aria-pressed="${viewState.showPlayer}"
          >显示玩家</button>
        </div>

        <div class="phone-relationship-contact-strip" aria-label="选择焦点角色">
          ${graph.nodes.map(node => `
            <button
              type="button"
              class="${node.id === focusId ? 'is-active' : ''}"
              data-action="relationship-focus"
              data-relationship-node-id="${escapeHtml(node.id)}"
              aria-pressed="${node.id === focusId}"
              title="${escapeHtml(node.name)}"
            >
              ${renderPhoneAvatar(nodeAvatarData(node), 'phone-relationship-strip-avatar')}
              <span>${escapeHtml(node.name)}</span>
            </button>
          `).join('')}
        </div>

        <div class="phone-relationship-legend" aria-label="关系颜色图例">
          <span><i class="is-positive"></i>亲近</span>
          <span><i class="is-mixed"></i>复杂</span>
          <span><i class="is-negative"></i>紧张</span>
          <span><i class="is-neutral"></i>中性</span>
        </div>

        ${focus
          ? renderFocusGraph(graph, focus, focusPairs)
          : '<div class="phone-relationship-empty">当前存档没有可显示的角色词条。</div>'}
        ${focus ? renderPairDetails(selectedPair, graph, focus.id) : ''}
        ${renderPairList(graph, viewState.selectedPairKey)}
      </div>
    </section>
  `;
}

export function bindPhoneRelationshipEvents(
  root: ParentNode | null | undefined,
  rerender: () => void,
): void {
  root?.querySelectorAll<HTMLButtonElement>('[data-action="relationship-focus"]').forEach(button => {
    button.addEventListener('click', () => {
      const nodeId = button.dataset.relationshipNodeId;
      if (!nodeId) return;
      viewState.focusId = nodeId;
      viewState.selectedPairKey = null;
      rerender();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="relationship-select-pair"]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.relationshipPairKey;
      if (!key) return;
      viewState.selectedPairKey = key;
      const ids = key.split('|').map(value => decodeURIComponent(value));
      if (viewState.focusId && !ids.includes(viewState.focusId)) viewState.focusId = ids[0] ?? null;
      rerender();
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="relationship-layer"]').forEach(button => {
    button.addEventListener('click', () => {
      const layer = button.dataset.relationshipLayer;
      if (layer !== 'all' && layer !== 'current' && layer !== 'original') return;
      viewState.layer = layer;
      viewState.selectedPairKey = null;
      rerender();
    });
  });
  root?.querySelector<HTMLButtonElement>('[data-action="relationship-toggle-player"]')?.addEventListener('click', () => {
    viewState.showPlayer = !viewState.showPlayer;
    if (!viewState.showPlayer && viewState.focusId === PLAYER_NODE_ID) viewState.focusId = null;
    viewState.selectedPairKey = null;
    rerender();
  });
}
