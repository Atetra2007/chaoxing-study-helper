const retryDelays = [150, 350];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// This announces a usable panel (including a bootstrap error screen), not a
// ready save task. Never retry initialization or saving through this helper.
export async function announcePanelReady(api, { wait = delay } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(retryDelays[attempt - 1]);
    try {
      const response = await api.runtime.sendMessage({ channel: 'cx-ui', command: 'panel-ready' });
      if (response?.ok === true) return true;
    } catch { /* The worker or floating receiver may still be starting. */ }
  }
  return false;
}
