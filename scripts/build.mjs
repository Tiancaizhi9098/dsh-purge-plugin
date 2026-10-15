import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('lib', { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node22.19', packages: 'external', sourcemap: true });
const browser = await build({ entryPoints: ['src/client.tsx'], write: false, bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'], minify: false });
await writeFile('lib/client.js', 'window.__ModuleLoader__.load({id:"dsh-purge-plugin",factory:function(require){\nconst module={exports:{}};const exports=module.exports;\n'
  + browser.outputFiles[0].text + '\nreturn module.exports;\n}});\n');
await build({ entryPoints: ['src/patches.ts'], outfile: 'lib/patches.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22.19', packages: 'external' });
// Separate filesystem entry keeps tests independent of a running Harness.
await build({ entryPoints: ['src/files.ts'], outdir: 'lib/testable',
  bundle: true, platform: 'node', format: 'esm', target: 'node22.19', packages: 'external' });
