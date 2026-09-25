/** IndexedDB 持久层：所有 op 先落库再广播，保证标签页关闭/刷新不丢数据。 */

const DB_NAME = 'shared-counter';
const STORE = 'ops';

export function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(new OpStore(req.result));
    req.onerror = () => reject(req.error);
  });
}

class OpStore {
  constructor(db) {
    this.db = db;
  }

  put(op) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(op);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
