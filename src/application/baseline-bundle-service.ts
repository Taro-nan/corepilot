import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectRecord } from '../contracts/project.js';
import type { BaselineBundleFile, BaselineImportSession as Session, BaselineImportCheck, BaselineImportStatus } from '../contracts/baseline-bundle.js';
import type { BinaryBundleBaselineDefinition } from '../contracts/library-package.js';
import { binaryBundleIdentitySha256 } from '../library-package/loader.js';
import { loadOptimizationConfig, resolveRunnerConfig } from '../config/optimization-config.js';
import { isRegisteredRunner } from '../config/runner-config.js';
import { bundleRelativePath } from '../runner/baseline-bundle-inspector.js';
import { RunnerClient } from '../client/runner-client.js';
import { stageAndInspectBaselineBundle } from '../workspace/baseline-bundle-staging.js';
import type { ExecutionMachineService } from './execution-machine-service.js';
import type { ValidationAssetsService } from './validation-assets-service.js';
import { ApiError } from '../core/api-error.js';

async function fileDigest(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export class BaselineBundleService {
  private readonly finalizing = new Map<string, Promise<unknown>>();
  private readonly uploading = new Set<string>();
  constructor(private readonly dataDir: string, private readonly machines: ExecutionMachineService,
    private readonly assets: ValidationAssetsService,
    private readonly stageAndInspect: typeof stageAndInspectBaselineBundle = stageAndInspectBaselineBundle) {}

  private root(project: ProjectRecord, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid bundle ID');
    return path.join(this.dataDir, 'projects', project.project_id, 'baseline-bundles', id);
  }

  private session(project: ProjectRecord, id: string): Session {
    const session = JSON.parse(fs.readFileSync(path.join(this.root(project, id), 'session.json'), 'utf8')) as Session;
    if (session.project_id !== project.project_id || session.bundle_id !== id) throw new Error('bundle belongs to another project');
    return session;
  }

  create(project: ProjectRecord, input: { packageId: string; version: string; targetId: string; library: string; libraryVersion: string }) {
    const draft = this.assets.get(project, input.packageId, input.version, input.targetId);
    if (draft.qualification !== 'DRAFT') throw new Error('只能向待审阅的项目草稿上传比较基线');
    if (!input.library.trim() || !input.libraryVersion.trim()) throw new Error('请填写比较库名称和版本');
    const bundleId = randomUUID();
    const root = this.root(project, bundleId);
    fs.mkdirSync(path.join(root, 'files'), { recursive: true, mode: 0o700 });
    const session: Session = { schema_version: 1, project_id: project.project_id, bundle_id: bundleId,
      package_id: input.packageId, package_version: input.version, target_id: input.targetId,
      library: input.library.trim(), library_version: input.libraryVersion.trim(), created_at: new Date().toISOString(),
      expected_selection_key: this.assets.baselineSelectionKey(project, input.packageId, input.version, input.targetId) };
    fs.writeFileSync(path.join(root, 'session.json'), JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
    return { bundle_id: bundleId, files: [], entries: [] };
  }

  async upload(project: ProjectRecord, id: string, relativePath: string, chunks: AsyncIterable<Buffer>) {
    this.session(project, id);
    const root = this.root(project, id);
    const key = `${project.project_id}/${id}`;
    if (this.finalizing.has(key) || this.uploading.has(key)) throw new ApiError(409, 'BASELINE_IMPORT_BUSY', '正在处理这次导入，请等待完成后再上传');
    if (fs.existsSync(path.join(root, 'result.json'))) throw new Error('该比较基线已固定，请创建新的上传');
    const relative = bundleRelativePath(relativePath);
    if (!/\.(?:so(?:\.[A-Za-z0-9_.+-]+)?|h|hpp|hh)$/.test(relative)) {
      throw new Error('上传目录只接收 .so 动态库和 .h/.hpp/.hh 头文件；请先解包 RPM/DEB，再选择 include/lib 目录');
    }
    this.uploading.add(key);
    try {
      const before = await this.listFiles(project, id, false);
      if (before.length >= 256) throw new Error('一个比较包最多 256 个文件');
      const existingBytes = before.reduce((sum, file) => sum + file.bytes, 0);
      const filename = path.join(root, 'files', ...relative.split('/'));
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const handle = await fs.promises.open(filename, 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of chunks) {
          bytes += chunk.byteLength;
          if (bytes > 512 * 1024 * 1024 || existingBytes + bytes > 1024 * 1024 * 1024) throw new Error('单文件最多 512 MB，整个比较包最多 1 GB');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
        }
      } catch (error) { await handle.close(); fs.rmSync(filename, { force: true }); throw error; }
      await handle.close();
      if (!bytes) { fs.rmSync(filename); throw new Error('上传文件不能为空'); }
      const uploaded = { path: relative, sha256: hash.digest('hex'), bytes };
      const inventory = [...before, uploaded];
      fs.writeFileSync(path.join(root, 'files.json'), JSON.stringify(inventory, null, 2) + '\n', { mode: 0o600 });
      fs.rmSync(path.join(root, 'inspection.json'), { force: true });
      return uploaded;
    } finally { this.uploading.delete(key); }
  }

  async listFiles(project: ProjectRecord, id: string, hashContent = true): Promise<BaselineBundleFile[]> {
    const root = path.join(this.root(project, id), 'files');
    const inventoryPath = path.join(this.root(project, id), 'files.json');
    const recorded = !hashContent && fs.existsSync(inventoryPath)
      ? new Map((JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as BaselineBundleFile[]).map(file => [file.path, file])) : null;
    const paths: string[] = [];
    function visit(directory: string) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) visit(filename);
        else if (item.isFile()) paths.push(filename);
        else throw new Error(`unsupported bundle file: ${filename}`);
      }
    }
    visit(root);
    const files = await Promise.all(paths.map(async filename => {
      const relative = path.relative(root, filename).split(path.sep).join('/'), bytes = fs.statSync(filename).size;
      const previous = recorded?.get(relative);
      return { path: relative, sha256: hashContent || !previous || previous.bytes !== bytes ? await fileDigest(filename) : previous.sha256, bytes };
    }));
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private readCheck(project: ProjectRecord, id: string): (BaselineImportCheck & { definition?: BinaryBundleBaselineDefinition }) | null {
    const filename = path.join(this.root(project, id), 'inspection.json');
    return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
  }

  private writeCheck(project: ProjectRecord, id: string, check: BaselineImportCheck & { definition?: BinaryBundleBaselineDefinition }) {
    const filename = path.join(this.root(project, id), 'inspection.json');
    fs.writeFileSync(filename + '.tmp', JSON.stringify(check, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(filename + '.tmp', filename);
  }

  async list(project: ProjectRecord, packageId: string, version: string, targetId: string) {
    const root = path.join(this.dataDir, 'projects', project.project_id, 'baseline-bundles');
    if (!fs.existsSync(root)) return [];
    const sessions = fs.readdirSync(root).filter(id => /^[a-f0-9-]{36}$/.test(id)).map(id => this.session(project, id))
      .filter(item => item.package_id === packageId && item.package_version === version && item.target_id === targetId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20);
    return Promise.all(sessions.map(item => this.status(project, item.bundle_id)));
  }

  async status(project: ProjectRecord, id: string): Promise<BaselineImportStatus> {
    const session = this.session(project, id);
    // Browsing reads the upload manifest; checks and binding independently hash actual file contents.
    const files = await this.listFiles(project, id, false);
    const resultPath = path.join(this.root(project, id), 'result.json');
    const stored = this.readCheck(project, id);
    const check: BaselineImportCheck | null = stored ? { entry_path: stored.entry_path, files: stored.files, state: stored.state,
      machine: stored.machine, inspection: stored.inspection, error: stored.error } : null;
    if (check?.state === 'CHECKING' && !this.finalizing.has(`${project.project_id}/${id}`)) {
      check.state = 'NEEDS_RECHECK'; check.error = '检查期间服务中断，请重新检查这份导入';
    }
    if (check?.state === 'READY') {
      try {
        if (JSON.stringify(this.connection(project).identity) !== JSON.stringify(check.machine)) {
          check.state = 'NEEDS_RECHECK'; check.error = '执行机器或连接配置已变化，请重新检查';
        }
      } catch (error) { check.state = 'NEEDS_RECHECK'; check.error = (error as Error).message; }
    }
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
    return { ...session, files, entries: files.filter(file => /\.so(?:\..*)?$/.test(file.path)).map(file => file.path),
      check, state: result ? 'BOUND' : check?.state ?? 'UPLOADING', result };
  }

  private async exclusive<T>(project: ProjectRecord, id: string, action: () => Promise<T>): Promise<T> {
    const key = `${project.project_id}/${id}`;
    const pending = this.finalizing.get(key);
    if (pending) { await pending.catch(() => {}); return this.exclusive(project, id, action); }
    if (this.uploading.has(key)) throw new ApiError(409, 'BASELINE_IMPORT_BUSY', '文件还在上传，请上传完成后再检查或固定');
    const work = action();
    this.finalizing.set(key, work);
    try { return await work; } finally { this.finalizing.delete(key); }
  }

  private connection(project: ProjectRecord) {
    const config = loadOptimizationConfig(project.config_path).config;
    const machineId = isRegisteredRunner(config.runner) ? config.runner.machine_id : null;
    const machine = machineId ? this.machines.resolve(machineId) : null;
    const effective = machine ? { ...config, runner: machine.runner, target: machine.target } : config;
    const runner = resolveRunnerConfig(effective);
    if (runner.mode !== 'rpc') throw new Error('请先选择可用的 Runner RPC 执行机器');
    const connectionKey = createHash('sha256').update(JSON.stringify({ runner, target: effective.target })).digest('hex');
    return { runner, target: effective.target, identity: { id: machineId, revision: machine?.identity.revision ?? null,
      name: machine?.identity.name ?? 'Runner 执行机器', connection_key: connectionKey } };
  }

  /** Inspection never changes the current baseline; both single files and folders use this path. */
  async check(project: ProjectRecord, id: string, entry: string) {
    return this.exclusive(project, id, () => this.checkOnce(project, id, entry));
  }

  private async checkOnce(project: ProjectRecord, id: string, entry: string) {
    const session = this.session(project, id);
    const root = this.root(project, id);
    const entryPath = bundleRelativePath(entry);
    if (fs.existsSync(path.join(root, 'result.json'))) throw new Error('这次导入已经固定，新的检查请新建导入');
    const files = await this.listFiles(project, id);
    if (!files.some(file => file.path === entryPath && /\.so(?:\..*)?$/.test(file.path))) throw new Error('请选择已上传的入口动态库');
    const connection = this.connection(project), { runner, target } = connection;
    const check: BaselineImportCheck & { definition?: BinaryBundleBaselineDefinition } = { entry_path: entryPath, files,
      state: 'CHECKING', machine: connection.identity, inspection: null, error: null };
    this.writeCheck(project, id, check);
    try {
      const client = new RunnerClient({ baseUrl: runner.endpoint, token: runner.token, requestTimeoutMs: runner.requestTimeoutMs });
      const { machine: hardware } = await client.probe();
      const remoteRoot = path.posix.join(target.workspace_root.replaceAll('\\', '/'),
        'baseline-bundle-checks', id, randomUUID());
      const inspection = await this.stageAndInspect({ localRoot: path.join(root, 'files'), remoteRoot, target, runner, entryPath, files });
      check.inspection = inspection;
      if (!inspection.ok) { check.state = 'CHECK_FAILED'; this.writeCheck(project, id, check); return { ok: false, inspection, files, bundle_id: id }; }
      if (inspection.machine_identity_sha256 !== hardware.machine_identity_sha256) throw new Error('Runner 机器身份在检查期间变化');
      const headers = files.filter(file => /\.(?:h|hpp|hh)$/.test(file.path)).map(file => ({ path: file.path, sha256: file.sha256 }));
      const needed = new Set(inspection.libraries.flatMap(library => library.needed.filter(item =>
        item.classification === 'BUNDLED_DEPENDENCY').map(item => item.soname)));
      const libraries = inspection.libraries.map(library => ({ ...library,
        role: library.path === entryPath ? 'ENTRY' as const : needed.has(library.soname) ? 'BUNDLED_DEPENDENCY' as const : 'OTHER' as const }));
      const digest = binaryBundleIdentitySha256({ headers, libraries });
      check.definition = {
        schema_version: 1, baseline_id: `baseline-${digest.slice(0, 12)}`, version: session.library_version,
        kind: 'binary_bundle', state: 'VERIFIED', digest_algorithm: 'sha256-file-identities-v1', sha256: digest,
        headers, libraries,
        loader_environment: { mechanism: 'LD_LIBRARY_PATH',
          search_paths: [...new Set(libraries.map(library => path.posix.dirname(library.path)))] },
        target_compatibility: [`Linux ${hardware.architecture}; machine ${hardware.machine_identity_sha256}`],
        dependency_closure: { status: 'VALID', target_machine: hardware.machine_identity_sha256,
          checked_at: inspection.checked_at, resolved_libraries: inspection.resolved_libraries },
      };
      check.state = 'READY'; this.writeCheck(project, id, check);
      return { ok: true, inspection, files, bundle_id: id };
    } catch (error) {
      check.state = 'CHECK_FAILED'; check.error = (error as Error).message;
      this.writeCheck(project, id, check); throw error;
    }
  }

  async bind(project: ProjectRecord, id: string, entry: string) {
    return this.exclusive(project, id, async () => {
      const session = this.session(project, id), root = this.root(project, id), entryPath = bundleRelativePath(entry);
      const resultPath = path.join(root, 'result.json');
      if (fs.existsSync(resultPath)) {
        const cached = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        if (cached.entry_path !== entryPath) throw new Error('该比较包已固定另一入口库；更换入口请新建导入');
        if (cached.selection_key && cached.selection_key !== this.assets.baselineSelectionKey(project, session.package_id, session.package_version, session.target_id)) throw new ApiError(409, 'BASELINE_SELECTION_CHANGED', '当前比较基线已经更换，原导入记录保留，不会重新覆盖当前选择');
        return cached;
      }
      const check = this.readCheck(project, id);
      if (check?.state !== 'READY' || !check.definition || !check.inspection?.ok || check.entry_path !== entryPath) throw new ApiError(409, 'BASELINE_CHECK_REQUIRED', '请先在目标机检查所选入口库，检查通过后再固定');
      const connection = this.connection(project);
      if (JSON.stringify(connection.identity) !== JSON.stringify(check.machine)) throw new ApiError(409, 'BASELINE_MACHINE_CHANGED', '执行机器或连接配置已变化，请重新检查后再固定');
      if (JSON.stringify(await this.listFiles(project, id)) !== JSON.stringify(check.files)) throw new Error('导入文件在检查后发生变化，请重新检查');
      const currentKey = this.assets.baselineSelectionKey(project, session.package_id, session.package_version, session.target_id);
      if (session.expected_selection_key && session.expected_selection_key !== currentKey) throw new ApiError(409, 'BASELINE_SELECTION_CHANGED', '当前比较基线已被其他操作更换，请重新发起导入');
      const binding = this.assets.bindBinaryBundle(project, session.package_id, session.package_version, session.target_id,
        { library: session.library, definition: check.definition, bundleRoot: path.join(root, 'files'), entryPath,
          machineId: check.machine.id, uploadId: id });
      const result = { ok: true, ...binding, inspection: check.inspection, bundle_id: id,
        selection_key: this.assets.baselineSelectionKey(project, session.package_id, session.package_version, session.target_id) };
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return result;
    });
  }

  /** Compatibility entry: CLI's explicit import-and-fix command uses the same two operations. */
  async finalize(project: ProjectRecord, id: string, entry: string): Promise<unknown> {
    const state = await this.status(project, id);
    if (state.result) return this.bind(project, id, entry);
    const result = await this.check(project, id, entry);
    return result.ok ? this.bind(project, id, entry) : result;
  }
}
