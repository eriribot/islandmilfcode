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
};

export function createDefaultMemoryEditorState(): MemoryEditorState {
  return {
    selectedTable: 'facts',
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

function previewRow(table: MemoryTableName, row: MemoryBaseRow): string {
  const r = row as unknown as Record<string, unknown>;
  switch (table) {
    case 'entities':
      return `${String(r.kind ?? '?')} · ${String(r.name ?? r.entityId ?? '')}`;
    case 'events':
      return `${String(r.title ?? '')} — ${String(r.description ?? '').slice(0, 40)}`;
    case 'facts':
      return `[${String(r.category ?? '')}] ${String(r.subject ?? '')}: ${String(r.content ?? '').slice(0, 60)}`;
    case 'relations':
      return `${String(r.fromId ?? '')} → ${String(r.toId ?? '')} (${String(r.label ?? '')})`;
    case 'impressions':
      return `${String(r.targetId ?? '')} 对 ${String(r.subject ?? '')}: ${String(r.label ?? '')}`;
    case 'tasks':
      return `[${String(r.status ?? '')}] ${String(r.content ?? '').slice(0, 60)}`;
    case 'secrets':
      return `${String(r.subject ?? '')} (${String(r.risk ?? '')}/${r.revealed ? '已暴露' : '未暴露'})`;
    case 'items':
      return `${String(r.action ?? 'noted')} · ${String(r.name ?? '')} ${r.count !== undefined ? `×${r.count}` : ''}`;
    case 'phoneMessages':
      return `[${String(r.role ?? '')}] ${String(r.targetId ?? '')}: ${String(r.textPreview ?? '').slice(0, 50)}`;
    case 'summaries': {
      const range = Array.isArray(r.range) ? `[${(r.range as number[]).join(',')}]` : '';
      return `${String(r.level ?? '')} ${range} ${String(r.text ?? '').slice(0, 50)}`;
    }
    case 'attributes':
      return `${String(r.targetId ?? '')}.${String(r.key ?? '')} = ${String(r.value ?? '')}`;
    default:
      return String(r.id ?? '');
  }
}

function renderTableTabs(db: IslandMemoryDB, editor: MemoryEditorState): string {
  return MEMORY_TABLE_NAMES.map(name => {
    const counts = getTableCounts(db, name);
    const active = name === editor.selectedTable;
    return `
      <button
        class="memory-tab ${active ? 'is-active' : ''}"
        data-action="memory-select-table"
        data-table="${name}"
      >
        <strong>${escapeHtml(TABLE_LABELS[name])}</strong>
        <span>${counts.active}${counts.expired ? ` · ${counts.expired} 已删` : ''}</span>
      </button>
    `;
  }).join('');
}

function renderRowDetail(table: MemoryTableName, row: MemoryBaseRow, editor: MemoryEditorState): string {
  const isEditing = editor.editingRowId === row.id;
  const json = JSON.stringify(row, null, 2);

  if (isEditing) {
    return `
      <div class="memory-row-detail memory-row-detail--editing">
        <textarea class="memory-edit-textarea" data-field="memory-edit-draft" rows="14">${escapeHtml(editor.editingDraft)}</textarea>
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
      <pre class="memory-row-json">${escapeHtml(json)}</pre>
      <div class="memory-row-actions">
        <button class="memory-action" data-action="memory-edit-row" data-table="${table}" data-row-id="${escapeHtml(row.id)}">编辑</button>
        ${
          row.expired
            ? `<button class="memory-action" data-action="memory-restore-row" data-table="${table}" data-row-id="${escapeHtml(row.id)}">恢复</button>`
            : `<button class="memory-action memory-action--danger" data-action="memory-expire-row" data-table="${table}" data-row-id="${escapeHtml(row.id)}">软删除</button>`
        }
      </div>
    </div>
  `;
}

function renderRowList(db: IslandMemoryDB, editor: MemoryEditorState): string {
  const table = editor.selectedTable;
  const rows = getTable(db, table);
  const visible = editor.showExpired ? rows : rows.filter(row => !row.expired);

  if (!visible.length) {
    return `<div class="memory-empty">${editor.showExpired ? '该表为空。' : '该表没有活跃行。'}</div>`;
  }

  const sorted = [...visible].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  return sorted
    .map(row => {
      const expanded = editor.expandedRowId === row.id || editor.editingRowId === row.id;
      const sourceLabel = row.source ?? 'unknown';
      const stamp = (row.createdAt ?? '').slice(0, 19).replace('T', ' ');
      return `
        <article class="memory-row ${row.expired ? 'is-expired' : ''}">
          <button class="memory-row-summary" data-action="memory-toggle-row" data-row-id="${escapeHtml(row.id)}">
            <span class="memory-row-preview">${escapeHtml(previewRow(table, row))}</span>
            <span class="memory-row-meta">
              <small>${escapeHtml(sourceLabel)} · ${escapeHtml(stamp)}</small>
              ${row.expired ? '<em class="memory-row-flag">已删</em>' : ''}
            </span>
          </button>
          ${expanded ? renderRowDetail(table, row, editor) : ''}
        </article>
      `;
    })
    .join('');
}

function renderCreateForm(editor: MemoryEditorState): string {
  if (!editor.creating) {
    return `
      <div class="memory-create-bar">
        <button class="memory-action memory-action--primary" data-action="memory-new-row">新增行</button>
        <button class="memory-action" data-action="memory-toggle-expired">${editor.showExpired ? '隐藏已删' : '显示已删'}</button>
      </div>
    `;
  }

  return `
    <div class="memory-create-form">
      <div class="memory-create-title">新增 ${escapeHtml(TABLE_LABELS[editor.selectedTable])} 行（JSON，无需写 id/createdAt/source）</div>
      <textarea class="memory-edit-textarea" data-field="memory-new-draft" rows="10">${escapeHtml(editor.creatingDraft)}</textarea>
      ${editor.error ? `<div class="memory-error">${escapeHtml(editor.error)}</div>` : ''}
      <div class="memory-row-actions">
        <button class="memory-action memory-action--primary" data-action="memory-save-new" data-table="${editor.selectedTable}">保存</button>
        <button class="memory-action" data-action="memory-cancel-new">取消</button>
      </div>
    </div>
  `;
}

export function renderMemoryEditor(state: AppState): string {
  const db = state.memoryDB;
  const editor = state.memoryEditor;

  return `
    <div class="memory-editor">
      <div class="memory-editor-meta">
        <span>runId: <code>${escapeHtml(db.runId || '(未绑定)')}</code></span>
        <span>cursor: ${db.lastProcessedIndex}</span>
        <span>schema v${db.version}</span>
      </div>
      <nav class="memory-tabs" aria-label="记忆表">
        ${renderTableTabs(db, editor)}
      </nav>
      ${renderCreateForm(editor)}
      <div class="memory-row-list">
        ${renderRowList(db, editor)}
      </div>
    </div>
  `;
}
