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
"$cc_bin" -O2 -std=c11 -Wall -Wextra -Werror "$bundle_root/correctness/saxpy_correctness.c" -o "$runtime_root/saxpy_correctness" -ldl -lm
"$cc_bin" -O2 -std=c11 -Wall -Wextra -Werror "$bundle_root/benchmark/saxpy_benchmark.c" -o "$runtime_root/saxpy_benchmark" -ldl -lm
sha256sum "$runtime_root/saxpy_correctness" "$runtime_root/saxpy_benchmark"
