#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 13 ]]; then exit 64; fi
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime_root="${13}"
if [[ ! -x "$runtime_root/dilate_evaluator" ]]; then bash "$bundle_root/scripts/build-evaluator.sh" "$runtime_root" >/dev/null; fi
artifact_sha256="$(sha256sum "$4" | cut -d ' ' -f 1)"
harness_sha256="$(sha256sum "$runtime_root/dilate_evaluator" | cut -d ' ' -f 1)"
export OMP_NUM_THREADS="${11}" OPENBLAS_NUM_THREADS="${11}" GOTO_NUM_THREADS="${11}" OMP_DYNAMIC=FALSE
export PHYOPT_ARTIFACT_SHA256="$artifact_sha256" PHYOPT_HARNESS_SHA256="$harness_sha256"
"$runtime_root/dilate_evaluator" performance "${@:1:12}"
[[ "$(sha256sum "$4" | cut -d ' ' -f 1)" == "$artifact_sha256" ]]
