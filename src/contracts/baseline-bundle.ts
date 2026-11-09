/** Files uploaded for one external library baseline. Paths are relative to bundle_root. */
export interface BaselineBundleFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RunnerBundleInspectionRequest {
  bundle_root: string;
  entry_path: string;
  files: BaselineBundleFile[];
}

export interface RunnerBundleInspection {
  ok: boolean;
  machine_identity_sha256: string;
  checked_at: string;
  entry_sha256: string;
  libraries: Array<{
    path: string;
    sha256: string;
    soname: string;
    elf: { class: string; endian: string; machine: string; build_id: string };
    needed: Array<{ soname: string; classification: 'BUNDLED_DEPENDENCY' | 'SYSTEM_DEPENDENCY' | 'MISSING_DEPENDENCY' }>;
  }>;
  resolved_libraries: Array<{ soname: string; path: string; sha256: string }>;
  issues: string[];
}

export interface BaselineImportSession {
  schema_version: 1;
  project_id: string;
  bundle_id: string;
  package_id: string;
  package_version: string;
  target_id: string;
  library: string;
  library_version: string;
  created_at: string;
  expected_selection_key?: string;
}

export interface BaselineImportCheck {
  entry_path: string;
  files: BaselineBundleFile[];
  state: 'CHECKING' | 'READY' | 'CHECK_FAILED' | 'NEEDS_RECHECK';
  machine: { id: string | null; revision: number | null; name: string; connection_key: string };
  inspection: RunnerBundleInspection | null;
  error: string | null;
}

export interface BaselineImportStatus extends BaselineImportSession {
  files: BaselineBundleFile[];
  entries: string[];
  state: 'UPLOADING' | BaselineImportCheck['state'] | 'BOUND';
  check: BaselineImportCheck | null;
  result: unknown | null;
}
