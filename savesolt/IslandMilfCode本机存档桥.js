(() => {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const REQUEST_EVENT = 'islandmilfcode:tavern-backup:request:v1';
  const RESPONSE_EVENT = 'islandmilfcode:tavern-backup:response:v1';
  const RUNTIME_KEY = '__islandmilfcodeTavernBackupBridgeV1__';
  const PUBLIC_FILE_ROOT = '/user/files';
  const BUNDLE_FILE = 'islandmilfcode-backups-v2.json';
  const LEGACY_INDEX_FILE = 'islandmilfcode-backup-index-v1.json';
  const AVATAR_IMAGE_FOLDER = 'islandmilfcode-avatars';
  const SAVE_ASSET_FOLDER_PREFIX = 'islandmilfcode-assets-';
  const FORMAT = 'islandmilfcode-tavern-backup';
  const ENVELOPE_VERSION = 1;
  const BUNDLE_VERSION = 2;
  const STORAGE_LABEL = `user/files/${BUNDLE_FILE} + user/images/${AVATAR_IMAGE_FOLDER}`;

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

  async function uploadJsonFile(fileName, value) {
    const response = await fetch('/api/files/upload', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({
        name: fileName,
        data: encodeBase64Utf8(JSON.stringify(value, null, 2)),
      }),
    });
    if (!response.ok) throw new Error(`写入 ${fileName} 失败：${await getResponseError(response)}`);

    const result = await response.json();
    const uploadedPath = normalizePublicPath(result.path);
    if (uploadedPath !== fileUrl(fileName)) {
      throw new Error(`SillyTavern 返回了意外的文件路径：${uploadedPath || '空'}`);
    }
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

  function normalizeBundle(value) {
    if (!isRecord(value) || value.format !== FORMAT || value.formatVersion !== BUNDLE_VERSION) {
      return createEmptyBundle();
    }
    const entries = Array.isArray(value.entries)
      ? value.entries.filter(entry =>
          isRecord(entry) &&
          typeof entry.saveId === 'string' &&
          typeof entry.runId === 'string' &&
          isRecord(entry.state) &&
          isRecord(entry.messages),
        )
      : [];
    return {
      format: FORMAT,
      formatVersion: BUNDLE_VERSION,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
      entries,
    };
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
    const [bundle, legacyIndex] = await Promise.all([
      readJsonFile(BUNDLE_FILE).then(normalizeBundle),
      readJsonFile(LEGACY_INDEX_FILE).then(normalizeLegacyIndex),
    ]);
    const entriesBySaveId = new Map();
    for (const entry of legacyIndex.entries) {
      entriesBySaveId.set(entry.saveId, getPublicEntry(entry, 'legacy-v1'));
    }
    for (const entry of bundle.entries) {
      entriesBySaveId.set(entry.saveId, getPublicEntry(entry, 'bundle-v2'));
    }
    return [...entriesBySaveId.values()].sort(
      (left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0),
    );
  }

  async function writeBackup(input) {
    const backup = assertBackup(input);
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

    const bundle = normalizeBundle(await readJsonFile(BUNDLE_FILE));
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
    const downloadedAssets = await Promise.all(
      (Array.isArray(bundleEntry.assetRefs) ? bundleEntry.assetRefs : []).map(downloadImageAsset),
    );
    for (const asset of downloadedAssets) assetRecords.set(asset.id, asset);

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
      entry.assetsFile ? readJsonFile(entry.assetsFile) : Promise.resolve(null),
    ]);
    if (!isEnvelope(stateEnvelope, 'state') || !isEnvelope(messagesEnvelope, 'messages')) {
      throw new Error('旧版本机备份主体或消息文件格式不正确');
    }
    if (stateEnvelope.saveId !== saveId || messagesEnvelope.saveId !== saveId) {
      throw new Error('旧版本机备份文件与索引中的 saveId 不一致');
    }
    if (assetsEnvelope && (!isEnvelope(assetsEnvelope, 'assets') || assetsEnvelope.saveId !== saveId)) {
      throw new Error('旧版本机备份图片文件与索引中的 saveId 不一致');
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
      ...(assetsEnvelope?.imageAssets?.length ? { imageAssets: assetsEnvelope.imageAssets } : {}),
    };
  }

  async function loadBackup(saveIdValue) {
    const saveId = String(saveIdValue ?? '').trim();
    if (!saveId) throw new Error('读取本机备份时缺少 saveId');

    const bundle = normalizeBundle(await readJsonFile(BUNDLE_FILE));
    const bundleEntry = bundle.entries.find(item => item.saveId === saveId);
    if (bundleEntry) return loadBundledBackup(saveId, bundleEntry);

    const legacyIndex = normalizeLegacyIndex(await readJsonFile(LEGACY_INDEX_FILE));
    const legacyEntry = legacyIndex.entries.find(item => item.saveId === saveId);
    if (legacyEntry) return loadLegacyBackup(saveId, legacyEntry);
    throw new Error('本机备份中没有这个存档');
  }

  async function dispatch(request) {
    switch (request.action) {
      case 'probe': {
        const entries = await listBackups();
        return {
          persistent: true,
          storagePath: STORAGE_LABEL,
          saveCount: entries.length,
          chatId: getCurrentChatId(),
        };
      }
      case 'list':
        return { entries: await listBackups() };
      case 'write':
        return { entry: await writeBackup(request.backup) };
      case 'load':
        return { backup: await loadBackup(request.saveId) };
      default:
        throw new Error(`不支持的本机存档操作：${String(request.action)}`);
    }
  }

  function isBackupRequest(value) {
    return (
      isRecord(value) &&
      value.protocolVersion === PROTOCOL_VERSION &&
      typeof value.requestId === 'string' &&
      typeof value.action === 'string'
    );
  }

  async function respond(request) {
    let response;
    try {
      response = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        action: request.action,
        backend: 'tavern-file',
        ok: true,
        result: await dispatch(request),
      };
    } catch (error) {
      response = {
        protocolVersion: PROTOCOL_VERSION,
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
    await eventEmit(RESPONSE_EVENT, response);
  }

  if (typeof eventOn !== 'function' || typeof eventEmit !== 'function') {
    throw new Error('[IslandMilfCode Saves] 酒馆助手事件接口不可用');
  }

  const scope = globalThis;
  scope[RUNTIME_KEY]?.stop?.();
  let requestQueue = Promise.resolve();
  const subscription = eventOn(REQUEST_EVENT, request => {
    if (!isBackupRequest(request)) return;
    requestQueue = requestQueue.catch(() => undefined).then(() => respond(request));
  });
  scope[RUNTIME_KEY] = {
    stop: () => subscription?.stop?.(),
  };

  console.info(`[IslandMilfCode Saves] 本机存档桥已启动：${STORAGE_LABEL}`);
})();
