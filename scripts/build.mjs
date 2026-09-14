import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(await readFile(path.join(root,'extension','manifest.json'),'utf8'));
const out=path.join(root,'outputs',`chaoxing-study-helper-${manifest.version}`);
await mkdir(path.join(out,'vendor'),{recursive:true});
for(const file of await readdir(path.join(root,'extension'))){
  if(/\.(js|html|css|json)$/.test(file))await copyFile(path.join(root,'extension',file),path.join(out,file));
}
await copyFile(path.join(root,'node_modules/pdf-lib/dist/pdf-lib.min.js'),path.join(out,'vendor/pdf-lib.min.js'));
await copyFile(path.join(root,'node_modules/pdf-lib/LICENSE.md'),path.join(out,'vendor/pdf-lib-LICENSE.md'));
await copyFile(path.join(root,'docs','安装使用说明.md'),path.join(out,'安装使用说明.md'));
await writeFile(path.join(out,'构建说明.txt'),`学习通课件助手 ${manifest.version}\n将本文件所在文件夹作为“加载解压缩的扩展”目录。\nPDF库随扩展打包，不从远程加载脚本。\n`);
console.log(JSON.stringify({out,version:manifest.version,files:await readdir(out)}));
