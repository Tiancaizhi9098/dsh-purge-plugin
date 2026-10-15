#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyPatches, inspectPatches, revertPatches } from '../lib/patches.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const [mode, ...args] = process.argv.slice(2);
const option = name => { const at=args.indexOf(name); return at<0 ? undefined : args[at+1]; };
function run(bin,args) { return execFileSync(bin,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}); }
function replace(path,bytes,mode) {
  const temp=path+'.dsh-purge-'+randomUUID()+'.tmp';
  try {writeFileSync(temp,bytes,{flag:'wx',mode});renameSync(temp,path);} finally {if(existsSync(temp))unlinkSync(temp);}
}
function archiveHeaderHash(path) {
  const bytes=readFileSync(path);
  if(bytes.length<16 || bytes.readUInt32LE(0)!==4) throw new Error('无效的 ASAR 文件头');
  const jsonSize=bytes.readUInt32LE(12);
  if(jsonSize>bytes.length-16) throw new Error('无效的 ASAR 文件头长度');
  return hash(bytes.subarray(16,16+jsonSize));
}
function verifyArchiveIntegrity(archive,plist) {
  const declared=run('/usr/libexec/PlistBuddy',['-c','Print :ElectronAsarIntegrity:Resources/app.asar:hash',plist]).trim();
  if(declared!==archiveHeaderHash(archive)) throw new Error('ElectronAsarIntegrity 与 app.asar 不匹配；未修改应用。');
}
function belongsToApp(command,app) {
  const text=command.trim();
  const marker=text.match(/\.app\/Contents\/(?:MacOS|Frameworks)\//);
  if(!marker) return false;
  try {return realpathSync(text.slice(0,marker.index+4))===app;} catch {return false;}
}
let rollback;
try {
  if(process.platform!=='darwin') throw new Error('此命令用于 macOS 桌面版；Linux、Windows 使用 scripts/patches.mjs。');
  if(!['status','apply','revert'].includes(mode)) throw new Error('用法：node scripts/macos.mjs status|apply|revert --app "/Applications/DeepSeek Harness.app" [--manifest 备份路径]');
  const app=realpathSync(resolve(option('--app') || '/Applications/DeepSeek Harness.app'));
  if(!app.endsWith('.app')) throw new Error('--app 必须是 .app 应用目录');
  const contents=join(app,'Contents');
  const plist=join(contents,'Info.plist');
  const exeName=run('/usr/bin/plutil',['-extract','CFBundleExecutable','raw','-o','-',plist]).trim();
  if(!exeName || /[\\/]/.test(exeName)) throw new Error('CFBundleExecutable 无效');
  const executable=join(contents,'MacOS',exeName);
  const seal=join(contents,'_CodeSignature','CodeResources');
  const archive=join(contents,'Resources','app.asar');
  const base=join(archive,'dsh','node_modules','@deepseek-ai');
  if(mode==='status') {
    const report=inspectPatches(base);
    let signatureVerified=false,asarIntegrityVerified=false;
    const diagnostics=[];
    try {run('/usr/bin/codesign',['--verify','--deep','--strict',app]);signatureVerified=true;} catch {diagnostics.push('应用代码签名校验失败');}
    try {verifyArchiveIntegrity(archive,plist);asarIntegrityVerified=true;} catch(error) {diagnostics.push(error.message);}
    console.log(JSON.stringify({...report,signatureVerified,asarIntegrityVerified,...(diagnostics.length?{diagnostics}:{})},null,2));
    process.exit(signatureVerified && asarIntegrityVerified ? 0 : 1);
  }
  const processes=run('/bin/ps',['-ax','-o','command=']).split('\n');
  if(processes.some(line=>belongsToApp(line,app))) throw new Error('请先完全退出这个 DSH 应用（包括后台进程），再运行命令。');
  const paths=[plist,executable,seal];
  if(mode==='revert') {
    const manifestPath=resolve(option('--manifest') || '');
    if(!option('--manifest')) throw new Error('revert 需要 --manifest 指定 macOS 备份 JSON');
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    if(manifest.format!=='dsh-purge-macos-v1' || manifest.app!==app || !manifest.archiveBackup || !Array.isArray(manifest.files) || manifest.files.length!==3) throw new Error('macOS 备份与此应用不匹配');
    for(const [i,file] of manifest.files.entries()) {
      if(file.path!==paths[i] || (file.existed ? hash(Buffer.from(file.original,'base64'))!==file.beforeSha256 : file.original!=='' || file.beforeSha256!==null)) throw new Error('macOS 备份校验失败');
      const current=existsSync(file.path)?hash(readFileSync(file.path)):null;
      if(current!==file.beforeSha256 && current!==file.afterSha256) throw new Error('应用另有修改，拒绝覆盖：'+file.path);
    }
    // Validate the archive before restoring any signed metadata.
    revertPatches(manifest.archiveBackup,base);
    for(const file of manifest.files) {
      if(file.existed) replace(file.path,Buffer.from(file.original,'base64'),file.mode);
      else if(existsSync(file.path)) unlinkSync(file.path);
    }
    run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
    verifyArchiveIntegrity(archive,plist);
    console.log(JSON.stringify({restored:true,app,signatureVerified:true,asarIntegrityVerified:true},null,2));process.exit(0);
  }
  const status=inspectPatches(base);
  if(status.patches.every(p=>p.applied)) {
    verifyArchiveIntegrity(archive,plist);
    run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
    console.log(JSON.stringify({...status,signatureVerified:true,asarIntegrityVerified:true},null,2));process.exit(0);
  }
  // Verify the original app before changing anything. Never disable Gatekeeper or fuses.
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  verifyArchiveIntegrity(archive,plist);
  const home=resolve(process.env.DSH_HOME?.trim() || join(homedir(),'.dsh'));
  const backupRoot=join(home,'plugins','dsh-purge','runtime-backups');
  mkdirSync(backupRoot,{recursive:true,mode:0o700});
  const manifestPath=join(backupRoot,new Date().toISOString().replaceAll(':','-')+'-'+randomUUID()+'.macos.json');
  const files=paths.map(path=>{const existed=existsSync(path);const original=existed?readFileSync(path):Buffer.alloc(0);return {path,existed,original:original.toString('base64'),beforeSha256:existed?hash(original):null,mode:existed?statSync(path).mode&0o777:0o644};});
  const manifest={format:'dsh-purge-macos-v1',app,createdAt:new Date().toISOString(),files};
  writeFileSync(manifestPath,JSON.stringify(manifest),{flag:'wx',mode:0o600});
  let result;
  rollback=()=>{
    if(manifest.archiveBackup) revertPatches(manifest.archiveBackup,base);
    for(const file of files) {
      if(file.existed) replace(file.path,Buffer.from(file.original,'base64'),file.mode);
      else if(existsSync(file.path))unlinkSync(file.path);
    }
  };
  result=applyPatches(base,backupRoot,{allowMacBundle:true});
  manifest.archiveBackup=result.backup;
  writeFileSync(manifestPath,JSON.stringify(manifest),{mode:0o600});
  const headerHash=archiveHeaderHash(archive);
  run('/usr/libexec/PlistBuddy',['-c','Set :ElectronAsarIntegrity:Resources/app.asar:hash '+headerHash,plist]);
  // Only the outer app changed. Nested helpers/frameworks keep their original signatures.
  run('/usr/bin/codesign',['--force','--sign','-','--preserve-metadata=identifier,entitlements,flags','--timestamp=none',app]);
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  verifyArchiveIntegrity(archive,plist);
  for(const file of files) file.afterSha256=existsSync(file.path)?hash(readFileSync(file.path)):null;
  writeFileSync(manifestPath,JSON.stringify(manifest),{mode:0o600});
  rollback=undefined;
  console.log(JSON.stringify({...inspectPatches(base),changed:true,backup:manifestPath,signatureVerified:true,asarIntegrityVerified:true,signature:'local-ad-hoc',restartRequired:true},null,2));
} catch(error) {
  let message=error.message;
  if(error.stderr)message+='\n'+error.stderr.toString();
  if(rollback)try{rollback();message+='\n已恢复本次写入前的应用文件。';}catch(failure){message+='\n回滚未完成：'+failure.message;}
  console.error(message);process.exitCode=1;
}
