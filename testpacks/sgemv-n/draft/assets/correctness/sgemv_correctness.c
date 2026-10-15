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

typedef struct {
  long double real;
  long double imag;
} reference_complex;

static reference_complex add_complex(reference_complex a,
                                     reference_complex b) {
  reference_complex result = {a.real + b.real, a.imag + b.imag};
  return result;
}

static reference_complex multiply_complex(reference_complex a,
                                          reference_complex b) {
  reference_complex result = {
      a.real * b.real - a.imag * b.imag,
      a.real * b.imag + a.imag * b.real};
  return result;
}

static reference_complex conjugate_complex(reference_complex value) {
  value.imag = -value.imag;
  return value;
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

static long double pattern(int i, int j, int salt) {
  int value = (i * 17 + j * 29 + salt * 13) & 2047;
  return ((long double)value - 1023.0L) / 2048.0L;
}

static reference_complex load_value(const void *data, size_t logical,
                                    int double_type, int complex_type) {
  reference_complex result = {0.0L, 0.0L};
  size_t components = complex_type ? 2u : 1u;
  if (double_type) {
    const double *values = (const double *)data;
    result.real = values[components * logical];
    if (complex_type) result.imag = values[components * logical + 1];
  } else {
    const float *values = (const float *)data;
    result.real = values[components * logical];
    if (complex_type) result.imag = values[components * logical + 1];
  }
  return result;
}

static void store_value(void *data, size_t logical, int double_type,
                        int complex_type, reference_complex value) {
  size_t components = complex_type ? 2u : 1u;
  if (double_type) {
    double *values = (double *)data;
    values[components * logical] = (double)value.real;
    if (complex_type) values[components * logical + 1] = (double)value.imag;
  } else {
    float *values = (float *)data;
    values[components * logical] = (float)value.real;
    if (complex_type) values[components * logical + 1] = (float)value.imag;
  }
}

static void call_gemv(char type, enum CBLAS_TRANSPOSE trans,
                      int m, int n, const void *a, int lda,
                      const void *x, int incx, void *y, int incy) {
  const float alpha_s = 0.7f, beta_s = -0.3f;
  const double alpha_d = 0.7, beta_d = -0.3;
  const float alpha_c[2] = {0.7f, -0.2f}, beta_c[2] = {-0.3f, 0.15f};
  const double alpha_z[2] = {0.7, -0.2}, beta_z[2] = {-0.3, 0.15};

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
      fprintf(stderr, "invalid type: %c\n", type);
      exit(2);
  }
}

int main(int argc, char **argv) {
  if (argc != 8) {
    fprintf(stderr,
            "usage: %s type trans M N LDA incx incy\n"
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
#ifdef KML_BLAS
  /* Keep KML correctness tests on the same requested thread count. */
  BlasSetNumThreads(omp_get_max_threads());
#endif
  int complex_type = type == 'c' || type == 'z';
  int double_type = type == 'd' || type == 'z';
  int no_trans = trans == CblasNoTrans || trans == CblasConjNoTrans;
  int conjugate = trans == CblasConjTrans || trans == CblasConjNoTrans;
  int lenx = no_trans ? n : m;
  int leny = no_trans ? m : n;
  int inner = no_trans ? n : m;
  size_t components = complex_type ? 2u : 1u;
  size_t scalar_size = double_type ? sizeof(double) : sizeof(float);

  if ((type != 's' && type != 'd' && type != 'c' && type != 'z') ||
      lda < m) {
    fprintf(stderr, "invalid type or dimensions\n");
    return 2;
  }

  size_t a_values = (size_t)lda * (size_t)n;
  size_t x_values = vector_span(lenx, incx);
  size_t y_values = vector_span(leny, incy);
  void *a = aligned_malloc(a_values * components * scalar_size);
  void *x = aligned_malloc(x_values * components * scalar_size);
  void *y = aligned_malloc(y_values * components * scalar_size);
  reference_complex *reference =
      (reference_complex *)aligned_malloc((size_t)leny * sizeof(*reference));
  if (!a || !x || !y || !reference) {
    fprintf(stderr, "allocation failed\n");
    free(a); free(x); free(y); free(reference);
    return 3;
  }
  memset(a, 0, a_values * components * scalar_size);
  memset(x, 0, x_values * components * scalar_size);
  memset(y, 0, y_values * components * scalar_size);

  for (int j = 0; j < n; ++j) {
    for (int i = 0; i < m; ++i) {
      reference_complex value = {pattern(i, j, 1),
                                 complex_type ? pattern(i, j, 2) : 0.0L};
      store_value(a, (size_t)j * (size_t)lda + (size_t)i,
                  double_type, complex_type, value);
    }
  }

  for (int i = 0; i < lenx; ++i) {
    reference_complex value = {pattern(i, 0, 3),
                               complex_type ? pattern(i, 0, 4) : 0.0L};
    store_value(x, vector_index(i, lenx, incx),
                double_type, complex_type, value);
  }

  reference_complex alpha = {0.7L, complex_type ? -0.2L : 0.0L};
  reference_complex beta = {-0.3L, complex_type ? 0.15L : 0.0L};
  for (int output = 0; output < leny; ++output) {
    reference_complex initial = {pattern(output, 0, 5),
                                 complex_type ? pattern(output, 0, 6) : 0.0L};
    store_value(y, vector_index(output, leny, incy),
                double_type, complex_type, initial);

    reference_complex sum = {0.0L, 0.0L};
    for (int k = 0; k < inner; ++k) {
      int row = no_trans ? output : k;
      int column = no_trans ? k : output;
      reference_complex av = load_value(
          a, (size_t)column * (size_t)lda + (size_t)row,
          double_type, complex_type);
      if (conjugate && complex_type) av = conjugate_complex(av);
      reference_complex xv = load_value(
          x, vector_index(k, lenx, incx), double_type, complex_type);
      sum = add_complex(sum, multiply_complex(av, xv));
    }
    reference[output] = add_complex(multiply_complex(alpha, sum),
                                    multiply_complex(beta, initial));
  }

  call_gemv(type, trans, m, n, a, lda, x, incx, y, incy);

  long double max_error = 0.0L;
  long double max_reference = 0.0L;
  int max_index = 0;
  for (int i = 0; i < leny; ++i) {
    reference_complex actual = load_value(
        y, vector_index(i, leny, incy), double_type, complex_type);
    long double error = hypotl(actual.real - reference[i].real,
                               actual.imag - reference[i].imag);
    long double magnitude = hypotl(reference[i].real, reference[i].imag);
    if (error > max_error) {
      max_error = error;
      max_index = i;
    }
    if (magnitude > max_reference) max_reference = magnitude;
  }

  long double tolerance_factor = double_type ? 2.0e-12L : 2.0e-5L;
  long double tolerance = tolerance_factor * sqrtl((long double)inner + 1.0L) *
                          fmaxl(1.0L, max_reference);
  int passed = isfinite((double)max_error) && max_error <= tolerance;
  printf("type=%c trans=%c M=%d N=%d LDA=%d incx=%d incy=%d "
         "max_error=%.12Le tolerance=%.12Le index=%d %s\n",
         type, trans_char, m, n, lda, incx, incy,
         max_error, tolerance, max_index, passed ? "PASS" : "FAIL");

  free(a); free(x); free(y); free(reference);
  return passed ? 0 : 1;
}
