#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 ]]; then exit 64; fi
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime_root="$1"
mkdir -p -- "$runtime_root"
"${CC:-gcc}" -O2 -std=c11 -Wall -Wextra -Werror "$bundle_root/harness/dilate_evaluator.c" "$bundle_root/correctness/scalar_oracle.c" -o "$runtime_root/dilate_evaluator" -ldl -lm
sha256sum "$runtime_root/dilate_evaluator"
