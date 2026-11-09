import React, { useEffect, useState } from 'react';
import type { ProjectRecord, RepositoryInspection } from '../../src/contracts/project';
import { api } from './api';
import { DirectoryPicker } from './DirectoryPicker';
import { CopyValue, Feedback, Field, Icon, Modal } from './components';

export function SourceBranchSelect({ repository, value, onChange, disabled = false, compact = false, label = '优化分支' }: {
  repository: RepositoryInspection; value: string; onChange: (value: string) => void; disabled?: boolean; compact?: boolean; label?: string;
}) {
  if (!repository.is_git) return <p className="hint">该目录尚未建立 Git 仓库，首次优化时会为源码建立可追溯的版本基线。</p>;
  if (!repository.branches.length) return <p className="hint">Git 仓库尚无已提交的本地分支，首次优化时会创建源码基线。</p>;
  const selected = repository.branches.find(branch => branch.name === value);
  return <div className="source-branches">
    <p className="hint">当前检出：<strong>{repository.current_branch ?? '游离 HEAD'}</strong>{repository.head_commit && <code> · {repository.head_commit.slice(0, 12)}</code>}</p>
    <Field label={label} help={compact ? '使用该分支已提交的源码。' : '任务从所选分支的已提交版本开始，在独立工作区优化；人工交付后合并回该分支。'}>
      <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        {!selected && <option value={value} disabled>{value ? `${value}（分支已不存在，请重新选择）` : '请选择分支'}</option>}
        {repository.branches.map(branch => <option key={branch.name} value={branch.name}>{branch.name}{branch.name === repository.current_branch ? ' · 当前分支' : ''} · {branch.commit.slice(0, 8)}</option>)}
      </select>
    </Field>
    {selected && (compact ? <details className="branch-version"><summary>查看分支版本</summary><CopyValue value={selected.commit} label="分支版本" /><p>{selected.subject}</p>{selected.upstream && <p>跟踪 {selected.upstream}</p>}</details>
      : <p className="branch-commit"><code>{selected.commit.slice(0, 12)}</code><span>{selected.subject}</span>{selected.upstream && <small>跟踪 {selected.upstream}</small>}</p>)}
  </div>;
}


export function AddProject({ close, added, projects }: { close: () => void; added: (project: ProjectRecord) => void; projects: ProjectRecord[] }) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [config, setConfig] = useState('');
  const [branch, setBranch] = useState('');
  const [repository, setRepository] = useState<RepositoryInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectionError, setInspectionError] = useState('');
  const [inspectionRetry, setInspectionRetry] = useState(0);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setRepository(null); setBranch(''); setInspectionError(''); setInspecting(!!root.trim());
    if (!root.trim()) return;
    const timer = setTimeout(() => {
      api.inspectRepository(root.trim()).then(info => {
        if (cancelled) return;
        setRepository(info); setBranch(info.branches.find(b => b.name === info.current_branch)?.name ?? info.branches[0]?.name ?? '');
      }).catch(e => { if (!cancelled) setInspectionError(e.message); }).finally(() => { if (!cancelled) setInspecting(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [root, inspectionRetry]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const info = repository ?? await api.inspectRepository(root.trim());
      const selectedBranch = branch || info.branches.find(b => b.name === info.current_branch)?.name || info.branches[0]?.name;
      const result = await api.addProject({ name: name.trim(), repository_root: root.trim(), ...(selectedBranch ? { source_branch: selectedBranch } : {}), ...(config.trim() ? { config_path: config.trim() } : {}) });
      added(result.project);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <><Modal title="添加源码项目" onClose={() => { if (!busy) close(); }}><form onSubmit={e => void submit(e)}><fieldset className="source-project-fields" disabled={busy}>
    <Field label="项目名称"><input required autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="例如 IPPI-FT" /></Field>
    <Field label="服务器上的源码目录" help="选择运行 CorePilot 的服务器上的源码目录；本机部署时可直接浏览本机各盘符。"><div className="input-button"><input required value={root} onChange={e => { setRoot(e.target.value); setError(''); }} placeholder="D:\sources\my-library 或 /srv/sources/my-library" /><button type="button" onClick={() => setBrowsing(true)}><Icon name="folder" size={17} />浏览</button></div></Field>
    {inspecting && <p className="hint">正在读取 Git 分支…</p>}
    {repository && <SourceBranchSelect repository={repository} value={branch} onChange={setBranch} />}
    {inspectionError && !error && <div className="source-inspection-error"><p className="hint">{inspectionError}</p><button type="button" onClick={() => setInspectionRetry(value => value + 1)}>重新读取分支</button></div>}
    <div className="config-import"><p className="hint">首次使用无需准备配置文件。添加后先选择模型与机器，再到「构建与验证」准备编译和测试。</p><details><summary>导入已有 CorePilot 配置（可选）{config.trim() && ' · 已填写配置路径'}</summary><Field label="CorePilot 配置文件路径" help="已有 CLI 用户可填写 corepilot.yaml 的路径，复用模型、机器、构建与测试设置。支持绝对路径或相对源码目录的路径；后续保存配置会更新此文件。"><input value={config} onChange={e => setConfig(e.target.value)} placeholder="例如 corepilot.yaml 或 /srv/config/corepilot.yaml" /></Field></details></div>
    {error && <Feedback text={error} bad />}
    <div className="form-actions"><button type="button" disabled={busy} onClick={close}>返回</button><button className="primary" disabled={busy}>{busy ? '添加中…' : '添加项目'}</button></div>
  </fieldset></form></Modal>
    {browsing && <DirectoryPicker initial={root.trim()} projects={projects} close={() => setBrowsing(false)} selected={directory => { setRoot(directory); setBrowsing(false); setError(''); }} />}
  </>;
}
