(() => {
  // This script owns only the floating shell. Download/OCR commands stay inside
  // the extension-origin iframe and are never accepted from window messages.
  if (window.top !== window || document.getElementById('cx-study-helper-host')) return;
  const host = document.createElement('div');
  host.id = 'cx-study-helper-host';
  host.dataset.cxStudyHelper = 'true';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial;position:fixed!important;z-index:2147483000!important;display:block!important;font-family:"Segoe UI","Microsoft YaHei",sans-serif!important;color:#263247!important;line-height:1.5!important;isolation:isolate!important;color-scheme:light!important}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer}button:focus-visible,.handle:focus-visible{outline:2px solid #3474d7;outline-offset:3px}[hidden]{display:none!important}
    .shell{width:390px;max-width:calc(100vw - 16px);border:1px solid #dfe5ed;border-radius:13px;background:#fff;box-shadow:0 10px 36px #20304a24;overflow:hidden}
    .header{height:43px;display:flex;align-items:center;gap:8px;padding:0 10px 0 13px;background:#fff;border-bottom:1px solid #edf0f5;font-size:13px}
    .handle{display:flex;align-items:center;gap:8px;flex:1;align-self:stretch;cursor:grab;touch-action:none;user-select:none;outline-offset:-4px!important}.handle:active{cursor:grabbing}.grip{color:#a7b0be;font-size:16px;font-weight:400}.handle strong{font-weight:600}
    .collapse{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:6px;background:#fff;color:#76869a;font-size:20px;line-height:1;padding:0}.collapse:hover{background:#f1f5fa}
    .view{position:relative;background:#fff}iframe{display:block;width:100%;border:0;background:#fff}
    .loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px;text-align:center;font-size:13px;color:#52647c;background:#fff;overflow:auto}.loading strong{color:#30435f;font-weight:600}.loading p{margin:0;max-width:280px;font-size:12px;color:#7c8a9d}.reopen,.open-window{border:1px solid #cddbf0;border-radius:7px;background:#f3f7fe;color:#356bcc;padding:7px 15px}.reopen{margin-top:4px}.reopen:hover,.open-window:hover{background:#eaf1fc}.open-window:disabled{cursor:default;opacity:.6}
    .bubble{display:flex;align-items:center;gap:7px;min-height:38px;max-width:220px;border:1px solid #dbe4f0;border-radius:20px;background:#fff;color:#356bcc;padding:8px 13px;box-shadow:0 4px 18px #20304a18;font-size:12px;line-height:1.5;white-space:nowrap}.bubble:hover{background:#f6f9ff}.dot{width:6px;height:6px;flex:0 0 6px;background:#5790dd;border-radius:50%}
  `;
  const shell = document.createElement('section'); shell.className = 'shell'; shell.hidden = true;
  shell.setAttribute('aria-label', '学习通课件助手');
  const header = document.createElement('header'); header.className = 'header';
  const handle = document.createElement('div'); handle.className = 'handle'; handle.tabIndex = 0;
  handle.setAttribute('role', 'button'); handle.setAttribute('aria-label', '拖动课件助手，或使用方向键移动');
  const grip = document.createElement('span'); grip.className = 'grip'; grip.textContent = '⠿'; grip.setAttribute('aria-hidden', 'true');
  const title = document.createElement('strong'); title.textContent = '课件助手'; handle.append(grip, title);
  const collapseButton = document.createElement('button'); collapseButton.type = 'button'; collapseButton.className = 'collapse';
  collapseButton.textContent = '−'; collapseButton.setAttribute('aria-label', '收起小窗'); collapseButton.title = '收起小窗，保存任务继续运行';
  const bubble = document.createElement('button'); bubble.type = 'button'; bubble.className = 'bubble';
  bubble.setAttribute('aria-label', '展开课件助手');
  const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.textContent = '课件助手'; bubble.append(dot, label);
  const view = document.createElement('div'); view.className = 'view';
  const loading = document.createElement('div'); loading.className = 'loading'; loading.setAttribute('role', 'status');
  const loadingTitle = document.createElement('strong');
  const loadingHint = document.createElement('p');
  const reopenButton = document.createElement('button'); reopenButton.type = 'button'; reopenButton.className = 'reopen';
  reopenButton.textContent = '重新打开'; reopenButton.hidden = true;
  const windowButton = document.createElement('button'); windowButton.type = 'button'; windowButton.className = 'open-window';
  windowButton.textContent = '独立小窗打开'; windowButton.hidden = true;
  loading.append(loadingTitle, loadingHint, reopenButton, windowButton); view.append(loading);
  header.append(handle, collapseButton); shell.append(header, view); shadow.append(style, shell, bubble);
  host.dataset.viewState = 'idle';
  document.documentElement.append(host);

  let frame = null, open = false, drag = null, restored = false;
  let currentLoad = null, loadingTimer = null, currentViewState = 'idle';
  let windowPending = false;
  let stateSession = null, stateRevision = -1;
  let frameHeight = 400, position = { left: Math.max(8, innerWidth - 406), top: 76, edge: 'right' };
  const storageKey = 'floatingPanelPosition';
  function clamp(value, min, max) { return Math.max(min, Math.min(Math.max(min, max), value)); }
  function fit() {
    const width = Math.min(390, Math.max(100, innerWidth - 16));
    const height = Math.min(frameHeight, Math.max(80, innerHeight - 61));
    view.style.height = `${height}px`;
    if (frame) frame.style.height = `${height}px`;
    position.left = clamp(position.left, 8, innerWidth - width - 8);
    position.top = clamp(position.top, 8, innerHeight - (open ? height + 45 : 40) - 8);
    const bubbleWidth = bubble.getBoundingClientRect().width || 118;
    const left = open ? position.left : position.edge === 'left' ? 8 : Math.max(8, innerWidth - bubbleWidth - 8);
    host.style.setProperty('left', `${Math.round(left)}px`, 'important');
    host.style.setProperty('top', `${Math.round(position.top)}px`, 'important');
  }
  function persist() {
    chrome.storage.local.set({ [storageKey]: { left: Math.round(position.left), top: Math.round(position.top), edge: position.edge } }).catch(() => {});
  }
  function viewState(state) {
    currentViewState = state;
    host.dataset.viewState = state;
    loading.hidden = state === 'ready';
    reopenButton.hidden = state !== 'timeout';
    windowButton.hidden = state !== 'timeout';
    loadingTitle.textContent = state === 'stale' ? '扩展已更新，请刷新课件页'
      : state === 'timeout' ? '助手暂未加载完成' : '正在加载课件助手…';
    loadingHint.textContent = state === 'stale' ? '刷新后再打开课件助手。'
      : state === 'timeout' ? '可以重新打开小窗；正在进行的保存任务会继续。' : '首次打开可能需要几秒钟。';
    if (frame) {
      frame.style.visibility = state === 'ready' ? 'visible' : 'hidden';
      frame.setAttribute('aria-hidden', String(state !== 'ready'));
    }
  }
  function createFrame() {
    clearTimeout(loadingTimer); loadingTimer = null; currentLoad = null;
    frame?.remove(); frame = null;
    let url;
    try {
      const extensionId = chrome.runtime.id;
      if (!extensionId) throw new Error('stale');
      url = new URL(chrome.runtime.getURL('panel.html'));
      if (url.protocol !== 'chrome-extension:' || url.host !== extensionId || url.pathname !== '/panel.html'
        || url.username || url.password) throw new Error('stale');
      currentLoad = crypto.randomUUID();
      url.searchParams.set('load', currentLoad);
    } catch {
      viewState('stale'); fit(); return;
    }
    const load = currentLoad;
    frame = document.createElement('iframe');
    frame.src = url.href;
    frame.title = '课件保存与设置';
    frame.setAttribute('allow', 'clipboard-write');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    // A frame load alone does not prove that the extension UI initialized.
    frame.addEventListener('load', () => {
      if (load === currentLoad && currentViewState === 'loading') viewState('loaded');
    });
    viewState('loading');
    loadingTimer = setTimeout(() => {
      if (load === currentLoad && currentViewState !== 'ready') viewState('timeout');
    }, 5000);
    view.append(frame); fit();
  }
  function toggle(value = !open) {
    open = value;
    if (open && !frame) createFrame();
    shell.hidden = !open; bubble.hidden = open;
    fit();
    if (!open) bubble.focus();
  }
  async function openPanelWindow(event) {
    if (!event.isTrusted || !open || currentViewState !== 'timeout' || windowPending) return;
    const load = currentLoad;
    windowPending = true; windowButton.disabled = true; windowButton.textContent = '正在打开…';
    try {
      // The worker derives the course tab from this sender. Page data never
      // chooses a target URL or a source tab, and opening a view starts no task.
      const response = await chrome.runtime.sendMessage({ channel: 'cx-panel-window', command: 'open' });
      if (response?.ok !== true) throw new Error('not-opened');
      if (load === currentLoad && currentViewState === 'timeout') {
        loadingTitle.textContent = '已在独立小窗打开';
        loadingHint.textContent = '可以在独立小窗继续操作；请保留原课件页面。';
      }
    } catch {
      if (load === currentLoad && currentViewState === 'timeout') {
        loadingTitle.textContent = '独立小窗未能打开';
        loadingHint.textContent = '请点击“独立小窗打开”重试，或重新打开当前小窗。';
      }
    } finally {
      windowPending = false; windowButton.disabled = false; windowButton.textContent = '独立小窗打开';
    }
  }
  function renderState(value) {
    if (value?.sessionId && Number.isInteger(value.revision)) {
      if (value.sessionId === stateSession && value.revision < stateRevision) return;
      stateSession = value.sessionId; stateRevision = value.revision;
    }
    const phase = value?.phase, progress = value?.progress || {};
    const ready = Number.isInteger(progress.ready) && progress.ready >= 0 ? progress.ready : 0;
    const total = Number.isInteger(progress.total) && progress.total > 0 ? progress.total : 0;
    const failed = Number.isInteger(progress.failed) && progress.failed > 0 ? progress.failed : 0;
    const count = total ? ` ${ready}/${total}` : '';
    label.textContent = phase === 'capture' ? `保存中${count}` : phase === 'paused' ? `已暂停${count}`
      : phase === 'assemble' ? '正在生成 PDF' : phase === 'download' ? '正在下载'
      : phase === 'success' ? '课件已保存' : phase === 'failed' ? (failed ? `${failed} 页待补存` : '保存需检查') : '课件助手';
    bubble.setAttribute('aria-label', `${label.textContent}，展开课件助手`); fit();
  }
  bubble.addEventListener('click', event => { if (event.isTrusted) toggle(true); });
  reopenButton.addEventListener('click', event => { if (event.isTrusted) createFrame(); });
  windowButton.addEventListener('click', event => { void openPanelWindow(event); });
  collapseButton.addEventListener('click', () => toggle(false));
  handle.addEventListener('pointerdown', event => {
    if (!event.isTrusted || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, left: position.left, top: position.top, pointer: event.pointerId };
    handle.setPointerCapture(event.pointerId); event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    position.left = drag.left + event.clientX - drag.x; position.top = drag.top + event.clientY - drag.y; fit();
  });
  function release(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = null; position.edge = position.left + Math.min(390, innerWidth - 16) / 2 < innerWidth / 2 ? 'left' : 'right'; persist();
  }
  handle.addEventListener('pointerup', release); handle.addEventListener('pointercancel', release);
  handle.addEventListener('keydown', event => {
    const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
    if (!delta || !event.isTrusted) return;
    event.preventDefault(); position.left += delta[0]; position.top += delta[1];
    position.edge = position.left + Math.min(390, innerWidth - 16) / 2 < innerWidth / 2 ? 'left' : 'right'; fit(); persist();
  });
  shadow.addEventListener('keydown', event => { if (event.key === 'Escape' && open) toggle(false); });
  window.addEventListener('resize', fit);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== 'cx-floating') return;
    if (message.action === 'probe') { respond?.({ ok: true }); return; }
    if (message.action === 'toggle') toggle();
    else if (message.action === 'collapse') toggle(false);
    else if (message.action === 'state') renderState(message.snapshot);
    else if (message.action === 'ready') {
      if (!currentLoad || message.load !== currentLoad) { respond?.({ ok: false }); return; }
      clearTimeout(loadingTimer); loadingTimer = null; viewState('ready');
      respond?.({ ok: true, load: currentLoad }); return;
    }
    else if (message.action === 'resize' && Number.isFinite(message.height)) {
      frameHeight = clamp(message.height, 200, 800); fit();
    } else return;
    respond?.({ ok: true });
  });
  chrome.storage.local.get(storageKey).then(result => {
    if (restored || open || drag) return;
    restored = true; const saved = result?.[storageKey];
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      position = { left: saved.left, top: saved.top, edge: saved.edge === 'left' ? 'left' : 'right' };
    }
    fit();
  }).catch(() => {});
  fit();
})();
