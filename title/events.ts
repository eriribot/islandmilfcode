export type TitleCallbacks = {
  enterSave: (saveId: string) => void;
  returnToTitle: () => void;
  startCreating: () => void;
  createAndEnter: (opts: { characterName: string; gender: string; personality: string; appearance: string; className: string }) => void;
  deleteSave: (saveId: string) => void;
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

  root?.querySelectorAll<HTMLButtonElement>('[data-action="load-save"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const saveId = btn.dataset.saveId;
      if (saveId) cb.enterSave(saveId);
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

  const form = root?.querySelector<HTMLFormElement>('[data-action="create-form"]');
  form?.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    const characterName = (fd.get('characterName') as string)?.trim();
    if (!characterName) return;
    cb.createAndEnter({
      characterName,
      gender: (fd.get('gender') as string)?.trim() || '男',
      personality: (fd.get('personality') as string)?.trim() || '',
      appearance: (fd.get('appearance') as string)?.trim() || '',
      className: (fd.get('className') as string)?.trim() || '2年A班',
    });
  });
}
