// OPFS is private to this extension/origin. No course names or URLs are stored.
const ROOT = 'chaoxing-save-v1';
const storageError = () => new Error('本机临时存储不可用或空间不足，请检查磁盘空间后重试。');

export async function createTempStorage({ storage = globalThis.navigator?.storage, locks = globalThis.navigator?.locks } = {}) {
  if (!storage?.getDirectory || !locks?.request) throw storageError();
  let root, directory, release, name, lease;
  try {
    root = await (await storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
    // Held locks protect other assistant tabs. Abandoned sessions are swept.
    for await (const [entry, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !/^session-[a-f0-9-]{36}$/.test(entry)) continue;
      await locks.request(`${ROOT}/${entry}`, { ifAvailable: true }, async lock => {
        if (lock) {
          try { await root.removeEntry(entry, { recursive: true }); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
        }
      });
    }
    name = `session-${crypto.randomUUID()}`;
    await new Promise((resolve, reject) => {
      lease = locks.request(`${ROOT}/${name}`, async () => {
        await new Promise(done => { release = done; resolve(); });
      });
      lease.catch(reject);
    });
    directory = await root.getDirectoryHandle(name, { create: true });
  } catch { release?.(); await lease?.catch(() => {}); throw storageError(); }
  let disposed = false;
  const check = () => { if (disposed) throw storageError(); };
  async function remove(file) {
    try { await directory.removeEntry(file); } catch (error) { if (error.name !== 'NotFoundError') throw storageError(); }
  }
  return {
    async put(number, bytes) {
      check(); let writer;
      try {
        const handle = await directory.getFileHandle(`page-${number}`, { create: true });
        writer = await handle.createWritable();
        await writer.write(bytes); await writer.close();
      } catch { await writer?.abort().catch(() => {}); throw storageError(); }
    },
    async get(number) {
      check();
      try { return new Uint8Array(await (await (await directory.getFileHandle(`page-${number}`)).getFile()).arrayBuffer()); }
      catch { throw storageError(); }
    },
    async createOutput() {
      check(); let handle, writer;
      try {
        handle = await directory.getFileHandle('output.pdf', { create: true });
        writer = await handle.createWritable();
      } catch { throw storageError(); }
      return {
        async write(bytes) { try { await writer.write(bytes); } catch { throw storageError(); } },
        async close() { try { await writer.close(); return { blob: await handle.getFile() }; } catch { throw storageError(); } },
        async abort() { await writer.abort().catch(() => {}); await remove('output.pdf'); },
      };
    },
    async removeOutput() { check(); await remove('output.pdf'); },
    async dispose() {
      if (disposed) return;
      try { await root.removeEntry(name, { recursive: true }); disposed = true; }
      catch { throw storageError(); }
      finally { release(); await lease; }
    },
  };
}
