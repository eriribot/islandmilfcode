import { listSaves } from '../state/saves';
import type { SaveMeta } from '../types';

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSaveTime(updatedAt: number) {
  const date = new Date(updatedAt);
  const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${dateStr} ${timeStr}`;
}

function renderSaveSlot(save: SaveMeta, index: number) {
  const kindLabel = save.kind === 'autosave' ? '自动存档' : '手动存档';
  const playerName = save.playerProfile?.name?.trim() || save.characterName?.trim() || '未命名主角';
  const target = save.activeTarget;
  const targetName = target?.alias || target?.name || '未知攻略对象';
  const targetDetail = target
    ? [`攻略对象：${targetName}`, target.stage, `好感 ${target.affinity}`].filter(Boolean).join(' · ')
    : '攻略对象：未知';
  const detail = save.preview?.trim() || save.location || save.label;

  return `
    <article class="gal-save-slot" data-save-index="${index}" data-run-id="${escapeHtml(save.runId)}">
      <button class="gal-save-load" data-action="load-save" data-save-id="${escapeHtml(save.saveId)}">
        <span class="gal-save-slot__topline">
          <span class="gal-save-name">${escapeHtml(playerName)}</span>
          <span class="gal-save-kind">${escapeHtml(kindLabel)}</span>
        </span>
        <span class="gal-save-detail">${escapeHtml(targetDetail)}</span>
        <span class="gal-save-detail">${escapeHtml(detail)}</span>
        <span class="gal-save-meta">${formatSaveTime(save.updatedAt)} · ${save.messageCount} 条记录</span>
      </button>
      <button class="gal-save-delete" data-action="delete-save" data-save-id="${escapeHtml(save.saveId)}" title="删除存档">×</button>
    </article>
  `;
}

export function renderLoadSaveModal() {
  const saves = listSaves();
  const saveSlots = saves.map((save, index) => renderSaveSlot(save, index)).join('');

  return `
    <div class="gal-loadsave" role="dialog" aria-modal="true" aria-labelledby="gal-loadsave-title">
      <button class="gal-loadsave__backdrop" data-action="hide-saves" type="button" aria-label="关闭读档窗口"></button>
      <section class="gal-loadsave__panel">
        <header class="gal-loadsave__header">
          <div>
            <p class="gal-loadsave__eyebrow">Load Game</p>
            <h2 id="gal-loadsave-title">读取存档</h2>
          </div>
          <button class="gal-loadsave__close" data-action="hide-saves" type="button" aria-label="关闭">×</button>
        </header>

        ${
          saves.length
            ? `
          <div class="gal-loadsave__list">
            ${saveSlots}
          </div>
        `
            : '<p class="gal-loadsave__empty">暂无可读取的存档</p>'
        }
      </section>
    </div>
  `;
}
