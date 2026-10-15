import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { REMOTE, PACKAGE, NS, type PurgeRemote, type FileView, type BackupView, type PatchView, type RpcResult } from './contracts.ts';

const zh = {
  title: '全局 AGENTS.md', nav: '全局 AGENTS',
  help: '所有工作区共用的指令。保存后建议新建会话使用。',
  editor: '全局 AGENTS.md 内容', path: '文件位置', missing: '文件尚未创建；首次保存时创建。',
  save: '保存', reload: '重新加载', loading: '正在加载…', reloadHelp: '重新加载会放弃未保存的编辑。',
  saved: '已保存。原内容已自动备份；新会话将读取这份全局指令。',
  unchanged: '没有未保存的更改', dirty: '有未保存的更改', error: '操作未完成：',
  backups: '历史备份', chooseBackup: '选择要恢复的版本', restore: '恢复',
  noBackups: '暂时没有可恢复的旧内容。保存修改后会自动保留。',
  restored: '已恢复。恢复前的内容也已备份。',
  patched: '补丁已应用', restart: '补丁已写入；重启 DSH 后完整生效。',
  patchError: '补丁未完成：', conflictHelp: '若其他窗口改过文件，保存会提示冲突并保留此处草稿。',
};
const en: typeof zh = {
  title: 'Global AGENTS.md', nav: 'Global AGENTS',
  help: 'Shared instructions for all workspaces. Start a new session after saving.',
  editor: 'Global AGENTS.md contents', path: 'File location', missing: 'This file will be created on the first save.',
  save: 'Save', reload: 'Reload', loading: 'Loading…', reloadHelp: 'Reload discards unsaved edits.',
  saved: 'Saved. Previous contents backed up; new sessions will read these global instructions.',
  unchanged: 'No unsaved changes', dirty: 'Unsaved changes', error: 'Operation failed: ',
  backups: 'Backup history', chooseBackup: 'Select a version to restore', restore: 'Restore',
  noBackups: 'No previous contents yet. Editing and saving will create a backup.',
  restored: 'Restored. Replaced contents were also backed up.',
  patched: 'patches applied', restart: 'patches written; restart DSH to load them fully.',
  patchError: 'Patches incomplete: ', conflictHelp: 'External changes cause a save conflict; your draft is retained here.',
};
type Key = keyof typeof zh;
interface ClientContext extends Context {
  remote: TypertClientRemote & { dshPurge: PurgeRemote };
  locale: { register(ns: string, dictionaries: { zh: typeof zh; en: typeof zh }): () => void; bind(ns: string): (key: Key) => string };
  slots: {
    inject(slot: string, fn: () => unknown): void;
    register(options: { name: string; id: string; order: number; label: () => string; locale: string }, page: React.ComponentType): () => void;
  };
}
const css = `
.dsh-purge{width:100%;min-width:0;line-height:1.6;color:inherit}.dsh-purge *{box-sizing:border-box}
.dsh-purge h3{font-size:17px;font-weight:600;margin:0 0 8px}.dsh-purge p{margin:6px 0 12px}
.dsh-purge .dp-hint{font-size:12px;opacity:.65;overflow-wrap:anywhere}.dsh-purge .dp-path{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.7;overflow-wrap:anywhere;margin:16px 0 10px}
.dsh-purge textarea,.dsh-purge select{width:100%;background:transparent;color:inherit;border:1px solid #8886;border-radius:7px;padding:10px 12px;font:inherit}
.dsh-purge textarea{height:clamp(280px,38vh,440px);min-height:220px;resize:vertical;line-height:1.65;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;tab-size:2;white-space:pre}
.dsh-purge option{color:CanvasText;background:Canvas}.dsh-purge .dp-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0 8px}
.dsh-purge button{font:inherit;color:inherit;background:transparent;border:1px solid #8886;padding:7px 15px;border-radius:7px;cursor:pointer}
.dsh-purge button.dp-primary{color:white;background:#4d6bfe;border-color:#4d6bfe}.dsh-purge button:disabled{opacity:.4;cursor:default}
.dsh-purge :focus-visible{outline:2px solid #6f8aff;outline-offset:3px}.dsh-purge details{border-top:1px solid #8884;padding-top:16px;margin-top:20px}
.dsh-purge summary{cursor:pointer;font-size:13px;margin-bottom:10px}.dsh-purge .dp-notice{padding:9px 12px;border-left:3px solid #4d6bfe;background:#4d6bfe12;margin:12px 0;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-purge .dp-error{border-color:#e77;background:#e771}.dsh-purge .dp-badge{font-size:11px;opacity:.7}
@media(max-width:560px){.dsh-purge .dp-actions button{flex-grow:1}}
`;
async function unwrap<T>(promise: Promise<RpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export const inject = ['slots', 'locale', 'remote'];
async function mountClient(ctx: ClientContext): Promise<() => void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }));
  const t = ctx.locale.bind(NS);
  const disposeRemote = await ctx.remote.$mount(REMOTE);
  ctx.effect(() => disposeRemote);
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = PACKAGE; style.textContent = css; document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.inject(['remote.dshPurge'], child => {
    const rpc = (child as ClientContext).remote.dshPurge;
    function Editor(): React.ReactNode {
      const [file, setFile] = useState<FileView>();
      const [content, setContent] = useState('');
      const [history, setHistory] = useState<BackupView[]>([]);
      const [backup, setBackup] = useState('');
      const [patches, setPatches] = useState<PatchView>();
      const [busy, setBusy] = useState(true);
      const [notice, setNotice] = useState('');
      const [error, setError] = useState('');
      const generation = useRef(0);
      const mounted = useRef(true);
      const dirty = file !== undefined && file.content !== content;
      async function load() {
        const sequence = ++generation.current;
        setBusy(true); setError(''); setNotice('');
        try {
          const [next, backups, status] = await Promise.all([unwrap(rpc.readFile({ target: 'global' })), unwrap(rpc.history({ target: 'global' })), unwrap(rpc.status({}))]);
          if (mounted.current && generation.current === sequence) {
            setFile(next); setContent(next.content); setHistory(backups.filter(item => item.exists)); setBackup(''); setPatches(status);
          }
        } catch (reason) {
          if (mounted.current && generation.current === sequence) setError(reason instanceof Error ? reason.message : String(reason));
        } finally { if (mounted.current && generation.current === sequence) setBusy(false); }
      }
      useEffect(() => {
        mounted.current = true; void load();
        return () => { mounted.current = false; generation.current++; };
      }, []);
      async function save(restore: boolean) {
        if (!file) return;
        setBusy(true); setError(''); setNotice('');
        try {
          const next = restore
            ? await unwrap(rpc.restore({ target: 'global', revision: file.revision, backup }))
            : await unwrap(rpc.saveFile({ target: 'global', revision: file.revision, content }));
          if (!mounted.current) return;
          setFile(next); setContent(next.content); setBackup(''); setNotice(t(restore ? 'restored' : 'saved'));
          const backups = await unwrap(rpc.history({ target: 'global' }));
          if (mounted.current) setHistory(backups.filter(item => item.exists));
        } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { if (mounted.current) setBusy(false); }
      }
      return <div className="dsh-purge">
        <h3>{t('title')}</h3><p className="dp-hint">{t('help')}</p>
        {patches ? (patches.error ? <p className="dp-notice dp-error" role="alert">{patches.applied}/{patches.total} {t('patchError')}{patches.error}</p>
          : <span className="dp-badge">{patches.applied}/{patches.total} {t(patches.restartRequired ? 'restart' : 'patched')}</span>) : null}
        {error ? <div className="dp-notice dp-error" role="alert">{t('error')}{error}</div> : null}
        {notice ? <div className="dp-notice" role="status">{notice}</div> : null}
        <p className="dp-path">{file ? file.path : t('loading')}</p>
        {file && !file.exists ? <p className="dp-hint">{t('missing')}</p> : null}
        <textarea spellCheck={false} aria-label={t('editor')} value={content} disabled={busy || !file} onChange={event => setContent(event.target.value)} />
        <div className="dp-actions">
          <button className="dp-primary" disabled={busy || !file || (!dirty && file.exists)} onClick={() => void save(false)}>{t('save')}</button>
          <button disabled={busy} title={t('reloadHelp')} onClick={() => void load()}>{t('reload')}</button>
          <span className="dp-hint">{busy ? t('loading') : t(dirty ? 'dirty' : 'unchanged')}</span>
        </div>
        <p className="dp-hint">{t('conflictHelp')}</p>
        <details><summary>{t('backups')} · {history.length}</summary>{history.length ? <>
          <select aria-label={t('backups')} value={backup} disabled={busy || dirty} onChange={event => setBackup(event.target.value)}>
            <option value="">{t('chooseBackup')}</option>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.bytes} B</option>)}
          </select>
          <div className="dp-actions"><button disabled={busy || dirty || !backup || !file} onClick={() => void save(true)}>{t('restore')}</button></div>
        </> : <p className="dp-hint">{t('noBackups')}</p>}</details>
      </div>;
    }
    (child as ClientContext).slots.inject('settings.section', () => (child as ClientContext).slots.register({
      name: 'settings.section', id: 'dsh-purge', order: 25, label: () => t('nav'), locale: NS,
    }, Editor));
  });
  return () => {};
}
export async function apply(ctx: ClientContext): Promise<() => void> {
  try { return await mountClient(ctx); }
  catch (error) { console.error('[dsh-purge-plugin] startup failed', error); throw error; }
}
