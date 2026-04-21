export type TitleCallbacks = {
  enterSave: (saveId: string) => void;
  returnToTitle: () => void;
  startCreating: () => void;
  createAndEnter: (opts: { characterName: string; personality: string; appearance: string }) => void;
  deleteSave: (saveId: string) => void;
  render: () => void;
};

export function bindTitleHomeEvents(root: HTMLElement | null, cb: TitleCallbacks) {
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
      personality: (fd.get('personality') as string)?.trim() || '',
      appearance: (fd.get('appearance') as string)?.trim() || '',
    });
  });
}
