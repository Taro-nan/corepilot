import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Check, Errors } from 'typebox/value';
import type { TSchema } from 'typebox';
import {
  BinaryBundleBaselineDefinitionSchema,
  LibraryPackageManifestSchema,
  LibraryPackageSelectionSchema,
  PackageBuildDefinitionSchema,
  type BinaryBundleBaselineDefinition,
  type CandidateSourceScope,
  type LibraryPackageManifest,
  type LibraryPackageSelection,
  type LibraryPackageTarget,
  type LoadedLibraryPackage,
  type PackageBuildDefinition,
} from '../contracts/library-package.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import type { LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';

export class LibraryPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryPackageError';
  }
}

function validate(schema: TSchema, value: unknown, label: string): void {
  if (!Check(schema, value)) throw new LibraryPackageError(`${label}: ${JSON.stringify(Errors(schema, value))}`);
}

export function validateLibraryPackageManifest(value: unknown): LibraryPackageManifest {
  validate(LibraryPackageManifestSchema, value, 'invalid library package manifest');
  const manifest = value as LibraryPackageManifest;
  unique(manifest.functions.map((item) => item.function_id), 'function_id');
  unique(manifest.targets.map((item) => item.target_id), 'target_id');
  unique(manifest.build_definitions.map((item) => item.build_id), 'build_id');
  unique(manifest.formal_evaluators.map((item) => `${item.evaluator_id}@${item.version}`), 'evaluator identity');
  for (const target of manifest.targets) {
    if (!manifest.functions.some((item) => item.function_id === target.function_id)) throw new LibraryPackageError(`unknown function '${target.function_id}'`);
    if (!manifest.build_definitions.some((item) => item.build_id === target.build_id)) throw new LibraryPackageError(`unknown build '${target.build_id}'`);
    for (const reference of [target.evaluator, target.development_benchmark.evaluator]) {
      if (!manifest.formal_evaluators.some((item) => item.evaluator_id === reference.evaluator_id && item.version === reference.evaluator_version)) {
        throw new LibraryPackageError(`unknown evaluator '${reference.evaluator_id}@${reference.evaluator_version}'`);
      }
    }
    if (target.development_benchmark.evaluator.evaluator_id !== target.evaluator.evaluator_id ||
        target.development_benchmark.evaluator.evaluator_version !== target.evaluator.evaluator_version) {
      throw new LibraryPackageError('v1 development benchmark must use the target evaluator');
    }
  }
  return structuredClone(manifest);
}

export function validateLibraryPackageSelection(value: unknown): LibraryPackageSelection {
  validate(LibraryPackageSelectionSchema, value, 'invalid library package selection');
  const selection = value as LibraryPackageSelection;
  if ((selection.evaluator_id === undefined) !== (selection.evaluator_version === undefined)) {
    throw new LibraryPackageError('evaluator_id and evaluator_version must be provided together');
  }
  return structuredClone(selection);
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new LibraryPackageError(`duplicate ${label}`);
}

export function binaryBundleIdentitySha256(definition: Pick<BinaryBundleBaselineDefinition, 'headers' | 'libraries'>): string {
  const hash = createHash('sha256');
  for (const file of [...definition.headers, ...definition.libraries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function validateBinaryBundleBaselineDefinition(value: unknown): BinaryBundleBaselineDefinition {
  validate(BinaryBundleBaselineDefinitionSchema, value, 'invalid binary bundle baseline definition');
  const definition = value as BinaryBundleBaselineDefinition;
  const files = [...definition.headers, ...definition.libraries];
  unique(files.map((item) => item.path), 'binary bundle file path');
  unique(definition.libraries.map((item) => item.soname), 'binary bundle SONAME');
  if (!definition.libraries.some((item) => item.role === 'ENTRY')) throw new LibraryPackageError('binary bundle requires an entry library');
  if (definition.sha256 !== binaryBundleIdentitySha256(definition)) throw new LibraryPackageError('binary bundle aggregate digest differs from file identities');
  const sonames = new Set(definition.libraries.map((item) => item.soname));
  for (const library of definition.libraries) {
    if (library.soname.includes('/') || library.soname.includes('\\')) throw new LibraryPackageError('binary bundle SONAME must be a filename');
    unique(library.needed.map((item) => item.soname), `dependencies of ${library.soname}`);
    for (const dependency of library.needed) {
      if (dependency.classification === 'BUNDLED_DEPENDENCY' && !sonames.has(dependency.soname)) {
        throw new LibraryPackageError(`undeclared bundled dependency '${dependency.soname}'`);
      }
      if (dependency.classification === 'MISSING_DEPENDENCY' && definition.state !== 'INVALID') {
        throw new LibraryPackageError('missing dependency requires INVALID baseline state');
      }
    }
  }
  if (definition.dependency_closure.status === 'INVALID' && definition.state !== 'INVALID') {
    throw new LibraryPackageError('invalid dependency closure requires INVALID baseline state');
  }
  if (definition.dependency_closure.status === 'VALID' &&
      (!definition.dependency_closure.target_machine || !definition.dependency_closure.checked_at ||
       definition.libraries.some((item) => item.needed.some((dependency) => dependency.classification === 'MISSING_DEPENDENCY')))) {
    throw new LibraryPackageError('valid dependency closure requires a target check and no missing dependencies');
  }
  if (definition.state === 'VERIFIED') {
    if (definition.dependency_closure.status !== 'VALID') throw new LibraryPackageError('VERIFIED binary bundle requires valid target dependency closure');
    const resolved = new Map(definition.dependency_closure.resolved_libraries.map((item) => [item.soname, item.sha256]));
    for (const library of definition.libraries) {
      if (resolved.get(library.soname) !== library.sha256) throw new LibraryPackageError(`unverified runtime library '${library.soname}'`);
    }
  }
  return structuredClone(definition);
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name === right.name ? 0 : left.name < right.name ? -1 : 1;
}

function containedPath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) {
    throw new LibraryPackageError(`path must be relative and contained: ${relative}`);
  }
  const absolute = path.resolve(root, relative);
  const resolvedRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(absolute);
  const outside = path.relative(resolvedRoot, resolved);
  if (outside.startsWith('..') || path.isAbsolute(outside)) throw new LibraryPackageError(`path escapes root: ${relative}`);
  let current = path.resolve(root);
  for (const segment of relative.split('/').filter((item) => item !== '.' && item !== '')) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new LibraryPackageError(`symbolic link is not allowed: ${relative}`);
  }
  return absolute;
}

function readJson(filename: string): unknown {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { throw new LibraryPackageError(`cannot read ${filename}: ${(error as Error).message}`); }
}

function contentDigest(root: string): string {
  const hash = createHash('sha256');
  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort(byName)) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new LibraryPackageError(`symbolic link is not allowed: ${filename}`);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        hash.update(path.relative(root, filename).split(path.sep).join('/'));
        hash.update('\0');
        hash.update(fs.readFileSync(filename));
        hash.update('\0');
      } else throw new LibraryPackageError(`unsupported package asset: ${filename}`);
    }
  }
  visit(root);
  return hash.digest('hex');
}

export class LibraryPackageLoader {
  readonly packagesRoot: string;
  readonly evaluatorsRoot: string;

  constructor(options: { packagesRoot?: string; evaluatorsRoot?: string } = {}) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    this.packagesRoot = path.resolve(options.packagesRoot ?? path.join(repositoryRoot, 'packages'));
    this.evaluatorsRoot = path.resolve(options.evaluatorsRoot ?? path.join(repositoryRoot, 'evaluators'));
  }

  listPackages(): Array<{ package_id: string; version: string; owner: string; qualification: LibraryPackageManifest['qualification'] }> {
    if (!fs.existsSync(this.packagesRoot)) return [];
    const packages = [];
    for (const packageEntry of fs.readdirSync(this.packagesRoot, { withFileTypes: true }).sort(byName)) {
      if (!packageEntry.isDirectory()) continue;
      for (const versionEntry of fs.readdirSync(path.join(this.packagesRoot, packageEntry.name), { withFileTypes: true }).sort(byName)) {
        if (!versionEntry.isDirectory()) continue;
        const loaded = this.loadPackage(packageEntry.name, versionEntry.name);
        const { package_id, version, owner, qualification } = loaded.manifest;
        packages.push({ package_id, version, owner, qualification });
      }
    }
    return packages;
  }

  loadPackage(packageId: string, packageVersion: string): LoadedLibraryPackage {
    validateLibraryPackageSelection({ package_id: packageId, package_version: packageVersion, target_id: 'identity-check' });
    const root = containedPath(this.packagesRoot, `${packageId}/${packageVersion}`);
    const manifest = validateLibraryPackageManifest(readJson(containedPath(root, 'package.json')));
    if (manifest.package_id !== packageId || manifest.version !== packageVersion) throw new LibraryPackageError('package directory and manifest identity differ');
    const builds: Record<string, PackageBuildDefinition> = {};
    for (const definition of manifest.build_definitions) {
      const build = readJson(containedPath(root, definition.definition));
      validate(PackageBuildDefinitionSchema, build, `invalid build '${definition.build_id}'`);
      builds[definition.build_id] = build as PackageBuildDefinition;
    }
    const binaryBaselines: Record<string, BinaryBundleBaselineDefinition> = {};
    for (const target of manifest.targets) {
      const baseline = target.artifacts.baseline;
      if (!('kind' in baseline) || baseline.kind !== 'binary_bundle') continue;
      const definition = validateBinaryBundleBaselineDefinition(readJson(containedPath(root, baseline.definition)));
      if (definition.baseline_id !== baseline.id || definition.version !== baseline.version || definition.sha256 !== baseline.sha256) {
        throw new LibraryPackageError(`binary bundle identity differs from target '${target.target_id}'`);
      }
      binaryBaselines[target.target_id] = definition;
    }
    return { root, manifest, builds, binary_baselines: binaryBaselines, content_digest: contentDigest(root) };
  }

  listTargets(loaded: LoadedLibraryPackage): LibraryPackageTarget[] {
    return structuredClone(loaded.manifest.targets);
  }

  listFunctions(loaded: LoadedLibraryPackage): LibraryPackageManifest['functions'] {
    return structuredClone(loaded.manifest.functions);
  }

  resolveTarget(loaded: LoadedLibraryPackage, targetId: string): LibraryPackageTarget {
    const target = loaded.manifest.targets.find((item) => item.target_id === targetId);
    if (!target) throw new LibraryPackageError(`unknown target '${targetId}'`);
    return structuredClone(target);
  }

  resolveBuildDefinition(loaded: LoadedLibraryPackage, targetId: string): PackageBuildDefinition {
    return structuredClone(loaded.builds[this.resolveTarget(loaded, targetId).build_id]);
  }

  resolveCandidateScope(loaded: LoadedLibraryPackage, targetId: string): CandidateSourceScope {
    return this.resolveTarget(loaded, targetId).candidate_scope;
  }

  resolveBinaryBaseline(loaded: LoadedLibraryPackage, targetId: string): BinaryBundleBaselineDefinition | null {
    this.resolveTarget(loaded, targetId);
    return loaded.binary_baselines[targetId] ? structuredClone(loaded.binary_baselines[targetId]) : null;
  }

  resolveEvaluator(loaded: LoadedLibraryPackage, evaluatorId: string, evaluatorVersion: string, options: { requireQualified?: boolean } = {}): LoadedFormalEvaluatorBundle {
    const definition = loaded.manifest.formal_evaluators.find((item) => item.evaluator_id === evaluatorId && item.version === evaluatorVersion);
    if (!definition) throw new LibraryPackageError(`unknown evaluator '${evaluatorId}@${evaluatorVersion}'`);
    const bundle = loadFormalEvaluatorBundle(containedPath(this.evaluatorsRoot, definition.catalog_path), {
      requireQualified: options.requireQualified ?? false,
      expected: { evaluatorId, version: evaluatorVersion, digest: definition.digest },
    });
    if (bundle.manifest.owner !== definition.owner) throw new LibraryPackageError('evaluator owner differs from package reference');
    return bundle;
  }

  resolveSelection(input: LibraryPackageSelection, options: { requireQualified?: boolean } = {}) {
    const selection = validateLibraryPackageSelection(input);
    const loaded = this.loadPackage(selection.package_id, selection.package_version);
    const target = this.resolveTarget(loaded, selection.target_id);
    if ((selection.evaluator_id !== undefined && selection.evaluator_id !== target.evaluator.evaluator_id) ||
        (selection.evaluator_version !== undefined && selection.evaluator_version !== target.evaluator.evaluator_version)) {
      throw new LibraryPackageError('selected evaluator differs from target evaluator');
    }
    const bundle = this.resolveEvaluator(loaded, target.evaluator.evaluator_id, target.evaluator.evaluator_version, options);
    const functionDefinition = loaded.manifest.functions.find((item) => item.function_id === target.function_id)!;
    if (functionDefinition.api !== bundle.manifest.domain.api) throw new LibraryPackageError('target function API differs from evaluator API');
    for (const workloadId of target.development_benchmark.workload_ids) {
      if (!bundle.manifest.performance.workload_ids.includes(workloadId)) throw new LibraryPackageError(`unknown development workload '${workloadId}'`);
    }
    return { loaded, target, functionDefinition, bundle, build: this.resolveBuildDefinition(loaded, target.target_id) };
  }
}
