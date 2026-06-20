import { escapeHtml } from '../html';
import type { AppState, MemoryEditorState } from '../types';
import { commitBatch } from './upsert';
import type { IslandMemoryDB, MemoryBaseRow, MemoryWriteBatch } from './types';

export const MEMORY_TABLE_NAMES = [
  'entities',
  'events',
  'facts',
  'relations',
  'impressions',
  'tasks',
  'secrets',
  'items',
  'phoneMessages',
  'summaries',
  'attributes',
  'worldState',
] as const;

export type MemoryTableName = (typeof MEMORY_TABLE_NAMES)[number];

const TABLE_LABELS: Record<MemoryTableName, string> = {
  entities: '实体',
  events: '事件',
  facts: '事实',
  relations: '关系',
  impressions: '印象',
  tasks: '任务',
  secrets: '秘密',
  items: '物品',
  phoneMessages: '手机消息',
  summaries: '摘要',
  attributes: '属性',
  worldState: '世界状态',
};

const EDITABLE_TABLES = new Set<MemoryTableName>([
  'events',
  'facts',
  'tasks',
  'secrets',
  'items',
  'phoneMessages',
  'summaries',
]);

const USER_VISIBLE_TABLES: MemoryTableName[] = [
  'tasks',
  'items',
  'phoneMessages',
  'summaries',
];

// 中文注释：这些是 AI 在 <key_facts> 里允许输出的全部分类，对应 summary/types.ts 的 KeyFactCategory。
// 即使本存档当前没有对应行，首页也作为 placeholder chip 常驻渲染，跟 USER_VISIBLE_TABLES 的硬编码行为对齐。
const CANONICAL_FACT_CATEGORIES = [
  'event',
  'profile',
  'relation',
  'secret',
  'item',
  'location',
  'promise',
] as const;

type FactCategory = string;

const FACT_CATEGORY_ORDER: FactCategory[] = [
  'event',
  'profile',
  'trait',
  'state',
  'preference',
  'relationship',
  'relation',
  'knowledge',
  'opinion',
  'background',
  'ability',
  'habit',
  'goal',
  'promise',
  'secret',
  'memory',
  'emotion',
  'item',
  'location',
  'custom',
];

type HomeEntry =
  | { kind: 'table'; table: MemoryTableName; label: string; count: number }
  | { kind: 'category'; category: FactCategory; label: string; count: number };

function buildHomeEntries(db: IslandMemoryDB): HomeEntry[] {
  const facts = getTable(db, 'facts').filter(r => !r.expired);
  const catCounts = new Map<string, number>();
  for (const row of facts) {
    const cat = String((row as unknown as Record<string, unknown>).category ?? '');
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }

  const entries: HomeEntry[] = [];

  // 第一段：CANONICAL_FACT_CATEGORIES 常驻 chip（即使 0 条），跟 table tile 的硬编码占位一致。
  for (const cat of CANONICAL_FACT_CATEGORIES) {
    entries.push({
      kind: 'category',
      category: cat,
      label: getHomeCategoryLabel(cat),
      count: catCounts.get(cat) ?? 0,
    });
  }

  // 第二段：数据里出现了但不在 canonical 列表里的分类（custom 或未来扩展），按 FACT_CATEGORY_ORDER 排。
  const canonicalSet = new Set<string>(CANONICAL_FACT_CATEGORIES);
  const extras = [...catCounts.keys()]
    .filter(cat => !canonicalSet.has(cat))
    .sort((a, b) => {
      const ia = FACT_CATEGORY_ORDER.indexOf(a);
      const ib = FACT_CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  for (const cat of extras) {
    entries.push({
      kind: 'category',
      category: cat,
      label: getHomeCategoryLabel(cat),
      count: catCounts.get(cat) ?? 0,
    });
  }

  for (const table of USER_VISIBLE_TABLES) {
    const count = getTable(db, table).filter(r => !r.expired).length;
    entries.push({ kind: 'table', table, label: TABLE_LABELS[table], count });
  }

  return entries;
}

export function createDefaultMemoryEditorState(): MemoryEditorState {
  return {
    selectedTable: null,
    selectedCategory: null,
    expandedRowId: null,
    editingRowId: null,
    editingDraft: '',
    creating: false,
    creatingDraft: '',
    showExpired: false,
    error: null,
  };
}

function getTable(db: IslandMemoryDB, table: MemoryTableName): MemoryBaseRow[] {
  const value = (db as unknown as Record<string, unknown>)[table];
  return Array.isArray(value) ? (value as MemoryBaseRow[]) : [];
}

function findRow(db: IslandMemoryDB, table: MemoryTableName, id: string): MemoryBaseRow | null {
  return getTable(db, table).find(row => row.id === id) ?? null;
}

const PROTECTED_KEYS = new Set(['id', 'createdAt']);

export function createMemoryDraft(table: MemoryTableName, row: MemoryBaseRow): string {
  const r = row as unknown as Record<string, unknown>;
  switch (table) {
    case 'facts':
      return String(r.content ?? '');
    case 'events':
      return String(r.description ?? r.title ?? '');
    case 'tasks':
      return String(r.content ?? '');
    case 'secrets':
      return String(r.content ?? '');
    case 'items':
      return String(r.state ?? r.name ?? '');
    case 'phoneMessages':
      return String(r.textPreview ?? '');
    case 'summaries':
      return String(r.text ?? '');
    default:
      return '';
  }
}

export function createMemoryPatchFromDraft(table: MemoryTableName, draft: string): Record<string, unknown> {
  const value = draft.trim();
  if (!value) throw new Error('内容不能为空');

  switch (table) {
    case 'facts':
      return { content: value };
    case 'events':
      return { title: value.slice(0, 28) || 'User 事件', description: value };
    case 'tasks':
      return { content: value };
    case 'secrets':
      return { content: value };
    case 'items':
      return { state: value };
    case 'phoneMessages':
      return { textPreview: value.slice(0, 200) };
    case 'summaries':
      return { text: value };
    default:
      throw new Error('该表是系统索引，只能查看，不能手动编辑。');
  }
}

export function createUserEventMemoryPayload(draft: string): Record<string, unknown> {
  const content = draft.trim();
  if (!content) throw new Error('事件内容不能为空');
  return {
    category: 'event',
    subject: 'User',
    content,
    importance: 3,
    confidence: 'high',
  };
}

export function updateMemoryRow(
  db: IslandMemoryDB,
  table: MemoryTableName,
  id: string,
  patch: Record<string, unknown>,
): boolean {
  const row = findRow(db, table, id);
  if (!row) return false;

  for (const [key, value] of Object.entries(patch)) {
    if (PROTECTED_KEYS.has(key)) continue;
    (row as Record<string, unknown>)[key] = value;
  }
  row.updatedAt = new Date().toISOString();
  return true;
}

export function expireMemoryRow(db: IslandMemoryDB, table: MemoryTableName, id: string): boolean {
  const row = findRow(db, table, id);
  if (!row) return false;
  if (table === 'items' && (row as unknown as { locked?: boolean }).locked) return false;
  row.expired = true;
  row.updatedAt = new Date().toISOString();
  return true;
}

export function restoreMemoryRow(db: IslandMemoryDB, table: MemoryTableName, id: string): boolean {
  const row = findRow(db, table, id);
  if (!row) return false;
  row.expired = false;
  row.updatedAt = new Date().toISOString();
  return true;
}

export function deleteMemoryRow(db: IslandMemoryDB, table: MemoryTableName, id: string): boolean {
  const rows = getTable(db, table);
  const index = rows.findIndex(row => row.id === id);
  if (index < 0) return false;
  rows.splice(index, 1);
  return true;
}

function getTrashTables(): MemoryTableName[] {
  return ['facts', ...USER_VISIBLE_TABLES];
}

export function deleteAllExpiredMemoryRows(db: IslandMemoryDB): number {
  let deleted = 0;
  for (const table of getTrashTables()) {
    const rows = getTable(db, table);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].expired) continue;
      rows.splice(i, 1);
      deleted += 1;
    }
  }
  return deleted;
}

export function expireAllUnlockedItems(db: IslandMemoryDB): number {
  const now = new Date().toISOString();
  let expired = 0;
  for (const row of db.items) {
    if (row.expired || row.locked) continue;
    row.expired = true;
    row.updatedAt = now;
    expired += 1;
  }
  return expired;
}

export function insertMemoryRow(
  db: IslandMemoryDB,
  table: MemoryTableName,
  payload: Record<string, unknown>,
): string | null {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (PROTECTED_KEYS.has(key)) continue;
    if (key === 'source' || key === 'updatedAt') continue;
    sanitized[key] = value;
  }

  const batch: MemoryWriteBatch = {
    source: 'manual',
    inserts: { [table]: [sanitized] } as MemoryWriteBatch['inserts'],
  };
  const ids = commitBatch(db, batch);
  return ids[0] ?? null;
}

function getTableCounts(db: IslandMemoryDB, table: MemoryTableName) {
  const rows = getTable(db, table);
  let active = 0;
  let expired = 0;
  for (const row of rows) {
    if (row.expired) expired += 1;
    else active += 1;
  }
  return { active, expired, total: rows.length };
}

const SOURCE_LABELS: Record<string, string> = {
  manual: '手动',
  system: '系统',
  progress: '剧情',
  'progress-commit': '剧情',
  summary: '摘要',
  'summary-minor': '小摘要',
  'summary-major': '大摘要',
  'summary-global': '全局摘要',
  'phone-directive': '手机',
  'phone-scene-extract': '手机',
  migration: '迁移',
  unknown: '自动',
};

const CATEGORY_LABELS: Record<string, string> = {
  event: '事件',
  profile: '档案',
  trait: '特征',
  preference: '偏好',
  relationship: '关系',
  relation: '关系',
  knowledge: '知识',
  state: '状态',
  opinion: '观点',
  background: '背景',
  ability: '能力',
  habit: '习惯',
  goal: '目标',
  secret: '秘密',
  memory: '记忆',
  emotion: '情感',
  promise: '承诺',
  item: '物品',
  location: '地点',
  custom: '自定义',
};

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '待办',
  done: '已完成',
  expired: '已过期',
  archived: '已归档',
};

const SECRET_RISK_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

const SUMMARY_LEVEL_LABELS: Record<string, string> = {
  minor: '小摘要',
  major: '大摘要',
  global: '全局摘要',
};

const ITEM_ACTION_LABELS: Record<string, string> = {
  gained: '获得',
  lost: '失去',
  transformed: '变化',
  noted: '记录',
};

const ROLE_LABELS: Record<string, string> = {
  user: '我',
  assistant: '对方',
};

function localizeSource(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function localizeCategory(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

function getHomeCategoryLabel(category: string): string {
  if (category === 'item') return '物品事实';
  return localizeCategory(category) || category;
}

function localizeTaskStatus(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

function localizeSecretRisk(risk: string): string {
  return SECRET_RISK_LABELS[risk] ?? risk;
}

function localizeSummaryLevel(level: string): string {
  return SUMMARY_LEVEL_LABELS[level] ?? level;
}

function localizeItemAction(action: string): string {
  return ITEM_ACTION_LABELS[action] ?? action;
}

function localizeRole(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function previewRow(table: MemoryTableName, row: MemoryBaseRow): string {
  const r = row as unknown as Record<string, unknown>;
  switch (table) {
    case 'entities':
      return `${String(r.kind ?? '?')} · ${String(r.name ?? r.entityId ?? '')}`;
    case 'events':
      return `${String(r.title ?? '事件')} · ${String(r.description ?? '').slice(0, 42)}`;
    case 'facts':
      return `${String(r.subject ?? '')}: ${String(r.content ?? '').slice(0, 72)}`;
    case 'relations':
      return `${String(r.fromId ?? '')} → ${String(r.toId ?? '')} (${String(r.label ?? '')})`;
    case 'impressions':
      return `${String(r.targetId ?? '')} 对 ${String(r.subject ?? '')}: ${String(r.label ?? '')}`;
    case 'tasks':
      return `[${localizeTaskStatus(String(r.status ?? ''))}] ${String(r.content ?? '').slice(0, 64)}`;
    case 'secrets':
      return `${String(r.subject ?? '')} (${localizeSecretRisk(String(r.risk ?? ''))}/${r.revealed ? '已暴露' : '未暴露'})`;
    case 'items':
      return `${r.locked ? '[锁定] ' : ''}${String(r.name ?? '')} ${r.count !== undefined ? `×${r.count}` : ''}`;
    case 'phoneMessages':
      return `${String(r.targetId ?? '')}: ${String(r.textPreview ?? '').slice(0, 54)}`;
    case 'summaries': {
      const range = Array.isArray(r.range) ? `[${(r.range as number[]).join(',')}]` : '';
      return `${localizeSummaryLevel(String(r.level ?? ''))} ${range} ${String(r.text ?? '').slice(0, 54)}`;
    }
    case 'attributes':
      return `${String(r.targetId ?? '')}.${String(r.key ?? '')} = ${String(r.value ?? '')}`;
    default:
      return String(r.id ?? '');
  }
}

function renderReadableFields(table: MemoryTableName, row: MemoryBaseRow): string {
  const r = row as unknown as Record<string, unknown>;
  const fields: Array<[string, string]> = [];
  const gameTime = String(r.gameTime ?? '').trim();

  switch (table) {
    case 'entities':
      fields.push(['名称', String(r.name ?? '')], ['类型', String(r.kind ?? '')]);
      break;
    case 'events':
      fields.push(['时间', gameTime], ['标题', String(r.title ?? '')], ['事件', String(r.description ?? '')]);
      break;
    case 'facts':
      fields.push(['时间', gameTime], ['对象', String(r.subject ?? '')], ['类型', localizeCategory(String(r.category ?? ''))], ['内容', String(r.content ?? '')]);
      break;
    case 'relations':
      fields.push(['来源', String(r.fromId ?? '')], ['对象', String(r.toId ?? '')], ['关系', String(r.label ?? '')]);
      break;
    case 'impressions':
      fields.push(['角色', String(r.targetId ?? '')], ['对象', String(r.subject ?? '')], ['印象', String(r.label ?? '')]);
      break;
    case 'tasks':
      fields.push(['时间', gameTime], ['状态', localizeTaskStatus(String(r.status ?? ''))], ['事项', String(r.content ?? '')]);
      break;
    case 'secrets':
      fields.push(['时间', gameTime], ['主题', String(r.subject ?? '')], ['秘密', String(r.content ?? '')], ['风险', localizeSecretRisk(String(r.risk ?? ''))]);
      break;
    case 'items':
      fields.push(
        ['时间', gameTime],
        ['物品', String(r.name ?? '')],
        ['状态', String(r.state ?? '')],
        ['动作', localizeItemAction(String(r.action ?? ''))],
        ['锁定', r.locked ? '是' : '否'],
        ['特殊含义', r.promptRelevant ? '会注入 prompt' : '不注入 prompt'],
      );
      break;
    case 'phoneMessages':
      fields.push(['对象', String(r.targetId ?? '')], ['角色', localizeRole(String(r.role ?? ''))], ['消息', String(r.textPreview ?? '')]);
      break;
    case 'summaries':
      fields.push(['层级', localizeSummaryLevel(String(r.level ?? ''))], ['摘要', String(r.text ?? '')]);
      break;
    case 'attributes':
      fields.push(['对象', String(r.targetId ?? '')], ['属性', String(r.key ?? '')], ['值', String(r.value ?? '')]);
      break;
    default:
      break;
  }

  const rendered = fields
    .filter(([, value]) => value.trim())
    .map(
      ([label, value]) => `
        <div class="memory-field">
          <span>${escapeHtml(label)}</span>
          <p>${escapeHtml(value)}</p>
        </div>
      `,
    )
    .join('');

  return rendered || '<div class="memory-field"><span>内容</span><p>暂无可读内容</p></div>';
}

function renderRowDetail(table: MemoryTableName, row: MemoryBaseRow, editor: MemoryEditorState): string {
  const isEditing = editor.editingRowId === row.id;
  const r = row as unknown as Record<string, unknown>;

  if (isEditing) {
    return `
      <div class="memory-row-detail memory-row-detail--editing">
        <label class="memory-form-field">
          <span>内容</span>
          <textarea class="memory-edit-textarea" data-field="memory-edit-draft" rows="6">${escapeHtml(editor.editingDraft)}</textarea>
        </label>
        ${editor.error ? `<div class="memory-error">${escapeHtml(editor.error)}</div>` : ''}
        <div class="memory-row-actions">
          <button class="memory-action memory-action--primary" data-action="memory-save-edit" data-table="${table}" data-row-id="${escapeHtml(row.id)}">保存</button>
          <button class="memory-action" data-action="memory-cancel-edit">取消</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="memory-row-detail">
      <div class="memory-fields">
        ${renderReadableFields(table, row)}
      </div>
      <div class="memory-row-actions">
        ${
          EDITABLE_TABLES.has(table)
            ? `<button class="memory-action" data-action="memory-edit-row" data-table="${table}" data-row-id="${escapeHtml(row.id)}">编辑内容</button>`
            : ''
        }
        ${
          table === 'items'
            ? `
              <button class="memory-action" data-action="memory-toggle-item-lock" data-row-id="${escapeHtml(row.id)}">${r.locked ? '取消锁定' : '锁定物品'}</button>
              <button class="memory-action" data-action="memory-toggle-item-prompt" data-row-id="${escapeHtml(row.id)}">${r.promptRelevant ? '取消特殊含义' : '标记特殊含义'}</button>
            `
            : ''
        }
        ${
          table === 'items' && r.locked
            ? `<button class="memory-action memory-action--danger" disabled>已锁定</button>`
            : `<button class="memory-action memory-action--danger" data-action="memory-expire-row" data-table="${table}" data-row-id="${escapeHtml(row.id)}">删除</button>`
        }
      </div>
    </div>
  `;
}

function renderSingleRow(table: MemoryTableName, row: MemoryBaseRow, editor: MemoryEditorState): string {
  const expanded = editor.expandedRowId === row.id || editor.editingRowId === row.id;
  const sourceLabel = localizeSource(row.source ?? 'unknown');
  const stamp = (row.createdAt ?? '').slice(0, 19).replace('T', ' ');
  return `
    <article class="memory-row">
      <button class="memory-row-summary" data-action="memory-toggle-row" data-row-id="${escapeHtml(row.id)}">
        <span class="memory-row-preview">${escapeHtml(previewRow(table, row))}</span>
        <span class="memory-row-meta">
          <small>${escapeHtml(sourceLabel)} · ${escapeHtml(stamp)}</small>
        </span>
      </button>
      ${expanded ? renderRowDetail(table, row, editor) : ''}
    </article>
  `;
}

function renderRowList(db: IslandMemoryDB, table: MemoryTableName, editor: MemoryEditorState): string {
  const rows = getTable(db, table).filter(row => !row.expired);

  if (!rows.length) {
    return `<div class="memory-empty">暂无记录。</div>`;
  }

  if (table === 'facts') {
    const groups = new Map<string, MemoryBaseRow[]>();
    for (const row of rows) {
      const cat = String((row as unknown as Record<string, unknown>).category ?? '');
      const list = groups.get(cat) ?? [];
      list.push(row);
      groups.set(cat, list);
    }

    const sortedKeys = [...groups.keys()].sort((a, b) => {
      const ia = FACT_CATEGORY_ORDER.indexOf(a);
      const ib = FACT_CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

    return sortedKeys.map(cat => {
      const catRows = groups.get(cat)!.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      const label = localizeCategory(cat) || cat;
      return `
        <div class="memory-group">
          <div class="memory-group-title">${escapeHtml(label)}</div>
          ${catRows.map(row => renderSingleRow(table, row, editor)).join('')}
        </div>
      `;
    }).join('');
  }

  const sorted = [...rows].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return sorted.map(row => renderSingleRow(table, row, editor)).join('');
}

function renderTrashList(db: IslandMemoryDB, editor: MemoryEditorState): string {
  const allExpired: Array<{ table: MemoryTableName; row: MemoryBaseRow }> = [];
  for (const name of getTrashTables()) {
    for (const row of getTable(db, name)) {
      if (row.expired) allExpired.push({ table: name, row });
    }
  }

  if (!allExpired.length) {
    return `<div class="memory-empty">回收站为空。</div>`;
  }

  allExpired.sort((a, b) => (b.row.updatedAt ?? '').localeCompare(a.row.updatedAt ?? ''));

  return allExpired
    .map(({ table, row }) => {
      const expanded = editor.expandedRowId === row.id;
      const stamp = (row.updatedAt ?? row.createdAt ?? '').slice(0, 19).replace('T', ' ');
      return `
        <article class="memory-row is-expired">
          <button class="memory-row-summary" data-action="memory-toggle-row" data-row-id="${escapeHtml(row.id)}">
            <span class="memory-row-preview">${escapeHtml(previewRow(table, row))}</span>
            <span class="memory-row-meta">
              <small>${escapeHtml(TABLE_LABELS[table])} · ${escapeHtml(stamp)}</small>
            </span>
          </button>
          ${expanded ? `
            <div class="memory-row-detail">
              <div class="memory-fields">
                ${renderReadableFields(table, row)}
              </div>
              <div class="memory-row-actions">
                <button class="memory-action memory-action--primary" data-action="memory-restore-row" data-table="${table}" data-row-id="${escapeHtml(row.id)}">恢复</button>
                <button class="memory-action memory-action--danger" data-action="memory-delete-row" data-table="${table}" data-row-id="${escapeHtml(row.id)}">永久删除</button>
              </div>
            </div>
          ` : ''}
        </article>
      `;
    })
    .join('');
}

function renderCreateForm(editor: MemoryEditorState): string {
  if (!editor.creating) {
    return `
      <div class="memory-create-bar">
        <button class="memory-action memory-action--primary" data-action="memory-new-row">记录事件</button>
      </div>
    `;
  }

  return `
    <div class="memory-create-form">
      <div class="memory-create-title">记录事件</div>
      <label class="memory-form-field">
        <span>事件内容</span>
        <textarea class="memory-edit-textarea" data-field="memory-new-draft" rows="6" placeholder="例如：在15分钟内用安艺家剩余的食材做出美味的晚餐，受到加藤惠与英梨梨的认可。">${escapeHtml(editor.creatingDraft)}</textarea>
      </label>
      ${editor.error ? `<div class="memory-error">${escapeHtml(editor.error)}</div>` : ''}
      <div class="memory-row-actions">
        <button class="memory-action memory-action--primary" data-action="memory-save-new">保存</button>
        <button class="memory-action" data-action="memory-cancel-new">取消</button>
      </div>
    </div>
  `;
}

function getTotalExpiredCount(db: IslandMemoryDB): number {
  let count = 0;
  for (const name of getTrashTables()) {
    for (const row of getTable(db, name)) {
      if (row.expired) count += 1;
    }
  }
  return count;
}

function renderMemoryHome(db: IslandMemoryDB): string {
  const trashCount = getTotalExpiredCount(db);
  const entries = buildHomeEntries(db);

  const cards = entries.map(entry => {
    if (entry.kind === 'category') {
      return `
        <button class="memory-home-card" data-action="memory-open-category" data-category="${escapeHtml(entry.category)}">
          <strong>${escapeHtml(entry.label)}</strong>
          <span class="memory-home-card__count">${entry.count} 条</span>
        </button>
      `;
    }
    return `
      <button class="memory-home-card" data-action="memory-open-table" data-table="${entry.table}">
        <strong>${escapeHtml(entry.label)}</strong>
        <span class="memory-home-card__count">${entry.count} 条</span>
      </button>
    `;
  }).join('');

  return `
    <div class="memory-editor">
      <div class="memory-home-grid">
        ${cards}
      </div>
      <button class="memory-trash-entry" data-action="memory-open-trash">
        <span>回收站</span>
        <span>${trashCount} 条已删除</span>
      </button>
    </div>
  `;
}

function renderMemoryTablePage(state: AppState, table: MemoryTableName): string {
  const db = state.memoryDB;
  const editor = state.memoryEditor;
  const unlockedItemCount = table === 'items'
    ? db.items.filter(row => !row.expired && !row.locked).length
    : 0;

  return `
    <div class="memory-editor">
      <div class="memory-sub-header">
        <button class="memory-action" data-action="memory-back-to-home">← 返回</button>
        <strong>${escapeHtml(TABLE_LABELS[table])}</strong>
        ${
          table === 'items' && unlockedItemCount
            ? `<button class="memory-action memory-action--danger" data-action="memory-expire-all-unlocked-items">全部删除未锁定</button>`
            : ''
        }
      </div>
      ${table === 'facts' ? renderCreateForm(editor) : ''}
      <div class="memory-row-list">
        ${renderRowList(db, table, editor)}
      </div>
    </div>
  `;
}

function renderMemoryTrashPage(state: AppState): string {
  const db = state.memoryDB;
  const editor = state.memoryEditor;
  const trashCount = getTotalExpiredCount(db);

  return `
    <div class="memory-editor">
      <div class="memory-sub-header">
        <button class="memory-action" data-action="memory-back-to-home">← 返回</button>
        <strong>回收站</strong>
        ${
          trashCount
            ? `<button class="memory-action memory-action--danger" data-action="memory-delete-all-expired">全部永久删除</button>`
            : ''
        }
      </div>
      <div class="memory-row-list">
        ${renderTrashList(db, editor)}
      </div>
    </div>
  `;
}

function renderMemoryCategoryPage(state: AppState, category: string): string {
  const db = state.memoryDB;
  const editor = state.memoryEditor;
  const rows = getTable(db, 'facts')
    .filter(r => !r.expired && String((r as unknown as Record<string, unknown>).category ?? '') === category);
  const label = localizeCategory(category) || category;
  const showCreate = category === 'event';

  const sorted = [...rows].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const rowsHtml = sorted.length
    ? sorted.map(row => renderSingleRow('facts', row, editor)).join('')
    : `<div class="memory-empty">暂无记录。</div>`;

  return `
    <div class="memory-editor">
      <div class="memory-sub-header">
        <button class="memory-action" data-action="memory-back-to-home">← 返回</button>
        <strong>${escapeHtml(label)}</strong>
      </div>
      ${showCreate ? renderCreateForm(editor) : ''}
      <div class="memory-row-list">
        ${rowsHtml}
      </div>
    </div>
  `;
}

export function renderMemoryEditor(state: AppState): string {
  const editor = state.memoryEditor;

  if (editor.selectedCategory) {
    return renderMemoryCategoryPage(state, editor.selectedCategory);
  }
  if (editor.selectedTable === null) {
    return renderMemoryHome(state.memoryDB);
  }
  if (editor.selectedTable === '__trash') {
    return renderMemoryTrashPage(state);
  }
  return renderMemoryTablePage(state, editor.selectedTable);
}
