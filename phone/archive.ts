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
    // 中文注释：加藤惠按开局变量档案处理，和英梨梨、诗羽一样从一开始就是可加载的角色变量。
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
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '该角色当前是开局变量档案；绑定酒馆世界书目标后会显示存档变量。',
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
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '该角色当前是档案占位；绑定酒馆世界书目标后会显示存档变量。',
  },
  utaha: {
    id: 'utaha',
    archiveLabel: '女主档案',
    // 中文注释：诗羽档案来自《路人女主.json》的「霞之丘诗羽(开局)」条目，用于替换原先的静态占位文案。
    name: '霞之丘诗羽',
    romanName: 'Kasumigaoka Utaha',
    panelMark: '詩羽',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/utaha_phone.jpg',
    imageAlt: '霞之丘诗羽头像',
    portraitCode: 'black-haired novelist',
    foot: [
      { label: '定位', value: '丰之崎年级第一 / 学姐' },
      { label: '笔名', value: '霞诗子' },
      { label: '代表作', value: '《恋爱节拍器》' },
    ],
    tags: ['黑长直', '霞诗子', '毒舌学姐', '高攻低防'],
    intro:
      '表面是丰之崎学园高不可攀的优等生，私下是以“霞诗子”为笔名的超人气高中生轻小说作家。她擅长用从容、毒舌和成熟余裕掌控局面，但真正被触及感情时，会露出笨拙、患得患失和沉重占有欲。',
    quote: '“所谓的创作者，就是要把自己的灵魂切碎了喂给读者吃的生物啊。”',
    details: [
      { label: '生日', value: '1995年1月31日' },
      { label: '身高', value: '168cm' },
      { label: '三围', value: 'B89 W61 H88' },
      { label: '身份', value: '轻小说作家 / 丰之崎两大美女之一' },
      { label: '特质', value: '身份二象性、隐性病娇、高攻低防、双标毒舌' },
      { label: '关系', value: '安艺伦也的头号读者关系与爱慕对象；英梨梨的情敌兼合作伙伴' },
    ],
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '开局为 2012 年 3 月 31 日，高二后升入私立丰之崎学园三年级 C 班。隐藏身份“霞诗子”与《恋爱节拍器》是她关系推进的核心变量。',
  },
  izumi: {
    id: 'izumi',
    archiveLabel: '女主档案',
    name: '波岛出海',
    romanName: 'Hashima Izumi',
    panelMark: '出海',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/izumi_film.jpg',
    imageAlt: '波岛出海头像',
    portraitCode: 'junior illustrator',
    foot: [
      { label: '定位', value: '后辈创作者' },
      { label: '类型', value: '活力 / 努力 / 竞争心' },
      { label: '档案', value: '人物档案' },
    ],
    tags: ['后辈', '创作者', '行动派'],
    intro:
      '带着后辈式的明亮和不服输，认真追赶前辈们的创作者。出海的档案重点适合记录创作成长、竞争心、被认可的瞬间和对玩家评价的在意程度。',
    quote: '“我也会画出让人心动的作品的！”',
    details: [
      { label: '身份', value: '创作者后辈 / 社团相关竞争者' },
      { label: '特质', value: '热情、努力、憧憬前辈但不愿只停在憧憬' },
      { label: '状态', value: '变量档案已接入' },
      { label: '关系核心', value: '评价、认可、竞争与共同创作' },
    ],
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '该角色当前是内置变量档案；绑定酒馆世界书目标后会显示存档变量。',
  },
  michiru: {
    id: 'michiru',
    archiveLabel: '女主档案',
    name: '冰堂 美智留',
    romanName: 'Hyodo Michiru',
    panelMark: '美智留',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Michiru_phone.jpg',
    imageAlt: '冰堂美智留头像',
    portraitCode: 'band vocalist cousin',
    foot: [
      { label: '定位', value: '表姐 / 乐队主唱' },
      { label: '类型', value: '开朗 / 直球 / 音乐系' },
      { label: '档案', value: '人物档案' },
    ],
    tags: ['音乐', '表姐', '行动派'],
    intro:
      '外向、直觉敏锐、讨厌沉闷气氛的乐队少女。美智留的档案重点适合记录音乐状态、同伴意识、直球关心和她把玩家纳入行动半径的瞬间。',
    quote: '“先把气氛炒起来吧！”',
    details: [
      { label: '生日', value: '1995年12月18日' },
      { label: '身份', value: 'icy tail 乐队主唱 / 吉他手' },
      { label: '身高', value: '173cm' },
      { label: '特质', value: '开朗直球、同伴至上、凭直觉行动' },
    ],
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '该角色当前是内置变量档案；绑定酒馆世界书目标后会显示存档变量。',
  },
};

// 中文注释：档案页顶部角色标签的显示顺序；新增角色必须同步到这里，档案页才会出现。
const CHARACTER_ARCHIVE_ORDER: PhoneCharacterId[] = ['megumi', 'eriri', 'utaha', 'izumi', 'michiru'];

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
  // 中文注释：兼容世界书里常见的中日文、笔名和罗马音写法，避免手机档案误显示“未载入变量”。
  const haystack = [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .map(value => String(value ?? '').toLowerCase())
    .join('\n');

  if (archive.id === 'eriri') return /英梨梨|泽村|澤村|eriri|sawamura/.test(haystack);
  if (archive.id === 'megumi') return /加藤|惠|恵|megumi|katou|kato/.test(haystack);
  if (archive.id === 'utaha') return /霞之丘|霞之诗羽|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(haystack);
  if (archive.id === 'izumi') return /波岛|波島|出海|izumi|hashima/.test(haystack);
  if (archive.id === 'michiru') return /冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(haystack);
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
