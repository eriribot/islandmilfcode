// 极薄的 IndexedDB 封装：只暴露 open/get/put/delete/getAll 五个原子操作。
// 上层 save-store 负责内存 Map / 写队列 / BroadcastChannel。

const DB_NAME = 'islandmilfcode';
const DB_VERSION = 2;
export const IDB_STORE_INDEX = 'save-index';
export const IDB_STORE_PAYLOAD = 'save-payload';
export const IDB_STORE_IMAGE_ASSETS = 'image-assets';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_INDEX)) {
        db.createObjectStore(IDB_STORE_INDEX, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_PAYLOAD)) {
        db.createObjectStore(IDB_STORE_PAYLOAD, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_IMAGE_ASSETS)) {
        db.createObjectStore(IDB_STORE_IMAGE_ASSETS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('indexedDB.open blocked'));
  });
  return dbPromise;
}

function txStore(db: IDBDatabase, storeName: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb request failed'));
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('idb transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('idb transaction failed'));
  });
}

/** 取一条记录；不存在返回 null。 */
export async function idbGet<T>(storeName: string, id: string): Promise<T | null> {
  const db = await openDb();
  const result = await promisifyRequest(txStore(db, storeName, 'readonly').get(id));
  if (!result) return null;
  // 我们存的形状是 { id, value }，剥掉 id 再返回。
  const wrapped = result as { id: string; value: T };
  return wrapped.value;
}

/** 写入一条记录（覆盖式）。 */
export async function idbPut<T>(storeName: string, id: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  const completed = waitForTransaction(tx);
  const requested = promisifyRequest(tx.objectStore(storeName).put({ id, value }));
  await Promise.all([requested, completed]);
}

/** 删除一条记录。 */
export async function idbDelete(storeName: string, id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  const completed = waitForTransaction(tx);
  const requested = promisifyRequest(tx.objectStore(storeName).delete(id));
  await Promise.all([requested, completed]);
}

/** 取整个 store 的所有记录。 */
export async function idbGetAll<T>(storeName: string): Promise<Array<{ id: string; value: T }>> {
  const db = await openDb();
  const result = await promisifyRequest(txStore(db, storeName, 'readonly').getAll());
  return (result as Array<{ id: string; value: T }>) ?? [];
}

/** 关闭并丢弃缓存的连接（一般只在测试/异常恢复时用）。 */
export function closeIdb(): void {
  if (!dbPromise) return;
  dbPromise.then(db => db.close()).catch(() => {});
  dbPromise = null;
}
