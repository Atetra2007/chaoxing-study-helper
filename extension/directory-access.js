import { createContentHash, digestHex } from './stream-hash.js';

const DB_NAME = 'cx-directory-access-v1', ID = /^[A-Za-z0-9_-]{16,96}$/;
const CHUNK = 1024 * 1024;
const descriptions = {
  DIRECTORY_MISSING: '保存文件夹不可用，请重新选择文件夹。',
  DIRECTORY_PERMISSION: '保存文件夹需要授权，请重新授权后保存。',
  DIRECTORY_WRITE: '文件夹写入未完成，请检查磁盘空间和目录权限后重试。',
  DIRECTORY_VERIFY: '文件写入校验未通过，尚未确认保存成功。',
};
export function directoryError(code) { return Object.assign(new Error(descriptions[code] || descriptions.DIRECTORY_WRITE), { code }); }
const checkAbort = signal => { if (signal?.aborted) throw new DOMException('已取消保存。', 'AbortError'); };
function translate(error) {
  if (error?.code?.startsWith?.('DIRECTORY_') || error?.name === 'AbortError') return error;
  if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return directoryError('DIRECTORY_PERMISSION');
  if (error?.name === 'NotFoundError') return directoryError('DIRECTORY_MISSING');
  return directoryError('DIRECTORY_WRITE');
}

// Handles stay in the extension origin's IndexedDB. Chrome runtime messages
// carry only record IDs and display metadata, never these capability objects.
export function createDirectoryRepository(indexedDB = globalThis.indexedDB) {
  async function operation(stores, mode, work) {
    if (!indexedDB) throw directoryError('DIRECTORY_MISSING');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('directories', { keyPath: 'id' });
        database.createObjectStore('state');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(directoryError('DIRECTORY_MISSING'));
      request.onblocked = () => reject(directoryError('DIRECTORY_MISSING'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode); let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(directoryError('DIRECTORY_MISSING'));
        try { work(tx, value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
      });
    } finally { db.close(); }
  }
  return {
    get: id => operation(['directories'], 'readonly', (tx, done) => {
      tx.objectStore('directories').get(id).onsuccess = event => done(event.target.result);
    }),
    active: () => operation(['state'], 'readonly', (tx, done) => {
      tx.objectStore('state').get('active').onsuccess = event => done(event.target.result);
    }),
    put: record => operation(['directories', 'state'], 'readwrite', tx => {
      tx.objectStore('directories').put(record);
      tx.objectStore('state').put(record.id, 'active');
    }),
  };
}

export function createDirectoryAccess({ repository = createDirectoryRepository(), locks = globalThis.navigator?.locks } = {}) {
  async function getRecord(id) {
    const selected = id === undefined ? await repository.active() : id;
    if (!ID.test(selected || '')) return null;
    return await repository.get(selected) || null;
  }
  async function state(id) {
    let record;
    try { record = await getRecord(id); }
    catch { return { id: '', name: '', permission: 'unsupported' }; }
    if (!record?.handle || record.handle.kind !== 'directory') return { id: '', name: '', permission: 'missing' };
    let permission = 'unsupported';
    try {
      if (typeof record.handle.queryPermission === 'function') permission = await record.handle.queryPermission({ mode: 'readwrite' });
    } catch (error) { permission = error?.name === 'NotFoundError' ? 'missing' : 'denied'; }
    if (!['granted', 'prompt', 'denied', 'missing', 'unsupported'].includes(permission)) permission = 'denied';
    return { id: record.id, name: String(record.handle.name || record.name || '').slice(0, 120), permission };
  }
  async function remember(handle) {
    if (handle?.kind !== 'directory' || typeof handle.queryPermission !== 'function') throw directoryError('DIRECTORY_MISSING');
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw directoryError('DIRECTORY_PERMISSION');
    const record = { id: crypto.randomUUID(), name: String(handle.name).slice(0, 120), handle };
    await repository.put(record);
    return { id: record.id, name: record.name, permission: 'granted' };
  }
  async function write(blob, { directoryId, relativePath, expectedHash, signal, onProgress = () => {} } = {}) {
    checkAbort(signal);
    const segments = typeof relativePath === 'string' ? relativePath.split('/') : [];
    if (!ID.test(directoryId || '') || !segments.length || segments.length > 2 ||
      segments.some(value => !value || value === '.' || value === '..' || value.length > 180 || /[<>:"\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)) ||
      !/^[a-f0-9]{64}$/.test(expectedHash || '') || !blob || !Number.isSafeInteger(blob.size) || blob.size <= 0 ||
      typeof blob.slice !== 'function' || !locks?.request) throw directoryError('DIRECTORY_WRITE');
    try {
      // Serialize all this extension's output allocation, including multiple
      // source tabs. Other desktop programs are outside this lock's scope.
      return await locks.request('cx-directory-output', { signal }, async () => {
        checkAbort(signal);
        const record = await getRecord(directoryId);
        if (!record) throw directoryError('DIRECTORY_MISSING');
        if ((await state(directoryId)).permission !== 'granted') throw directoryError('DIRECTORY_PERMISSION');
        let target = record.handle;
        if (segments.length === 2) target = await target.getDirectoryHandle(segments[0], { create: true });
        checkAbort(signal);
        const requested = segments.at(-1), dot = requested.lastIndexOf('.');
        const stem = dot > 0 ? requested.slice(0, dot) : requested, extension = dot > 0 ? requested.slice(dot) : '';
        let fileHandle, filename;
        for (let count = 0; count < 1000; count++) {
          checkAbort(signal);
          filename = count ? `${stem} (${count})${extension}` : requested;
          try { await target.getFileHandle(filename); continue; }
          catch (error) {
            if (error?.name === 'TypeMismatchError') continue;
            if (error?.name !== 'NotFoundError') throw error;
          }
          fileHandle = await target.getFileHandle(filename, { create: true });
          // Recheck immediately before truncation; an external app may race us.
          if ((await fileHandle.getFile()).size !== 0) { fileHandle = null; continue; }
          break;
        }
        if (!fileHandle) throw directoryError('DIRECTORY_WRITE');
        let writer, committed = false;
        try {
          checkAbort(signal);
          writer = await fileHandle.createWritable({ keepExistingData: false });
          for (let offset = 0; offset < blob.size; offset += CHUNK) {
            checkAbort(signal);
            const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + CHUNK)).arrayBuffer());
            checkAbort(signal); await writer.write(bytes);
            onProgress({ bytes: offset + bytes.length, stage: 'write' });
          }
          checkAbort(signal); await writer.close(); committed = true;
          const actual = await fileHandle.getFile();
          if (actual.size !== blob.size) throw directoryError('DIRECTORY_VERIFY');
          const hash = createContentHash();
          for (let offset = 0; offset < actual.size; offset += CHUNK) {
            checkAbort(signal);
            const bytes = new Uint8Array(await actual.slice(offset, Math.min(actual.size, offset + CHUNK)).arrayBuffer());
            hash.update(bytes); onProgress({ bytes: offset + bytes.length, stage: 'verify' });
          }
          if (digestHex(hash) !== expectedHash) throw directoryError('DIRECTORY_VERIFY');
          checkAbort(signal);
          return { kind: 'directory', state: 'complete', directoryId, directoryName: record.name,
            relativePath: [...segments.slice(0, -1), filename].join('/'), bytes: actual.size, contentHash: expectedHash };
        } catch (error) {
          if (!committed) {
            await writer?.abort().catch(() => {});
            // Only remove our newly allocated empty entry, never a completed
            // file or an existing file that could contain personal notes.
            try {
              const current = await target.getFileHandle(filename);
              if (await current.isSameEntry(fileHandle) && (await current.getFile()).size === 0) await target.removeEntry(filename);
            } catch { /* Keep uncertain contents rather than deleting them. */ }
          }
          throw error;
        }
      });
    } catch (error) { throw translate(error); }
  }
  return { getDirectoryRecord: getRecord, getDirectoryState: state, saveDirectoryHandle: remember, saveBlobToDirectory: write };
}
const access = createDirectoryAccess();
export const getDirectoryRecord = id => access.getDirectoryRecord(id);
export const getDirectoryState = id => access.getDirectoryState(id);
export const saveDirectoryHandle = handle => access.saveDirectoryHandle(handle);
export const saveBlobToDirectory = (blob, options) => access.saveBlobToDirectory(blob, options);
