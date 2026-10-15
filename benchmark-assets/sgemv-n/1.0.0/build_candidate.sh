#!/bin/sh
# Build the candidate SGEMV-N formal benchmark.
# Candidate and baseline share the SAME source (sgemv_bench_formal.c);
# only the link target (-L / -Wl,-rpath / -l) differs.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"

gcc -O2 -fopenmp \
  -I "$here/include" \
  "$here/sgemv_bench_formal.c" \
  -o "$here/sgemv_bench_candidate" \
  -L /tmp/sgemv_n_v1_final_20260904 \
  -Wl,-rpath,/tmp/sgemv_n_v1_final_20260904 \
  -lblas_ft_ft2000p-r0.3.33 \
  -lm -lpthread
