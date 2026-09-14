// Development-only browser API simulation. Never included in the extension build.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syntheticPage, SAMPLE_PAGE_COUNT } from './synthetic-pages.mjs';
const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(await readFile(path.join(root,'extension','manifest.json'),'utf8'));
const extension=path.join(root,'outputs',`chaoxing-study-helper-${manifest.version}`);
const port=4178;
const sampleCache=new Map();
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://127.0.0.1:${port}`);
    let name=decodeURIComponent(url.pathname);
    if(name==='/test-output'&&req.method==='POST'){
      const pieces=[];let size=0;for await(const piece of req){size+=piece.length;if(size>50*1024*1024)throw new Error('too large');pieces.push(piece);}
      const output=path.join(root,'work','extension-ui-test');await mkdir(output,{recursive:true});
      await writeFile(path.join(output,'browser-export.pdf'),Buffer.concat(pieces));
      res.writeHead(200,{'Content-Type':'application/json'});res.end('{"saved":true}');return;
    }
    let body,type='text/plain; charset=utf-8';
    if(name==='/'){
      body=(await readFile(path.join(extension,'workspace.html'),'utf8'))
        .replace('<script src="vendor/pdf-lib.min.js">','<script src="/tests/chrome-shim.js"></script><script src="vendor/pdf-lib.min.js">');
      type='text/html; charset=utf-8';
    }else if(name==='/tests/browser-native-fetch.html'){
      body=await readFile(path.join(root,'tests','browser-native-fetch.html'));type='text/html; charset=utf-8';
    }else if(name==='/tests/chrome-shim.js'){
      body=await readFile(path.join(root,'tests','chrome-shim.js'));type='text/javascript';
    }else if(/^\/sample\/[1-9]\d?\.png$/.test(name)){
      const number=Number(name.split('/').pop().replace('.png',''));
      if(number>SAMPLE_PAGE_COUNT)throw new Error('unknown sample page');
      if(!sampleCache.has(number))sampleCache.set(number,syntheticPage(number));
      body=sampleCache.get(number);type='image/png';
    }else{
      const file=path.resolve(extension,'.'+name);
      if(!file.startsWith(extension+path.sep))throw new Error('bad path');
      body=await readFile(file);type=({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[path.extname(file)]||'application/octet-stream';
    }
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
  }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Development simulation (31 synthetic pages): http://127.0.0.1:${port}`));
