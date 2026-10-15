import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PATCHES, applyPatches, inspectPatches, revertPatches } from '../lib/patches.js';
import { runtimeFixture } from './fixture.mjs';
import { parse } from 'yaml';

function presetPersona(content) {
  const rows = parse(content, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  const search = value => {
    if (value?.name === '@deepseek-ai/dsh-persona') return value.config;
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) {
        const found = search(child);
        if (found) return found;
      }
    }
  };
  return search(rows);
}

test('all eight patches cover published rc.2 runtime entries, parse and revert byte-for-byte', async t => {
  const { base, original, backups } = await runtimeFixture(t);
  const result = applyPatches(base, backups);
  assert.deepEqual(result.patches.map(p => p.id), [1,2,3,4,5,6,7,8]);
  assert.ok(result.changed && result.backup);
  assert.ok(result.patches.every(p => p.applied));
  for (const entry of ['lib/index.js', 'lib/invariant.js', 'lib/types/index.js']) {
    const text = await readFile(join(base, 'dsh-user-approval', entry), 'utf8');
    assert.ok(text.includes('actions run with full access'));
    assert.ok(!text.includes('actions that require approval are rejected automatically'));
  }
  const persona = await readFile(join(base, 'dsh-web-app', 'cordis.patch.yml'), 'utf8');
  assert.ok(persona.includes('personaSuffix: Your working directory is {{cwd}}.'));
  assert.equal(persona.match(/Session directives:/g).length, 1);
  const row = parse(persona.match(/- id: system-prompt[\s\S]*?(?=\n# Full-text)/)[0])[0];
  assert.ok(row.config.personaPrefix.includes('Session directives:'));
  assert.equal(row.config.personaSuffix, 'Your working directory is {{cwd}}.');
  for (const preset of ['standard', 'ptc', 'cordis']) {
    const file = join(base, 'dsh-web-app/presets', preset + '.patch.yml');
    const config = presetPersona(await readFile(file, 'utf8'));
    assert.equal(config.suffix, presetPersona(original.get(file).toString()).suffix);
    assert.match(config.prefix, /^You are a coding agent powered by the \{\{model\}\} model\./);
    assert.equal(config.prefix.match(/Session directives:/g).length, 1);
  }
  for (const file of original.keys()) if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file]);
  assert.equal(applyPatches(base, backups).changed, false);
  assert.ok(inspectPatches(base).patches.every(p => p.applied));
  revertPatches(result.backup, base);
  for (const [file, bytes] of original) assert.deepEqual(await readFile(file), bytes);
});

test('CRLF runtime files remain CRLF and repeat application is a no-op', async t => {
  const { base, original, backups } = await runtimeFixture(t, true);
  const result = applyPatches(base, backups);
  for (const file of original.keys()) {
    const text = await readFile(file, 'utf8');
    assert.ok(!/(?<!\r)\n/.test(text), file);
  }
  for (const preset of ['standard', 'ptc', 'cordis']) {
    const config = presetPersona(await readFile(join(base, 'dsh-web-app/presets', preset + '.patch.yml'), 'utf8'));
    assert.equal(config.prefix.match(/Session directives:/g).length, 1);
  }
  assert.equal(applyPatches(base, backups).changed, false);
  revertPatches(result.backup, base);
  for (const [file, bytes] of original) assert.deepEqual(await readFile(file), bytes);
});

test('legacy root-only coverage reports 7/8 and repairs all missing presets without duplicating the root', async context => {
  const { base, original, backups } = await runtimeFixture(context);
  applyPatches(base, backups);
  for (const preset of ['standard', 'ptc', 'cordis']) {
    const file = join(base, 'dsh-web-app/presets', preset + '.patch.yml');
    await writeFile(file, original.get(file));
  }
  const before = new Map(await Promise.all([...original.keys()].map(async file => [file, await readFile(file)])));
  const status = inspectPatches(base);
  assert.equal(status.patches.filter(patch => patch.applied).length, 7);
  assert.equal(status.patches.find(patch => patch.id === 4).applied, false);
  for (const [file, bytes] of before) assert.deepEqual(await readFile(file), bytes);
  const result = applyPatches(base, backups);
  assert.ok(result.changed && result.patches.every(patch => patch.applied));
  assert.deepEqual(await readFile(join(base, 'dsh-web-app/cordis.patch.yml')), before.get(join(base, 'dsh-web-app/cordis.patch.yml')));
  assert.equal(applyPatches(base, backups).changed, false);
  revertPatches(result.backup, base);
  for (const [file, bytes] of before) assert.deepEqual(await readFile(file), bytes);
});

test('an unrecognized preset prevents the entire patch batch from writing', async context => {
  const { base, original, backups } = await runtimeFixture(context);
  const file = join(base, 'dsh-web-app/presets/ptc.patch.yml');
  const changed = Buffer.from((await readFile(file, 'utf8')).replace('prefix: You are a coding agent', 'prefix: Different agent'));
  await writeFile(file, changed);
  original.set(file, changed);
  assert.throws(() => applyPatches(base, backups), /补丁 #4/);
  for (const [path, bytes] of original) assert.deepEqual(await readFile(path), bytes);
});

test('a missing last patch prevents all installation writes', async t => {
  const { base, original, backups } = await runtimeFixture(t);
  const file = join(base, 'dsh-base', 'cordis.patch.yml');
  const changed = Buffer.from((await readFile(file, 'utf8')).replace('policy: !!js', 'policyChanged: !!js'));
  await writeFile(file, changed); original.set(file, changed);
  assert.throws(() => applyPatches(base, backups), /补丁 #8/);
  for (const [path, bytes] of original) assert.deepEqual(await readFile(path), bytes);
});

test('revert rejects a modified runtime and leaves every file untouched', async t => {
  const { base, original, backups } = await runtimeFixture(t);
  const result = applyPatches(base, backups);
  const changed = join(base, 'dsh-base', 'cordis.patch.yml');
  await writeFile(changed, (await readFile(changed, 'utf8')) + '\n# external update\n');
  const current = new Map(await Promise.all([...original.keys()].map(async file => [file, await readFile(file)])));
  assert.throws(() => revertPatches(result.backup, base), /另有修改/);
  for (const [file, bytes] of current) assert.deepEqual(await readFile(file), bytes);
});
