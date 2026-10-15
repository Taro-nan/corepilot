import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CandidateSourceScope } from '../contracts/library-package.js';
import { assertCandidateSourceScope } from '../library-package/candidate-scope.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from 'typebox';
import {
  DEVELOPMENT_ONLY,
  type DevelopmentFindings,
  type DevelopmentInvestigationToolName,
  type DevelopmentSupportingMeasurement,
} from '../contracts/development-investigation.js';

export interface WorkspaceToolResult {
  isError: boolean;
  text: string;
}

export interface WorkspaceToolOptions {
  candidateSourceScope?: CandidateSourceScope;
  beforeSourceMutation?: () => void;
  buildContext?: () => Promise<unknown> | unknown;
  targetProfile?: () => Promise<unknown> | unknown;
  performanceEvidence?: () => Promise<unknown> | unknown;
  runBuild?: (signal: AbortSignal) => Promise<WorkspaceToolResult>;
  runCorrectness?: (signal: AbortSignal) => Promise<WorkspaceToolResult>;
  runPerformance?: (signal: AbortSignal) => Promise<WorkspaceToolResult>;
  inspectMachine?: (signal: AbortSignal) => Promise<WorkspaceToolResult>;
  inspectBinary?: (input: { symbol?: string }, signal: AbortSignal) => Promise<WorkspaceToolResult>;
  disassemble?: (input: { symbol: string }, signal: AbortSignal) => Promise<WorkspaceToolResult>;
  runDevBenchmark?: (input: { workloadId: string; samples: number }, signal: AbortSignal) => Promise<WorkspaceToolResult>;
  profilePerfStat?: (input: { workloadId: string; repeats: number }, signal: AbortSignal) => Promise<WorkspaceToolResult>;
  /** Prevent a source mutation until the Agent records a structured diagnosis. */
  requireDevelopmentFindingsBeforeMutation?: boolean;
}

export class WorkspaceToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceToolError';
  }
}

function asString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new WorkspaceToolError(`${key} must be a non-empty string`);
  return value.trim();
}

function asBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new WorkspaceToolError(`${key} must be boolean`);
  return value;
}

function asBoundedInteger(args: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = args[key] === undefined ? fallback : Number(args[key]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WorkspaceToolError(`${key} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

const INVESTIGATION_TOOLS = new Set<DevelopmentInvestigationToolName>([
  'inspect_machine',
  'inspect_binary',
  'disassemble',
  'run_dev_benchmark',
  'profile_perf_stat',
]);

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new WorkspaceToolError(`${field} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim().slice(0, 4096));
}

function parseSupportingMeasurements(value: unknown): DevelopmentSupportingMeasurement[] {
  if (!Array.isArray(value)) throw new WorkspaceToolError('supporting_measurements must be an array');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkspaceToolError(`supporting_measurements[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const tool = asString(item, 'tool') as DevelopmentInvestigationToolName;
    if (!INVESTIGATION_TOOLS.has(tool)) throw new WorkspaceToolError(`supporting_measurements[${index}].tool is not an investigation tool`);
    const experimentId = item.experiment_id;
    if (experimentId !== undefined && (typeof experimentId !== 'string' || experimentId.trim().length === 0)) {
      throw new WorkspaceToolError(`supporting_measurements[${index}].experiment_id must be a non-empty string`);
    }
    return {
      tool,
      subject_id: asString(item, 'subject_id').slice(0, 1024),
      summary: asString(item, 'summary').slice(0, 4096),
      ...(typeof experimentId === 'string' ? { experiment_id: experimentId.trim().slice(0, 1024) } : {}),
    };
  });
}

function result(text: string, isError = false): WorkspaceToolResult {
  return { text, isError };
}

function runGit(root: string, args: string[]): string {
  const child = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (child.status !== 0) throw new WorkspaceToolError(`git ${args.join(' ')} failed: ${(child.stderr ?? '').trim()}`);
  return (child.stdout ?? '').trim();
}

interface CodeSearchHit {
  path: string;
  line: number;
  text: string;
}

interface RipgrepJsonMatch {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

/** Run ripgrep without a shell and stop as soon as the Agent-visible result cap is reached. */
function searchWithRipgrep(
  root: string,
  query: string,
  regexp: boolean,
  signal: AbortSignal,
  limit = 500,
): Promise<{ query: string; hits: CodeSearchHit[]; truncated: boolean }> {
  signal.throwIfAborted();
  const args = [
    '--no-config',
    '--json',
    '--line-number',
    '--ignore-case',
    '--color', 'never',
    '--glob', '!.git/**',
    '--glob', '!.phyopt/**',
    '--glob', '!node_modules/**',
    ...(regexp ? [] : ['--fixed-strings']),
    '--', query, '.',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const hits: CodeSearchHit[] = [];
    let stdoutBuffer = '';
    let stderr = '';
    let truncated = false;
    let stoppedForLimit = false;
    let aborted = false;
    let settled = false;

    const stop = () => {
      if (!child.killed) child.kill();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const parseLine = (line: string) => {
      if (!line) return;
      let event: RipgrepJsonMatch;
      try { event = JSON.parse(line) as RipgrepJsonMatch; } catch { return; }
      if (event.type !== 'match') return;
      const rawPath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const rawText = event.data?.lines?.text;
      if (typeof rawPath !== 'string' || !Number.isInteger(lineNumber) || typeof rawText !== 'string') return;
      const relativePath = path.relative(root, path.resolve(root, rawPath)).split(path.sep).join('/');
      hits.push({ path: relativePath, line: lineNumber as number, text: rawText.replace(/\r?\n$/, '').slice(0, 500) });
      if (hits.length >= limit) {
        truncated = true;
        stoppedForLimit = true;
        stop();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        parseLine(line);
        if (stoppedForLimit) break;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new WorkspaceToolError((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'ripgrep (rg) is required for search_code but was not found on PATH'
        : `cannot start ripgrep: ${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (stdoutBuffer && !stoppedForLimit) parseLine(stdoutBuffer);
      if (aborted) {
        reject(new WorkspaceToolError('search_code cancelled'));
        return;
      }
      if (!stoppedForLimit && code !== 0 && code !== 1) {
        reject(new WorkspaceToolError(`ripgrep search failed${stderr.trim() ? `: ${stderr.trim()}` : ` with exit code ${code ?? 'unknown'}`}`));
        return;
      }
      resolve({ query, hits: hits.slice(0, limit), truncated });
    });
  });
}

/** 绑定编辑 worktree 的受控工具集合；入口文件不会成为 allowed_files。 */
export class WorkspaceToolset {
  private readonly root: string;
  private findings: DevelopmentFindings | null = null;

  constructor(root: string, private readonly options: WorkspaceToolOptions = {}) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) throw new WorkspaceToolError(`workspace does not exist: ${this.root}`);
  }

  private resolve(relative: string): string {
    const normalized = relative.replace(/^[\\/]+/, '');
    const absolute = path.resolve(this.root, normalized);
    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) throw new WorkspaceToolError(`path escapes editing workspace: ${relative}`);
    const parts = path.relative(this.root, absolute).split(path.sep).filter(Boolean);
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new WorkspaceToolError(`path traverses a symbolic link: ${relative}`);
    }
    return absolute;
  }

  private assertWritable(relative: string): void {
    if (this.options.candidateSourceScope) assertCandidateSourceScope(this.options.candidateSourceScope, [this.relative(this.resolve(relative))]);
    const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '');
    const first = normalized.split('/')[0];
    if (first === '.git' || first === '.phyopt' || first === 'node_modules') throw new WorkspaceToolError(`protected workspace path: ${relative}`);
  }

  private assertMutationAllowed(): void {
    this.options.beforeSourceMutation?.();
    if (this.options.requireDevelopmentFindingsBeforeMutation === true && this.findings === null) {
      throw new WorkspaceToolError('record_development_findings must be called before modifying source');
    }
    if (this.options.requireDevelopmentFindingsBeforeMutation === true && this.findings?.chosen_transformation === null) {
      throw new WorkspaceToolError('development findings do not justify a source transformation');
    }
  }

  beginInvestigationRound(): void {
    this.findings = null;
  }

  developmentFindings(): DevelopmentFindings | null {
    return this.findings ? structuredClone(this.findings) : null;
  }

  private relative(absolute: string): string {
    return path.relative(this.root, absolute).split(path.sep).join('/');
  }

  private listFiles(current = this.root): string[] {
    const output: string[] = [];
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.phyopt' || entry.name === 'node_modules') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new WorkspaceToolError(`symbolic link is not allowed: ${this.relative(absolute)}`);
      if (entry.isDirectory()) output.push(...this.listFiles(absolute));
      else output.push(this.relative(absolute));
    }
    return output.sort();
  }

  private read(relative: string): string {
    const absolute = this.resolve(relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new WorkspaceToolError(`file not found: ${relative}`);
    return fs.readFileSync(absolute, 'utf8');
  }

  async execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<WorkspaceToolResult> {
    try {
      signal.throwIfAborted();
      switch (name) {
        case 'list_tree': {
          const limit = args.limit === undefined ? 500 : Number(args.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new WorkspaceToolError('limit must be an integer in 1..5000');
          const files = this.listFiles();
          return result(JSON.stringify({ root: this.root, files: files.slice(0, limit), truncated: files.length > limit }));
        }
        case 'search_code': {
          const query = asString(args, 'query');
          const regexp = asBoolean(args, 'regex');
          return result(JSON.stringify(await searchWithRipgrep(this.root, query, regexp, signal)));
        }
        case 'find_symbol': {
          const symbol = asString(args, 'symbol');
          return this.execute('search_code', { query: `\\b${symbol.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, regex: true }, signal);
        }
        case 'find_references':
          return this.execute('search_code', { query: asString(args, 'symbol'), regex: false }, signal);
        case 'read_file':
          return result(this.read(asString(args, 'path')));
        case 'read_build_context':
          return result(JSON.stringify(await this.options.buildContext?.() ?? null));
        case 'read_target_profile':
          return result(JSON.stringify(await this.options.targetProfile?.() ?? null));
        case 'read_performance_evidence':
          return result(JSON.stringify(await this.options.performanceEvidence?.() ?? null));
        case 'inspect_machine':
          return this.options.inspectMachine ? this.options.inspectMachine(signal) : result('inspect_machine is not configured', true);
        case 'inspect_binary': {
          if (!this.options.inspectBinary) return result('inspect_binary is not configured', true);
          const symbol = args.symbol === undefined ? undefined : asString(args, 'symbol');
          return this.options.inspectBinary({ ...(symbol ? { symbol } : {}) }, signal);
        }
        case 'disassemble':
          return this.options.disassemble
            ? this.options.disassemble({ symbol: asString(args, 'symbol') }, signal)
            : result('disassemble is not configured', true);
        case 'run_dev_benchmark':
          return this.options.runDevBenchmark
            ? this.options.runDevBenchmark({
                workloadId: asString(args, 'workload_id'),
                samples: asBoundedInteger(args, 'samples', 3, 1, 5),
              }, signal)
            : result('run_dev_benchmark is not configured', true);
        case 'profile_perf_stat':
          return this.options.profilePerfStat
            ? this.options.profilePerfStat({
                workloadId: asString(args, 'workload_id'),
                repeats: asBoundedInteger(args, 'repeats', 1, 1, 3),
              }, signal)
            : result('profile_perf_stat is not configured', true);
        case 'record_development_findings': {
          const chosen = args.chosen_transformation;
          if (chosen !== null && (typeof chosen !== 'string' || chosen.trim().length === 0)) {
            throw new WorkspaceToolError('chosen_transformation must be null or a non-empty string');
          }
          this.findings = {
            classification: DEVELOPMENT_ONLY,
            observations: stringList(args.observations, 'observations'),
            suspected_bottleneck: asString(args, 'suspected_bottleneck').slice(0, 4096),
            supporting_measurements: parseSupportingMeasurements(args.supporting_measurements),
            chosen_transformation: typeof chosen === 'string' ? chosen.trim().slice(0, 4096) : null,
            rejected_alternatives: stringList(args.rejected_alternatives, 'rejected_alternatives'),
          };
          return result(JSON.stringify(this.findings));
        }
        case 'write_file': {
          this.assertMutationAllowed();
          const relative = asString(args, 'path');
          this.assertWritable(relative);
          const content = args.content;
          if (typeof content !== 'string') throw new WorkspaceToolError('content must be a string');
          const absolute = this.resolve(relative);
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, content);
          return result(JSON.stringify({ path: this.relative(absolute), bytes: Buffer.byteLength(content) }));
        }
        case 'create_file': {
          this.assertMutationAllowed();
          const relative = asString(args, 'path');
          this.assertWritable(relative);
          const absolute = this.resolve(relative);
          if (fs.existsSync(absolute)) throw new WorkspaceToolError(`file already exists: ${relative}`);
          const content = args.content;
          if (typeof content !== 'string') throw new WorkspaceToolError('content must be a string');
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, content, { flag: 'wx' });
          return result(JSON.stringify({ path: this.relative(absolute), bytes: Buffer.byteLength(content) }));
        }
        case 'replace_text': {
          this.assertMutationAllowed();
          const relative = asString(args, 'path');
          this.assertWritable(relative);
          const oldText = asString(args, 'old_text');
          const newText = args.new_text;
          if (typeof newText !== 'string') throw new WorkspaceToolError('new_text must be a string');
          const content = this.read(relative);
          const count = content.split(oldText).length - 1;
          if (count !== 1) throw new WorkspaceToolError(`old_text must occur exactly once (found ${count})`);
          fs.writeFileSync(this.resolve(relative), content.replace(oldText, newText));
          return result(JSON.stringify({ path: relative, replacements: 1 }));
        }
        case 'delete_file': {
          this.assertMutationAllowed();
          const relative = asString(args, 'path');
          this.assertWritable(relative);
          const absolute = this.resolve(relative);
          if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new WorkspaceToolError(`file not found: ${relative}`);
          fs.unlinkSync(absolute);
          return result(JSON.stringify({ path: relative, deleted: true }));
        }
        case 'move_file': {
          this.assertMutationAllowed();
          const from = asString(args, 'from');
          const to = asString(args, 'to');
          this.assertWritable(from);
          this.assertWritable(to);
          const source = this.resolve(from);
          const destination = this.resolve(to);
          if (!fs.existsSync(source)) throw new WorkspaceToolError(`file not found: ${from}`);
          if (fs.existsSync(destination)) throw new WorkspaceToolError(`destination already exists: ${to}`);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.renameSync(source, destination);
          return result(JSON.stringify({ from, to }));
        }
        case 'revert_file': {
          this.assertMutationAllowed();
          const relative = asString(args, 'path');
          this.assertWritable(relative);
          runGit(this.root, ['restore', '--', relative]);
          return result(JSON.stringify({ path: relative, reverted: true }));
        }
        case 'git_status':
          return result(runGit(this.root, ['status', '--short']));
        case 'show_diff':
          return result(runGit(this.root, ['diff', '--', ...(args.path ? [asString(args, 'path')] : [])]));
        case 'run_build':
          return this.options.runBuild ? this.options.runBuild(signal) : result('run_build is not configured', true);
        case 'run_correctness':
          return this.options.runCorrectness ? this.options.runCorrectness(signal) : result('run_correctness is not configured', true);
        case 'run_performance':
          return this.options.runPerformance ? this.options.runPerformance(signal) : result('run_performance is not configured', true);
        default:
          throw new WorkspaceToolError(`unknown workspace tool '${name}'`);
      }
    } catch (error) {
      return result((error as Error).message, true);
    }
  }

  asAgentTools(): AgentTool[] {
    const empty = () => Type.Object({}, { additionalProperties: false });
    const definitions: Array<{
      name: string;
      label: string;
      description: string;
      parameters: TSchema;
    }> = [
      { name: 'list_tree', label: 'List workspace files', description: 'List repository files, excluding protected runtime trees.', parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }, { additionalProperties: false }) },
      { name: 'search_code', label: 'Search code', description: 'Search the repository with ripgrep. Use regex=false for literal text.', parameters: Type.Object({ query: Type.String(), regex: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) },
      { name: 'find_symbol', label: 'Find symbol', description: 'Find exact symbol occurrences with ripgrep.', parameters: Type.Object({ symbol: Type.String() }, { additionalProperties: false }) },
      { name: 'find_references', label: 'Find references', description: 'Find literal references to a symbol or identifier.', parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }) },
      { name: 'read_file', label: 'Read file', description: 'Read one UTF-8 file relative to the Candidate workspace.', parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }) },
      { name: 'read_build_context', label: 'Read build context', description: 'Read the configured build command and repository context.', parameters: empty() },
      { name: 'read_target_profile', label: 'Read target profile', description: 'Read the configured target machine profile.', parameters: empty() },
      { name: 'read_performance_evidence', label: 'Read performance evidence', description: 'Read structured baseline, workload, and acceptance-policy evidence.', parameters: empty() },
      { name: 'inspect_machine', label: 'Inspect target machine', description: 'Read Runner-observed target identity and capabilities. DEVELOPMENT_ONLY.', parameters: empty() },
      { name: 'inspect_binary', label: 'Inspect target binary', description: 'Build on the target and inspect the Candidate library with readelf, nm, and ldd. DEVELOPMENT_ONLY.', parameters: Type.Object({ symbol: Type.Optional(Type.String()) }, { additionalProperties: false }) },
      { name: 'disassemble', label: 'Disassemble target symbol', description: 'Build on the target and disassemble one symbol from the Candidate library. DEVELOPMENT_ONLY.', parameters: Type.Object({ symbol: Type.String() }, { additionalProperties: false }) },
      { name: 'run_dev_benchmark', label: 'Run targeted benchmark', description: 'Run one declared workload for Baseline and Candidate with a small independent sample count. DEVELOPMENT_ONLY and never acceptance evidence.', parameters: Type.Object({ workload_id: Type.String(), samples: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }, { additionalProperties: false }) },
      { name: 'profile_perf_stat', label: 'Profile with perf stat', description: 'Compare supported perf counters for Baseline and Candidate on one declared workload under identical resources. DEVELOPMENT_ONLY.', parameters: Type.Object({ workload_id: Type.String(), repeats: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })) }, { additionalProperties: false }) },
      { name: 'record_development_findings', label: 'Record diagnosis', description: 'Record the structured diagnosis before changing source. Use chosen_transformation=null when evidence does not justify a change.', parameters: Type.Object({
        observations: Type.Array(Type.String(), { maxItems: 32 }),
        suspected_bottleneck: Type.String(),
        supporting_measurements: Type.Array(Type.Object({
          tool: Type.Union([...INVESTIGATION_TOOLS].map((name) => Type.Literal(name))),
          subject_id: Type.String(),
          summary: Type.String(),
          experiment_id: Type.Optional(Type.String()),
        }, { additionalProperties: false }), { maxItems: 32 }),
        chosen_transformation: Type.Union([Type.String(), Type.Null()]),
        rejected_alternatives: Type.Array(Type.String(), { maxItems: 32 }),
      }, { additionalProperties: false }) },
      { name: 'write_file', label: 'Write file', description: 'Replace the complete contents of an existing or new workspace file.', parameters: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }) },
      { name: 'create_file', label: 'Create file', description: 'Create a new workspace file; fails if it already exists.', parameters: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }) },
      { name: 'replace_text', label: 'Replace text', description: 'Replace one exact, uniquely occurring text block in a workspace file.', parameters: Type.Object({ path: Type.String(), old_text: Type.String(), new_text: Type.String() }, { additionalProperties: false }) },
      { name: 'delete_file', label: 'Delete file', description: 'Delete one workspace file.', parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }) },
      { name: 'move_file', label: 'Move file', description: 'Move one workspace file to a new relative path.', parameters: Type.Object({ from: Type.String(), to: Type.String() }, { additionalProperties: false }) },
      { name: 'revert_file', label: 'Revert file', description: 'Restore one workspace file from the Candidate baseline.', parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }) },
      { name: 'git_status', label: 'Git status', description: 'Show concise Candidate workspace changes.', parameters: empty() },
      { name: 'show_diff', label: 'Show diff', description: 'Show the Candidate diff, optionally for one file.', parameters: Type.Object({ path: Type.Optional(Type.String()) }, { additionalProperties: false }) },
      { name: 'run_build', label: 'Run development build', description: 'Run the configured development build feedback command.', parameters: empty() },
      { name: 'run_correctness', label: 'Run development correctness', description: 'Run development correctness feedback; this is not Formal Evidence.', parameters: empty() },
      { name: 'run_performance', label: 'Run development performance', description: 'Run development performance feedback; this is not Formal Evidence.', parameters: empty() },
    ];

    const available = definitions.filter(({ name }) => {
      if (name === 'run_build') return this.options.runBuild !== undefined;
      if (name === 'run_correctness') return this.options.runCorrectness !== undefined;
      if (name === 'run_performance') return this.options.runPerformance !== undefined;
      if (name === 'inspect_machine') return this.options.inspectMachine !== undefined;
      if (name === 'inspect_binary') return this.options.inspectBinary !== undefined;
      if (name === 'disassemble') return this.options.disassemble !== undefined;
      if (name === 'run_dev_benchmark') return this.options.runDevBenchmark !== undefined;
      if (name === 'profile_perf_stat') return this.options.profilePerfStat !== undefined;
      if (name === 'record_development_findings') {
        return this.options.requireDevelopmentFindingsBeforeMutation === true ||
          this.options.inspectMachine !== undefined || this.options.inspectBinary !== undefined ||
          this.options.disassemble !== undefined || this.options.runDevBenchmark !== undefined ||
          this.options.profilePerfStat !== undefined;
      }
      return true;
    });

    return available.map(({ name, label, description, parameters }) => ({
      name,
      label,
      description,
      parameters,
      executionMode: 'sequential',
      execute: async (_toolCallId, args, signal) => {
        const output = await this.execute(name, args as Record<string, unknown>, signal ?? new AbortController().signal);
        if (output.isError) throw new WorkspaceToolError(output.text);
        return {
          content: [{ type: 'text', text: output.text }],
          details: { tool: name },
          ...(name === 'record_development_findings' && this.findings?.chosen_transformation === null
            ? { terminate: true }
            : {}),
        };
      },
    }));
  }
}
