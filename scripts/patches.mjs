import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyPatches, inspectPatches, revertPatches, findDshBase } from '../lib/patches.js';
const [mode = 'status', manifest] = process.argv.slice(2);
const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
try {
  const base = findDshBase();
  if (mode === 'revert') {
    if (!manifest) throw new Error('revert 需要指定备份 JSON 的完整路径');
    revertPatches(resolve(manifest), base);
    console.log('已恢复原文件。先停用插件，再重启 DSH，防止启动时重新应用补丁。');
  } else if (mode === 'apply' || mode === 'status') {
    const report = mode === 'apply' ? applyPatches(base, join(home, 'plugins', 'dsh-purge', 'runtime-backups')) : inspectPatches(base);
    console.log(JSON.stringify(report, null, 2));
    if (report.changed) console.log('需要重启 DSH，已加载的模块才会使用新补丁。');
  } else throw new Error('用法：node scripts/patches.mjs status|apply|revert [备份路径]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
