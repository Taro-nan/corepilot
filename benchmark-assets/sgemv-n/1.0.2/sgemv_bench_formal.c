/*
 * sgemv_bench_formal.c — formal SGEMV-N performance benchmark.
 *
 * Frozen by BenchmarkAssetVersion 1.0.0. Candidate and baseline binaries are
 * built from THIS SAME source; only the link target (-L/-l) differs.
 *
 * Behavior:
 *   1. Parse M N threads alpha beta incx incy lda warmup loops role
 *      test_plan_version test_plan_digest benchmark_binary_sha256.
 *   2. Run the dladdr/dlsym runtime identity probe BEFORE any timing
 *      (it resolves cblas_sgemv via RTLD_DEFAULT and prints the shared
 *      object it was loaded from).
 *   3. Allocate deterministic inputs, run warmup calls, then a timed loop.
 *   4. Emit one PHYOPT_DLADDR line (identity) and one PHYOPT_RESULT line
 *      (seconds/GFLOPS/M/N/threads/loops/role).
 *
 * The timed loop uses CLOCK_MONOTONIC_RAW. The dladdr probe is NEVER inside
 * the timed interval.
 */

#define _GNU_SOURCE

/* Positional argument contract: 14 args after the program name. */
#define EXPECTED_POSITIONAL_ARGS 14
#define EXPECTED_ARGC (EXPECTED_POSITIONAL_ARGS + 1)

#include <cblas.h>
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now_sec(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC_RAW, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec * 1.0e-9;
}

static long parse_long(const char *text, const char *name, int allow_zero) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno || end == text || *end != '\0') {
    fprintf(stderr, "invalid %s: %s\n", name, text);
    exit(2);
  }
  if (!allow_zero && value <= 0) {
    fprintf(stderr, "%s must be > 0: %s\n", name, text);
    exit(2);
  }
  return value;
}

static float parse_float(const char *text, const char *name) {
  char *end = NULL;
  errno = 0;
  float value = strtof(text, &end);
  if (errno || end == text || *end != '\0') {
    fprintf(stderr, "invalid %s: %s\n", name, text);
    exit(2);
  }
  return value;
}

/* Deterministic input pattern (same generator used across all points). */
static float pattern(int i, int j, int salt) {
  int value = (i * 17 + j * 29 + salt * 13) & 2047;
  return ((float)value - 1023.0f) / 2048.0f;
}

/*
 * Runtime identity probe. Runs BEFORE any timed work. Prints a single
 * PHYOPT_DLADDR line with the shared object actually providing cblas_sgemv.
 */
static int probe_runtime_identity(const char *role,
                                  const char *test_plan_version,
                                  const char *test_plan_digest,
                                  const char *benchmark_binary_sha256) {
  void *sym = dlsym(RTLD_DEFAULT, "cblas_sgemv");
  Dl_info info;
  char real[PATH_MAX];

  if (!sym) {
    fprintf(stderr, "probe: cblas_sgemv not found via RTLD_DEFAULT\n");
    return 3;
  }
  if (dladdr(sym, &info) == 0 || !info.dli_fname) {
    fprintf(stderr, "probe: dladdr failed\n");
    return 3;
  }
  if (realpath(info.dli_fname, real) == NULL) {
    fprintf(stderr, "probe: realpath failed for %s\n", info.dli_fname);
    return 3;
  }

  printf("PHYOPT_DLADDR proof_method=dladdr_dlsym symbol=cblas_sgemv "
         "resolved_path=%s realpath=%s benchmark_role=%s "
         "benchmark_binary_sha256=%s test_plan_version=%s test_plan_digest=%s\n",
         info.dli_fname, real, role, benchmark_binary_sha256,
         test_plan_version, test_plan_digest);
  return 0;
}

int main(int argc, char **argv) {
  /*
   * argv: M N threads alpha beta incx incy lda warmup loops role
   *       test_plan_version test_plan_digest benchmark_binary_sha256
   * = EXPECTED_POSITIONAL_ARGS (14) positional arguments; argc == 15.
   */
  if (argc != EXPECTED_ARGC) {
    fprintf(stderr,
            "usage: %s M N threads alpha beta incx incy lda warmup loops role "
            "test_plan_version test_plan_digest benchmark_binary_sha256\n",
            argv[0]);
    return 2;
  }

  int m = (int)parse_long(argv[1], "M", 0);
  int n = (int)parse_long(argv[2], "N", 0);
  int threads = (int)parse_long(argv[3], "threads", 0);
  float alpha = parse_float(argv[4], "alpha");
  float beta = parse_float(argv[5], "beta");
  int incx = (int)parse_long(argv[6], "incx", 1);
  int incy = (int)parse_long(argv[7], "incy", 1);
  int lda = (int)parse_long(argv[8], "lda", 0);
  int warmup = (int)parse_long(argv[9], "warmup", 1);
  int loops = (int)parse_long(argv[10], "loops", 1);
  const char *role = argv[11];
  const char *test_plan_version = argv[12];
  const char *test_plan_digest = argv[13];
  const char *benchmark_binary_sha256 = argv[14];

  if (lda < m) {
    fprintf(stderr, "lda must be >= m (lda=%d, m=%d)\n", lda, m);
    return 2;
  }

  /* Runtime identity probe — must happen before any timed region. */
  if (probe_runtime_identity(role, test_plan_version, test_plan_digest,
                             benchmark_binary_sha256) != 0) {
    return 3;
  }

  size_t a_values = (size_t)lda * (size_t)n;
  size_t x_values = 1u + (size_t)(n - 1) * (size_t)llabs(incx);
  size_t y_values = 1u + (size_t)(m - 1) * (size_t)llabs(incy);

  float *a = NULL;
  float *x = NULL;
  float *y = NULL;
  if (posix_memalign((void **)&a, 64, a_values * sizeof(float)) != 0) a = NULL;
  if (posix_memalign((void **)&x, 64, x_values * sizeof(float)) != 0) x = NULL;
  if (posix_memalign((void **)&y, 64, y_values * sizeof(float)) != 0) y = NULL;
  if (!a || !x || !y) {
    fprintf(stderr, "allocation failed (A values=%zu)\n", a_values);
    free(a); free(x); free(y);
    return 3;
  }

  /* Deterministic inputs. Column-major layout: A(j*lda + i). */
  for (int j = 0; j < n; ++j) {
    for (int i = 0; i < m; ++i) {
      a[(size_t)j * (size_t)lda + (size_t)i] = pattern(i, j, 1);
    }
  }
  for (int i = 0; i < n; ++i) {
    size_t idx = incx > 0 ? (size_t)i * (size_t)incx
                          : (size_t)(n - 1 - i) * (size_t)(-incx);
    x[idx] = pattern(i, 0, 3);
  }
  for (int i = 0; i < m; ++i) {
    size_t idx = incy > 0 ? (size_t)i * (size_t)incy
                          : (size_t)(m - 1 - i) * (size_t)(-incy);
    y[idx] = pattern(0, i, 5);
  }

  /* Warmup calls (not timed). */
  for (int repeat = 0; repeat < warmup; ++repeat) {
    cblas_sgemv(CblasColMajor, CblasNoTrans, m, n, alpha, a, lda, x, incx,
                beta, y, incy);
  }

  /* Timed loop (CLOCK_MONOTONIC_RAW). */
  double start = now_sec();
  for (int repeat = 0; repeat < loops; ++repeat) {
    cblas_sgemv(CblasColMajor, CblasNoTrans, m, n, alpha, a, lda, x, incx,
                beta, y, incy);
  }
  double seconds = (now_sec() - start) / (double)loops;

  double gflops = 2.0 * (double)m * (double)n / seconds / 1.0e9;

  printf("PHYOPT_RESULT role=%s m=%d n=%d threads=%d loops=%d "
         "seconds=%.9f gflops=%.6f\n",
         role, m, n, threads, loops, seconds, gflops);

  free(a); free(x); free(y);
  return 0;
}
