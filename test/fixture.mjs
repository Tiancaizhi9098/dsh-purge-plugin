import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATCHES } from '../lib/patches.js';
import * as asar from '@electron/asar';
export async function runtimeFixture(t, crlf = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-eight-patches-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, '@deepseek-ai');
  const original = new Map();
  const published = fileURLToPath(new URL('../node_modules/@deepseek-ai/', import.meta.url));
  for (const patch of PATCHES) {
    for (const relative of ['package.json', ...patch.files]) {
      const target = join(base, patch.package, relative);
      if (original.has(target)) continue;
      let bytes = await readFile(join(published, patch.package, relative));
      if (crlf) bytes = Buffer.from(bytes.toString('utf8').replace(/\r?\n/g, '\r\n'));
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
      original.set(target, bytes);
    }
  }
  return { root, base, original, backups: join(root, 'backups') };
}

export async function archiveFixture(context) {
  const runtime = await runtimeFixture(context);
  const source = join(runtime.root, 'source');
  await mkdir(join(source, 'dsh/node_modules'), { recursive: true });
  await cp(runtime.base, join(source, 'dsh/node_modules/@deepseek-ai'), { recursive: true });
  await writeFile(join(source, 'untouched.bin'), Buffer.from([0, 255, 42, 16, 0]));
  const archive = join(runtime.root, 'app.asar');
  await asar.createPackage(source, archive);
  return { ...runtime, archive, source, base: join(archive, 'dsh/node_modules/@deepseek-ai') };
}
