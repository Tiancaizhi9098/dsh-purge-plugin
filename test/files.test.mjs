import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstructionFiles } from '../lib/testable/files.js';

async function fixture(t, limit = 4096) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-purge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '工作区 with spaces');
  await mkdir(dir);
  const file = join(dir, 'AGENTS.md');
  const files = new InstructionFiles(() => [{ id: 'workspace', path: file, root: dir, label: 'Test' }], join(root, 'backups'), () => limit);
  return { root, dir, file, files };
}

test('UTF-8 create, edit, backups, restore and restore absence preserve exact bytes', async t => {
  const { files, file } = await fixture(t);
  const empty = await files.read('workspace');
  assert.equal(empty.revision, 'missing');
  const first = await files.save('workspace', empty.revision, '\uFEFF# 说明\r\n第一版\r\n');
  const absence = (await files.history('workspace'))[0];
  assert.equal(absence.exists, false);
  const second = await files.save('workspace', first.revision, '# Version two\n');
  const original = (await files.history('workspace')).find(entry => entry.exists);
  const restored = await files.restore('workspace', second.revision, original.id);
  assert.equal(await readFile(file, 'utf8'), '\uFEFF# 说明\r\n第一版\r\n');
  await files.restore('workspace', restored.revision, absence.id);
  assert.equal((await files.read('workspace')).exists, false);
  assert.equal((await files.history('workspace')).length, 4);
});

test('external changes reject save and retain external contents', async t => {
  const { files, file } = await fixture(t);
  const before = await files.save('workspace', 'missing', 'one');
  await writeFile(file, 'external');
  await assert.rejects(files.save('workspace', before.revision, 'two'), /File changed/);
  assert.equal(await readFile(file, 'utf8'), 'external');
});

test('concurrent saves do not overwrite each other', async t => {
  const { files, file } = await fixture(t);
  const answers = await Promise.allSettled([files.save('workspace', 'missing', 'first'), files.save('workspace', 'missing', 'second')]);
  assert.equal(answers.filter(answer => answer.status === 'fulfilled').length, 1);
  assert.ok(['first', 'second'].includes(await readFile(file, 'utf8')));
});

test('limits use bytes and reject invalid UTF-8 without writing', async t => {
  const { files, file } = await fixture(t, 10);
  await assert.rejects(files.save('workspace', 'missing', '中文中文'), /byte limit/);
  await writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(files.read('workspace'), /encoded data/);
});

test('unknown paths and backup traversal are rejected', async t => {
  const { files } = await fixture(t);
  await assert.rejects(files.read('../../secret'), /Unknown target/);
  await assert.rejects(files.restore('workspace', 'missing', '../x'), /Invalid backup/);
});

test('symlinks cannot move the editor outside the selected workspace', async t => {
  const { root, file, files } = await fixture(t);
  const outside = join(root, 'outside.md');
  await writeFile(outside, 'outside');
  try { await symlink(outside, file, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows runner requires Developer Mode or symlink privilege');
    throw error;
  }
  await assert.rejects(files.read('workspace'), /escapes/);
  await assert.rejects(files.save('workspace', 'missing', 'changed'), /escapes/);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('no-op saves do not add backup entries', async t => {
  const { files } = await fixture(t);
  const first = await files.save('workspace', 'missing', 'same');
  await files.save('workspace', first.revision, 'same');
  assert.equal((await files.history('workspace')).length, 1);
});

test('tampered backup bytes fail checksum verification', async t => {
  const { root, files } = await fixture(t);
  const first = await files.save('workspace', 'missing', 'one');
  const second = await files.save('workspace', first.revision, 'two');
  const backup = (await files.history('workspace')).find(entry => entry.exists);
  const { readdir } = await import('node:fs/promises');
  const folder = (await readdir(join(root, 'backups'))).find(value => !value.endsWith('.lock'));
  const path = join(root, 'backups', folder, backup.id + '.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.content = Buffer.from('tampered').toString('base64');
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(files.restore('workspace', second.revision, backup.id), /checksum/);
});
