#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: qualify-on-target.sh CANDIDATE_LIBRARY BASELINE_LIBRARY OUTPUT_ROOT" >&2
  exit 64
fi

source_bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
candidate_source="$(realpath "$1")"
baseline_source="$(realpath "$2")"
mkdir -p -- "$3"
output_root="$(cd "$3" && pwd -P)"

case "$output_root/" in
  "$source_bundle_root/"*)
    echo "qualification output must be outside the evaluator bundle" >&2
    exit 64
    ;;
esac

node "$source_bundle_root/scripts/qualification-runner.mjs" verify-content "$source_bundle_root" \
  >"$output_root/source-content-verification.json"

stage_root="$output_root/staged"
staged_bundle="$stage_root/evaluator"
staged_artifacts="$stage_root/artifacts"
if [[ -e "$stage_root" ]]; then
  echo "qualification staging path already exists: $stage_root" >&2
  exit 73
fi
mkdir -p -- "$staged_bundle" "$staged_artifacts"
cp -a -- "$source_bundle_root/." "$staged_bundle/"
cp -- "$candidate_source" "$staged_artifacts/candidate.so"
cp -- "$baseline_source" "$staged_artifacts/baseline.so"

candidate_digest="$(sha256sum "$candidate_source" | awk '{print $1}')"
baseline_digest="$(sha256sum "$baseline_source" | awk '{print $1}')"
candidate_expected="${PHYOPT_CANDIDATE_SHA256:-$candidate_digest}"
baseline_expected="${PHYOPT_BASELINE_SHA256:-$baseline_digest}"

node "$staged_bundle/scripts/qualification-runner.mjs" verify-content "$staged_bundle" \
  >"$output_root/preflight-content-verification.json"

set +e
PHYOPT_RUNNER_VERSION="${PHYOPT_RUNNER_VERSION:-phyopt-agent-0.4.0}" \
  node "$staged_bundle/scripts/qualification-runner.mjs" run \
  "$staged_bundle" "$staged_artifacts/candidate.so" "$staged_artifacts/baseline.so" "$output_root" \
  "$candidate_expected" "$baseline_expected"
qualification_status=$?
set -e

set +e
node "$staged_bundle/scripts/qualification-runner.mjs" verify-content "$staged_bundle" \
  >"$output_root/postflight-content-verification.json"
postflight_status=$?
set -e
if [[ -f "$output_root/qualification-result.json" ]]; then
  sha256sum "$output_root/qualification-result.json" >"$output_root/qualification-result.sha256"
fi
if [[ "$qualification_status" -eq 0 && "$postflight_status" -ne 0 ]]; then
  qualification_status="$postflight_status"
fi

echo "Target evidence collected in $output_root; qualification.json remains unchanged and owner approval is required for QUALIFIED."
exit "$qualification_status"
