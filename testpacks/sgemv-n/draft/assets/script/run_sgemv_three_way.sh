#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 5 || $# -gt 6 ]]; then
  echo "usage: $0 RELEASE033_EXE KML_EXE CANDIDATE_EXE OUTPUT_FILE REPS [CPU_LIST]" >&2
  exit 2
fi

release_exe=$1
kml_exe=$2
candidate_exe=$3
output_file=$4
repetitions=$5
cpu_list=${6:-0-15}

if ! [[ $repetitions =~ ^[1-9][0-9]*$ ]]; then
  echo "REPS must be a positive integer" >&2
  exit 2
fi

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

# Six permutations make the three executable positions equally frequent when
# REPS=6 (and repeat cyclically for larger runs).
orders=(
  'release033 kml_v2.0.0 sgemv_v1'
  'kml_v2.0.0 sgemv_v1 release033'
  'sgemv_v1 release033 kml_v2.0.0'
  'release033 sgemv_v1 kml_v2.0.0'
  'kml_v2.0.0 release033 sgemv_v1'
  'sgemv_v1 kml_v2.0.0 release033'
)

mkdir -p "$(dirname "$output_file")"
printf '%s\n' \
  'rep,order,version,threads,type,trans,m,n,lda,incx,incy,warmup,loops,seconds,gflops,checksum' \
  >"$output_file"

executable_for() {
  case "$1" in
    release033) printf '%s\n' "$release_exe" ;;
    kml_v2.0.0) printf '%s\n' "$kml_exe" ;;
    sgemv_v1) printf '%s\n' "$candidate_exe" ;;
    *) echo "unknown version: $1" >&2; return 2 ;;
  esac
}

run_one() {
  local repetition=$1
  local order=$2
  local version=$3
  local m=$4
  local n=$5
  local threads=$6
  local loops=$7
  local executable
  local result

  executable=$(executable_for "$version")
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
  read -r v0 v1 v2 <<<"${orders[$(( (repetition - 1) % ${#orders[@]} ))]}"
  for case_spec in "${cases[@]}"; do
    read -r m n threads loops <<<"$case_spec"
    run_one "$repetition" 0 "$v0" "$m" "$n" "$threads" "$loops"
    run_one "$repetition" 1 "$v1" "$m" "$n" "$threads" "$loops"
    run_one "$repetition" 2 "$v2" "$m" "$n" "$threads" "$loops"
  done
done
