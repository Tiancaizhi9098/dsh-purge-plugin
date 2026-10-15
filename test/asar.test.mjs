import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import * as asar from '@electron/asar';
import { archiveFixture as fixture } from './fixture.mjs';
import { applyPatches, inspectPatches, revertPatches, findDshBase } from '../lib/patches.js';

test('ASAR applies all eight patches, updates integrity, preserves other entries and reverts exact archive bytes',async t=>{
  const f=await fixture(t);const before=await readFile(f.archive);
  const result=applyPatches(f.base,f.backups);
  assert.ok(result.changed && result.patches.every(p=>p.applied));
  assert.ok(inspectPatches(f.base).patches.every(p=>p.applied));
  assert.equal(applyPatches(f.base,f.backups).changed,false);
  asar.uncache(f.archive);
  assert.deepEqual(asar.extractFile(f.archive,'untouched.bin'),Buffer.from([0,255,42,16,0]));
  const text=asar.extractFile(f.archive,join('dsh','node_modules','@deepseek-ai','dsh-user-approval','lib','invariant.js'));
  assert.match(text.toString(),/actions run with full access/);
  const entry=asar.statFile(f.archive,join('dsh','node_modules','@deepseek-ai','dsh-user-approval','lib','invariant.js'));
  const {createHash}=await import('node:crypto');
  assert.equal(entry.integrity.hash,createHash('sha256').update(text).digest('hex'));
  for (const preset of ['standard', 'ptc', 'cordis']) {
    const path = join('dsh/node_modules/@deepseek-ai/dsh-web-app/presets', preset + '.patch.yml');
    const bytes = asar.extractFile(f.archive, path);
    assert.equal(bytes.toString().match(/Session directives:/g).length, 1);
    assert.equal(asar.statFile(f.archive, path).integrity.hash, createHash('sha256').update(bytes).digest('hex'));
  }
  revertPatches(result.backup,f.base);
  assert.deepEqual(await readFile(f.archive),before);
  revertPatches(result.backup,f.base);
});
test('plain Node can resolve DSH_BASE inside ASAR without Electron virtual fs',async t=>{
  const f=await fixture(t);const old=process.env.DSH_BASE;process.env.DSH_BASE=f.base;
  try{assert.equal(findDshBase(),join(await realpath(f.archive),'dsh/node_modules/@deepseek-ai'));}finally{if(old===undefined)delete process.env.DSH_BASE;else process.env.DSH_BASE=old;}
});
test('ASAR path aliases use the same canonical base for apply, inspect and revert', async context => {
  const fixture = await archiveFixtureAlias(context);
  const before = await readFile(fixture.archive);
  const result = applyPatches(fixture.aliasBase, fixture.backups);
  assert.equal(result.base, join(await realpath(fixture.archive), 'dsh/node_modules/@deepseek-ai'));
  assert.ok(inspectPatches(fixture.aliasBase).patches.every(patch => patch.applied));
  revertPatches(result.backup, fixture.aliasBase);
  assert.deepEqual(await readFile(fixture.archive), before);
});

async function archiveFixtureAlias(context) {
  const runtime = await fixture(context);
  const alias = join(runtime.root, 'alias.asar');
  try { await symlink(runtime.archive, alias); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      context.skip('Windows account does not have symlink permission');
      return { ...runtime, aliasBase: runtime.base };
    }
    throw error;
  }
  return { ...runtime, aliasBase: join(alias, 'dsh/node_modules/@deepseek-ai') };
}
test('ASAR rejects an external archive change before reverting',async t=>{
  const f=await fixture(t);const result=applyPatches(f.base,f.backups);
  const changed=Buffer.concat([await readFile(f.archive),Buffer.from('external')]);
  await writeFile(f.archive,changed);
  assert.throws(()=>revertPatches(result.backup,f.base),/另有修改/);
  assert.deepEqual(await readFile(f.archive),changed);
});
test('missing last patch leaves ASAR byte-for-byte untouched',async t=>{
  const f=await fixture(t);
  const target=join(f.source,'dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml');
  await writeFile(target,(await readFile(target,'utf8')).replace('policy: !!js','other: !!js'));
  await asar.createPackage(f.source,f.archive);const before=await readFile(f.archive);
  assert.throws(()=>applyPatches(f.base,f.backups),/补丁 #8/);
  assert.deepEqual(await readFile(f.archive),before);
});
test('signed macOS bundle layout requires the offline signing transaction',async t=>{
  const f=await fixture(t);const archive=join(f.root,'Test.app/Contents/Resources/app.asar');
  await mkdir(dirname(archive),{recursive:true});await cp(f.archive,archive);
  const before=await readFile(archive);
  assert.throws(()=>applyPatches(join(archive,'dsh/node_modules/@deepseek-ai'),f.backups),/先退出 DSH/);
  assert.deepEqual(await readFile(archive),before);
});
