import React, { useCallback, useEffect, useState } from 'react';
import type { ProjectRecord } from '../../../src/contracts/project';
import type { TestingTaskDetails, TestingTaskRecord } from '../../../src/contracts/testing';
import type { CandidateTestingContext } from '../SourceOptimizationWorkbench';
import { api } from '../api';
import { Badge, Empty, Feedback, Icon, Modal, Panel, time } from '../components';
import { TestingComposer } from './TestingComposer';
import { TestingResult } from './TestingResult';
import { subjectCaption } from './testing-draft';
import { useTestingOptions } from './useTestingOptions';

export function TestingWorkspace({ taskId, projects, projectId, navigate, prepare, notify, optimize }: {
  taskId: string; projects: ProjectRecord[]; projectId?: string;
  navigate: (id?: string) => void; prepare: (projectId: string, functionName: string) => void;
  notify: (text: string, bad?: boolean) => void; optimize: (projectId: string, branch: string, functionName: string) => void;
}) {
  const [tasks, setTasks] = useState<TestingTaskRecord[]>([]);
  const options = useTestingOptions(taskId === 'new');
  const [details, setDetails] = useState<TestingTaskDetails | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  useEffect(() => {
    let active = true; let pending = false;
    async function read() {
      if (pending) return;
      pending = true;
      try {
        const [list, result] = await Promise.all([api.testing.list(),
          taskId && taskId !== 'new' ? api.testing.get(taskId) : Promise.resolve(null)]);
        if (!active) return;
        setTasks(list.tasks); setDetails(result); setLocalNotice(list.observation?.message ?? ''); setError(''); setLoaded(true);
      } catch (failure) { if (active) { setError((failure as Error).message); setLoaded(true); } }
      finally { pending = false; }
    }
    setDetails(null); void read();
    const timer = setInterval(() => void read(), 2500);
    return () => { active = false; clearInterval(timer); };
  }, [taskId, retry]);
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const candidateContext: CandidateTestingContext | undefined = params.get('commit') && params.get('project') ? {
    projectId: params.get('project')!, branch: params.get('branch') ?? '', commit: params.get('commit')!, functionName: params.get('function') ?? '' } : undefined;
  const shown = tasks.filter(task => (status === 'all' || task.execution.status === status) && `${task.name} ${task.plan.function_name}`.toLowerCase().includes(search.toLowerCase()));
  if (taskId && taskId !== 'new') return <>
    {error && <><Feedback text={error} bad /><button onClick={refresh}>重新读取任务</button></>}
    {details ? <TestingResult details={details} back={() => navigate()} refresh={refresh} notify={notify} optimize={optimize} />
      : <Empty title={error ? '测试任务暂时无法打开' : '正在读取测试任务…'} description={error ? '已有记录保留在服务器。请检查连接并重新读取。' : '正在查询原作业的进度和结果。'} action={<button onClick={() => navigate()}>返回测试任务</button>} />}
  </>;
  return <>
    <div className="page-heading"><div><h1>测试任务</h1><p>比较源码或库包，独立查看正确性与性能。</p></div><button className="primary" onClick={() => navigate('new')}><Icon name="plus" size={17} />创建测试任务</button></div>
    {localNotice && <p className="notice compact" role="status">{localNotice}</p>}
    {error && <><Feedback text={error} bad /><button onClick={refresh}>重新读取</button></>}
    {!loaded ? <p role="status" className="loading">正在读取测试任务…</p> : !tasks.length ? <Empty title="直接测试，不必先优化" description="选择源码分支或上传库包，复用测试方案，在同一机器上比较。无需调用模型。" />
      : <Panel title="独立测试" aside={<div className="workflow-filters"><label className="search"><Icon name="search" size={16} /><input aria-label="搜索测试任务" placeholder="搜索函数或任务名称" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <select aria-label="筛选测试状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="PREPARING">准备中</option><option value="PENDING">等待执行</option><option value="RUNNING">运行中</option><option value="SUCCEEDED">执行完成</option><option value="FAILED">执行失败</option><option value="UNKNOWN">待核对</option><option value="CANCELLED">已取消</option></select></div>}>
        <div className="table-scroll"><table><thead><tr><th>测试目标</th><th>比较对象</th><th>执行机器</th><th>执行状态</th><th>更新时间</th><th /></tr></thead><tbody>{shown.map(task => <tr key={task.task_id}>
          <td><strong>{task.name}</strong><small>{task.plan.function_name}</small></td><td>{subjectCaption(task.input.candidate)}<small>{task.input.baseline ? '对比 ' + subjectCaption(task.input.baseline) : '独立正确性测试'}</small></td>
          <td>{task.machine.name}</td><td><Badge value={task.execution.status} /></td><td>{time(task.updated_at)}</td><td><button className="text-btn" onClick={() => navigate(task.task_id)}>查看任务<Icon name="arrow" size={15} /></button></td>
        </tr>)}</tbody></table>{!shown.length && <p className="center muted">没有匹配的测试，请调整筛选。</p>}</div>
      </Panel>}
    {taskId === 'new' && (options.data ? <TestingComposer projects={projects} projectId={candidateContext?.projectId ?? params.get('draft_project') ?? params.get('project') ?? projectId} candidateContext={candidateContext} catalog={options.data.catalog} machines={options.data.machines} assets={options.data.assets}
      close={() => navigate()} created={id => { navigate(id); notify('测试已提交，关闭页面后后台继续执行。'); }}
      assetAdded={options.addAsset} prepare={prepare} /> : <Modal title="创建测试任务" onClose={() => navigate()}>
        {options.error ? <><Feedback text={'创建条件暂时无法读取：' + options.error} bad /><button onClick={options.retry}>重新读取创建条件</button></>
          : <p role="status">正在读取执行机器、库包与测试方案…</p>}
      </Modal>)}
  </>;
}
