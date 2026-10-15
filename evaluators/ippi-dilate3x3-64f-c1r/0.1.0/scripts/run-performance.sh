#!/usr/bin/env bash
# PHYOPT_ARGUMENT_CONTRACT: phase,role,workload_id,artifact_path,width,height,src_padding,dst_padding,loops,seed,threads,iteration_index,runtime_root
set -euo pipefail
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec bash "$bundle_root/benchmark/run-sample.sh" "$@"
