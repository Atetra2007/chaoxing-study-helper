// Local development harness. Production extension files are imported unchanged.
import { createBackgroundController } from '/floating-extension/background-controller.js';
import { candidatesFromFrames } from '/floating-extension/model.js';
import { saveDirectoryHandle } from '/floating-extension/directory-access.js';

const base = `${location.origin}/floating-extension/`, extensionId = 'floating-preview-extension', sourceId = 42;
const virtualBase = `chrome-extension://${extensionId}/`;
const mode = new URLSearchParams(location.search).get('test') || 'normal';
const totalBasis = new URLSearchParams(location.search).get('basis') === 'list' ? 'reader-list' : 'explicit-total';
const nativeFetch = window.fetch.bind(window), contexts = new Map(), blobURLs = new Map(), downloads = new Map(), panelWindows = new Map();
const localData = { floatingPreferences: { imageQuality: 'balanced', saveAs: false, ocrEnabled: false, groupByCourse: true }, floatingCourseFolders: {} }, sessionData = {};
let controller, offscreenFrame = null, directoryTab = null, failuresEnabled = mode === 'failure', nextDownload = 1;
let dropNextPanelReady = mode === 'panel-timeout';
let rejectNextPanelReady = mode === 'panel-ready-retry';
const previewVersion = mode === 'panel-import-failure' ? '0.4.3-preview-import-failure' : '0.4.3-preview';
const source = { id: sourceId, windowId: 4000, title: '合成测试资料（31 页）', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=42' };
const sourceDocumentId = 'floating-fixture-source-document';
const frames = [{ frameId: 0, result: { title: source.title } }, { frameId: 3, documentId: 'floating-fixture-reader', result: {
  title: source.title, frameKey: 'https://pan-yz.chaoxing.com/screen/v2/file_floating_fixture', readerKind: 'chaoxing-screen-v2',
  rosterTotal: 31, totalBasis, pages: Array.from({ length: 31 }, (_, i) => ({ number: i + 1,
    url: `https://s3.cldisk.com/fixture/${i + 1}.png`, width: 1023, height: 1447 })), originals: [],
} }];
const backgroundSender = { id: extensionId, url: base + 'background.js' };
function storage(data) {
  return { async get(keys) { return Object.fromEntries((keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys).filter(key => key in data).map(key => [key, structuredClone(data[key])])); },
    async set(value) { Object.assign(data, structuredClone(value)); },
    async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]; } };
}
function deliver(kind, message) {
  const target = contexts.get(kind);
  if (!target || !target.listeners.size) return Promise.reject(new Error(`预览接收器未就绪：${kind}`));
  return new Promise((resolve, reject) => {
    let asynchronous = false, settled = false;
    const respond = value => { if (!settled) { settled = true; resolve(value); } };
    try {
      for (const listener of target.listeners) {
        const value = listener(structuredClone(message), backgroundSender, respond);
        if (value === true) asynchronous = true;
        else if (value && typeof value.then === 'function') { asynchronous = true; value.then(respond, reject); }
      }
      if (!asynchronous && !settled) resolve(undefined);
    } catch (error) { reject(error); }
  });
}
function createChrome(kind, realm) {
  const context = { realm, listeners: new Set() }; contexts.set(kind, context);
  const runtime = {
      id: extensionId, getURL: name => (kind === 'floating' ? virtualBase : base) + name,
      onMessage: { addListener: listener => context.listeners.add(listener), removeListener: listener => context.listeners.delete(listener) },
      async sendMessage(message) {
        if (kind === 'panel' && message.channel === 'cx-ui' && message.command === 'panel-ready' && rejectNextPanelReady) {
          rejectNextPanelReady = false;
          document.getElementById('preview-result').textContent = '已模拟首次就绪通知失败；后续由生产代码重试。';
          return { ok: false, error: '助手界面尚未确认就绪。' };
        }
        if (kind === 'panel' && message.channel === 'cx-ui' && message.command === 'panel-ready' && dropNextPanelReady) {
          dropNextPanelReady = false;return { ok: true }; // Simulate one iframe that never becomes ready.
        }
        const popup = [...panelWindows.values(), ...(directoryTab ? [directoryTab] : [])].find(value => value.window === realm);
        const sender = kind === 'floating' ? { id: extensionId, url: source.url, tab: { ...source }, frameId: 0, documentId: sourceDocumentId }
          : { id: extensionId, url: realm.location?.href || base + (kind === 'offscreen' ? 'offscreen.html' : 'panel.html'),
            ...(kind === 'panel' ? { tab: { id: sourceId } } : popup ? { tab: { ...popup.tab }, frameId: 0 } : {}) };
        // Real HTTP Blob origins differ from chrome-extension origins. Only this
        // development boundary translates URLs; broker validation remains intact.
        if (kind === 'offscreen' && message.channel === 'cx-host-rpc' && message.method === 'download.begin') {
          const virtual = `blob:chrome-extension://${extensionId}/${crypto.randomUUID()}`;
          blobURLs.set(virtual, message.payload.url);
          message = { ...message, payload: { ...message.payload, url: virtual } };
        }
        try { return await controller.handle(message, sender); }
        catch (error) { return { ok: false, error: error.message }; }
      },
  };
  // Offscreen has a restricted runtime subset. In particular, supplying
  // getManifest here would hide a real extension initialization failure.
  if (kind === 'offscreen') return { runtime };
  runtime.getManifest = () => ({ version: previewVersion });
  return {
    runtime,
    storage: { local: storage(localData), session: storage(sessionData) },
    permissions: { async request() { throw new Error('开发预览不连接真实 OCR 服务；请在安装后的扩展中验证连接。'); } },
  };
}
function installFetch(realm) {
  const fetch = realm.fetch.bind(realm);
  realm.fetch = async function(url, options) {
    if (typeof url === 'string' && /^https:\/\/s3\.cldisk\.com\/fixture\/\d+\.png$/.test(url)) {
      const signal = options?.signal;
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, mode === 'slow' ? 1200 : 350);
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
      if (failuresEnabled && url.endsWith('/7.png')) return new realm.Response('simulated failure', { status: 503 });
      const response = await fetch('/sample/' + url.split('/').pop(), options);
      return new realm.Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    }
    return fetch(url, options);
  };
}
const api = {
  runtime: {
    id: extensionId, getURL: name => base + name,
    getManifest: () => ({ version: previewVersion }),
    async getContexts() { return offscreenFrame ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: base + 'offscreen.html' }] : []; },
    async sendMessage(message) {
      if (message.channel === 'cx-host-command') return deliver('offscreen', message);
      if (message.channel === 'cx-directory-state') return Promise.allSettled([deliver('panel', message), deliver('panel-window', message)]);
      if (message.channel === 'cx-panel-state') {
        const value = message.snapshot;
        document.getElementById('preview-state').textContent = `任务：${value.phase} · ${value.progress?.ready || 0}/${value.progress?.total || 0} 页 · 失败 ${value.progress?.failed || 0} 页`;
        if (value.receipt?.kind === 'directory') document.getElementById('preview-result').textContent = `浏览器私有测试目录：${value.receipt.directoryName}/${value.receipt.relativePath} · ${value.receipt.bytes} 字节 · SHA256 ${value.receipt.contentHash}。不是桌面目录验收。`;
        return Promise.allSettled([deliver('panel', message), deliver('panel-window', message)]);
      }
    },
  },
  storage: { local: storage(localData), session: storage(sessionData) },
  windows: {
    async get(id) { const value = panelWindows.get(id); if (!value || value.window?.closed) throw new Error('预览窗口已结束'); return { id, type: 'popup', tabs: [value.tab] }; },
    async update(id) { if (id === source.windowId) { window.focus(); return { id }; } const value = panelWindows.get(id); if (!value || value.window?.closed) throw new Error('预览窗口已结束'); value.window.focus(); return { id }; },
    async remove(id) { const value = panelWindows.get(id); value?.window?.close(); panelWindows.delete(id); contexts.delete('panel-window'); },
    async create(details) {
      const url = new URL(details.url);
      if (url.pathname.endsWith('/panel.html') && url.searchParams.get('view') === 'window') {
        const id = 4300 + panelWindows.size, tab = { id, windowId: id, url: details.url };
        const record = { tab, window: null }; panelWindows.set(id, record);
        // This opens a real top-level HTTP window. Only extension APIs and
        // source metadata are simulated; it is not an installed Edge window.
        record.window = window.open(details.url, '_blank');
        if (!record.window) { panelWindows.delete(id); throw new Error('开发预览的弹出窗口未打开。'); }
        return { id, type: 'popup', tabs: [tab] };
      }
      throw new Error('预览仅允许助手使用独立窗口。');
    },
  },
  tabs: {
    async get(id) { if (id === sourceId) return source; const value = directoryTab?.tab.id === id ? directoryTab : panelWindows.get(id); if (!value || value.window?.closed) throw new Error('预览来源不存在'); return { ...value.tab }; },
    async create(details) {
      if (details.url !== base + 'directory.html') throw new Error('预览授权页地址无效');
      const tab = { id: 4200, windowId: source.windowId, url: details.url };
      directoryTab = { tab, window: window.open(details.url, '_blank') };
      if (!directoryTab.window) { directoryTab = null; throw new Error('预览授权页未打开。'); }
      return { ...tab };
    },
    async update(id) {
      const tab = await api.tabs.get(id);
      if (id === sourceId) window.focus(); else (directoryTab?.tab.id === id ? directoryTab : panelWindows.get(id)).window.focus();
      return tab;
    },
    async query({ windowId }) { const value = panelWindows.get(windowId); return value && !value.window?.closed ? [{ ...value.tab }] : []; },
    async remove(id) { const value = panelWindows.get(id); value?.window?.close(); panelWindows.delete(id); contexts.delete('panel-window'); },
    async sendMessage(id, message, options) { if (id !== sourceId || (options?.documentId && options.documentId !== sourceDocumentId)) throw new Error('预览来源不存在'); return deliver('floating', message); },
  },
  offscreen: {
    async createDocument() {
      if (offscreenFrame) throw new Error('预览后台已存在');
      offscreenFrame = document.createElement('iframe'); offscreenFrame.id = 'offscreen-preview'; offscreenFrame.hidden = true;
      offscreenFrame.src = base + 'offscreen.html'; offscreenFrame.setAttribute('aria-hidden', 'true');
      await new Promise((resolve, reject) => {
        offscreenFrame.onload = resolve; offscreenFrame.onerror = () => reject(new Error('开发后台 iframe 加载失败'));
        document.body.append(offscreenFrame);
      });
    },
  },
  action: { async setBadgeText() {}, async setTitle() {} },
  scripting: { async executeScript() { throw new Error('预览不执行浏览器脚本注入'); } },
  downloads: {
    async download({ url, filename, conflictAction, saveAs = false }) {
      if (conflictAction !== 'uniquify' || !blobURLs.has(url)) throw new Error('开发下载请求无效');
      const id = nextDownload++, item = { id, state: 'in_progress', filename, saveAs: saveAs === true };
      downloads.set(id, item);
      document.getElementById('preview-download-options').textContent = `下载 API 参数：filename=${filename}；saveAs=${item.saveAs}。${item.saveAs ? '模拟请求另存为；此预览不会显示真实系统保存对话框。' : '模拟使用浏览器默认下载目录。'}`;
      const actual = blobURLs.get(url); blobURLs.delete(url);
      setTimeout(async () => {
        try {
          const bytes = await (await nativeFetch(actual)).arrayBuffer();
          const outputName = `floating-export-${Date.now()}-${id}.pdf`;
          const result = await nativeFetch(`/test-output?name=${outputName}`, { method: 'POST', body: bytes });
          if (!result.ok) throw new Error('无法保存开发输出');
          item.outputName = (await result.json()).filename; item.bytes = bytes.byteLength; item.state = 'complete';
          document.getElementById('preview-result').textContent = `已保存：work/extension-ui-test/${item.outputName}（${item.bytes.toLocaleString()} 字节）`;
        } catch (error) { item.state = 'interrupted'; document.getElementById('preview-result').textContent = error.message; }
      }, 100);
      return id;
    },
    async search({ id }) { return downloads.has(id) ? [{ ...downloads.get(id) }] : []; },
    async cancel(id) { if (downloads.has(id)) downloads.get(id).state = 'interrupted'; },
    async show(id) { const item = downloads.get(id); document.getElementById('preview-result').textContent = `模拟“打开所在文件夹”：work/extension-ui-test/${item?.outputName || ''}`; },
  },
};
controller = createBackgroundController(api, {
  async courseContext(id) { return id === sourceId ? { key: 'course:42', name: '合成测试课程' } : { key: '', name: '' }; },
  async scan() { return candidatesFromFrames(structuredClone(frames)); },
  async validate(id, candidate) { if (id !== sourceId || !candidatesFromFrames(frames).some(value => value.identity === candidate.identity)) throw new Error('预览来源变化'); },
});
// Only the local fixture maps a validated virtual extension frame to HTTP.
// Production URL validation and ready nonces execute without modification.
function installPreviewFrameURLs(prototype) {
  const native = Object.getOwnPropertyDescriptor(prototype, 'src');
  Object.defineProperty(prototype, 'src', { ...native, set(value) {
    const url = new URL(value, location.href);
    if (url.protocol === 'chrome-extension:' && url.host === extensionId && url.pathname === '/panel.html'
      && !url.username && !url.password) value = base + 'panel.html' + url.search + url.hash;
    return native.set.call(this, value);
  } });
}
window.__floatingPreview = { createChrome, installFetch };
installPreviewFrameURLs(HTMLIFrameElement.prototype);
window.chrome = createChrome('floating', window);
const downloadOptions = document.createElement('p'); downloadOptions.id = 'preview-download-options';
downloadOptions.textContent = '下载 API 参数将在开始下载时显示；此预览不显示真实系统保存对话框。';
document.getElementById('preview-result').before(downloadOptions);
document.getElementById('preview-mode').textContent = mode === 'panel-timeout' ? '加载故障模式：首次小窗不发送就绪确认；5秒后可点击重新打开，测试只重建小窗。' : mode === 'failure' ? '故障模式：第 7 页持续返回 HTTP 503。首次保存失败后，点击恢复测试网络，再在小窗补存。' : mode === 'slow' ? '慢速模式：逐页延迟，适合验证暂停、继续与收起后运行。' : '普通模式：合成教材完整保存，输出到本地 work 文件夹。';
document.querySelector('header.reader > span').textContent = totalBasis === 'reader-list' ? '阅读器列出 31 页' : '共 31 页';
if (totalBasis === 'reader-list') document.getElementById('preview-mode').textContent += ' 当前仅有阅读器列表页数依据，完成后仍不能宣称已确认整份课件完整。';
const restore = document.getElementById('restore-test-network'); restore.hidden = mode !== 'failure';
restore.addEventListener('click', () => { failuresEnabled = false; restore.disabled = true; restore.textContent = '测试网络已恢复'; });
document.getElementById('preview-toggle').addEventListener('click', () => void controller.toggle(source));
const pages = document.getElementById('sample-pages');
for (let number = 1; number <= 31; number++) {
  const figure = document.createElement('figure'), image = document.createElement('img'), caption = document.createElement('figcaption');
  image.src = `/sample/${number}.png`; image.loading = 'lazy'; image.alt = `合成测试教材第 ${number} 页`;
  caption.textContent = `第 ${number} / 31 页 · 合成测试数据`; figure.append(image, caption); pages.append(figure);
}
// Preview-only automation adapter. The production floating.js stays closed.
const originalAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(options) {
  return Reflect.apply(originalAttachShadow, this, [this.id === 'cx-study-helper-host' ? { ...options, mode: 'open' } : options]);
};
try {
  await import('/floating-extension/floating.js');
} finally {
  Element.prototype.attachShadow = originalAttachShadow;
}
