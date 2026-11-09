import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BuildRequirements } from '../contracts/build-planning.js';

export interface InspectedFile { path: string; sha256: string; bytes: number }
export interface BuildCandidate { kind: string; command: string; evidence: string[]; status: 'DISCOVERED' | 'VERIFIED' | 'UNVERIFIED' }
export interface FunctionCandidate {
  symbol: string;
  public_api: string | 'UNKNOWN';
  header: string | null;
  implementation_files: string[];
  architecture_files: string[];
  call_path: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}
export interface RepositoryInspection {
  repository: { path: string; name: string; git_commit: string | null; git_dirty: boolean | null };
  files: string[];
  inspected_files: InspectedFile[];
  build_candidates: BuildCandidate[];
  build_requirements: BuildRequirements;
  functions: FunctionCandidate[];
  tests: string[];
  benchmarks: string[];
  test_assets: Array<{ path: string; assertion_clues: string[] }>;
  benchmark_assets: Array<{ path: string; argument_clues: string[]; output_clues: string[]; workload_clues: string[] }>;
  references: string[];
  dependencies: string[];
  version_clues: Array<{ path: string; value: string }>;
  languages: string[];
  public_headers: string[];
  unknowns: string[];
}

const SKIP_DIRS = new Set(['.git', '.corepilot', 'node_modules', 'dist', 'build', '.cache', '.venv', 'vendor']);
const MAX_FILES = 50_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const SOURCE = /\.(?:c|cc|cpp|cxx|s|S)$/;
const HEADER = /\.(?:h|hh|hpp|hxx)$/;
const TEXT = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|s|S|md|txt|cmake|meson|sh|yml|yaml|toml|json)$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z_0-9]*$/;
const SENSITIVE = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:secret|credential|private[_-]?key)[^/]*|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12))$/i;

/** Extract build facts from already indexed source; no build command is executed. */
function inspectBuildRequirements(files: string[], content: Map<string, string>): BuildRequirements {
  const roots = [
    ['cmake', 'CMakeLists.txt'], ['meson', 'meson.build'], ['make', 'Makefile'], ['make', 'GNUmakefile'],
    ['configure', 'configure'], ['cargo', 'Cargo.toml'], ['go', 'go.mod'], ['ninja', 'build.ninja'],
  ];
  const root_builds = roots.filter(([, file]) => files.includes(file)).map(([kind, file]) => ({ kind, path: file }));
  const evidence: BuildRequirements['evidence'] = [];
  let cmake_minimum: string | null = null;
  let cxx_standard: number | null = null;
  let openmp_option: string | null = null;
  const record = (file: string, index: number, line: string) => {
    if (evidence.length < 12) evidence.push({ path: file, line: index + 1, text: line.trim().slice(0, 180) });
  };
  const cmake = content.get('CMakeLists.txt');
  if (cmake) for (const [index, line] of cmake.split(/\r?\n/).entries()) {
    const minimum = line.match(/^\s*cmake_minimum_required\s*\(\s*VERSION\s+(\d+(?:\.\d+){1,2})/i);
    if (minimum && !cmake_minimum) { cmake_minimum = minimum[1]; record('CMakeLists.txt', index, line); }
    const standard = line.match(/(?:CMAKE_CXX_STANDARD\s+|cxx_std_)(11|14|17|20|23|26)\b/i);
    if (standard && Number(standard[1]) > (cxx_standard ?? 0)) { cxx_standard = Number(standard[1]); record('CMakeLists.txt', index, line); }
    const openmp = line.match(/^\s*option\s*\(\s*([A-Za-z_][A-Za-z_0-9]*)\b.*\bOpenMP\b/i);
    if (openmp && !openmp_option) { openmp_option = openmp[1]; record('CMakeLists.txt', index, line); }
  }
  if (!cxx_standard) {
    for (const [file, text] of content) {
      if (!/\.(?:cc|cpp|cxx|hpp|hxx)$/.test(file) || /(?:^|\/)(?:test|ctest|bench)/i.test(file)) continue;
      const lines = text.split(/\r?\n/);
      const index = lines.findIndex(line => /\bstd::(?:is_same_v|optional|variant|string_view)\b|\bif\s+constexpr\s*\(/.test(line) && !/^\s*(?:\/\/|\*)/.test(line));
      if (index >= 0) { cxx_standard = 17; record(file, index, lines[index]); break; }
    }
  }
  return { root_builds, cmake_minimum, cxx_standard, openmp_option, evidence };
}

function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function slash(value: string): string { return value.split(path.sep).join('/'); }
function isTest(value: string): boolean { return /(?:^|\/)(?:tests?|ctest|unittests?|testing)(?:\/|$)|(?:^|\/)(?:test|check)_[^/]+\.[^/]+$/i.test(value); }
function isBenchmark(value: string): boolean { return /(?:^|\/)(?:benchmarks?|microbenchmarks?|perf)(?:\/|$)|(?:^|\/)[^/]*(?:bench|benchmark)[^/]*\.[^/]+$/i.test(value); }
function isProtected(value: string): boolean {
  return isTest(value) || isBenchmark(value) || /(?:^|\/)(?:reference|oracle|golden|generated|third.party|cmake)(?:\/|[._-])/i.test(value) || /(?:^|\/)(?:Makefile|CMakeLists\.txt|meson\.build|configure)$/i.test(value);
}

export class RepositoryInspector {
  readonly root: string;
  private readonly inspected = new Map<string, InspectedFile>();
  private fileList: string[] | null = null;

  constructor(repositoryRoot: string) {
    this.root = fs.realpathSync(path.resolve(repositoryRoot));
    if (!fs.statSync(this.root).isDirectory()) throw new Error('repository path must be a directory');
  }

  listFiles(): string[] {
    if (this.fileList) return [...this.fileList];
    const tracked = spawnSync('git', ['-C', this.root, 'ls-files', '--cached', '-z'], {
      encoding: 'buffer', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (tracked.status === 0) {
      const files = tracked.stdout.toString('utf8').split('\0').filter(Boolean).map((item) => slash(item)).filter((relative) => {
        if (SENSITIVE.test(relative)) return false;
        return !relative.split('/').slice(0, -1).some((segment) => SKIP_DIRS.has(segment));
      });
      if (files.length > MAX_FILES) throw new Error(`repository inspection exceeds ${MAX_FILES} files`);
      this.fileList = files.filter((relative) => {
        const absolute = path.join(this.root, ...relative.split('/'));
        return fs.existsSync(absolute) && fs.lstatSync(absolute).isFile() && !fs.lstatSync(absolute).isSymbolicLink();
      }).sort();
      return [...this.fileList];
    }
    if (fs.existsSync(path.join(this.root, '.git'))) {
      const detail = tracked.error?.message ?? (tracked.stderr.toString('utf8').trim() || 'unknown Git inspection failure');
      throw new Error(`cannot enumerate tracked repository files: ${detail}`);
    }
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        const relative = slash(path.relative(this.root, absolute));
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) visit(absolute);
        } else if (entry.isFile() && !SENSITIVE.test(relative)) {
          files.push(relative);
          if (files.length > MAX_FILES) throw new Error(`repository inspection exceeds ${MAX_FILES} files`);
        }
      }
    };
    visit(this.root);
    this.fileList = files;
    return [...files];
  }

  readFile(relative: string): string {
    if (!this.listFiles().includes(relative)) throw new Error(`repository file is not an indexed regular file: ${relative}`);
    const absolute = path.join(this.root, ...relative.split('/'));
    const real = fs.realpathSync(absolute);
    if (real !== absolute || !fs.statSync(real).isFile()) throw new Error(`repository file changed or is a link: ${relative}`);
    const stat = fs.statSync(real);
    if (stat.size > MAX_TEXT_BYTES) throw new Error(`repository file exceeds 2 MiB read limit: ${relative}`);
    const data = fs.readFileSync(real);
    if (data.includes(0)) throw new Error(`binary repository file cannot be read: ${relative}`);
    this.inspected.set(relative, { path: relative, sha256: sha256(data), bytes: data.length });
    return data.toString('utf8');
  }

  inspectedFiles(): InspectedFile[] { return [...this.inspected.values()].sort((left, right) => left.path.localeCompare(right.path)); }

  searchCode(query: string): Array<{ path: string; line: number; text: string }> {
    if (!query || query.length > 128) throw new Error('search query must be 1..128 characters');
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const file of this.listFiles().filter((item) => TEXT.test(item)).slice(0, 600)) {
      let content: string;
      try { content = this.readFile(file); } catch { continue; }
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (line.toLowerCase().includes(query.toLowerCase())) hits.push({ path: file, line: index + 1, text: line.slice(0, 300) });
        if (hits.length >= 100) return hits;
      }
    }
    return hits;
  }

  inspectGit(): { git_commit: string | null; git_dirty: boolean | null } {
    const run = (args: string[]) => spawnSync('git', ['-C', this.root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const commit = run(['rev-parse', '--verify', 'HEAD']);
    if (commit.status !== 0) {
      if (fs.existsSync(path.join(this.root, '.git'))) throw new Error(`cannot inspect repository identity: ${commit.error?.message ?? (commit.stderr.trim() || 'unknown Git inspection failure')}`);
      return { git_commit: null, git_dirty: null };
    }
    const status = run(['status', '--porcelain', '--untracked-files=no']);
    return { git_commit: commit.stdout.trim(), git_dirty: status.status === 0 ? status.stdout.trim().length > 0 : null };
  }

  inspect(): RepositoryInspection {
    const files = this.listFiles();
    const buildCandidates: BuildCandidate[] = [];
    const addBuild = (kind: string, command: string, evidence: string[]) => buildCandidates.push({ kind, command, evidence, status: 'DISCOVERED' });
    const make = files.filter((item) => /(?:^|\/)Makefile$|(?:^|\/)GNUmakefile$/i.test(item));
    const rootMake = make.filter(item => !item.includes('/'));
    if (rootMake.length) addBuild('make', 'make', rootMake);
    const cmake = files.filter((item) => /(?:^|\/)CMakeLists\.txt$/.test(item));
    if (cmake.includes('CMakeLists.txt')) addBuild('cmake', 'cmake -S . -B build && cmake --build build', ['CMakeLists.txt']);
    const meson = files.filter((item) => /(?:^|\/)meson\.build$/.test(item));
    if (meson.includes('meson.build')) addBuild('meson', 'meson setup build && meson compile -C build', ['meson.build']);
    const configure = files.filter((item) => /(?:^|\/)configure$|(?:^|\/)configure\.ac$/.test(item));
    if (configure.includes('configure')) addBuild('configure', './configure && make', ['configure']);
    const scripts = files.filter((item) => /(?:^|\/)scripts\/[^/]*(?:build|compile)[^/]*\.sh$/i.test(item));
    for (const script of scripts.slice(0, 5)) addBuild('script', script, [script]);
    const additionalBuilds = [
      { file: 'Cargo.toml', kind: 'cargo', command: 'cargo build --release' },
      { file: 'go.mod', kind: 'go', command: 'go build ./...' },
      { file: 'pyproject.toml', kind: 'python', command: 'python3 -m build' },
      { file: 'BUILD.bazel', kind: 'bazel', command: 'bazel build //...' },
      { file: 'build.ninja', kind: 'ninja', command: 'ninja' },
    ].filter(item => files.includes(item.file));
    for (const item of additionalBuilds) addBuild(item.kind, item.command, [item.file]);
    const docs = files.filter((item) => /(?:^|\/)(?:README|INSTALL|CONTRIBUTING)[^/]*$/i.test(item)).slice(0, 8);
    const ci = files.filter((item) => /(?:^|\/)\.github\/workflows\/[^/]+\.(?:yml|yaml)$|(?:^|\/)\.gitlab-ci\.yml$/i.test(item)).slice(0, 12);
    const tests = files.filter(isTest);
    const benchmarks = files.filter(isBenchmark);
    const references = files.filter((item) => /(?:^|\/)[^/]*(?:reference|oracle|golden)[^/]*\.(?:c|cc|cpp|h|txt|json)$/i.test(item));
    const headers = files.filter((item) => HEADER.test(item) && !isProtected(item));
    const publicHeaders = headers.filter((item) => /(?:^|\/)(?:include|inc|headers?|public)(?:\/|$)/i.test(item));
    const selectedHeaders = publicHeaders.length ? publicHeaders : headers.filter((item) => !item.includes('/')).slice(0, 80);
    const sourceFiles = files.filter((item) => SOURCE.test(item) && !isProtected(item));
    const content = new Map<string, string>();
    for (const file of [...new Set([...docs, ...ci, ...make, ...cmake, ...meson, ...configure, ...scripts, ...additionalBuilds.map(item => item.file), ...selectedHeaders, ...sourceFiles.slice(0, 500), ...tests.slice(0, 100), ...benchmarks.slice(0, 100), ...references.slice(0, 50)])].slice(0, 1200)) {
      try { content.set(file, this.readFile(file)); } catch { continue; }
    }
    const buildRequirements = inspectBuildRequirements(files, content);
    const candidates = new Map<string, FunctionCandidate>();
    for (const header of selectedHeaders) {
      const text = content.get(header) ?? '';
      const prototype = /(?:^|[;{}\n])\s*(?:extern\s+)?(?:[A-Za-z_][\w\s*]*?\s+)([A-Za-z_]\w*)\s*\([^;{}]*\)\s*;/gm;
      for (const match of text.matchAll(prototype)) {
        const symbol = match[1];
        if (!symbol || !IDENTIFIER.test(symbol) || /^(?:if|for|while|switch|return|typedef)$/.test(symbol)) continue;
        if (!candidates.has(symbol)) candidates.set(symbol, { symbol, public_api: symbol, header, implementation_files: [], architecture_files: [], call_path: [header], confidence: 'MEDIUM' });
      }
    }
    const symbolsInFile = new Map<string, Set<string>>();
    const symbols = (file: string): Set<string> => {
      if (!symbolsInFile.has(file)) symbolsInFile.set(file, new Set([...((content.get(file) ?? '').matchAll(/\b([A-Za-z_]\w*)\s*\(/g))].map(match => match[1])));
      return symbolsInFile.get(file)!;
    };
    const occurrences = new Map<string, string[]>();
    const byBasename = new Map<string, string[]>();
    const sourceOrder = new Map(sourceFiles.map((file, index) => [file, index]));
    for (const file of sourceFiles) {
      const basename = path.posix.basename(file).replace(/\.(?:c|cc|cpp|cxx|s|S)$/, '');
      byBasename.set(basename, [...(byBasename.get(basename) ?? []), file]);
      for (const symbol of symbols(file)) if (candidates.has(symbol)) occurrences.set(symbol, [...(occurrences.get(symbol) ?? []), file]);
    }
    for (const candidate of candidates.values()) {
      const implementations = new Set([...(occurrences.get(candidate.symbol) ?? []), ...(byBasename.get(candidate.symbol) ?? [])]);
      for (let index = candidate.symbol.indexOf('_'); index >= 0; index = candidate.symbol.indexOf('_', index + 1)) {
        for (const file of byBasename.get(candidate.symbol.slice(0, index)) ?? []) implementations.add(file);
      }
      candidate.implementation_files = [...implementations].sort((left, right) => sourceOrder.get(left)! - sourceOrder.get(right)!).slice(0, 30);
      candidate.architecture_files = candidate.implementation_files.filter((file) => /(?:arm|aarch|x86|avx|neon|simd|kernel|asm)/i.test(file));
      candidate.call_path = [candidate.header!, ...candidate.implementation_files];
      candidate.confidence = candidate.implementation_files.length ? 'HIGH' : 'LOW';
    }
    const dependencies = new Set<string>();
    const metadata = [...docs, ...ci, ...make, ...cmake, ...meson, ...configure, ...scripts, ...additionalBuilds.map(item => item.file)];
    const versionClues: Array<{ path: string; value: string }> = [];
    for (const candidate of buildCandidates) {
      const expression = new RegExp('\\b' + candidate.kind + '\\b', 'i');
      candidate.evidence.push(...[...docs, ...ci].filter((file) => expression.test(content.get(file) ?? '')));
    }
    for (const file of metadata) {
      const text = content.get(file) ?? '';
      for (const match of text.matchAll(/\b(?:gcc|clang|g\+\+|cmake|meson|ninja|pkg-config|openmp|pthread|blas|lapack)\b/gi)) dependencies.add(match[0].toLowerCase());
      const version = text.match(/\b(?:version\s*[:=]?\s*|project\s*\([^)]*\bVERSION\s+)(\d+\.\d+(?:\.\d+)?)/i)?.[1];
      if (version) versionClues.push({ path: file, value: version });
    }
    const languages = [...new Set(files.flatMap((file) => /\.(?:c|h)$/.test(file) ? ['C'] : /\.(?:cc|cpp|cxx|hpp)$/.test(file) ? ['C++'] : /\.(?:s|S)$/.test(file) ? ['Assembly'] : /\.rs$/.test(file) ? ['Rust'] : /\.go$/.test(file) ? ['Go'] : /\.py$/.test(file) ? ['Python'] : []))];
    const testAssets = tests.map((file) => {
      const text = content.get(file) ?? '';
      return { path: file, assertion_clues: [
        ...( /\bassert\s*\(/.test(text) ? ['assert'] : []),
        ...( /(?:==|!=|fabs|EXPECT_|CHECK_)/.test(text) ? ['comparison'] : []),
      ] };
    });
    const benchmarkAssets = benchmarks.map((file) => {
      const text = content.get(file) ?? '';
      return {
        path: file,
        argument_clues: [...new Set([...text.matchAll(/\b(?:argc|argv|getopt)\b/g)].map((match) => match[0]))],
        output_clues: [...new Set([...text.matchAll(/\b(?:printf|fprintf|cout|write)\b/g)].map((match) => match[0]))],
        workload_clues: [
          ...( /\bfor\s*\(/.test(text) ? ['loop'] : []),
          ...[...candidates.keys()].filter(symbol => symbols(file).has(symbol)).slice(0, 10),
        ],
      };
    });
    const unknowns: string[] = [];
    if (!buildCandidates.length) unknowns.push('Build command is UNKNOWN; no supported build definition found.');
    if (!candidates.size) unknowns.push('Public API is UNKNOWN; no C/C++ public function declarations found.');
    unknowns.push(references.length
      ? 'Reference candidates were found, but an independent correctness oracle remains UNVERIFIED.'
      : 'Independent correctness oracle is UNKNOWN.');
    if (!benchmarks.length) unknowns.push('No existing benchmark asset found.');
    unknowns.push('Build commands, target compatibility, workloads, baseline, tolerance and acceptance policy require human verification.');
    return {
      repository: { path: this.root, name: path.basename(this.root), ...this.inspectGit() }, files,
      inspected_files: this.inspectedFiles(),
      build_candidates: buildCandidates, build_requirements: buildRequirements, functions: [...candidates.values()].slice(0, 5000), tests, benchmarks,
      test_assets: testAssets, benchmark_assets: benchmarkAssets, references,
      dependencies: [...dependencies], version_clues: versionClues, languages,
      public_headers: publicHeaders.length ? publicHeaders : selectedHeaders, unknowns,
    };
  }

  assertUnchanged(): void {
    for (const file of this.inspected.values()) {
      const absolute = path.join(this.root, ...file.path.split('/'));
      if (fs.lstatSync(absolute).isSymbolicLink() || fs.realpathSync(absolute) !== absolute || sha256(fs.readFileSync(absolute)) !== file.sha256) {
        throw new Error(`repository changed during onboarding: ${file.path}`);
      }
    }
  }
}
