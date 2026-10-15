import { z } from 'zod';
import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
export const PACKAGE = 'dsh-purge-plugin';
export const NS = 'dshPurge';
const target = z.literal('global');
const revision = z.string().regex(/^(missing|[a-f0-9]{64})$/);
export const requests = {
  status: z.object({}).strict(),
  readFile: z.object({ target }).strict(),
  saveFile: z.object({ target, revision, content: z.string().max(1_048_576) }).strict(),
  history: z.object({ target }).strict(),
  restore: z.object({ target, revision, backup: z.string().regex(/^[a-f0-9-]+$/) }).strict(),
};
export type Method = keyof typeof requests;
export interface FileView { target: string; path: string; exists: boolean; content: string; revision: string; bytes: number }
export interface BackupView { id: string; createdAt: string; exists: boolean; bytes: number }
export interface PatchView { applied: number; total: number; restartRequired: boolean; error?: string }
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } };
export interface PurgeRemote {
  status(request: z.infer<typeof requests.status>): Promise<RpcResult<PatchView>>;
  readFile(request: z.infer<typeof requests.readFile>): Promise<RpcResult<FileView>>;
  saveFile(request: z.infer<typeof requests.saveFile>): Promise<RpcResult<FileView>>;
  history(request: z.infer<typeof requests.history>): Promise<RpcResult<BackupView[]>>;
  restore(request: z.infer<typeof requests.restore>): Promise<RpcResult<FileView>>;
}
export const REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: (Object.entries(requests) as [Method, z.ZodType][]).map(([method, schema]): InvocationDescriptor => ({
    id: PACKAGE + '#' + NS + '/' + method, service: NS, namespace: NS, method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
      mode: 'strict', typeSymbol: PACKAGE + '#' + method + 'Request', create: () => schema,
    } }],
    result: { mode: 'src-json' },
  })),
};