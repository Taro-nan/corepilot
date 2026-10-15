#define _POSIX_C_SOURCE 200112L

#ifdef KML_BLAS
#include "kblas.h"
#include <omp.h>
#else
#include <cblas.h>
#endif
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now_sec(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec * 1.0e-9;
}

static void *aligned_malloc(size_t bytes) {
  void *ptr = NULL;
  if (posix_memalign(&ptr, 64, bytes) != 0) return NULL;
  return ptr;
}

static long parse_long(const char *text, const char *name, int allow_negative) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno || end == text || *end != '\0' || value == 0 ||
      (!allow_negative && value < 0)) {
    fprintf(stderr, "invalid %s: %s\n", name, text);
    exit(2);
  }
  return value;
}

static enum CBLAS_TRANSPOSE parse_trans(char value) {
  switch (value) {
    case 'N': case 'n': return CblasNoTrans;
    case 'T': case 't': return CblasTrans;
    case 'C': case 'c': return CblasConjTrans;
    case 'R': case 'r': return CblasConjNoTrans;
    default:
      fprintf(stderr, "invalid trans: %c (use N/T/C/R)\n", value);
      exit(2);
  }
}

static size_t vector_span(int length, int increment) {
  return 1u + (size_t)(length - 1) * (size_t)abs(increment);
}

static size_t vector_index(int logical, int length, int increment) {
  if (increment > 0) return (size_t)logical * (size_t)increment;
  return (size_t)(length - 1 - logical) * (size_t)(-increment);
}

static double pattern(int i, int j, int salt) {
  int value = (i * 17 + j * 29 + salt * 13) & 2047;
  return ((double)value - 1023.0) / 2048.0;
}

static void call_gemv(char type, enum CBLAS_TRANSPOSE trans,
                      int m, int n, const void *a, int lda,
                      const void *x, int incx, void *y, int incy) {
  const float alpha_s = 1.0f, beta_s = 0.0f;
  const double alpha_d = 1.0, beta_d = 0.0;
  const float alpha_c[2] = {1.0f, 0.0f}, beta_c[2] = {0.0f, 0.0f};
  const double alpha_z[2] = {1.0, 0.0}, beta_z[2] = {0.0, 0.0};

  switch (type) {
    case 's':
      cblas_sgemv(CblasColMajor, trans, m, n, alpha_s,
                  (const float *)a, lda, (const float *)x, incx,
                  beta_s, (float *)y, incy);
      break;
    case 'd':
      cblas_dgemv(CblasColMajor, trans, m, n, alpha_d,
                  (const double *)a, lda, (const double *)x, incx,
                  beta_d, (double *)y, incy);
      break;
    case 'c':
      cblas_cgemv(CblasColMajor, trans, m, n, alpha_c,
                  a, lda, x, incx, beta_c, y, incy);
      break;
    case 'z':
      cblas_zgemv(CblasColMajor, trans, m, n, alpha_z,
                  a, lda, x, incx, beta_z, y, incy);
      break;
    default:
      fprintf(stderr, "invalid type: %c (use s/d/c/z)\n", type);
      exit(2);
  }
}

int main(int argc, char **argv) {
  if (argc != 10) {
    fprintf(stderr,
            "usage: %s type trans M N LDA incx incy warmup loops\n"
            "  type: s/d/c/z; trans: N/T/C/R\n", argv[0]);
    return 2;
  }

  char type = argv[1][0];
  char trans_char = argv[2][0];
  enum CBLAS_TRANSPOSE trans = parse_trans(trans_char);
  int m = (int)parse_long(argv[3], "M", 0);
  int n = (int)parse_long(argv[4], "N", 0);
  int lda = (int)parse_long(argv[5], "LDA", 0);
  int incx = (int)parse_long(argv[6], "incx", 1);
  int incy = (int)parse_long(argv[7], "incy", 1);
  int warmup = (int)parse_long(argv[8], "warmup", 0);
  int loops = (int)parse_long(argv[9], "loops", 0);
#ifdef KML_BLAS
  /* KML_BLAS owns its thread pool; synchronize it with OMP_NUM_THREADS. */
  BlasSetNumThreads(omp_get_max_threads());
#endif
  int complex_type = type == 'c' || type == 'z';
  int double_type = type == 'd' || type == 'z';
  int no_trans = trans == CblasNoTrans || trans == CblasConjNoTrans;
  int lenx = no_trans ? n : m;
  int leny = no_trans ? m : n;
  size_t components = complex_type ? 2u : 1u;
  size_t scalar_size = double_type ? sizeof(double) : sizeof(float);

  if ((type != 's' && type != 'd' && type != 'c' && type != 'z') ||
      lda < m || warmup < 1 || loops < 1) {
    fprintf(stderr, "invalid type, dimensions, or loop counts\n");
    return 2;
  }

  size_t a_values = (size_t)lda * (size_t)n;
  size_t x_values = vector_span(lenx, incx);
  size_t y_values = vector_span(leny, incy);
  if (a_values > SIZE_MAX / components / scalar_size ||
      x_values > SIZE_MAX / components / scalar_size ||
      y_values > SIZE_MAX / components / scalar_size) {
    fprintf(stderr, "allocation size overflow\n");
    return 2;
  }

  void *a = aligned_malloc(a_values * components * scalar_size);
  void *x = aligned_malloc(x_values * components * scalar_size);
  void *y = aligned_malloc(y_values * components * scalar_size);
  if (!a || !x || !y) {
    fprintf(stderr, "allocation failed (A bytes=%zu)\n",
            a_values * components * scalar_size);
    free(a); free(x); free(y);
    return 3;
  }
  memset(a, 0, a_values * components * scalar_size);
  memset(x, 0, x_values * components * scalar_size);
  memset(y, 0, y_values * components * scalar_size);

  for (int j = 0; j < n; ++j) {
    for (int i = 0; i < m; ++i) {
      size_t logical = (size_t)j * (size_t)lda + (size_t)i;
      double real = pattern(i, j, 1);
      double imag = pattern(i, j, 2);
      if (double_type) {
        double *values = (double *)a;
        values[components * logical] = real;
        if (complex_type) values[components * logical + 1] = imag;
      } else {
        float *values = (float *)a;
        values[components * logical] = (float)real;
        if (complex_type) values[components * logical + 1] = (float)imag;
      }
    }
  }

  for (int i = 0; i < lenx; ++i) {
    size_t logical = vector_index(i, lenx, incx);
    double real = pattern(i, 0, 3);
    double imag = pattern(i, 0, 4);
    if (double_type) {
      double *values = (double *)x;
      values[components * logical] = real;
      if (complex_type) values[components * logical + 1] = imag;
    } else {
      float *values = (float *)x;
      values[components * logical] = (float)real;
      if (complex_type) values[components * logical + 1] = (float)imag;
    }
  }

  for (int repeat = 0; repeat < warmup; ++repeat)
    call_gemv(type, trans, m, n, a, lda, x, incx, y, incy);

  double start = now_sec();
  for (int repeat = 0; repeat < loops; ++repeat)
    call_gemv(type, trans, m, n, a, lda, x, incx, y, incy);
  double seconds = (now_sec() - start) / (double)loops;

  double checksum = 0.0;
  int checksum_count = leny < 8 ? leny : 8;
  for (int i = 0; i < checksum_count; ++i) {
    size_t logical = vector_index(i, leny, incy);
    if (double_type) {
      double *values = (double *)y;
      checksum += values[components * logical];
      if (complex_type) checksum += values[components * logical + 1];
    } else {
      float *values = (float *)y;
      checksum += values[components * logical];
      if (complex_type) checksum += values[components * logical + 1];
    }
  }

  double flop_factor = complex_type ? 8.0 : 2.0;
  double gflops = flop_factor * (double)m * (double)n / seconds / 1.0e9;
  printf("%c,%c,%d,%d,%d,%d,%d,%d,%d,%.9f,%.6f,%.17g\n",
         type, trans_char, m, n, lda, incx, incy, warmup, loops,
         seconds, gflops, checksum);

  free(a); free(x); free(y);
  return 0;
}
