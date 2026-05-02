import { escapeHtml } from '../html';
import type { TargetStatus } from '../types';
import { affinityStage } from '../variables/normalize';
import type { PhoneCharacterId } from './types';

type ArchiveMeterTone = 'affection';

type ArchiveMeter = {
  label: string;
  caption: string;
  value: number;
  tone: ArchiveMeterTone;
};

type CharacterArchive = {
  id: PhoneCharacterId;
  archiveLabel: string;
  name: string;
  romanName: string;
  panelMark: string;
  imageUrl: string;
  imageAlt: string;
  portraitCode: string;
  foot: Array<{ label: string; value: string }>;
  tags: string[];
  intro: string;
  quote: string;
  details: Array<{ label: string; value: string }>;
  meters: ArchiveMeter[];
  note: string;
};

type ResolvedArchive = CharacterArchive & {
  loadedTarget: TargetStatus | null;
  displayName: string;
  displaySubtitle: string;
  displayImageUrl: string;
  displayImageAlt: string;
  affinity: number;
  stage: string;
};

const CHARACTER_ARCHIVES: Record<PhoneCharacterId, CharacterArchive> = {
  megumi: {
    id: 'megumi',
    archiveLabel: '女主档案',
    name: '加藤 惠',
    romanName: '安静可靠型',
    panelMark: '加藤恵',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/megumi_phone.jpg',
    imageAlt: '加藤惠头像',
    portraitCode: 'steady presence',
    foot: [
      { label: '定位', value: '日常系女主' },
      { label: '类型', value: '安静 / 稳定 / 观察者' },
      { label: '档案', value: '人物档案' },
    ],
    tags: ['低存在感', '温和', '可靠'],
    intro:
      '看起来平淡，却总能在关键处保持清醒。她的魅力不靠夸张表现，而是来自稳定的距离感、细腻的观察力和很少失衡的情绪。',
    quote: '“我会听你说完的。”',
    details: [
      { label: '生日', value: '9月23日' },
      { label: '身高', value: '160cm' },
      { label: '喜欢', value: '安静的谈话、散步、整理记录' },
      { label: '不擅长', value: '被强行推到台前' },
    ],
    meters: [{ label: '好感度', caption: '资料占位', value: 0, tone: 'affection' }],
    note: '该角色当前是档案占位；绑定酒馆世界书目标后会显示存档变量。',
  },
  eriri: {
    id: 'eriri',
    archiveLabel: '女主档案',
    name: '泽村・斯宾塞・英梨梨',
    romanName: '傲娇画师型',
    panelMark: '英梨梨',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/eriri_phone.jpg',
    imageAlt: '英梨梨头像',
    portraitCode: 'twin-tail illustrator',
    foot: [
      { label: '定位', value: '青梅竹马' },
      { label: '类型', value: '傲娇 / 画师 / 竞争心' },
      { label: '档案', value: '人物档案' },
    ],
    tags: ['金发双马尾', '同人画师', '傲娇'],
    intro:
      '外表强势，真正认真时却比谁都在意细节。英梨梨的档案重点适合记录创作状态、关系拉扯、吃醋反应和偶尔坦率的瞬间。',
    quote: '“才、才不是特地为了你画的！”',
    details: [
      { label: '生日', value: '3月20日' },
      { label: '身高', value: '158cm' },
      { label: '喜欢', value: '绘画、社团作品、被认真看见' },
      { label: '不擅长', value: '敷衍、落后、被当成小孩子' },
    ],
    meters: [{ label: '好感度', caption: '资料占位', value: 0, tone: 'affection' }],
    note: '该角色当前是档案占位；绑定酒馆世界书目标后会显示存档变量。',
  },
  utaha: {
    id: 'utaha',
    archiveLabel: '女主档案',
    name: '霞之丘 诗羽',
    romanName: '冷静作家型',
    panelMark: '詩羽',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/utaha_phone.jpg',
    imageAlt: '霞之丘诗羽头像',
    portraitCode: 'black-haired novelist',
    foot: [
      { label: '定位', value: '学姐 / 作家' },
      { label: '类型', value: '毒舌 / 冷静 / 压迫感' },
      { label: '档案', value: '人物档案' },
    ],
    tags: ['黑长直', '轻小说作家', '学姐'],
    intro:
      '语气锋利，思路清楚，擅长把暧昧和压力都变成文字。她的档案适合记录心理攻防、作品灵感和那些不直接说出口的关心。',
    quote: '“这种程度的借口，你真的打算交给我看吗？”',
    details: [
      { label: '生日', value: '1月31日' },
      { label: '身高', value: '168cm' },
      { label: '喜欢', value: '写作、夜晚、有效率的对话' },
      { label: '不擅长', value: '迟钝、逃避、低质量草稿' },
    ],
    meters: [{ label: '好感度', caption: '资料占位', value: 0, tone: 'affection' }],
    note: '该角色当前是档案占位；绑定酒馆世界书目标后会显示存档变量。',
  },
};

const CHARACTER_ARCHIVE_ORDER: PhoneCharacterId[] = ['megumi', 'eriri', 'utaha'];

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getArchive(characterId: PhoneCharacterId) {
  return CHARACTER_ARCHIVES[characterId] ?? CHARACTER_ARCHIVES.megumi;
}

function getTargetAvatarUrl(target: TargetStatus | null) {
  const avatarUrl = target?.meta?.avatarUrl;
  return typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl.trim() : '';
}

function isTargetForArchive(target: TargetStatus, archive: CharacterArchive) {
  const haystack = [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .map(value => String(value ?? '').toLowerCase())
    .join('\n');

  if (archive.id === 'eriri') return /英梨梨|泽村|澤村|eriri|sawamura/.test(haystack);
  if (archive.id === 'megumi') return /加藤|惠|恵|megumi|katou|kato/.test(haystack);
  if (archive.id === 'utaha') return /霞之丘|霞ヶ丘|诗羽|詩羽|utaha|kasumigaoka/.test(haystack);
  return false;
}

function getTargetForArchive(characterId: PhoneCharacterId, targets: TargetStatus[]) {
  const archive = getArchive(characterId);
  return targets.find(target => isTargetForArchive(target, archive)) ?? null;
}

function getArchiveImage(archive: CharacterArchive, target: TargetStatus | null) {
  // 档案阶段图只由存档变量决定；当前先返回默认/世界书头像，后续可按 affinity 分段扩展。
  return getTargetAvatarUrl(target) || archive.imageUrl;
}

function resolveArchive(characterId: PhoneCharacterId, targets: TargetStatus[]): ResolvedArchive {
  const archive = getArchive(characterId);
  const target = getTargetForArchive(characterId, targets);
  const affinity = clampPercent(target?.affinity ?? 0);
  const stage = target?.stage || affinityStage(affinity);

  return {
    ...archive,
    loadedTarget: target,
    displayName: target?.name || archive.name,
    displaySubtitle: target ? `${stage} · 酒馆世界书已载入` : archive.romanName,
    displayImageUrl: getArchiveImage(archive, target),
    displayImageAlt: `${target?.name || archive.name}头像`,
    affinity,
    stage,
    meters: [
      {
        label: '好感度',
        caption: target ? stage : '资料占位',
        value: affinity,
        tone: 'affection',
      },
    ],
    note: target
      ? `变量来源：${String(target.meta?.worldbookEntryName ?? '酒馆世界书')}。当前关系阶段为「${stage}」。`
      : archive.note,
  };
}

function renderMeter(meter: ArchiveMeter) {
  const value = clampPercent(meter.value);
  return `
    <div class="archive-meter">
      <div class="archive-meter__meta">
        <span>
          <strong>${escapeHtml(meter.label)}</strong>
          <em>${escapeHtml(meter.caption)}</em>
        </span>
        <b>${value}%</b>
      </div>
      <div class="archive-bar" style="--value:${value}%">
        <span class="archive-bar__fill archive-bar__fill--${meter.tone}"></span>
      </div>
    </div>
  `;
}

export function renderCharacterArchivePanel(characterId: PhoneCharacterId, targets: TargetStatus[] = []) {
  const archive = resolveArchive(characterId, targets);
  const affection = archive.affinity;
  const activeHearts = Math.max(0, Math.min(5, Math.ceil(affection / 20)));

  return `
    <div class="archive-page">
      <div class="archive-character-tabs" aria-label="切换档案">
        ${CHARACTER_ARCHIVE_ORDER.map(id => {
          const item = resolveArchive(id, targets);
          return `
            <button
              class="${id === archive.id ? 'is-active' : ''}"
              data-action="switch-phone-character"
              data-character-id="${id}"
              aria-pressed="${id === archive.id ? 'true' : 'false'}"
            >
              <img src="${escapeHtml(item.displayImageUrl)}" alt="${escapeHtml(item.displayName)}" loading="lazy" decoding="async" />
              <span>${escapeHtml(item.displayName)}</span>
              ${item.loadedTarget ? '<i>变量</i>' : '<i>占位</i>'}
            </button>
          `;
        }).join('')}
      </div>

      <header class="archive-summary-card">
        <div class="archive-avatar">
          <img src="${escapeHtml(archive.displayImageUrl)}" alt="${escapeHtml(archive.displayImageAlt)}" loading="lazy" decoding="async" />
        </div>
        <div class="archive-summary-copy">
          <span class="archive-eyebrow">${escapeHtml(archive.archiveLabel)}</span>
          <h2>${escapeHtml(archive.displayName)}</h2>
          <span class="archive-roman">${escapeHtml(archive.displaySubtitle)}</span>
          <div class="archive-tags">
            ${archive.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}
          </div>
        </div>
      </header>

      <section class="archive-panel archive-profile">
        <div class="archive-panel__head">
          <span>人物资料</span>
          <span>${escapeHtml(archive.panelMark)}</span>
        </div>
        <div class="archive-profile__body">
          <p>${escapeHtml(archive.intro)}</p>
          <blockquote>${escapeHtml(archive.quote)}</blockquote>
          <div class="archive-info-grid">
            ${archive.details
              .map(
                item => `
                  <div>
                    <span>${escapeHtml(item.label)}</span>
                    <strong>${escapeHtml(item.value)}</strong>
                  </div>
                `,
              )
              .join('')}
          </div>
        </div>
      </section>

      <section class="archive-subpanel">
        <h3>关系状态</h3>
        <div class="archive-affection-head">
          <span>${archive.loadedTarget ? '存档变量' : '未载入变量'}</span>
          <strong>${affection}%</strong>
        </div>
        <div class="archive-hearts" aria-hidden="true">
          ${Array.from({ length: 5 }, (_, index) => `<span class="${index < activeHearts ? 'is-active' : ''}"></span>`).join('')}
        </div>
        <div class="archive-meter-stack">
          ${archive.meters.map(renderMeter).join('')}
        </div>
        <p>${escapeHtml(archive.note)}</p>
      </section>

    </div>
  `;
}
