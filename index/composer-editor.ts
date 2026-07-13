import { escapeHtml } from '../html';

export type ComposerEditorBinding = {
  readonly root: HTMLElement | null;
  readonly getDraft: () => string;
  readonly setDraft: (value: string) => void;
  readonly getContextLabel: () => string;
  readonly getSubmitLabel: () => string;
  readonly isGenerating: () => boolean;
  readonly submit: () => Promise<void>;
};

function syncMountedComposers(root: HTMLElement, value: string) {
  root.querySelectorAll<HTMLTextAreaElement>('.composer-input').forEach(textarea => {
    textarea.value = value;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(88, textarea.scrollHeight)}px`;
  });
  root.querySelectorAll<HTMLButtonElement>('.paper-composer-card [data-action="send"]').forEach(button => {
    button.disabled = !value.trim();
  });
}

function createComposerEditor(binding: ComposerEditorBinding, trigger: HTMLButtonElement) {
  const root = binding.root;
  if (!root || binding.isGenerating()) return;
  root.querySelector<HTMLElement>('[data-composer-editor-overlay]')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'composer-editor-overlay';
  overlay.dataset.composerEditorOverlay = 'true';
  overlay.innerHTML = `
    <button class="composer-editor-overlay__backdrop" type="button" data-composer-editor-close aria-label="关闭正文编辑器"></button>
    <section class="composer-editor-overlay__panel" role="dialog" aria-modal="true" aria-labelledby="composer-editor-title">
      <header class="composer-editor-overlay__header">
        <div>
          <span>记录框</span>
          <strong id="composer-editor-title">${escapeHtml(binding.getContextLabel())}</strong>
        </div>
        <button class="composer-editor-overlay__close" type="button" data-composer-editor-close aria-label="关闭">×</button>
      </header>
      <textarea class="composer-editor-overlay__textarea" data-composer-editor-input placeholder="填写正文或大纲……">${escapeHtml(binding.getDraft())}</textarea>
      <footer class="composer-editor-overlay__footer">
        <span data-composer-editor-count></span>
        <button class="composer-editor-overlay__return" type="button" data-composer-editor-close>返回记录栏</button>
        <button class="composer-editor-overlay__submit" type="button" data-composer-editor-submit>${escapeHtml(binding.getSubmitLabel())}</button>
      </footer>
    </section>
  `;
  root.append(overlay);

  const textarea = overlay.querySelector<HTMLTextAreaElement>('[data-composer-editor-input]');
  const submitButton = overlay.querySelector<HTMLButtonElement>('[data-composer-editor-submit]');
  const count = overlay.querySelector<HTMLElement>('[data-composer-editor-count]');
  if (!textarea || !submitButton || !count) {
    overlay.remove();
    return;
  }

  const sync = () => {
    const value = textarea.value;
    binding.setDraft(value);
    syncMountedComposers(root, value);
    count.textContent = `${value.length} 字`;
    submitButton.disabled = !value.trim() || binding.isGenerating();
  };
  const close = () => {
    overlay.remove();
    trigger.focus();
  };
  const submit = async () => {
    sync();
    if (submitButton.disabled) return;
    overlay.remove();
    await binding.submit();
  };

  overlay.querySelectorAll<HTMLElement>('[data-composer-editor-close]').forEach(button => {
    button.addEventListener('click', close);
  });
  textarea.addEventListener('input', sync);
  textarea.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  submitButton.addEventListener('click', () => void submit());

  sync();
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

export function bindComposerEditor(binding: ComposerEditorBinding) {
  binding.root
    ?.querySelectorAll<HTMLButtonElement>('[data-action="open-composer-editor"]')
    .forEach(button => button.addEventListener('click', () => createComposerEditor(binding, button)));
}
