// src/files.ts
import { mkdir, open, readFile, realpath, rename, rm, stat, unlink, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
var digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
var inside = (root, file) => {
  const part = relative(root, file);
  return part === "" || !isAbsolute(part) && part !== ".." && !part.startsWith(".." + (process.platform === "win32" ? "\\" : "/"));
};
async function nearestReal(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await nearestReal(parent), relative(parent, path));
  }
}
async function optionalBytes(path, limit) {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("\u76EE\u6807\u4E0D\u662F\u666E\u901A\u6587\u4EF6 / Target is not a regular file");
    if (info.size > limit) throw new Error(`\u6587\u4EF6\u8D85\u8FC7 ${limit} \u5B57\u8282\u4E0A\u9650 / File exceeds byte limit`);
    const bytes = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > limit) throw new Error("\u8BFB\u53D6\u671F\u95F4\u6587\u4EF6\u8D85\u51FA\u4E0A\u9650 / File grew beyond limit");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
var InstructionFiles = class {
  constructor(targets, backupRoot, limit) {
    this.targets = targets;
    this.backupRoot = backupRoot;
    this.limit = limit;
  }
  async target(id) {
    const target = this.targets().find((value) => value.id === id);
    if (!target) throw new Error("\u672A\u77E5\u6587\u4EF6\uFF0C\u8BF7\u5237\u65B0\u5217\u8868 / Unknown target; refresh the list");
    const root = await nearestReal(resolve(target.root));
    const path = await nearestReal(resolve(target.path));
    if (!inside(root, path) || path === root) throw new Error("\u76EE\u6807\u94FE\u63A5\u8D85\u51FA\u5141\u8BB8\u76EE\u5F55 / Target link escapes the allowed directory");
    return { ...target, root, path };
  }
  view(target, bytes) {
    return {
      target: target.id,
      path: target.path,
      exists: bytes !== void 0,
      content: bytes?.toString("utf8") ?? "",
      revision: bytes === void 0 ? "missing" : digest(bytes),
      bytes: bytes?.length ?? 0
    };
  }
  async read(id) {
    const target = await this.target(id);
    return this.view(target, await optionalBytes(target.path, this.limit()));
  }
  directory(target) {
    return join(this.backupRoot, digest(Buffer.from(target.path)));
  }
  async locked(target, action) {
    await mkdir(this.backupRoot, { recursive: true, mode: 448 });
    const lock = join(this.backupRoot, digest(Buffer.from(target.path)) + ".lock");
    let handle;
    try {
      handle = await open(lock, "wx", 384);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("\u6587\u4EF6\u6B63\u5728\u4FDD\u5B58\uFF1B\u82E5\u4E0A\u6B21\u8FDB\u7A0B\u5D29\u6E83\uFF0C\u8BF7\u68C0\u67E5\u5E76\u79FB\u9664\u9501\u6587\u4EF6\uFF1A" + lock);
      throw error;
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
  async backup(target, bytes) {
    const dir = this.directory(target);
    await mkdir(dir, { recursive: true, mode: 448 });
    const id = randomUUID();
    const record = {
      id,
      path: target.path,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      exists: bytes !== void 0,
      content: bytes?.toString("base64") ?? "",
      sha256: bytes === void 0 ? null : digest(bytes)
    };
    const handle = await open(join(dir, id + ".json"), "wx", 384);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async replace(target, revision, next) {
    return this.locked(target, async () => {
      const current = await optionalBytes(target.path, this.limit());
      if (this.view(target, current).revision !== revision) throw new Error("\u6587\u4EF6\u5DF2\u88AB\u5176\u4ED6\u7A97\u53E3\u6216\u7A0B\u5E8F\u4FEE\u6539\uFF0C\u8BF7\u91CD\u65B0\u52A0\u8F7D / File changed; reload before saving");
      if (current === void 0 && next === void 0 || current !== void 0 && next !== void 0 && current.equals(next)) return this.view(target, current);
      await this.backup(target, current);
      await mkdir(dirname(target.path), { recursive: true });
      if ((await this.target(target.id)).path !== target.path) throw new Error("\u6587\u4EF6\u8DEF\u5F84\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u52A0\u8F7D / Target path changed");
      const latest = await optionalBytes(target.path, this.limit());
      if (this.view(target, latest).revision !== revision) throw new Error("\u4FDD\u5B58\u671F\u95F4\u6587\u4EF6\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u52A0\u8F7D / File changed during save");
      if (next === void 0) await unlink(target.path);
      else {
        const temp = join(dirname(target.path), ".dsh-purge-" + randomUUID() + ".tmp");
        const mode = current === void 0 ? 384 : (await stat(target.path)).mode & 511;
        const handle = await open(temp, "wx", mode);
        try {
          await handle.writeFile(next);
          await handle.sync();
        } catch (error) {
          await handle.close();
          await rm(temp, { force: true });
          throw error;
        }
        await handle.close();
        try {
          await rename(temp, target.path);
        } finally {
          await rm(temp, { force: true });
        }
      }
      return this.view(target, next);
    });
  }
  async save(id, revision, content) {
    const next = Buffer.from(content, "utf8");
    if (next.length > this.limit()) throw new Error("\u5185\u5BB9\u8D85\u51FA\u6587\u4EF6\u5B57\u8282\u4E0A\u9650 / Content exceeds byte limit");
    return this.replace(await this.target(id), revision, next);
  }
  async history(id) {
    const target = await this.target(id);
    let names;
    try {
      names = await readdir(this.directory(target));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const result = [];
    for (const name of names.filter((value) => /^[a-f0-9-]+\.json$/.test(value))) {
      const record = await this.record(target, name.slice(0, -5));
      result.push({ id: record.id, createdAt: record.createdAt, exists: record.exists, bytes: Buffer.from(record.content, "base64").length });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async record(target, id) {
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error("\u65E0\u6548\u5907\u4EFD\u7F16\u53F7 / Invalid backup id");
    const path = join(this.directory(target), id + ".json");
    if ((await stat(path)).size > this.limit() * 2 + 8192) throw new Error("\u5907\u4EFD\u8D85\u8FC7\u8BFB\u53D6\u4E0A\u9650 / Backup exceeds limit");
    const record = JSON.parse(await readFile(path, "utf8"));
    if (record.id !== id || record.path !== target.path || typeof record.exists !== "boolean" || typeof record.content !== "string" || typeof record.createdAt !== "string") throw new Error("\u5907\u4EFD\u683C\u5F0F\u4E0D\u5339\u914D / Invalid backup record");
    const bytes = Buffer.from(record.content, "base64");
    if (bytes.length > this.limit() || record.exists && digest(bytes) !== record.sha256) throw new Error("\u5907\u4EFD\u5185\u5BB9\u6821\u9A8C\u5931\u8D25 / Backup checksum failed");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return record;
  }
  async restore(id, revision, backup) {
    const target = await this.target(id);
    const record = await this.record(target, backup);
    return this.replace(target, revision, record.exists ? Buffer.from(record.content, "base64") : void 0);
  }
};
export {
  InstructionFiles
};
