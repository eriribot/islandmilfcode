import { listSaves } from '../state/saves';
import { renderLoadSaveModal } from './loadsave';

// 发布角色卡前，把这里替换为可直接访问的远程音频 URL。
const TITLE_MUSIC_URL = 'https://eriribot.github.io/islandmilfcode/Aimer_星屑ビーナス.mp3';

const TITLE_FILM_IMAGES = [
  'https://eriribot.github.io/islandmilfcode/picresource/all_film.jpg',
  'https://eriribot.github.io/islandmilfcode/picresource/eriri_film.jpg',
  'https://eriribot.github.io/islandmilfcode/picresource/izumi_film.jpg',
  'https://eriribot.github.io/islandmilfcode/picresource/megumi_film.jpg',
  'https://eriribot.github.io/islandmilfcode/picresource/michiru_film.jpg',
  'https://eriribot.github.io/islandmilfcode/picresource/utha_film.jpg',
  
];

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 渲染单行属性分配控件 */
function renderStatRow(key: string, label: string, defaultValue: number): string {
  return `
    <div class="gal-stat-row">
      <span class="gal-stat-row__label">${escapeHtml(label)}</span>
      <button type="button" class="gal-stat-row__btn" data-stat-action="dec" data-stat-key="${key}" aria-label="${escapeHtml(label)}减少">−</button>
      <span class="gal-stat-row__value" data-stat-display="${key}">${defaultValue}</span>
      <input type="number" class="gal-stat-row__input" name="stat-${key}" value="${defaultValue}" min="0" max="100" step="1" data-stat-input="${key}" aria-label="${escapeHtml(label)}数值" />
      <button type="button" class="gal-stat-row__btn" data-stat-action="inc" data-stat-key="${key}" aria-label="${escapeHtml(label)}增加">+</button>
    </div>
  `;
}

// 播放音乐
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

// 樱花散落
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

function renderFilmStrip() {
  const frames = Array.from({ length: 4 }, () => TITLE_FILM_IMAGES).flat();
  return `
    <div class="gal-film-ribbon" aria-hidden="true">
      ${['top', 'middle', 'bottom'].map((segment, index) => `
        <div class="gal-film-ribbon__segment gal-film-ribbon__segment--${segment}">
          <div class="gal-film-ribbon__track" style="--film-offset:${index * -112}px">
            ${frames.map(src => `
              <figure class="gal-film-ribbon__frame">
                <img src="${escapeHtml(src)}" loading="lazy" alt="" />
              </figure>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

type TitleHomeOptions = {
  showSaves?: boolean;
};

export function renderTitleHome(options: TitleHomeOptions = {}) {
  const saves = listSaves();
  const showSaves = options.showSaves === true;
  const hasSaves = saves.length > 0;

  return `
    <div class="gal-title">
      ${renderSakuraField(42)}
      ${renderTitleMusicControl()}
      ${renderFilmStrip()}

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
          <h1 class="gal-title__name">
          <img src ="https://eriribot.github.io/islandmilfcode/picresource/logo.png" alt="S冴えない彼女の育てかた" class="gal-title__logo" />
          </h1>
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
          <button
            class="gal-btn gal-btn--load"
            data-action="show-saves"
            ${hasSaves ? '' : 'disabled'}
            aria-disabled="${hasSaves ? 'false' : 'true'}"
            title="${hasSaves ? '读取已有存档' : '暂无可读取的存档'}"
          >
            读取存档
          </button>
        </div>

        <p class="gal-title__footer">Saenai Hiroin no Sodatekata</p>
      </div>

      ${showSaves ? renderLoadSaveModal() : ''}
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
            <span class="gal-field__label">游戏难度</span>
            <div class="gal-difficulty-options" role="radiogroup" aria-label="游戏难度">
              <label class="gal-difficulty-option">
                <input type="radio" name="difficulty" value="easy" />
                <span class="gal-difficulty-option__card">
                  <strong>轻松</strong>
                  <small>500 点 · 每次 ±10</small>
                </span>
              </label>
              <label class="gal-difficulty-option">
                <input type="radio" name="difficulty" value="normal" checked />
                <span class="gal-difficulty-option__card">
                  <strong>普通</strong>
                  <small>300 点 · 每次 ±10</small>
                </span>
              </label>
              <label class="gal-difficulty-option">
                <input type="radio" name="difficulty" value="hard" />
                <span class="gal-difficulty-option__card">
                  <strong>困难</strong>
                  <small>150 点 · 每次 ±10</small>
                </span>
              </label>
            </div>
          </div>

          <div class="gal-field">
            <span class="gal-field__label">
              能力分配 <span class="gal-field__hint">剩余 <span data-stat-remaining>0</span> 点</span>
            </span>
            <div class="gal-stat-allocator">
              ${renderStatRow('knowledge', '知识', 0)}
              ${renderStatRow('charm', '魅力', 0)}
              ${renderStatRow('proficiency', '灵巧', 0)}
              ${renderStatRow('kindness', '体贴', 0)}
              ${renderStatRow('courage', '勇气', 0)}
            </div>
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
              <label class="gal-class-option gal-class-option--has-detail">
                <input type="radio" name="className" value="2年B班" />
                <span>2年B班</span>
                <div class="gal-class-detail" role="tooltip">
                  <strong>2年B班</strong>
                  <p>重要角色:</p>
                  <div class="gal-class-detail__content">
                    <span class="gal-class-detail__character">
                      <span class="gal-class-detail__sprite gal-class-detail__sprite--tomoya" role="img" aria-label="安艺伦也"></span>
                      <span class="gal-class-detail__name">安艺伦也</span>
                    </span>
                    <span class="gal-class-detail__character">
                      <span class="gal-class-detail__sprite gal-class-detail__sprite--megumi" role="img" aria-label="加藤惠"></span>
                      <span class="gal-class-detail__name">加藤惠</span>
                    </span>
                  </div>
                </div>
              </label>
              <label class="gal-class-option gal-class-option--has-detail">
                <input type="radio" name="className" value="2年G班" />
                <span>2年G班</span>
                <div class="gal-class-detail" role="tooltip">
                  <strong>2年G班</strong>
                  <p>重要角色:</p>
                  <div class="gal-class-detail__content">
                    <span class="gal-class-detail__character">
                      <span class="gal-class-detail__sprite gal-class-detail__sprite--eriri" role="img" aria-label="泽村·斯潘塞·英梨梨"></span>
                      <span class="gal-class-detail__name">泽村·斯潘塞·英梨梨</span>
                    </span>
                  </div>
                </div>
              </label>
              <label class="gal-class-option gal-class-option--has-detail">
                <input type="radio" name="className" value="3年C班" />
                <span>3年C班</span>
                <div class="gal-class-detail" role="tooltip">
                  <strong>3年C班</strong>
                  <p>重要角色:</p>
                  <div class="gal-class-detail__content">
                    <span class="gal-class-detail__character">
                      <span class="gal-class-detail__sprite gal-class-detail__sprite--utaha" role="img" aria-label="霞之丘诗羽"></span>
                      <span class="gal-class-detail__name">霞之丘诗羽</span>
                    </span>
                  </div>
                </div>
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
