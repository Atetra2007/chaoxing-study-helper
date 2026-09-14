import { allowedURL } from './model.js';

// Course libraries can contain a document in a nested frame without changing
// their top-level URL. Keep the toolbar's source instead of requiring a reader URL.
export function isSuggestedSource(tab) {
  if (!allowedURL(tab?.url, true)) return false;
  const url = new URL(tab.url);
  if (!/(^|\.)chaoxing\.com$/i.test(url.hostname)) return false;
  return /(?:^|\/)mycourse\/(?:studentstudy|stu)(?:\/|$)/i.test(url.pathname)
    || /^\/screen\/v2\//i.test(url.pathname);
}

export function selectSourceTabs(tabs, requestedId = null) {
  const explicit = Number.isInteger(requestedId) && requestedId >= 0;
  const seen = new Set();
  const available = tabs.filter(tab => {
    if (!Number.isInteger(tab?.id) || tab.id < 0 || seen.has(tab.id)) return false;
    if (!allowedURL(tab.url, true) || !(isSuggestedSource(tab) || (explicit && tab.id === requestedId))) return false;
    seen.add(tab.id);
    return true;
  });
  const sourceId = explicit
    ? (available.some(tab => tab.id === requestedId) ? requestedId : null)
    : (available.length === 1 ? available[0].id : null);
  return { tabs: available, sourceId };
}

export async function loadSourceTabs(tabsAPI, requestedId = null) {
  const tabs = await tabsAPI.query({ url: ['https://*.chaoxing.com/*'] });
  // The explicit source may be a supported direct reader outside the discovery
  // query. Check it against the same page allowlist before adding it to the UI.
  if (Number.isInteger(requestedId) && requestedId >= 0 && !tabs.some(tab => tab.id === requestedId)) {
    try { tabs.push(await tabsAPI.get(requestedId)); } catch { /* Source was closed. */ }
  }
  return selectSourceTabs(tabs, requestedId);
}
