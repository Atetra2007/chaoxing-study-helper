import { mkdir, copyFile, readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { buildSource } from './build-source.mjs';
import { createRequire } from 'node:module';
const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(await readFile(path.join(root,'extension','manifest.json'),'utf8'));
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(pkg.version!==manifest.version)throw new Error('package.json与manifest版本不一致，停止构建。');
const out=path.join(root,'outputs',`chaoxing-study-helper-${manifest.version}`);
await mkdir(path.join(out,'vendor'),{recursive:true});
for(const file of await readdir(path.join(root,'extension'))){
  if(/\.(js|html|css|json)$/.test(file))await writeFile(path.join(out,file),buildSource(file,await readFile(path.join(root,'extension',file)),manifest.version));
}
await mkdir(path.join(out,'vendor/noble-hashes'),{recursive:true});
for(const file of ['sha2.js','_md.js','_u64.js','utils.js','LICENSE'])await copyFile(path.join(root,'node_modules/@noble/hashes',file),path.join(out,'vendor/noble-hashes',file));
await copyFile(path.join(root,'node_modules/pdf-lib/dist/pdf-lib.min.js'),path.join(out,'vendor/pdf-lib.min.js'));
await copyFile(path.join(root,'node_modules/pdf-lib/LICENSE.md'),path.join(out,'vendor/pdf-lib-LICENSE.md'));
const pdfRequire=createRequire(await realpath(path.join(root,'node_modules/pdf-lib/package.json')));
await mkdir(path.join(out,'vendor/licenses'),{recursive:true});
for(const [name,license] of [['@pdf-lib/standard-fonts','LICENSE.md'],['@pdf-lib/upng','LICENSE'],['pako','LICENSE']]){
  const folder=path.dirname(pdfRequire.resolve(`${name}/package.json`));
  await copyFile(path.join(folder,license),path.join(out,'vendor/licenses',`${name.replace('@','').replace('/','-')}.txt`));
}
const tslibFolder=path.dirname(pdfRequire.resolve('tslib'));
for(const file of ['LICENSE.txt','CopyrightNotice.txt'])await copyFile(path.join(tslibFolder,file),path.join(out,'vendor/licenses',`tslib-${file}`));
for(const file of ['LICENSE','PRIVACY.md','THIRD_PARTY_NOTICES.md'])await copyFile(path.join(root,file),path.join(out,file));
const installGuide=(await readFile(path.join(root,'docs','安装使用说明.md'),'utf8')).replace(/\]\(([^():#]+\.md)\)/g,(_,relative)=>`](https://github.com/Atetra2007/chaoxing-study-helper/blob/v${manifest.version}/docs/${encodeURI(relative)})`);
await writeFile(path.join(out,'安装使用说明.md'),installGuide);
await writeFile(path.join(out,'构建说明.txt'),`学习通课件助手 ${manifest.version}\n将本文件所在文件夹作为“加载解压缩的扩展”目录。\nPDF库随扩展打包，不从远程加载脚本。\n`);
console.log(JSON.stringify({out,version:manifest.version,files:await readdir(out)}));
