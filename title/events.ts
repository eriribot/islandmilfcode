import type { Difficulty, PlayerStats } from '../types';

export type TitleCallbacks = {
  enterSave: (saveId: string) => void;
  returnToTitle: () => void;
  startCreating: () => void;
  showSaves: () => void;
  hideSaves: () => void;
  createAndEnter: (opts: {
    familyName: string;
    givenName: string;
    gender: string;
    personality: string;
    appearance: string;
    className: string;
    stats?: PlayerStats;
    difficulty?: Difficulty;
  }) => void;
  deleteSave: (saveId: string) => void;
  exportSave: (saveId: string) => void;
  render: () => void;
};

let titleMusicAudio: HTMLAudioElement | null = null;
let titleMusicUrl = '';

function getTitleMusicAudio(url: string) {
  if (!titleMusicAudio || titleMusicUrl !== url) {
    titleMusicAudio?.pause();
    titleMusicAudio = new Audio(url);
    titleMusicAudio.loop = true;
    titleMusicAudio.preload = 'auto';
    titleMusicAudio.volume = 0.42;
    titleMusicUrl = url;
  }

  return titleMusicAudio;
}

function setMusicButtonState(button: HTMLButtonElement, playing: boolean) {
  button.classList.toggle('is-playing', playing);
  button.setAttribute('aria-pressed', String(playing));
}

function readStatValue(fd: FormData, key: keyof PlayerStats) {
  const value = Number(fd.get(`stat-${key}`));
  return Number.isFinite(value) ? value : 0;
}

function bindTitleMusicEvents(root: HTMLElement | null) {
  root?.querySelectorAll<HTMLButtonElement>('[data-action="toggle-title-music"]').forEach(button => {
    const url = button.dataset.musicUrl?.trim();
    if (!url) {
      button.addEventListener('click', () => {
        console.warn('Title music URL is empty. Set TITLE_MUSIC_URL in title/render.ts.');
      });
      return;
    }

    const audio = getTitleMusicAudio(url);
    setMusicButtonState(button, !audio.paused);

    button.addEventListener('click', async () => {
      try {
        if (audio.paused) {
          await audio.play();
          setMusicButtonState(button, true);
        } else {
          audio.pause();
          setMusicButtonState(button, false);
        }
      } catch (error) {
        console.warn('Unable to play title music.', error);
        setMusicButtonState(button, false);
      }
    });
  });
}

export function bindTitleHomeEvents(root: HTMLElement | null, cb: TitleCallbacks) {
  bindTitleMusicEvents(root);

  root?.querySelector<HTMLButtonElement>('[data-action="new-game"]')?.addEventListener('click', () => {
    cb.startCreating();
  });

  root?.querySelector<HTMLButtonElement>('[data-action="show-saves"]')?.addEventListener('click', event => {
    const button = event.currentTarget as HTMLButtonElement | null;
    if (!button || button.disabled) return;
    cb.showSaves();
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="hide-saves"]').forEach(button => {
    button.addEventListener('click', () => {
      cb.hideSaves();
    });
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="load-save"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const saveId = btn.dataset.saveId;
      if (saveId) cb.enterSave(saveId);
    });
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="export-save"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const saveId = btn.dataset.saveId;
      if (saveId) cb.exportSave(saveId);
    });
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-action="delete-save"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const saveId = btn.dataset.saveId;
      if (!saveId) return;
      if (!confirm('确认删除此存档？')) return;
      cb.deleteSave(saveId);
      cb.render();
    });
  });
}

export function bindCharacterCreationEvents(root: HTMLElement | null, cb: TitleCallbacks) {
  bindTitleMusicEvents(root);

  root?.querySelector<HTMLButtonElement>('[data-action="back-to-title"]')?.addEventListener('click', () => {
    cb.returnToTitle();
  });

  // 点数分配交互
  bindStatAllocatorEvents(root);

  const form = root?.querySelector<HTMLFormElement>('[data-action="create-form"]');
  form?.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    const familyName = (fd.get('familyName') as string)?.trim();
    const givenName = (fd.get('givenName') as string)?.trim();
    if (!familyName || !givenName) return;

    const difficulty = normalizeDifficulty(fd.get('difficulty'));
    const config = DIFFICULTY_CONFIG[difficulty] ?? DIFFICULTY_CONFIG.normal;
    const stats: PlayerStats = {
      knowledge: readStatValue(fd, 'knowledge'),
      charm: readStatValue(fd, 'charm'),
      proficiency: readStatValue(fd, 'proficiency'),
      kindness: readStatValue(fd, 'kindness'),
      courage: readStatValue(fd, 'courage'),
    };
    const normalizedStats = normalizeStatsForConfig(stats, config);

    cb.createAndEnter({
      familyName,
      givenName,
      gender: (fd.get('gender') as string)?.trim() || '男',
      personality: (fd.get('personality') as string)?.trim() || '',
      appearance: (fd.get('appearance') as string)?.trim() || '',
      className: (fd.get('className') as string)?.trim() || '2年B班',
      stats: normalizedStats,
      difficulty,
    });
  });
}

// ── 难度配置 ──
const DIFFICULTY_CONFIG = {
  easy: { total: 500, default: 0, min: 0, max: 100 },
  normal: { total: 300, default: 0, min: 0, max: 100 },
  hard: { total: 150, default: 0, min: 0, max: 100 },
} as const;

const STAT_KEYS = ['knowledge', 'charm', 'proficiency', 'kindness', 'courage'] as const;
const STAT_STEP = 10;
type DifficultyConfig = (typeof DIFFICULTY_CONFIG)[Difficulty];

function normalizeDifficulty(value: FormDataEntryValue | null): Difficulty {
  return value === 'easy' || value === 'hard' || value === 'normal' ? value : 'normal';
}

function clampStatValue(value: number, config: DifficultyConfig) {
  return Math.min(config.max, Math.max(config.min, Number.isFinite(value) ? Math.floor(value) : config.default));
}

function getStatTotal(stats: PlayerStats) {
  return STAT_KEYS.reduce((total, key) => total + Number(stats[key] ?? 0), 0);
}

function normalizeStatsForConfig(stats: PlayerStats, config: DifficultyConfig): PlayerStats {
  const next = Object.fromEntries(
    STAT_KEYS.map(key => [key, clampStatValue(Number(stats[key]), config)]),
  ) as unknown as PlayerStats;

  let total = getStatTotal(next);
  while (total > config.total) {
    const key = [...STAT_KEYS].reverse().find(item => next[item] > config.min);
    if (!key) break;
    const reduceBy = Math.min(next[key] - config.min, total - config.total);
    next[key] = Math.max(config.min, next[key] - reduceBy);
    total -= reduceBy;
  }

  return next;
}

/** 绑定点数分配区域的交互事件 */
function bindStatAllocatorEvents(root: HTMLElement | null) {
  if (!root) return;
  const container = root.querySelector<HTMLElement>('.gal-stat-allocator');
  if (!container) return;

  function getConfig(): DifficultyConfig {
    const selected = root!.querySelector<HTMLInputElement>('input[name="difficulty"]:checked');
    const key = normalizeDifficulty(selected?.value ?? null);
    return DIFFICULTY_CONFIG[key];
  }

  function recalcRemaining() {
    const config = getConfig();
    let used = 0;
    for (const key of STAT_KEYS) {
      const input = container!.querySelector<HTMLInputElement>(`input[name="stat-${key}"]`);
      used += Number(input?.value ?? config.default);
    }
    const remaining = config.total - used;
    const el = root!.querySelector<HTMLElement>('[data-stat-remaining]');
    if (el) el.textContent = String(remaining);
  }

  function resetToDefaults() {
    const config = getConfig();
    for (const key of STAT_KEYS) {
      const input = container!.querySelector<HTMLInputElement>(`input[name="stat-${key}"]`);
      const display = container!.querySelector<HTMLElement>(`[data-stat-display="${key}"]`);
      if (input) input.value = String(config.default);
      if (display) display.textContent = String(config.default);
    }
    recalcRemaining();
  }

  // 难度切换
  root.querySelectorAll<HTMLInputElement>('input[name="difficulty"]').forEach(radio => {
    radio.addEventListener('change', resetToDefaults);
  });

  // +/- 按钮
  container.querySelectorAll<HTMLButtonElement>('[data-stat-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.statKey;
      const action = btn.dataset.statAction;
      if (!key || !action) return;

      const config = getConfig();
      const input = container!.querySelector<HTMLInputElement>(`input[name="stat-${key}"]`);
      const display = container!.querySelector<HTMLElement>(`[data-stat-display="${key}"]`);
      if (!input) return;

      let val = Number(input.value);
      let used = 0;
      for (const k of STAT_KEYS) {
        const inp = container!.querySelector<HTMLInputElement>(`input[name="stat-${k}"]`);
        used += Number(inp?.value ?? config.default);
      }

      if (action === 'inc') {
        const remaining = config.total - used;
        if (val >= config.max || remaining <= 0) return;
        val = Math.min(val + STAT_STEP, config.max, val + remaining);
      } else {
        if (val <= config.min) return;
        val = Math.max(val - STAT_STEP, config.min);
      }

      input.value = String(val);
      if (display) display.textContent = String(val);
      recalcRemaining();
    });
  });

  container.querySelectorAll<HTMLInputElement>('[data-stat-input]').forEach(input => {
    const normalizeInput = () => {
      const config = getConfig();
      const key = input.dataset.statInput;
      const oldValue = Number(input.defaultValue || config.default);
      const display = key ? container!.querySelector<HTMLElement>(`[data-stat-display="${key}"]`) : null;
      const otherUsed = STAT_KEYS.filter(item => item !== key).reduce((total, item) => {
        const other = container!.querySelector<HTMLInputElement>(`input[name="stat-${item}"]`);
        return total + Number(other?.value ?? config.default);
      }, 0);
      const maxAllowed = Math.min(config.max, config.total - otherUsed);
      const nextValue = Math.min(clampStatValue(Number(input.value || oldValue), config), Math.max(config.min, maxAllowed));
      input.value = String(nextValue);
      input.defaultValue = String(nextValue);
      if (display) display.textContent = String(nextValue);
      recalcRemaining();
    };
    input.addEventListener('change', normalizeInput);
    input.addEventListener('input', normalizeInput);
  });

  recalcRemaining();
}
