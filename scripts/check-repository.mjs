import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import ts from 'typescript';
import { staleCompiledFiles } from './prune-dist.mjs';

const root = path.resolve(import.meta.dirname, '..');
const slash = value => value.split(path.sep).join('/');
const problems = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isSymbolicLink() ? []
    : entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

// Check actual working files, including new files that have not been staged.
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}).split('\0').filter(file => file && fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile()))];

// Ignore rules do not remove files already tracked by Git. Machine-specific
// configuration and local runtime state must not enter a fresh checkout.
const trackedFiles = execFileSync('git', ['ls-files', '--cached', '-z'], {
  cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}).split('\0').filter(Boolean);
for (const file of trackedFiles) {
  if (file === 'corepilot.yaml' || /^(?:\.tmp-model-test|\.corepilot|corepilot-data)\//.test(file)) {
    problems.push(`Machine-specific configuration or runtime data must not be tracked: ${file}`);
  }
}

// Keep this intentionally small: it catches repository-wide formatting and
// unresolved merges without pretending to be a semantic TypeScript linter.
for (const file of files.filter(file => /^(?:src|web\/src|tests|scripts)\/.*\.(?:ts|tsx|mjs)$/.test(file))) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (/[\t ]+$/.test(lines[index])) problems.push(`Trailing whitespace: ${file}:${index + 1}`);
    if (/^(?:<{7}(?:\s|$)|={7}$|>{7}(?:\s|$))/.test(lines[index])) problems.push(`Unresolved merge marker: ${file}:${index + 1}`);
  }
}

const tests = [...walk(path.join(root, 'tests')), ...walk(path.join(root, 'web', 'tests'))].map(file => slash(path.relative(root, file)));
const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, encoding: 'utf8', input: tests.join('\n') + '\n', windowsHide: true });
if (ignored.error || ignored.status !== 0 && ignored.status !== 1) throw new Error(ignored.error?.message ?? ignored.stderr);
if (ignored.status === 0) problems.push(`Tests/fixtures must be trackable:\n${ignored.stdout.trim()}`);

const configuration = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (configuration.error) throw new Error(ts.flattenDiagnosticMessageText(configuration.error.messageText, '\n'));
const options = ts.parseJsonConfigFileContent(configuration.config, ts.sys, root).options;
const graph = new Map();
const importSpecifiers = new Map();
const moduleFiles = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'web', 'src')), ...walk(path.join(root, 'extensions', 'vscode', 'src'))].filter(file => /\.tsx?$/.test(file));
for (const file of moduleFiles) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = [];
  const specifiers = [];
  function visit(node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : null;
    if (specifier && ts.isStringLiteralLike(specifier)) {
      specifiers.push(specifier.text);
      const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (resolved && !path.relative(root, path.resolve(resolved)).startsWith('..')) imports.push(slash(path.relative(root, path.resolve(resolved))));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const relative = slash(path.relative(root, file));
  graph.set(relative, imports); importSpecifiers.set(relative, specifiers);
}
const visited = new Set();
function visit(file) { if (visited.has(file)) return; visited.add(file); for (const dependency of graph.get(file) ?? []) visit(dependency); }
// Add a root here only when it is an actual public program entry point.
for (const entry of ['src/entry.ts', 'src/runner-entry.ts', 'web/src/main.tsx', 'extensions/vscode/src/extension.ts']) visit(entry);
for (const file of graph.keys()) if (file.startsWith('src/') && !visited.has(file)) problems.push(`Source module is unreachable from product entries: ${file}. Check dynamic registrations before removing it; test helpers belong in tests/.`);

// Verification is shared by reports and the delivery entry point. Keep this
// decision independent of storage, UI, SDK and transport implementations.
const verificationModule = 'src/core/candidate-verification.ts';
if (!graph.has(verificationModule)) problems.push(`Missing shared candidate verification: ${verificationModule}`);
for (const specifier of importSpecifiers.get(verificationModule) ?? []) {
  if (!specifier.startsWith('../contracts/')) problems.push(`Candidate verification may import only contracts: ${specifier}`);
}
for (const dependency of graph.get(verificationModule) ?? []) {
  if (!dependency.startsWith('src/contracts/')) problems.push(`Candidate verification may depend only on contracts: ${dependency}`);
}
for (const caller of ['src/report/customer-summary.ts', 'src/application/workflow-delivery-service.ts']) {
  if (!graph.get(caller)?.includes(verificationModule)) problems.push(`${caller} must use shared candidate verification`);
}

// Independent tests must use the shared measurement/statistics path. HTTP only
// adapts input/output; it must not acquire Runner or storage responsibilities.
const testingResults = 'src/application/testing-results.ts';
if (!graph.get(testingResults)?.includes('src/evaluator/performance-statistics.ts')) problems.push('Independent testing results must use shared performance statistics');
for (const dependency of graph.get(testingResults) ?? []) {
  if (!dependency.startsWith('src/contracts/') && dependency !== 'src/evaluator/performance-statistics.ts') problems.push(`Testing results cannot depend on execution, transport or storage: ${dependency}`);
}
for (const dependency of graph.get('src/http/testing-routes.ts') ?? []) {
  if (/^src\/(?:runner|storage|evaluator|workflow|workspace)\//.test(dependency)) problems.push(`Testing HTTP must call its application service: ${dependency}`);
}

let checkedLinks = 0;
for (const file of files.filter(file => file.endsWith('.md'))) {
  let fence = null;
  for (const line of fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { fence = fence === null ? marker[1][0] : marker[1][0] === fence ? null : fence; continue; }
    if (fence) continue;
    for (const match of line.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const raw = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(raw)) continue;
      const target = path.resolve(root, path.dirname(file), decodeURIComponent(raw.split('#')[0]));
      if (path.relative(root, target).startsWith('..')) continue; // The primary constitution and local evidence may live outside this clone.
      checkedLinks++;
      if (!fs.existsSync(target)) problems.push(`Broken local link: ${file} -> ${raw}`);
    }
  }
}
for (const filename of staleCompiledFiles(root)) problems.push(`Obsolete compiled output: ${slash(path.relative(root, filename))}; run npm run build.`);
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Repository OK: ${graph.size} modules, ${tests.length} test/fixture files, ${checkedLinks} local links; no unreachable src modules or obsolete compiled files.`);
