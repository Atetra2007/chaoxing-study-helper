// Keep this entry independent of panel imports: module-linking failures must
// produce a usable recovery view instead of leaving the outer shell waiting.
export async function bootPanel({ runtime = chrome.runtime, doc = document,
  load = url => import(url), reload = () => window.location.reload(),
  setTimer = setTimeout, clearTimer = clearTimeout,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)), moduleURL = import.meta.url } = {}) {
  let failureView = null, timeout;
  let version = '';
  const root = doc.getElementById('panel');
  async function revealFailure() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await delay(attempt === 1 ? 150 : 350);
      try {
        const response = await runtime.sendMessage({ channel: 'cx-ui', command: 'panel-ready' });
        if (response?.ok === true) return true;
      } catch { /* The worker may be waking or being replaced. */ }
    }
    return false;
  }
  function showFailure(code) {
    if (root) root.hidden = true;
    if (!failureView) {
      failureView = doc.createElement('section');
      failureView.className = 'startup-failure';
      failureView.setAttribute('role', 'alert');
      const title = doc.createElement('h1'), detail = doc.createElement('p');
      const button = doc.createElement('button'), label = doc.createElement('small');
      button.type = 'button'; button.className = 'primary'; button.textContent = '重新加载界面';
      button.addEventListener('click', reload);
      label.textContent = version ? `v${version}` : '课件助手';
      failureView.append(title, detail, button, label); doc.body.append(failureView);
    }
    doc.body.dataset.startup = code;
    failureView.querySelector('h1').textContent = code === 'UI_RUNTIME' ? '助手连接未建立'
      : code === 'UI_VERSION' ? '界面文件版本不一致'
      : code === 'UI_SLOW' ? '界面加载时间较长' : '界面文件未能加载';
    failureView.querySelector('p').textContent = code === 'UI_VERSION'
      ? '请重新加载扩展并刷新课件页，再打开助手。'
      : '可以重新加载界面；若仍未恢复，请重新加载扩展并刷新课件页。';
    void revealFailure();
  }
  try {
    // Read extension APIs inside the guarded startup path. A separate recovery
    // window must also show a usable error if its extension context is absent.
    try {
      version = runtime.getManifest().version;
      if (typeof version !== 'string' || !version) throw new Error('missing-version');
    } catch { throw Object.assign(new Error('missing-extension-context'), { code: 'UI_RUNTIME' }); }
    if (!root || ['save-once', 'choose-directory', 'settings-content'].some(id => !doc.getElementById(id))) {
      throw Object.assign(new Error('missing-ui-elements'), { code: 'UI_VERSION' });
    }
    const panelURL = new URL('./panel.js', moduleURL);
    panelURL.searchParams.set('v', version);
    timeout = setTimer(() => showFailure('UI_SLOW'), 4500);
    await load(panelURL.href);
    clearTimer(timeout);
    failureView?.remove(); root.hidden = false; doc.body.dataset.startup = 'ready';
    return { ok: true };
  } catch (error) {
    clearTimer(timeout);
    const code = error?.code === 'UI_RUNTIME' ? 'UI_RUNTIME'
      : error?.code === 'UI_VERSION' || /does not provide an export named/.test(error?.message || '') ? 'UI_VERSION' : 'UI_START';
    showFailure(code);
    return { ok: false, code };
  }
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined') void bootPanel();
