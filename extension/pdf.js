import { preparePDFImage } from './image-quality.js';

export async function assemblePDF(PDFLib, images, { title, total, quality = 'original', recognizePage, onProgress = ()=>{}, cancelled = ()=>false } = {}) {
  if (!['original', 'balanced'].includes(quality)) throw new Error('未知的图片画质选项。');
  const sorted = images.slice().sort((a,b)=>a.number-b.number);
  if (sorted.length !== total || sorted.some((p,i)=>p.number !== i+1)) throw new Error('存在缺页或重复页，未生成 PDF。');
  const pdf = await PDFLib.PDFDocument.create();
  pdf.setTitle(title || '学习通课件');
  pdf.setProducer('学习通课件助手');
  pdf.setSubject(recognizePage ? '文字优先阅读副本 · 本机OCR · 需核对文字' : quality === 'balanced' ? '页面图片阅读副本 · 均衡压缩' : '页面图片阅读副本 · 原画质');
  const hashPages = new Map();
  const embedded = new Map();
  const textResults = new Map();
  const compression = { compressedPages: 0, unchangedPages: 0, fallbackPages: 0, reusedPages: 0, embeddedImageBytes: 0, textPages: 0, imagePages: 0 };
  for (const item of sorted) {
    if (cancelled()) throw new Error('已取消保存。');
    const key = item.hash || item;
    const group = hashPages.get(key) || []; group.push(item.number); hashPages.set(key, group);
    if(recognizePage){
      onProgress(item.number,total,'ocr');
      if(!textResults.has(key))textResults.set(key,await recognizePage(item));
      if(cancelled())throw new Error('已取消保存。');
      const result=textResults.get(key);
      if(result.kind==='text'){
        const part=await PDFLib.PDFDocument.load(result.bytes);
        if(part.getPageCount()!==1)throw new Error('本地OCR返回页数异常。');
        const source=part.getPage(0);
        if(item.width&&item.height&&Math.abs(source.getHeight()/source.getWidth()-item.height/item.width)>0.001)throw new Error('本地OCR返回页面比例异常。');
        const [page]=await pdf.copyPages(part,[0]);pdf.addPage(page);compression.textPages++;
        onProgress(item.number,total,'assembled');
        continue;
      }
      if(result.kind!=='image')throw new Error('本地OCR返回类型异常。');
    }
    compression.imagePages++;
    let entry = embedded.get(key);
    if (!entry) {
      const prepared = await preparePDFImage(item, { quality, cancelled });
      if (cancelled()) throw new Error('已取消保存。');
      const image = await (prepared.format === 'png' ? pdf.embedPng(prepared.bytes) : pdf.embedJpg(prepared.bytes));
      // Embed now so pdf-lib can release decoded PNG buffers before the next page.
      await image.embed();
      entry = { image, outcome: prepared.outcome };
      embedded.set(key, entry);
      compression.embeddedImageBytes += prepared.bytes.length;
    } else compression.reusedPages++;
    compression[entry.outcome === 'compressed' ? 'compressedPages' : entry.outcome === 'fallback' ? 'fallbackPages' : 'unchangedPages']++;
    const image = entry.image;
    const width = 595.2755905511812, height = width * image.height / image.width;
    pdf.addPage([width, height]).drawImage(image, { x:0, y:0, width, height });
    onProgress(item.number, total);
    await new Promise(r=>setTimeout(r,0));
  }
  const bytes = await pdf.save();
  if (cancelled()) throw new Error('已取消保存。');
  const check = await PDFLib.PDFDocument.load(bytes);
  if (check.getPageCount() !== total) throw new Error('PDF 页数校验失败。');
  return { bytes, duplicateGroups:[...hashPages.values()].filter(g=>g.length>1), compression };
}
