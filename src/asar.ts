import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Electron's patched fs exposes archive entries, but cannot replace the archive.
export const rawFs: typeof nodeFs = process.versions.electron
  ? createRequire(import.meta.url)('original-fs') : nodeFs;
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
interface Entry { files?: Record<string, Entry>; link?: string; unpacked?: boolean; size?: number; offset?: string; executable?: boolean; integrity?: { algorithm: string; hash: string; blockSize: number; blocks: string[] } }
export function archiveLocation(base: string): { archive: string; prefix: string } | undefined {
  const absolute = resolve(base);
  const parts = absolute.split(sep);
  const index = parts.findIndex(part => part.endsWith('.asar'));
  if (index < 0) return;
  const archive = parts.slice(0, index + 1).join(sep);
  if (!rawFs.statSync(archive).isFile()) return;
  return { archive: rawFs.realpathSync(archive), prefix: parts.slice(index + 1).join('/') };
}
export function atomicBytes(path: string, bytes: Uint8Array, mode: number): void {
  const temp = join(dirname(path), '.' + randomUUID() + '.dsh-purge.tmp');
  let handle: number | undefined;
  try {
    handle = rawFs.openSync(temp, 'wx', mode);
    rawFs.writeFileSync(handle, bytes); rawFs.fsyncSync(handle);
    rawFs.closeSync(handle); handle = undefined;
    rawFs.renameSync(temp, path);
  } finally {
    if (handle !== undefined) rawFs.closeSync(handle);
    if (rawFs.existsSync(temp)) rawFs.unlinkSync(temp);
  }
}
/** Parse independently of Electron's process-wide ASAR cache. No extraction or symlink traversal. */
export class Archive {
  readonly bytes: Buffer;
  readonly tree: Entry;
  readonly dataStart: number;
  readonly path: string;
  constructor(path: string) {
    this.path = rawFs.realpathSync(path);
    this.bytes = rawFs.readFileSync(this.path);
    if (this.bytes.length < 16 || this.bytes.readUInt32LE(0) !== 4) throw new Error('无效的 ASAR 文件头');
    const headerSize = this.bytes.readUInt32LE(4);
    const jsonSize = this.bytes.readUInt32LE(12);
    this.dataStart = 8 + headerSize;
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024 || this.dataStart > this.bytes.length || jsonSize > headerSize - 8 || this.bytes.readUInt32LE(8) !== headerSize - 4) throw new Error('无效的 ASAR 文件头长度');
    this.tree = JSON.parse(this.bytes.subarray(16, 16 + jsonSize).toString('utf8'));
    if (!this.tree.files) throw new Error('ASAR 缺少目录');
  }
  entry(path: string): Entry {
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('无效的 ASAR 路径');
    let entry = this.tree;
    for (const part of parts) {
      if (!entry.files || !Object.hasOwn(entry.files, part)) throw new Error('ASAR 中找不到文件：' + path);
      entry = entry.files[part];
      if (entry.link) throw new Error('补丁目标不能经过 ASAR 链接：' + path);
    }
    return entry;
  }
  read(path: string): Buffer {
    const entry = this.entry(path);
    if (entry.files || !Number.isSafeInteger(entry.size) || entry.size! < 0) throw new Error('无效的 ASAR 文件：' + path);
    // Keep all changed files in the same atomic archive transaction.
    if (entry.unpacked) throw new Error('补丁目标已被单独解包，暂不支持混合写入：' + path);
    const offset = Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || this.dataStart + offset + entry.size! > this.bytes.length) throw new Error('ASAR 文件范围无效：' + path);
    const bytes = this.bytes.subarray(this.dataStart + offset, this.dataStart + offset + entry.size!);
    if (entry.integrity && (entry.integrity.algorithm !== 'SHA256' || sha256(bytes) !== entry.integrity.hash)) throw new Error('ASAR 文件校验失败：' + path);
    return bytes;
  }
  updated(changes: Map<string, Buffer>): Buffer {
    const tree = structuredClone(this.tree);
    const appended: Buffer[] = [];
    let offset = this.bytes.length - this.dataStart;
    for (const [path, bytes] of changes) {
      this.read(path);
      let entry = tree;
      for (const part of path.split('/')) entry = entry.files![part];
      entry.size = bytes.length; entry.offset = String(offset); offset += bytes.length;
      const blockSize = entry.integrity?.blockSize ?? 4 * 1024 * 1024;
      if (!Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 64 * 1024 * 1024) throw new Error('ASAR blockSize 无效');
      const blocks = [];
      for (let at = 0; at < bytes.length; at += blockSize) blocks.push(sha256(bytes.subarray(at, at + blockSize)));
      entry.integrity = { algorithm: 'SHA256', hash: sha256(bytes), blockSize, blocks };
      appended.push(bytes);
    }
    const json = Buffer.from(JSON.stringify(tree));
    const payloadSize = 4 + Math.ceil(json.length / 4) * 4;
    const header = Buffer.alloc(12 + payloadSize);
    header.writeUInt32LE(4, 0); header.writeUInt32LE(4 + payloadSize, 4);
    header.writeUInt32LE(payloadSize, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16);
    return Buffer.concat([header, this.bytes.subarray(this.dataStart), ...appended]);
  }
  relative(path: string): string {
    const value = relative(this.path, path).split(sep).join('/');
    if (value.startsWith('../') || value === '..') throw new Error('补丁路径超出 ASAR');
    return value;
  }
}
