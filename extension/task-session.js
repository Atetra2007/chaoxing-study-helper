import { CaptureTask } from './engine.js';
import { allowedURL, directoryRelativePath, normalizePages, outputPath, sha256 } from './model.js';
import { assemblePDF } from './pdf.js';
import { createTempStorage } from './temp-storage.js';
import { localOCRClient } from './local-ocr.js';
import { classifyError, completenessText, diagnosticReport, failureSummary } from './diagnostics.js';

const cancelledError = () => new Error('已取消保存。');
const directoryError = (code, message) => Object.assign(new Error(message), { code });
const initialProgress = () => ({ total: 0, ready: 0, failed: 0, bytes: 0, pages: [] });
const userError = error => {
  const { code, message, action } = classifyError(error);
  return { code, message, action: action.replaceAll('助手页面', '原课件页面') };
};
const retryableError = error => !['SOURCE', 'INCOMPLETE', 'UNSUPPORTED', 'LIMIT'].includes(classifyError(error).code);

/** DOM/Chrome-free save lifecycle. Only the host retains candidates and OCR secrets.
 * services.download must resolve with {id, state:'complete'} after browser confirmation.
 * start() locks synchronously and acknowledges immediately; completion settles after cleanup.
 */
export class TaskSession {
  constructor({ sourceId, services, onChange = () => {}, version = 'preview',
    createStore, assemble, fetcher, inspect, ocrClient, PDFLib, captureOptions = {} }) {
    this.sourceId = sourceId;
    this.sessionId = crypto.randomUUID();
    this.revision = 0;
    this.services = services;
    this.onChange = onChange;
    this.version = version;
    this.createStore = createStore || services.createStore || createTempStorage;
    this.assemble = assemble || services.assemble || assemblePDF;
    this.fetcher = fetcher || services.fetcher || globalThis.fetch.bind(globalThis);
    this.inspect = inspect || services.inspect;
    this.ocrClient = ocrClient || services.ocrClient || localOCRClient;
    this.PDFLib = PDFLib || services.PDFLib || globalThis.PDFLib;
    this.captureOptions = captureOptions;
    this.phase = 'scan';
    this.busy = false;
    this.disposed = false;
    this.cancelled = false;
    this.candidates = [];
    this.selectedIndex = null;
    this.selected = null;
    this.task = null;
    this.controller = null;
    this.ocrToken = null;
    this.ocrConnecting = false;
    this.ocrConnected = false;
    this.options = { course: '', title: '', groupByCourse: true, imageQuality: 'balanced', ocrEnabled: false, saveAs: false,
      destinationMode: 'downloads', directoryId: '', directoryName: '', once: false };
    this.hasSaveAttempt = false;
    this.progress = initialProgress();
    this.error = null;
    this.lastError = null;
    this.warning = '';
    this.historyNote = '';
    this.downloadId = null;
    this.receipt = null;
    this.retryable = false;
    this.metrics = {};
    this.completion = Promise.resolve();
    this.operation = null;
  }

  safeCandidate(candidate, index) {
    if (!candidate) return null;
    return { index, title: String(candidate.title || '学习通课件'), kind: candidate.kind,
      extension: candidate.extension || 'pdf', total: candidate.total || null,
      totalBasis: candidate.totalBasis || 'unknown', issue: candidate.issue ? userError(candidate.issue).message : '' };
  }

  snapshot() {
    const heap = globalThis.performance?.memory?.usedJSHeapSize;
    if (heap) this.metrics.observedJSHeapBytes = Math.max(this.metrics.observedJSHeapBytes || 0, heap);
    const reportPhase = ({ capture: 'fetch', paused: 'fetch', success: 'complete', empty: 'scan' })[this.phase] || this.phase;
    return {
      sourceId: this.sourceId, sessionId: this.sessionId, revision: this.revision, phase: this.phase, busy: this.busy,
      candidates: this.candidates.map((candidate, index) => this.safeCandidate(candidate, index)),
      selectedIndex: this.selectedIndex, selected: this.safeCandidate(this.selected, this.selectedIndex),
      progress: { ...this.progress, pages: this.progress.pages.map(({ number, status, attempts, error }) =>
        ({ number, status, attempts: attempts || 0, error: error ? userError(error).message : '' })) },
      error: this.error ? { ...this.error } : null, warning: this.warning, historyNote: this.historyNote,
      downloadId: this.downloadId, receipt: this.receipt ? { ...this.receipt } : null,
      diagnostic: diagnosticReport({ version: this.version, candidate: this.selected,
        snapshot: this.progress, phase: reportPhase, error: this.lastError, metrics: this.metrics }),
      ocrConnected: this.ocrConnected, ocrConnecting: this.ocrConnecting, options: { ...this.options }, hasSaveAttempt: this.hasSaveAttempt,
      completeness: completenessText(this.selected, this.phase === 'success'),
      filename: this.filename(),
      outputBytes: this.metrics.outputBytes || 0,
      canRetry: !this.busy && !this.disposed && this.phase === 'failed' && this.retryable && !!this.selected && !this.selected.issue,
    };
  }

  filename() {
    if (this.receipt?.relativePath) return this.receipt.relativePath;
    if (!this.selected) return '';
    const path = this.options.destinationMode === 'directory' && !this.options.saveAs ? directoryRelativePath : outputPath;
    // An incomplete directory choice is displayed as unconfigured until the
    // save preflight reports it; rendering must not throw or hide the panel.
    try { return path(this.options.course, this.options.title || this.selected.title, this.selected.extension || 'pdf', this.options.groupByCourse); }
    catch { return ''; }
  }

  emit() {
    this.revision++;
    // A disconnected view must not terminate a running save.
    try { this.onChange(this.snapshot()); } catch { /* The next connected view receives a fresh snapshot. */ }
  }

  assertActive() {
    if (this.cancelled || this.disposed || this.controller?.signal.aborted) throw cancelledError();
  }

  fail(error) {
    this.phase = this.cancelled || this.disposed ? 'cancelled' : 'failed';
    this.lastError = this.phase === 'cancelled' ? cancelledError() : error;
    this.error = userError(this.lastError);
  }

  resetResult() {
    this.lastError = null; this.error = null; this.warning = ''; this.downloadId = null; this.receipt = null;
    this.metrics = {}; this.retryable = false;
  }

  syncPreferences(preferences, { rescan = false } = {}) {
    // Reopening a view may bring preferences from a new course scope. Apply
    // those only before saving, or when an explicit rescan discards the task.
    if (this.busy || this.disposed || (this.hasSaveAttempt && !rescan)
      || !preferences || typeof preferences !== 'object') return false;
    const next = {};
    if (typeof preferences.course === 'string') next.course = preferences.course.trim().slice(0, 70);
    if (['balanced', 'original'].includes(preferences.imageQuality)) next.imageQuality = preferences.imageQuality;
    if (['downloads', 'directory'].includes(preferences.destinationMode)) next.destinationMode = preferences.destinationMode;
    if (typeof preferences.directoryId === 'string') next.directoryId = preferences.directoryId.trim().slice(0, 128);
    if (typeof preferences.directoryName === 'string') next.directoryName = preferences.directoryName.trim().slice(0, 255);
    for (const key of ['groupByCourse', 'ocrEnabled', 'saveAs']) {
      if (typeof preferences[key] === 'boolean') next[key] = preferences[key];
    }
    const changed = Object.entries(next).some(([key, value]) => this.options[key] !== value);
    Object.assign(this.options, next);
    if (changed) this.emit();
    return changed;
  }

  launch(work) {
    this.busy = true;
    this.cancelled = false;
    this.controller = new AbortController();
    // Defer work so the operation is assigned before any synchronous observer runs.
    const operation = Promise.resolve().then(work).catch(error => this.fail(error)).finally(() => {
      this.busy = false;
      this.controller = null;
      this.operation = null;
      this.emit();
    }).then(() => this.snapshot());
    this.operation = operation;
    this.emit();
    return operation;
  }

  async discardTask() {
    const previous = this.task;
    if (!previous) return;
    // Keep ownership when cleanup fails so a later attempt can retry it.
    await previous.dispose();
    if (this.task === previous) this.task = null;
  }

  async scan() {
    if (this.busy || this.disposed) return this.snapshot();
    this.phase = 'scan'; this.resetResult(); this.historyNote = '';
    this.hasSaveAttempt = false;
    this.candidates = []; this.selected = null; this.selectedIndex = null;
    this.progress = initialProgress();
    return this.launch(async () => {
      await this.discardTask(); this.assertActive();
      if (!Number.isInteger(this.sourceId) || this.sourceId < 0) throw new Error('请先打开学习通课件，再点击扩展图标。');
      const candidates = await this.services.scan(this.sourceId);
      this.assertActive();
      this.candidates = candidates || [];
      if (!this.candidates.length) {
        this.phase = 'empty';
        this.error = userError('未发现支持的课件。');
        return;
      }
      this.phase = 'ready';
      if (this.candidates.length === 1) await this.selectCandidate(0);
    });
  }

  async select(index) {
    if (this.busy || this.disposed) return this.snapshot();
    if (index !== null && (!Number.isInteger(index) || !this.candidates[index])) throw new Error('资料选择无效。');
    return this.launch(async () => {
      await this.discardTask(); this.assertActive();
      await this.selectCandidate(index);
    });
  }

  async selectCandidate(index) {
    this.selectedIndex = index;
    this.selected = index === null ? null : this.candidates[index];
    this.phase = 'ready'; this.resetResult(); this.historyNote = '';
    this.hasSaveAttempt = false;
    this.options.title = this.selected?.title || '';
    this.progress = { ...initialProgress(), total: this.selected?.total || 0,
      pages: (this.selected?.pages || []).map(page => ({ number: page.number, status: 'pending', attempts: 0 })) };
    if (this.selected?.issue) {
      this.lastError = this.selected.issue; this.error = userError(this.selected.issue);
    }
    this.emit();
    if (!this.selected) return;
    try {
      const fingerprint = await sha256(this.selected.identity);
      this.assertActive();
      const result = await this.services.historyGet();
      this.assertActive();
      const history = Array.isArray(result) ? result : result?.history || [];
      const previous = history.find(entry => entry.fingerprint === fingerprint);
      if (previous && Number.isFinite(previous.at)) this.historyNote =
        `这个资料入口曾于 ${new Date(previous.at).toLocaleString('zh-CN')} 保存。再次保存会另存副本，不覆盖旧文件。`;
    } catch (error) {
      this.assertActive(); // Missing history must not block saving; cancellation still wins.
    }
  }

  start(options = {}, { retry = false } = {}) {
    if (this.busy || this.disposed || !this.selected || this.selected.issue) return { accepted: false };
    this.options = {
      course: String(options.course ?? this.options.course).trim(),
      title: String(options.title ?? this.options.title).trim() || this.selected.title,
      groupByCourse: typeof options.groupByCourse === 'boolean' ? options.groupByCourse : this.options.groupByCourse,
      imageQuality: options.imageQuality ?? this.options.imageQuality,
      ocrEnabled: options.ocrEnabled === undefined ? this.options.ocrEnabled : options.ocrEnabled === true,
      saveAs: options.saveAs === undefined ? this.options.saveAs : options.saveAs === true,
      destinationMode: ['downloads', 'directory'].includes(options.destinationMode) ? options.destinationMode : this.options.destinationMode,
      directoryId: typeof options.directoryId === 'string' ? options.directoryId.trim().slice(0, 128) : this.options.directoryId,
      directoryName: typeof options.directoryName === 'string' ? options.directoryName.trim().slice(0, 255) : this.options.directoryName,
      once: options.once === true || (retry && options.once === undefined && this.options.once),
    };
    if (this.options.saveAs) this.options.destinationMode = 'downloads';
    this.hasSaveAttempt = true;
    this.phase = 'capture'; this.resetResult();
    this.completion = this.launch(() => this.save({ retry }));
    return { accepted: true };
  }

  captureChanged(progress) {
    this.progress = progress;
    if (['capture', 'paused'].includes(this.phase)) this.phase = progress.status === 'paused' ? 'paused' : 'capture';
    this.emit();
  }

  async fetchOriginal(candidate) {
    if (!allowedURL(candidate.url)) throw new Error('原文件的资源域名未获支持。');
    const timer = setTimeout(() => this.controller?.abort(), 60000);
    try {
      const response = await this.fetcher(candidate.url, { credentials: 'include', redirect: 'error', signal: this.controller.signal });
      this.assertActive();
      if (!response.ok) throw new Error(`原文件请求失败（HTTP ${response.status}），请检查登录状态。`);
      if (response.url && !allowedURL(response.url)) throw new Error('资源跳转到了未支持的域名。');
      if (/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('返回的是网页，未下载为课件。');
      if (Number(response.headers.get('content-length')) > 250 * 1024 * 1024) throw new Error('原文件超过第一版 250 MB 上限。');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('未收到原文件内容。');
      const parts = []; let size = 0;
      try {
        while (true) {
          this.assertActive();
          const { value, done } = await reader.read();
          this.assertActive();
          if (done) break;
          size += value.length;
          if (size > 250 * 1024 * 1024) throw new Error('原文件超过第一版 250 MB 上限。');
          parts.push(value); this.progress.bytes = size; this.emit();
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      const isPDF = String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-';
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
      if (candidate.extension === 'pdf' ? !isPDF : !isZip && !isOle) throw new Error('文件内容与课件格式不符，已停止保存。');
      return bytes;
    } finally { clearTimeout(timer); }
  }

  async save({ retry }) {
    const candidate = this.selected;
    const { title, course, groupByCourse, imageQuality, saveAs, destinationMode, directoryId } = this.options;
    const useOCR = candidate.kind === 'images' && this.options.ocrEnabled;
    const started = performance.now();
    this.metrics = { imageQuality: candidate.kind === 'images' ? imageQuality : 'not-applicable', ocrEnabled: useOCR };
    try {
      if (!['balanced', 'original'].includes(imageQuality)) throw new Error('未知的图片画质选项。');
      let relativePath = '';
      if (destinationMode === 'directory') {
        relativePath = directoryRelativePath(course, title, candidate.extension || 'pdf', groupByCourse);
        if (!directoryId) throw directoryError('DIRECTORY_MISSING', '请先选择本次保存文件夹。');
        if (!this.services.getDirectoryState || !this.services.saveBlobToDirectory) throw directoryError('DIRECTORY_WRITE', '当前环境不能使用自定义文件夹，请改用浏览器下载。');
        const directory = await this.services.getDirectoryState(directoryId); this.assertActive();
        if (directory?.permission === 'unsupported') throw directoryError('DIRECTORY_WRITE', '当前浏览器不能使用自定义文件夹，请改用浏览器下载。');
        if (!directory || directory.permission === 'missing' || directory.id !== directoryId) throw directoryError('DIRECTORY_MISSING', '所选文件夹已不可用，请重新选择。');
        if (directory.permission !== 'granted') throw directoryError('DIRECTORY_PERMISSION', '需要重新授权所选文件夹。');
        this.options.directoryName = typeof directory.name === 'string' ? directory.name.slice(0, 255) : '';
        this.emit();
      }
      const ocr = useOCR ? this.ocrClient(this.ocrToken, { signal: this.controller.signal }) : null;
      if (ocr) { await ocr.check(); this.assertActive(); }
      await this.services.validate(this.sourceId, candidate); this.assertActive();
      let blob, contentHash, outputBytes, duplicates = [], compressionWarning = '';
      if (candidate.kind === 'images') {
        const pages = normalizePages(candidate.pages, candidate.total);
        if (!retry || !this.task || this.task.status === 'cancelled' || this.task.disposed) {
          await this.discardTask(); this.assertActive();
          const store = await this.createStore();
          // Assign before checking cancellation so every newly created store is cleaned.
          this.task = new CaptureTask(pages, { ...this.captureOptions, store, fetcher: this.fetcher, inspect: this.inspect,
            onChange: progress => this.captureChanged(progress) });
          this.assertActive();
        }
        const result = await this.task.run(); this.assertActive();
        if (result.failed) {
          this.phase = 'failed'; this.lastError = new Error('缺页，未生成 PDF。');
          this.retryable = result.pages.filter(page => page.status === 'failed').every(page => retryableError(page.error));
          this.error = { message: `还有 ${result.failed} 页未获取，暂不生成 PDF。`,
            action: failureSummary(result.pages).replaceAll('助手页面', '原课件页面') };
          return;
        }
        await this.services.validate(this.sourceId, candidate); this.assertActive();
        this.metrics.fetchMs = performance.now() - started; this.metrics.imageBytes = this.task.totalBytes;
        this.phase = 'assemble'; this.emit(); const assembled = performance.now();
        const sink = await this.task.store.createOutput();
        if (this.cancelled || this.disposed) { await sink.abort(); this.assertActive(); }
        const output = await this.assemble(this.PDFLib, [...this.task.cache.values()], {
          title, total: candidate.total, quality: imageQuality,
          recognizePage: ocr ? item => ocr.recognize(item) : undefined,
          loadImage: item => this.task.loadImage(item), sink,
          onProgress: (page, total, stage) => { this.progress = { ...this.progress, page, stage }; this.emit(); },
          cancelled: () => this.cancelled || this.disposed,
        });
        this.assertActive();
        blob = output.blob; contentHash = output.contentHash; outputBytes = output.outputBytes;
        duplicates = output.duplicateGroups || [];
        this.metrics.maxPDFObjectBytes = output.maxPDFObjectBytes;
        Object.assign(this.metrics, output.compression);
        if (output.compression?.fallbackPages) compressionWarning = `${output.compression.fallbackPages} 页未能压缩，已保留原画质，页面未丢失。`;
        this.metrics.assembleMs = performance.now() - assembled;
      } else {
        let bytes = await this.fetchOriginal(candidate); this.assertActive();
        this.metrics.fetchMs = performance.now() - started;
        await this.services.validate(this.sourceId, candidate); this.assertActive();
        outputBytes = bytes.length; contentHash = await sha256(bytes); this.assertActive();
        blob = new Blob([bytes], { type: candidate.extension === 'pdf' ? 'application/pdf' : 'application/octet-stream' });
        bytes = null;
      }
      await this.services.validate(this.sourceId, candidate); this.assertActive();
      this.phase = 'download'; this.metrics.outputBytes = outputBytes; this.emit();
      const downloadStarted = performance.now();
      if (destinationMode === 'directory') {
        const receipt = await this.services.saveBlobToDirectory(blob, { directoryId, relativePath, expectedHash: contentHash,
          signal: this.controller.signal, onProgress: progress => {
            const bytes = typeof progress === 'number' ? progress : progress?.bytes;
            if (Number.isFinite(bytes) && bytes >= 0) this.progress = { ...this.progress,
              outputBytes: Math.min(outputBytes, bytes), outputTotal: outputBytes,
              stage: progress?.stage === 'verify' ? 'verify' : 'write' };
            this.emit();
          } });
        this.assertActive();
        const parts = typeof receipt?.relativePath === 'string' ? receipt.relativePath.split('/') : [];
        const expectedParts = relativePath.split('/');
        if (receipt?.kind !== 'directory' || receipt.state !== 'complete' || receipt.directoryId !== directoryId
          || receipt.bytes !== outputBytes || receipt.contentHash !== contentHash || parts.length < 1 || parts.length > 2
          || parts.length !== expectedParts.length || parts.slice(0, -1).join('/') !== expectedParts.slice(0, -1).join('/')
          || !parts.at(-1)?.endsWith(`.${candidate.extension || 'pdf'}`)
          || parts.some(part => !part || part === '.' || part === '..' || /[\\<>:"|?*\x00-\x1f]/.test(part))) {
          throw directoryError('DIRECTORY_VERIFY', '无法确认文件夹中的实际保存结果。');
        }
        this.receipt = { kind: 'directory', state: 'complete', directoryId,
          directoryName: typeof receipt.directoryName === 'string' ? receipt.directoryName.slice(0, 255) : this.options.directoryName,
          relativePath: receipt.relativePath, bytes: receipt.bytes, contentHash: receipt.contentHash };
      } else {
        const url = URL.createObjectURL(blob);
        let download;
        try {
          download = await this.services.download(url, outputPath(course, title, candidate.extension || 'pdf', groupByCourse),
            { signal: this.controller.signal, saveAs });
        } finally { URL.revokeObjectURL(url); }
        this.assertActive();
        if (!Number.isInteger(download?.id) || download?.state !== 'complete') throw new Error('无法确认浏览器下载结果，请查看下载列表。');
        this.downloadId = download.id;
        this.receipt = { kind: 'downloads', state: 'complete', downloadId: download.id };
      }
      this.metrics.downloadMs = performance.now() - downloadStarted;
      // Download completion is authoritative. Late cancellation cannot un-save this file.
      this.phase = 'success'; this.emit();
      let historyWarning = '';
      try {
        const fingerprint = await sha256(candidate.identity);
        await this.services.historyRecord({ fingerprint, contentHash, title, course, pages: candidate.total || null, at: Date.now() });
      } catch { historyWarning = '文件已保存，但本次保存记录未能写入。'; }
      this.warning = [duplicates.length ? `以下页码的图片内容相同，已保留原页码：${duplicates.map(group => group.join('、')).join('；')}。请对照课件检查。` : '',
        compressionWarning, historyWarning].filter(Boolean).join('\n');
    } catch (error) {
      this.fail(error);
      this.retryable = this.phase === 'failed' && retryableError(error);
    }
    finally {
      try {
        if (this.task && !this.task.disposed) {
          if (this.cancelled || this.disposed || this.phase === 'success') await this.task.dispose();
          else await this.task.store.removeOutput();
        }
      } catch { this.warning += `${this.warning ? '\n' : ''}本次临时文件未能清理，将在下次保存时重试清理。`; }
      this.metrics.elapsedMs = performance.now() - started;
      this.emit();
    }
  }

  pause() {
    if (this.busy && this.phase === 'capture' && this.task?.running) this.task.pause();
    return this.snapshot();
  }

  resume() {
    if (this.busy && this.phase === 'paused') this.task?.resume();
    return this.snapshot();
  }

  cancel() {
    if (!this.busy || this.phase === 'success') return this.snapshot();
    this.cancelled = true; this.phase = 'cancelled';
    this.controller?.abort(); this.task?.cancel(); this.emit();
    return this.snapshot();
  }

  async connectOCR(token) {
    if (this.busy || this.disposed) return this.snapshot();
    this.ocrToken = null; this.ocrConnected = false; this.ocrConnecting = true;
    this.error = null; this.lastError = null;
    const phase = this.phase;
    return this.launch(async () => {
      try {
        const client = this.ocrClient(token, { signal: this.controller.signal });
        await client.check(); this.assertActive();
        this.ocrToken = token; this.ocrConnected = true;
        this.phase = phase;
      } finally { this.ocrConnecting = false; }
    });
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.cancel(); this.disposed = true;
    const operation = this.operation;
    this.disposePromise = (async () => {
      await operation;
      await this.discardTask();
      this.ocrToken = null; this.ocrConnected = false;
      this.candidates = []; this.selected = null; this.selectedIndex = null;
    })().catch(error => {
      // A subsequent cleanup attempt may recover a temporary filesystem failure.
      this.disposePromise = null;
      throw error;
    });
    return this.disposePromise;
  }
}
