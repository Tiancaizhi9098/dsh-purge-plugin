import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { NS, REMOTE, requests, type PatchView } from './contracts.ts';
import { InstructionFiles } from './files.ts';
import { applyPatches, inspectPatches, runtimeNeedsRestart } from './patches.ts';

// Legacy options are ignored; AGENTS.md is the sole editable instruction source.
export const Config = schema.object({});
declare module '@deepseek-ai/cordis' { interface Context { dshPurge: PurgePlugin } }

export default class PurgePlugin extends TypertRemoteService {
  static Config = Config;
  static inject = ['settings', 'typert'];
  private readonly files: InstructionFiles;
  private readonly patches: PatchView;
  constructor(ctx: Context) {
    super(ctx, NS);
    const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
    this.files = new InstructionFiles(() => [{ id: 'global', label: '全局 AGENTS.md', path: join(home, 'AGENTS.md'), root: home }], join(home, 'plugins', 'dsh-purge', 'backups'), () => 1_048_576);
    try {
      const result = applyPatches(undefined, join(home, 'plugins', 'dsh-purge', 'runtime-backups'));
      this.patches = { applied: result.patches.filter(patch => patch.applied).length, total: 8, restartRequired: result.changed || runtimeNeedsRestart(result.base) };
    } catch (error) {
      let applied = 0;
      try { applied = inspectPatches().patches.filter(patch => patch.applied).length; } catch {}
      this.patches = { applied, total: 8, restartRequired: false, error: error instanceof Error ? error.message : String(error) };
    }
    ctx.effect(() => ctx.typert.register({ package: REMOTE.package, face: 'host', schemas: [], invocations: REMOTE.descriptors, model: { services: [], events: [], objects: [] } }));
    ctx.effect(() => ctx.settings.configure({ auto: false }));
  }
  async status(request: unknown): Promise<PatchView> { requests.status.parse(request); return this.patches; }
  async readFile(request: unknown) { return this.files.read(requests.readFile.parse(request).target); }
  async saveFile(request: unknown) { const value = requests.saveFile.parse(request); return this.files.save(value.target, value.revision, value.content); }
  async history(request: unknown) { return this.files.history(requests.history.parse(request).target); }
  async restore(request: unknown) { const value = requests.restore.parse(request); return this.files.restore(value.target, value.revision, value.backup); }
}
