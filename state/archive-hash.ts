function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function fallbackHash(bytes: Uint8Array): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const byte of bytes) {
    left ^= byte;
    left = Math.imul(left, 0x01000193) >>> 0;
    right ^= left + byte + ((right << 6) >>> 0) + (right >>> 2);
    right >>>= 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

export async function hashArchiveValue(value: unknown): Promise<{
  hash: string;
  json: string;
  byteLength: number;
}> {
  const serialized = JSON.stringify(stableValue(value));
  if (typeof serialized !== 'string') throw new Error('Archive value is not JSON serializable');
  const json = serialized;
  const bytes = new TextEncoder().encode(json);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { hash: `sha256:${hash}`, json, byteLength: bytes.byteLength };
  }
  return { hash: `fnv64:${fallbackHash(bytes)}`, json, byteLength: bytes.byteLength };
}
