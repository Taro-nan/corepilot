import type { TestingSubject } from '../../../src/contracts/testing';

export interface SubjectDraft {
  kind: 'source' | 'binary';
  projectId: string;
  branch: string;
  commit: string;
  assetId: string;
  overrideBuild: boolean;
  command: string;
  cwd: string;
  artifact: string;
  resolvedBuild?: { command: string; cwd: string; artifact: string };
}

export const emptySubject = (projectId = ''): SubjectDraft => ({ kind: projectId ? 'source' : 'binary', projectId, branch: '', commit: '', assetId: '',
  overrideBuild: false, command: '', cwd: '.', artifact: '' });

export function testingSubject(draft: SubjectDraft): TestingSubject {
  if (draft.kind === 'binary') {
    if (!draft.assetId) throw new Error('请选择已上传的库包。');
    return { kind: 'binary', asset_id: draft.assetId };
  }
  if (!draft.projectId || !draft.branch) throw new Error('请选择源码项目与分支。');
  if (draft.overrideBuild && !draft.command.trim()) throw new Error('请填写本次构建命令，或关闭自定义构建。');
  const build = draft.overrideBuild ? { command: draft.command.trim(), cwd: draft.cwd.trim() || '.', artifact: draft.artifact.trim() } : draft.resolvedBuild;
  if (!build?.command) throw new Error('请等待读取构建设置，或填写本次构建命令。');
  return { kind: 'source', project_id: draft.projectId, branch: draft.branch, ...(draft.commit ? { commit: draft.commit } : {}),
    build: { command: build.command, cwd: build.cwd }, ...(build.artifact ? { artifact: build.artifact } : {}) };
}

export function subjectCaption(subject: TestingSubject) {
  return subject.kind === 'source' ? `源码 · ${subject.branch}${subject.commit ? ' · 固定候选' : ''}` : '上传库包';
}

export const testingActive = (status: string) => ['PREPARING', 'PENDING', 'RUNNING', 'UNKNOWN'].includes(status);

export function testingPhaseLabel(phase: string): string {
  return ({ SNAPSHOTTING: '固定测试方案', FREEZING_SOURCE: '固定源码版本', CHECKING_MACHINE: '检查执行机器', STAGING_SUBJECTS: '准备两端库文件',
    STAGING_TESTS: '准备测试代码', SUBMITTING: '提交测试计划', SUBMITTED: '等待 Runner 执行', BUILD: '构建源码', EVALUATOR_SETUP: '构建测试程序',
    CORRECTNESS: '运行正确性测试', PERFORMANCE: '采集性能样本', SUCCEEDED: '执行完成', FAILED: '执行失败', UNKNOWN: '核对原作业状态',
    CANCELLED: '已确认停止', PENDING: '等待执行', RUNNING: '正在执行' } as Record<string, string>)[phase] ?? '正在准备测试';
}
