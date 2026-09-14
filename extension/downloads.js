// Wait for the browser's completed state, not merely a download ID.
export async function downloadFile(api, url, filename, { signal, saveAs = false } = {}) {
  if (signal?.aborted) throw new Error('已取消保存。');
  let id;
  return new Promise((resolve, reject) => {
    let done = false, poll;
    const finish = (error, item) => {
      if (done) return;
      done = true; clearInterval(poll);
      api.onChanged.removeListener(changed);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(item);
    };
    const inspect = async () => {
      if (id === undefined || done) return;
      try {
        const [item] = await api.search({ id });
        if (!item) return finish(new Error('浏览器中找不到这次下载，请重新保存。'));
        if (item.state === 'complete') finish(null, item);
        else if (item.state === 'interrupted') finish(new Error('浏览器下载中断，请检查下载列表后重试。'));
      } catch { finish(new Error('无法确认浏览器下载结果，请查看下载列表。')); }
    };
    const changed = delta => { if (delta.id === id) void inspect(); };
    const abort = () => {
      if (id !== undefined) void api.cancel(id).catch(()=>{});
      finish(new Error('已取消保存。'));
    };
    api.onChanged.addListener(changed);
    signal?.addEventListener('abort', abort, { once: true });
    api.download({ url, filename, conflictAction: 'uniquify', saveAs }).then(newId => {
      id = newId;
      if (done || signal?.aborted) { void api.cancel(id).catch(()=>{}); return; }
      poll = setInterval(()=>void inspect(), 1500);
      void inspect();
    }, () => finish(new Error('无法开始下载，请检查浏览器下载设置后重试。')));
  });
}
