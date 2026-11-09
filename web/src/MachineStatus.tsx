import React from 'react';
import type { ExecutionMachineSummary } from '../../src/contracts/execution-machine';
import { Feedback, time } from './components';
import './execution-machines.css';

const names = { ONLINE: '在线', OFFLINE: '离线', UNKNOWN: '待检测', STALE: '状态待刷新', DISABLED: '已停用' };
export function MachineStatus({ machine }: { machine: ExecutionMachineSummary }) {
  return <span className={`machine-status ${machine.status.toLowerCase()}`}><i />{names[machine.status]}</span>;
}
export function MachineCheckFeedback({ machine }: { machine: ExecutionMachineSummary }) {
  const success = machine.status === 'ONLINE';
  const result = success ? '连接成功，Runner RPC 可访问。'
    : machine.status === 'OFFLINE' ? `连接失败：${machine.error ?? 'Runner 未连接，请检查服务与网络。'}`
    : machine.status === 'DISABLED' ? '未执行检测：机器已停用，请先启用机器。'
    : '未获得当前配置的检测结果，请重新检测。';
  return <Feedback text={`${machine.name}：${result}${machine.last_checked_at ? ` 检测时间：${time(machine.last_checked_at)}` : ''}`} bad={!success} />;
}
export function MachineFacts({ machine }: { machine: ExecutionMachineSummary }) {
  return <><dl className="definition"><dt>硬件</dt><dd>{machine.hardware ? `${machine.hardware.architecture} · ${machine.hardware.cpu_count} CPU${machine.hardware.numa_summary ? ` · ${machine.hardware.numa_summary.node_count} NUMA` : ''}` : '检测连接后识别'}</dd><dt>系统</dt><dd>{machine.hardware ? `${machine.hardware.platform} / ${machine.hardware.os}` : '尚未识别'}</dd><dt>部署环境</dt><dd>{machine.setup_complete ? '已登记' : '待维护者准备'}</dd><dt>实验资源</dt><dd>{machine.health?.resource_enforcement === 'REQUIRED' ? '已开启强制资源约束' : machine.health ? '待维护者开启强制资源约束' : '尚未检测'}</dd><dt>最近检测</dt><dd>{time(machine.last_checked_at ?? undefined)}</dd></dl>
    {machine.status !== 'ONLINE' && machine.hardware && <p className="hint">硬件信息来自最近一次成功检测：{time(machine.last_online_at ?? undefined)}。</p>}
    {machine.error && <p className="machine-error">{machine.error}</p>}</>;
}
