import { IDB_STORE_IMAGE_ASSETS, idbDelete, idbGet, idbGetAll, idbPut } from './idb';

export type ImageAssetRecord = {
  id: string;
  blob: Blob;
  mimeType: string;
  byteLength: number;
  createdAt: number;
  prompt?: string;
};

export type ImageAssetBackupRecord = {
  id: string;
  dataUrl: string;
  mimeType: string;
  byteLength: number;
  createdAt: number;
  prompt?: string;
};

const MAX_OBJECT_URL_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_OBJECT_URL_CACHE_FLOORS = 5;
const MAX_HYDRATE_CONCURRENCY = 2;

const assetMap = new Map<string, ImageAssetRecord>();
const pendingWrites = new Set<Promise<unknown>>();
const objectUrlCache = new Map<string, { url: string; byteLength: number; lastAccessed: number; floorKey: string }>();

let initialized = false;
let initPromise: Promise<void> | null = null;

function trackWrite(promise: Promise<unknown>) {
  pendingWrites.add(promise);
  promise.finally(() => pendingWrites.delete(promise));
  return promise;
}

function createAssetId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `img-${random}`;
}

function dataUrlToBlob(dataUrl: string) {
  const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) throw new Error('Invalid image data URL');
  const mimeType = match[1] || 'image/png';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return {
    blob: new Blob([bytes], { type: mimeType }),
    mimeType,
    byteLength: bytes.byteLength,
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image asset'));
    reader.readAsDataURL(blob);
  });
}

export function isInlineImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\//i.test(value.trim());
}

export async function initImageAssetStore() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const rows = await idbGetAll<ImageAssetRecord>(IDB_STORE_IMAGE_ASSETS);
    assetMap.clear();
    for (const row of rows) {
      if (row.value?.id && row.value?.blob instanceof Blob) {
        assetMap.set(row.id, row.value);
      }
    }
    initialized = true;
  })();
  return initPromise;
}

export async function flushImageAssetStore() {
  await Promise.allSettled([...pendingWrites]);
}

export function persistInlineImageDataAsAssetSync(dataUrl: string, meta: { prompt?: string; id?: string } = {}) {
  if (!isInlineImageDataUrl(dataUrl)) return '';
  const { blob, mimeType, byteLength } = dataUrlToBlob(dataUrl);
  const id = meta.id || createAssetId();
  const record: ImageAssetRecord = {
    id,
    blob,
    mimeType,
    byteLength,
    createdAt: Date.now(),
    prompt: meta.prompt,
  };
  assetMap.set(id, record);
  trackWrite(idbPut(IDB_STORE_IMAGE_ASSETS, id, record));
  return id;
}

export async function saveImageDataUrlAsAsset(dataUrl: string, meta: { prompt?: string; id?: string } = {}) {
  const id = persistInlineImageDataAsAssetSync(dataUrl, meta);
  if (!id) throw new Error('Image generation did not return a data URL');
  await flushImageAssetStore();
  return id;
}

export async function restoreImageAssetFromBackup(record: ImageAssetBackupRecord) {
  if (!record?.id || !isInlineImageDataUrl(record.dataUrl)) return false;
  const id = persistInlineImageDataAsAssetSync(record.dataUrl, {
    id: record.id,
    prompt: record.prompt,
  });
  return Boolean(id);
}

export function getCachedImageAssetObjectUrl(assetId: string) {
  const cached = objectUrlCache.get(assetId);
  if (!cached) return '';
  cached.lastAccessed = Date.now();
  return cached.url;
}

function pruneObjectUrlCache() {
  let totalBytes = [...objectUrlCache.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
  const floorKeys = () => new Set([...objectUrlCache.values()].map(entry => entry.floorKey));
  const sorted = () => [...objectUrlCache.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

  while (totalBytes > MAX_OBJECT_URL_CACHE_BYTES || floorKeys().size > MAX_OBJECT_URL_CACHE_FLOORS) {
    const [assetId, entry] = sorted()[0] ?? [];
    if (!assetId || !entry) break;
    URL.revokeObjectURL(entry.url);
    objectUrlCache.delete(assetId);
    totalBytes -= entry.byteLength;
  }
}

export async function loadImageAssetObjectUrl(assetId: string, floorKey: string) {
  const cached = objectUrlCache.get(assetId);
  if (cached) {
    cached.lastAccessed = Date.now();
    cached.floorKey = floorKey;
    return cached.url;
  }

  const record = assetMap.get(assetId) ?? await idbGet<ImageAssetRecord>(IDB_STORE_IMAGE_ASSETS, assetId);
  if (!record?.blob) throw new Error(`Image asset not found: ${assetId}`);
  assetMap.set(assetId, record);

  const url = URL.createObjectURL(record.blob);
  objectUrlCache.set(assetId, {
    url,
    byteLength: record.byteLength || record.blob.size || 0,
    lastAccessed: Date.now(),
    floorKey,
  });
  pruneObjectUrlCache();
  return url;
}

export function hydrateImageAssetElements(root: ParentNode, floorKey: string) {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-image-asset-id]'))
    .filter(img => !img.dataset.imageAssetLoaded && !img.dataset.imageAssetLoading);
  let cursor = 0;
  let active = 0;

  const pump = () => {
    while (active < MAX_HYDRATE_CONCURRENCY && cursor < images.length) {
      const img = images[cursor++];
      const assetId = img.dataset.imageAssetId;
      if (!assetId) continue;
      const cached = getCachedImageAssetObjectUrl(assetId);
      if (cached) {
        img.src = cached;
        img.dataset.imageAssetLoaded = '1';
        continue;
      }

      active += 1;
      img.dataset.imageAssetLoading = '1';
      loadImageAssetObjectUrl(assetId, floorKey)
        .then(url => {
          if (img.isConnected) {
            img.src = url;
            img.dataset.imageAssetLoaded = '1';
            img.classList.add('is-loaded');
          }
        })
        .catch(error => {
          img.dataset.imageAssetError = error instanceof Error ? error.message : String(error);
          if (img.hasAttribute('data-phone-avatar-image')) {
            img.remove();
          } else {
            img.classList.add('is-error');
          }
        })
        .finally(() => {
          delete img.dataset.imageAssetLoading;
          active -= 1;
          pump();
        });
    }
  };

  pump();
}

export async function exportImageAssetsForIds(assetIds: Iterable<string>): Promise<ImageAssetBackupRecord[]> {
  const ids = [...new Set([...assetIds].filter(Boolean))];
  const records: ImageAssetBackupRecord[] = [];
  for (const id of ids) {
    const record = assetMap.get(id) ?? await idbGet<ImageAssetRecord>(IDB_STORE_IMAGE_ASSETS, id);
    if (!record?.blob) continue;
    assetMap.set(id, record);
    records.push({
      id,
      dataUrl: await blobToDataUrl(record.blob),
      mimeType: record.mimeType,
      byteLength: record.byteLength || record.blob.size || 0,
      createdAt: record.createdAt || Date.now(),
      prompt: record.prompt,
    });
  }
  return records;
}

export async function deleteImageAssetsExcept(usedAssetIds: Iterable<string>) {
  const used = new Set(usedAssetIds);
  const deletes: Promise<void>[] = [];
  for (const id of assetMap.keys()) {
    if (used.has(id)) continue;
    const cached = objectUrlCache.get(id);
    if (cached) URL.revokeObjectURL(cached.url);
    objectUrlCache.delete(id);
    assetMap.delete(id);
    deletes.push(idbDelete(IDB_STORE_IMAGE_ASSETS, id));
  }
  await Promise.allSettled(deletes);
}

export function isImageAssetStoreInitialized() {
  return initialized;
}
