#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 13 ]]; then
  echo "benchmark contract requires 13 arguments" >&2
  exit 64
fi
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime_root="${13}"
if [[ ! -x "$runtime_root/saxpy_benchmark" ]]; then
  bash "$bundle_root/scripts/build-evaluator.sh" "$runtime_root" >/dev/null
fi
artifact_sha256="$(sha256sum "$4" | awk '{print $1}')"
harness_sha256="$(sha256sum "$runtime_root/saxpy_benchmark" | awk '{print $1}')"
export OMP_NUM_THREADS="$9" OPENBLAS_NUM_THREADS="$9" GOTO_NUM_THREADS="$9"
export OMP_DYNAMIC=FALSE OMP_PLACES=cores OMP_PROC_BIND=spread OMP_WAIT_POLICY=ACTIVE
export PHYOPT_ARTIFACT_SHA256="$artifact_sha256" PHYOPT_HARNESS_SHA256="$harness_sha256"
exec "$runtime_root/saxpy_benchmark" "${@:1:12}"
