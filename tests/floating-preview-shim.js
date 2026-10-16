// Development only. Served exclusively under /floating-extension by preview.mjs.
(() => {
  const directory = parent === window && location.pathname.endsWith('/directory.html');
  const standalone = parent === window && (directory || new URLSearchParams(location.search).get('view') === 'window');
  const bridge = standalone ? opener?.__floatingPreview : parent.__floatingPreview;
  if (!bridge || (parent === window && !standalone)) throw new Error('浮窗预览必须从 /floating 打开。');
  const kind = directory ? 'directory' : location.pathname.endsWith('/offscreen.html') ? 'offscreen' : standalone ? 'panel-window' : 'panel';
  window.chrome = bridge.createChrome(kind, window);
  if (kind === 'offscreen') bridge.installFetch(window);
  if (directory) {
    // The native picker is never invoked in this fixture. The returned handle
    // belongs only to OPFS; no desktop directory is selected or authorized.
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('合成课件输出', { create: true });
    addEventListener('DOMContentLoaded', () => {
      const notice = document.createElement('p'); notice.id = 'directory-preview-note';
      notice.textContent = '合成预览：选择文件夹已模拟，仅使用浏览器私有测试目录，不是桌面授权验收。';
      document.querySelector('main').prepend(notice);
    });
  }
})();
