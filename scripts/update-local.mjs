import { mkdir, readFile, writeFile, readdir, lstat, copyFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildSource } from './build-source.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const inside = (base, name) => name.toLowerCase().startsWith((base+path.sep).toLowerCase());
async function exists(name) { try { await lstat(name);return true; } catch(error) { if(error.code==='ENOENT')return false;throw error; } }
async function files(directory) {
  const names=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const name=path.join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error('更新目录包含链接，已停止。');
    if(entry.isDirectory())for(const child of await files(name))names.push(path.join(entry.name,child));
    else if(entry.isFile())names.push(entry.name);
    else throw new Error('更新目录包含非普通文件，已停止。');
  }
  return names;
}
async function copyVerified(source,target,names) {
  for(const name of names) {
    const destination=path.join(target,name);
    await mkdir(path.dirname(destination),{recursive:true});
    await copyFile(path.join(source,name),destination);
    if(digest(await readFile(destination))!==digest(await readFile(path.join(source,name))))throw new Error('文件复制校验失败。');
  }
}
async function noLinks(root,target) {
  let current=root;
  for(const part of path.relative(root,target).split(path.sep)) {
    current=path.join(current,part);
    if(await exists(current) && (await lstat(current)).isSymbolicLink())throw new Error('目标路径包含链接，已停止。');
  }
}

export async function updateLocal({root,target}) {
  root=await realpath(root);
  const outputs=path.join(root,'outputs');
  target=path.resolve(root,target||'outputs/installed');
  if(!inside(outputs,target)||path.dirname(target).toLowerCase()!==outputs.toLowerCase())throw new Error('目标必须是项目outputs中的直接子目录。');
  await noLinks(root,target);
  const manifest=JSON.parse(await readFile(path.join(root,'extension/manifest.json'),'utf8'));
  const source=path.join(outputs,`chaoxing-study-helper-${manifest.version}`);
  if(source.toLowerCase()===target.toLowerCase())throw new Error('安装目录不能与本次构建目录相同。');
  await noLinks(root,source);
  const built=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
  if(built.version!==manifest.version||built.name!==manifest.name)throw new Error('构建版本或扩展名称不符。');
  const names=await files(source);
  for(const required of ['manifest.json','workspace.html','app.js','diagnostics.js',path.join('vendor','pdf-lib.min.js')]) {
    if(!names.includes(required))throw new Error('构建文件不完整。');
  }
  // Reject stale code even if its manifest version happens to match.
  for(const name of await files(path.join(root,'extension'))) {
    if(/\.(js|html|css|json)$/.test(name) && digest(buildSource(name,await readFile(path.join(root,'extension',name)),manifest.version))!==digest(await readFile(path.join(source,name))))throw new Error('构建与源码不一致，请重新构建。');
  }
  let backup=null;
  if(await exists(target)) {
    const old=JSON.parse(await readFile(path.join(target,'manifest.json'),'utf8'));
    if(old.name!==manifest.name||old.manifest_version!==3)throw new Error('目标不是本项目扩展，已停止。');
    const previous=await files(target);
    backup=path.join(root,'work','extension-backups',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
    await noLinks(root,backup);
    await copyVerified(target,backup,previous);
  }
  try { await copyVerified(source,target,names); }
  catch(error) { throw new Error(`更新未完成，请勿重新加载。原文件备份：${backup||'首次安装，无旧文件'}。${error.message}`); }
  return {version:manifest.version,target,backup,files:names.length,reloadRequired:true};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const root=path.resolve(import.meta.dirname,'..');
  const args=process.argv.slice(2);
  if(args.length && (args.length!==2 || args[0]!=='--target'))throw new Error('用法：pnpm update:local [--target outputs/已安装目录]');
  const config=path.join(root,'work','local-install.json');
  const saved=await exists(config)?JSON.parse(await readFile(config,'utf8')):{};
  execFileSync(process.execPath,[path.join(root,'scripts/build.mjs')],{stdio:'inherit'});
  const result=await updateLocal({root,target:args[1]||saved.target});
  await mkdir(path.dirname(config),{recursive:true});
  await writeFile(config,JSON.stringify({target:result.target},null,2));
  console.log(JSON.stringify(result,null,2));
  console.log('文件已更新并逐项校验。请在Edge重新加载扩展，关闭旧助手页并刷新原课件页，确认小窗底部版本。');
}
