#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 16 ]]; then
  echo "benchmark contract requires 16 arguments" >&2
  exit 64
fi
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime_root="${16}"
if [[ ! -x "$runtime_root/sgemv_bench_formal" ]]; then
  bash "$bundle_root/scripts/build-evaluator.sh" "$runtime_root" >/dev/null
fi
artifact_sha256="$(sha256sum "$4" | awk '{print $1}')"
harness_sha256="$(sha256sum "$runtime_root/sgemv_bench_formal" | awk '{print $1}')"
export OMP_NUM_THREADS="${12}" OPENBLAS_NUM_THREADS="${12}" GOTO_NUM_THREADS="${12}"
export OMP_DYNAMIC=FALSE OMP_PLACES=cores OMP_PROC_BIND=spread OMP_WAIT_POLICY=ACTIVE
export PHYOPT_ARTIFACT_SHA256="$artifact_sha256" PHYOPT_HARNESS_SHA256="$harness_sha256"
exec "$runtime_root/sgemv_bench_formal" "${@:1:15}"
