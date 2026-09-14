chrome.action.onClicked.addListener(async (tab) => {
  const key = `workspace-${tab.id}`;
  const previous = (await chrome.storage.session.get(key))[key];
  if (previous) {
    try {
      const existing = await chrome.tabs.get(previous);
      if (existing.url?.startsWith(chrome.runtime.getURL('workspace.html'))) {
        await chrome.tabs.update(previous, { active: true });
        return;
      }
    } catch { /* The previous workspace has been closed. */ }
  }
  const workspace = await chrome.tabs.create({
    url: chrome.runtime.getURL(`workspace.html?source=${tab.id}`),
  });
  await chrome.storage.session.set({ [key]: workspace.id });
  try { await chrome.tabs.update(workspace.id, { autoDiscardable: false }); } catch { /* Optional. */ }
});
