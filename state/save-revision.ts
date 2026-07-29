export const BROWSER_REVISION_FIELD = 'browserRevision' as const;

export type BrowserRevisionCarrier = Record<string, unknown> & {
  browserRevision?: number;
};

export function normalizeBrowserRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isFinite(revision) || revision < 0) return 0;
  return Math.floor(revision);
}

export function readBrowserRevision(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  return normalizeBrowserRevision((value as BrowserRevisionCarrier)[BROWSER_REVISION_FIELD]);
}

export function nextBrowserRevision(...values: unknown[]): number {
  return values.reduce<number>((highest, value) => Math.max(highest, readBrowserRevision(value)), 0) + 1;
}

export function withBrowserRevision<T extends Record<string, unknown>>(value: T, revision: number): T {
  return {
    ...value,
    [BROWSER_REVISION_FIELD]: normalizeBrowserRevision(revision),
  };
}

export function isIncomingRevisionStale(input: {
  incoming: unknown;
  current?: unknown;
  pendingRevision?: number;
  knownRevision?: number;
}): boolean {
  const incoming = readBrowserRevision(input.incoming);
  const current = readBrowserRevision(input.current);
  const pending = normalizeBrowserRevision(input.pendingRevision);
  const known = normalizeBrowserRevision(input.knownRevision);
  return incoming < Math.max(current, pending, known);
}
