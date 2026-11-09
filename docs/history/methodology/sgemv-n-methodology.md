# SGEMV-N Methodology Notes

Reviewed methodology records. These are general methodological guidance, NOT
hardware-measured facts.

## 1. A regression is not proof of a specific bottleneck

A measured slowdown on a specific shape/thread combination is evidence of a
regression, not direct proof of a mechanism (e.g. memory bandwidth). Mechanism
claims require additional evidence (profiling, counters, controlled
experiments).

## 2. Equal symbol addresses do not imply identical instruction bytes

Two builds may place a function at the same virtual address while differing in
emitted instructions. Address equality is weak evidence; byte-level comparison
or disassembly is required for identity claims.
