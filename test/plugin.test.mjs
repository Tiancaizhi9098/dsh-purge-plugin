import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { Context, Service } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import PurgePlugin from '../lib/index.js';
import { archiveFixture, runtimeFixture } from './fixture.mjs';
import { applyPatches } from '../lib/patches.js';
import * as asar from '@electron/asar';

test('Cordis applies eight patches, serves only the global editor, and removes RPC on unload', async t => {
  const fixture = await runtimeFixture(t);
  const oldHome = process.env.DSH_HOME, oldBase = process.env.DSH_BASE;
  process.env.DSH_HOME = join(fixture.root, 'home'); process.env.DSH_BASE = fixture.base;
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldBase === undefined) delete process.env.DSH_BASE; else process.env.DSH_BASE = oldBase;
  });
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(TypertRegistry);
  class Settings extends Service {
    constructor(ctx) { super(ctx, 'settings'); }
    configure(value) { assert.deepEqual(value, { auto: false }); return () => {}; }
    describe() { throw new Error('The editor must not inspect other settings'); }
    update() { throw new Error('The editor must not change permission settings'); }
  }
  await ctx.plugin(Settings);
  const fiber = ctx.plugin(PurgePlugin, { enabled: true, sessionDirectives: 'legacy ignored', workspaceRoots: ['/unused'] });
  await fiber;
  assert.equal(ctx.typert.local.list().filter(entry => entry.namespace === 'dshPurge').length, 5);
  assert.deepEqual(await ctx.dshPurge.status({}), { applied: 8, total: 8, restartRequired: true });
  const missing = await ctx.dshPurge.readFile({ target: 'global' });
  assert.equal(missing.path, join(await realpath(fixture.root), 'home', 'AGENTS.md'));
  const saved = await ctx.dshPurge.saveFile({ target: 'global', revision: 'missing', content: '# 全局要求\n使用中文。\n' });
  assert.equal((await ctx.dshPurge.readFile({ target: 'global' })).content, saved.content);
  assert.equal((await ctx.dshPurge.history({ target: 'global' })).length, 1);
  await assert.rejects(ctx.dshPurge.readFile({ target: 'shared' }));
  await assert.rejects(ctx.dshPurge.readFile({ target: 'global', path: '/other/file' }));
  assert.equal(ctx.dshPurge.saveConfiguration, undefined);
  assert.equal(ctx.dshPurge.setDefaultPermission, undefined);
  const original = { kind: 'enter', messages: [{ id: 'u', source: { kind: 'user' }, content: [] }] };
  assert.equal(await ctx.waterfall('agent/pre-step', {}, () => original), original);
  await fiber.dispose();
  assert.equal(ctx.typert.local.list().filter(entry => entry.namespace === 'dshPurge').length, 0);
});

test('macOS root-only legacy patches report 7/8 while the offline transaction is required', async context => {
  const fixture = await archiveFixture(context);
  applyPatches(fixture.base, fixture.backups);
  asar.uncache(fixture.archive);
  asar.extractAll(fixture.archive, fixture.source);
  const preset = join(fixture.source, 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
  await writeFile(preset, fixture.original.get(join(fixture.root, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml')));
  const archive = join(fixture.root, 'Test.app/Contents/Resources/app.asar');
  await mkdir(join(fixture.root, 'Test.app/Contents/Resources'), { recursive: true });
  await asar.createPackage(fixture.source, archive);
  const before = await readFile(archive);
  const oldHome = process.env.DSH_HOME, oldBase = process.env.DSH_BASE;
  process.env.DSH_HOME = join(fixture.root, 'home');
  process.env.DSH_BASE = join(archive, 'dsh/node_modules/@deepseek-ai');
  context.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldBase === undefined) delete process.env.DSH_BASE; else process.env.DSH_BASE = oldBase;
  });
  const ctx = new Context(); context.after(() => ctx.fiber.dispose());
  await ctx.plugin(TypertRegistry);
  class Settings extends Service {
    constructor(ctx) { super(ctx, 'settings'); }
    configure() { return () => {}; }
  }
  await ctx.plugin(Settings);
  await ctx.plugin(PurgePlugin);
  const status = await ctx.dshPurge.status({});
  assert.equal(status.applied, 7);
  assert.equal(status.total, 8);
  assert.match(status.error, /先退出 DSH/);
  assert.deepEqual(await readFile(archive), before);
});
