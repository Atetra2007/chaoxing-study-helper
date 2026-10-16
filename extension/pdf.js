import { preparePDFImage } from './image-quality.js';
import { PDFFileWriter, memoryPDFSink } from './pdf-writer.js';

export async function assemblePDF(PDFLib, images, { title, total, quality = 'original', recognizePage, loadImage = async item => item,
  sink = memoryPDFSink(), onProgress = () => {}, cancelled = () => false } = {}) {
  const writer = new PDFFileWriter(PDFLib, sink, cancelled);
  try {
    if (!['original', 'balanced'].includes(quality)) throw new Error('未知的图片画质选项。');
    const sorted = images.slice().sort((a, b) => a.number - b.number);
    if (!Number.isInteger(total) || total < 1 || sorted.length !== total || sorted.some((p, i) => p.number !== i + 1)) throw new Error('存在缺页或重复页，未生成 PDF。');
    const hashPages = new Map(), templates = new Map(), remaining = new Map();
    for (const item of sorted) { const key = item.hash || item; remaining.set(key, (remaining.get(key) || 0) + 1); }
    const compression = { compressedPages: 0, unchangedPages: 0, fallbackPages: 0, reusedPages: 0, embeddedImageBytes: 0, textPages: 0, imagePages: 0 };
    await writer.begin();
    for (const metadata of sorted) {
      if (cancelled()) throw new Error('已取消保存。');
      const key = metadata.hash || metadata;
      const group = hashPages.get(key) || []; group.push(metadata.number); hashPages.set(key, group);
      let entry = templates.get(key);
      if (!entry) {
        // This scope owns one source image, one OCR result and one PDF page.
        const item = await loadImage(metadata);
        let part, kind = 'image', outcome;
        if (recognizePage) {
          onProgress(item.number, total, 'ocr');
          const result = await recognizePage(item);
          if (cancelled()) throw new Error('已取消保存。');
          kind = result.kind;
          if (kind === 'text') {
            part = await PDFLib.PDFDocument.load(result.bytes);
            if (part.getPageCount() !== 1) throw new Error('本地OCR返回页数异常。');
            const source = part.getPage(0);
            if (item.width && item.height && Math.abs(source.getHeight() / source.getWidth() - item.height / item.width) > 0.001) throw new Error('本地OCR返回页面比例异常。');
          } else if (kind !== 'image') throw new Error('本地OCR返回类型异常。');
        }
        if (kind === 'image') {
          const prepared = await preparePDFImage(item, { quality, cancelled });
          part = await PDFLib.PDFDocument.create();
          const image = await (prepared.format === 'png' ? part.embedPng(prepared.bytes) : part.embedJpg(prepared.bytes));
          const width = 595.2755905511812, height = width * image.height / image.width;
          part.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
          outcome = prepared.outcome;
          compression.embeddedImageBytes += prepared.bytes.length;
        }
        entry = { template: await writer.append(part), kind, outcome };
        if (remaining.get(key) > 1) templates.set(key, entry);
      } else {
        await writer.append(null, entry.template);
        if (entry.kind === 'image') compression.reusedPages++;
      }
      if (entry.kind === 'text') compression.textPages++;
      else {
        compression.imagePages++;
        compression[entry.outcome === 'compressed' ? 'compressedPages' : entry.outcome === 'fallback' ? 'fallbackPages' : 'unchangedPages']++;
      }
      remaining.set(key, remaining.get(key) - 1);
      if (!remaining.get(key)) templates.delete(key);
      onProgress(metadata.number, total, 'assembled');
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const subject = recognizePage ? '文字优先阅读副本 · 本机OCR · 需核对文字' : quality === 'balanced' ? '页面图片阅读副本 · 均衡压缩' : '页面图片阅读副本 · 原画质';
    const output = await writer.finish({ title, subject, total });
    return { ...output, duplicateGroups: [...hashPages.values()].filter(g => g.length > 1), compression };
  } catch (error) { await sink.abort().catch(() => {}); throw error; }
}
