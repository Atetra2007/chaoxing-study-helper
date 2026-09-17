const ENDPOINT = 'http://127.0.0.1:8765';
export const OCR_ORIGIN_PERMISSION = `${ENDPOINT}/*`;
const IMAGE_REASONS = ['non-text-layout','uncertain-layout','uncertain-text','possible-formula','rotated-text','uncovered-content','complex-columns','uncertain-typesetting','unsupported-image'];

export function readOCRConnection(text) {
  let value;
  try{value=JSON.parse(text);}catch{throw new Error('本地OCR连接文件无效。');}
  if(!value||typeof value!=='object')throw new Error('本地OCR连接文件无效。');
  if(value.schema!==1 || !/^[a-f0-9]{64}$/.test(value.token||'')) throw new Error('本地OCR连接文件无效。');
  return value.token;
}

export function localOCRClient(token, { fetcher = globalThis.fetch.bind(globalThis), signal } = {}) {
  if(!/^[a-f0-9]{64}$/.test(token||''))throw new Error('请先选择本地OCR连接文件。');
  async function request(route, body) {
    const controller=new AbortController();
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    const timer=setTimeout(abort,120000);
    try {
      const response=await fetcher(`${ENDPOINT}${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/octet-stream'}:{})},body,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
      if(!response.ok)throw new Error('本地OCR未就绪、正在处理其他任务或连接已失效。请检查本地组件。');
      if(Number(response.headers.get('content-length'))>2*1024*1024)throw new Error('本地OCR结果过大。');
      const reader=response.body.getReader();const parts=[];let size=0;
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();throw new Error('本地OCR结果过大。');}parts.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch(error) {
      if(signal?.aborted)throw new Error('已取消保存。');
      throw new Error(error.message?.startsWith('本地OCR')?error.message:'本地OCR连接失败或处理超时，请确认本地组件已启动。');
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {
    async check(){const result=await request('/health');if(result.schema!==1||result.ready!==true||result.engine!=='local-paddleocr')throw new Error('本地OCR组件版本不兼容。');},
    async recognize(item){
      const result=await request('/page',item.bytes);
      if(result.kind==='image'&&IMAGE_REASONS.includes(result.reason))return {kind:'image',reason:result.reason};
      if(result.kind!=='text'||result.reason!=='text'||typeof result.pdf!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(result.pdf))throw new Error('本地OCR返回了无效页面。');
      const bytes=Uint8Array.from(atob(result.pdf),c=>c.charCodeAt(0));
      if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('本地OCR页面格式异常。');
      return {kind:'text',bytes};
    },
  };
}
