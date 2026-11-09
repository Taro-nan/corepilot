import React, { useEffect, useState } from 'react';
import type { ProjectRecord, RepositoryInspection } from '../../../src/contracts/project';
import type { TestingAsset, TestingPlanPreview } from '../../../src/contracts/testing';
import type { OptimizationConfig } from '../../../src/config/optimization-config';
import { displayBuildCommand } from '../../../src/config/build-command';
import { api } from '../api';
import { CopyValue, Disclosure, Feedback, Field } from '../components';
import { SourceBranchSelect } from '../SourceProject';
import type { SubjectDraft } from './testing-draft';

export function TestingSubjectPicker({ title, value, change, projects, assets, plan, upload }: {
  title: string; value: SubjectDraft; change: (value: SubjectDraft) => void; projects: ProjectRecord[]; assets: TestingAsset[];
  plan: TestingPlanPreview | null; upload: () => void;
}) {
  const [repository, setRepository] = useState<RepositoryInspection | null>(null);
  const [config, setConfig] = useState<OptimizationConfig | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const project = projects.find(item => item.project_id === value.projectId);
  const asset = assets.find(item => item.asset_id === value.assetId);
  const update = (patch: Partial<SubjectDraft>) => change({ ...value, ...patch });
  const resolvedBuild = config && plan ? { command: config.build.executable ? displayBuildCommand(config.build) : plan.build.command,
    cwd: config.build.executable ? config.build.cwd : plan.build.cwd, artifact: plan.build.artifact } : null;
  useEffect(() => {
    if (value.kind !== 'source' || !project) return;
    let active = true; setRepository(null); setConfig(null); setError('');
    Promise.all([api.inspectRepository(project.repository_root), api.projectAction(project.project_id, 'config') as Promise<{ config: OptimizationConfig }>])
      .then(([repository, result]) => { if (active) { setRepository(repository); setConfig(result.config); } }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [project?.repository_root, value.kind, retry]);
  useEffect(() => {
    if (value.kind !== 'source') return;
    const branch = value.branch || project?.source_branch || repository?.current_branch || repository?.branches[0]?.name || '';
    const buildChanged = !!resolvedBuild && JSON.stringify(resolvedBuild) !== JSON.stringify(value.resolvedBuild);
    if (branch !== value.branch || buildChanged) update({ branch, ...(resolvedBuild ? { resolvedBuild } : {}) });
  }, [repository, config, plan?.evaluator.digest, value.kind, value.branch]);
  return <fieldset className="testing-subject"><legend>{title}</legend>
    <div className="segmented" aria-label={`${title}类型`}>
      <button type="button" aria-pressed={value.kind === 'source'} onClick={() => update({ kind: 'source' })}>源码分支</button>
      <button type="button" aria-pressed={value.kind === 'binary'} onClick={() => update({ kind: 'binary' })}>上传库包</button>
    </div>
    {value.kind === 'source' ? <>
      <Field label="源码项目"><select required value={value.projectId} onChange={event => update({ projectId: event.target.value, branch: '', commit: '', resolvedBuild: undefined })}>
        <option value="" disabled>选择源码项目</option>{projects.map(item => <option key={item.project_id} value={item.project_id}>{item.name}</option>)}
      </select></Field>
      {!projects.length && <p className="hint">还没有源码项目。可以切换为上传库包，或先在项目入口添加源码。</p>}
      {repository && <SourceBranchSelect repository={repository} value={value.branch} compact label="测试分支" onChange={branch => update({ branch, commit: '' })} />}
      {project && !repository && !error && <p role="status" className="hint">正在读取本地分支…</p>}
      {error && <><Feedback text={error} bad /><button type="button" onClick={() => setRetry(current => current + 1)}>重新读取分支</button></>}
      {value.commit && <div className="notice compact testing-pinned"><strong>固定优化候选</strong><p>本次测试使用候选提交，后续分支变化不会改变它。</p><CopyValue value={value.commit} label="候选提交" /></div>}
      <Disclosure title="构建设置" summary={value.overrideBuild ? '本次自定义构建' : resolvedBuild?.command ?? '读取项目构建设置…'} modified={value.overrideBuild}>
        <label className="checkbox"><input type="checkbox" checked={value.overrideBuild} onChange={event => update({ overrideBuild: event.target.checked,
          command: value.command || resolvedBuild?.command || '', cwd: value.cwd === '.' ? resolvedBuild?.cwd || '.' : value.cwd,
          artifact: value.artifact || resolvedBuild?.artifact || '' })} />自定义本次构建</label>
        {value.overrideBuild ? <><Field label="构建命令"><textarea required rows={3} value={value.command} onChange={event => update({ command: event.target.value })} /></Field>
          <Field label="构建工作目录"><input required value={value.cwd} onChange={event => update({ cwd: event.target.value })} placeholder="源码内相对路径" /></Field>
          <Field label="产物相对路径"><input value={value.artifact} onChange={event => update({ artifact: event.target.value })} placeholder="例如：build/libkernel.so" /></Field></>
          : <p className="hint">{resolvedBuild ? `${resolvedBuild.command} · 工作目录 ${resolvedBuild.cwd} · 产物 ${resolvedBuild.artifact}` : '选择测试方案后可查看构建命令与产物路径。'}</p>}
      </Disclosure>
    </> : <>
      <Field label="测试库包"><select required value={value.assetId} onChange={event => update({ assetId: event.target.value })}>
        <option value="" disabled>选择已固定的库包</option>{assets.filter(item => item.state === 'READY').map(item => <option key={item.asset_id} value={item.asset_id}>{item.name} · {item.version || '未指定版本'}</option>)}
      </select></Field>
      <button type="button" className="text-btn" onClick={upload}>上传新的库包</button>
      {asset && <div className="testing-asset-note"><strong>{asset.entry_path}</strong><span>{asset.files.length} 个文件 · 已固定版本</span></div>}
    </>}
  </fieldset>;
}
