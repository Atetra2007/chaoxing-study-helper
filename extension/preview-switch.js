// Injected with chrome.scripting.executeScript: keep all validation self-contained.
// This activates the site's visible preview control; it does not invent resource URLs.
export function switchToImagePreview(expected) {
  const unchanged = { switched: false };
  try {
    const safeHTTPS = url => url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443');
    const wrapper = new URL(location.href);
    if (!safeHTTPS(wrapper) || !/(^|\.)chaoxing\.com$/i.test(wrapper.hostname)
      || wrapper.pathname !== '/ananas/modules/pdf/mooc2-resource-index.html') return unchanged;
    if (expected?.canSwitch !== true) return unchanged;
    const unique = selector => {
      const elements = document.querySelectorAll(selector);
      return elements.length === 1 ? elements[0] : null;
    };
    const office = unique('iframe#office-iframe');
    const image = unique('iframe#panView');
    const button = unique('#otherOpen1');
    if (!office || !image || !button || typeof button.click !== 'function') return unchanged;
    const officeURL = new URL(office.getAttribute('src'), document.baseURI);
    const imageURL = new URL(image.getAttribute('src'), document.baseURI);
    const officeId = officeURL.pathname.match(/^\/weboffice\/office\/f\/([a-zA-Z0-9_-]+)$/)?.[1];
    const imageId = imageURL.pathname.match(/^\/screen\/v2\/file_([a-zA-Z0-9_-]+)$/)?.[1];
    const officeKey = officeURL.origin + officeURL.pathname;
    const imageKey = imageURL.origin + imageURL.pathname;
    if (!safeHTTPS(officeURL) || !/^wps\d+\.cldisk\.com$/i.test(officeURL.hostname)
      || !safeHTTPS(imageURL) || !/(^|\.)chaoxing\.com$/i.test(imageURL.hostname)
      || !officeId || officeId !== imageId
      || officeKey !== expected.officeKey || imageKey !== expected.imageKey) return unchanged;
    const visible = element => {
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || style.opacity === '0') return false;
      }
      return element.getClientRects().length > 0;
    };
    if (!visible(button) || !visible(office) || button.disabled || button.getAttribute('aria-disabled') === 'true') return unchanged;
    button.click();
    return { switched: true, imageKey };
  } catch { return unchanged; }
}
