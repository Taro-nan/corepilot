import { Type, type Static } from 'typebox';

export const LIBRARY_PACKAGE_SCHEMA_VERSION = 1;

const text = Type.String({ minLength: 1, pattern: '\\S' });
const identifier = Type.String({ pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' });
const version = Type.String({ pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const relativePath = Type.String({ pattern: '^(?![A-Za-z]:)(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\x00]+$' });
const strings = Type.Array(text, { minItems: 1, uniqueItems: true });
const evaluatorReference = Type.Object({ evaluator_id: identifier, evaluator_version: version }, { additionalProperties: false });

export const LibraryPackageSelectionSchema = Type.Object({
  package_id: identifier,
  package_version: version,
  target_id: identifier,
  evaluator_id: Type.Optional(identifier),
  evaluator_version: Type.Optional(version),
}, { additionalProperties: false });

export const CandidateSourceScopeSchema = Type.Object({
  include: Type.Array(relativePath, { minItems: 1, uniqueItems: true }),
  exclude: Type.Array(relativePath, { uniqueItems: true }),
}, { additionalProperties: false });

export const PackageBuildDefinitionSchema = Type.Object({
  executable: text,
  args: Type.Array(Type.String()),
  cwd: relativePath,
  environment: Type.Record(Type.String(), Type.String()),
  timeout_ms: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const BinaryBundleBaselineDefinitionSchema = Type.Object({
  schema_version: Type.Literal(1),
  baseline_id: identifier,
  version: text,
  kind: Type.Literal('binary_bundle'),
  state: Type.Union([Type.Literal('DRAFT'), Type.Literal('VERIFIED'), Type.Literal('INVALID')]),
  digest_algorithm: Type.Literal('sha256-file-identities-v1'),
  sha256: digest,
  headers: Type.Array(Type.Object({ path: relativePath, sha256: digest }, { additionalProperties: false }), { minItems: 1 }),
  libraries: Type.Array(Type.Object({
    path: relativePath,
    role: Type.Union([Type.Literal('ENTRY'), Type.Literal('BUNDLED_DEPENDENCY'), Type.Literal('OTHER')]),
    sha256: digest,
    soname: text,
    elf: Type.Object({ class: text, endian: text, machine: text, build_id: text }, { additionalProperties: false }),
    needed: Type.Array(Type.Object({
      soname: text,
      classification: Type.Union([Type.Literal('BUNDLED_DEPENDENCY'), Type.Literal('SYSTEM_DEPENDENCY'), Type.Literal('MISSING_DEPENDENCY')]),
    }, { additionalProperties: false }), { uniqueItems: true }),
  }, { additionalProperties: false }), { minItems: 1 }),
  loader_environment: Type.Object({ mechanism: Type.Literal('LD_LIBRARY_PATH'), search_paths: Type.Array(relativePath, { minItems: 1, uniqueItems: true }) }, { additionalProperties: false }),
  target_compatibility: strings,
  dependency_closure: Type.Object({
    status: Type.Union([Type.Literal('UNVERIFIED'), Type.Literal('VALID'), Type.Literal('INVALID')]),
    target_machine: Type.Union([text, Type.Null()]),
    checked_at: Type.Union([text, Type.Null()]),
    resolved_libraries: Type.Array(Type.Object({ soname: text, path: text, sha256: digest }, { additionalProperties: false })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const SingleArtifactBaselineSchema = Type.Object({ id: identifier, library: text, version: text, sha256: digest }, { additionalProperties: false });
const BinaryBundleBaselineReferenceSchema = Type.Object({
  id: identifier, library: text, version: text, sha256: digest,
  kind: Type.Literal('binary_bundle'), definition: relativePath,
}, { additionalProperties: false });

export const LibraryPackageManifestSchema = Type.Object({
  schema_version: Type.Literal(LIBRARY_PACKAGE_SCHEMA_VERSION),
  package_id: identifier,
  version,
  owner: text,
  library: Type.Object({
    name: text,
    source_compatibility: strings,
    target_compatibility: strings,
  }, { additionalProperties: false }),
  qualification: Type.Object({
    state: Type.Union((['DRAFT', 'REVIEWED', 'QUALIFIED', 'REJECTED', 'SUPERSEDED'] as const).map((state) => Type.Literal(state))),
    reviewer: Type.Union([text, Type.Null()]),
    reviewed_at: Type.Union([text, Type.Null()]),
  }, { additionalProperties: false }),
  functions: Type.Array(Type.Object({ function_id: identifier, api: text }, { additionalProperties: false }), { minItems: 1 }),
  build_definitions: Type.Array(Type.Object({ build_id: identifier, definition: relativePath }, { additionalProperties: false }), { minItems: 1 }),
  formal_evaluators: Type.Array(Type.Object({
    evaluator_id: identifier, version, owner: text, digest, catalog_path: relativePath,
  }, { additionalProperties: false }), { minItems: 1 }),
  targets: Type.Array(Type.Object({
    target_id: identifier,
    function_id: identifier,
    build_id: identifier,
    evaluator: evaluatorReference,
    candidate_scope: CandidateSourceScopeSchema,
    development_benchmark: Type.Object({ evaluator: evaluatorReference, workload_ids: strings }, { additionalProperties: false }),
    artifacts: Type.Object({
      candidate: Type.Object({ artifact_id: identifier, relative_path: relativePath }, { additionalProperties: false }),
      baseline: Type.Union([SingleArtifactBaselineSchema, BinaryBundleBaselineReferenceSchema]),
    }, { additionalProperties: false }),
    performance_acceptance: Type.Object({
      weighted_geomean_min: Type.Number({ exclusiveMinimum: 0 }),
      overall_ci_lower_min: Type.Number({ exclusiveMinimum: 0 }),
      key_case_ci_lower_min: Type.Number({ exclusiveMinimum: 0 }),
      confidence_level: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
    }, { additionalProperties: false }),
    analysis_sampling: Type.Object({
      interleave_seed: Type.Integer({ minimum: 0 }),
      bootstrap_iterations: Type.Integer({ minimum: 100 }),
    }, { additionalProperties: false }),
    domain_payload: Type.Record(Type.String(), Type.Unknown()),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export type LibraryPackageSelection = Static<typeof LibraryPackageSelectionSchema>;
export type LibraryPackageManifest = Static<typeof LibraryPackageManifestSchema>;
export type LibraryPackageTarget = LibraryPackageManifest['targets'][number];
export type CandidateSourceScope = Static<typeof CandidateSourceScopeSchema>;
export type PackageBuildDefinition = Static<typeof PackageBuildDefinitionSchema>;
export type BinaryBundleBaselineDefinition = Static<typeof BinaryBundleBaselineDefinitionSchema>;

export interface LibraryPackageTaskReference {
  package_id: string;
  package_version: string;
  package_digest: string;
  target_id: string;
  function_id: string;
  evaluator_id: string;
  evaluator_version: string;
}

export interface LoadedLibraryPackage {
  root: string;
  manifest: LibraryPackageManifest;
  content_digest: string;
  builds: Record<string, PackageBuildDefinition>;
  binary_baselines: Record<string, BinaryBundleBaselineDefinition>;
}
