import type { SummaryModelOption } from '../summary/types';

export function buildSummaryModelsUrl(apiurl: string): string {
  const url = new URL(apiurl);
  const path = url.pathname.replace(/\/+$/, '');

  if (/\/models$/i.test(path)) return url.toString();

  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path.replace(/\/chat\/completions$/i, '/models');
    return url.toString();
  }

  if (/\/(completions|responses)$/i.test(path)) {
    url.pathname = path.replace(/\/(completions|responses)$/i, '/models');
    return url.toString();
  }

  url.pathname = path ? `${path}/models` : '/v1/models';
  return url.toString();
}

export function parseSummaryModelsResponse(payload: unknown): SummaryModelOption[] {
  const rawList =
    payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray(payload)
        ? payload
        : [];
  const byId = new Map<string, SummaryModelOption>();

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { id?: unknown; name?: unknown; owned_by?: unknown; ownedBy?: unknown };
    const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
    if (!id) continue;
    const ownedBy =
      typeof item.owned_by === 'string' ? item.owned_by : typeof item.ownedBy === 'string' ? item.ownedBy : undefined;
    byId.set(id, { id, ...(ownedBy ? { ownedBy } : {}) });
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}
