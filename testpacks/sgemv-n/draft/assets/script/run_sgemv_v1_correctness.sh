#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 CANDIDATE_EXE OUTPUT_FILE [CPU_LIST]" >&2
  exit 2
fi

candidate_exe=$1
output_file=$2
cpu_list=${3:-0-15}

mkdir -p "$(dirname "$output_file")"
: >"$output_file"

run_case() {
  local threads=$1
  shift

  numactl -C "$cpu_list" -i 0 env \
    OMP_NUM_THREADS="$threads" \
    OPENBLAS_NUM_THREADS="$threads" \
    OMP_DYNAMIC=FALSE \
    OMP_PLACES=cores \
    OMP_PROC_BIND=spread \
    "$candidate_exe" "$@" | tee -a "$output_file"
}

# Four-column kernel plus N and M tails.
run_case 1 s N 127 129 130 1 1
run_case 1 s N 127 130 131 1 1
run_case 1 s N 127 131 132 1 1

# Negative strides and the original scalar/non-unit-INCY path.
run_case 1 s N 127 129 130 -1 -1

# Four-column, two-column and original single-column multithread modes.
run_case 8  s N 4103 4111 4112 1 1
run_case 16 s N 4096 4096 4099 1 1
run_case 16 s N 512 32768 512 1 1
run_case 16 s N 8192 8192 8195 1 1

# Confirm that SGEMV-T and DGEMV-N remain isolated from this optimization.
run_case 16 s T 4096 4096 4099 1 1
run_case 16 d N 4096 4096 4099 1 1

