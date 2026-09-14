// Only served by the local development preview. No privileged browser access.
const nativeFetch=window.fetch.bind(window);
const mode=new URLSearchParams(location.search).get('test');
const frame={frameId:3,documentId:'fixture-reader',result:{title:'',frameKey:'https://pan-yz.chaoxing.com/screen/v2/fixture',readerKind:'chaoxing-screen-v2',rosterTotal:31,totalBasis:'reader-list',
  pages:Array.from({length:31},(_,i)=>({number:i+1,url:`https://s3.cldisk.com/fixture/${i+1}.png`,width:1023,height:1447})),originals:[]}};
const changeListeners=new Set();const stored={course:'合成测试课程'};const downloads=new Map();let nextId=1;
let failuresEnabled=mode==='failure';
window.fetch=async function(url,options){
  if(this!==window)throw new TypeError('Illegal invocation');
  if(typeof url==='string'&&url.startsWith('https://s3.cldisk.com/fixture/')){
    if(mode==='slow'||mode==='failure')await new Promise(r=>setTimeout(r,mode==='slow'?1200:350));
    if(failuresEnabled&&url.endsWith('/7.png'))return new Response('failure',{status:503});
    const local=await nativeFetch('/sample/'+url.split('/').pop(),options);
    return new Response(await local.arrayBuffer(),{status:local.status,headers:local.headers});
  }
  return nativeFetch(url,options);
};
window.chrome={
  tabs:{query:async()=>[{id:42,title:'学生学习页面',url:'https://mooc1.chaoxing.com/mycourse/studentstudy'}],get:async()=>({id:42,url:'https://mooc1.chaoxing.com/mycourse/studentstudy'}),update:async()=>{},onRemoved:{addListener:()=>{}}},
  scripting:{executeScript:async({target})=>target.documentIds?[frame]:[{frameId:0,result:{title:'合成测试资料（31页）',pages:[],originals:[]}},frame]},
  storage:{local:{get:async key=>({[key]:stored[key]}),set:async data=>Object.assign(stored,data)}},
  downloads:{onChanged:{addListener:fn=>changeListeners.add(fn),removeListener:fn=>changeListeners.delete(fn)},
    download:async({url,filename,conflictAction})=>{
      if(conflictAction!=='uniquify')throw new Error('unsafe filename policy');
      const id=nextId++;downloads.set(id,{id,state:'in_progress',filename});
      setTimeout(async()=>{
        try{const bytes=await(await nativeFetch(url)).arrayBuffer();
          await nativeFetch('/test-output',{method:'POST',body:bytes});downloads.get(id).state='complete';
        }catch{downloads.get(id).state='interrupted';}
        changeListeners.forEach(fn=>fn({id,state:{current:downloads.get(id).state}}));
      },100);return id;
    },search:async({id})=>downloads.has(id)?[downloads.get(id)]:[],cancel:async id=>{downloads.get(id).state='interrupted';},show:()=>{}},
};
addEventListener('DOMContentLoaded',()=>{
  const notice=document.createElement('div');notice.textContent='开发预览：31页代码生成的合成测试数据，模拟扩展接口；不代表真实课件保存验证';
  notice.style.cssText='background:#fff3d6;color:#866215;text-align:center;padding:9px;font-size:12px';document.body.prepend(notice);
  if(mode==='failure'){
    const button=document.createElement('button');button.textContent='恢复测试网络';button.id='restore-test-network';
    button.onclick=()=>{failuresEnabled=false;button.disabled=true;button.textContent='测试网络已恢复';};notice.append(' ',button);
  }
});
