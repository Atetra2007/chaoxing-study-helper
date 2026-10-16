import { allowedURL } from './model.js';
import { scanTab, validateSource } from './browser.js';
import { getCourseContext } from './course-context.js';

const UI_COMMANDS = new Set(['init', 'scan', 'select', 'start', 'retry', 'pause', 'resume', 'cancel', 'show-file', 'connect-ocr', 'prefs', 'collapse', 'resize', 'panel-ready', 'directory-status', 'choose-directory']);
const PREF_KEY = 'floatingPreferences';
const FOLDERS_KEY = 'floatingCourseFolders';
const DIRECTORY_ID = /^[a-zA-Z0-9_-]{16,96}$/;
const PANEL_WINDOWS_KEY = 'panelWindowBindings';
const DIRECTORY_PAGE_KEY = 'directoryPageBinding';
const downloadKey = sourceId => `floating-download-${sourceId}`;

export function safePreferences(value = {}) {
  if (!value || typeof value !== 'object') return {};
  const prefs = {};
  if (typeof value.course === 'string') prefs.course = value.course.trim().slice(0, 70);
  if (['balanced', 'original'].includes(value.imageQuality)) prefs.imageQuality = value.imageQuality;
  if (typeof value.saveAs === 'boolean') prefs.saveAs = value.saveAs;
  if (typeof value.ocrEnabled === 'boolean') prefs.ocrEnabled = value.ocrEnabled;
  if (typeof value.groupByCourse === 'boolean') prefs.groupByCourse = value.groupByCourse;
  if (['downloads', 'directory'].includes(value.destinationMode)) prefs.destinationMode = value.destinationMode;
  if (typeof value.directoryId === 'string' && DIRECTORY_ID.test(value.directoryId)) prefs.directoryId = value.directoryId;
  if (typeof value.directoryName === 'string') prefs.directoryName = value.directoryName.trim().slice(0, 120);
  return prefs;
}
function safeDirectory(value) {
  return {
    id: typeof value?.id === 'string' && DIRECTORY_ID.test(value.id) ? value.id : '',
    name: typeof value?.name === 'string' ? value.name.trim().slice(0, 120) : '',
    permission: ['granted', 'prompt', 'denied', 'missing', 'unsupported'].includes(value?.permission) ? value.permission : 'missing',
  };
}
export function isPanelSender(api, sender) {
  return sender?.id === api.runtime.id && Number.isInteger(sender.tab?.id) && sender.tab.id >= 0
    && sender.url?.split('?')[0] === api.runtime.getURL('panel.html');
}
export function isHostSender(api, sender) {
  return sender?.id === api.runtime.id && !sender.tab
    && sender.url === api.runtime.getURL('offscreen.html');
}
export function isDirectorySender(api, sender) {
  const url = api.runtime.getURL('directory.html');
  return sender?.id === api.runtime.id && sender.url === url
    && (sender.frameId === undefined || sender.frameId === 0)
    && (!sender.origin || sender.origin === api.runtime.getURL('').replace(/\/$/, ''))
    && (!sender.tab?.url || sender.tab.url === url);
}

// Task state belongs to the offscreen document. Download IDs survive a worker
// restart in storage.session; credentials never enter this storage or page DOM.
export function createBackgroundController(api, { scan = scanTab, validate = validateSource, courseContext = id => getCourseContext(id, api) } = {}) {
  let creating = null, historyWrite = Promise.resolve(), preferenceWrite = Promise.resolve();
  let choosingDirectory = null, directoryBindingWrite = Promise.resolve();
  const sourceBarriers = new Map();
  const sourceCourses = new Map();
  const sourceGenerations = new Map();
  const toggleRequests = new Map();
  const panelWindows = new Map(), panelOpenRequests = new Map(), pendingPanels = new Map();
  let panelRestore = null, panelWrite = Promise.resolve();
  const hostURL = api.runtime.getURL('offscreen.html');
  // getManifest is available in the worker, but not in an offscreen context.
  const version = api.runtime.getManifest().version;
  const validId = value => Number.isInteger(value) && value >= 0;
  function panelWindowURL(load) {
    const url = new URL(api.runtime.getURL('panel.html'));
    url.searchParams.set('view', 'window'); url.searchParams.set('load', load);
    return url.href;
  }
  function windowLoad(value) {
    try {
      const url = new URL(value), load = url.searchParams.get('load');
      return DIRECTORY_ID.test(load || '') && value === panelWindowURL(load) ? load : null;
    } catch { return null; }
  }
  function restorePanelWindows() {
    if (!panelRestore) panelRestore = (async () => {
      const records = (await api.storage.session.get(PANEL_WINDOWS_KEY))[PANEL_WINDOWS_KEY];
      const sources = new Set(), loads = new Set();
      for (const record of Array.isArray(records) ? records.slice(0, 100) : []) {
        if (!validId(record?.tabId) || !validId(record.windowId) || !validId(record.sourceId)
          || record.tabId === record.sourceId || !DIRECTORY_ID.test(record.load || '')
          || !DIRECTORY_ID.test(record.sourceDocumentId || '') || (sourceGenerations.get(record.sourceId) || 0) !== 0
          || (sourceGenerations.get(record.tabId) || 0) !== 0
          || panelWindows.has(record.tabId) || sources.has(record.sourceId) || loads.has(record.load)) continue;
        panelWindows.set(record.tabId, { tabId: record.tabId, windowId: record.windowId, sourceId: record.sourceId, load: record.load, sourceDocumentId: record.sourceDocumentId, generation: 0, tabGeneration: 0 });
        sources.add(record.sourceId); loads.add(record.load);
      }
    })().catch(error => { panelRestore = null; throw error; });
    return panelRestore;
  }
  function persistPanelWindows() {
    const write = panelWrite.catch(() => {}).then(() => api.storage.session.set({ [PANEL_WINDOWS_KEY]: [...panelWindows.values()].map(({ generation, tabGeneration, ...record }) => record) }));
    panelWrite = write; return write;
  }
  async function forgetPanelWindow(record, close = false) {
    let storageError;
    if (panelWindows.get(record.tabId)?.load === record.load) {
      panelWindows.delete(record.tabId);
      try { await persistPanelWindows(); } catch (error) { storageError = error; }
    }
    if (close) {
      // Close only the registered extension tab, never an entire user window.
      try {
        const tab = await api.tabs.get(record.tabId);
        if (tab.windowId === record.windowId && (tab.pendingUrl || tab.url) === panelWindowURL(record.load)) await api.tabs.remove(record.tabId);
      } catch { /* The panel may already have closed or navigated away. */ }
    }
    if (storageError) throw storageError;
  }
  async function clearSourcePanels(sourceId) {
    await restorePanelWindows();
    await Promise.all([...panelWindows.values()].filter(record => record.sourceId === sourceId).map(record => forgetPanelWindow(record, true)));
    // Also erase stale stored records skipped while restoration raced navigation.
    await persistPanelWindows();
  }
  async function probeSource(sourceId, documentId) {
    const source = await currentSource(sourceId);
    if (source.pendingUrl && source.pendingUrl !== source.url) throw new Error('原课件页面已变化，请从原页面重新打开助手。');
    let response;
    try { response = await api.tabs.sendMessage(sourceId, { channel: 'cx-floating', action: 'probe' }, { frameId: 0, documentId }); }
    catch { throw new Error('原课件页面已变化，请从原页面重新打开助手。'); }
    if (response?.ok !== true) throw new Error('原课件页面已变化，请从原页面重新打开助手。');
  }
  async function verifyCreatedPanel(record) {
    let tab;
    try { tab = await api.tabs.get(record.tabId); }
    catch { throw new Error('助手小窗已关闭，请重新打开。'); }
    if (tab.windowId !== record.windowId || (tab.pendingUrl || tab.url) !== panelWindowURL(record.load)
      || record.tabGeneration !== (sourceGenerations.get(record.tabId) || 0)) throw new Error('助手小窗已变化，请重新打开。');
  }
  async function panelContext(sender) {
    const url = new URL(sender.url);
    if (url.searchParams.get('view') !== 'window') return { sourceId: sender.tab.id, window: null };
    const load = windowLoad(sender.url);
    if (!load || sender.frameId !== 0) throw new Error('不支持的助手请求。');
    const pending = pendingPanels.get(load);
    if (pending) await pending;
    await restorePanelWindows();
    const record = panelWindows.get(sender.tab.id);
    if (!record || record.load !== load || record.generation !== (sourceGenerations.get(record.sourceId) || 0)
      || record.tabGeneration !== (sourceGenerations.get(record.tabId) || 0)
      || (sender.tab.windowId !== undefined && sender.tab.windowId !== record.windowId)) throw new Error('小窗连接已失效，请从原课件页面重新打开。');
    const tab = await api.tabs.get(record.tabId);
    if (tab.windowId !== record.windowId || tab.url !== panelWindowURL(load)
      || (tab.pendingUrl && tab.pendingUrl !== tab.url)) throw new Error('小窗连接已失效，请从原课件页面重新打开。');
    await probeSource(record.sourceId, record.sourceDocumentId);
    if (record.generation !== (sourceGenerations.get(record.sourceId) || 0)
      || record.tabGeneration !== (sourceGenerations.get(record.tabId) || 0)) throw new Error('原课件页面已变化，请从原页面重新打开助手。');
    return { sourceId: record.sourceId, window: record };
  }
  async function openPanelWindow(sender) {
    if (sender?.id !== api.runtime.id || sender.frameId !== 0 || !validId(sender.tab?.id)
      || !allowedURL(sender.url, true) || !DIRECTORY_ID.test(sender.documentId || '')) throw new Error('不支持的助手请求。');
    const sourceId = sender.tab.id, request = { generation: sourceGenerations.get(sourceId) || 0 };
    await readySource(sourceId, request);
    const source = await currentSource(sourceId);
    assertRequest(sourceId, request);
    if (source.url !== sender.url || (source.pendingUrl && source.pendingUrl !== source.url)) throw new Error('当前课件页面已变化，请重新打开助手。');
    await probeSource(sourceId, sender.documentId); assertRequest(sourceId, request);
    if (panelOpenRequests.has(sourceId)) return panelOpenRequests.get(sourceId);
    const opening = (async () => {
      await restorePanelWindows(); assertRequest(sourceId, request);
      const existing = [...panelWindows.values()].find(record => record.sourceId === sourceId);
      if (existing) {
        let usable = false;
        try {
          const tab = await api.tabs.get(existing.tabId);
          usable = existing.generation === request.generation && existing.sourceDocumentId === sender.documentId
            && existing.tabGeneration === (sourceGenerations.get(existing.tabId) || 0)
            && tab.windowId === existing.windowId && tab.url === panelWindowURL(existing.load)
            && (!tab.pendingUrl || tab.pendingUrl === tab.url);
          if (usable) { await api.windows.update(existing.windowId, { focused: true }); assertRequest(sourceId, request); }
        } catch { usable = false; }
        assertRequest(sourceId, request);
        if (usable) return { sourceId };
        await forgetPanelWindow(existing, true);
      }
      const load = crypto.randomUUID();
      let finish, record;
      const pending = new Promise(resolve => { finish = resolve; });
      pendingPanels.set(load, pending);
      try {
        assertRequest(sourceId, request);
        const created = await api.windows.create({ url: panelWindowURL(load), type: 'popup', width: 390, height: 640 });
        if (!validId(created?.id)) throw new Error('无法创建助手小窗，请重试。');
        const tabs = created.tabs || await api.tabs.query({ windowId: created.id });
        if (tabs.length !== 1 || !validId(tabs[0]?.id) || tabs[0].id === sourceId) throw new Error('无法确认助手小窗，请重试。');
        record = { sourceId, tabId: tabs[0].id, windowId: created.id, load, sourceDocumentId: sender.documentId,
          generation: request.generation, tabGeneration: sourceGenerations.get(tabs[0].id) || 0 };
        await verifyCreatedPanel(record);
        assertRequest(sourceId, request);
        panelWindows.set(record.tabId, record); await persistPanelWindows();
        await verifyCreatedPanel(record);
        assertRequest(sourceId, request);
        if (panelWindows.get(record.tabId) !== record) throw new Error('助手小窗连接已失效，请重新打开。');
        return { sourceId };
      } catch (error) {
        if (record) await forgetPanelWindow(record, true).catch(() => {});
        throw error;
      } finally {
        pendingPanels.delete(load); finish();
      }
    })();
    panelOpenRequests.set(sourceId, opening);
    try { return await opening; }
    finally { if (panelOpenRequests.get(sourceId) === opening) panelOpenRequests.delete(sourceId); }
  }
  async function hasHost() {
    return (await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [hostURL] })).length > 0;
  }
  async function ensureHost() {
    if (!api.offscreen?.createDocument || !api.runtime.getContexts) throw new Error('当前浏览器不支持后台保存，请更新 Edge 后重新加载扩展。');
    if (creating) return creating;
    creating = (async () => {
      if (!await hasHost()) await api.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: '在用户保存课件时创建文件 Blob，并在悬浮窗收起后继续逐页生成和校验 PDF。' });
    })();
    try { await creating; } finally { creating = null; }
  }
  function assertRequest(sourceId, request) {
    if (request.generation !== (sourceGenerations.get(sourceId) || 0)) throw new Error('当前课程已变化，请重新识别后保存。');
  }
  async function callHost(command, sourceId, payload = {}, request = null) {
    await ensureHost();
    if (request) assertRequest(sourceId, request);
    const response = await api.runtime.sendMessage({ channel: 'cx-host-command', command, sourceId, version, payload });
    if (!response?.ok) throw new Error(response?.error || '后台保存未连接，请重新打开助手。');
    return response;
  }
  async function currentSource(sourceId) {
    let tab;
    try { tab = await api.tabs.get(sourceId); } catch { throw new Error('原课件页面已关闭，请重新打开课件。'); }
    if (!allowedURL(tab.url, true)) throw new Error('请在学习通课件页面打开助手。');
    return tab;
  }
  async function readySource(sourceId, request) {
    if (sourceBarriers.has(sourceId)) await sourceBarriers.get(sourceId);
    assertRequest(sourceId, request);
    await currentSource(sourceId);
    assertRequest(sourceId, request);
  }
  async function contextFor(sourceId) {
    const value = await courseContext(sourceId);
    return value && /^course:[1-9]\d{0,29}$/.test(value.key || '')
      ? { key: value.key, name: typeof value.name === 'string' ? value.name.trim().slice(0, 70) : '' }
      : { key: '', name: '' };
  }
  async function preferences(context) {
    const stored = await api.storage.local.get([PREF_KEY, FOLDERS_KEY]);
    // Old global course values cannot safely be assigned to the current course.
    const { course: ignored, ...global } = safePreferences(stored[PREF_KEY]);
    const remembered = context.key && stored[FOLDERS_KEY]?.[context.key];
    return { imageQuality: 'balanced', saveAs: false, ocrEnabled: false, groupByCourse: true, destinationMode: 'downloads', ...global,
      course: typeof remembered === 'string' ? remembered.slice(0, 70) : context.name };
  }
  function queuePreferences(work) {
    const operation = preferenceWrite.catch(() => {}).then(work);
    preferenceWrite = operation;
    return operation;
  }
  function setPreferences(sourceId, payload, request, { persist = true } = {}) {
    return queuePreferences(async () => {
      await readySource(sourceId, request);
      const context = await contextFor(sourceId);
      assertRequest(sourceId, request);
      if ((request.course !== undefined && request.course !== context.key)
        || (sourceCourses.has(sourceId) && sourceCourses.get(sourceId) !== context.key)) throw new Error('当前课程已变化，请重新识别后保存。');
      sourceCourses.set(sourceId, context.key);
      const value = { ...await preferences(context), ...safePreferences(payload) };
      assertRequest(sourceId, request);
      // "Save as once" borrows the current settings without changing the next
      // save's destination or the remembered folder for this course.
      if (!persist) return value;
      const { course, ...global } = value;
      const updates = { [PREF_KEY]: global };
      if (context.key && typeof payload.course === 'string') {
        const stored = (await api.storage.local.get(FOLDERS_KEY))[FOLDERS_KEY] || {};
        // Keep a bounded map of course IDs and user-facing folder names only.
        const entries = Object.entries(stored).filter(([key, name]) => key !== context.key && /^course:[1-9]\d{0,29}$/.test(key) && typeof name === 'string').slice(-99);
        updates[FOLDERS_KEY] = Object.fromEntries([...entries, [context.key, course]]);
      }
      // Navigation can arrive during either storage read. Never let an old
      // panel write preferences or dispatch a save after its source changed.
      assertRequest(sourceId, request);
      await api.storage.local.set(updates);
      assertRequest(sourceId, request);
      return value;
    });
  }
  function initializePreferences(sourceId, request) {
    // Reads share the write queue so a rescan cannot restore older settings
    // while a previous panel change is still waiting for context or storage.
    return queuePreferences(async () => {
      await readySource(sourceId, request);
      const context = await contextFor(sourceId);
      assertRequest(sourceId, request);
      if (sourceCourses.has(sourceId) && sourceCourses.get(sourceId) !== context.key) {
        const dropping = drop(sourceId);
        request.generation = sourceGenerations.get(sourceId);
        await dropping;
        assertRequest(sourceId, request);
      }
      sourceCourses.set(sourceId, context.key);
      const value = await preferences(context);
      assertRequest(sourceId, request);
      return { context, preferences: value };
    });
  }
  async function floating(sourceId, message) {
    try { await api.tabs.sendMessage(sourceId, { channel: 'cx-floating', ...message }, { frameId: 0 }); } catch { /* Source may already be closing. */ }
  }
  async function notify(sourceId, snapshot) {
    await Promise.allSettled([
      api.runtime.sendMessage({ channel: 'cx-panel-state', sourceId, snapshot }),
      floating(sourceId, { action: 'state', snapshot: { sessionId: snapshot.sessionId, revision: snapshot.revision, phase: snapshot.phase, busy: snapshot.busy, progress: { ready: snapshot.progress?.ready || 0, total: snapshot.progress?.total || 0, failed: snapshot.progress?.failed || 0 } } }),
    ]);
  }
  async function directoryStatus(sourceId, directoryId, request = null) {
    const payload = typeof directoryId === 'string' && DIRECTORY_ID.test(directoryId) ? { directoryId } : {};
    const response = await callHost('directory-status', sourceId, payload, request);
    if (request) assertRequest(sourceId, request);
    return safeDirectory(response.directory);
  }
  async function focusTab(tab) {
    await api.tabs.update(tab.id, { active: true });
    if (validId(tab.windowId)) await api.windows.update(tab.windowId, { focused: true });
  }
  async function savedDirectoryPage() {
    await directoryBindingWrite;
    const record = (await api.storage.session.get(DIRECTORY_PAGE_KEY))[DIRECTORY_PAGE_KEY];
    if (!validId(record?.tabId) || !validId(record.sourceId) || !validId(record.returnTabId)) return null;
    try {
      const tab = await api.tabs.get(record.tabId);
      if (tab.url === api.runtime.getURL('directory.html') && (!tab.pendingUrl || tab.pendingUrl === tab.url)) return { ...record, tab };
    } catch { /* A closed authorization tab is never reopened automatically. */ }
    return null;
  }
  function writeDirectoryBinding(work) {
    const pending = directoryBindingWrite.catch(() => {}).then(work);
    directoryBindingWrite = pending.catch(() => {});
    return pending;
  }
  function clearDirectoryBinding(tabId, preserveDirectoryTab = false) {
    return writeDirectoryBinding(async () => {
      const record = (await api.storage.session.get(DIRECTORY_PAGE_KEY))[DIRECTORY_PAGE_KEY];
      if (record?.sourceId === tabId || (!preserveDirectoryTab && record?.tabId === tabId)) await api.storage.session.set({ [DIRECTORY_PAGE_KEY]: null });
    });
  }
  function chooseDirectory(sourceId, request, returnTabId) {
    // Serialize callers: reuse one tab, but its Return action must follow the
    // latest caller rather than the first source that began opening it.
    const opening = (choosingDirectory || Promise.resolve()).catch(() => {}).then(async () => {
      const existing = await savedDirectoryPage();
      const source = await currentSource(sourceId);
      assertRequest(sourceId, request);
      // A normal tab stays alive after the native chooser returns. Never close
      // or navigate it programmatically while Edge tears down picker/AX nodes.
      const tab = existing?.tab || await api.tabs.create({ url: api.runtime.getURL('directory.html'), active: true,
        ...(validId(source.windowId) ? { windowId: source.windowId } : {}) });
      if (!validId(tab?.id) || tab.id === sourceId || tab.id === returnTabId) throw new Error('无法打开文件夹设置页，请重试。');
      assertRequest(sourceId, request);
      await writeDirectoryBinding(async () => {
        assertRequest(sourceId, request);
        await api.storage.session.set({ [DIRECTORY_PAGE_KEY]: { tabId: tab.id, sourceId, returnTabId } });
      });
      assertRequest(sourceId, request);
      if (existing) await focusTab(tab);
    });
    choosingDirectory = opening;
    return opening.finally(() => { if (choosingDirectory === opening) choosingDirectory = null; });
  }
  async function returnFromDirectory(sender) {
    if (!validId(sender.tab?.id) || sender.frameId !== 0) throw new Error('无法定位原课件小窗。');
    if (choosingDirectory) await choosingDirectory;
    const record = await savedDirectoryPage();
    if (!record || record.tabId !== sender.tab.id) throw new Error('无法定位原课件小窗。');
    const request = { generation: sourceGenerations.get(record.sourceId) || 0 };
    if (sourceBarriers.has(record.sourceId)) {
      await sourceBarriers.get(record.sourceId);
      throw new Error('原课件页面已变化，请重新打开助手。');
    }
    const source = await currentSource(record.sourceId);
    let target = source;
    if (record.returnTabId !== record.sourceId) {
      await restorePanelWindows();
      const panel = panelWindows.get(record.returnTabId);
      if (panel?.sourceId === record.sourceId) {
        try {
          await verifyCreatedPanel(panel);
          await probeSource(panel.sourceId, panel.sourceDocumentId);
          target = await api.tabs.get(panel.tabId);
        } catch { /* If the view closed, return to its still-open course page. */ }
      }
    }
    assertRequest(record.sourceId, request);
    await focusTab(target);
    return { destination: target.id === record.sourceId ? 'source' : 'panel' };
  }
  function directoryChanged() {
    return queuePreferences(async () => {
      // The authorization page stores its handle directly in extension IDB.
      // Only the offscreen host can report authoritative active metadata.
      const directory = await directoryStatus(null);
      let globalPreferences;
      if (directory.permission === 'granted' && directory.id) {
        const stored = (await api.storage.local.get(PREF_KEY))[PREF_KEY];
        const { course: ignored, ...global } = safePreferences(stored);
        globalPreferences = { imageQuality: 'balanced', saveAs: false, ocrEnabled: false, groupByCourse: true, ...global,
          destinationMode: 'directory', saveAs: false, directoryId: directory.id, directoryName: directory.name };
        await api.storage.local.set({ [PREF_KEY]: globalPreferences });
      }
      await api.runtime.sendMessage({ channel: 'cx-directory-state', directory, ...(globalPreferences ? { preferences: globalPreferences } : {}) }).catch(() => {});
      return { directory, ...(globalPreferences ? { preferences: globalPreferences } : {}) };
    });
  }
  async function ui(message, sender) {
    if (!isPanelSender(api, sender) || !UI_COMMANDS.has(message.command)) throw new Error('不支持的助手请求。');
    // Capture generations before popup restoration or early-create waiting.
    const generations = new Map(sourceGenerations), courses = new Map(sourceCourses);
    const { sourceId, window: panelWindow } = await panelContext(sender);
    const request = { generation: generations.get(sourceId) || 0, course: courses.get(sourceId) };
    if (message.command === 'panel-ready') {
      if (panelWindow) { assertRequest(sourceId, request); await currentSource(sourceId); assertRequest(sourceId, request); return { sourceId }; }
      // This reports that the trusted panel DOM loaded, independently of
      // course scanning, task disposal, storage and offscreen initialization.
      // Take the attempt marker from the browser-provided sender URL, not
      // the message payload, so a late old frame cannot ready its replacement.
      const load = new URL(sender.url).searchParams.get('load');
      if (!/^[A-Za-z0-9_-]{16,96}$/.test(load || '')) throw new Error('不支持的助手请求。');
      // A best-effort state broadcast is insufficient for this handshake: the
      // exact current view must acknowledge before the panel stops retrying.
      let response;
      try { response = await api.tabs.sendMessage(sourceId, { channel: 'cx-floating', action: 'ready', load }, { frameId: 0 }); }
      catch { throw new Error('小窗尚未确认就绪，请重试。'); }
      if (response?.ok !== true || response.load !== load) throw new Error('小窗尚未确认就绪，请重试。');
      return { sourceId };
    }
    // Bind the request before any await: tabs.get and preference writes may
    // finish after this tab has already moved to another course.
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
    if (message.command === 'prefs') return { sourceId, preferences: await setPreferences(sourceId, payload, request) };
    let initial = null, savePreferences = null;
    if (message.command === 'start' || message.command === 'retry') savePreferences = await setPreferences(sourceId, payload, request, { persist: payload.once !== true });
    else if (['init', 'scan'].includes(message.command)) initial = await initializePreferences(sourceId, request);
    else await readySource(sourceId, request);
    if (message.command === 'choose-directory') { await chooseDirectory(sourceId, request, sender.tab.id); return { sourceId }; }
    if (message.command === 'directory-status') {
      const stored = await queuePreferences(() => preferences({ key: '', name: '' }));
      const directoryId = safePreferences(payload).directoryId || stored.directoryId;
      return { sourceId, directory: await directoryStatus(sourceId, directoryId, request) };
    }
    if (message.command === 'collapse') { if (panelWindow) await forgetPanelWindow(panelWindow, true); else await floating(sourceId, { action: 'collapse' }); return { sourceId }; }
    if (message.command === 'resize') { if (!panelWindow) await floating(sourceId, { action: 'resize', height: Math.max(200, Math.min(800, Number(payload.height) || 360)) }); return { sourceId }; }
    if (message.command === 'show-file') {
      const id = (await api.storage.session.get(downloadKey(sourceId)))[downloadKey(sourceId)];
      if (!Number.isInteger(id)) throw new Error('尚无已完成的下载文件。');
      const [item] = await api.downloads.search({ id });
      if (item?.state !== 'complete') throw new Error('浏览器尚未确认下载完成。');
      await api.downloads.show(id); return { sourceId };
    }
    // No directory handle or arbitrary object crosses this message boundary.
    const hostPayload = savePreferences ? { ...savePreferences,
      ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
      ...(payload.retry === true ? { retry: true } : {}), ...(payload.once === true ? { once: true } : {}),
    } : initial ? { preferences: initial.preferences }
      : message.command === 'select' ? { index: Number.isInteger(payload.index) ? payload.index : -1 }
      : message.command === 'connect-ocr' ? { token: typeof payload.token === 'string' ? payload.token : '' } : {};
    const result = await callHost(message.command, sourceId, hostPayload, request);
    const directory = initial ? await directoryStatus(sourceId, initial.preferences.directoryId, request) : null;
    return { ...result, sourceId, ...(initial ? { viewMode: panelWindow ? 'window' : 'embedded', directory, preferences: initial.preferences, courseContext: { name: initial.context.name, known: !!initial.context.name } } : {}) };
  }
  async function hostRPC(message, sender) {
    if (!isHostSender(api, sender)) throw new Error('不支持的后台请求。');
    const { sourceId, method } = message;
    if (!Number.isInteger(sourceId) || sourceId < 0) throw new Error('课件来源无效。');
    const payload = message.payload || {};
    switch (method) {
      case 'scan': await currentSource(sourceId); return scan(sourceId);
      case 'validate': await currentSource(sourceId); return validate(sourceId, payload.candidate);
      case 'history.get': return (await api.storage.local.get('history')).history || [];
      case 'history.record': {
        const entry = payload.entry;
        if (!entry || !/^[a-f0-9]{64}$/.test(entry.fingerprint || '') || !/^[a-f0-9]{64}$/.test(entry.contentHash || '')) throw new Error('保存记录无效。');
        const clean = { fingerprint: entry.fingerprint, contentHash: entry.contentHash, title: String(entry.title || '').slice(0, 100), course: String(entry.course || '').slice(0, 70), pages: Number.isInteger(entry.pages) ? entry.pages : null, at: Date.now() };
        const write = historyWrite.catch(() => {}).then(async () => {
          const history = (await api.storage.local.get('history')).history || [];
          await api.storage.local.set({ history: [clean, ...history].slice(0, 60) });
        });
        historyWrite = write; await write; return true;
      }
      case 'download.begin': {
        await currentSource(sourceId);
        if (typeof payload.url !== 'string' || !payload.url.startsWith(`blob:chrome-extension://${api.runtime.id}/`)
          || typeof payload.filename !== 'string' || !payload.filename.startsWith('学习通课件/') || payload.filename.split('/').some(part => part === '..')) throw new Error('下载请求无效。');
        const id = await api.downloads.download({ url: payload.url, filename: payload.filename, conflictAction: 'uniquify', saveAs: payload.saveAs === true });
        try { await api.storage.session.set({ [downloadKey(sourceId)]: id }); }
        catch (error) { await api.downloads.cancel(id).catch(() => {}); throw error; }
        return id;
      }
      case 'download.status':
      case 'download.cancel': {
        const stored = await api.storage.session.get(downloadKey(sourceId));
        if (!Number.isInteger(payload.id) || stored[downloadKey(sourceId)] !== payload.id) throw new Error('下载任务不匹配。');
        if (method === 'download.cancel') { await api.downloads.cancel(payload.id); return true; }
        const [item] = await api.downloads.search({ id: payload.id });
        return item ? [{ id: item.id, state: item.state }] : [];
      }
      default: throw new Error('不支持的后台操作。');
    }
  }
  async function handle(message, sender) {
    if (message?.channel === 'cx-ui') return { ok: true, ...await ui(message, sender) };
    if (message?.channel === 'cx-panel-window') {
      if (message.command !== 'open') throw new Error('不支持的助手请求。');
      return { ok: true, ...await openPanelWindow(sender) };
    }
    if (message?.channel === 'cx-directory') {
      if (!isDirectorySender(api, sender) || !['changed', 'return'].includes(message.command)) throw new Error('不支持的目录请求。');
      if (message.command === 'return') return { ok: true, ...await returnFromDirectory(sender) };
      return { ok: true, ...await directoryChanged() };
    }
    if (message?.channel === 'cx-host-rpc') return { ok: true, value: await hostRPC(message, sender) };
    if (message?.channel === 'cx-host-state') {
      if (!isHostSender(api, sender)) throw new Error('不支持的状态请求。');
      await notify(message.sourceId, message.snapshot); return { ok: true };
    }
  }
  async function toggleNow(tab) {
    if (!Number.isInteger(tab?.id) || !allowedURL(tab.url, true)) {
      if (Number.isInteger(tab?.id)) {
        await api.action.setBadgeText({ tabId: tab.id, text: '课件' });
        await api.action.setTitle({ tabId: tab.id, title: '请先打开学习通课件，再点击助手' });
      }
      return;
    }
    await api.action.setBadgeText({ tabId: tab.id, text: '' });
    try { await api.tabs.sendMessage(tab.id, { channel: 'cx-floating', action: 'toggle' }, { frameId: 0 }); }
    catch (error) {
      if (!/^(?:Could not establish connection\.\s*)?Receiving end does not exist\.?$/i.test(error?.message || '')) throw error;
      // After extension reload, its old DOM can survive without a receiver.
      // Remove only our marked shell, never an active receiver or page node.
      await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => {
        const host = document.getElementById('cx-study-helper-host');
        if (host?.getAttribute('data-cx-study-helper') === 'true') host.remove();
      } });
      await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['floating.js'] });
      await api.tabs.sendMessage(tab.id, { channel: 'cx-floating', action: 'toggle' }, { frameId: 0 });
    }
  }
  function toggle(tab) {
    if (!Number.isInteger(tab?.id)) return toggleNow(tab);
    // A second toolbar click must observe the first recovery's receiver;
    // otherwise its earlier missing-receiver error could remove the new shell.
    const pending = (toggleRequests.get(tab.id) || Promise.resolve()).catch(() => {}).then(() => toggleNow(tab));
    toggleRequests.set(tab.id, pending);
    return pending.finally(() => { if (toggleRequests.get(tab.id) === pending) toggleRequests.delete(tab.id); });
  }
  function invalidateSource(sourceId) {
    sourceGenerations.set(sourceId, (sourceGenerations.get(sourceId) || 0) + 1);
    sourceCourses.delete(sourceId);
  }
  function drop(sourceId, { invalidate = true, mayBePanel = false, preserveDirectoryTab = false } = {}) {
    if (invalidate) invalidateSource(sourceId);
    if (sourceBarriers.has(sourceId)) return sourceBarriers.get(sourceId);
    const barrier = (async () => {
      if (mayBePanel) {
        await restorePanelWindows();
        const record = panelWindows.get(sourceId);
        if (record) { await forgetPanelWindow(record); return; }
      }
      await Promise.all([
        clearSourcePanels(sourceId),
        clearDirectoryBinding(sourceId, preserveDirectoryTab),
        (async () => { if (api.runtime.getContexts && await hasHost()) await api.runtime.sendMessage({ channel: 'cx-host-command', command: 'drop', sourceId, version, payload: {} }).catch(() => {}); })(),
      ]);
    })().finally(() => sourceBarriers.delete(sourceId));
    sourceBarriers.set(sourceId, barrier);return barrier;
  }
  function tabRemoved(tabId) {
    // Install the disposal barrier synchronously, before registry restoration,
    // so a new page cannot initialize against the old page's running task.
    return drop(tabId, { mayBePanel: true });
  }
  function tabUpdated(tabId, change, tab) {
    if (change.status !== 'loading' && typeof change.url !== 'string') return Promise.resolve();
    // Creating or refreshing the panel itself is not course navigation.
    if (windowLoad(tab?.pendingUrl || change.url || tab?.url)) return Promise.resolve();
    // Initial load and refresh of the authorization page retain Return. If a
    // course source navigates here, its source binding must still be cleared.
    return drop(tabId, { mayBePanel: true,
      preserveDirectoryTab: (tab?.pendingUrl || change.url || tab?.url) === api.runtime.getURL('directory.html') });
  }
  return { handle, toggle, drop, ensureHost, tabRemoved, tabUpdated };
}
