import { escapeHtml } from '../html';
import type { TargetStatus } from '../types';

export type PhoneAvatarData = {
  name: string;
  avatarUrl?: string;
  avatarAssetId?: string;
};

export function getPhoneTargetName(target: Pick<TargetStatus, 'name' | 'alias'>): string {
  return target.name || target.alias || '角色';
}

export function getPhoneTargetAvatarUrl(target: TargetStatus): string {
  const avatarUrl = target.meta?.avatarUrl;
  const normalized = typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl.trim() : '';
  if (normalized === 'https://eriribot.github.io/islandmilfcode/picresource/izumi_film.jpg') {
    return 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg';
  }
  if (normalized) return normalized;

  // 兼容缺少 avatarUrl 的旧硝子存档；新世界书会在载入时把头像写入 target.meta。
  const haystack = [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .map(value => String(value ?? '').toLowerCase())
    .join('\n');
  if (/西宫硝子|西宮硝子|西宫|西宮|硝子|shoko|shouko|nishimiya/.test(haystack)) {
    return 'https://eriribot.github.io/islandmilfcode/picresource/shoko_phone.jpg';
  }
  return '';
}

export function getPhoneTargetAvatarData(target: TargetStatus): PhoneAvatarData {
  return {
    name: getPhoneTargetName(target),
    avatarUrl: getPhoneTargetAvatarUrl(target),
  };
}

export function renderPhoneAvatar(data: PhoneAvatarData, extraClass = ''): string {
  const name = data.name.trim() || '角色';
  const initial = name.slice(0, 1);
  const classes = ['phone-chat-avatar', extraClass].filter(Boolean).join(' ');
  const avatarUrl = data.avatarUrl?.trim() || '';
  const avatarAssetId = data.avatarAssetId?.trim() || '';
  const image = avatarUrl || avatarAssetId
    ? `<img data-phone-avatar-image ${avatarUrl ? `src="${escapeHtml(avatarUrl)}"` : ''} ${avatarAssetId ? `data-image-asset-id="${escapeHtml(avatarAssetId)}"` : ''} alt="${escapeHtml(name)}" loading="lazy" decoding="async" />`
    : '';
  return `
    <span class="${classes}" aria-label="${escapeHtml(name)}">
      <span class="phone-target-avatar__fallback" aria-hidden="true">${escapeHtml(initial)}</span>
      ${image}
    </span>
  `;
}

export function renderPhoneTargetAvatar(target: TargetStatus, extraClass = ''): string {
  return renderPhoneAvatar(getPhoneTargetAvatarData(target), extraClass);
}

export function bindPhoneAvatarFallbacks(root: ParentNode | null | undefined): void {
  root?.querySelectorAll<HTMLImageElement>('[data-phone-avatar-image]').forEach(image => {
    image.addEventListener(
      'error',
      () => {
        image.remove();
      },
      { once: true },
    );
  });
}
