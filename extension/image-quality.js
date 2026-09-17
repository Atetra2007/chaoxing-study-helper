export const READING_JPEG_QUALITY = 0.85;
const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;

function checkCancelled(cancelled) {
  if (cancelled()) throw new Error('已取消保存。');
}

// Keep the source dimensions and colours. White is also the PDF page background.
export async function encodeReadingJPEG(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  let canvas;
  try {
    if (bitmap.width * bitmap.height > MAX_CANVAS_PIXELS) throw new Error('图片超过压缩尺寸上限。');
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('图片压缩不可用。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: READING_JPEG_QUALITY });
    if (blob.type !== 'image/jpeg') throw new Error('图片压缩格式不可用。');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

export async function preparePDFImage(item, { quality = 'original', encode = encodeReadingJPEG, cancelled = () => false } = {}) {
  if (!['original', 'balanced'].includes(quality)) throw new Error('未知的图片画质选项。');
  checkCancelled(cancelled);
  const png = item.bytes[0] === 137 && item.bytes[1] === 80;
  const original = { bytes: item.bytes, format: png ? 'png' : 'jpeg', outcome: 'unchanged' };
  // Existing JPEGs are already compressed: never introduce another lossy generation.
  if (quality === 'original' || !png) return original;
  try {
    const bytes = await encode(item.bytes);
    checkCancelled(cancelled);
    if (!(bytes instanceof Uint8Array) || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('图片压缩结果无效。');
    // Do not sacrifice quality for a negligible byte saving.
    if (bytes.length >= item.bytes.length * 0.9) return original;
    return { bytes, format: 'jpeg', outcome: 'compressed' };
  } catch {
    checkCancelled(cancelled);
    return { ...original, outcome: 'fallback' };
  }
}
