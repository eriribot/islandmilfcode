import type { StatusData, TargetStatus } from '../types';

export const DEEPSEEK_WEB_LOOKUP_REQUEST_EVENT = 'islandmilfcode-deepseek-web-lookup-request';
export const DEEPSEEK_WEB_LOOKUP_RESPONSE_EVENT = 'islandmilfcode-deepseek-web-lookup-response';

export type DeepSeekWebLookupSettings = {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  maxEvidencePacks: number;
  preferExtensionBridge: boolean;
  allowSidecarFallback: boolean;
};

export type DeepSeekLookupIntent =
  | 'canon_timeline'
  | 'appearance'
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
};

const DEFAULT_SETTINGS: DeepSeekWebLookupSettings = {
  enabled: false,
  endpoint: 'http://127.0.0.1:8787/lookup-character-detail',
  timeoutMs: 6000,
  maxEvidencePacks: 4,
  preferExtensionBridge: true,
  allowSidecarFallback: false,
};

const CACHE_PREFIX = 'islandmilfcode:deepseek-web-evidence:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeDeepSeekWebLookupSettings(input: unknown): DeepSeekWebLookupSettings {
  const raw = input && typeof input === 'object' ? (input as Partial<DeepSeekWebLookupSettings>) : {};
  return {
    enabled: Boolean(raw.enabled),
    endpoint: String(raw.endpoint || DEFAULT_SETTINGS.endpoint).trim() || DEFAULT_SETTINGS.endpoint,
    timeoutMs: Math.max(1000, Math.min(30_000, Math.round(Number(raw.timeoutMs ?? DEFAULT_SETTINGS.timeoutMs) || DEFAULT_SETTINGS.timeoutMs))),
    maxEvidencePacks: Math.max(
      1,
      Math.min(8, Math.round(Number(raw.maxEvidencePacks ?? DEFAULT_SETTINGS.maxEvidencePacks) || DEFAULT_SETTINGS.maxEvidencePacks)),
    ),
    preferExtensionBridge: raw.preferExtensionBridge !== false,
    allowSidecarFallback: raw.allowSidecarFallback === true,
  };
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
  for (const request of requests.slice(0, settings.maxEvidencePacks)) {
    const cached = readCachedEvidence(request);
    if (cached) {
      evidencePacks.push(...cached);
      continue;
    }

    try {
      const fresh = await requestEvidencePack(settings, request, input.statusData);
      if (fresh.length) {
        writeCachedEvidence(request, fresh);
        evidencePacks.push(...fresh);
      }
    } catch (error) {
      return {
        enabled: true,
        requests,
        evidencePacks,
        context: buildDeepSeekEvidenceContext(evidencePacks),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    enabled: true,
    requests,
    evidencePacks,
    context: buildDeepSeekEvidenceContext(evidencePacks),
  };
}

export function buildDeepSeekEvidenceContext(evidencePacks: DeepSeekEvidencePack[]) {
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
        '这些证据包只用于 scenePresence 的 present/focus/absent/uncertain、appearanceGuards 和 canon 时间线判定；不要复述网页原文。',
        '若证据包与最近正文已经发生的蝴蝶效应冲突，以最近正文的新因果为准，并在 plotImpact/evidence 中写明覆盖原因。',
        ...packs,
      ].join('\n\n')
    : '';
}

function planDeepSeekLookupRequests(input: DeepSeekWebLookupInput): DeepSeekLookupRequest[] {
  const text = `${input.userInput}\n${input.recentText}`.toLowerCase();
  const requests: DeepSeekLookupRequest[] = [];

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

async function requestEvidencePack(
  settings: DeepSeekWebLookupSettings,
  request: DeepSeekLookupRequest,
  statusData: StatusData,
) {
  if (settings.preferExtensionBridge) {
    const bridgeResult = await requestEvidencePackViaExtension(settings, request, statusData);
    if (bridgeResult) return bridgeResult;
  }
  if (!settings.allowSidecarFallback) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request,
        worldTime: statusData.world.currentTime,
        location: statusData.world.currentLocation,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`sidecar-http-${response.status}`);
    const data = await response.json();
    return normalizeEvidencePacks(data?.evidencePacks ?? data?.evidence ?? data);
  } finally {
    clearTimeout(timeout);
  }
}

function getEventApi() {
  const api = globalThis as {
    eventEmit?: (eventType: string, ...args: any[]) => Promise<void> | void;
    eventOn?: (eventType: string, listener: (...args: any[]) => void) => { stop?: () => void } | void;
    eventRemoveListener?: (eventType: string, listener: (...args: any[]) => void) => void;
  };
  return api;
}

function createLookupRequestId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `islandmilfcode-ds-web-${random}`;
}

function requestEvidencePackViaExtension(
  settings: DeepSeekWebLookupSettings,
  request: DeepSeekLookupRequest,
  statusData: StatusData,
): Promise<DeepSeekEvidencePack[] | null> {
  const api = getEventApi();
  if (typeof api.eventEmit !== 'function' || typeof api.eventOn !== 'function') {
    return Promise.resolve(null);
  }

  const id = createLookupRequestId();
  const payload = {
    id,
    request,
    worldTime: statusData.world.currentTime,
    location: statusData.world.currentLocation,
  };

  return new Promise(resolve => {
    let settled = false;
    let subscription: { stop?: () => void } | void;
    const cleanup = () => {
      subscription?.stop?.();
      api.eventRemoveListener?.(DEEPSEEK_WEB_LOOKUP_RESPONSE_EVENT, onResponse);
    };
    const finish = (value: DeepSeekEvidencePack[] | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onResponse = (response: unknown) => {
      if (!response || typeof response !== 'object' || Array.isArray(response)) return;
      const obj = response as Record<string, unknown>;
      if (obj.id !== id) return;
      const packs = normalizeEvidencePacks(obj.evidencePacks ?? obj.evidence);
      finish(packs.length ? packs : null);
    };

    subscription = api.eventOn(DEEPSEEK_WEB_LOOKUP_RESPONSE_EVENT, onResponse);
    setTimeout(() => finish(null), settings.timeoutMs);
    Promise.resolve(api.eventEmit(DEEPSEEK_WEB_LOOKUP_REQUEST_EVENT, payload)).catch(() => finish(null));
  });
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
        source: String(obj.source ?? 'web-sidecar').trim() || 'web-sidecar',
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

function getCacheKey(request: DeepSeekLookupRequest) {
  return `${CACHE_PREFIX}${request.intent}:${request.characterId ?? 'global'}:${request.query.toLowerCase().replace(/\s+/g, ' ')}`;
}

function readCachedEvidence(request: DeepSeekLookupRequest): DeepSeekEvidencePack[] | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(getCacheKey(request));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { createdAt?: number; evidencePacks?: unknown };
    if (!parsed.createdAt || Date.now() - parsed.createdAt > CACHE_TTL_MS) return null;
    const packs = normalizeEvidencePacks(parsed.evidencePacks);
    return packs.length ? packs : null;
  } catch {
    return null;
  }
}

function writeCachedEvidence(request: DeepSeekLookupRequest, evidencePacks: DeepSeekEvidencePack[]) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getCacheKey(request), JSON.stringify({ createdAt: Date.now(), evidencePacks }));
  } catch {
    // localStorage may be full or unavailable inside sandboxed iframes; lookup can still proceed without cache.
  }
}
