import { mkdir, open, readFile, realpath, rename, rm, stat, unlink, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { BackupView, FileView } from './contracts.ts';

export interface FileTarget { id: string; label: string; path: string; root: string }
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, file: string): boolean => {
  const part = relative(root, file);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')));
};
async function nearestReal(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await nearestReal(parent), relative(parent, path));
  }
}
async function optionalBytes(path: string, limit: number): Promise<Buffer | undefined> {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('目标不是普通文件 / Target is not a regular file');
    if (info.size > limit) throw new Error(`文件超过 ${limit} 字节上限 / File exceeds byte limit`);
    const bytes = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > limit) throw new Error('读取期间文件超出上限 / File grew beyond limit');
    // Fatal decoder rejects binary / invalid UTF-8 rather than corrupting an existing instruction file.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

/** Edits are restricted to registered instruction files; backups precede each replacement. */
export class InstructionFiles {
  constructor(private readonly targets: () => FileTarget[], private readonly backupRoot: string, private readonly limit: () => number) {}

  private async target(id: string): Promise<FileTarget> {
    const target = this.targets().find(value => value.id === id);
    if (!target) throw new Error('未知文件，请刷新列表 / Unknown target; refresh the list');
    const root = await nearestReal(resolve(target.root));
    const path = await nearestReal(resolve(target.path));
    if (!inside(root, path) || path === root) throw new Error('目标链接超出允许目录 / Target link escapes the allowed directory');
    return { ...target, root, path };
  }
  private view(target: FileTarget, bytes: Buffer | undefined): FileView {
    return { target: target.id, path: target.path, exists: bytes !== undefined,
      content: bytes?.toString('utf8') ?? '', revision: bytes === undefined ? 'missing' : digest(bytes), bytes: bytes?.length ?? 0 };
  }
  async read(id: string): Promise<FileView> {
    const target = await this.target(id);
    return this.view(target, await optionalBytes(target.path, this.limit()));
  }
  private directory(target: FileTarget): string { return join(this.backupRoot, digest(Buffer.from(target.path))); }

  private async locked<T>(target: FileTarget, action: () => Promise<T>): Promise<T> {
    await mkdir(this.backupRoot, { recursive: true, mode: 0o700 });
    const lock = join(this.backupRoot, digest(Buffer.from(target.path)) + '.lock');
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('文件正在保存；若上次进程崩溃，请检查并移除锁文件：' + lock);
      throw error;
    }
    try { return await action(); }
    finally { await handle.close(); await unlink(lock); }
  }
  private async backup(target: FileTarget, bytes: Buffer | undefined): Promise<void> {
    const dir = this.directory(target);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const record = { id, path: target.path, createdAt: new Date().toISOString(), exists: bytes !== undefined,
      content: bytes?.toString('base64') ?? '', sha256: bytes === undefined ? null : digest(bytes) };
    const handle = await open(join(dir, id + '.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
  }
  private async replace(target: FileTarget, revision: string, next: Buffer | undefined): Promise<FileView> {
    return this.locked(target, async () => {
      const current = await optionalBytes(target.path, this.limit());
      if (this.view(target, current).revision !== revision) throw new Error('文件已被其他窗口或程序修改，请重新加载 / File changed; reload before saving');
      if ((current === undefined && next === undefined) || (current !== undefined && next !== undefined && current.equals(next))) return this.view(target, current);
      await this.backup(target, current);
      await mkdir(dirname(target.path), { recursive: true });
      // Re-resolve after directory creation so existing symlinks cannot silently change the destination.
      if ((await this.target(target.id)).path !== target.path) throw new Error('文件路径发生变化，请重新加载 / Target path changed');
      const latest = await optionalBytes(target.path, this.limit());
      if (this.view(target, latest).revision !== revision) throw new Error('保存期间文件发生变化，请重新加载 / File changed during save');
      if (next === undefined) await unlink(target.path);
      else {
        const temp = join(dirname(target.path), '.dsh-purge-' + randomUUID() + '.tmp');
        const mode = current === undefined ? 0o600 : (await stat(target.path)).mode & 0o777;
        const handle = await open(temp, 'wx', mode);
        try { await handle.writeFile(next); await handle.sync(); }
        catch (error) { await handle.close(); await rm(temp, { force: true }); throw error; }
        await handle.close();
        try { await rename(temp, target.path); }
        finally { await rm(temp, { force: true }); }
      }
      return this.view(target, next);
    });
  }
  async save(id: string, revision: string, content: string): Promise<FileView> {
    const next = Buffer.from(content, 'utf8');
    if (next.length > this.limit()) throw new Error('内容超出文件字节上限 / Content exceeds byte limit');
    return this.replace(await this.target(id), revision, next);
  }
  async history(id: string): Promise<BackupView[]> {
    const target = await this.target(id);
    let names: string[];
    try { names = await readdir(this.directory(target)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: BackupView[] = [];
    for (const name of names.filter(value => /^[a-f0-9-]+\.json$/.test(value))) {
      const record = await this.record(target, name.slice(0, -5));
      result.push({ id: record.id, createdAt: record.createdAt, exists: record.exists, bytes: Buffer.from(record.content, 'base64').length });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async record(target: FileTarget, id: string): Promise<{ id: string; path: string; createdAt: string; exists: boolean; content: string; sha256: string | null }> {
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error('无效备份编号 / Invalid backup id');
    const path = join(this.directory(target), id + '.json');
    if ((await stat(path)).size > this.limit() * 2 + 8192) throw new Error('备份超过读取上限 / Backup exceeds limit');
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.id !== id || record.path !== target.path || typeof record.exists !== 'boolean'
      || typeof record.content !== 'string' || typeof record.createdAt !== 'string') throw new Error('备份格式不匹配 / Invalid backup record');
    const bytes = Buffer.from(record.content, 'base64');
    if (bytes.length > this.limit() || (record.exists && digest(bytes) !== record.sha256)) throw new Error('备份内容校验失败 / Backup checksum failed');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return record;
  }
  async restore(id: string, revision: string, backup: string): Promise<FileView> {
    const target = await this.target(id);
    const record = await this.record(target, backup);
    return this.replace(target, revision, record.exists ? Buffer.from(record.content, 'base64') : undefined);
  }
}
