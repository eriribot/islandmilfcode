import { listSaves } from '../state/saves';
import type { SaveSlot } from '../types';

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSaveSlot(save: SaveSlot, index: number) {
  const date = new Date(save.updatedAt);
  const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const msgCount = save.messages.length;

  return `
    <div class="gal-save-slot" data-save-index="${index}">
      <button class="gal-save-load" data-action="load-save" data-save-id="${escapeHtml(save.id)}">
        <span class="gal-save-name">${escapeHtml(save.characterName)}</span>
        <span class="gal-save-detail">${escapeHtml(save.personality)}</span>
        <span class="gal-save-meta">${dateStr} ${timeStr} · ${msgCount} 条记录</span>
      </button>
      <button class="gal-save-delete" data-action="delete-save" data-save-id="${escapeHtml(save.id)}" title="删除存档">✕</button>
    </div>
  `;
}

export function renderTitleHome() {
  const saves = listSaves();
  const saveSlots = saves.map((s, i) => renderSaveSlot(s, i)).join('');

  return `
    <div class="gal-title">
      <div class="gal-title__particles" aria-hidden="true">
        <span class="gal-particle gal-particle--1"></span>
        <span class="gal-particle gal-particle--2"></span>
        <span class="gal-particle gal-particle--3"></span>
        <span class="gal-particle gal-particle--4"></span>
        <span class="gal-particle gal-particle--5"></span>
      </div>

      <div class="gal-title__content">
        <header class="gal-title__header">
          <p class="gal-title__ornament">✦ ─────── ✦</p>
          <h1 class="gal-title__name">维纳斯小岛的假期</h1>
          <p class="gal-title__sub">Venus Island Vacation</p>
        </header>

        <div class="gal-info-cards">
          <div class="gal-info-card">
            <span class="gal-info-card__icon">🎁</span>
            <strong>本卡完全免费</strong>
            <p>永久免费开放<br/>禁止二次倒卖</p>
          </div>
          <div class="gal-info-card">
            <span class="gal-info-card__icon">🔗</span>
            <strong>更新地址</strong>
            <p>Discord<br/>新类脑 · 旅程</p>
          </div>
          <div class="gal-info-card">
            <span class="gal-info-card__icon">🏖️</span>
            <strong>本卡类型</strong>
            <p>SillyTavern<br/>私人家庭档案</p>
          </div>
        </div>

        <div class="gal-title__actions">
          <button class="gal-btn gal-btn--primary" data-action="new-game">
            新建角色 →
          </button>
        </div>

        ${
          saves.length
            ? `
          <div class="gal-saves-section">
            <p class="gal-saves-label">── 存档列表 ──</p>
            <div class="gal-saves-list">
              ${saveSlots}
            </div>
          </div>
        `
            : ''
        }

        <p class="gal-title__footer">Venus Island · Private Archive</p>
      </div>
    </div>
  `;
}

export function renderCharacterCreation() {
  return `
    <div class="gal-title">
      <div class="gal-title__particles" aria-hidden="true">
        <span class="gal-particle gal-particle--1"></span>
        <span class="gal-particle gal-particle--2"></span>
        <span class="gal-particle gal-particle--3"></span>
      </div>

      <div class="gal-title__content">
        <header class="gal-title__header">
          <p class="gal-title__ornament">✦ ─────── ✦</p>
          <h1 class="gal-title__name" style="font-size:1.6rem">创建角色</h1>
          <p class="gal-title__sub">Character Creation</p>
        </header>

        <form class="gal-create-form" data-action="create-form">
          <div class="gal-field">
            <label class="gal-field__label" for="gal-char-name">角色名</label>
            <input class="gal-field__input" id="gal-char-name" name="characterName"
              type="text" placeholder="输入你的角色名称" required autocomplete="off" />
          </div>

          <div class="gal-field">
            <label class="gal-field__label" for="gal-char-personality">性格</label>
            <textarea class="gal-field__textarea" id="gal-char-personality" name="personality"
              placeholder="描述角色的性格特征…" rows="3"></textarea>
          </div>

          <div class="gal-field">
            <label class="gal-field__label" for="gal-char-appearance">
              相貌 <span class="gal-field__hint">（锁定男主）</span>
            </label>
            <textarea class="gal-field__textarea" id="gal-char-appearance" name="appearance"
              placeholder="描述角色的外貌特征…" rows="3"></textarea>
          </div>

          <div class="gal-create-actions">
            <button type="button" class="gal-btn gal-btn--ghost" data-action="back-to-title">
              ← 返回
            </button>
            <button type="submit" class="gal-btn gal-btn--primary">
              确认创建 →
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}
