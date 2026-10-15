import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as asar from '@electron/asar';
import { archiveFixture } from './fixture.mjs';

const macOnly = { skip: process.platform !== 'darwin' };
const script = fileURLToPath(new URL('../scripts/macos.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function macFixture(context) {
  const fixture = await archiveFixture(context);
  const app = join(await realpath(fixture.root), 'Test App.app');
  const contents = join(app, 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources'), { recursive: true });
  const archive = join(contents, 'Resources/app.asar');
  const executable = join(contents, 'MacOS/Test');
  const plist = join(contents, 'Info.plist');
  const seal = join(contents, '_CodeSignature/CodeResources');
  await cp(fixture.archive, archive);
  const program = join(fixture.root, 'test-app.c');
  await writeFile(program, '#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n');
  run('/usr/bin/cc', [program, '-o', executable]);
  const bytes = await readFile(archive);
  const headerHash = hash(bytes.subarray(16, 16 + bytes.readUInt32LE(12)));
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.dsh-purge.tests</string>
<key>CFBundleName</key><string>DSH Purge Test</string>
<key>CFBundleExecutable</key><string>Test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict>
<key>algorithm</key><string>SHA256</string><key>hash</key><string>${headerHash}</string>
</dict></dict></dict></plist>`);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
  const files = [archive, plist, executable, seal];
  const original = new Map(await Promise.all(files.map(async path => [path, await readFile(path)])));
  const cli = (mode, ...args) => spawnSync(process.execPath, [script, mode, '--app', app, ...args], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: join(fixture.root, 'home') }, timeout: 30_000,
  });
  return { ...fixture, app, archive, executable, plist, files, original, cli };
}

test('macOS CLI signs all presets, checks integrity, is idempotent and restores original signed bytes', macOnly, async context => {
  const fixture = await macFixture(context);
  const initial = fixture.cli('status');
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(JSON.parse(initial.stdout).signatureVerified, true);
  for (const [path, bytes] of fixture.original) assert.deepEqual(await readFile(path), bytes);
  const applied = fixture.cli('apply');
  assert.equal(applied.status, 0, applied.stderr);
  const report = JSON.parse(applied.stdout);
  assert.ok(report.changed && report.patches.every(patch => patch.applied));
  assert.equal(report.signatureVerified, true);
  assert.equal(report.asarIntegrityVerified, true);
  asar.uncache(fixture.archive);
  for (const preset of ['standard', 'ptc', 'cordis']) {
    const content = asar.extractFile(fixture.archive, 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/' + preset + '.patch.yml').toString();
    assert.equal(content.match(/Session directives:/g).length, 1);
  }
  const patched = new Map(await Promise.all(fixture.files.map(async path => [path, await readFile(path)])));
  const repeated = fixture.cli('apply');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).changed, false);
  const status = fixture.cli('status');
  assert.equal(status.status, 0, status.stderr);
  assert.ok(JSON.parse(status.stdout).patches.every(patch => patch.applied));
  for (const [path, bytes] of patched) assert.deepEqual(await readFile(path), bytes);
  const reverted = fixture.cli('revert', '--manifest', report.backup);
  assert.equal(reverted.status, 0, reverted.stderr);
  assert.equal(JSON.parse(reverted.stdout).restored, true);
  for (const [path, bytes] of fixture.original) assert.deepEqual(await readFile(path), bytes);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fixture.app]);
});

test('macOS status detects a wrong Electron integrity hash even when the outer signature is valid', macOnly, async context => {
  const fixture = await macFixture(context);
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :ElectronAsarIntegrity:Resources/app.asar:hash ' + '0'.repeat(64), fixture.plist]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', fixture.app]);
  const before = new Map(await Promise.all(fixture.files.map(async path => [path, await readFile(path)])));
  const status = fixture.cli('status');
  assert.equal(status.status, 1);
  const report = JSON.parse(status.stdout);
  assert.equal(report.signatureVerified, true);
  assert.equal(report.asarIntegrityVerified, false);
  assert.match(report.diagnostics.join('\n'), /ElectronAsarIntegrity/);
  const applied = fixture.cli('apply');
  assert.equal(applied.status, 1);
  assert.match(applied.stderr, /ElectronAsarIntegrity/);
  for (const [path, bytes] of before) assert.deepEqual(await readFile(path), bytes);
});

test('macOS CLI refuses to modify an application running through a path alias', macOnly, async context => {
  const fixture = await macFixture(context);
  const alias = join(fixture.root, 'Alias.app');
  await symlink(fixture.app, alias, 'dir');
  const child = spawn(join(alias, 'Contents/MacOS/Test'), [], { stdio: 'ignore' });
  const closed = once(child, 'close');
  await once(child, 'spawn');
  try {
    const result = fixture.cli('apply');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /完全退出/);
    for (const [path, bytes] of fixture.original) assert.deepEqual(await readFile(path), bytes);
  } finally {
    child.kill();
    await closed;
  }
});
