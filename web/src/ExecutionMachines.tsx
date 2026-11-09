import React, { useEffect, useState } from 'react';
import type { ExecutionMachineDetails, ExecutionMachineSummary } from '../../src/contracts/execution-machine';
import type { TargetConfig } from '../../src/config/target-config';
import { createRpcRunnerConfig, type RpcRunnerConnection } from '../../src/config/runner-config';
import { request } from './api';
import { Panel, Modal, Field, Feedback, Empty, Icon } from './components';
import { MachineCheckFeedback, MachineFacts, MachineStatus } from './MachineStatus';

interface MachineDraft { id?: string; revision?: number; name: string; runner: RpcRunnerConnection; target: TargetConfig | null; enabled: boolean }
export function ExecutionMachines() {
  const [machines, setMachines] = useState<ExecutionMachineSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<MachineDraft | null>(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState('');
  const [checked, setChecked] = useState<ExecutionMachineSummary | null>(null);
  async function load() { const data = await request<{ machines: ExecutionMachineSummary[] }>('/v1/machines'); setMachines(data.machines); setError(''); }
  useEffect(() => {
    let cancelled = false;
    const refresh = () => request<{ machines: ExecutionMachineSummary[] }>('/v1/machines').then(data => { if (!cancelled) { setMachines(data.machines); setError(''); } }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    void refresh(); const timer = setInterval(() => void refresh(), 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  function add() { setFormError(''); setDraft({ name: '', runner: createRpcRunnerConfig(), target: null, enabled: true }); }
  async function edit(id: string) {
    try {
      const { machine } = await request<{ machine: ExecutionMachineDetails }>(`/v1/machines/${id}/configuration`);
      setFormError(''); setDraft({ id, revision: machine.revision, name: machine.name, runner: machine.runner, target: machine.target, enabled: machine.enabled });
    } catch (e) { setError((e as Error).message); }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!draft) return;
    setBusy(true); setFormError(''); setChecked(null);
    try {
      await request(`/v1/machines${draft.id ? '/' + draft.id : ''}`, draft.id ? 'PUT' : 'POST', { machine: { name: draft.name, runner: draft.runner, target: draft.target, enabled: draft.enabled, ...(draft.revision === undefined ? {} : { expected_revision: draft.revision }) } });
      setDraft(null); await load();
    } catch (e) { setFormError((e as Error).message); } finally { setBusy(false); }
  }
  async function check(id: string) {
    setChecking(id); setChecked(null); setError('');
    try {
      const { machine } = await request<{ machine: ExecutionMachineSummary }>(`/v1/machines/${id}/check`, 'POST', {});
      setMachines(current => current.map(item => item.machine_id === machine.machine_id ? machine : item));
      setChecked(machine);
    } catch (e) { setError((e as Error).message); } finally { setChecking(''); }
  }
  const setRunner = (key: keyof RpcRunnerConnection, value: string) => setDraft(d => d && ({ ...d, runner: { ...d.runner, [key]: value } }));
  const setTarget = (key: string, value: unknown) => setDraft(d => d?.target ? { ...d, target: { ...d.target, [key]: value } as TargetConfig } : d);
  return <>
    <div className="page-heading"><div><h1>执行机器</h1><p>维护者注册一次，项目直接选择。机器状态与硬件来自真实 Runner 检测。</p></div><button className="primary" onClick={add}><Icon name="plus" size={17} />注册执行机器</button></div>
    {error && <Feedback text={error} bad />}
    {loading ? <p className="loading" role="status">正在读取执行机器…</p> : !machines.length ? <Panel title="共享执行资源"><Empty title="注册第一台执行机器" description="登记已部署 Runner 的连接信息，并准备源码传输环境，供所有项目复用。" action={<button className="primary" onClick={add}>注册第一台机器</button>} /></Panel> : <div className="machine-grid">{machines.map(machine => <Panel key={machine.machine_id} title={machine.name} className="machine-card" aside={<MachineStatus machine={machine} />}><MachineFacts machine={machine} />{checking === machine.machine_id && <p className="hint" role="status">正在连接 Runner 并读取硬件信息…</p>}{checked?.machine_id === machine.machine_id && <MachineCheckFeedback machine={checked} />}<div className="form-actions"><button disabled={!!checking || !machine.enabled} aria-busy={checking === machine.machine_id} onClick={() => void check(machine.machine_id)}>{checking === machine.machine_id ? '正在检测…' : '检测连接'}</button><button disabled={checking === machine.machine_id} onClick={() => void edit(machine.machine_id)}>编辑机器</button></div></Panel>)}</div>}
    {draft && <Modal title={draft.id ? '编辑执行机器' : '注册执行机器'} wide onClose={() => { if (!busy) setDraft(null); }}><form onSubmit={e => void save(e)}><fieldset disabled={busy} className="config-fields">
      <div className="machine-form-grid"><Field label="机器名称"><input required value={draft.name} onChange={e => setDraft(d => d && ({ ...d, name: e.target.value }))} placeholder="例如 飞腾 S5000C · 开发机" /></Field><Field label="Runner RPC 地址"><input required value={draft.runner.endpoint} onChange={e => setRunner('endpoint', e.target.value)} placeholder="http://目标机器地址:4327" /></Field><Field label="Runner Token" help="配置一次，由服务器保存；支持 ${ENV_VAR} 引用。"><input type="password" required autoComplete="off" value={draft.runner.token} onChange={e => setRunner('token', e.target.value)} /></Field><label className="checkbox"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft(d => d && ({ ...d, enabled: e.target.checked }))} />允许项目使用这台机器</label></div>
      <details className="machine-deployment" open={!!draft.target}><summary>部署环境（维护者配置）</summary><p className="hint">当前版本通过 SSH/scp 传输源码和验证资产。登记与 Runner 同机的传输环境，项目无需重复配置。工作目录需位于 Runner 启动时授权的 workspace 内。</p><label className="checkbox"><input type="checkbox" checked={!!draft.target} onChange={e => setDraft(d => d && ({ ...d, target: e.target.checked ? { ssh_alias: '', workspace_root: '' } : null }))} />登记源码传输环境</label>{draft.target && <div className="machine-form-grid"><Field label="部署连接方式"><select value={'ssh_alias' in draft.target ? 'alias' : 'direct'} onChange={e => setDraft(d => d?.target ? { ...d, target: e.target.value === 'alias' ? { ssh_alias: '', workspace_root: d.target.workspace_root } : { host: '', username: '', port: 22, workspace_root: d.target.workspace_root } } : d)}><option value="alias">服务端 SSH Alias</option><option value="direct">主机与用户</option></select></Field>{'ssh_alias' in draft.target ? <Field label="部署 SSH Alias"><input required value={draft.target.ssh_alias} onChange={e => setTarget('ssh_alias', e.target.value)} /></Field> : <><Field label="部署主机"><input required value={draft.target.host} onChange={e => setTarget('host', e.target.value)} /></Field><Field label="部署用户"><input required value={draft.target.username} onChange={e => setTarget('username', e.target.value)} /></Field><Field label="部署 SSH 端口"><input type="number" min="1" max="65535" value={draft.target.port} onChange={e => setTarget('port', Number(e.target.value))} /></Field><Field label="服务端私钥路径（可选）"><input value={draft.target.identity_file ?? ''} onChange={e => setTarget('identity_file', e.target.value || undefined)} /></Field></>}<Field label="Runner 工作目录"><input required value={draft.target.workspace_root} onChange={e => setTarget('workspace_root', e.target.value)} placeholder="Runner 授权的 workspace 内绝对路径" /></Field></div>}</details>
      {formError && <Feedback text={formError} bad />}<div className="form-actions"><button type="button" onClick={() => setDraft(null)}>取消</button><button type="submit" className="primary">{busy ? '正在保存并检测…' : '保存并检测'}</button></div>
    </fieldset></form></Modal>}
  </>;
}
