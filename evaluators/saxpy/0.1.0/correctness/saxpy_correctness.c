#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*cblas_saxpy_fn)(const int, const float, const float *, const int, float *, const int);

static long parse_long(const char *value, const char *name) {
  char *end = NULL;
  errno = 0;
  long output = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') {
    fprintf(stderr, "invalid %s: %s\n", name, value);
    exit(64);
  }
  return output;
}

static double parse_double(const char *value, const char *name) {
  char *end = NULL;
  errno = 0;
  double output = strtod(value, &end);
  if (errno != 0 || end == value || *end != '\0' || !isfinite(output)) {
    fprintf(stderr, "invalid %s: %s\n", name, value);
    exit(64);
  }
  return output;
}

static uint32_t next_random(uint32_t *state) {
  uint32_t x = *state ? *state : 1u;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  *state = x;
  return x;
}

static float random_float(uint32_t *state) {
  return (float)((int32_t)(next_random(state) & 0xffffu) - 32768) / 32768.0f;
}

static void print_json_string(const char *value) {
  putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; ++cursor) {
    if (*cursor == '"' || *cursor == '\\') printf("\\%c", *cursor);
    else if (*cursor == '\n') fputs("\\n", stdout);
    else if (*cursor == '\r') fputs("\\r", stdout);
    else if (*cursor == '\t') fputs("\\t", stdout);
    else if (*cursor < 0x20) printf("\\u%04x", *cursor);
    else putchar(*cursor);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc != 9) {
    fprintf(stderr, "usage: saxpy_correctness CASE_ID ARTIFACT N INCX INCY ALPHA THREADS SEED\n");
    return 64;
  }
  const char *case_id = argv[1];
  const char *artifact_path = argv[2];
  const int n = (int)parse_long(argv[3], "n");
  const int incx = (int)parse_long(argv[4], "incx");
  const int incy = (int)parse_long(argv[5], "incy");
  const float alpha = (float)parse_double(argv[6], "alpha");
  const int threads = (int)parse_long(argv[7], "threads");
  uint32_t seed = (uint32_t)parse_long(argv[8], "seed");
  if (n < 0 || incx == 0 || incy == 0 || threads < 1) {
    fputs("invalid SAXPY case parameters\n", stderr);
    return 64;
  }

  void *library = dlopen(artifact_path, RTLD_NOW | RTLD_LOCAL);
  if (!library) {
    fprintf(stderr, "dlopen failed: %s\n", dlerror());
    return 65;
  }
  dlerror();
  cblas_saxpy_fn saxpy = (cblas_saxpy_fn)dlsym(library, "cblas_saxpy");
  const char *symbol_error = dlerror();
  if (symbol_error || !saxpy) {
    fprintf(stderr, "dlsym(cblas_saxpy) failed: %s\n", symbol_error ? symbol_error : "unknown");
    dlclose(library);
    return 65;
  }
  Dl_info symbol_info;
  memset(&symbol_info, 0, sizeof(symbol_info));
  if (dladdr((void *)saxpy, &symbol_info) == 0 || !symbol_info.dli_fname) {
    fputs("dladdr(cblas_saxpy) failed\n", stderr);
    dlclose(library);
    return 65;
  }

  size_t x_count = n > 0 ? 1u + (size_t)(n - 1) * (size_t)abs(incx) : 1u;
  size_t y_count = n > 0 ? 1u + (size_t)(n - 1) * (size_t)abs(incy) : 1u;
  float *x = (float *)malloc(x_count * sizeof(float));
  float *y = (float *)malloc(y_count * sizeof(float));
  float *reference = (float *)malloc(y_count * sizeof(float));
  if (!x || !y || !reference) {
    fputs("allocation failed\n", stderr);
    free(x); free(y); free(reference); dlclose(library);
    return 70;
  }
  for (size_t index = 0; index < x_count; ++index) x[index] = random_float(&seed);
  for (size_t index = 0; index < y_count; ++index) y[index] = random_float(&seed);
  memcpy(reference, y, y_count * sizeof(float));
  const size_t x_start = incx < 0 && n > 0 ? (size_t)(n - 1) * (size_t)(-incx) : 0u;
  const size_t y_start = incy < 0 && n > 0 ? (size_t)(n - 1) * (size_t)(-incy) : 0u;
  for (int index = 0; index < n; ++index) {
    const size_t xi = (size_t)((long)x_start + (long)index * incx);
    const size_t yi = (size_t)((long)y_start + (long)index * incy);
    reference[yi] = (float)((double)reference[yi] + (double)alpha * (double)x[xi]);
  }

  saxpy(n, alpha, x, incx, y, incy);
  double max_abs_error = 0.0;
  double max_relative_error = 0.0;
  int failed_index = -1;
  for (int index = 0; index < n; ++index) {
    const size_t yi = (size_t)((long)y_start + (long)index * incy);
    const double absolute = fabs((double)y[yi] - (double)reference[yi]);
    const double relative = absolute / fmax(fabs((double)reference[yi]), 1.0e-30);
    if (absolute > max_abs_error) max_abs_error = absolute;
    if (relative > max_relative_error) max_relative_error = relative;
    if (absolute > 1.0e-5 + 1.0e-5 * fabs((double)reference[yi]) && failed_index < 0) failed_index = index;
  }
  const int passed = failed_index < 0;
  const char *artifact_sha = getenv("PHYOPT_ARTIFACT_SHA256");
  const char *harness_sha = getenv("PHYOPT_HARNESS_SHA256");
  if (!artifact_sha) artifact_sha = "";
  if (!harness_sha) harness_sha = "";

  fputs("PHYOPT_MEASUREMENT {\"kind\":\"CORRECTNESS_CASE\",\"role\":\"EVALUATOR\",\"subject_id\":", stdout);
  print_json_string(case_id);
  printf(",\"sample_index\":null,\"value\":\"%s\",\"unit\":null,\"validity\":\"VALID\",\"domain_payload\":{\"parameters\":{\"n\":%d,\"incx\":%d,\"incy\":%d,\"alpha\":%.9g,\"seed\":%s,\"threads\":%d},", passed ? "PASS" : "FAIL", n, incx, incy, alpha, argv[8], threads);
  if (passed) fputs("\"error_reason\":null,", stdout);
  else printf("\"error_reason\":\"mismatch at logical index %d\",", failed_index);
  printf("\"observed_summary\":{\"max_abs_error\":%.17g,\"max_relative_error\":%.17g},\"reference_summary\":{\"implementation\":\"evaluator scalar float64 accumulation\",\"absolute_tolerance\":1e-5,\"relative_tolerance\":1e-5},\"artifact_identity\":{\"input_path\":", max_abs_error, max_relative_error);
  print_json_string(artifact_path);
  fputs(",\"sha256\":", stdout); print_json_string(artifact_sha);
  fputs(",\"resolved_cblas_saxpy_path\":", stdout); print_json_string(symbol_info.dli_fname);
  fputs("},\"evaluator_binary_identity\":{\"sha256\":", stdout); print_json_string(harness_sha);
  fputs("}}}\n", stdout);

  free(x); free(y); free(reference); dlclose(library);
  return passed ? 0 : 2;
}
