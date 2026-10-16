import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDirectoryAccess } from '../extension/directory-access.js';

const hash = blob => blob.arrayBuffer().then(bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex'));
const notFound = () => new DOMException('missing', 'NotFoundError');
function directory(name) {
  const entries = new Map();
  return { kind: 'directory', name, permission: 'granted', entries,
    async queryPermission() { return this.permission; },
    async getDirectoryHandle(key, { create = false } = {}) {
      if (!entries.has(key) && create) entries.set(key, directory(key));
      if (!entries.has(key)) throw notFound();
      if (entries.get(key).kind !== 'directory') throw new DOMException('', 'TypeMismatchError');
      return entries.get(key);
    },
    async getFileHandle(key, { create = false } = {}) {
      if (!entries.has(key) && create) {
        const entry = { kind: 'file', name: key, blob: new Blob(), writes: [],
          async getFile() { return this.blob; },
          async isSameEntry(other) { return other === this; },
          async createWritable() {
            const chunks = [], file = this;
            return { async write(value) { file.writes.push(value.byteLength);chunks.push(value); await file.onWrite?.(); },
              async close() { file.blob = new Blob(chunks); await file.onClose?.(); }, async abort() { chunks.length = 0;file.aborted = true; } };
          },
        };
        entries.set(key, entry);this.onCreate?.(entry);
      }
      if (!entries.has(key)) throw notFound();
      if (entries.get(key).kind !== 'file') throw new DOMException('', 'TypeMismatchError');
      return entries.get(key);
    },
    async removeEntry(key) { entries.delete(key); },
  };
}
function environment() {
  let active, tail = Promise.resolve(); const records = new Map();
  const repository = { async get(id) { return records.get(id); }, async active() { return active; },
    async put(record) { records.set(record.id, record);active = record.id; } };
  const locks = { request(name, options, work) { const task = tail.catch(() => {}).then(work);tail = task;return task; } };
  return { ...createDirectoryAccess({ repository, locks }), records };
}

test('directory selection remembers only granted handles and exposes metadata without handles', async () => {
  const e = environment(), root = directory('课程文件');
  assert.equal((await e.getDirectoryState()).permission, 'missing');
  const state = await e.saveDirectoryHandle(root);
  assert.deepEqual(Object.keys(state).sort(), ['id', 'name', 'permission']);
  assert.deepEqual(await e.getDirectoryState(), state);
  root.permission = 'prompt';assert.equal((await e.getDirectoryState(state.id)).permission, 'prompt');
  await assert.rejects(e.saveDirectoryHandle(root), { code: 'DIRECTORY_PERMISSION' });
  assert.equal((await e.getDirectoryState()).id, state.id);
});

test('unavailable directory storage reports unsupported without breaking the legacy download UI', async () => {
  const access = createDirectoryAccess({ repository: { async active() { throw new Error('storage unavailable'); } } });
  assert.deepEqual(await access.getDirectoryState(), { id: '', name: '', permission: 'unsupported' });
});

test('directory output creates course folders, writes in bounded chunks, and verifies actual disk bytes', async () => {
  const e = environment(), root = directory('课程文件'), state = await e.saveDirectoryHandle(root);
  const blob = new Blob([new Uint8Array(2 * 1024 * 1024 + 7).fill(19)]), expectedHash = await hash(blob), progress = [];
  const receipt = await e.saveBlobToDirectory(blob, { directoryId: state.id, relativePath: '概率论/第一章.pdf', expectedHash, onProgress: value => progress.push(value) });
  const file = root.entries.get('概率论').entries.get('第一章.pdf');
  assert.deepEqual(file.writes, [1048576, 1048576, 7]);assert.equal(await hash(file.blob), expectedHash);
  assert.deepEqual(receipt, { kind: 'directory', state: 'complete', directoryId: state.id, directoryName: '课程文件', relativePath: '概率论/第一章.pdf', bytes: blob.size, contentHash: expectedHash });
  assert.equal(progress.at(-1).stage, 'verify');assert.equal(progress.at(-1).bytes, blob.size);
  assert.equal(root.entries.has('学习通课件'), false);
});

test('direct output and concurrent duplicate saves preserve existing files and allocate unique names', async () => {
  const e = environment(), root = directory('课程文件'), state = await e.saveDirectoryHandle(root);
  const old = await root.getFileHandle('课件.pdf', { create: true });old.blob = new Blob(['personal notes']);
  const blob = new Blob(['new course']), expectedHash = await hash(blob);
  const receipts = await Promise.all([1, 2].map(() => e.saveBlobToDirectory(blob, { directoryId: state.id, relativePath: '课件.pdf', expectedHash })));
  assert.deepEqual(receipts.map(value => value.relativePath), ['课件 (1).pdf', '课件 (2).pdf']);
  assert.equal(await old.blob.text(), 'personal notes');assert.equal(root.entries.size, 3);
});

test('an in-flight save uses its selected record even after the active directory changes', async () => {
  const e = environment(), first = directory('A'), second = directory('B');
  const a = await e.saveDirectoryHandle(first);await e.saveDirectoryHandle(second);
  const blob = new Blob(['test']);
  await e.saveBlobToDirectory(blob, { directoryId: a.id, relativePath: '课件.pdf', expectedHash: await hash(blob) });
  assert.equal(first.entries.has('课件.pdf'), true);assert.equal(second.entries.size, 0);
});

test('invalid paths and revoked permissions cannot create output files', async () => {
  const e = environment(), root = directory('课程文件'), state = await e.saveDirectoryHandle(root), blob = new Blob(['test']);
  const expectedHash = await hash(blob);
  for (const relativePath of ['../x.pdf', '/x.pdf', 'C:\\x.pdf', 'a//x.pdf', 'a/b/c.pdf', 'x?.pdf']) {
    await assert.rejects(e.saveBlobToDirectory(blob, { directoryId: state.id, relativePath, expectedHash }), { code: 'DIRECTORY_WRITE' });
  }
  root.permission = 'denied';
  await assert.rejects(e.saveBlobToDirectory(blob, { directoryId: state.id, relativePath: '课件.pdf', expectedHash }), { code: 'DIRECTORY_PERMISSION' });
  assert.equal(root.entries.size, 0);
});

test('cancellation aborts the writer and removes only its new empty entry', async () => {
  const e = environment(), root = directory('课程文件'), state = await e.saveDirectoryHandle(root), controller = new AbortController();
  const old = await root.getFileHandle('笔记.pdf', { create: true });old.blob = new Blob(['notes']);
  let created;root.onCreate = file => { created = file;file.onWrite = () => controller.abort(); };
  const blob = new Blob(['test']);
  await assert.rejects(e.saveBlobToDirectory(blob, { directoryId: state.id, relativePath: '课件.pdf', expectedHash: await hash(blob), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(created.aborted, true);assert.equal(root.entries.has('课件.pdf'), false);assert.equal(await old.blob.text(), 'notes');
});

test('a corrupt close or late cancellation cannot be reported as verified success or delete committed contents', async () => {
  for (const failure of ['hash', 'size', 'cancel']) {
    const e = environment(), root = directory('课程文件'), state = await e.saveDirectoryHandle(root), controller = new AbortController();
    root.onCreate = file => { file.onClose = () => {
      if (failure === 'cancel') controller.abort();else file.blob = new Blob([failure === 'hash' ? 'bad!' : 'short']);
    }; };
    const blob = new Blob(['good']);
    await assert.rejects(e.saveBlobToDirectory(blob, { directoryId: state.id, relativePath: '课件.pdf', expectedHash: await hash(blob), signal: controller.signal }), failure === 'cancel' ? { name: 'AbortError' } : { code: 'DIRECTORY_VERIFY' });
    assert.equal(root.entries.has('课件.pdf'), true);
  }
});
