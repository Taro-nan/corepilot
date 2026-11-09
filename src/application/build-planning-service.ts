import path from 'node:path';
import type { OptimizationConfig } from '../config/optimization-config.js';
import { loadOptimizationConfig, resolveRunnerConfig } from '../config/optimization-config.js';
import { isRegisteredRunner } from '../config/runner-config.js';
import { commandBuild, displayBuildCommand } from '../config/build-command.js';
import type { ProjectRecord } from '../contracts/project.js';
import type { ProjectBuildOptions, RunnerToolchain, StoredBuildFact } from '../contracts/build-planning.js';
import type { ProjectSourceDiscovery } from '../contracts/project-setup.js';
import type { TaskStore } from '../storage/task-store.js';
import { RunnerClient, RunnerClientError } from '../client/runner-client.js';
import { ExecutionMachineService } from './execution-machine-service.js';
import { ProjectSetupService } from './project-setup-service.js';

function safeCommand(value: string): string {
  return value.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,"'}]+/gi, '$1[redacted]');
}

function recentBuild(fact: StoredBuildFact | null): ProjectBuildOptions['recent'] {
  if (!fact) return null;
  const { workflow, task, execution } = fact;
  const stored = task.target.scope.build;
  const usable = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Partial<OptimizationConfig['build']> : null;
  const complete = usable && typeof usable.executable === 'string' && Array.isArray(usable.args)
    && usable.args.every(arg => typeof arg === 'string') && typeof usable.cwd === 'string'
    && !path.isAbsolute(usable.cwd) && !usable.cwd.split(/[\\/]/).includes('..')
    && typeof usable.timeout_ms === 'number' && usable.environment && Object.keys(usable.environment).length === 0
    && usable.executable === execution.command && JSON.stringify(usable.args) === JSON.stringify(execution.args);
  const actual = displayBuildCommand({ executable: execution.command, args: execution.args, cwd: '.', environment: {}, timeout_ms: execution.timeout_ms });
  const command = safeCommand(actual);
  const reusable = complete && command === actual ? structuredClone(usable) : null;
  return { command, build: reusable, status: execution.cancelled ? 'CANCELLED' : execution.timed_out ? 'TIMED_OUT'
    : execution.exit_code === 0 ? 'SUCCEEDED' : 'FAILED', executed_at: execution.end_time,
    workflow_id: workflow.workflow_id, experiment_id: execution.experiment_id, command_execution_id: execution.command_execution_id,
    machine_name: workflow.execution_machine?.name ?? null, source_commit: workflow.baseline_commit ?? null };
}

function available(toolchain: RunnerToolchain, name: string): boolean { return toolchain.tools[name]?.status === 'AVAILABLE'; }
function version(value: string | null): number[] | null {
  const match = value?.match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}
function versionAtLeast(actual: string | null, minimum: string): boolean {
  const found = version(actual), required = minimum.split('.').map(Number);
  if (!found) return false;
  for (let index = 0; index < 3; index++) {
    if (found[index] > (required[index] ?? 0)) return true;
    if (found[index] < (required[index] ?? 0)) return false;
  }
  return true;
}
function parallelJobs(machine: RunnerToolchain): number {
  const cpu = Math.max(1, Math.min(machine.available_parallelism || 1, machine.cpu_count || 1));
  const memory = Math.max(1, Math.floor(machine.memory_total_bytes / (2 * 1024 ** 3)));
  return Math.min(cpu, memory);
}

export function recommendBuild(discovery: ProjectSourceDiscovery, toolchain: RunnerToolchain, machine: { machine_id: string; revision: number; name: string }): ProjectBuildOptions['recommended'] {
  const requirements = discovery.build_requirements;
  if (!requirements || toolchain.platform !== 'linux') return null;
  const root = requirements.root_builds;
  const kind = ['cmake', 'meson', 'make', 'configure', 'cargo', 'go', 'ninja'].find(item => root.some(build => build.kind === item));
  if (!kind) return null;
  const jobs = parallelJobs(toolchain);
  const reasons = [`源码根目录：${root.find(build => build.kind === kind)!.path}`, `执行机器：${machine.name} / ${toolchain.architecture} / ${toolchain.cpu_count} CPU，使用 ${jobs} 个并行构建任务`];
  let command = '';
  if (kind === 'cmake') {
    if (!available(toolchain, 'cmake') || (requirements.cmake_minimum && !versionAtLeast(toolchain.tools.cmake?.version ?? null, requirements.cmake_minimum))) return null;
    const cxx = available(toolchain, 'g++') ? 'g++' : available(toolchain, 'clang++') ? 'clang++' : '';
    const cc = available(toolchain, 'gcc') ? 'gcc' : available(toolchain, 'clang') ? 'clang' : '';
    if ((!cc && !cxx) || (discovery.languages.includes('C') && !cc) || (discovery.languages.includes('C++') && !cxx)) return null;
    const generator = available(toolchain, 'ninja') ? 'Ninja' : available(toolchain, 'make') ? 'Unix Makefiles' : '';
    if (!generator) return null;
    const flags = [`-G '${generator}'`, '-DCMAKE_BUILD_TYPE=Release', ...(cc ? [`-DCMAKE_C_COMPILER=${cc}`] : []), ...(cxx ? [`-DCMAKE_CXX_COMPILER=${cxx}`] : []),
      ...(requirements.cxx_standard ? [`-DCMAKE_CXX_STANDARD=${requirements.cxx_standard}`] : []), ...(requirements.openmp_option ? [`-D${requirements.openmp_option}=ON`] : [])];
    command = `cmake -S . -B .corepilot-build ${flags.join(' ')}\ncmake --build .corepilot-build --parallel ${jobs}`;
    reasons.push(`目标机 CMake：${toolchain.tools.cmake.version ?? '版本未知'}；生成器：${generator}`);
    if (requirements.cxx_standard) reasons.push(`源码要求 C++${requirements.cxx_standard}`);
    if (requirements.openmp_option) reasons.push(`源码声明 OpenMP 选项 ${requirements.openmp_option}；可用性仍需实际构建验证`);
  } else if (kind === 'meson') {
    if (!available(toolchain, 'meson') || !available(toolchain, 'ninja') || (!available(toolchain, 'gcc') && !available(toolchain, 'clang'))) return null;
    command = `meson setup .corepilot-build --buildtype release\nmeson compile -C .corepilot-build -j ${jobs}`;
  } else if (kind === 'make') {
    if (!available(toolchain, 'make') || (!available(toolchain, 'gcc') && !available(toolchain, 'clang'))) return null;
    command = `make -j ${jobs}`;
  } else if (kind === 'configure') {
    if (!available(toolchain, 'bash') || !available(toolchain, 'make') || (!available(toolchain, 'gcc') && !available(toolchain, 'clang'))) return null;
    command = `./configure\nmake -j ${jobs}`;
  } else if (kind === 'cargo') {
    if (!available(toolchain, 'cargo') || !available(toolchain, 'rustc')) return null;
    command = 'cargo build --release';
  } else if (kind === 'go') {
    if (!available(toolchain, 'go')) return null;
    command = 'go build ./...';
  } else if (kind === 'ninja') {
    if (!available(toolchain, 'ninja')) return null;
    command = `ninja -j ${jobs}`;
  }
  if (!command) return null;
  const build = commandBuild(command, { executable: '', args: [], cwd: '.', environment: {}, timeout_ms: 600000 });
  return { command, build, machine_id: machine.machine_id, machine_revision: machine.revision, machine_name: machine.name,
    toolchain, inspected_at: discovery.inspected_at, source_commit: discovery.repository.git_commit, reasons, evidence: requirements.evidence,
    status: 'NOT_BUILT' };
}

/** The same read-only build planning use case serves CLI and web. */
export class BuildPlanningService {
  constructor(private readonly store: TaskStore, private readonly machines: ExecutionMachineService, private readonly setup: ProjectSetupService) {}

  async options(project: ProjectRecord, machineId?: string): Promise<ProjectBuildOptions> {
    const recent = recentBuild(this.store.latestBuildForRepository(project.repository_root));
    const runner = loadOptimizationConfig(project.config_path).config.runner;
    const selectedId = machineId ?? (isRegisteredRunner(runner) ? runner.machine_id : undefined);
    if (!selectedId) return { recent, recommended: null, message: '先在“模型与机器”中选择已注册的执行机器，才能结合真实工具链推荐。' };
    const discovery = this.setup.discovery(project);
    if (!discovery) return { recent, recommended: null, message: '先识别当前源码，再读取执行机器的工具链生成推荐。' };
    if (!discovery.build_requirements) return { recent, recommended: null, message: '源码调查记录需要更新，请点击“重新识别源码”。' };
    try {
      const machine = this.machines.resolve(selectedId);
      const connection = resolveRunnerConfig({ runner: machine.runner });
      if (connection.mode !== 'rpc') return { recent, recommended: null, message: '所选执行机器没有可用的 Runner RPC 配置。' };
      const client = new RunnerClient({ baseUrl: connection.endpoint, token: connection.token, requestTimeoutMs: connection.requestTimeoutMs });
      const facts = await client.probe();
      const toolchain = await client.toolchain();
      if (toolchain.runner_id !== facts.health.runner_id || toolchain.architecture !== facts.machine.architecture) throw new Error('Runner 工具链与机器身份不一致，请重新检测机器。');
      const recommended = recommendBuild(discovery, toolchain, machine.identity);
      return { recent, recommended, message: recommended ? null : '当前源码根目录的构建方式与目标机工具链无法匹配；请核对源码证据、机器上的编译工具，或使用自定义构建。' };
    } catch (error) {
      const message = error instanceof RunnerClientError && error.status === 404 ? 'Runner 版本较旧，缺少工具链查询接口；请由维护者更新 Runner。'
        : error instanceof RunnerClientError && error.code === 'CONNECTION_FAILED' ? '无法连接所选机器的 Runner，请先检测机器连接。'
        : error instanceof RunnerClientError && error.code === 'REQUEST_TIMEOUT' ? '读取所选机器工具链超时，请检查 Runner 连接。'
        : (error as Error).message;
      return { recent, recommended: null, message };
    }
  }
}
