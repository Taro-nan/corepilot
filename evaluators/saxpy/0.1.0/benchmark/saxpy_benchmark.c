#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

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
  if (errno != 0 || end == value || *end != '\0') {
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

static double seconds(struct timespec start, struct timespec end) {
  return (double)(end.tv_sec - start.tv_sec) + (double)(end.tv_nsec - start.tv_nsec) * 1.0e-9;
}

static void print_json_string(const char *value) {
  putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; ++cursor) {
    if (*cursor == '"' || *cursor == '\\') printf("\\%c", *cursor);
    else if (*cursor == '\n') fputs("\\n", stdout);
    else if (*cursor < 0x20) printf("\\u%04x", *cursor);
    else putchar(*cursor);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc != 13) {
    fprintf(stderr, "usage: saxpy_benchmark PHASE ROLE WORKLOAD ARTIFACT N INCX INCY ALPHA THREADS LOOPS SEED INDEX\n");
    return 64;
  }
  const char *phase = argv[1];
  const char *role = argv[2];
  const char *workload_id = argv[3];
  const char *artifact_path = argv[4];
  const int n = (int)parse_long(argv[5], "n");
  const int incx = (int)parse_long(argv[6], "incx");
  const int incy = (int)parse_long(argv[7], "incy");
  const float alpha = (float)parse_double(argv[8], "alpha");
  const int threads = (int)parse_long(argv[9], "threads");
  const int loops = (int)parse_long(argv[10], "loops");
  uint32_t seed = (uint32_t)parse_long(argv[11], "seed");
  const int sample_index = (int)parse_long(argv[12], "iteration_index");
  if (n < 1 || incx == 0 || incy == 0 || threads < 1 || loops < 1 || sample_index < 0) return 64;

  void *library = dlopen(artifact_path, RTLD_NOW | RTLD_LOCAL);
  if (!library) { fprintf(stderr, "dlopen failed: %s\n", dlerror()); return 65; }
  dlerror();
  cblas_saxpy_fn saxpy = (cblas_saxpy_fn)dlsym(library, "cblas_saxpy");
  const char *symbol_error = dlerror();
  if (symbol_error || !saxpy) { fprintf(stderr, "dlsym failed: %s\n", symbol_error ? symbol_error : "unknown"); dlclose(library); return 65; }
  Dl_info symbol_info;
  memset(&symbol_info, 0, sizeof(symbol_info));
  if (dladdr((void *)saxpy, &symbol_info) == 0 || !symbol_info.dli_fname) { fputs("dladdr failed\n", stderr); dlclose(library); return 65; }

  size_t x_count = 1u + (size_t)(n - 1) * (size_t)abs(incx);
  size_t y_count = 1u + (size_t)(n - 1) * (size_t)abs(incy);
  float *x = (float *)malloc(x_count * sizeof(float));
  float *y = (float *)malloc(y_count * sizeof(float));
  if (!x || !y) { free(x); free(y); dlclose(library); return 70; }
  for (size_t index = 0; index < x_count; ++index) x[index] = random_float(&seed);
  for (size_t index = 0; index < y_count; ++index) y[index] = random_float(&seed);

  struct timespec start;
  struct timespec end;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (int loop = 0; loop < loops; ++loop) saxpy(n, alpha, x, incx, y, incy);
  clock_gettime(CLOCK_MONOTONIC, &end);
  const double elapsed = seconds(start, end);
  const double latency = elapsed / (double)loops;
  const double gflops = (2.0 * (double)n) / latency / 1.0e9;
  volatile float checksum = y[(size_t)(sample_index % n) * (size_t)abs(incy)];
  (void)checksum;

  if (strcmp(phase, "sample") == 0) {
    const char *artifact_sha = getenv("PHYOPT_ARTIFACT_SHA256");
    const char *harness_sha = getenv("PHYOPT_HARNESS_SHA256");
    if (!artifact_sha) artifact_sha = "";
    if (!harness_sha) harness_sha = "";
    fputs("PHYOPT_MEASUREMENT {\"kind\":\"PERFORMANCE_SAMPLE\",\"role\":", stdout); print_json_string(role);
    fputs(",\"subject_id\":", stdout); print_json_string(workload_id);
    printf(",\"sample_index\":%d,\"value\":%.17g,\"unit\":\"seconds\",\"validity\":\"VALID\",\"domain_payload\":{\"parameters\":{\"n\":%d,\"incx\":%d,\"incy\":%d,\"alpha\":%.9g,\"loops\":%d,\"seed\":%s,\"threads\":%d},\"elapsed_seconds\":%.17g,\"latency_seconds\":%.17g,\"gflops\":%.17g,\"artifact_identity\":{\"input_path\":", sample_index, latency, n, incx, incy, alpha, loops, argv[11], threads, elapsed, latency, gflops);
    print_json_string(artifact_path);
    fputs(",\"sha256\":", stdout); print_json_string(artifact_sha);
    fputs(",\"resolved_cblas_saxpy_path\":", stdout); print_json_string(symbol_info.dli_fname);
    fputs("},\"benchmark_identity\":{\"sha256\":", stdout); print_json_string(harness_sha);
    fputs("}}}\n", stdout);
  }

  free(x); free(y); dlclose(library);
  return 0;
}
