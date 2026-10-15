#!/usr/bin/env bash
# PHYOPT_ARGUMENT_CONTRACT: case_id,artifact_path,m,n,lda,incx,incy,alpha,beta,threads,seed,runtime_root
set -euo pipefail
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec bash "$bundle_root/correctness/run-case.sh" "$@"
