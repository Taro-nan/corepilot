#!/bin/sh
# Build the baseline (OpenBLAS release033) SGEMV-N formal benchmark.
# Candidate and baseline share the SAME source (sgemv_bench_formal.c);
# only the link target (-L / -Wl,-rpath / -l) differs.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"

gcc -O2 -fopenmp \
  -I "$here/include" \
  "$here/sgemv_bench_formal.c" \
  -o "$here/sgemv_bench_baseline" \
  -L /tmp/gemv_n_release033 \
  -Wl,-rpath,/tmp/gemv_n_release033 \
  -lopenblas_ft2000p-r0.3.33 \
  -lm -lpthread
