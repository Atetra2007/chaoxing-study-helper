import { createContentHash, digestHex } from './stream-hash.js';

// pdf-lib 1.17.1 serializes one page at a time. Only small offsets and refs grow.
export class PDFFileWriter {
  constructor(lib, sink, cancelled) {
    this.lib = lib; this.sink = sink; this.cancelled = cancelled;
    this.context = lib.PDFContext.create();
    this.root = this.context.nextRef(); this.catalog = this.context.nextRef();
    this.info = this.context.nextRef(); this.pages = []; this.offsets = [];
    this.position = 0; this.hash = createContentHash(); this.maxObjectBytes = 0;
  }
  async write(data) {
    if (this.cancelled()) throw new Error('已取消保存。');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.sink.write(bytes);
    this.hash.update(bytes); this.position += bytes.length;
  }
  async begin() { await this.write('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'); }
  async object(ref, object) {
    this.offsets[ref.objectNumber] = this.position;
    await this.write(`${ref.objectNumber} 0 obj\n`);
    const bytes = new Uint8Array(object.sizeInBytes());
    if (object.copyBytesInto(bytes, 0) !== bytes.length) throw new Error('PDF 对象长度校验失败。');
    this.maxObjectBytes = Math.max(this.maxObjectBytes, bytes.length);
    await this.write(bytes); await this.write('\nendobj\n');
  }
  async append(part, template) {
    const { PDFObjectCopier, PDFName } = this.lib;
    if (!template) {
      await part.flush();
      template = PDFObjectCopier.for(part.context, this.context).copy(part.getPage(0).node);
      template.set(PDFName.of('Parent'), this.root);
    }
    // Repeated pages share already-written image/font/content resources.
    const ref = this.context.register(template.clone(this.context));
    this.pages.push(ref);
    for (const [reference, object] of this.context.enumerateIndirectObjects()) {
      await this.object(reference, object);
      this.context.delete(reference);
    }
    return template;
  }
  async finish({ title, subject, total }) {
    if (this.pages.length !== total) throw new Error('PDF 页数校验失败。');
    const { PDFHexString } = this.lib;
    const text = value => PDFHexString.fromText(value);
    const pageTreeOffset = this.position;
    await this.object(this.root, this.context.obj({ Type: 'Pages', Count: total, Kids: this.pages }));
    const pageTreeEnd = this.position;
    await this.object(this.catalog, this.context.obj({ Type: 'Catalog', Pages: this.root }));
    await this.object(this.info, this.context.obj({ Title: text(title || '学习通课件'), Producer: text('学习通课件助手'), Subject: text(subject) }));
    const start = this.position, size = this.context.largestObjectNumber + 1;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) {
      const offset = this.offsets[i];
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 1e10) throw new Error('PDF 索引校验失败。');
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    await this.write(xref + `trailer\n<< /Size ${size} /Root ${this.catalog} /Info ${this.info} >>\nstartxref\n${start}\n%%EOF\n`);
    const result = await this.sink.close();
    if (this.cancelled()) throw new Error('已取消保存。');
    if ((result.blob?.size ?? result.bytes?.length) !== this.position) throw new Error('PDF 文件长度校验失败。');
    const contentHash = digestHex(this.hash);
    // Read back committed bytes in bounded chunks, not PDFDocument.load(fullFile).
    const file = result.blob || new Blob([result.bytes]);
    const checkHash = createContentHash();
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      if (this.cancelled()) throw new Error('已取消保存。');
      checkHash.update(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()));
    }
    if (digestHex(checkHash) !== contentHash) throw new Error('PDF 文件内容校验失败。');
    const tree = await file.slice(pageTreeOffset, pageTreeEnd).text();
    const count = /\/Count\s+(\d+)/.exec(tree);
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(tree)?.[1].match(/\d+\s+0\s+R/g) || [];
    if (Number(count?.[1]) !== total || kids.length !== total || kids.some((ref, i) => ref !== this.pages[i].toString())) throw new Error('PDF 页数或顺序校验失败。');
    if (this.cancelled()) throw new Error('已取消保存。');
    return { ...result, contentHash, outputBytes: this.position, maxPDFObjectBytes: this.maxObjectBytes };
  }
}

// Compatibility for small programmatic callers/tests. The app always supplies
// an OPFS sink and never falls back here on temporary storage failure.
export function memoryPDFSink() {
  let parts = [];
  return {
    async write(bytes) { parts.push(bytes); },
    async close() { const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let pos = 0; for (const part of parts) { bytes.set(part, pos); pos += part.length; } parts = []; return { bytes }; },
    async abort() { parts = []; },
  };
}
