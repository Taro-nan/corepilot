import fs from 'node:fs';
import path from 'node:path';
import { generatedTestEntrypoint } from '../src/application/validation-python-harness.js';
import type { startWebFixture } from './web-fixture.js';
import type { prepareReviewFixture } from './validation-review-fixture.js';

export function seedLegacyDraft(f: Awaited<ReturnType<typeof startWebFixture>>, r: Awaited<ReturnType<typeof prepareReviewFixture>>) {
  const draft = f.projects.validationAssets.get(r.project, r.pkg, r.version, r.target);
  return f.projects.validationAssets.save(r.project, r.pkg, r.version, r.target, { ...draft, source: 'edited',
    expected_digest: draft.evaluator_digest, correctness_script: generatedTestEntrypoint('correctness'),
    supporting_files: [{ path: 'support/corepilot_test.py', content: 'class TestContext:\n    def identity(self):\n        return {"input_path": self.artifact_path, "resolved_symbol_path": self.artifact_path}\n' },
      { path: 'support/test-correctness.py', content: 'from corepilot_test import TestContext\n' }] });
}

// Simulates a previously qualified record in a temporary catalog. It is not a
// human decision, actual target run, or performance evidence.
export function seedHistoricalQualification(f: Awaited<ReturnType<typeof startWebFixture>>,
  r: Awaited<ReturnType<typeof prepareReviewFixture>>, legacy: boolean) {
  if (legacy) seedLegacyDraft(f, r);
  const selection = { package_id: r.pkg, package_version: r.version, target_id: r.target };
  const resolved = f.projects.packageLoader.resolveSelection(selection);
  const qualificationPath = path.join(resolved.bundle.root, 'qualification.json');
  const packagePath = path.join(resolved.loaded.root, 'package.json');
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
  const now = '2026-01-02T00:00:00.000Z';
  Object.assign(qualification, { status: 'QUALIFIED', reviewer: 'Historical fixture reviewer', approved_at: now,
    target: { ...qualification.target, machine_identity_sha256: 'a'.repeat(64) },
    qualification_run: { run_id: 'validation:historical-fixture', result: 'TARGET_EXECUTION_PASSED', started_at: now, completed_at: now },
    evidence: { report_sha256: 'b'.repeat(64), raw_measurements_sha256: 'c'.repeat(64) },
    checks: qualification.checks.map((check: Record<string, unknown>) => ({ ...check, status: 'PASS' })) });
  fs.writeFileSync(qualificationPath, JSON.stringify(qualification));
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  manifest.qualification = { state: 'QUALIFIED', reviewer: qualification.reviewer, reviewed_at: now };
  fs.writeFileSync(packagePath, JSON.stringify(manifest));
  return { selection, qualificationPath, packagePath,
    resolved: f.projects.packageLoader.resolveSelection(selection, { requireQualified: true }) };
}
