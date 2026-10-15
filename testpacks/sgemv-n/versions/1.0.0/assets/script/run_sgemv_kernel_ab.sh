#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 5 || $# -gt 6 ]]; then
  echo "usage: $0 BASELINE_EXE CANDIDATE_EXE OUTPUT_FILE REPS CASE_SET [CPU_LIST]" >&2
  echo "CASE_SET: pilot | final | boundary | large | focus1 | focus16" >&2
  exit 2
fi

baseline_exe=$1
candidate_exe=$2
output_file=$3
repetitions=$4
case_set=$5
cpu_list=${6:-0-15}

if ! [[ $repetitions =~ ^[1-9][0-9]*$ ]]; then
  echo "REPS must be a positive integer" >&2
  exit 2
fi

case "$case_set" in
  pilot)
    cases=(
      '1024 16384 1 60'
      '4096 4096 1 60'
      '16384 1024 1 60'
      '1024 16384 8 160'
      '4096 4096 8 160'
      '16384 1024 8 160'
      '1024 16384 16 160'
      '4096 4096 16 160'
      '16384 1024 16 160'
    )
    ;;
  final)
    cases=(
      '1024 16384 1 60'
      '4096 4096 1 60'
      '16384 1024 1 60'
      '1024 16384 8 160'
      '4096 4096 8 160'
      '16384 1024 8 160'
      '1024 16384 16 160'
      '4096 4096 16 160'
      '16384 1024 16 160'
      '8192 8192 16 60'
      '16384 16384 8 30'
    )
    ;;
  boundary)
    cases=(
      '512 32768 8 160'
      '512 32768 16 160'
      '1024 32768 8 120'
      '1024 32768 16 120'
      '2048 32768 8 100'
      '2048 32768 16 100'
      '8192 8192 8 60'
      '16384 16384 16 30'
    )
    ;;
  large)
    cases=(
      '8192 8192 16 60'
      '16384 16384 8 30'
    )
    ;;
  focus1)
    cases=(
      '512 16384 1 100'
      '512 32768 1 60'
      '1024 16384 1 60'
      '1024 32768 1 40'
      '2048 8192 1 60'
      '2048 32768 1 20'
      '4096 4096 1 60'
    )
    ;;
  focus16)
    cases=(
      '512 32768 16 160'
      '1024 16384 16 160'
      '1024 32768 16 120'
      '2048 32768 16 100'
      '4096 4096 16 160'
      '16384 1024 16 160'
      '8192 8192 16 60'
      '16384 16384 16 30'
    )
    ;;
  *)
    echo "CASE_SET must be pilot, final, boundary, large, focus1 or focus16" >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$output_file")"
printf '%s\n' \
  'rep,order,version,threads,type,trans,m,n,lda,incx,incy,warmup,loops,seconds,gflops,checksum' \
  >"$output_file"

run_one() {
  local repetition=$1
  local order=$2
  local version=$3
  local executable=$4
  local m=$5
  local n=$6
  local threads=$7
  local loops=$8
  local result

  result=$(numactl -C "$cpu_list" -i 0 env \
    OMP_NUM_THREADS="$threads" \
    OPENBLAS_NUM_THREADS="$threads" \
    OMP_DYNAMIC=FALSE \
    OMP_PLACES=cores \
    OMP_PROC_BIND=spread \
    OMP_WAIT_POLICY=ACTIVE \
    "$executable" s N "$m" "$n" "$m" 1 1 3 "$loops")
  printf '%d,%d,%s,%d,%s\n' \
    "$repetition" "$order" "$version" "$threads" "$result" \
    | tee -a "$output_file"
}

for ((repetition = 1; repetition <= repetitions; ++repetition)); do
  if ((repetition % 2 == 1)); then
    versions=(baseline candidate)
    executables=("$baseline_exe" "$candidate_exe")
  else
    versions=(candidate baseline)
    executables=("$candidate_exe" "$baseline_exe")
  fi

  for case_spec in "${cases[@]}"; do
    read -r m n threads loops <<<"$case_spec"
    for order in 0 1; do
      run_one "$repetition" "$order" "${versions[order]}" \
        "${executables[order]}" "$m" "$n" "$threads" "$loops"
    done
  done
done
