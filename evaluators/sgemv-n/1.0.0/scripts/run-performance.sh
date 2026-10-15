#!/usr/bin/env bash
# PHYOPT_ARGUMENT_CONTRACT: phase,role,workload_id,artifact_path,m,n,lda,incx,incy,alpha,beta,threads,loops,seed,iteration_index,runtime_root
set -euo pipefail
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec bash "$bundle_root/benchmark/run-sample.sh" "$@"
