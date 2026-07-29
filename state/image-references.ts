import {
  IDB_STORE_IMAGE_REFERENCES_V3,
  idbGet,
  idbGetAll,
  idbPut,
} from './idb';

type ImageReferenceRecord = {
  ownerKey: string;
  assetIds: string[];
  updatedAt: number;
};

type ImageGcCandidate = {
  assetId: string;
  firstSeenUnreferencedAt: number;
  confirmations: number;
};

const pendingAssetIds = new Set<string>();

export function registerPendingImageAsset(assetId: string) {
  if (assetId) pendingAssetIds.add(assetId);
}

export function clearPendingImageAsset(assetId: string) {
  pendingAssetIds.delete(assetId);
}

export function getPendingImageAssetIds() {
  return new Set(pendingAssetIds);
}

export async function replaceImageAssetReferences(ownerKey: string, assetIds: Iterable<string>) {
  const normalized = [...new Set([...assetIds].filter(Boolean))].sort();
  await idbPut<ImageReferenceRecord>(IDB_STORE_IMAGE_REFERENCES_V3, `owner:${ownerKey}`, {
    ownerKey,
    assetIds: normalized,
    updatedAt: Date.now(),
  });
}

export async function readImageAssetReferences(ownerKey: string): Promise<string[]> {
  const record = await idbGet<ImageReferenceRecord>(IDB_STORE_IMAGE_REFERENCES_V3, `owner:${ownerKey}`);
  return record?.assetIds ?? [];
}

export async function listReferencedImageAssetIds(): Promise<Set<string>> {
  const rows = await idbGetAll<ImageReferenceRecord>(IDB_STORE_IMAGE_REFERENCES_V3);
  const result = new Set<string>();
  for (const row of rows) {
    if (!row.id.startsWith('owner:')) continue;
    row.value.assetIds?.forEach(id => result.add(id));
  }
  return result;
}

/** Returns true only on a later confirmed pass (minimum 24 hours apart). */
export async function markImageGcCandidate(assetId: string): Promise<boolean> {
  const key = `gc:${assetId}`;
  const previous = await idbGet<ImageGcCandidate>(IDB_STORE_IMAGE_REFERENCES_V3, key);
  const now = Date.now();
  if (!previous) {
    await idbPut<ImageGcCandidate>(IDB_STORE_IMAGE_REFERENCES_V3, key, {
      assetId,
      firstSeenUnreferencedAt: now,
      confirmations: 1,
    });
    return false;
  }
  const confirmations = previous.confirmations + 1;
  await idbPut<ImageGcCandidate>(IDB_STORE_IMAGE_REFERENCES_V3, key, { ...previous, confirmations });
  return confirmations >= 2 && now - previous.firstSeenUnreferencedAt >= 24 * 60 * 60 * 1000;
}
