import { listSaves } from '../state/saves';
import type { SaveMeta } from '../types';

// Replace this with a direct remote audio URL before publishing the character card.
const TITLE_MUSIC_URL =
  'https://lw-sycdn.kuwo.cn/0c6ffe8f44c1e9f5df3bb367a2e31a91/69eed9b0/resource/30106/trackmedia/M5000019WwgG3MJdsB.mp3?bitrate$128&from=vip';

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTitleMusicControl() {
  const musicUrl = TITLE_MUSIC_URL.trim();
  const stateClass = musicUrl ? '' : ' gal-music-toggle--disabled';
  const hint = musicUrl ? '播放/暂停标题音乐' : '请先在 title/render.ts 填写 TITLE_MUSIC_URL';

  return `
    <button
      type="button"
      class="gal-music-toggle${stateClass}"
      data-action="toggle-title-music"
      data-music-url="${escapeHtml(musicUrl)}"
      aria-label="${escapeHtml(hint)}"
      title="${escapeHtml(hint)}"
      aria-pressed="false"
    >
      <span class="gal-music-toggle__icon" data-music-label aria-hidden="true">♪</span>
    </button>
  `;
}

function renderSakuraField(count = 36) {
  return `
    <div class="gal-sakura-field" aria-hidden="true">
      ${Array.from({ length: count }, (_, i) => {
        const left = (i * 29 + 7) % 104;
        const size = 9 + ((i * 7) % 18);
        const delay = -((i * 1.17) % 15);
        const duration = 13 + ((i * 5) % 12);
        const sway = 32 + ((i * 17) % 96);
        const spin = i % 2 === 0 ? 1 : -1;
        const depth = i % 5 === 0 ? 'near' : i % 3 === 0 ? 'far' : 'mid';
        const blur = depth === 'near' ? 0.2 : depth === 'far' ? 1.2 : 0.55;
        const alpha = depth === 'near' ? 0.9 : depth === 'far' ? 0.48 : 0.68;
        const scale = depth === 'near' ? 1.18 : depth === 'far' ? 0.74 : 1;
        return `
          <span
            class="gal-sakura-petal gal-sakura-petal--${depth}"
            style="--x:${left}vw;--size:${size}px;--delay:${delay.toFixed(2)}s;--duration:${duration}s;--sway:${sway}px;--spin:${spin};--blur:${blur}px;--alpha:${alpha};--scale:${scale};"
          >
            <span></span>
          </span>
        `;
      }).join('')}
    </div>
  `;
}

function renderSaveSlot(save: SaveMeta, index: number) {
  const date = new Date(save.updatedAt);
  const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const msgCount = save.messageCount;
  const kindLabel = save.kind === 'autosave' ? '自动存档' : '手动存档';
  const playerName = save.playerProfile?.name?.trim() || save.characterName?.trim() || '未命名主角';
  const target = save.activeTarget;
  const targetName = target?.alias || target?.name || '未知攻略对象';
  const targetDetail = target
    ? [`攻略对象：${targetName}`, target.stage, `好感 ${target.affinity}`].filter(Boolean).join(' · ')
    : '攻略对象：未知';
  const detail = save.preview?.trim() || save.location || save.label;

  return `
    <div class="gal-save-slot" data-save-index="${index}" data-run-id="${escapeHtml(save.runId)}">
      <button class="gal-save-load" data-action="load-save" data-save-id="${escapeHtml(save.saveId)}">
        <span class="gal-save-name">${escapeHtml(playerName)}</span>
        <span class="gal-save-detail">${escapeHtml(targetDetail)}</span>
        <span class="gal-save-detail">${escapeHtml(detail)}</span>
        <span class="gal-save-meta">${dateStr} ${timeStr} · ${kindLabel} · ${msgCount} 条记录</span>
      </button>
      <button class="gal-save-delete" data-action="delete-save" data-save-id="${escapeHtml(save.saveId)}" title="删除存档">×</button>
    </div>
  `;
}

export function renderTitleHome() {
  const saves = listSaves();
  const saveSlots = saves.map((s, i) => renderSaveSlot(s, i)).join('');

  return `
    <div class="gal-title">
      ${renderSakuraField(42)}
      ${renderTitleMusicControl()}

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
          <h1 class="gal-title__name">冴えない彼女の育てかた</h1>
          <p class="gal-title__sub">Saenai Hiroin no Sodatekata</p>
        </header>

        <div class="gal-info-cards">
          <div class="gal-info-card">
            <span class="gal-info-card__icon">
              <img src="https://box.moegirl.icu/media/Nav_c02.png" alt="礼物" loading="lazy" />
            </span>
            <span class="gal-info-card__text">
              <strong>本卡完全免费</strong>
              <p>永久免费开放<br/>禁止二次倒卖</p>
            </span>
          </div>
          <div class="gal-info-card">
            <span class="gal-info-card__icon">
              <img src="https://box.moegirl.icu/media/thumb/Nav_c03.png/60px-Nav_c03.png" alt="链接" loading="lazy" />
            </span>
            <span class="gal-info-card__text">
              <strong>更新地址</strong>
              <p>Discord<br/>新类脑</p>
            </span>
          </div>
          <div class="gal-info-card">
            <span class="gal-info-card__icon">
              <img src="https://box.moegirl.icu/media/thumb/Nav_c04.png/60px-Nav_c04.png" alt="假日" loading="lazy" />
            </span>
            <span class="gal-info-card__text">
              <strong>本卡类型</strong>
              <p>SillyTavern<br/>同人卡</p>
            </span>
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

        <p class="gal-title__footer">Saenai Hiroin no Sodatekata</p>
      </div>
    </div>
  `;
}

export function renderCharacterCreation() {
  return `
    <div class="gal-title">
      ${renderSakuraField(28)}
      ${renderTitleMusicControl()}

      <div class="gal-title__particles" aria-hidden="true">
        <span class="gal-particle gal-particle--1"></span>
        <span class="gal-particle gal-particle--2"></span>
        <span class="gal-particle gal-particle--3"></span>
      </div>

      <div class="gal-title__content">
        <header class="gal-title__header">
          <p class="gal-title__ornament">✦ ─────── ✦</p>
          <h1 class="gal-title__name" style="font-size:1.6rem">创建主角</h1>
          <p class="gal-title__sub">Character Creation</p>
        </header>

        <form class="gal-create-form" data-action="create-form">
          <div class="gal-field">
            <label class="gal-field__label" for="gal-char-name">主角名</label>
            <input class="gal-field__input" id="gal-char-name" name="characterName"
              type="text" placeholder="输入你的主角名称" required autocomplete="off" />
          </div>

          <div class="gal-field">
            <label class="gal-field__label" for="gal-char-gender">性别</label>
            <input class="gal-field__input" id="gal-char-gender" name="gender"
              type="text" value="男" readonly />
          </div>

          <div class="gal-field">
            <label class="gal-field__label" for="gal-char-personality">主角性格</label>
            <textarea class="gal-field__textarea" id="gal-char-personality" name="personality"
              placeholder="描述主角的性格特征..." rows="3"></textarea>
          </div>

          <div class="gal-field">
            <label class="gal-field__label" for="gal-char-appearance">
              主角相貌 <span class="gal-field__hint"></span>
            </label>
            <textarea class="gal-field__textarea" id="gal-char-appearance" name="appearance"
              placeholder="描述主角的外貌特征..." rows="3"></textarea>
          </div>

          <div class="gal-field">
            <span class="gal-field__label">
              所在班级 <span class="gal-field__hint"></span>
            </span>
            <div class="gal-class-options" role="radiogroup" aria-label="所在班级">
              <label class="gal-class-option">
                <input type="radio" name="className" value="1年A班" />
                <span>1年A班</span>
              </label>
              <label class="gal-class-option">
                <input type="radio" name="className" value="1年B班" />
                <span>1年B班</span>
              </label>
              <label class="gal-class-option">
                <input type="radio" name="className" value="2年A班" checked />
                <span>2年A班</span>
              </label>
              <label class="gal-class-option">
                <input type="radio" name="className" value="2年B班" />
                <span>2年B班</span>
              </label>
              <label class="gal-class-option">
                <input type="radio" name="className" value="3年A班" />
                <span>3年A班</span>
              </label>
              <label class="gal-class-option">
                <input type="radio" name="className" value="3年B班" />
                <span>3年B班</span>
              </label>
            </div>
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
