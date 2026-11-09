import React, { useEffect, useState } from 'react';
import { isRegisteredRunner, type RunnerConfig } from '../../src/config/runner-config';
import type { ExecutionMachineSummary } from '../../src/contracts/execution-machine';
import { request } from './api';
import { Field, Panel, Feedback, Empty } from './components';
import { MachineCheckFeedback, MachineFacts, MachineStatus } from './MachineStatus';

export function MachinePicker({ runner, onChange, onSave, manage, busy }: { runner?: RunnerConfig; onChange: (runner: RunnerConfig) => void; onSave: () => void; manage: () => void; busy: boolean }) {
  const [machines, setMachines] = useState<ExecutionMachineSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<ExecutionMachineSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => request<{ machines: ExecutionMachineSummary[] }>('/v1/machines').then(data => { if (!cancelled) { setMachines(data.machines); setError(''); } }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    void load(); const timer = setInterval(() => void load(), 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const selectedId = isRegisteredRunner(runner) ? runner.machine_id : '';
  const selected = machines.find(machine => machine.machine_id === selectedId);
  useEffect(() => { setChecked(null); }, [selectedId]);
  async function check() {
    if (!selected) return;
    setChecking(true); setChecked(null); setError('');
    try {
      const { machine } = await request<{ machine: ExecutionMachineSummary }>(`/v1/machines/${selected.machine_id}/check`, 'POST', {});
      setMachines(current => current.map(item => item.machine_id === machine.machine_id ? machine : item));
      setChecked(machine);
    } catch (e) { setError((e as Error).message); } finally { setChecking(false); }
  }
  return <Panel title="执行机器" aside={<span className="muted">已注册的 Runner</span>}>
    <p className="hint">选择维护者已准备的机器。连接信息由系统统一管理，同一台机器可供多个项目使用。</p>
    {error && <Feedback text={error} bad />}
    {loading ? <p className="hint" role="status">正在读取执行机器与连接状态…</p> : !machines.length ? <Empty title="尚未注册执行机器" description="请由维护者先注册 Runner 并准备部署环境，之后可在这里选择。" action={<button type="button" onClick={manage}>管理执行机器</button>} /> : <>
      <div className="form-grid"><Field label="执行机器"><select value={selectedId} disabled={busy || checking} onChange={e => onChange({ mode: 'rpc', machine_id: e.target.value })}>
        <option value="" disabled hidden>选择已注册机器</option>
        {selectedId && !selected && <option value={selectedId}>机器记录不可用</option>}
        {machines.map(machine => <option key={machine.machine_id} value={machine.machine_id} disabled={!machine.enabled}>{machine.name} · {machine.status === 'ONLINE' ? '在线' : machine.status === 'DISABLED' ? '已停用' : machine.status === 'OFFLINE' ? '离线' : '待检测'}{machine.hardware ? ` · ${machine.hardware.architecture} / ${machine.hardware.cpu_count} CPU` : ''}</option>)}
      </select></Field></div>
      {!selectedId && <p className="hint">{runner?.mode === 'legacy' || !runner ? '项目当前保留历史兼容配置。' : !isRegisteredRunner(runner) && runner.endpoint ? '项目当前保留独立 Runner 配置。' : '尚未选择执行机器。'}选择并保存执行机器后，后续任务会使用统一登记的连接信息。</p>}
      {selected && <div className="machine-selection"><div className="machine-card-head"><strong>{selected.name}</strong><MachineStatus machine={selected} /></div><MachineFacts machine={selected} />{checking && <p className="hint" role="status">正在连接 Runner 并读取硬件信息…</p>}{checked?.machine_id === selectedId && <MachineCheckFeedback machine={checked} />}{!selected.setup_complete && <p className="hint">部署环境尚未准备完成，请联系维护者后再开始优化。</p>}</div>}
      <div className="form-actions"><button type="button" disabled={!selected?.enabled || busy || checking} aria-busy={checking} onClick={() => void check()}>{checking ? '正在检测机器…' : '检测所选机器'}</button><button type="button" className="primary" disabled={busy || checking || !selectedId} onClick={onSave}>保存配置</button></div>
    </>}
    {machines.length > 0 && <div className="machine-management-link"><button type="button" className="text-btn" onClick={manage}>维护者：管理执行机器</button></div>}
  </Panel>;
}
