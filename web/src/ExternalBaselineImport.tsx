import React, { useEffect, useRef, useState } from 'react';
import type { BaselineImportStatus } from '../../src/contracts/baseline-bundle';
import { request } from './api';
import { Feedback, Field, Icon } from './components';

interface SelectedFile { path: string; file: File }
const supported = /\.(?:so(?:\.[A-Za-z0-9_.+-]+)?|h|hpp|hh)$/;
const library = /\.so(?:\.[A-Za-z0-9_.+-]+)?$/;
const size = (bytes: number) => bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export function ExternalBaselineImport({ projectId, packageId, version, targetId, hasBaseline, machineName, onBound }: {
  projectId: string; packageId: string; version: string; targetId: string; hasBaseline: boolean; machineName: string;
  onBound: () => Promise<void>;
}) {
  const base = `/v1/projects/${encodeURIComponent(projectId)}/baseline-bundles`;
  const [name, setName] = useState(''), [libraryVersion, setLibraryVersion] = useState('');
  const [selected, setSelected] = useState<SelectedFile[]>([]), [ignored, setIgnored] = useState(0);
  const [session, setSession] = useState<BaselineImportStatus | null>(null), [entry, setEntry] = useState('');
  const [working, setWorking] = useState(''), [progress, setProgress] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; bad: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const filesRef = useRef<HTMLInputElement>(null), folderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ package_id: packageId, package_version: version, target_id: targetId });
    request<{ imports: BaselineImportStatus[] }>(`${base}?${query}`).then(value => {
      if (!active) return;
      const latest = value.imports.find(item => item.state !== 'BOUND');
      if (latest) { setSession(latest); setName(latest.library); setLibraryVersion(latest.library_version);
        setEntry(latest.check?.entry_path ?? (latest.entries.length === 1 ? latest.entries[0] : '')); }
    }).catch(error => { if (active) setFeedback({ text: error.message, bad: true }); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [base, packageId, version, targetId]);
  useEffect(() => {
    if (session?.state !== 'CHECKING') return;
    const timer = setTimeout(() => { void refresh(session.bundle_id).catch(error => setFeedback({ text: error.message, bad: true })); }, 2000);
    return () => clearTimeout(timer);
  }, [session]);
  async function refresh(id: string) { const latest = await request<BaselineImportStatus>(`${base}/${id}`); setSession(latest); return latest; }
  async function run(action: string, work: () => Promise<void>) {
    setWorking(action); setFeedback(null);
    try { await work(); } catch (error) { setFeedback({ text: (error as Error).message, bad: true }); }
    finally { setWorking(''); }
  }
  function choose(files: FileList | null, folder: boolean) {
    if (!files) return;
    const values = Array.from(files).map(file => ({ file, path: folder ? file.webkitRelativePath.split('/').slice(1).join('/') || file.name : file.name }));
    if (values.some(item => /\.(?:zip|tgz|gz|xz|bz2|rpm|deb|tar)$/i.test(item.path))) {
      setFeedback({ text: '请先将安装包或压缩包解压，再选择包含 .so 和头文件的文件夹。这里接收已编译的库文件。', bad: true }); return;
    }
    const valid = values.filter(item => supported.test(item.path));
    if (!valid.length) { setFeedback({ text: '未发现 .so 动态库或 .h/.hpp/.hh 头文件，请选择已编译的库文件或其所在文件夹。', bad: true }); return; }
    const merged = new Map(selected.map(item => [item.path, item]));
    for (const item of valid) if (!session?.files.some(file => file.path === item.path)) merged.set(item.path, item);
    setSelected([...merged.values()]); setIgnored(values.length - valid.length); setFeedback(null);
    if (filesRef.current) filesRef.current.value = ''; if (folderRef.current) folderRef.current.value = '';
  }
  async function upload() {
    const count = selected.length + (session?.files.length ?? 0), bytes = selected.reduce((sum, item) => sum + item.file.size, 0) + (session?.files.reduce((sum, file) => sum + file.bytes, 0) ?? 0);
    if (!selected.length) throw new Error('请先选择库文件');
    if (count > 256 || bytes > 1024 ** 3 || selected.some(item => item.file.size > 512 * 1024 ** 2)) throw new Error('单文件最多 512 MB，一次导入最多 256 个文件、合计 1 GB');
    const id = session?.bundle_id ?? (await request<{ bundle_id: string }>(base, 'POST', {
      package_id: packageId, package_version: version, target_id: targetId, library: name.trim(), library_version: libraryVersion.trim(),
    })).bundle_id;
    setSession(await request<BaselineImportStatus>(`${base}/${id}`));
    let completed = 0;
    try {
      for (const item of selected) {
        setProgress(`正在上传 ${completed + 1}/${selected.length}：${item.path}`);
        const response = await fetch(`${base}/${id}/files?path=${encodeURIComponent(item.path)}`, { method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' }, body: item.file, signal: AbortSignal.timeout(600_000) });
        const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? `上传失败：HTTP ${response.status}`);
        completed++;
      }
    } finally {
      const latest = await refresh(id);
      setSelected(current => current.filter(item => !latest.files.some(file => file.path === item.path)));
      if (!entry && latest.entries.length === 1) setEntry(latest.entries[0]);
      setProgress('');
    }
    setFeedback({ text: '文件已上传。确认入口库后，在执行机器上检查；当前比较基线保持原样。', bad: false });
  }
  async function check() {
    if (!session || !entry) return;
    setProgress(`正在 ${machineName} 检查架构、依赖和加载符号…`);
    try { await request(`${base}/${session.bundle_id}/check`, 'POST', { entry_path: entry }); }
    finally { await refresh(session.bundle_id); setProgress(''); }
  }
  async function bind() {
    if (!session) return;
    await request(`${base}/${session.bundle_id}/bind`, 'POST', { entry_path: entry });
    await refresh(session.bundle_id); await onBound();
    setFeedback({ text: '外部库已固定为当前比较基线。下一步配置测试条件，再生成或上传两库测试代码。', bad: false });
  }
  function reset() { setSession(null); setSelected([]); setEntry(''); setName(''); setLibraryVersion(''); setFeedback(null); setProgress(''); setIgnored(0); }
  const remoteCheck = session?.check;
  const ready = session?.state === 'READY' && remoteCheck?.entry_path === entry && !selected.length;
  const blocked = !!working || loading || session?.state === 'CHECKING';
  const inventory = [...session?.files ?? [], ...selected.map(item => ({ path: item.path, bytes: item.file.size, sha256: '' }))];
  return <div className="external-baseline">
    <div className="test-section-heading"><strong>导入已编译的外部库</strong>{session && <button type="button" disabled={blocked} className="text-btn" onClick={reset}>新建导入</button>}</div>
    <p className="hint">例如第三方算法库。一次选择入口 .so、依赖库及头文件；也可以直接选择解包后的文件夹。</p>
    {loading && <p role="status" className="hint">正在读取未完成的导入…</p>}
    {feedback && <Feedback text={feedback.text} bad={feedback.bad} />}
    <ol className="baseline-import-steps" aria-label="外部库导入步骤">{['选择文件', '检查兼容性', '固定基线'].map((text, i) => <li key={text} aria-current={(!session ? i === 0 : ready || session.state === 'BOUND' ? i === 2 : i === 1) ? 'step' : undefined}><span>{i + 1}</span>{text}</li>)}</ol>
    <div className="validation-script-grid"><Field label="比较库名称"><input aria-label="比较库名称" value={name} disabled={!!session || blocked} onChange={event => setName(event.target.value)} placeholder="例如 HMPPI" /></Field>
      <Field label="比较库版本"><input aria-label="比较库版本" value={libraryVersion} disabled={!!session || blocked} onChange={event => setLibraryVersion(event.target.value)} placeholder="填写实际版本" /></Field></div>
    {session?.state !== 'BOUND' && <div className="baseline-file-picker"><Icon name="folder" size={28} /><div><strong>{session ? '补充库文件与头文件' : '选择库文件或文件夹'}</strong><p>单个库与多文件库使用同一流程。文件会在固定前接受目标机检查。</p></div>
      <div className="baseline-file-actions"><label className="file-choice">选择库文件<input ref={filesRef} aria-label="选择外部库文件" type="file" multiple disabled={blocked} onChange={event => choose(event.target.files, false)} /></label>
        <label className="file-choice">选择已解包文件夹<input ref={element => { folderRef.current = element; if (element) element.setAttribute('webkitdirectory', ''); }} aria-label="选择已解包的库文件夹" type="file" multiple disabled={blocked} onChange={event => choose(event.target.files, true)} /></label></div></div>}
    {!!inventory.length && <div className="baseline-file-summary"><strong>{inventory.filter(item => library.test(item.path)).length} 个动态库 · {inventory.filter(item => !library.test(item.path)).length} 个头文件 · {size(inventory.reduce((sum, item) => sum + item.bytes, 0))}</strong>
      {!!ignored && <small>已忽略本次选择中的 {ignored} 个其他文件</small>}
      <details><summary>查看文件清单</summary><ul>{inventory.map(item => <li key={item.path}><code>{item.path}</code><span>{size(item.bytes)}{item.sha256 ? ' · 已上传' : ' · 待上传'}</span></li>)}</ul></details></div>}
    {!!selected.length && <div className="form-actions"><button type="button" className="primary" disabled={!name.trim() || !libraryVersion.trim() || blocked} onClick={() => void run('upload', upload)}>{working === 'upload' ? '正在上传…' : session ? '上传补充文件' : '上传所选文件'}</button><button type="button" disabled={blocked} onClick={() => setSelected([])}>清空待上传文件</button></div>}
    {progress && <p role="status" className="hint">{progress}</p>}
    {!!session?.entries.length && <Field label="用于对比的入口库" help="测试程序将调用这个库；其余动态库作为运行依赖一起提供。"><select aria-label="用于对比的入口库" disabled={blocked || session.state === 'BOUND'} value={entry} onChange={event => setEntry(event.target.value)}><option value="" disabled hidden>请选择入口库</option>{session.entries.map(value => <option key={value} value={value}>{value}</option>)}</select></Field>}
    {session && !session.entries.length && <p className="hint">已上传头文件，请继续补充至少一个 .so 动态库。</p>}
    {!!session?.entries.length && session.state !== 'BOUND' && <button type="button" className="baseline-check-button" disabled={!entry || blocked || !!selected.length} onClick={() => void run('check', check)}>{working === 'check' || session.state === 'CHECKING' ? '正在检查…' : ready ? '重新检查兼容性' : '在执行机器上检查兼容性'}</button>}
    {remoteCheck && <div className={`baseline-inspection ${ready ? 'ready' : ''}`} role="status"><strong>{ready ? '目标机检查通过，等待固定' : remoteCheck.entry_path !== entry ? '入口库已更换，请重新检查' : remoteCheck.state === 'CHECKING' ? '目标机检查中' : remoteCheck.state === 'NEEDS_RECHECK' ? '需要重新检查' : '检查结果'}</strong>
      <p>{remoteCheck.machine.name}{remoteCheck.inspection ? ` · ${new Date(remoteCheck.inspection.checked_at).toLocaleString('zh-CN', { hour12: false })}` : ''}</p>
      {remoteCheck.error && <Feedback text={remoteCheck.error} bad />}
      {!!remoteCheck.inspection?.issues.length && <div className="baseline-bundle-issues"><strong>需要补齐或调整</strong><ul>{remoteCheck.inspection.issues.map(issue => <li key={issue}>{issue}</li>)}</ul><p>可以在上方补充缺少的文件，再重新检查。</p></div>}
      {remoteCheck.inspection?.ok && <><p>已核对文件身份、ELF 架构和运行依赖。测试正确性与性能将在后续流程验证。</p><details><summary>查看库架构与依赖</summary>{remoteCheck.inspection.libraries.map(item => <div key={item.path}><code>{item.path}</code><p>{item.elf.class} · {item.elf.machine} · {item.needed.map(dep => `${dep.soname} (${dep.classification === 'BUNDLED_DEPENDENCY' ? '已上传' : dep.classification === 'SYSTEM_DEPENDENCY' ? '目标机提供' : '缺少'})`).join('、') || '无动态依赖'}</p></div>)}</details></>}
    </div>}
    {session?.state !== 'BOUND' && <div className="baseline-bind-action"><p>{hasBaseline ? '固定后，将替换当前目标的比较基线。' : '固定后，这份外部库将用于后续两库测试。'}上传和检查不会切换当前基线。</p>
      <button type="button" className="primary" disabled={!ready || blocked} onClick={() => void run('bind', bind)}>{working === 'bind' ? '正在固定…' : hasBaseline ? '替换当前比较基线' : '固定为比较基线'}</button></div>}
  </div>;
}
