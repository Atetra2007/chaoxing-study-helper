import { allowedURL, sha256 } from './model.js';

export async function inspectImage(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  if (dimensions.width < 128 || dimensions.height < 128) throw new Error('图片尺寸异常，可能是加载占位图。');
  return dimensions;
}

export class CaptureTask {
  constructor(pages, options = {}) {
    this.pages = pages.map(p => ({ ...p, status: 'pending', attempts: 0 }));
    this.cache = new Map();
    this.status = 'idle';
    this.controllers = new Set();
    this.waiters = [];
    // Native browser fetch requires the Window/Worker receiver when stored on an object.
    this.fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
    this.inspect = options.inspect || inspectImage;
    this.onChange = options.onChange || (() => {});
    this.concurrency = options.concurrency || 3;
    this.attemptLimit = options.attemptLimit || 3;
    this.timeoutMs = options.timeoutMs || 20000;
    this.maxPageBytes = options.maxPageBytes || 25 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes || 250 * 1024 * 1024;
    this.retryDelay = options.retryDelay ?? 600;
    this.totalBytes = 0;
  }
  snapshot() {
    return { status: this.status, total: this.pages.length, ready: this.cache.size, bytes: this.totalBytes,
      failed: this.pages.filter(p=>p.status==='failed').length,
      pages: this.pages.map(({number,status,error,attempts})=>({number,status,error,attempts})) };
  }
  emit() { this.onChange(this.snapshot()); }
  pause() { if (this.status === 'running') { this.status = 'paused'; this.emit(); } }
  resume() {
    if (this.status === 'paused') { this.status = 'running'; this.waiters.splice(0).forEach(r=>r()); this.emit(); }
  }
  cancel() {
    this.status = 'cancelled';
    for (const page of this.pages) if (page.status !== 'ready') page.status = 'cancelled';
    for (const controller of this.controllers) controller.abort();
    this.waiters.splice(0).forEach(r=>r());
    this.emit();
  }
  async gate() {
    while (this.status === 'paused') await new Promise(resolve => this.waiters.push(resolve));
    if (this.status === 'cancelled') throw new Error('已取消保存。');
  }
  async readResponse(response) {
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? '资源访问被拒绝，请检查登录状态后重新识别。' : `图片请求失败（HTTP ${response.status}）。`);
    if (response.url && !allowedURL(response.url)) throw new Error('资源跳转到了未支持的域名。');
    const type = response.headers.get('content-type') || '';
    if (!/^image\/(png|jpeg)(;|$)/i.test(type)) throw new Error('返回内容不是 PNG/JPEG 图片，可能是登录页或错误页。');
    const declared = Number(response.headers.get('content-length'));
    if (declared > this.maxPageBytes) throw new Error('单页超过 25 MB，请改用原文件下载。');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('未收到图片内容。');
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxPageBytes) throw new Error('单页过大，已停止读取。');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async getPage(page) {
    let lastError = '图片获取失败。';
    for (let attempt = 0; attempt < this.attemptLimit; attempt++) {
      await this.gate();
      page.status = 'loading'; page.attempts++; page.error = ''; this.emit();
      const controller = new AbortController(); this.controllers.add(controller);
      const timer = setTimeout(()=>controller.abort(), this.timeoutMs);
      try {
        if (!allowedURL(page.url)) throw new Error('资源域名未获支持。');
        const response = await this.fetcher(page.url, { credentials: 'include', redirect: 'error', signal: controller.signal });
        const bytes = await this.readResponse(response);
        const dimensions = await this.inspect(bytes);
        if (page.width && page.height && (page.width !== dimensions.width || page.height !== dimensions.height))
          throw new Error('图片尺寸与识别时不一致，请重新识别课件。');
        const hash = await sha256(bytes);
        if (this.status === 'cancelled') throw new Error('已取消保存。');
        if (this.totalBytes + bytes.length > this.maxTotalBytes) throw new Error('课件图片总量超过 250 MB，第一版暂不支持。');
        this.totalBytes += bytes.length;
        this.cache.set(page.number, { number: page.number, bytes, hash, ...dimensions });
        page.status = 'ready'; this.emit(); return;
      } catch (error) {
        if (this.status === 'cancelled') throw new Error('已取消保存。');
        lastError = error.name === 'AbortError' ? '图片读取超时，请重试。'
          : error instanceof TypeError && /Illegal invocation|incompatible (receiver|type)/i.test(error.message)
            ? '扩展的图片请求调用异常，请更新扩展后重新打开助手。'
          : error instanceof TypeError ? '网络请求失败，请检查网络与扩展的网站访问权限。' : error.message;
      } finally { clearTimeout(timer); this.controllers.delete(controller); }
      if (attempt + 1 < this.attemptLimit) await new Promise(r=>setTimeout(r, this.retryDelay * (attempt + 1)));
    }
    page.status = 'failed'; page.error = lastError; this.emit();
  }
  async run() {
    if (this.running) throw new Error('已有保存任务正在执行。');
    if (this.status === 'cancelled') throw new Error('任务已取消，请重新开始。');
    this.running = true; this.status = 'running';
    const pending = this.pages.filter(p=>!this.cache.has(p.number));
    pending.forEach(p=>{ p.status='pending'; p.error=''; });
    let cursor = 0; this.emit();
    try {
      const worker = async () => {
        while (cursor < pending.length) {
          await this.gate();
          const page = pending[cursor++];
          if (page) await this.getPage(page);
        }
      };
      await Promise.all(Array.from({length:Math.min(this.concurrency, pending.length)}, worker));
      await this.gate();
      this.status = this.cache.size === this.pages.length ? 'ready' : 'needs-retry';
    } finally { this.running = false; this.emit(); }
    return this.snapshot();
  }
}
