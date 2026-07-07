import type {
  DeepSeekFanGeneratedProfile,
  DeepSeekFanLookupState,
  DeepSeekFanSearchProvider,
  DeepSeekFanSearchResult,
  StatusData,
  ScenePresence,
  TargetStatus,
  WorldbookEntry,
} from '../types';

export type DeepSeekWebLookupSettings = {
  enabled: boolean;
  timeoutMs: number;
  maxEvidencePacks: number;
  searchSource: 'ddg' | 'encyclopedia';
  searchDdgRegion: string;
};

export type DeepSeekLookupIntent =
  | 'canon_timeline'
  | 'appearance'
  | 'fact_check'
  | 'design_small_detail'
  | 'first_appearance_bootstrap';

export type DeepSeekLookupRequest = {
  intent: DeepSeekLookupIntent;
  query: string;
  reason: string;
  characterId?: string;
  detailType?: string;
};

export type DeepSeekEvidencePack = {
  kind: 'CANON_FACT' | 'APPEARANCE' | 'DETAIL' | 'BOOTSTRAP';
  characterId?: string;
  source: string;
  confidence: 'low' | 'medium' | 'high';
  facts: string[];
  mustFollow?: string[];
  mustNotInfer?: string[];
  appliesWhen?: string;
};

export type DeepSeekWebLookupInput = {
  settings?: Partial<DeepSeekWebLookupSettings> | null;
  statusData: StatusData;
  scenePresence?: ScenePresence | null;
  userInput: string;
  recentText: string;
};

export type DeepSeekWebLookupResult = {
  enabled: boolean;
  requests: DeepSeekLookupRequest[];
  evidencePacks: DeepSeekEvidencePack[];
  context: string;
  skippedReason?: string;
  error?: string;
  errors?: string[];
};

const DEFAULT_SETTINGS: DeepSeekWebLookupSettings = {
  enabled: false,
  timeoutMs: 12_000,
  maxEvidencePacks: 4,
  searchSource: 'ddg',
  searchDdgRegion: 'wt-wt',
};

const CACHE_PREFIX = 'islandmilfcode:deepseek-web-evidence:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_DEEPSEEK_FAN_LOOKUP_STATE: DeepSeekFanLookupState = {
  workTitle: '',
  characterName: '',
  targetRoleId: '',
  worldbookName: '',
  worldbookCandidates: [],
  extra: '',
  searchProvider: 'ddg',
  searchApiKey: '',
  searchSearxngUrl: '',
  searchDdgRegion: 'wt-wt',
  searchTimeoutMs: 45_000,
  searchMaxResults: 5,
  readerResultCount: 2,
  status: 'idle',
  error: '',
  searchQuery: '',
  searchContext: '',
  searchResults: [],
  generatedText: '',
  generatedProfile: null,
  worldbookEntryText: '',
  lastUpdatedAt: 0,
};

export type DeepSeekFanSearchInput = Pick<
  DeepSeekFanLookupState,
  | 'workTitle'
  | 'characterName'
  | 'extra'
  | 'searchProvider'
  | 'searchApiKey'
  | 'searchSearxngUrl'
  | 'searchDdgRegion'
  | 'searchTimeoutMs'
  | 'searchMaxResults'
  | 'readerResultCount'
>;

export type DeepSeekFanSearchOutput = {
  query: string;
  context: string;
  results: DeepSeekFanSearchResult[];
};

export type DeepSeekFanWorldbookEntryDraft = Pick<WorldbookEntry, 'name' | 'comment' | 'key' | 'content' | 'extra'>;

const DDG_REGION_OPTIONS = new Set(['wt-wt', 'us-en', 'uk-en', 'jp-jp', 'cn-zh', 'tw-tzh', 'hk-tzh', 'kr-kr', 'de-de', 'fr-fr']);

export function normalizeDeepSeekWebLookupSettings(input: unknown): DeepSeekWebLookupSettings {
  const raw = input && typeof input === 'object' ? (input as Partial<DeepSeekWebLookupSettings>) : {};
  return {
    enabled: Boolean(raw.enabled),
    timeoutMs: Math.max(1000, Math.min(30_000, Math.round(Number(raw.timeoutMs ?? DEFAULT_SETTINGS.timeoutMs) || DEFAULT_SETTINGS.timeoutMs))),
    maxEvidencePacks: Math.max(
      1,
      Math.min(8, Math.round(Number(raw.maxEvidencePacks ?? DEFAULT_SETTINGS.maxEvidencePacks) || DEFAULT_SETTINGS.maxEvidencePacks)),
    ),
    searchSource: pickEnum(raw.searchSource, ['ddg', 'encyclopedia'] as const, DEFAULT_SETTINGS.searchSource),
    searchDdgRegion: normalizeDdgRegion(raw.searchDdgRegion),
  };
}

export function normalizeDeepSeekFanLookupState(input: unknown): DeepSeekFanLookupState {
  const raw = input && typeof input === 'object' ? (input as Partial<DeepSeekFanLookupState>) : {};
  const provider = pickEnum(
    raw.searchProvider,
    ['offline', 'encyclopedia', 'jina', 'jina_reader', 'searxng', 'ddg'] as const,
    DEFAULT_DEEPSEEK_FAN_LOOKUP_STATE.searchProvider,
  );
  const status = pickEnum(
    raw.status,
    ['idle', 'searching', 'searched', 'generating', 'generated', 'saved', 'writing', 'written', 'error'] as const,
    'idle',
  );

  return {
    workTitle: String(raw.workTitle ?? '').trim(),
    characterName: String(raw.characterName ?? '').trim(),
    targetRoleId: String(raw.targetRoleId ?? '').trim(),
    worldbookName: String(raw.worldbookName ?? '').trim(),
    worldbookCandidates: parseStringList(raw.worldbookCandidates, 80),
    extra: String(raw.extra ?? ''),
    searchProvider: provider,
    searchApiKey: String(raw.searchApiKey ?? ''),
    searchSearxngUrl: String(raw.searchSearxngUrl ?? '').trim(),
    searchDdgRegion: normalizeDdgRegion(raw.searchDdgRegion),
    searchTimeoutMs: Math.max(5000, Math.min(90_000, Math.round(Number(raw.searchTimeoutMs ?? 45_000) || 45_000))),
    searchMaxResults: Math.max(1, Math.min(10, Math.round(Number(raw.searchMaxResults ?? 5) || 5))),
    readerResultCount: Math.max(0, Math.min(5, Math.round(Number(raw.readerResultCount ?? 2) || 0))),
    status,
    error: String(raw.error ?? ''),
    searchQuery: String(raw.searchQuery ?? ''),
    searchContext: String(raw.searchContext ?? ''),
    searchResults: normalizeFanSearchResults(raw.searchResults),
    generatedText: String(raw.generatedText ?? ''),
    generatedProfile: normalizeFanGeneratedProfile(raw.generatedProfile, {
      workTitle: String(raw.workTitle ?? ''),
      characterName: String(raw.characterName ?? ''),
    }),
    worldbookEntryText: String(raw.worldbookEntryText ?? ''),
    lastUpdatedAt: Math.max(0, Number(raw.lastUpdatedAt ?? 0) || 0),
  };
}

export async function searchDeepSeekFanCharacter(input: DeepSeekFanSearchInput): Promise<DeepSeekFanSearchOutput> {
  const state = normalizeDeepSeekFanLookupState(input);
  const query = buildFanSearchQuery(state.workTitle, state.characterName, state.extra);
  if (!query.trim()) {
    throw new Error('请先填写作品名或角色名。');
  }
  if (state.searchProvider === 'offline') {
    return {
      query,
      context: buildOfflineFanSearchContext(state.workTitle, state.characterName, state.extra),
      results: [],
    };
  }

  const output = await callFanSearchProvider(state.searchProvider, query, state);
  const context = buildFanSearchContext(output.results, output.raw);
  return { query, context, results: output.results };
}

export function buildDeepSeekFanGenerationPrompt(input: DeepSeekFanLookupState): string {
  const state = normalizeDeepSeekFanLookupState(input);
  return [
    defaultFanSystemTemplate(),
    '',
    '【作品名】',
    state.workTitle || '资料不足',
    '',
    '【角色名】',
    state.characterName || '资料不足',
    '',
    '【补充要求 / 同人方向】',
    state.extra.trim() || '保持原作核心，不额外添加同人私设。',
    '',
    '【本页搜索资料】',
    state.searchContext.trim() || '未联网。只能根据用户输入生成，资料不足处必须写“资料不足”。',
  ].join('\n');
}

export function normalizeFanGeneratedProfile(
  raw: unknown,
  fallback: { workTitle?: string; characterName?: string } = {},
): DeepSeekFanGeneratedProfile | null {
  const obj = parseProfileObject(raw);
  if (!obj) return null;
  const work = getProfileString(obj, ['sourceWork', 'workTitle', '作品名']) || String(fallback.workTitle ?? '').trim();
  const name = getProfileString(obj, ['name', 'characterName', '姓名']) || String(fallback.characterName ?? '').trim();
  const aliases = uniq([name, ...getProfileStringArray(obj, ['aliases', '别名', 'keywords'])].filter(Boolean));
  const relationships = normalizeProfileRelationships(obj.relationships ?? obj['关系']);
  const uncertain = getProfileStringArray(obj, ['uncertain', '不确定点', '资料不足']);
  const profile: DeepSeekFanGeneratedProfile = {
    name: name || '未命名角色',
    sourceWork: work || '资料不足',
    aliases,
    gender: getProfileString(obj, ['gender', '性别']) || '资料不足',
    age: getProfileString(obj, ['age', '年龄']) || '资料不足',
    birthday: getProfileString(obj, ['birthday', '生日']) || '资料不足',
    identity: getProfileString(obj, ['identity', 'basic', '身份']) || '资料不足',
    appearance: getProfileString(obj, ['appearance', '外貌']) || '资料不足',
    personality: getProfileString(obj, ['personality', '性格']) || '资料不足',
    speech: getProfileString(obj, ['speech', '口吻', '说话方式']) || '资料不足',
    psychologyBehavior: getProfileString(obj, ['psychologyBehavior', 'psychology', 'behavior', '心理行为']) || '资料不足',
    abilities: getProfileString(obj, ['abilities', 'ability', '能力']) || '资料不足',
    background: getProfileString(obj, ['background', '背景']) || '资料不足',
    relationships,
    uncertain,
    entryTitle: getProfileString(obj, ['entryTitle', 'title', '条目标题']) || [work, name || '同人角色设定'].filter(Boolean).join('｜'),
    content: '',
  };
  profile.content = buildFanProfileContent(profile);
  return profile;
}

export function buildFallbackFanGeneratedProfile(input: DeepSeekFanLookupState): DeepSeekFanGeneratedProfile {
  const state = normalizeDeepSeekFanLookupState(input);
  const name = state.characterName || '未命名角色';
  const work = state.workTitle || '资料不足';
  const searchDigest = summarizeFanSearchForFallback(state);
  const profile: DeepSeekFanGeneratedProfile = {
    name,
    sourceWork: work,
    aliases: [name].filter(Boolean),
    gender: '资料不足',
    age: '资料不足',
    birthday: '资料不足',
    identity: searchDigest || '资料不足',
    appearance: '资料不足',
    personality: state.extra.trim() ? `用户补充方向：${state.extra.trim()}` : '资料不足',
    speech: '资料不足',
    psychologyBehavior: '资料不足',
    abilities: '资料不足',
    background: searchDigest || '资料不足',
    relationships: [],
    uncertain: [
      '未调用模型生成；这是无 API key 时的本地保守草稿。',
      '需要人工补充或稍后使用已配置模型重新生成。',
    ],
    entryTitle: [work, name, '同人角色设定'].filter(Boolean).join('｜'),
    content: '',
  };
  profile.content = buildFanProfileContent(profile);
  return profile;
}

export function buildFanWorldbookEntry(profile: DeepSeekFanGeneratedProfile): DeepSeekFanWorldbookEntryDraft {
  const entryTitle = profile.entryTitle || [profile.sourceWork, profile.name].filter(Boolean).join('｜') || '同人角色设定';
  const keys = uniq([profile.name, ...profile.aliases, profile.sourceWork].filter(value => value && value !== '资料不足'));
  return {
    name: entryTitle,
    comment: entryTitle,
    key: keys.length ? keys : [entryTitle],
    content: profile.content || buildFanProfileContent(profile),
    extra: {
      kind: 'islandmilfcode.target',
      name: profile.name,
      alias: profile.aliases.filter(alias => alias !== profile.name).join(' / '),
      sourceWork: profile.sourceWork,
      meta: {
        source: 'deepseek-fan-lookup',
        fanProfile: true,
        generatedAt: new Date().toISOString(),
      },
    },
  };
}

export function buildFanProfilePreviewText(profile: DeepSeekFanGeneratedProfile): string {
  return buildFanWorldbookEntry(profile).content;
}

export async function collectDeepSeekWebLookupEvidence(
  input: DeepSeekWebLookupInput,
): Promise<DeepSeekWebLookupResult> {
  const settings = normalizeDeepSeekWebLookupSettings(input.settings);
  if (!settings.enabled) {
    return { enabled: false, requests: [], evidencePacks: [], context: '', skippedReason: 'disabled' };
  }

  const requests = planDeepSeekLookupRequests(input);
  if (!requests.length) {
    return { enabled: true, requests: [], evidencePacks: [], context: '', skippedReason: 'no-lookup-needed' };
  }

  const evidencePacks: DeepSeekEvidencePack[] = [];
  const errors: string[] = [];
  for (const request of requests.slice(0, settings.maxEvidencePacks)) {
    const cached = readCachedEvidence(settings, request);
    if (cached) {
      evidencePacks.push(...cached);
      continue;
    }

    try {
      const fresh = await requestEvidencePack(settings, request, input.statusData);
      if (fresh.length) {
        writeCachedEvidence(settings, request, fresh);
        evidencePacks.push(...fresh);
      }
    } catch (error) {
      errors.push(`${request.intent}:${request.query} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    enabled: true,
    requests,
    evidencePacks,
    context: buildDeepSeekEvidenceContext(evidencePacks, requests, errors),
    ...(errors.length ? { errors, error: errors[0] } : {}),
  };
}

export function buildDeepSeekEvidenceContext(
  evidencePacks: DeepSeekEvidencePack[],
  requests: DeepSeekLookupRequest[] = [],
  errors: string[] = [],
) {
  const packs = evidencePacks
    .map(pack => {
      const header = `[${pack.kind}]${pack.characterId ? `[CHAR:${pack.characterId}]` : ''}[来源:${pack.source}][置信度:${pack.confidence}]`;
      return [
        header,
        pack.facts.length ? ['事实：', ...pack.facts.map(item => `- ${item}`)].join('\n') : '',
        pack.mustFollow?.length ? ['必须遵守：', ...pack.mustFollow.map(item => `- ${item}`)].join('\n') : '',
        pack.mustNotInfer?.length ? ['禁止推论：', ...pack.mustNotInfer.map(item => `- ${item}`)].join('\n') : '',
        pack.appliesWhen ? `适用：${pack.appliesWhen}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean);

  return packs.length
    ? [
        '[DeepSeek 联网证据包]',
        '这些证据包只用于本轮正文前的外貌、角色设计细节、canon 时间线与用户输入事实校准；不要复述网页原文。',
        '若证据包与最近正文已经发生的蝴蝶效应冲突，以最近正文的新因果为准，并在 plotImpact/evidence 中写明覆盖原因。',
        requests.length
          ? ['本轮联网查询计划：', ...requests.slice(0, 4).map(item => `- ${item.intent}: ${item.query}`)].join('\n')
          : '',
        errors.length
          ? ['本轮查询失败/无结果：', ...errors.slice(0, 4).map(item => `- ${item}`)].join('\n')
          : '',
        ...packs,
      ].join('\n\n')
    : requests.length || errors.length
      ? [
          '[DeepSeek 联网证据包]',
          '本轮触发了联网校准，但没有拿到可用结果。不要因此编造网页事实；只能把玩家输入中的待校准点视为不确定。',
          requests.length ? ['本轮联网查询计划：', ...requests.slice(0, 4).map(item => `- ${item.intent}: ${item.query}`)].join('\n') : '',
          errors.length ? ['本轮查询失败/无结果：', ...errors.slice(0, 4).map(item => `- ${item}`)].join('\n') : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : '';
}

function planDeepSeekLookupRequests(input: DeepSeekWebLookupInput): DeepSeekLookupRequest[] {
  const text = `${input.userInput}\n${input.recentText}`.toLowerCase();
  const requests: DeepSeekLookupRequest[] = [];
  for (const item of input.scenePresence?.webLookupPlan ?? []) {
    const query = normalizeAiLookupQuery(item.query);
    if (!query) continue;
    requests.push({
      intent: item.intent === 'detail' ? 'fact_check' : item.intent,
      query,
      reason: item.reason || '生成前 AI 判断该外部事实需要联网校准。',
      detailType: `ai-web-${item.intent}`,
    });
  }

  if (/同班|分班|b班|g班|座位|靠窗|隔壁班|二年级|2年|红坂|朱音|黑金|恋爱节拍器|连载|完结|2011|2012|2013/i.test(text)) {
    requests.push({
      intent: 'canon_timeline',
      query: '冴えない彼女の育てかた 2011 恋するメトロノーム 2012 クラス分け 紅坂朱音 2013',
      reason: '当前轮涉及原作时间线、分班或红坂朱音/黑金二人组等容易倒灌的 canon 事实。',
      detailType: 'timeline',
    });
  }

  for (const target of input.statusData.targets) {
    const terms = getTargetTerms(target);
    if (!terms.some(term => term && text.includes(term.toLowerCase()))) continue;
    if (/外貌|发色|瞳色|发型|服装|头像|陌生|初登场|第一次见|看见|观察|认出/i.test(text)) {
      requests.push({
        intent: 'appearance',
        query: `${target.name} 外貌 发色 瞳色 发型 角色设计`,
        reason: '当前轮可能需要描写角色外貌或初登场识别，本地上下文可能不足。',
        characterId: target.id,
        detailType: 'appearance',
      });
    }
  }

  return dedupeRequests(requests).slice(0, 4);
}

function normalizeAiLookupQuery(queryHint: string) {
  return String(queryHint ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[“”"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function getTargetTerms(target: TargetStatus) {
  return [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .flatMap(value => String(value ?? '').split(/[、,，/／\s]+/))
    .map(value => value.trim())
    .filter(value => value.length >= 2);
}

function dedupeRequests(requests: DeepSeekLookupRequest[]) {
  const seen = new Set<string>();
  return requests.filter(request => {
    const key = `${request.intent}:${request.characterId ?? ''}:${request.query}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFanSearchQuery(workTitle: string, characterName: string, extra: string) {
  return [workTitle, characterName, '角色资料', '性格', '台词', extra]
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

function buildEncyclopediaQueries(settings: DeepSeekFanLookupState) {
  const work = settings.workTitle.trim();
  const character = settings.characterName.trim();
  const base = [work, character].filter(Boolean).join(' ');
  const subject = base || work || character;
  return [
    {
      label: '萌娘百科角色资料',
      focus: 'profile' as const,
      query: [subject, 'site:zh.moegirl.org.cn', '萌娘百科', '角色'].filter(Boolean).join(' '),
    },
    {
      label: '萌娘百科备用域名',
      focus: 'profile' as const,
      query: [subject, 'site:moegirl.org.cn', '萌娘百科', '角色'].filter(Boolean).join(' '),
    },
    {
      label: '百度百科角色资料',
      focus: 'profile' as const,
      query: [subject, 'site:baike.baidu.com', '百度百科', '角色'].filter(Boolean).join(' '),
    },
    {
      label: '作品时间点',
      focus: 'timeline' as const,
      query: [work || subject, character, '时间线 剧情 时间点 登场 集数 卷数'].filter(Boolean).join(' '),
    },
    {
      label: '外貌与角色设计',
      focus: 'appearance' as const,
      query: [subject, '外貌 发色 瞳色 发型 服装 角色设计'].filter(Boolean).join(' '),
    },
  ].filter(item => item.query.trim());
}

function buildOfflineFanSearchContext(workTitle: string, characterName: string, extra: string) {
  return [
    '[不联网同人资料]',
    `作品名：${workTitle || '资料不足'}`,
    `角色名：${characterName || '资料不足'}`,
    extra.trim() ? `补充要求：${extra.trim()}` : '',
    '没有联网资料；生成设定时必须保守处理未知信息。',
  ]
    .filter(Boolean)
    .join('\n');
}

async function callFanSearchProvider(
  provider: DeepSeekFanSearchProvider,
  query: string,
  settings: DeepSeekFanLookupState,
): Promise<{ raw: string; results: DeepSeekFanSearchResult[] }> {
  if (provider === 'encyclopedia') return callEncyclopediaSearch(settings);
  if (provider === 'jina') return callJinaSearch(query, settings);
  if (provider === 'jina_reader') return callJinaSearchWithReader(query, settings);
  if (provider === 'searxng') return callSearxngSearch(query, settings);
  if (provider === 'ddg') return callDdgSearch(query, settings);
  return { raw: '', results: [] };
}

async function fanFetchText(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(normalizeFanFetchError(text, response.status));
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fanFetchJson(url: string, options: RequestInit, timeoutMs: number): Promise<unknown> {
  const text = await fanFetchText(url, options, timeoutMs);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('接口返回不是 JSON。');
  }
}

function normalizeFanFetchError(text: string, status: number) {
  const message = text.slice(0, 240).trim() || `HTTP ${status}`;
  if (/AuthenticationRequiredError|Authorization header|API key|unauthorized|forbidden/i.test(message)) {
    return '搜索服务要求鉴权，已跳过该来源。';
  }
  return message;
}

async function callJinaSearch(query: string, settings: DeepSeekFanLookupState) {
  const headers: Record<string, string> = { Accept: 'text/plain', 'X-No-Cache': 'true' };
  const key = settings.searchApiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
  const raw = await fanFetchText(url, { method: 'GET', headers }, settings.searchTimeoutMs);
  const urls = extractUrlsFromText(raw, settings.searchMaxResults);
  const results = normalizeFanSearchResults([
    { title: 'Jina Search', url, snippet: raw.slice(0, 6000), source: 'jina-search' },
    ...urls.map((item, index) => ({
      title: `搜索结果 ${index + 1}`,
      url: item,
      snippet: '',
      source: 'jina-search-url',
    })),
  ]);
  return { raw, results };
}

async function callJinaReader(url: string, settings: DeepSeekFanLookupState): Promise<DeepSeekFanSearchResult> {
  const headers: Record<string, string> = {
    Accept: 'text/plain',
    'X-Retain-Images': 'none',
    'X-No-Cache': 'true',
  };
  const key = settings.searchApiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  const readerUrl = `https://r.jina.ai/${url}`;
  const raw = await fanFetchText(readerUrl, { method: 'GET', headers }, settings.searchTimeoutMs);
  return { title: 'Jina Reader', url, snippet: raw.slice(0, 8000), source: 'jina-reader' };
}

async function callJinaSearchWithReader(query: string, settings: DeepSeekFanLookupState) {
  const searched = await callJinaSearch(query, settings);
  const urls = searched.results.map(result => result.url).filter(isHttpUrl).slice(0, settings.readerResultCount);
  const readerResults: DeepSeekFanSearchResult[] = [];
  for (const url of urls) {
    try {
      readerResults.push(await callJinaReader(url, settings));
    } catch {
      // Individual reader failures should not discard the search result list.
    }
  }
  return {
    raw: [searched.raw, ...readerResults.map(result => result.snippet)].join('\n\n'),
    results: normalizeFanSearchResults([...readerResults, ...searched.results]),
  };
}

async function callSearxngSearch(query: string, settings: DeepSeekFanLookupState) {
  const base = normalizeSearxngBaseUrl(settings.searchSearxngUrl);
  if (!base) throw new Error('请先填写 SearXNG 地址。');
  const jsonUrl = buildSearxngUrl(base, query, 'json');
  try {
    const raw = await fanFetchText(jsonUrl, { method: 'GET', headers: { Accept: 'application/json,text/plain' } }, settings.searchTimeoutMs);
    const parsed = parseSearxngJsonText(raw);
    if (parsed.length) return { raw, results: parsed.slice(0, settings.searchMaxResults) };
  } catch {
    // Fall through to HTML parsing; public instances often disable JSON or CORS.
  }
  const htmlUrl = buildSearxngUrl(base, query, '');
  const raw = await fanFetchText(htmlUrl, { method: 'GET', headers: { Accept: 'text/html,text/plain' } }, settings.searchTimeoutMs);
  const results = parseGenericHtmlResults(raw, 'searxng').slice(0, settings.searchMaxResults);
  if (!results.length) throw new Error('SearXNG 可访问，但没有解析到搜索结果。');
  return { raw, results };
}

async function callDdgSearch(query: string, settings: DeepSeekFanLookupState) {
  const region = normalizeDdgRegion(settings.searchDdgRegion);
  const url = buildDdgHtmlUrl(query, region);
  const raw = await fanFetchText(url, { method: 'GET', headers: { Accept: 'text/html,text/plain' } }, settings.searchTimeoutMs);
  const results = parseDdgHtmlText(raw).slice(0, settings.searchMaxResults);
  if (results.length) return { raw, results };
  throw new Error('DDG HTML 可访问，但没有解析到搜索结果。');
}

async function callEncyclopediaSearch(settings: DeepSeekFanLookupState) {
  const queries = buildEncyclopediaQueries(settings);
  const allResults: DeepSeekFanSearchResult[] = [];
  const rawBlocks: string[] = [];
  const mediaWikiSearches = buildMediaWikiSearches(settings);
  for (const item of mediaWikiSearches) {
    try {
      const searched = await callMediaWikiSearch(item.api, item.query, item.source, item.focus, settings);
      rawBlocks.push(`[${item.label}]\n${searched.raw.slice(0, 3000)}`);
      allResults.push(...searched.results);
    } catch (error) {
      rawBlocks.push(`[${item.label} 失败] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const item of queries) {
    if (allResults.length >= settings.searchMaxResults) break;
    try {
      const searched = await callDdgSearch(item.query, {
        ...settings,
        searchMaxResults: Math.max(settings.searchMaxResults, 6),
      });
      rawBlocks.push(`[${item.label}]\n${searched.raw.slice(0, 3000)}`);
      allResults.push(
        ...searched.results.map(result => annotateFanSearchResult(result, item.focus)),
      );
    } catch (error) {
      rawBlocks.push(`[${item.label} 失败] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const results = normalizeFanSearchResults(allResults).slice(0, settings.searchMaxResults);
  if (results.length) return { raw: rawBlocks.join('\n\n'), results };
  throw new Error('百科优先搜索没有拿到结果。可以换关键词，或改用自己的 SearXNG 地址。');
}

function buildMediaWikiSearches(settings: DeepSeekFanLookupState) {
  const work = settings.workTitle.trim();
  const character = settings.characterName.trim();
  const subject = [work, character].filter(Boolean).join(' ') || work || character;
  const timeline = [work || subject, character, '时间线 剧情 登场'].filter(Boolean).join(' ');
  const appearance = [subject, '外貌 发色 瞳色 发型 服装'].filter(Boolean).join(' ');
  const apiList = [
    { source: '萌娘百科', api: 'https://zh.moegirl.org.cn/api.php' },
    { source: 'Wikipedia', api: 'https://zh.wikipedia.org/w/api.php' },
  ];
  return apiList.flatMap(site => [
    { ...site, label: `${site.source} 条目`, focus: 'profile' as const, query: subject },
    { ...site, label: `${site.source} 时间点`, focus: 'timeline' as const, query: timeline },
    { ...site, label: `${site.source} 外貌`, focus: 'appearance' as const, query: appearance },
  ]).filter(item => item.query.trim());
}

async function callMediaWikiSearch(
  api: string,
  query: string,
  source: string,
  focus: NonNullable<DeepSeekFanSearchResult['focus']>,
  settings: DeepSeekFanLookupState,
  mustMatchTerms: string[] = [],
): Promise<{ raw: string; results: DeepSeekFanSearchResult[] }> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(Math.max(1, Math.min(8, settings.searchMaxResults))),
    format: 'json',
    origin: '*',
  });
  const url = `${api}?${params.toString()}`;
  const data = await fanFetchJson(url, { method: 'GET', headers: { Accept: 'application/json' } }, settings.searchTimeoutMs);
  const rows = parseMediaWikiSearchResults(data, api, source, focus, mustMatchTerms);
  return { raw: JSON.stringify(data), results: rows };
}

function parseMediaWikiSearchResults(
  data: unknown,
  api: string,
  source: string,
  focus: NonNullable<DeepSeekFanSearchResult['focus']>,
  mustMatchTerms: string[] = [],
) {
  const rows =
    data && typeof data === 'object' && !Array.isArray(data)
      ? ((data as { query?: { search?: Array<Record<string, unknown>> } }).query?.search ?? [])
      : [];
  const origin = api.replace(/\/api\.php$/i, '');
  return normalizeFanSearchResults(
    rows
      .map(row => {
        const title = String(row.title ?? '').trim();
        const url = `${origin}/${encodeURIComponent(title.replace(/ /g, '_'))}`;
        const snippet = cleanSearchText(String(row.snippet ?? ''));
        if (mustMatchTerms.length && !doesSearchResultMatchTerms({ title, url, snippet }, mustMatchTerms)) return null;
        return annotateFanSearchResult(
          {
            title,
            url,
            snippet,
            source,
          },
          focus,
        );
      })
      .filter((item): item is DeepSeekFanSearchResult => Boolean(item)),
  );
}

function doesSearchResultMatchTerms(
  result: Pick<DeepSeekFanSearchResult, 'title' | 'url' | 'snippet'>,
  terms: string[],
) {
  const titleUrl = normalizeLookupText(`${result.title}\n${decodeURIComponent(result.url)}`);
  return terms.some(term => {
    const normalized = normalizeLookupText(term);
    return titleUrl.includes(normalized);
  });
}

function normalizeLookupText(text: string) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[零〇]/g, '0')
    .replace(/一/g, '1')
    .replace(/二/g, '2')
    .replace(/两/g, '2')
    .replace(/三/g, '3')
    .replace(/四/g, '4')
    .replace(/五/g, '5')
    .replace(/六/g, '6')
    .replace(/七/g, '7')
    .replace(/八/g, '8')
    .replace(/九/g, '9')
    .replace(/\s+/g, '')
    .replace(/[·・:_\-—/／（）()\[\]【】《》「」『』"'“”]/g, '');
}

function normalizeFanResultFocus(raw: unknown): DeepSeekFanSearchResult['focus'] | undefined {
  const value = String(raw ?? '').trim();
  if (value === 'timeline' || value === 'appearance' || value === 'profile') return value;
  return undefined;
}

function annotateFanSearchResult(
  result: DeepSeekFanSearchResult,
  focus: NonNullable<DeepSeekFanSearchResult['focus']>,
): DeepSeekFanSearchResult {
  const source = classifyFanSearchSource(result.url, result.source);
  return {
    ...result,
    source,
    focus,
    priority: scoreFanSearchResult(result, focus, source),
  };
}

function classifyFanSearchSource(url: string, fallback: string) {
  const host = safeHostname(url);
  if (/saenai.*fandom\.com|saekano.*fandom\.com|fandom\.com/i.test(host)) return '路人女主 Wiki';
  if (/moegirl\.org/i.test(host)) return '萌娘百科';
  if (/baike\.baidu\.com/i.test(host)) return '百度百科';
  if (/wikipedia\.org/i.test(host)) return 'Wikipedia';
  return fallback || 'search';
}

function scoreFanSearchResult(
  result: DeepSeekFanSearchResult,
  focus: NonNullable<DeepSeekFanSearchResult['focus']>,
  source: string,
) {
  const haystack = [result.title, result.url, result.snippet].join('\n').toLowerCase();
  let score = 10;
  if (source === '路人女主 Wiki') score += 60;
  if (/路人女主|不起眼女主角|冴えない彼女|saekano|saenai/.test(haystack)) score += 20;
  if (source === '百度百科') score += 50;
  if (source === '萌娘百科') score += 40;
  if (source === 'Wikipedia') score += 15;
  if (focus === 'timeline') score += /时间线|剧情|登场|卷|集|章|年|月|日|timeline/.test(haystack) ? 18 : 8;
  if (focus === 'appearance') score += /外貌|发色|瞳|发型|服装|角色设计|身高|appearance|hair|eyes/.test(haystack) ? 18 : 8;
  if (focus === 'profile') score += /角色|人物|简介|资料|profile|character/.test(haystack) ? 12 : 6;
  return score;
}

function safeHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function normalizeFanSearchResults(raw: unknown): DeepSeekFanSearchResult[] {
  const items = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  return items
    .map(item => {
      const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const title = String(obj.title ?? '').trim() || '搜索结果';
      const url = String(obj.url ?? '').trim();
      const snippet = String(obj.snippet ?? '').trim();
      const source = String(obj.source ?? '').trim() || 'search';
      const focus = normalizeFanResultFocus(obj.focus);
      const priority = Math.max(0, Math.min(100, Math.round(Number(obj.priority ?? 0) || 0)));
      if (!title && !url && !snippet) return null;
      const key = url || `${title}:${snippet.slice(0, 120)}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        title,
        url,
        snippet,
        source,
        ...(focus ? { focus } : {}),
        ...(priority ? { priority } : {}),
      };
    })
    .filter((item): item is DeepSeekFanSearchResult => Boolean(item))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 20);
}

function buildFanSearchContext(results: DeepSeekFanSearchResult[], raw = '') {
  const blocks = results.slice(0, 8).map((result, index) =>
    [
      `[资料 ${index + 1}] ${result.title}`,
      result.url ? `URL：${result.url}` : '',
      result.source ? `来源：${result.source}` : '',
      result.snippet ? `摘要：${result.snippet.slice(0, 1800)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  if (!blocks.length && raw.trim()) return raw.trim().slice(0, 8000);
  return blocks.join('\n\n').slice(0, 12_000);
}

function extractUrlsFromText(text: string, limit: number) {
  const urls: string[] = [];
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && urls.length < limit) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (!/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function normalizeSearxngBaseUrl(raw: string) {
  let base = raw.trim();
  if (!base) return '';
  base = base.replace(/[?#].*$/, '').replace(/\/(search|about|preferences)\/?$/i, '');
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, '');
}

function buildSearxngUrl(base: string, query: string, format: string) {
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('categories', 'general');
  params.set('language', 'auto');
  params.set('safesearch', '0');
  params.set('pageno', '1');
  setOptionalQueryParam(params, 'format', format);
  return `${base}/search?${params.toString()}`;
}

function setOptionalQueryParam(params: URLSearchParams, key: string, value: string) {
  const targetParams = value ? params : null;
  targetParams?.set(key, value);
}

function parseSearxngJsonText(text: string): DeepSeekFanSearchResult[] {
  try {
    const data = JSON.parse(text) as { results?: Array<Record<string, unknown>>; answers?: unknown[] };
    const rows = Array.isArray(data.results) ? data.results : [];
    const results = rows.map((row, index) => ({
      title: String(row.title ?? `SearXNG 结果 ${index + 1}`),
      url: String(row.url ?? row.link ?? ''),
      snippet: String(row.content ?? row.snippet ?? row.description ?? row.pretty_url ?? ''),
      source: String(row.engine ? `searxng:${row.engine}` : 'searxng'),
    }));
    if (Array.isArray(data.answers)) {
      for (const [index, answer] of data.answers.filter(Boolean).slice(0, 3).entries()) {
        results.unshift({ title: `SearXNG Answer ${index + 1}`, url: '', snippet: String(answer), source: 'searxng-answer' });
      }
    }
    return normalizeFanSearchResults(results);
  } catch {
    return [];
  }
}

function normalizeDdgRegion(raw: unknown) {
  const value = String(raw ?? '').trim();
  return DDG_REGION_OPTIONS.has(value) ? value : 'wt-wt';
}

function buildDdgHtmlUrl(query: string, region: string) {
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('kl', normalizeDdgRegion(region));
  params.set('kp', '-2');
  return `https://html.duckduckgo.com/html/?${params.toString()}`;
}

function parseDdgHtmlText(html: string) {
  const results: DeepSeekFanSearchResult[] = [];
  const re = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    results.push({
      title: cleanSearchText(match[2] ?? ''),
      url: normalizeDdgResultUrl(match[1] ?? ''),
      snippet: cleanSearchText(match[3] ?? ''),
      source: 'ddg-html',
    });
  }
  return normalizeFanSearchResults(results);
}

function parseGenericHtmlResults(html: string, source: string) {
  const results: DeepSeekFanSearchResult[] = [];
  const linkRe = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) && results.length < 12) {
    const title = cleanSearchText(match[2] ?? '');
    const url = match[1] ?? '';
    if (!title || !isHttpUrl(url)) continue;
    results.push({ title, url, snippet: '', source });
  }
  return normalizeFanSearchResults(results);
}

function cleanSearchText(text: string) {
  return decodeHtml(String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

const HTML_ENTITY_AMP = String.fromCharCode(38);
const HTML_ENTITY_HASH = String.fromCharCode(35);
const HTML_ENTITY_SEMI = String.fromCharCode(59);

function namedHtmlEntity(name: string) {
  return HTML_ENTITY_AMP + name + HTML_ENTITY_SEMI;
}

function numericHtmlEntity(code: number) {
  return HTML_ENTITY_AMP + HTML_ENTITY_HASH + String(code) + HTML_ENTITY_SEMI;
}

function decodeHtml(text: string) {
  if (typeof document !== 'undefined') {
    const el = document.createElement('textarea');
    el.innerHTML = text;
    return el.value;
  }
  return text
    .replace(new RegExp(namedHtmlEntity('amp'), 'g'), '&')
    .replace(new RegExp(namedHtmlEntity('lt'), 'g'), '<')
    .replace(new RegExp(namedHtmlEntity('gt'), 'g'), '>')
    .replace(new RegExp(namedHtmlEntity('quot'), 'g'), '"')
    .replace(new RegExp(`${numericHtmlEntity(39)}|${namedHtmlEntity('apos')}`, 'g'), String.fromCharCode(39));
}

function normalizeDdgResultUrl(raw: string) {
  let url = decodeHtml(raw.trim());
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('/')) url = `https://duckduckgo.com${url}`;
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    if (parsed.hostname.replace(/^www\./i, '').endsWith('duckduckgo.com') && /^\/l\//i.test(parsed.pathname)) {
      return parsed.searchParams.get('uddg') || parsed.href;
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function isHttpUrl(url: string) {
  return /^https?:\/\//i.test(url.trim());
}

function parseProfileObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function getProfileString(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value.map(item => String(item ?? '').trim()).filter(Boolean).join('；');
      if (joined) return joined;
    }
  }
  return '';
}

function getProfileStringArray(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value.map(item => String(item ?? '').trim()).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return value.split(/[、,，;\n；]+/).map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeProfileRelationships(raw: unknown): Array<{ name: string; text: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (typeof item === 'string') return { name: '', text: item.trim() };
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const name = String(obj.name ?? obj.target ?? obj.role ?? '').trim();
      const text = String(obj.text ?? obj.description ?? obj.relationship ?? '').trim();
      if (!name && !text) return null;
      return { name, text: text || name };
    })
    .filter((item): item is { name: string; text: string } => Boolean(item));
}

function summarizeFanSearchForFallback(state: DeepSeekFanLookupState) {
  const snippets = state.searchResults
    .map(result => [result.title, result.snippet].filter(Boolean).join('：'))
    .filter(Boolean)
    .join('\n');
  const source = snippets || state.searchContext;
  return source
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 480);
}

function buildFanProfileContent(profile: DeepSeekFanGeneratedProfile) {
  const relationships = profile.relationships.length
    ? profile.relationships.map(item => `- ${[item.name, item.text].filter(Boolean).join('：')}`).join('\n')
    : '- 资料不足';
  const uncertain = profile.uncertain.length ? profile.uncertain.map(item => `- ${item}`).join('\n') : '- 暂无';
  return [
    `姓名：${profile.name}`,
    `作品：${profile.sourceWork}`,
    `别名：${profile.aliases.join(' / ') || '资料不足'}`,
    `性别：${profile.gender}`,
    `年龄：${profile.age}`,
    `生日：${profile.birthday}`,
    '',
    `身份：${profile.identity}`,
    '',
    `外貌：${profile.appearance}`,
    '',
    `性格：${profile.personality}`,
    '',
    `口吻：${profile.speech}`,
    '',
    `心理与行为模式：${profile.psychologyBehavior}`,
    '',
    `能力：${profile.abilities}`,
    '',
    `背景：${profile.background}`,
    '',
    '关系网：',
    relationships,
    '',
    '不确定点：',
    uncertain,
  ].join('\n');
}

function defaultFanSystemTemplate() {
  return [
    '你是同人角色设定整理助手。请根据用户给出的作品名、角色名、补充要求与【本页搜索资料】，整理一份手动预览用的角色运行设定。',
    '你不会也不应该自行联网；只能使用用户输入和本页已经提供的搜索资料。',
    '核心目标：这不是百科摘要，也不是资料来源报告，而是角色运行设定。重点是角色是谁、如何表现、为什么这样表现、在互动中会怎样反应。',
    '只输出严格 JSON，不要 Markdown，不要代码块，不要额外解释。',
    '不要为了补全字段编造年龄、生日、童年、关系或能力。资料不足时写“资料不足”，并在 uncertain 中记录不确定点。',
    '特别注意：优先判断作品时间点/剧情阶段，避免把后期设定倒灌到早期；外貌字段要尽量校准发色、瞳色、发型、服装与角色设计。',
    '官方设定、常见推测、同人扩展不要混淆；不确定、冲突、疑似粉丝推测的内容放入 uncertain。',
    'JSON 键必须包含：name, sourceWork, aliases, gender, age, birthday, identity, appearance, personality, speech, psychologyBehavior, abilities, background, relationships, uncertain, entryTitle。',
  ].join('\n');
}

function uniq(values: string[]) {
  return Array.from(new Set(values.map(value => String(value ?? '').trim()).filter(Boolean)));
}

async function requestEvidencePack(
  settings: DeepSeekWebLookupSettings,
  request: DeepSeekLookupRequest,
  statusData: StatusData,
) {
  const searched = await callDeepSeekDdgSearch(request, settings);
  const pack = buildDdgEvidencePack(request, statusData, searched.results);
  return pack ? [pack] : [];
}

async function callDeepSeekDdgSearch(request: DeepSeekLookupRequest, settings: DeepSeekWebLookupSettings) {
  const baseSettings = {
    ...DEFAULT_DEEPSEEK_FAN_LOOKUP_STATE,
    searchDdgRegion: settings.searchDdgRegion,
    searchTimeoutMs: settings.timeoutMs,
    searchMaxResults: Math.max(1, Math.min(8, settings.maxEvidencePacks * 2)),
  };
  const results: DeepSeekFanSearchResult[] = [];
  const rawBlocks: string[] = [];
  const errors: string[] = [];
  for (const query of buildDeepSeekDdgQueries(request, settings)) {
    for (const wiki of buildDeepSeekMediaWikiQueries(query, request)) {
      try {
        const searched = await callMediaWikiSearch(
          wiki.api,
          wiki.query,
          wiki.source,
          wiki.focus,
          baseSettings,
          wiki.mustMatchTerms,
        );
        rawBlocks.push(`[${wiki.source}:${wiki.query}]\n${searched.raw}`);
        results.push(...searched.results);
      } catch (wikiError) {
        errors.push(`${wiki.source}:${wiki.query} -> ${wikiError instanceof Error ? wikiError.message : String(wikiError)}`);
      }
    }
    if (normalizeFanSearchResults(results).length >= baseSettings.searchMaxResults) break;
    try {
      const searched = await callDdgSearch(query, baseSettings);
      rawBlocks.push(searched.raw);
      results.push(...searched.results);
    } catch (error) {
      errors.push(`DDG:${query} -> ${error instanceof Error ? error.message : String(error)}`);
      try {
        const searched = await callJinaSearch(query, baseSettings);
        rawBlocks.push(searched.raw);
        results.push(...searched.results.map(result => annotateFanSearchResult(result, request.detailType === 'appearance' ? 'appearance' : request.detailType === 'timeline' ? 'timeline' : 'profile')));
      } catch (jinaError) {
        errors.push(`Jina:${query} -> ${jinaError instanceof Error ? jinaError.message : String(jinaError)}`);
      }
    }
    if (normalizeFanSearchResults(results).length >= baseSettings.searchMaxResults) break;
  }
  const normalized = normalizeFanSearchResults(results).slice(0, baseSettings.searchMaxResults);
  if (!normalized.length && errors.length) throw new Error(errors.slice(0, 3).join('；'));
  return { raw: rawBlocks.join('\n\n'), results: normalized };
}

function buildDeepSeekMediaWikiQueries(query: string, request: DeepSeekLookupRequest) {
  const focus: NonNullable<DeepSeekFanSearchResult['focus']> =
    request.intent === 'appearance' || request.detailType === 'appearance'
      ? 'appearance'
      : request.intent === 'canon_timeline' || request.detailType === 'timeline'
        ? 'timeline'
        : 'profile';
  const coreTerms = extractCoreLookupTerms(query);
  const aliases = buildLookupAliases(coreTerms[0] || query);
  const queries = Array.from(
    new Set([
      ...aliases.flatMap(alias => [`intitle:${alias}`, alias]),
      query,
    ].filter(Boolean)),
  ).slice(0, 5);
  const sites = [
    { source: 'Wikipedia', api: 'https://zh.wikipedia.org/w/api.php' },
    { source: '萌娘百科', api: 'https://zh.moegirl.org.cn/api.php' },
  ];
  return sites.flatMap(site => queries.map(item => ({ ...site, query: item, focus, mustMatchTerms: aliases.length ? aliases : coreTerms })));
}

function extractCoreLookupTerms(query: string) {
  const terms = String(query ?? '').match(/[\u30a0-\u30ffー]{2,}|[A-Za-z][A-Za-z0-9'’.-]{2,}|[\u4e00-\u9fff]{2,10}/g) ?? [];
  const stopWords = /^(结局|剧情|剧情概要|概要|时间线|外貌|设定|基础设定|主题|主题分析|剧情解析|剧情分析|擦肩而过|列车|错过主题|官方|百度百科|萌娘百科|wiki)$/i;
  return terms
    .map(term => term.trim())
    .filter(term => term && !stopWords.test(term))
    .slice(0, 3);
}

function buildLookupAliases(core: string) {
  const value = String(core ?? '').trim();
  if (!value) return [];
  const aliases = new Set([value, value.normalize('NFKC')]);
  for (const item of Array.from(aliases)) {
    aliases.add(replaceChineseNumeralsWithDigits(item));
    aliases.add(replaceDigitsWithChineseNumerals(item));
    aliases.add(item.replace(/\s+/g, ''));
  }
  return Array.from(aliases).filter(Boolean).slice(0, 6);
}

function replaceChineseNumeralsWithDigits(text: string) {
  const digitMap: Record<string, string> = {
    零: '0',
    〇: '0',
    一: '1',
    二: '2',
    两: '2',
    三: '3',
    四: '4',
    五: '5',
    六: '6',
    七: '7',
    八: '8',
    九: '9',
  };
  return String(text ?? '').replace(/[零〇一二两三四五六七八九]/g, value => digitMap[value] ?? value);
}

function replaceDigitsWithChineseNumerals(text: string) {
  const digitMap: Record<string, string> = {
    '0': '零',
    '1': '一',
    '2': '二',
    '3': '三',
    '4': '四',
    '5': '五',
    '6': '六',
    '7': '七',
    '8': '八',
    '9': '九',
  };
  return String(text ?? '').replace(/\d/g, value => digitMap[value] ?? value);
}

function buildDeepSeekDdgQueries(request: DeepSeekLookupRequest, settings: DeepSeekWebLookupSettings) {
  if (settings.searchSource !== 'encyclopedia' || request.intent === 'fact_check') return [request.query];
  const focus =
    request.intent === 'appearance' || request.detailType === 'appearance'
      ? '外貌 发色 瞳色 发型 服装 角色设计'
      : '时间线 登场 剧情 卷数 集数';
  return [
    `${request.query} ${focus} 路人女主 wiki OR Saekano Wiki`,
    `${request.query} ${focus} site:baike.baidu.com 百度百科`,
    `${request.query} ${focus} site:zh.moegirl.org.cn 萌娘百科`,
    `${request.query} ${focus}`,
  ];
}

function buildDdgEvidencePack(
  request: DeepSeekLookupRequest,
  statusData: StatusData,
  results: DeepSeekFanSearchResult[],
): DeepSeekEvidencePack | null {
  const rows = normalizeFanSearchResults(results).slice(0, 5);
  if (!rows.length) return null;
  const kind: DeepSeekEvidencePack['kind'] =
    request.intent === 'appearance' || request.detailType === 'appearance'
      ? 'APPEARANCE'
      : request.intent === 'canon_timeline' || request.detailType === 'timeline'
        ? 'CANON_FACT'
        : 'DETAIL';
  const facts = rows
    .map(item => [item.title, item.snippet].filter(Boolean).join('：').slice(0, 260))
    .filter(Boolean);
  return {
    kind,
    characterId: request.characterId,
    source: rows.map(item => `${item.source}:${item.url}`).filter(Boolean).slice(0, 3).join(' | ') || 'DDG',
    confidence: 'medium',
    facts,
    mustFollow: facts.slice(0, 3),
    mustNotInfer:
      kind === 'APPEARANCE'
        ? ['不得补充未在世界书、近期正文或联网证据中出现的外貌细节。']
        : request.intent === 'fact_check'
          ? ['不得把搜索摘要当成绝对权威；只用来校准玩家输入中的店名、地点或事实，不要扩写无关百科。']
          : ['不得把后期资料倒灌为当前时间点已经发生的事实。'],
    appliesWhen: `${request.reason} 当前世界时间：${statusData.world.currentTime}；地点：${statusData.world.currentLocation}`,
  };
}

function normalizeEvidencePacks(raw: unknown): DeepSeekEvidencePack[] {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return items
    .map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const obj = item as Record<string, unknown>;
      const kind = pickEnum(obj.kind, ['CANON_FACT', 'APPEARANCE', 'DETAIL', 'BOOTSTRAP'] as const, 'CANON_FACT');
      const confidence = pickEnum(obj.confidence, ['low', 'medium', 'high'] as const, 'low');
      const facts = parseStringList(obj.facts ?? obj.fact, 8);
      const mustFollow = parseStringList(obj.mustFollow, 8);
      const mustNotInfer = parseStringList(obj.mustNotInfer ?? obj.mustNotInvent, 8);
      if (!facts.length && !mustFollow.length && !mustNotInfer.length) return null;
      return {
        kind,
        characterId: String(obj.characterId ?? '').trim() || undefined,
        source: String(obj.source ?? 'web-search').trim() || 'web-search',
        confidence,
        facts,
        mustFollow,
        mustNotInfer,
        appliesWhen: String(obj.appliesWhen ?? '').trim() || undefined,
      };
    })
    .filter((pack): pack is DeepSeekEvidencePack => Boolean(pack));
}

function parseStringList(raw: unknown, limit: number) {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\n+/) : [];
  return values
    .map(value => String(value ?? '').replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const value = String(raw ?? '').trim();
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function getCacheKey(settings: DeepSeekWebLookupSettings, request: DeepSeekLookupRequest) {
  return `${CACHE_PREFIX}${settings.searchSource}:${settings.searchDdgRegion}:${request.intent}:${request.characterId ?? 'global'}:${request.query.toLowerCase().replace(/\s+/g, ' ')}`;
}

function readCachedEvidence(settings: DeepSeekWebLookupSettings, request: DeepSeekLookupRequest): DeepSeekEvidencePack[] | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(getCacheKey(settings, request));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { createdAt?: number; evidencePacks?: unknown };
    if (!parsed.createdAt || Date.now() - parsed.createdAt > CACHE_TTL_MS) return null;
    const packs = normalizeEvidencePacks(parsed.evidencePacks);
    return packs.length ? packs : null;
  } catch {
    return null;
  }
}

function writeCachedEvidence(settings: DeepSeekWebLookupSettings, request: DeepSeekLookupRequest, evidencePacks: DeepSeekEvidencePack[]) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getCacheKey(settings, request), JSON.stringify({ createdAt: Date.now(), evidencePacks }));
  } catch {
    // localStorage may be full or unavailable inside sandboxed iframes; lookup can still proceed without cache.
  }
}
