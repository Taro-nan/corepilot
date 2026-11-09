import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectRecord } from '../contracts/project.js';
import type { ProjectSetup, ProjectSourceDiscovery, SetupCheck } from '../contracts/project-setup.js';
import type { OptimizationConfig } from '../config/optimization-config.js';
import { inspectInBackground } from '../onboarding/inspect-in-background.js';
import { LibraryPackageLoader } from '../library-package/loader.js';
import { loadValidationTestpack } from '../testpack/validation-yaml.js';
import { packageBaselineBinding } from '../library-package/task-definition.js';

/** Project-specific discovery and input assessment, with no model or command execution. */
export class ProjectSetupService {
  constructor(private readonly dataDir: string) {}
  private discoveryPath(project: ProjectRecord) { return path.join(this.dataDir, 'projects', project.project_id, 'source-discovery.json'); }
  discovery(project: ProjectRecord): ProjectSourceDiscovery | null {
    const filename = this.discoveryPath(project);
    return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) as ProjectSourceDiscovery : null;
  }

  async inspect(project: ProjectRecord): Promise<ProjectSourceDiscovery> {
    const inspection = await inspectInBackground(project.repository_root);
    const discovery: ProjectSourceDiscovery = { schema_version: 1, inspected_at: new Date().toISOString(), repository: inspection.repository,
      file_count: inspection.files.length, languages: inspection.languages, builds: inspection.build_candidates, build_requirements: inspection.build_requirements, functions: inspection.functions,
      tests: inspection.tests, benchmarks: inspection.benchmarks, references: inspection.references, unknowns: inspection.unknowns };
    const filename = this.discoveryPath(project);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(discovery, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, filename);
    return discovery;
  }

  async status(project: ProjectRecord, config: OptimizationConfig): Promise<ProjectSetup> {
    const discovery = this.discovery(project);
    const checks: SetupCheck[] = [];
    let validation: ProjectSetup['validation'] = null;
    const add = (id: SetupCheck['id'], title: string, state: SetupCheck['state'], message: string) => checks.push({ id, title, state, message });
    if (config.validation.library_package) {
      try {
        const loader = new LibraryPackageLoader({ catalogRoot: path.join(this.dataDir, 'catalog') });
        const resolved = loader.resolveSelection(config.validation.library_package);
        const bundle = resolved.bundle;
        validation = { function_name: resolved.functionDefinition.api, correctness_cases: bundle.correctness.cases.length,
          performance_workloads: bundle.workloads.workloads.length, evaluator_status: bundle.qualification.status };
        const reviewed = bundle.qualification.status === 'QUALIFIED';
        const buildConfigured = !!resolved.build.executable && resolved.build.executable !== 'false';
        add('build', '编译项目', buildConfigured ? 'CONFIGURED' : 'MISSING', buildConfigured ? '接入方案提供构建命令；是否能编译成功仍需在目标机实际执行。' : '接入草稿还没有可用的构建命令。');
        add('correctness', '正确性测试', reviewed ? 'CONFIGURED' : 'NEEDS_REVIEW', `${validation.correctness_cases} 个用例；${reviewed ? '使用已获资格的独立测试。' : '草稿用例和独立参考结果尚需审阅与目标机验证。'}`);
        add('performance', '性能测量', reviewed ? 'CONFIGURED' : 'NEEDS_REVIEW', `${validation.performance_workloads} 个负载；${reviewed ? '采样规则由接入方案提供。' : '负载、计时、单位和采样规则尚需验证。'}`);
        add('evaluator', '验证方案资格', reviewed && ['REVIEWED', 'QUALIFIED'].includes(resolved.loaded.manifest.qualification.state) ? 'CONFIGURED' : 'NEEDS_REVIEW', `接入方案审阅状态：${resolved.loaded.manifest.qualification.state}；当前函数测试方案：${bundle.qualification.status}。`);
        const binding = packageBaselineBinding(resolved, config.validation.baseline_artifact ?? '');
        await this.baseline(config.validation.baseline_artifact, binding.artifactDigest, add);
      } catch (error) {
        add('evaluator', '验证方案', 'INVALID', (error as Error).message);
      }
    } else {
      add('build', '编译项目', config.build.executable.trim() ? 'CONFIGURED' : 'MISSING', config.build.executable.trim() ? '已填写构建命令；尚不表示目标机编译成功。' : '识别源码中的构建方式，或填写该库实际使用的构建命令。');
      if (config.validation.testpack.trim()) {
        try {
          const loaded = loadValidationTestpack(config.validation.testpack);
          const testpack = loaded.testpack;
          validation = { function_name: testpack.function_name, correctness_cases: testpack.correctness.cases.length,
            performance_workloads: testpack.performance.cases.length, evaluator_status: testpack.evaluator ? 'REQUIRES_QUALIFICATION_CHECK' : 'LEGACY' };
          add('correctness', '正确性测试', 'CONFIGURED', `${validation.correctness_cases} 个用例，目标：${validation.function_name}。`);
          add('performance', '性能测量', 'CONFIGURED', `${validation.performance_workloads} 个负载，单位与采样规则来自测试方案。`);
          add('evaluator', '独立验证方案', 'NEEDS_REVIEW', testpack.evaluator ? '已声明独立 evaluator；正式运行前还要核验内容与资格。' : '这是兼容测试方案；正式 RPC 运行仍需要独立且合格的 evaluator。');
          await this.baseline(testpack.performance.baselines.comparison.path, testpack.performance.baselines.comparison.sha256, add);
        } catch (error) { add('correctness', '测试方案', 'INVALID', (error as Error).message); }
      } else {
        add('correctness', '正确性测试', 'MISSING', '接入本库的测试命令、独立参考结果与通过标准；发现测试文件不等于已经接线。');
        add('performance', '性能测量', 'MISSING', '接入本库的 benchmark、输入负载、计量单位、采样次数与收益目标。');
        add('baseline', '比较基线', 'MISSING', '准备优化前的库产物，或经过确认的参考实现；不能用历史速度数字代替新的测量。');
        add('evaluator', '独立验证方案', 'MISSING', '为当前库生成接入草稿，审阅并补齐验证资产，或导入本库已有方案。');
      }
    }
    return { discovery, checks, validation, next_steps: checks.filter(check => check.state !== 'CONFIGURED').map(check => check.message) };
  }

  private async baseline(filename: string | undefined, expected: string, add: (id: SetupCheck['id'], title: string, state: SetupCheck['state'], message: string) => void) {
    if (!filename?.trim()) { add('baseline', '比较基线', 'MISSING', '填写运行 CorePilot 的服务器能够读取的基线产物路径。'); return; }
    if (/^0+$/.test(expected)) { add('baseline', '比较基线', 'NEEDS_REVIEW', '方案尚未冻结基线身份，请先核对原始产物、构建条件并记录真实 SHA-256。'); return; }
    try {
      if (!fs.statSync(filename).isFile()) throw new Error('基线路径必须指向文件。');
      const digest = createHash('sha256');
      for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
      const matches = digest.digest('hex') === expected.toLowerCase();
      add('baseline', '比较基线', matches ? 'CONFIGURED' : 'INVALID', matches ? '基线文件存在，内容与验证方案记录的身份一致。' : '基线文件与验证方案的 SHA-256 不一致，请核对版本与构建条件。');
    } catch (error) { add('baseline', '比较基线', 'INVALID', (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? '找不到基线产物，请确认文件存在于运行 CorePilot 的服务器上。' : `无法读取基线产物：${(error as Error).message}`); }
  }
}
