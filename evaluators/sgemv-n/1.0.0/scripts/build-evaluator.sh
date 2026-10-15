#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: build-evaluator.sh RUNTIME_ROOT" >&2
  exit 64
fi

bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime_root="$1"
mkdir -p -- "$runtime_root"
cc_bin="${CC:-gcc}"
"$cc_bin" -O2 -std=c11 -Wall -Wextra -Werror -I "$bundle_root/include" "$bundle_root/correctness/sgemv_correctness_formal.c" -o "$runtime_root/sgemv_correctness_formal" -ldl -lm
"$cc_bin" -O2 -std=c11 -Wall -Wextra -Werror -I "$bundle_root/include" "$bundle_root/benchmark/sgemv_bench_formal.c" -o "$runtime_root/sgemv_bench_formal" -ldl -lm
sha256sum "$runtime_root/sgemv_correctness_formal" "$runtime_root/sgemv_bench_formal"
