export async function assemblePDF(PDFLib, images, { title, total, onProgress = ()=>{}, cancelled = ()=>false } = {}) {
  const sorted = images.slice().sort((a,b)=>a.number-b.number);
  if (sorted.length !== total || sorted.some((p,i)=>p.number !== i+1)) throw new Error('存在缺页或重复页，未生成 PDF。');
  const pdf = await PDFLib.PDFDocument.create();
  pdf.setTitle(title || '学习通课件');
  pdf.setProducer('学习通课件助手');
  pdf.setSubject('页面图片阅读副本');
  const hashPages = new Map();
  for (const item of sorted) {
    if (cancelled()) throw new Error('已取消保存。');
    const png = item.bytes[0] === 137 && item.bytes[1] === 80;
    const image = await (png ? pdf.embedPng(item.bytes) : pdf.embedJpg(item.bytes));
    const width = 595.2755905511812, height = width * image.height / image.width;
    pdf.addPage([width, height]).drawImage(image, { x:0, y:0, width, height });
    const group = hashPages.get(item.hash) || []; group.push(item.number); hashPages.set(item.hash, group);
    onProgress(item.number, total);
    await new Promise(r=>setTimeout(r,0));
  }
  const bytes = await pdf.save();
  if (cancelled()) throw new Error('已取消保存。');
  const check = await PDFLib.PDFDocument.load(bytes);
  if (check.getPageCount() !== total) throw new Error('PDF 页数校验失败。');
  return { bytes, duplicateGroups:[...hashPages.values()].filter(g=>g.length>1) };
}
