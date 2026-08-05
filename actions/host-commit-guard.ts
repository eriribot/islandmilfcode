const inFlightHostTimelineWrites = new Set<Promise<void>>();
const protectedGenerationCounts = new Map<string, number>();
let hostTimelineWriteTail: Promise<void> = Promise.resolve();

export async function runHostTimelineWrite<T>(operation: () => Promise<T>): Promise<T> {
  const previousWrite = hostTimelineWriteTail;
  let release!: () => void;
  const settled = new Promise<void>(resolve => {
    release = resolve;
  });
  hostTimelineWriteTail = previousWrite.then(() => settled, () => settled);
  inFlightHostTimelineWrites.add(settled);
  try {
    await previousWrite.catch(() => undefined);
    return await operation();
  } finally {
    inFlightHostTimelineWrites.delete(settled);
    release();
  }
}

export function isHostCommitGenerationProtected(generationId: string): boolean {
  return Boolean(generationId && protectedGenerationCounts.has(generationId));
}

export async function runProtectedHostTimelineWrite<T>(
  generationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!generationId) return runHostTimelineWrite(operation);
  protectedGenerationCounts.set(generationId, (protectedGenerationCounts.get(generationId) ?? 0) + 1);
  try {
    return await runHostTimelineWrite(operation);
  } finally {
    const remaining = (protectedGenerationCounts.get(generationId) ?? 1) - 1;
    if (remaining > 0) protectedGenerationCounts.set(generationId, remaining);
    else protectedGenerationCounts.delete(generationId);
  }
}

export async function waitForHostTimelineWrites(): Promise<void> {
  while (inFlightHostTimelineWrites.size) {
    await Promise.all([...inFlightHostTimelineWrites]);
  }
}
