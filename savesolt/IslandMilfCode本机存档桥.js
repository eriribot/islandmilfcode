(() => {
  'use strict';

  const PROTOCOL_VERSION = 2;
  const REQUEST_EVENT = 'islandmilfcode:tavern-backup:request:v2';
  const RESPONSE_EVENT = 'islandmilfcode:tavern-backup:response:v2';
  const LEGACY_REQUEST_EVENT = 'islandmilfcode:tavern-backup:request:v1';
  const LEGACY_RESPONSE_EVENT = 'islandmilfcode:tavern-backup:response:v1';
  const RUNTIME_KEY = '__islandmilfcodeTavernBackupBridgeV2__';
  const PUBLIC_FILE_ROOT = '/user/files';
  const BUNDLE_FILE = 'islandmilfcode-backups-v2.json';
  const LEGACY_INDEX_FILE = 'islandmilfcode-backup-index-v1.json';
  const AVATAR_IMAGE_FOLDER = 'islandmilfcode-avatars';
  const SAVE_ASSET_FOLDER_PREFIX = 'islandmilfcode-assets-';
  const FORMAT = 'islandmilfcode-tavern-backup';
  const ENVELOPE_VERSION = 1;
  const BUNDLE_VERSION = 2;
  const ARCHIVE_REGISTRY_FILE = 'islandmilfcode-archive-registry-v3.json';
  const ARCHIVE_PROBE_FILE = 'islandmilfcode-archive-probe-v3.json';
  const ARCHIVE_OBJECT_DIRECTORY = 'islandmilfcode-v3';
  const ARCHIVE_IMAGE_DIRECTORY_PATH = '/user/images/islandmilfcode-v3-images/';
  const ARCHIVE_REGISTRY_LOCK = 'islandmilfcode-v3-registry';
  const ARCHIVE_REGISTRY_LEASE_KEY = 'islandmilfcode:v3-registry-lease';
  const ARCHIVE_REGISTRY_LEASE_MS = 30_000;
  const ARCHIVE_REGISTRY_LOCK_WAIT_MS = 8_000;
  const ARCHIVE_GC_BATCH_SIZE = 32;
  const ARCHIVE_DELETE_FENCE_LIMIT = 256;
  let archiveLayout = 'unknown';

  function archiveLockStorage() {
    try {
      const storage = globalThis.localStorage;
      if (!storage) return null;
      storage.getItem(ARCHIVE_REGISTRY_LEASE_KEY);
      return storage;
    } catch {
      return null;
    }
  }

  function archiveRegistryLockMode() {
    if (globalThis.navigator?.locks && typeof globalThis.navigator.locks.request === 'function') {
      return 'web-locks';
    }
    return archiveLockStorage() ? 'local-storage-lease' : 'page-only';
  }

  function readArchiveRegistryLease(storage) {
    try {
      const value = JSON.parse(storage.getItem(ARCHIVE_REGISTRY_LEASE_KEY) || 'null');
      return isRecord(value)
        && typeof value.owner === 'string'
        && Number.isFinite(Number(value.expiresAt))
        ? value
        : null;
    } catch {
      return null;
    }
  }

  function waitForArchiveLock(milliseconds) {
    return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
  }

  async function withArchiveRegistryLease(storage, callback) {
    const owner = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const deadline = Date.now() + ARCHIVE_REGISTRY_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const now = Date.now();
      const current = readArchiveRegistryLease(storage);
      if (!current || Number(current.expiresAt) <= now) {
        storage.setItem(ARCHIVE_REGISTRY_LEASE_KEY, JSON.stringify({
          owner,
          expiresAt: now + ARCHIVE_REGISTRY_LEASE_MS,
        }));
        await waitForArchiveLock(20 + Math.floor(Math.random() * 30));
        if (readArchiveRegistryLease(storage)?.owner === owner) {
          let lost = false;
          const renewal = globalThis.setInterval(() => {
            try {
              if (readArchiveRegistryLease(storage)?.owner !== owner) {
                lost = true;
                return;
              }
              storage.setItem(ARCHIVE_REGISTRY_LEASE_KEY, JSON.stringify({
                owner,
                expiresAt: Date.now() + ARCHIVE_REGISTRY_LEASE_MS,
              }));
            } catch {
              lost = true;
            }
          }, Math.floor(ARCHIVE_REGISTRY_LEASE_MS / 3));
          try {
            const result = await callback();
            if (lost || readArchiveRegistryLease(storage)?.owner !== owner) {
              throw new Error('v3 registry 跨页面租约在操作完成前丢失');
            }
            return result;
          } finally {
            globalThis.clearInterval(renewal);
            try {
              if (readArchiveRegistryLease(storage)?.owner === owner) {
                storage.removeItem(ARCHIVE_REGISTRY_LEASE_KEY);
              }
            } catch {
              // An expired lease is recoverable by the next operation.
            }
          }
        }
      }
      await waitForArchiveLock(40 + Math.floor(Math.random() * 60));
    }
    throw new Error('等待 v3 registry 跨页面锁超时');
  }

  async function withArchiveRegistryLock(callback, options = {}) {
    const locks = globalThis.navigator?.locks;
    if (locks && typeof locks.request === 'function') {
      let callbackStarted = false;
      try {
        return await locks.request(ARCHIVE_REGISTRY_LOCK, { mode: 'exclusive' }, () => {
          callbackStarted = true;
          return callback();
        });
      } catch (error) {
        if (callbackStarted) throw error;
      }
    }
    if (options.requireWebLocks === true) {
      throw new Error('当前 WebView 没有 Web Locks，已暂停 v3 物理回收');
    }
    const storage = archiveLockStorage();
    if (storage) return withArchiveRegistryLease(storage, callback);
    return callback();
  }

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function getRequestHeaders() {
    if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getRequestHeaders !== 'function') {
      throw new Error('当前环境没有 SillyTavern 后端请求接口');
    }
    return { ...SillyTavern.getRequestHeaders(), 'Content-Type': 'application/json' };
  }

  function getCurrentChatId() {
    try {
      return SillyTavern.getCurrentChatId?.() ?? null;
    } catch {
      return null;
    }
  }

  function encodeBase64Bytes(bytes) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(chunks.join(''));
  }

  function encodeBase64Utf8(value) {
    return encodeBase64Bytes(new TextEncoder().encode(value));
  }

  function safeFileToken(value) {
    const normalized = String(value ?? '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96);
    return normalized || 'save';
  }

  function fileUrl(fileName) {
    return `${PUBLIC_FILE_ROOT}/${fileName}`;
  }

  function normalizePublicPath(value) {
    const normalized = String(value ?? '').trim().replace(/\\/g, '/');
    if (!normalized) return '';
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  async function getResponseError(response) {
    try {
      return (await response.text()).trim() || `${response.status} ${response.statusText}`;
    } catch {
      return `${response.status} ${response.statusText}`;
    }
  }

  async function readJsonFile(fileName) {
    const response = await fetch(`${fileUrl(fileName)}?islandmilfcode=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: getRequestHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取 ${fileName} 失败：${await getResponseError(response)}`);
    return response.json();
  }

  async function uploadJsonFile(fileName, value, options = {}) {
    const directory = String(options.directory || '').trim();
    const response = await fetch('/api/files/upload', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({
        name: fileName,
        data: encodeBase64Utf8(JSON.stringify(value, null, 2)),
        ...(directory ? { directory } : {}),
      }),
    });
    if (!response.ok) throw new Error(`写入 ${fileName} 失败：${await getResponseError(response)}`);

    const result = await response.json();
    const uploadedPath = normalizePublicPath(result.path);
    const expectedPath = fileUrl(directory ? `${directory}/${fileName}` : fileName);
    const flatPath = fileUrl(fileName);
    if (uploadedPath !== expectedPath && !(options.allowFlatFallback && uploadedPath === flatPath)) {
      throw new Error(`SillyTavern 返回了意外的文件路径：${uploadedPath || '空'}`);
    }
    return {
      path: uploadedPath,
      directoryApplied: Boolean(directory) && uploadedPath === expectedPath,
    };
  }

  async function deletePublicFile(publicPath) {
    const normalized = normalizePublicPath(publicPath);
    if (!normalized.startsWith(`${PUBLIC_FILE_ROOT}/`)) {
      throw new Error(`拒绝删除非 user/files 文件：${normalized || '空'}`);
    }
    const response = await fetch('/api/files/delete', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ path: normalized }),
    });
    if (response.status === 404) return 'missing';
    if (!response.ok) throw new Error(`删除 ${normalized} 失败：${await getResponseError(response)}`);
    return 'deleted';
  }

  function parseBase64ImageDataUrl(value) {
    const match = String(value ?? '').match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    if (!match) return null;
    return { mimeType: match[1].toLowerCase(), base64: match[2] };
  }

  function getImageFormat(mimeType) {
    const formats = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/avif': 'avif',
    };
    return formats[String(mimeType ?? '').toLowerCase()] || '';
  }

  async function uploadImageAsset(asset, folderName, fileToken) {
    const parsed = parseBase64ImageDataUrl(asset.dataUrl);
    const format = getImageFormat(asset.mimeType) || getImageFormat(parsed?.mimeType);
    if (!parsed || !format) return null;

    const response = await fetch('/api/images/upload', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({
        image: parsed.base64,
        format,
        ch_name: folderName,
        filename: safeFileToken(fileToken),
      }),
    });
    if (!response.ok) throw new Error(`写入图片资源 ${asset.id} 失败：${await getResponseError(response)}`);
    const result = await response.json();
    const imagePath = normalizePublicPath(result.path);
    if (!imagePath || !imagePath.startsWith('/user/images/')) {
      throw new Error(`SillyTavern 返回了意外的图片路径：${imagePath || '空'}`);
    }
    return {
      id: String(asset.id),
      path: imagePath,
      mimeType: String(asset.mimeType || parsed.mimeType),
      byteLength: Number(asset.byteLength) || 0,
      createdAt: Number(asset.createdAt) || Date.now(),
      ...(asset.prompt ? { prompt: String(asset.prompt) } : {}),
    };
  }

  async function downloadImageAsset(reference) {
    const imagePath = normalizePublicPath(reference.path);
    if (!imagePath.startsWith('/user/images/')) {
      throw new Error(`备份图片路径不正确：${imagePath || '空'}`);
    }
    const response = await fetch(`${imagePath}?islandmilfcode=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: getRequestHeaders(),
    });
    if (!response.ok) throw new Error(`读取图片资源 ${reference.id} 失败：${await getResponseError(response)}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = String(reference.mimeType || response.headers.get('content-type') || 'image/png');
    return {
      id: String(reference.id),
      dataUrl: `data:${mimeType};base64,${encodeBase64Bytes(bytes)}`,
      mimeType,
      byteLength: Number(reference.byteLength) || bytes.byteLength,
      createdAt: Number(reference.createdAt) || Date.now(),
      ...(reference.prompt ? { prompt: String(reference.prompt) } : {}),
    };
  }

  function createEmptyBundle() {
    return {
      format: FORMAT,
      formatVersion: BUNDLE_VERSION,
      updatedAt: new Date(0).toISOString(),
      entries: [],
    };
  }

  function isBundleEntry(entry) {
    return (
      isRecord(entry) &&
      typeof entry.saveId === 'string' &&
      typeof entry.runId === 'string' &&
      isEnvelope(entry.state, 'state') &&
      isEnvelope(entry.messages, 'messages') &&
      entry.state.saveId === entry.saveId &&
      entry.messages.saveId === entry.saveId &&
      isRecord(entry.state.payload) &&
      Array.isArray(entry.messages.chatLog)
    );
  }

  function normalizeBundle(value) {
    if (!isRecord(value) || value.format !== FORMAT || value.formatVersion !== BUNDLE_VERSION) {
      return createEmptyBundle();
    }
    const entries = Array.isArray(value.entries) ? value.entries.filter(isBundleEntry) : [];
    return {
      format: FORMAT,
      formatVersion: BUNDLE_VERSION,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
      entries,
    };
  }

  function readBundleForWrite(value) {
    if (value === null) return createEmptyBundle();
    if (!isRecord(value) || value.format !== FORMAT || value.formatVersion !== BUNDLE_VERSION || !Array.isArray(value.entries)) {
      throw new Error('现有 v2 备份汇总文件格式异常；已保留原文件，拒绝用空内容覆盖');
    }
    const normalized = normalizeBundle(value);
    if (normalized.entries.length !== value.entries.length) {
      throw new Error('现有 v2 备份汇总文件含有损坏条目；已保留原文件，拒绝过滤后覆盖');
    }
    return normalized;
  }

  function createEmptyLegacyIndex() {
    return {
      format: FORMAT,
      formatVersion: ENVELOPE_VERSION,
      updatedAt: new Date(0).toISOString(),
      entries: [],
    };
  }

  function normalizeLegacyIndex(value) {
    if (!isRecord(value) || value.format !== FORMAT || value.formatVersion !== ENVELOPE_VERSION) {
      return createEmptyLegacyIndex();
    }
    const entries = Array.isArray(value.entries)
      ? value.entries.filter(entry =>
          isRecord(entry) &&
          typeof entry.saveId === 'string' &&
          typeof entry.runId === 'string' &&
          typeof entry.stateFile === 'string' &&
          typeof entry.messagesFile === 'string',
        )
      : [];
    return {
      format: FORMAT,
      formatVersion: ENVELOPE_VERSION,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
      entries,
    };
  }

  function isEnvelope(value, kind) {
    return (
      isRecord(value) &&
      value.format === FORMAT &&
      value.formatVersion === ENVELOPE_VERSION &&
      value.kind === kind
    );
  }

  function assertBackup(value) {
    if (
      !isRecord(value) ||
      value.kind !== 'single-save' ||
      typeof value.saveId !== 'string' ||
      !value.saveId.trim() ||
      !isRecord(value.meta) ||
      !isRecord(value.payload) ||
      typeof value.payload.runId !== 'string' ||
      !Array.isArray(value.payload.chatLog)
    ) {
      throw new Error('收到的存档数据不完整，拒绝写入本机备份');
    }
    return value;
  }

  function getPlayerAvatarAssetId(backup) {
    const metaProfile = isRecord(backup.meta.playerProfile) ? backup.meta.playerProfile : null;
    const runtimeFlags = isRecord(backup.payload.gameState?.runtimeFlags) ? backup.payload.gameState.runtimeFlags : null;
    const runtimeProfile = isRecord(runtimeFlags?.playerProfile) ? runtimeFlags.playerProfile : null;
    return String(metaProfile?.avatarAssetId || runtimeProfile?.avatarAssetId || '').trim();
  }

  async function persistImageAssets(backup, saveToken) {
    const avatarAssetId = getPlayerAvatarAssetId(backup);
    const imageAssets = Array.isArray(backup.imageAssets) ? backup.imageAssets.filter(isRecord) : [];
    const references = [];
    const inlineAssets = [];
    for (const asset of imageAssets) {
      const assetId = String(asset.id || '').trim();
      if (!assetId) continue;
      const isPlayerAvatar = assetId === avatarAssetId;
      const folderName = isPlayerAvatar ? AVATAR_IMAGE_FOLDER : `${SAVE_ASSET_FOLDER_PREFIX}${saveToken}`;
      const fileToken = isPlayerAvatar ? `${saveToken}-${assetId}` : assetId;
      const reference = await uploadImageAsset(asset, folderName, fileToken);
      if (reference) references.push(reference);
      else inlineAssets.push(asset);
    }
    return { references, inlineAssets };
  }

  function getPublicEntry(entry, storage) {
    if (storage === 'legacy-v1') {
      return {
        saveId: entry.saveId,
        runId: entry.runId,
        playerName: entry.playerName,
        label: entry.label,
        updatedAt: entry.updatedAt,
        backedUpAt: entry.backedUpAt,
        storage,
        storagePath: `user/files/${entry.stateFile}`,
        stateFile: entry.stateFile,
        messagesFile: entry.messagesFile,
        ...(entry.assetsFile ? { assetsFile: entry.assetsFile } : {}),
      };
    }
    const imageFolders = [...new Set(
      (Array.isArray(entry.assetRefs) ? entry.assetRefs : [])
        .map(reference => normalizePublicPath(reference.path).split('/').slice(0, -1).join('/'))
        .filter(Boolean),
    )];
    return {
      saveId: entry.saveId,
      runId: entry.runId,
      playerName: entry.playerName,
      label: entry.label,
      updatedAt: entry.updatedAt,
      backedUpAt: entry.backedUpAt,
      storage,
      storagePath: `user/files/${BUNDLE_FILE}`,
      bundleFile: BUNDLE_FILE,
      imageFolders,
    };
  }

  async function listBackups() {
    const results = await Promise.allSettled([
      readJsonFile(BUNDLE_FILE).then(normalizeBundle),
      readJsonFile(LEGACY_INDEX_FILE).then(normalizeLegacyIndex),
    ]);
    const bundle = results[0].status === 'fulfilled' ? results[0].value : createEmptyBundle();
    const legacyIndex = results[1].status === 'fulfilled' ? results[1].value : createEmptyLegacyIndex();
    const entries = [
      ...bundle.entries.map(entry => getPublicEntry(entry, 'bundle-v2')),
      ...legacyIndex.entries.map(entry => getPublicEntry(entry, 'legacy-v1')),
    ];
    return entries.sort(
      (left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0),
    );
  }

  async function writeBackup(input) {
    const backup = assertBackup(input);
    const bundle = readBundleForWrite(await readJsonFile(BUNDLE_FILE));
    const backedUpAt = new Date().toISOString();
    const token = safeFileToken(backup.saveId);
    const stateEnvelope = {
      format: FORMAT,
      formatVersion: ENVELOPE_VERSION,
      kind: 'state',
      backedUpAt,
      saveId: backup.saveId,
      meta: backup.meta,
      payload: {
        saveId: backup.payload.saveId,
        runId: backup.payload.runId,
        gameState: backup.payload.gameState,
        summaryStore: backup.payload.summaryStore,
        memoryDB: backup.payload.memoryDB,
        version: backup.payload.version,
      },
    };
    const messagesEnvelope = {
      format: FORMAT,
      formatVersion: ENVELOPE_VERSION,
      kind: 'messages',
      backedUpAt,
      saveId: backup.saveId,
      runId: backup.payload.runId,
      chatLog: backup.payload.chatLog,
      messageSnapshots: backup.payload.messageSnapshots,
    };
    const { references, inlineAssets } = await persistImageAssets(backup, token);
    const playerProfile = isRecord(backup.meta.playerProfile) ? backup.meta.playerProfile : {};
    const entry = {
      saveId: backup.saveId,
      runId: backup.payload.runId,
      playerName: String(playerProfile.name || backup.meta.characterName || '未命名主角'),
      label: String(backup.meta.label || '存档'),
      updatedAt: Number(backup.meta.updatedAt) || Date.now(),
      backedUpAt,
      state: stateEnvelope,
      messages: messagesEnvelope,
      assetRefs: references,
      inlineAssets,
    };

    bundle.updatedAt = backedUpAt;
    bundle.entries = [entry, ...bundle.entries.filter(item => item.saveId !== entry.saveId)];
    await uploadJsonFile(BUNDLE_FILE, bundle);

    const persistedBundle = normalizeBundle(await readJsonFile(BUNDLE_FILE));
    const persistedEntry = persistedBundle.entries.find(item => item.saveId === entry.saveId);
    if (
      !persistedEntry ||
      persistedEntry.backedUpAt !== backedUpAt ||
      !isEnvelope(persistedEntry.state, 'state') ||
      !isEnvelope(persistedEntry.messages, 'messages')
    ) {
      throw new Error('本机备份汇总文件写入后校验失败');
    }
    return getPublicEntry(persistedEntry, 'bundle-v2');
  }

  async function loadBundledBackup(saveId, bundleEntry) {
    const stateEnvelope = bundleEntry.state;
    const messagesEnvelope = bundleEntry.messages;
    if (!isEnvelope(stateEnvelope, 'state') || !isEnvelope(messagesEnvelope, 'messages')) {
      throw new Error('本机备份主体或消息数据格式不正确');
    }
    if (stateEnvelope.saveId !== saveId || messagesEnvelope.saveId !== saveId) {
      throw new Error('本机备份数据与索引中的 saveId 不一致');
    }

    const assetRecords = new Map();
    for (const inlineAsset of Array.isArray(bundleEntry.inlineAssets) ? bundleEntry.inlineAssets : []) {
      if (isRecord(inlineAsset) && typeof inlineAsset.id === 'string') {
        assetRecords.set(inlineAsset.id, inlineAsset);
      }
    }
    const downloadedAssetResults = await Promise.allSettled(
      (Array.isArray(bundleEntry.assetRefs) ? bundleEntry.assetRefs : []).map(downloadImageAsset),
    );
    for (const result of downloadedAssetResults) {
      if (result.status === 'fulfilled') assetRecords.set(result.value.id, result.value);
    }

    return {
      version: stateEnvelope.payload.version,
      exportedAt: bundleEntry.backedUpAt,
      kind: 'single-save',
      saveId,
      meta: stateEnvelope.meta,
      payload: {
        ...stateEnvelope.payload,
        chatLog: messagesEnvelope.chatLog,
        messageSnapshots: messagesEnvelope.messageSnapshots,
      },
      ...(assetRecords.size ? { imageAssets: [...assetRecords.values()] } : {}),
    };
  }

  async function loadLegacyBackup(saveId, entry) {
    const [stateEnvelope, messagesEnvelope, assetsEnvelope] = await Promise.all([
      readJsonFile(entry.stateFile),
      readJsonFile(entry.messagesFile),
      entry.assetsFile
        ? readJsonFile(entry.assetsFile).catch(error => {
            console.warn(`[IslandMilfCode Saves] 旧版图片备份读取失败，将继续恢复存档主体：${String(error)}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
    if (!isEnvelope(stateEnvelope, 'state') || !isEnvelope(messagesEnvelope, 'messages')) {
      throw new Error('旧版本机备份主体或消息文件格式不正确');
    }
    if (stateEnvelope.saveId !== saveId || messagesEnvelope.saveId !== saveId) {
      throw new Error('旧版本机备份文件与索引中的 saveId 不一致');
    }
    const usableAssetsEnvelope = assetsEnvelope && isEnvelope(assetsEnvelope, 'assets') && assetsEnvelope.saveId === saveId
      ? assetsEnvelope
      : null;
    if (assetsEnvelope && !usableAssetsEnvelope) {
      console.warn('[IslandMilfCode Saves] 旧版图片备份格式异常，已忽略图片并继续恢复存档主体');
    }
    return {
      version: stateEnvelope.payload.version,
      exportedAt: entry.backedUpAt,
      kind: 'single-save',
      saveId,
      meta: stateEnvelope.meta,
      payload: {
        ...stateEnvelope.payload,
        chatLog: messagesEnvelope.chatLog,
        messageSnapshots: messagesEnvelope.messageSnapshots,
      },
      ...(Array.isArray(usableAssetsEnvelope?.imageAssets) && usableAssetsEnvelope.imageAssets.length
        ? { imageAssets: usableAssetsEnvelope.imageAssets }
        : {}),
    };
  }

  async function loadBackup(saveIdValue, preferredStorageValue) {
    const saveId = String(saveIdValue ?? '').trim();
    if (!saveId) throw new Error('读取本机备份时缺少 saveId');

    const preferredStorage = preferredStorageValue === 'legacy-v1' ? 'legacy-v1' : 'bundle-v2';
    const [bundleResult, legacyResult] = await Promise.allSettled([
      readJsonFile(BUNDLE_FILE).then(normalizeBundle),
      readJsonFile(LEGACY_INDEX_FILE).then(normalizeLegacyIndex),
    ]);
    const bundle = bundleResult.status === 'fulfilled' ? bundleResult.value : createEmptyBundle();
    const legacyIndex = legacyResult.status === 'fulfilled' ? legacyResult.value : createEmptyLegacyIndex();
    const bundleEntry = bundle.entries.find(item => item.saveId === saveId);
    const legacyEntry = legacyIndex.entries.find(item => item.saveId === saveId);
    const candidates = preferredStorage === 'legacy-v1'
      ? [
          { storage: 'legacy-v1', entry: legacyEntry, load: loadLegacyBackup },
          { storage: 'bundle-v2', entry: bundleEntry, load: loadBundledBackup },
        ]
      : [
          { storage: 'bundle-v2', entry: bundleEntry, load: loadBundledBackup },
          { storage: 'legacy-v1', entry: legacyEntry, load: loadLegacyBackup },
        ];
    let firstError = null;
    for (const candidate of candidates) {
      if (!candidate.entry) continue;
      try {
        return await candidate.load(saveId, candidate.entry);
      } catch (error) {
        firstError ??= error;
        console.warn(`[IslandMilfCode Saves] ${candidate.storage} 备份恢复失败，将尝试同 saveId 的另一份备份:`, error);
      }
    }
    if (firstError) throw firstError;
    if (preferredStorage === 'legacy-v1' && legacyResult.status === 'rejected') {
      throw legacyResult.reason;
    }
    if (preferredStorage === 'bundle-v2' && bundleResult.status === 'rejected') {
      throw bundleResult.reason;
    }
    if (bundleResult.status === 'rejected') throw bundleResult.reason;
    if (legacyResult.status === 'rejected') throw legacyResult.reason;
    throw new Error('本机备份中没有这个存档');
  }

  function archiveObjectFile(kind, hash) {
    return `islandmilfcode-v3-${safeFileToken(kind)}-${safeFileToken(hash)}.json`;
  }

  function archiveObjectPath(fileName, layout = archiveLayout) {
    return layout === 'subdir-v1' ? `${ARCHIVE_OBJECT_DIRECTORY}/${fileName}` : fileName;
  }

  function archiveReadPaths(fileName) {
    const nestedPath = `${ARCHIVE_OBJECT_DIRECTORY}/${fileName}`;
    // Prefer the negotiated layout to avoid one guaranteed 404 per object, but
    // retain the other path as a migration/downgrade fallback.
    return archiveLayout === 'flat-v3' ? [fileName, nestedPath] : [nestedPath, fileName];
  }

  async function findArchiveJsonFile(fileName, predicate) {
    for (const relativePath of archiveReadPaths(fileName)) {
      let value;
      try {
        value = await readJsonFile(relativePath);
      } catch (error) {
        // A damaged duplicate must not hide a valid copy in the other layout.
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (value === null) continue;
      if (predicate(value)) return { value, relativePath };
    }
    return null;
  }

  async function uploadArchiveJsonFile(fileName, value) {
    if (archiveLayout === 'unknown') {
      throw new Error('v3 存储布局尚未探测');
    }
    const directory = archiveLayout === 'subdir-v1' ? ARCHIVE_OBJECT_DIRECTORY : '';
    const result = await uploadJsonFile(fileName, value, { directory });
    return {
      ...result,
      relativePath: archiveObjectPath(fileName),
      storagePath: `user/files/${archiveObjectPath(fileName)}`,
    };
  }

  async function deleteArchiveJsonFile(fileName) {
    const paths = [...new Set(archiveReadPaths(fileName))];
    const outcomes = [];
    for (const relativePath of paths) {
      outcomes.push(await deletePublicFile(fileUrl(relativePath)));
    }
    return outcomes;
  }

  function createEmptyArchiveRegistry() {
    return {
      format: 'islandmilfcode-archive-registry',
      formatVersion: 3,
      updatedAt: new Date(0).toISOString(),
      entries: {},
      gcTombstones: {},
      deletedSaves: {},
      lastGc: null,
    };
  }

  function readArchiveRegistry(value, forWrite = false) {
    if (value === null) return createEmptyArchiveRegistry();
    if (
      !isRecord(value) ||
      value.format !== 'islandmilfcode-archive-registry' ||
      value.formatVersion !== 3 ||
      !isRecord(value.entries)
    ) {
      if (forWrite) throw new Error('现有 v3 registry 格式异常；已保留原文件，拒绝覆盖');
      return createEmptyArchiveRegistry();
    }
    return {
      ...value,
      format: 'islandmilfcode-archive-registry',
      formatVersion: 3,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
      entries: value.entries,
      gcTombstones: isRecord(value.gcTombstones) ? value.gcTombstones : {},
      deletedSaves: isRecord(value.deletedSaves) ? value.deletedSaves : {},
      lastGc: isRecord(value.lastGc) ? value.lastGc : null,
    };
  }

  function isArchiveRootValue(value) {
    if (!isRecord(value)) return false;
    if (Number(value.formatVersion) > 3 || Number(value.schemaVersion) > 3) return true;
    return (
      value.formatVersion === 3 &&
      value.schemaVersion === 3 &&
      typeof value.stateHash === 'string' &&
      isRecord(value.floorIndexPageHashes)
    );
  }

  function stableArchiveValue(value) {
    if (Array.isArray(value)) return value.map(stableArchiveValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, stableArchiveValue(child)]),
    );
  }

  function sameArchiveValue(left, right) {
    try {
      return JSON.stringify(stableArchiveValue(left)) === JSON.stringify(stableArchiveValue(right));
    } catch {
      return false;
    }
  }

  function fallbackTextHash(value) {
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      left ^= code & 0xff;
      left = Math.imul(left, 0x01000193) >>> 0;
      right ^= left + code + ((right << 6) >>> 0) + (right >>> 2);
      right >>>= 0;
    }
    return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
  }

  async function hashArchiveText(value) {
    const text = String(value);
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const bytes = new TextEncoder().encode(text);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return `sha256:${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    return `fnv64:${fallbackTextHash(text)}`;
  }

  function isStoredArchiveObject(value, kind, hash, expectedValue) {
    return (
      isRecord(value) &&
      value.format === 'islandmilfcode-archive-object' &&
      value.formatVersion === 3 &&
      value.kind === kind &&
      value.hash === hash &&
      'value' in value &&
      sameArchiveValue(value.value, expectedValue)
    );
  }

  function archiveWriteResult(outcome, fields, uploadCounts = {}) {
    const uploaded = outcome === 'uploaded';
    const jsonUploads = uploaded ? Math.max(0, Number(uploadCounts.jsonUploads) || 1) : 0;
    const imageUploads = uploaded ? Math.max(0, Number(uploadCounts.imageUploads) || 0) : 0;
    return {
      ...fields,
      outcome,
      uploaded,
      reused: outcome === 'reused',
      jsonUploads,
      imageUploads,
      fileUploads: jsonUploads + imageUploads,
    };
  }

  function isStoredArchiveImage(value, asset, contentHash) {
    if (
      !isRecord(value) ||
      value.format !== 'islandmilfcode-archive-image' ||
      value.formatVersion !== 3 ||
      value.assetId !== asset.id ||
      value.contentHash !== contentHash ||
      !isRecord(value.reference)
    ) return false;
    const reference = value.reference;
    const imagePath = normalizePublicPath(reference.path);
    if (reference.id !== asset.id || !imagePath.startsWith('/user/images/')) return false;
    const storedBytes = Number(reference.byteLength);
    const currentBytes = Number(asset.byteLength);
    if (storedBytes > 0 && currentBytes > 0 && storedBytes !== currentBytes) return false;
    const storedMimeType = String(reference.mimeType || '').toLowerCase();
    const currentMimeType = String(asset.mimeType || '').toLowerCase();
    return !storedMimeType || !currentMimeType || storedMimeType === currentMimeType;
  }

  function isArchiveObjectEnvelope(value, kind, hash) {
    return (
      isRecord(value) &&
      value.format === 'islandmilfcode-archive-object' &&
      Number(value.formatVersion) === 3 &&
      value.kind === kind &&
      value.hash === hash &&
      'value' in value
    );
  }

  function collectArchiveImageIds(value, ids, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(item => collectArchiveImageIds(item, ids, seen));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'assetId' || key === 'avatarAssetId') && typeof child === 'string' && child) {
        ids.add(child);
      } else if (key === 'imageAssetIds' && Array.isArray(child)) {
        child.forEach(id => {
          if (typeof id === 'string' && id) ids.add(id);
        });
      }
      collectArchiveImageIds(child, ids, seen);
    }
  }

  function createArchiveGraph(initialImageIds = []) {
    return {
      roots: new Set(),
      indexes: new Set(),
      leaves: new Set(),
      imageManifests: new Set(),
      imageIds: new Set(initialImageIds),
      imagePaths: new Map(),
      seenObjects: new Set(),
      objectValues: new Map(),
      complete: true,
      imagesComplete: true,
      blockers: [],
      missing: [],
      readErrors: [],
    };
  }

  function blockArchiveGraph(graph, message, strict, reason = 'invalid') {
    graph.blockers.push(message);
    if (reason === 'missing') graph.missing.push(message);
    else graph.readErrors.push(message);
    if (strict) graph.complete = false;
  }

  async function readArchiveGraphObject(graph, kind, hash, category, strict) {
    const normalizedHash = typeof hash === 'string' ? hash.trim() : '';
    if (!normalizedHash) {
      blockArchiveGraph(graph, `${kind} 引用缺少 hash`, strict);
      return null;
    }
    const objectKey = `${kind}\u0000${normalizedHash}`;
    const fileName = archiveObjectFile(kind, normalizedHash);
    graph[category].add(fileName);
    if (graph.seenObjects.has(objectKey)) return graph.objectValues.get(objectKey) ?? null;
    graph.seenObjects.add(objectKey);
    try {
      const found = await findArchiveJsonFile(fileName, value => isArchiveObjectEnvelope(value, kind, normalizedHash));
      if (!found) {
        blockArchiveGraph(graph, `${kind}/${normalizedHash} 不存在`, strict, 'missing');
        return null;
      }
      const envelope = found.value;
      if (Number(envelope.formatVersion) !== 3) {
        blockArchiveGraph(graph, `${kind}/${normalizedHash} 版本不可判定`, strict);
        return null;
      }
      collectArchiveImageIds(envelope.value, graph.imageIds);
      graph.objectValues.set(objectKey, envelope.value);
      return envelope.value;
    } catch (error) {
      blockArchiveGraph(
        graph,
        `${kind}/${normalizedHash} 读取失败：${error instanceof Error ? error.message : String(error)}`,
        strict,
        'read-error',
      );
      return null;
    }
  }

  function markArchiveGraphObject(graph, kind, hash, category, strict) {
    const normalizedHash = typeof hash === 'string' ? hash.trim() : '';
    if (!normalizedHash) {
      blockArchiveGraph(graph, `${kind} 引用缺少 hash`, strict);
      return;
    }
    graph[category].add(archiveObjectFile(kind, normalizedHash));
  }

  async function scanArchiveGraphObjectForImages(graph, kind, hash, category, liveImageScan) {
    const value = await readArchiveGraphObject(graph, kind, hash, category, false);
    if (value === null && liveImageScan) graph.imagesComplete = false;
  }

  async function collectArchiveGraph(rootSeeds, options = {}) {
    const strict = options.strict === true;
    const followPrevious = options.followPrevious === true;
    const collectImages = options.collectImages === true;
    const graph = createArchiveGraph(Array.isArray(options.imageIds) ? options.imageIds : []);
    (Array.isArray(options.extraValues) ? options.extraValues : []).forEach(value => {
      collectArchiveImageIds(value, graph.imageIds);
    });
    const pendingRoots = [...new Set(rootSeeds.filter(hash => typeof hash === 'string' && hash.trim()))];
    const visitedRoots = new Set();
    while (pendingRoots.length) {
      const rootHash = pendingRoots.pop();
      if (visitedRoots.has(rootHash)) continue;
      visitedRoots.add(rootHash);
      const root = await readArchiveGraphObject(graph, 'root', rootHash, 'roots', strict);
      if (!isRecord(root)) continue;
      if (Number(root.formatVersion) > 3 || Number(root.schemaVersion) > 3) {
        blockArchiveGraph(graph, `root/${rootHash} 由未来版本创建`, strict);
        continue;
      }
      if (
        Number(root.formatVersion) !== 3 ||
        Number(root.schemaVersion) !== 3 ||
        typeof root.stateHash !== 'string' ||
        !isRecord(root.floorIndexPageHashes)
      ) {
        blockArchiveGraph(graph, `root/${rootHash} 结构不完整`, strict);
        continue;
      }
      if (followPrevious && typeof root.previousRootHash === 'string' && root.previousRootHash.trim()) {
        pendingRoots.push(root.previousRootHash.trim());
      }
      // Retention GC only needs hashes from root/index. Full leaf reads are
      // reserved for an explicit save deletion where linked image cleanup is
      // worth the extra I/O.
      if (collectImages) {
        await scanArchiveGraphObjectForImages(graph, 'state', root.stateHash, 'leaves', strict);
      } else {
        markArchiveGraphObject(graph, 'state', root.stateHash, 'leaves', strict);
      }
      if (root.summaryHash) {
        if (collectImages) {
          await scanArchiveGraphObjectForImages(graph, 'summary', root.summaryHash, 'leaves', strict);
        } else {
          markArchiveGraphObject(graph, 'summary', root.summaryHash, 'leaves', strict);
        }
      }
      if (root.memoryHash) {
        if (collectImages) {
          await scanArchiveGraphObjectForImages(graph, 'memory', root.memoryHash, 'leaves', strict);
        } else {
          markArchiveGraphObject(graph, 'memory', root.memoryHash, 'leaves', strict);
        }
      }
      if (root.compatibilityHash) {
        if (collectImages) {
          await scanArchiveGraphObjectForImages(graph, 'compatibility', root.compatibilityHash, 'leaves', strict);
        } else {
          markArchiveGraphObject(graph, 'compatibility', root.compatibilityHash, 'leaves', strict);
        }
      }
      for (const pageHash of Object.values(root.floorIndexPageHashes)) {
        const page = await readArchiveGraphObject(graph, 'floor-index', pageHash, 'indexes', strict);
        if (!isRecord(page) || !Array.isArray(page.entries)) {
          blockArchiveGraph(graph, `floor-index/${String(pageHash)} 结构不完整`, strict);
          continue;
        }
        for (const entry of page.entries) {
          if (!isRecord(entry) || typeof entry.chunkHash !== 'string' || !entry.chunkHash) {
            blockArchiveGraph(graph, `floor-index/${String(pageHash)} 含无效 chunk 引用`, strict);
            continue;
          }
          if (collectImages) {
            await scanArchiveGraphObjectForImages(graph, 'floor-chunk', entry.chunkHash, 'leaves', strict);
          } else {
            markArchiveGraphObject(graph, 'floor-chunk', entry.chunkHash, 'leaves', strict);
          }
        }
      }
    }

    for (const assetId of graph.imageIds) {
      const fileName = archiveObjectFile('image', assetId);
      graph.imageManifests.add(fileName);
      try {
        const found = await findArchiveJsonFile(fileName, value => (
          isRecord(value) &&
          value.format === 'islandmilfcode-archive-image' &&
          Number(value.formatVersion) === 3 &&
          value.assetId === assetId &&
          isRecord(value.reference)
        ));
        const imagePath = normalizePublicPath(found?.value?.reference?.path);
        if (imagePath.startsWith(ARCHIVE_IMAGE_DIRECTORY_PATH)) {
          graph.imagePaths.set(assetId, imagePath);
        }
      } catch (error) {
        // Image attachments are optional for playability. Keeping the manifest
        // marked is enough to prevent an unreadable live image from being swept.
        graph.blockers.push(`image/${assetId} 读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return graph;
  }

  async function collectRootChainHashes(rootSeeds) {
    const pending = [...new Set(rootSeeds.filter(hash => typeof hash === 'string' && hash.trim()))];
    const visited = new Set();
    while (pending.length) {
      const rootHash = pending.pop();
      if (visited.has(rootHash)) continue;
      visited.add(rootHash);
      try {
        const found = await findArchiveJsonFile(
          archiveObjectFile('root', rootHash),
          value => isArchiveObjectEnvelope(value, 'root', rootHash),
        );
        const root = found?.value?.value;
        if (
          isRecord(root) &&
          Number(root.formatVersion) === 3 &&
          Number(root.schemaVersion) === 3 &&
          typeof root.previousRootHash === 'string' &&
          root.previousRootHash.trim()
        ) {
          pending.push(root.previousRootHash.trim());
        }
      } catch {
        // The known root hash remains in the tombstone. Missing descendants are
        // retained rather than guessed or deleted unsafely.
      }
    }
    return [...visited];
  }

  function createGcTombstone(saveId, reason, rootHashes, imageIds = []) {
    const seed = rootHashes[0] || `${Date.now()}`;
    const id = `${reason}:${safeFileToken(saveId)}:${safeFileToken(seed)}`;
    return {
      id,
      value: {
        format: 'islandmilfcode-archive-gc-tombstone',
        formatVersion: 1,
        id,
        saveId,
        reason,
        rootHashes: [...new Set(rootHashes)],
        imageIds: [...new Set(imageIds)],
        createdAt: Date.now(),
        attempts: 0,
      },
    };
  }

  function difference(left, right) {
    return [...left].filter(value => !right.has(value));
  }

  function archiveGcEntries(registry) {
    return Object.entries(isRecord(registry.gcTombstones) ? registry.gcTombstones : {})
      .filter(([, value]) => isRecord(value));
  }

  function archiveGcQueueSummary(registry, status = 'scheduled') {
    const tombstones = archiveGcEntries(registry);
    const lastGc = isRecord(registry.lastGc) ? registry.lastGc : {};
    const lockMode = archiveRegistryLockMode();
    return {
      status: tombstones.length
        ? lockMode !== 'web-locks' ? 'deferred' : status
        : (typeof lastGc.status === 'string' ? lastGc.status : 'none'),
      deleted: Math.max(0, Number(lastGc.deleted) || 0),
      missing: Math.max(0, Number(lastGc.missing) || 0),
      retainedShared: Math.max(0, Number(lastGc.retainedShared) || 0),
      failed: Math.max(0, Number(lastGc.failed) || 0),
      pendingTombstones: tombstones.length,
      pendingFiles: tombstones.reduce((sum, [, value]) => (
        sum + (Array.isArray(value.pendingJson) ? value.pendingJson.length : 0)
      ), 0),
      // Image manifests and image entities are deliberately retained. Their
      // sharing relation lives in floor chunks, and deleting a live image is a
      // worse player outcome than leaving a few optional files behind.
      imagesDeferred: tombstones.some(([, value]) => value.reason === 'save-deleted'),
      registryLock: lockMode,
      ...(tombstones.length && lockMode !== 'web-locks'
        ? { blocker: 'web-locks-unavailable' }
        : {}),
      ...(Number.isFinite(Number(lastGc.finishedAt)) ? { lastRunAt: Number(lastGc.finishedAt) } : {}),
    };
  }

  function selectArchiveGcTombstone(registry) {
    return archiveGcEntries(registry)
      .sort((left, right) => {
        const leftAttempt = Number(left[1].lastAttemptAt) || 0;
        const rightAttempt = Number(right[1].lastAttemptAt) || 0;
        if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
        return (Number(left[1].createdAt) || 0) - (Number(right[1].createdAt) || 0);
      })[0] || null;
  }

  function archiveLiveRootSignature(registry) {
    return Object.entries(registry.entries)
      .filter(([, entry]) => isRecord(entry))
      .map(([saveId, entry]) => [
        saveId,
        typeof entry.rootHash === 'string' ? entry.rootHash : '',
        typeof entry.previousRootHash === 'string' ? entry.previousRootHash : '',
      ].join('\u0000'))
      .sort()
      .join('\u0001');
  }

  async function persistArchiveRegistry(registry) {
    registry.updatedAt = new Date().toISOString();
    await uploadJsonFile(ARCHIVE_REGISTRY_FILE, registry);
  }

  async function deferArchiveGc(registry, tombstoneId, tombstone, blocker) {
    const updated = {
      ...tombstone,
      attempts: Math.max(0, Number(tombstone.attempts) || 0) + 1,
      lastAttemptAt: Date.now(),
      lastError: blocker,
    };
    registry.gcTombstones = { ...registry.gcTombstones, [tombstoneId]: updated };
    const summary = {
      ...archiveGcQueueSummary(registry, 'deferred'),
      blocker,
      finishedAt: Date.now(),
      tombstoneId,
    };
    registry.lastGc = summary;
    await persistArchiveRegistry(registry);
    return { ...summary, continue: false };
  }

  async function deleteGcBatch(items) {
    const queue = [...items];
    const completed = [];
    const failedItems = [];
    const summary = { deleted: 0, missing: 0, failed: 0 };
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= queue.length) return;
        const fileName = queue[index];
        try {
          const outcomes = await deleteArchiveJsonFile(fileName);
          if (outcomes.some(outcome => outcome === 'deleted')) summary.deleted += 1;
          else summary.missing += 1;
          completed.push(fileName);
        } catch (error) {
          summary.failed += 1;
          failedItems.push(fileName);
          summary.error ??= error instanceof Error ? error.message : String(error);
        }
      }
    });
    await Promise.all(workers);
    return { ...summary, completed, failedItems };
  }

  async function runArchiveGcMaintenanceUnlocked() {
    let registry = readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE), true);
    const selected = selectArchiveGcTombstone(registry);
    if (!selected) return { ...archiveGcQueueSummary(registry, 'none'), continue: false };
    const [tombstoneId, originalTombstone] = selected;
    let tombstone = { ...originalTombstone, lastAttemptAt: Date.now() };

    if (!Array.isArray(tombstone.pendingJson)) {
      const liveEntries = Object.values(registry.entries).filter(isRecord);
      const liveSeeds = liveEntries.flatMap(entry => [entry.rootHash, entry.previousRootHash]);
      const live = await collectArchiveGraph(liveSeeds, {
        strict: true,
        followPrevious: false,
        collectImages: false,
      });
      if (!live.complete) {
        return deferArchiveGc(
          registry,
          tombstoneId,
          tombstone,
          live.blockers[0] || 'live-graph-unreadable',
        );
      }

      const candidate = await collectArchiveGraph(
        Array.isArray(tombstone.rootHashes) ? tombstone.rootHashes : [],
        { strict: false, followPrevious: true, collectImages: false },
      );
      if (candidate.readErrors.length) {
        return deferArchiveGc(registry, tombstoneId, tombstone, candidate.readErrors[0]);
      }

      const candidateJsonCount = candidate.roots.size + candidate.indexes.size + candidate.leaves.size;
      const deadLeaves = difference(candidate.leaves, live.leaves);
      const deadIndexes = difference(candidate.indexes, live.indexes);
      const deadRoots = difference(candidate.roots, live.roots);
      const pendingJson = [...new Set([...deadLeaves, ...deadIndexes, ...deadRoots])];
      tombstone = {
        ...tombstone,
        pendingJson,
        retainedShared: Math.max(0, candidateJsonCount - pendingJson.length),
        deleted: Math.max(0, Number(tombstone.deleted) || 0),
        missing: Math.max(0, Number(tombstone.missing) || 0),
        failed: Math.max(0, Number(tombstone.failed) || 0),
        scanIncomplete: candidate.missing.length > 0,
        missingReferences: candidate.missing.length,
        liveRootSignature: archiveLiveRootSignature(registry),
        preparedAt: Date.now(),
        attempts: Math.max(0, Number(tombstone.attempts) || 0) + 1,
      };
      registry.gcTombstones = { ...registry.gcTombstones, [tombstoneId]: tombstone };
      // Persist the complete known inventory before the first physical delete.
      // A reload can then resume without losing descendants already discovered.
      await persistArchiveRegistry(registry);
    }

    const currentLiveSignature = archiveLiveRootSignature(registry);
    if (
      Array.isArray(tombstone.pendingJson)
      && tombstone.liveRootSignature !== currentLiveSignature
    ) {
      const liveEntries = Object.values(registry.entries).filter(isRecord);
      const live = await collectArchiveGraph(
        liveEntries.flatMap(entry => [entry.rootHash, entry.previousRootHash]),
        { strict: true, followPrevious: false, collectImages: false },
      );
      if (!live.complete) {
        return deferArchiveGc(
          registry,
          tombstoneId,
          tombstone,
          live.blockers[0] || 'live-graph-unreadable',
        );
      }
      const liveJson = new Set([...live.leaves, ...live.indexes, ...live.roots]);
      const filteredPending = tombstone.pendingJson.filter(fileName => !liveJson.has(fileName));
      tombstone = {
        ...tombstone,
        pendingJson: filteredPending,
        retainedShared: Math.max(0, Number(tombstone.retainedShared) || 0)
          + (tombstone.pendingJson.length - filteredPending.length),
        liveRootSignature: currentLiveSignature,
        lastAttemptAt: Date.now(),
      };
      registry.gcTombstones = { ...registry.gcTombstones, [tombstoneId]: tombstone };
      await persistArchiveRegistry(registry);
    }

    const pendingJson = Array.isArray(tombstone.pendingJson) ? tombstone.pendingJson : [];
    if (!pendingJson.length) {
      const nextTombstones = { ...registry.gcTombstones };
      delete nextTombstones[tombstoneId];
      registry.gcTombstones = nextTombstones;
      const summary = {
        ...archiveGcQueueSummary(registry, 'complete'),
        status: 'complete',
        deleted: Math.max(0, Number(tombstone.deleted) || 0),
        missing: Math.max(0, Number(tombstone.missing) || 0),
        retainedShared: Math.max(0, Number(tombstone.retainedShared) || 0),
        failed: Math.max(0, Number(tombstone.failed) || 0),
        imagesDeferred: tombstone.reason === 'save-deleted',
        scanIncomplete: tombstone.scanIncomplete === true,
        finishedAt: Date.now(),
        tombstoneId,
      };
      registry.lastGc = summary;
      await persistArchiveRegistry(registry);
      return { ...summary, continue: archiveGcEntries(registry).length > 0 };
    }

    const batch = pendingJson.slice(0, ARCHIVE_GC_BATCH_SIZE);
    const deletion = await deleteGcBatch(batch);
    // Re-read before merging so the non-Web-Locks fallback is less likely to
    // overwrite a newer registry written by another page.
    registry = readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE), true);
    const latestTombstone = registry.gcTombstones[tombstoneId];
    if (!isRecord(latestTombstone)) {
      return { ...archiveGcQueueSummary(registry), continue: archiveGcEntries(registry).length > 0 };
    }
    const completed = new Set(deletion.completed);
    const failed = new Set(deletion.failedItems);
    const latestPending = Array.isArray(latestTombstone.pendingJson)
      ? latestTombstone.pendingJson
      : pendingJson;
    const remaining = latestPending.filter(fileName => !completed.has(fileName) && !failed.has(fileName));
    remaining.push(...latestPending.filter(fileName => failed.has(fileName)));
    const deletedTotal = Math.max(0, Number(latestTombstone.deleted) || 0) + deletion.deleted;
    const missingTotal = Math.max(0, Number(latestTombstone.missing) || 0) + deletion.missing;
    const failedTotal = Math.max(0, Number(latestTombstone.failed) || 0) + deletion.failed;
    const nextTombstones = { ...registry.gcTombstones };
    if (remaining.length) {
      nextTombstones[tombstoneId] = {
        ...latestTombstone,
        pendingJson: remaining,
        attempts: Math.max(0, Number(latestTombstone.attempts) || 0) + 1,
        lastAttemptAt: Date.now(),
        deleted: deletedTotal,
        missing: missingTotal,
        failed: failedTotal,
        ...(deletion.error ? { lastError: deletion.error } : {}),
      };
    } else {
      delete nextTombstones[tombstoneId];
    }
    registry.gcTombstones = nextTombstones;
    const summary = {
      status: deletion.failed ? 'partial' : remaining.length ? 'running' : 'complete',
      deleted: deletedTotal,
      missing: missingTotal,
      retainedShared: Math.max(0, Number(latestTombstone.retainedShared) || 0),
      failed: failedTotal,
      pendingTombstones: archiveGcEntries(registry).length,
      pendingFiles: archiveGcEntries(registry).reduce((sum, [, value]) => (
        sum + (Array.isArray(value.pendingJson) ? value.pendingJson.length : 0)
      ), 0),
      imagesDeferred: latestTombstone.reason === 'save-deleted',
      scanIncomplete: latestTombstone.scanIncomplete === true,
      finishedAt: Date.now(),
      tombstoneId,
      ...(deletion.error ? { error: deletion.error } : {}),
    };
    registry.lastGc = summary;
    await persistArchiveRegistry(registry);
    return {
      ...summary,
      continue: deletion.failed === 0 && archiveGcEntries(registry).length > 0,
    };
  }

  async function runArchiveGcMaintenance() {
    return withArchiveRegistryLock(runArchiveGcMaintenanceUnlocked, { requireWebLocks: true });
  }

  async function isPublicImageReadable(reference) {
    const imagePath = normalizePublicPath(reference.path);
    if (!imagePath.startsWith('/user/images/')) return false;
    try {
      const response = await fetch(`${imagePath}?islandmilfcode=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        headers: getRequestHeaders(),
      });
      const readable = response.ok;
      if (response.body) await response.body.cancel().catch(() => undefined);
      return readable;
    } catch {
      return false;
    }
  }

  async function readUsableArchiveRoot(rootHash) {
    const object = await getArchiveObject({ kind: 'root', hash: rootHash }).catch(() => null);
    if (!isArchiveRootValue(object?.value)) return null;
    if (Number(object.value.formatVersion) > 3 || Number(object.value.schemaVersion) > 3) return object.value;
    const state = await getArchiveObject({ kind: 'state', hash: object.value.stateHash }).catch(() => null);
    return isRecord(state?.value) ? object.value : null;
  }

  async function probeArchiveStorage() {
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const probe = { format: 'islandmilfcode-archive-probe', formatVersion: 3, nonce };
    let probePath;
    if (archiveLayout === 'unknown') {
      const upload = await uploadJsonFile(ARCHIVE_PROBE_FILE, probe, {
        directory: ARCHIVE_OBJECT_DIRECTORY,
        allowFlatFallback: true,
      });
      archiveLayout = upload.directoryApplied ? 'subdir-v1' : 'flat-v3';
      probePath = upload.directoryApplied
        ? `${ARCHIVE_OBJECT_DIRECTORY}/${ARCHIVE_PROBE_FILE}`
        : ARCHIVE_PROBE_FILE;
    } else {
      const upload = await uploadArchiveJsonFile(ARCHIVE_PROBE_FILE, probe);
      probePath = upload.relativePath;
    }
    const readBack = await readJsonFile(probePath);
    if (!isRecord(readBack) || readBack.nonce !== nonce) throw new Error('v3 本机存储探针回读不一致');
    await deletePublicFile(fileUrl(probePath)).catch(() => undefined);
    const registry = readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE));
    return {
      persistent: true,
      archiveFormatVersion: 3,
      archiveLayout,
      registryLock: archiveRegistryLockMode(),
      storagePath: `user/files/${ARCHIVE_REGISTRY_FILE}`,
      saveCount: Object.keys(registry.entries).length,
      gc: archiveGcQueueSummary(registry),
      lastGc: registry.lastGc,
      chatId: getCurrentChatId(),
      actions: ['v3-put-object', 'v3-get-object', 'v3-put-image', 'v3-get-image', 'v3-commit-root', 'v3-delete-save', 'v3-read-root', 'v3-read-registry'],
    };
  }

  async function putArchiveObject(request) {
    const object = request.object;
    if (!isRecord(object) || typeof object.kind !== 'string' || typeof object.hash !== 'string' || !('value' in object)) {
      throw new Error('v3 object 请求不完整');
    }
    const fileName = archiveObjectFile(object.kind, object.hash);
    const storagePath = `user/files/${archiveObjectPath(fileName)}`;
    const existing = await findArchiveJsonFile(
      fileName,
      value => isStoredArchiveObject(value, object.kind, object.hash, object.value),
    );
    if (existing && !(archiveLayout === 'subdir-v1' && existing.relativePath === fileName)) {
      return archiveWriteResult('reused', {
        kind: object.kind,
        hash: object.hash,
        storagePath: `user/files/${existing.relativePath}`,
      });
    }
    const envelope = {
      format: 'islandmilfcode-archive-object',
      formatVersion: 3,
      kind: object.kind,
      hash: object.hash,
      value: object.value,
      writtenAt: new Date().toISOString(),
    };
    await uploadArchiveJsonFile(fileName, envelope);
    const readBack = await readJsonFile(archiveObjectPath(fileName));
    if (!isStoredArchiveObject(readBack, object.kind, object.hash, object.value)) {
      throw new Error(`v3 object 回读校验失败：${object.kind}/${object.hash}`);
    }
    if (archiveLayout === 'subdir-v1' && existing?.relativePath === fileName) {
      await deletePublicFile(fileUrl(fileName)).catch(() => undefined);
    }
    return archiveWriteResult('uploaded', {
      kind: object.kind,
      hash: object.hash,
      storagePath,
    });
  }

  async function getArchiveObject(request) {
    const kind = String(request.kind || '').trim();
    const hash = String(request.hash || '').trim();
    if (!kind || !hash) throw new Error('读取 v3 object 时缺少 kind/hash');
    const found = await findArchiveJsonFile(
      archiveObjectFile(kind, hash),
      value => isArchiveObjectEnvelope(value, kind, hash),
    );
    return found ? { kind, hash, value: found.value.value } : null;
  }

  async function putArchiveImage(request) {
    const asset = request.asset;
    if (!isRecord(asset) || typeof asset.id !== 'string' || typeof asset.dataUrl !== 'string') {
      throw new Error('v3 image 请求不完整');
    }
    const contentHash = await hashArchiveText(asset.dataUrl);
    const manifestFile = archiveObjectFile('image', asset.id);
    const storagePath = `user/files/${archiveObjectPath(manifestFile)}`;
    const existing = await findArchiveJsonFile(
      manifestFile,
      value => isStoredArchiveImage(value, asset, contentHash),
    );
    const existingReadable = existing ? await isPublicImageReadable(existing.value.reference) : false;
    if (
      existing &&
      existingReadable &&
      !(archiveLayout === 'subdir-v1' && existing.relativePath === manifestFile)
    ) {
      return archiveWriteResult('reused', {
        assetId: asset.id,
        reference: existing.value.reference,
        storagePath: `user/files/${existing.relativePath}`,
      });
    }
    if (
      existing &&
      existingReadable &&
      archiveLayout === 'subdir-v1' &&
      existing.relativePath === manifestFile
    ) {
      await uploadArchiveJsonFile(manifestFile, existing.value);
      const migrated = await readJsonFile(archiveObjectPath(manifestFile));
      if (!isStoredArchiveImage(migrated, asset, contentHash)) {
        throw new Error(`v3 image manifest 迁移回读校验失败：${asset.id}`);
      }
      await deletePublicFile(fileUrl(manifestFile)).catch(() => undefined);
      return archiveWriteResult('uploaded', {
        assetId: asset.id,
        reference: existing.value.reference,
        storagePath,
      });
    }
    const reference = await uploadImageAsset(asset, 'islandmilfcode-v3-images', asset.id);
    if (!reference) throw new Error(`v3 image 格式不支持：${asset.id}`);
    await uploadArchiveJsonFile(manifestFile, {
      format: 'islandmilfcode-archive-image',
      formatVersion: 3,
      assetId: asset.id,
      contentHash,
      reference,
    });
    const readBack = await readJsonFile(archiveObjectPath(manifestFile));
    if (!isStoredArchiveImage(readBack, asset, contentHash)) {
      throw new Error(`v3 image manifest 回读校验失败：${asset.id}`);
    }
    if (archiveLayout === 'subdir-v1' && existing?.relativePath === manifestFile) {
      await deletePublicFile(fileUrl(manifestFile)).catch(() => undefined);
    }
    return archiveWriteResult(
      'uploaded',
      { assetId: asset.id, reference, storagePath },
      { jsonUploads: 1, imageUploads: 1 },
    );
  }

  async function getArchiveImage(request) {
    const assetId = String(request.assetId || '').trim();
    if (!assetId) throw new Error('读取 v3 image 时缺少 assetId');
    const found = await findArchiveJsonFile(archiveObjectFile('image', assetId), value => (
      isRecord(value) && value.assetId === assetId && isRecord(value.reference)
    ));
    return found ? { asset: await downloadImageAsset(found.value.reference) } : { asset: null };
  }

  function pruneDeletedSaveFences(deletedSaves) {
    return Object.fromEntries(
      Object.entries(isRecord(deletedSaves) ? deletedSaves : {})
        .filter(([, value]) => isRecord(value))
        .sort((left, right) => (Number(right[1].deletedAt) || 0) - (Number(left[1].deletedAt) || 0))
        .slice(0, ARCHIVE_DELETE_FENCE_LIMIT),
    );
  }

  function archiveCommitTimestamp(request) {
    const committedAt = Date.parse(String(request.root?.committedAt || ''));
    const updatedAt = Number(request.meta?.updatedAt);
    return Math.max(
      Number.isFinite(committedAt) ? committedAt : 0,
      Number.isFinite(updatedAt) ? updatedAt : 0,
    );
  }

  async function commitArchiveRootUnlocked(request) {
    const saveId = String(request.saveId || '').trim();
    const rootHash = String(request.rootHash || '').trim();
    if (!saveId || !rootHash || !isRecord(request.root) || !isRecord(request.meta)) {
      throw new Error('提交 v3 root 时缺少 saveId/rootHash/root/meta');
    }
    const registry = readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE), true);
    const rootRevision = Number(request.root.revision);
    const metaRevision = Number(request.meta.browserRevision);
    const revision = Math.max(0, Math.floor(Number.isFinite(rootRevision) ? rootRevision : (metaRevision || 0)));
    const deletionFence = registry.deletedSaves[saveId];
    if (isRecord(deletionFence)) {
      const deletedAt = Math.max(0, Number(deletionFence.deletedAt) || 0);
      const commitTimestamp = archiveCommitTimestamp(request);
      if (!commitTimestamp || commitTimestamp <= deletedAt) {
        return {
          entry: null,
          ignored: true,
          reason: 'deleted-save',
          deletedAt,
          revision: Math.max(0, Number(deletionFence.revision) || 0),
          gc: archiveGcQueueSummary(registry),
          storagePath: `user/files/${ARCHIVE_REGISTRY_FILE}`,
        };
      }
      // A genuinely new player action after deletion may intentionally recreate
      // the same id. Only delayed pre-delete commits are fenced out.
      const nextDeletedSaves = { ...registry.deletedSaves };
      delete nextDeletedSaves[saveId];
      registry.deletedSaves = pruneDeletedSaveFences(nextDeletedSaves);
    }
    const registered = registry.entries[saveId];
    const previous = isRecord(registered) && typeof registered.rootHash === 'string' ? registered : null;
    const registeredRevision = Number(previous?.revision);
    const previousRevision = Number.isFinite(registeredRevision)
      ? Math.max(0, Math.floor(registeredRevision))
      : -1;
    if (previous && revision < previousRevision) {
      return {
        entry: previous,
        ignored: true,
        reason: 'older-revision',
        storagePath: `user/files/${ARCHIVE_REGISTRY_FILE}`,
      };
    }
    if (previous && revision === previousRevision) {
      if (previous.rootHash !== rootHash) {
        throw new Error(`v3 registry 拒绝同 revision 的不同 root：${revision}`);
      }
      const rootWrite = await putArchiveObject({ object: { kind: 'root', hash: rootHash, value: request.root } });
      return {
        entry: previous,
        ignored: true,
        reason: 'already-committed',
        rootWrite,
        gc: archiveGcQueueSummary(registry),
        registryWrite: archiveWriteResult('reused', {
          storagePath: `user/files/${ARCHIVE_REGISTRY_FILE}`,
        }),
        storagePath: `user/files/${ARCHIVE_REGISTRY_FILE}`,
      };
    }
    const rootWrite = await putArchiveObject({ object: { kind: 'root', hash: rootHash, value: request.root } });
    const previousRootCandidate = previous?.rootHash === rootHash
      ? previous.previousRootHash || request.root.previousRootHash || null
      : previous?.rootHash || request.root.previousRootHash || null;
    const previousRootHash = previousRootCandidate && previousRootCandidate !== rootHash
      ? previousRootCandidate
      : null;
    const entry = {
      saveId,
      runId: String(request.root.runId || request.meta.runId || ''),
      rootHash,
      previousRootHash,
      revision,
      meta: request.meta,
      updatedAt: Date.now(),
    };
    let retentionTombstoneId = null;
    const retiredRootHash = typeof previous?.previousRootHash === 'string'
      ? previous.previousRootHash.trim()
      : '';
    if (retiredRootHash && retiredRootHash !== rootHash && retiredRootHash !== previousRootHash) {
      const retiredRoots = [retiredRootHash];
      const tombstone = createGcTombstone(saveId, 'retention', retiredRoots);
      const existingTombstone = registry.gcTombstones[tombstone.id];
      registry.gcTombstones = {
        ...registry.gcTombstones,
        [tombstone.id]: isRecord(existingTombstone)
          ? {
              ...existingTombstone,
              rootHashes: [...new Set([
                ...(Array.isArray(existingTombstone.rootHashes) ? existingTombstone.rootHashes : []),
                ...retiredRoots,
              ])],
            }
          : tombstone.value,
      };
      retentionTombstoneId = tombstone.id;
    }
    registry.entries = { ...registry.entries, [saveId]: entry };
    registry.deletedSaves = pruneDeletedSaveFences(registry.deletedSaves);
    await persistArchiveRegistry(registry);
    const readBack = readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE));
    const confirmed = readBack.entries[saveId];
    if (!isRecord(confirmed) || confirmed.rootHash !== rootHash || Number(confirmed.revision) !== entry.revision) {
      throw new Error('v3 registry 提交后回读校验失败');
    }
    if (retentionTombstoneId && !isRecord(readBack.gcTombstones[retentionTombstoneId])) {
      throw new Error('v3 registry 没有保留待回收 revision 的 tombstone');
    }
    return {
      entry,
      rootWrite,
      gc: archiveGcQueueSummary(readBack),
      registryWrite: archiveWriteResult('uploaded', {
        storagePath: `user/files/${ARCHIVE_REGISTRY_FILE}`,
      }),
      storagePath: `user/files/${ARCHIVE_REGISTRY_FILE}`,
    };
  }

  async function commitArchiveRoot(request) {
    return withArchiveRegistryLock(() => commitArchiveRootUnlocked(request));
  }

  async function deleteArchiveSaveLocalUnlocked(request) {
    const saveId = String(request.saveId || '').trim();
    if (!saveId) throw new Error('删除 v3 本机存档时缺少 saveId');
    if (archiveLayout === 'unknown') await probeArchiveStorage();
    let registry = readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE), true);
    const entry = registry.entries[saveId];
    let tombstoneId = null;
    const deleted = isRecord(entry);
    if (deleted) {
      const roots = [...new Set([entry.rootHash, entry.previousRootHash].filter(value => (
        typeof value === 'string' && value.trim()
      )))];
      const tombstone = createGcTombstone(saveId, 'save-deleted', roots);
      const existingTombstone = registry.gcTombstones[tombstone.id];
      registry.gcTombstones = {
        ...registry.gcTombstones,
        [tombstone.id]: isRecord(existingTombstone)
          ? {
              ...existingTombstone,
              rootHashes: [...new Set([
                ...(Array.isArray(existingTombstone.rootHashes) ? existingTombstone.rootHashes : []),
                ...roots,
              ])],
            }
          : tombstone.value,
      };
      tombstoneId = tombstone.id;
      const nextEntries = { ...registry.entries };
      delete nextEntries[saveId];
      registry.entries = nextEntries;
    } else {
      const pending = Object.entries(registry.gcTombstones).find(([, value]) => (
        isRecord(value) && value.saveId === saveId && value.reason === 'save-deleted'
      ));
      tombstoneId = pending?.[0] || null;
    }

    registry.deletedSaves = pruneDeletedSaveFences({
      ...registry.deletedSaves,
      [saveId]: {
        saveId,
        deletedAt: Date.now(),
        revision: Math.max(0, Number(entry?.revision) || 0),
        rootHash: typeof entry?.rootHash === 'string' ? entry.rootHash : null,
        runId: typeof entry?.runId === 'string' ? entry.runId : null,
      },
    });
    await persistArchiveRegistry(registry);
    const confirmed = readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE), true);
    if (saveId in confirmed.entries) throw new Error('v3 registry 删除存档后回读仍存在');
    if (!isRecord(confirmed.deletedSaves[saveId])) {
      throw new Error('v3 registry 删除存档后未保留延迟提交栅栏');
    }
    if (tombstoneId && !isRecord(confirmed.gcTombstones[tombstoneId])) {
      throw new Error('v3 registry 删除存档后未保留 GC tombstone');
    }
    return {
      saveId,
      deleted,
      alreadyMissing: !deleted,
      tombstoneId,
      gc: archiveGcQueueSummary(confirmed),
    };
  }

  async function deleteArchiveSaveLocal(request) {
    return withArchiveRegistryLock(() => deleteArchiveSaveLocalUnlocked(request));
  }

  async function readArchiveRoot(request) {
    const saveId = String(request.saveId || '').trim();
    const registry = readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE));
    const entry = registry.entries[saveId];
    if (!isRecord(entry) || typeof entry.rootHash !== 'string') return { entry: null, root: null };
    const root = await readUsableArchiveRoot(entry.rootHash);
    if (root) {
      return {
        entry,
        root,
        degraded: false,
        requestedRootHash: entry.rootHash,
        resolvedRootHash: entry.rootHash,
      };
    }
    const previousRootHash = typeof entry.previousRootHash === 'string' ? entry.previousRootHash.trim() : '';
    if (previousRootHash && previousRootHash !== entry.rootHash) {
      const previousRoot = await readUsableArchiveRoot(previousRootHash);
      if (previousRoot) {
        return {
          entry,
          root: previousRoot,
          degraded: true,
          reason: 'current-root-unreadable',
          requestedRootHash: entry.rootHash,
          resolvedRootHash: previousRootHash,
        };
      }
    }
    return {
      entry,
      root: null,
      degraded: true,
      reason: 'no-readable-root',
      requestedRootHash: entry.rootHash,
      resolvedRootHash: null,
    };
  }

  async function dispatch(request) {
    switch (request.action) {
      case 'probe': {
        return probeArchiveStorage();
      }
      case 'list':
        return { entries: await listBackups() };
      case 'write':
        return { entry: await writeBackup(request.backup) };
      case 'load':
        return { backup: await loadBackup(request.saveId, request.preferredStorage) };
      case 'v3-put-object':
        return putArchiveObject(request);
      case 'v3-get-object':
        return getArchiveObject(request);
      case 'v3-put-image':
        return putArchiveImage(request);
      case 'v3-get-image':
        return getArchiveImage(request);
      case 'v3-commit-root':
        return commitArchiveRoot(request);
      case 'v3-delete-save':
        return deleteArchiveSaveLocal(request);
      case 'v3-read-root':
        return readArchiveRoot(request);
      case 'v3-read-registry':
        return { registry: readArchiveRegistry(await readJsonFile(ARCHIVE_REGISTRY_FILE)) };
      default:
        throw new Error(`不支持的本机存档操作：${String(request.action)}`);
    }
  }

  function isBackupRequest(value, protocolVersion) {
    return (
      isRecord(value) &&
      value.protocolVersion === protocolVersion &&
      typeof value.requestId === 'string' &&
      typeof value.action === 'string'
    );
  }

  function isSerializedWriteAction(action) {
    return action === 'probe'
      || action === 'write'
      || action === 'v3-put-object'
      || action === 'v3-put-image'
      || action === 'v3-commit-root'
      || action === 'v3-delete-save';
  }

  function shouldWakeArchiveGc(action) {
    return action === 'probe' || action === 'v3-commit-root' || action === 'v3-delete-save';
  }

  async function respond(request, protocolVersion, responseEvent) {
    let response;
    try {
      response = {
        protocolVersion,
        requestId: request.requestId,
        action: request.action,
        backend: 'tavern-file',
        ok: true,
        result: await dispatch(request),
      };
    } catch (error) {
      response = {
        protocolVersion,
        requestId: request.requestId,
        action: request.action,
        backend: 'tavern-file',
        ok: false,
        error: {
          code: 'ISLANDMILFCODE_TAVERN_BACKUP_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    try {
      await eventEmit(responseEvent, response);
    } catch (error) {
      console.warn('[IslandMilfCode Saves] response emit failed:', error);
    }
  }

  if (typeof eventOn !== 'function' || typeof eventEmit !== 'function') {
    console.warn('[IslandMilfCode Saves] 酒馆助手事件接口不可用；桥未启动，游戏仍可使用浏览器存档');
    return;
  }

  try {
    const scope = globalThis;
    scope[RUNTIME_KEY]?.stop?.();
    let writeQueue = Promise.resolve();
    let gcTimer = null;
    let gcQueued = false;
    let stopped = false;
    const queueArchiveGcMaintenance = (delay = 250) => {
      if (stopped || gcTimer !== null || gcQueued) return;
      gcTimer = globalThis.setTimeout(() => {
        gcTimer = null;
        if (stopped) return;
        gcQueued = true;
        writeQueue = writeQueue
          .catch(() => undefined)
          .then(async () => {
            let outcome = null;
            try {
              outcome = await runArchiveGcMaintenance();
            } catch {
              // The committed save remains valid and the durable tombstone is
              // retried on the next probe/commit/delete. GC never blocks play.
            } finally {
              gcQueued = false;
            }
            if (!stopped && outcome?.continue) queueArchiveGcMaintenance();
          });
      }, Math.max(0, delay));
    };
    const scheduleResponse = (request, protocolVersion, responseEvent) => {
      if (!isSerializedWriteAction(request.action)) {
        void respond(request, protocolVersion, responseEvent);
        return;
      }
      writeQueue = writeQueue
        .catch(() => undefined)
        .then(() => respond(request, protocolVersion, responseEvent))
        .then(() => {
          if (shouldWakeArchiveGc(request.action)) queueArchiveGcMaintenance();
        });
    };
    const subscription = eventOn(REQUEST_EVENT, request => {
      if (!isBackupRequest(request, PROTOCOL_VERSION)) return;
      scheduleResponse(request, PROTOCOL_VERSION, RESPONSE_EVENT);
    });
    const legacySubscription = eventOn(LEGACY_REQUEST_EVENT, request => {
      if (!isBackupRequest(request, 1)) return;
      scheduleResponse(request, 1, LEGACY_RESPONSE_EVENT);
    });
    scope[RUNTIME_KEY] = {
      stop: () => {
        stopped = true;
        if (gcTimer !== null) globalThis.clearTimeout(gcTimer);
        gcTimer = null;
        subscription?.stop?.();
        legacySubscription?.stop?.();
      },
    };
    console.info(`[IslandMilfCode Saves] v3 本机存档桥已启动：user/files/${ARCHIVE_REGISTRY_FILE}`);
  } catch (error) {
    console.warn('[IslandMilfCode Saves] 桥初始化失败；游戏仍可使用浏览器存档:', error);
  }
})();
