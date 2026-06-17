import { escapeHtml } from '../html';
import { getImpressionsForTarget } from '../memorydatabase/query';
import type { IslandMemoryDB } from '../memorydatabase/types';
import type { TargetStatus } from '../types';
import { affinityStage, attachmentStage, attachmentValue, obsessionStage } from '../variables/normalize';
import { isPhoneArchiveGoldImpression, selectPhoneArchiveImpressions, type PhoneCharacterId } from './types';

const LEGACY_IZUMI_FILM_AVATAR_URL = 'https://eriribot.github.io/islandmilfcode/picresource/izumi_film.jpg';
const IZUMI_PHONE_AVATAR_URL = 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg';

type ArchiveMeterTone = 'affection' | 'obsession';

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
  details: Array<{ label: string; value: string }>;
  meters: ArchiveMeter[];
  usesObsessionAxis?: boolean;
  note: string;
};

type ResolvedArchive = CharacterArchive & {
  loadedTarget: TargetStatus | null;
  displayName: string;
  displaySubtitle: string;
  displayImageUrl: string;
  displayImageAlt: string;
  affinity: number;
  obsession: number;
  stage: string;
  obsStage: string;
  usesObsessionAxis: boolean;
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
    details: [
      { label: '生日', value: '9月23日' },
      { label: '身高', value: '160cm' },
    ],
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '该角色当前是开局变量档案；绑定酒馆世界书目标后会显示实时变量。',
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
    details: [
      { label: '生日', value: '3月20日' },
      { label: '身高', value: '158cm' },
    ],
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '该角色当前是档案占位；绑定酒馆世界书目标后会显示实时变量。',
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
    details: [
      { label: '生日', value: '1月31日' },
      { label: '身高', value: '168cm' },
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
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/izumi_phone.jpg',
    imageAlt: '波岛出海头像',
    portraitCode: 'junior illustrator',
    foot: [
      { label: '定位', value: '后辈创作者' },
      { label: '类型', value: '活力 / 努力 / 竞争心' },
      { label: '档案', value: '人物档案' },
    ],
    tags: ['后辈', '创作者', '行动派'],
    details: [
      { label: '生日', value: '5月5日' },
      { label: '身高', value: '157cm' },
    ],
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '该角色当前是内置变量档案；绑定酒馆世界书目标后会显示实时变量。',
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
    details: [
      { label: '生日', value: '12月18日' },
      { label: '身高', value: '173cm' },
    ],
    meters: [{ label: '好感度', caption: '开局变量', value: 0, tone: 'affection' }],
    note: '该角色当前是内置变量档案；绑定酒馆世界书目标后会显示实时变量。',
  },
  sayuri: {
    id: 'sayuri',
    archiveLabel: '特别档案',
    name: '泽村小百合',
    romanName: 'Sawamura Sayuri',
    panelMark: '小百合',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/sayuri_phone.jpg',
    imageAlt: '泽村小百合头像',
    portraitCode: 'sawamura family matriarch',
    foot: [
      { label: '定位', value: '人妻 / 外交官夫人' },
      { label: '类型', value: '资深腐女 / 尽情欢闹的神秘大姐 / 人妻' },
      { label: '档案', value: '特别人物档案' },
    ],
    tags: ['外交官夫人', '人妻', '特别档案'],
    details: [
      { label: '年龄', value: '38-39' },
      { label: '身高', value: '159cm' },
    ],
    meters: [{ label: '好感度', caption: '资料占位', value: 0, tone: 'affection' }],
    usesObsessionAxis: false,
    note: '小百合不属于五小只角色歌与旧情度轴；她是已婚成人专例，不使用完璧/结缘闩锁。',
  },
  sonoko: {
    id: 'sonoko',
    archiveLabel: '特别档案',
    name: '町田苑子',
    romanName: 'Machida Sonoko',
    panelMark: '苑子',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Sonoko_phone.png',
    imageAlt: '町田苑子头像',
    portraitCode: 'sharp professional editor',
    foot: [
      { label: '定位', value: '职业编辑 / 霞诗子责编' },
      { label: '类型', value: '成熟 / 犀利 / 截稿管理' },
      { label: '档案', value: '特别人物档案' },
    ],
    tags: ['责编', '成人角色', '特别档案'],
    details: [
      { label: '生日', value: '6月15日' },
      { label: '身高', value: '168cm' },
    ],
    meters: [{ label: '好感度', caption: '资料占位', value: 0, tone: 'affection' }],
    usesObsessionAxis: false,
    note: '苑子不属于五小只角色歌与旧情度轴；作为成人未婚角色，亲密档案按五小只的完璧/结缘闩锁与计数器显示。',
  },
  akane: {
    id: 'akane',
    archiveLabel: '特别档案',
    name: '高坂茜(红坂朱音)',
    romanName: 'Kosaka Akane',
    panelMark: '茜',
    imageUrl: 'https://eriribot.github.io/islandmilfcode/picresource/Akane_phone.png',
    imageAlt: '高坂茜头像',
    portraitCode: 'legendary doujin creator',
    foot: [
      { label: '类型', value: '成熟 / 创作者 / 业界暴君' },
      { label: '档案', value: '特别人物档案' },
    ],
    tags: ['成人角色', '创作者', '特别档案'],
    details: [
      { label: '生日', value: '5月28日' },
      { label: '身高', value: '168cm' },
    ],
    meters: [{ label: '好感度', caption: '资料占位', value: 0, tone: 'affection' }],
    usesObsessionAxis: false,
    note: '茜不属于五小只角色歌与旧情度轴；作为成人未婚角色，亲密档案按五小只的完璧/结缘闩锁与计数器显示。',
  },
};

// 中文注释：档案页顶部角色标签的显示顺序；新增角色必须同步到这里，档案页才会出现。
const CHARACTER_ARCHIVE_ORDER: PhoneCharacterId[] = [
  'megumi',
  'eriri',
  'utaha',
  'izumi',
  'michiru',
  'sayuri',
  'sonoko',
  'akane',
];

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getArchive(characterId: PhoneCharacterId) {
  return CHARACTER_ARCHIVES[characterId] ?? CHARACTER_ARCHIVES.megumi;
}

function getTargetAvatarUrl(target: TargetStatus | null) {
  const avatarUrl = target?.meta?.avatarUrl;
  const normalized = typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl.trim() : '';
  return normalized === LEGACY_IZUMI_FILM_AVATAR_URL ? IZUMI_PHONE_AVATAR_URL : normalized;
}

function isTargetForArchive(target: TargetStatus, archive: CharacterArchive) {
  // 中文注释：兼容世界书里常见的中日文、笔名和罗马音写法，避免手机档案误显示“未载入变量”。
  const identityHaystack = [target.id, target.name, target.meta?.worldbookEntryName]
    .map(value => String(value ?? '').toLowerCase())
    .join('\n');
  const isSayuriIdentity = /泽村小百合|澤村小百合|小百合|sayuri/.test(identityHaystack);
  const isSonokoIdentity = /町田苑子|町田|苑子|sonoko|machida/.test(identityHaystack);
  const isAkaneIdentity = /高坂茜|红坂朱音|紅坂朱音|高坂|红坂|紅坂|朱音|茜|akane|kosaka|kousaka|kurenai/.test(
    identityHaystack,
  );
  const haystack = [identityHaystack, target.alias].map(value => String(value ?? '').toLowerCase()).join('\n');

  if (archive.id === 'eriri') return !isSayuriIdentity && /英梨梨|泽村|澤村|eriri|sawamura/.test(haystack);
  if (archive.id === 'megumi') return /加藤|惠|恵|megumi|katou|kato/.test(haystack);
  if (archive.id === 'utaha') return /霞之丘|霞之诗羽|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(haystack);
  if (archive.id === 'izumi') return /波岛|波島|出海|izumi|hashima/.test(haystack);
  if (archive.id === 'michiru') return /冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(haystack);
  if (archive.id === 'sayuri') return isSayuriIdentity;
  if (archive.id === 'sonoko') return isSonokoIdentity;
  if (archive.id === 'akane') return isAkaneIdentity;
  return false;
}

function getTargetForArchive(characterId: PhoneCharacterId, targets: TargetStatus[]) {
  const archive = getArchive(characterId);
  return targets.find(item => isTargetForArchive(item, archive)) ?? null;
}

function getArchiveImage(archive: CharacterArchive, target: TargetStatus | null) {
  // 档案阶段图只由存档变量决定；当前先返回默认/世界书头像，后续可按 affinity 分段扩展。
  return getTargetAvatarUrl(target) || archive.imageUrl;
}

function resolveArchive(characterId: PhoneCharacterId, targets: TargetStatus[]): ResolvedArchive {
  const archive = getArchive(characterId);
  const target = getTargetForArchive(characterId, targets);
  const affinity = clampPercent(target?.affinity ?? 0);
  const usesObsessionAxis = archive.usesObsessionAxis !== false && target?.meta?.noObsessionAxis !== true;
  const obsession = usesObsessionAxis ? clampPercent(target?.obsession ?? 0) : 0;
  const stage = target?.stage || affinityStage(affinity);
  const obsStage = usesObsessionAxis ? target?.obsessionStage || obsessionStage(obsession) : '';
  const meters: ArchiveMeter[] = [
    {
      label: '好感度',
      caption: target ? stage : '资料占位',
      value: affinity,
      tone: 'affection',
    },
    ...(usesObsessionAxis
      ? [
          {
            label: '旧情度',
            caption: target ? obsStage : '资料占位',
            value: obsession,
            tone: 'obsession' as const,
          },
        ]
      : []),
  ];

  return {
    ...archive,
    loadedTarget: target,
    displayName: target?.name || archive.name,
    displaySubtitle: target ? `${stage} · 酒馆世界书已载入` : archive.romanName,
    displayImageUrl: getArchiveImage(archive, target),
    displayImageAlt: `${target?.name || archive.name}头像`,
    affinity,
    obsession,
    stage,
    obsStage,
    usesObsessionAxis,
    meters,
    note: target
      ? usesObsessionAxis
        ? `当前关系阶段为「${stage}」，对伦也的旧情度为「${obsStage}」。`
        : `当前关系阶段为「${stage}」；该档案不使用旧情度/执念轴。`
      : archive.note,
  };
}

function renderMeter(meter: ArchiveMeter) {
  const value = clampPercent(meter.value);
  // 旧情度按危险度分级；好感度按温度分级。两条轴的分级规则在 CSS 选择器里按 tone 分别响应。
  let level = 'mid';
  if (meter.tone === 'obsession') {
    if (value >= 70) level = 'danger';
    else if (value < 10) level = 'letgo';
    else if (value < 30) level = 'fading';
  } else if (meter.tone === 'affection') {
    if (value >= 70) level = 'hot';
    else if (value < 30) level = 'cold';
  }
  return `
    <div class="archive-meter archive-meter--${meter.tone}" data-meter-level="${level}">
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

// 中文注释：亲密接触计数器的常见字段展示顺序；未列出的自定义字段（如 足交次数）追加在后面。
const COUNTER_FIELD_ORDER = ['接吻次数', '口交次数', '乳交次数', '性交次数', '被内射次数', '肛交次数'];

// 中文注释：已废弃、不再展示的计数字段。设计意图是“加深依恋感”而非征服式统计，
// 经验人数（伴侣数）与该意图冲突，旧存档里残留也一律不读取、不展示、不回注。
const EXCLUDED_COUNTER_FIELDS = new Set<string>(['经验人数']);

/** 从 target.meta 读取贞操状态；缺省视为 intact（完璧）。 */
function readVirginity(target: TargetStatus | null): 'intact' | 'lost' {
  return target?.meta?.virginity === 'lost' ? 'lost' : 'intact';
}

function isAdultMarriedIntimacyTarget(target: TargetStatus | null) {
  return target?.meta?.intimacyStatusMode === 'adult-married';
}

/** 从 target.meta 读取亲密接触计数器，按常见字段顺序排列，自定义字段追加在后；废弃字段（经验人数）一律剔除。 */
function readBodyCounters(target: TargetStatus | null): Array<{ field: string; value: number }> {
  const raw = target?.meta?.bodyCounters;
  if (!raw || typeof raw !== 'object') return [];
  const entries = new Map<string, number>();
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (EXCLUDED_COUNTER_FIELDS.has(field)) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) entries.set(field, n);
  }
  if (!entries.size) return [];

  const ordered: Array<{ field: string; value: number }> = [];
  for (const field of COUNTER_FIELD_ORDER) {
    if (entries.has(field)) {
      ordered.push({ field, value: entries.get(field)! });
      entries.delete(field);
    }
  }
  // 剩余的自定义字段（特殊玩法）追加在后。
  for (const [field, value] of entries) {
    ordered.push({ field, value });
  }
  return ordered;
}

/** 渲染印象 chip：按极性着色。impressions 为空则返回空串（不显示该区）。 */
function renderImpressionChips(memoryDB: IslandMemoryDB | null | undefined, targetId: string | undefined): string {
  if (!memoryDB || !targetId) return '';
  const allImpressions = getImpressionsForTarget(memoryDB, targetId);
  // 只显示"对 User/玩家"的印象；对其他角色的印象不在"她对你的印象"里展示。
  const impressions = selectPhoneArchiveImpressions(
    allImpressions.filter(imp => /^(user|玩家|你)$/i.test(imp.subject.trim())),
  );
  if (!impressions.length) return '';
  const chips = impressions
    .map(imp => {
      const polarity = isPhoneArchiveGoldImpression(imp)
        ? 'gold'
        : imp.polarity > 0
          ? 'pos'
          : imp.polarity < 0
            ? 'neg'
            : 'neutral';
      return `
        <button
          type="button"
          class="archive-impression-chip archive-impression-chip--${polarity}"
          data-action="archive-edit-impression"
          data-impression-id="${escapeHtml(imp.id)}"
          title="编辑印象标签"
          aria-label="编辑印象标签：${escapeHtml(imp.label)}"
        >${escapeHtml(imp.label)}</button>
      `;
    })
    .join('');
  return `
    <section class="archive-panel archive-impressions">
      <div class="archive-panel__head">
        <span>她对你的印象</span>
        <span>${impressions.length}</span>
      </div>
      <div class="archive-impression-chips">${chips}</div>
    </section>
  `;
}

/** 渲染亲密状态区：关系印章徽章 + 亲密接触计数器网格。只要 target 已载入就显示。 */
function renderSexStatusSection(target: TargetStatus | null): string {
  if (!target) return '';
  const adultMarried = isAdultMarriedIntimacyTarget(target);
  const virginity = readVirginity(target);
  const counters = readBodyCounters(target);
  const hasAdultIntimacy = adultMarried && counters.length > 0;

  // 设计意图：这是“依恋感”刻度，不是征服式战绩。已结缘=已与玩家确立亲密关系，措辞克制、暖色，不用“征服”这类词。
  const bonded = !adultMarried && virginity === 'lost';
  const sealMark = adultMarried ? (hasAdultIntimacy ? '背德' : '已婚') : bonded ? '结缘' : '完璧';
  const sealCaption = adultMarried
    ? hasAdultIntimacy
      ? '已发生关系 / 背德线'
      : '婚姻存续 / 尚未越界'
    : bonded
      ? '已确立亲密关系'
      : '尚未逾矩';
  const headerStatus = adultMarried ? (hasAdultIntimacy ? '背德关系' : '既婚') : bonded ? '已结缘' : '完璧';
  const badge = `
    <div class="archive-seal ${bonded || adultMarried ? 'is-bonded' : ''}" aria-label="${escapeHtml(headerStatus)}">
      <span class="archive-seal__mark">${escapeHtml(sealMark)}</span>
      <span class="archive-seal__caption">${escapeHtml(sealCaption)}</span>
    </div>
  `;

  // 常见项始终显示（缺的补 0），让五小只一载入就有完整网格；自定义字段（如 足交次数）有值才追加。
  const valueByField = new Map(counters.map(c => [c.field, c.value]));
  const displayCounters = [
    ...COUNTER_FIELD_ORDER.map(field => ({ field, value: valueByField.get(field) ?? 0 })),
    ...counters.filter(c => !COUNTER_FIELD_ORDER.includes(c.field)),
  ];

  // 依恋值：五小只从 counters + 结缘闩锁派生；成人已婚角色不使用贞操闩锁，只看玩家互动计数。
  const attachment = attachmentValue(Object.fromEntries(counters.map(c => [c.field, c.value])), bonded);
  const attachmentLabel = adultMarried ? '亲近值' : '依恋值';
  const attachmentCaption = adultMarried
    ? hasAdultIntimacy
      ? '背德关系已成立'
      : '尚未越界'
    : attachmentStage(attachment);
  const attachmentBar = `
    <div class="archive-attachment" data-attach-level="${attachment >= 75 ? 'deep' : attachment >= 25 ? 'mid' : 'early'}">
      <div class="archive-attachment__meta">
        <span><strong>${escapeHtml(attachmentLabel)}</strong><em>${escapeHtml(attachmentCaption)}</em></span>
        <b>${attachment}</b>
      </div>
      <div class="archive-bar" style="--value:${attachment}%">
        <span class="archive-bar__fill archive-bar__fill--attachment"></span>
      </div>
    </div>
  `;

  const counterGrid = `
    <div class="archive-counter-grid">
      ${displayCounters
        .map(
          c => `
            <div class="archive-counter">
              <span>${escapeHtml(c.field)}</span>
              <strong>${c.value}</strong>
            </div>
          `,
        )
        .join('')}
    </div>
  `;

  return `
    <section class="archive-panel archive-sexstatus">
      <div class="archive-panel__head">
        <span>亲密档案</span>
        <span>${escapeHtml(headerStatus)}</span>
      </div>
      <div class="archive-sexstatus__body">
        ${badge}
        ${attachmentBar}
        ${counterGrid}
      </div>
    </section>
  `;
}

export function renderCharacterArchivePanel(
  characterId: PhoneCharacterId,
  targets: TargetStatus[] = [],
  memoryDB?: IslandMemoryDB | null,
) {
  const archive = resolveArchive(characterId, targets);
  const affection = archive.affinity;
  const obsession = archive.obsession;
  const obsessionBlock = archive.usesObsessionAxis
    ? `
        <div class="archive-obsession-head">
          <span class="archive-obsession-icon" aria-hidden="true"></span>
          <span>当前执念</span>
          <strong>${obsession}%</strong>
        </div>
      `
    : '';
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
              ${item.loadedTarget ? '<i>已载入</i>' : '<i>占位</i>'}
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
          <span>${archive.loadedTarget ? '当前好感' : '未载入变量'}</span>
          <strong>${affection}%</strong>
        </div>
        <div class="archive-hearts" aria-hidden="true">
          ${Array.from({ length: 5 }, (_, index) => `<span class="${index < Math.max(0, Math.min(5, Math.ceil(affection / 20))) ? 'is-active' : ''}"></span>`).join('')}
        </div>
        ${obsessionBlock}
        <div class="archive-meter-stack">
          ${archive.meters.map(renderMeter).join('')}
        </div>
        <p>${escapeHtml(archive.note)}</p>
      </section>

      ${renderImpressionChips(memoryDB, archive.loadedTarget?.id)}

      ${renderSexStatusSection(archive.loadedTarget)}

    </div>
  `;
}
