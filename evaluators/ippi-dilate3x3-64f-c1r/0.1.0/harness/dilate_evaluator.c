#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../correctness/scalar_oracle.h"

typedef struct { int width; int height; } RoiSize;
typedef int (*DilateFunction)(const double *, int, double *, int, RoiSize);

typedef struct {
  void *handle;
  DilateFunction function;
  char resolved_path[PATH_MAX];
} LoadedLibrary;

static int parse_integer(const char *value, const char *name) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno || end == value || *end || parsed < INT_MIN || parsed > INT_MAX) {
    fprintf(stderr, "invalid %s: %s\n", name, value);
    exit(64);
  }
  return (int)parsed;
}

static uint32_t next_random(uint32_t *state) {
  uint32_t value = *state ? *state : 1u;
  value ^= value << 13;
  value ^= value >> 17;
  value ^= value << 5;
  *state = value;
  return value;
}

static double input_value(const char *pattern, size_t index, uint32_t *state) {
  if (strcmp(pattern, "random") == 0) return ((int)(next_random(state) % 20001u) - 10000) / 8.0;
  if (strcmp(pattern, "equal") == 0) return -7.25;
  if (strcmp(pattern, "ascending") == 0) return (double)index / 4.0;
  if (strcmp(pattern, "descending") == 0) return -(double)index / 4.0;
  if (strcmp(pattern, "positive") == 0) return (double)(index % 97u) + 0.5;
  if (strcmp(pattern, "negative") == 0) return -(double)(index % 97u) - 0.5;
  if (strcmp(pattern, "mixed") == 0) return index % 2u ? -(double)(index % 31u) : (double)(index % 29u);
  if (strcmp(pattern, "extreme") == 0) {
    const double values[] = { DBL_MAX / 4.0, -DBL_MAX / 4.0, DBL_MIN * 1024.0, -DBL_MIN * 1024.0, 0.5, -0.5 };
    return values[index % 6u];
  }
  fprintf(stderr, "unknown input pattern: %s\n", pattern);
  exit(64);
}

static void print_string(const char *value) {
  putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; ++cursor) {
    if (*cursor == '"' || *cursor == '\\') printf("\\%c", *cursor);
    else if (*cursor == '\n') fputs("\\n", stdout);
    else if (*cursor == '\r') fputs("\\r", stdout);
    else if (*cursor < 0x20) printf("\\u%04x", *cursor);
    else putchar(*cursor);
  }
  putchar('"');
}

static LoadedLibrary load_library(const char *artifact_path) {
  LoadedLibrary library = {0};
  char expected_path[PATH_MAX];
  if (!realpath(artifact_path, expected_path)) { perror("realpath artifact"); exit(65); }
  library.handle = dlopen(expected_path, RTLD_NOW | RTLD_LOCAL);
  if (!library.handle) { fprintf(stderr, "dlopen: %s\n", dlerror()); exit(65); }
  dlerror();
  library.function = (DilateFunction)dlsym(library.handle, "_Z21ippiDilate3x3_64f_C1RPKdiPdi8IppiSize");
  const char *symbol_error = dlerror();
  if (symbol_error || !library.function) { fprintf(stderr, "dlsym: %s\n", symbol_error ? symbol_error : "missing symbol"); exit(65); }
  Dl_info symbol_info = {0};
  if (!dladdr((void *)library.function, &symbol_info) || !symbol_info.dli_fname || !realpath(symbol_info.dli_fname, library.resolved_path)) {
    fputs("cannot resolve loaded symbol path\n", stderr);
    exit(65);
  }
  if (strcmp(expected_path, library.resolved_path) != 0) { fputs("loaded library path differs from declared artifact\n", stderr); exit(65); }
  return library;
}

static void print_identity(const char *artifact_path, const char *resolved_path, const char *binary_field) {
  const char *artifact_hash = getenv("PHYOPT_ARTIFACT_SHA256");
  const char *harness_hash = getenv("PHYOPT_HARNESS_SHA256");
  if (!artifact_hash || strlen(artifact_hash) != 64 || !harness_hash || strlen(harness_hash) != 64) {
    fputs("missing artifact or harness SHA-256\n", stderr);
    exit(65);
  }
  fputs("\"artifact_identity\":{\"input_path\":", stdout);
  print_string(artifact_path);
  fputs(",\"sha256\":", stdout);
  print_string(artifact_hash);
  fputs(",\"resolved_symbol_path\":", stdout);
  print_string(resolved_path);
  fputs("},", stdout);
  print_string(binary_field);
  fputs(":{\"sha256\":", stdout);
  print_string(harness_hash);
  fputs("}", stdout);
}

static double *new_image(int width, int height, int padding, int halo, int *stride, const char *pattern, uint32_t *seed) {
  *stride = width + padding + (halo ? 2 : 0);
  size_t count = (size_t)(height + (halo ? 2 : 0)) * (size_t)*stride;
  double *image = malloc(count * sizeof(double));
  if (!image) { fputs("image allocation failed\n", stderr); exit(70); }
  for (size_t index = 0; index < count; ++index) image[index] = input_value(pattern, index, seed);
  return image;
}

static int correctness(int argc, char **argv) {
  if (argc != 13) return 64;
  const char *case_id = argv[2];
  const char *artifact_path = argv[3];
  int width = parse_integer(argv[4], "width");
  int height = parse_integer(argv[5], "height");
  int source_padding = parse_integer(argv[6], "src_padding");
  int destination_padding = parse_integer(argv[7], "dst_padding");
  const char *pattern = argv[8];
  int seed = parse_integer(argv[9], "seed");
  const char *error_mode = argv[10];
  int expected_status = parse_integer(argv[11], "expected_status");
  int threads = parse_integer(argv[12], "threads");
  if (width < 0 || width > 4096 || height < 0 || height > 4096 || source_padding < 0 || destination_padding < 0 || threads != 1) return 64;
  int specified_status = 0;
  if (strcmp(error_mode, "none") == 0) specified_status = 0;
  else if (strcmp(error_mode, "null_src") == 0 || strcmp(error_mode, "null_dst") == 0) specified_status = -8;
  else if (strcmp(error_mode, "zero_width") == 0 || strcmp(error_mode, "zero_height") == 0) specified_status = -6;
  else if (strcmp(error_mode, "short_src_step") == 0 || strcmp(error_mode, "short_dst_step") == 0) specified_status = -16;
  else return 64;
  if (expected_status != specified_status || (width == 0) != (strcmp(error_mode, "zero_width") == 0) ||
      (height == 0) != (strcmp(error_mode, "zero_height") == 0)) return 64;

  LoadedLibrary library = load_library(artifact_path);
  uint32_t random_state = (uint32_t)seed;
  int source_stride = 0;
  int destination_stride = 0;
  double *source = new_image(width, height, source_padding, 1, &source_stride, pattern, &random_state);
  size_t source_count = (size_t)(height + 2) * (size_t)source_stride;
  double *source_snapshot = malloc(source_count * sizeof(double));
  if (!source_snapshot) return 70;
  memcpy(source_snapshot, source, source_count * sizeof(double));
  double *destination = new_image(width, height ? height : 1, destination_padding, 0, &destination_stride, "equal", &random_state);
  size_t destination_count = (size_t)(height ? height : 1) * (size_t)destination_stride;
  for (size_t index = 0; index < destination_count; ++index) destination[index] = 1234567.125;
  double *reference = malloc(destination_count * sizeof(double));
  if (!reference) return 70;
  memcpy(reference, destination, destination_count * sizeof(double));
  const double *source_roi = source + source_stride + 1;
  int source_step = source_stride * (int)sizeof(double);
  int destination_step = destination_stride * (int)sizeof(double);
  if (strcmp(error_mode, "null_src") == 0) source_roi = NULL;
  if (strcmp(error_mode, "short_src_step") == 0) source_step = width * (int)sizeof(double) - 1;
  if (strcmp(error_mode, "short_dst_step") == 0) destination_step = width * (int)sizeof(double) - 1;
  double *destination_roi = strcmp(error_mode, "null_dst") == 0 ? NULL : destination;
  RoiSize roi = {width, height};
  int observed_status = library.function(source_roi, source_step, destination_roi, destination_step, roi);
  if (expected_status == 0) scalar_dilate3x3(source + source_stride + 1, source_stride, reference, destination_stride, width, height);
  int mismatches = 0;
  for (size_t index = 0; index < destination_count; ++index) {
    if (destination[index] != reference[index]) ++mismatches;
  }
  int source_mutated = memcmp(source, source_snapshot, source_count * sizeof(double)) != 0;
  int passed = observed_status == expected_status && mismatches == 0 && !source_mutated;
  fputs("PHYOPT_MEASUREMENT {\"kind\":\"CORRECTNESS_CASE\",\"role\":\"EVALUATOR\",\"subject_id\":", stdout);
  print_string(case_id);
  printf(",\"sample_index\":null,\"value\":\"%s\",\"unit\":null,\"validity\":\"VALID\",\"domain_payload\":{\"parameters\":{\"width\":%d,\"height\":%d,\"src_padding\":%d,\"dst_padding\":%d,\"pattern\":", passed ? "PASS" : "FAIL", width, height, source_padding, destination_padding);
  print_string(pattern);
  printf(",\"seed\":%d,\"error_mode\":", seed);
  print_string(error_mode);
  printf(",\"expected_status\":%d},\"observed_summary\":{\"status\":%d,\"mismatches\":%d,\"source_mutated\":%s},\"reference_summary\":{\"implementation\":\"independent scalar 3x3 maximum\",\"comparison\":\"exact finite float64 numeric equality\"},", expected_status, observed_status, mismatches, source_mutated ? "true" : "false");
  print_identity(artifact_path, library.resolved_path, "evaluator_binary_identity");
  fputs("}}\n", stdout);
  free(source); free(source_snapshot); free(destination); free(reference); dlclose(library.handle);
  return passed ? 0 : 2;
}

static double elapsed_seconds(struct timespec start, struct timespec end) {
  return (double)(end.tv_sec - start.tv_sec) + (double)(end.tv_nsec - start.tv_nsec) / 1000000000.0;
}

static int performance(int argc, char **argv) {
  if (argc != 14) return 64;
  const char *phase = argv[2];
  const char *role = argv[3];
  const char *workload_id = argv[4];
  const char *artifact_path = argv[5];
  int width = parse_integer(argv[6], "width");
  int height = parse_integer(argv[7], "height");
  int source_padding = parse_integer(argv[8], "src_padding");
  int destination_padding = parse_integer(argv[9], "dst_padding");
  int loops = parse_integer(argv[10], "loops");
  int seed = parse_integer(argv[11], "seed");
  int threads = parse_integer(argv[12], "threads");
  int iteration = parse_integer(argv[13], "iteration_index");
  if ((strcmp(phase, "sample") && strcmp(phase, "warmup")) || width < 1 || width > 4096 || height < 1 || height > 2160 ||
      source_padding < 0 || destination_padding < 0 || loops < 1 || loops > 10000 || threads != 1 || iteration < 0) return 64;
  LoadedLibrary library = load_library(artifact_path);
  uint32_t random_state = (uint32_t)seed;
  int source_stride = 0;
  int destination_stride = 0;
  double *source = new_image(width, height, source_padding, 1, &source_stride, "random", &random_state);
  double *destination = new_image(width, height, destination_padding, 0, &destination_stride, "equal", &random_state);
  const double *source_roi = source + source_stride + 1;
  RoiSize roi = {width, height};
  struct timespec start;
  struct timespec end;
  int status = 0;
  if (clock_gettime(CLOCK_MONOTONIC, &start) != 0) return 65;
  for (int call = 0; call < loops; ++call) status = library.function(source_roi, source_stride * (int)sizeof(double), destination, destination_stride * (int)sizeof(double), roi);
  if (clock_gettime(CLOCK_MONOTONIC, &end) != 0) return 65;
  double latency = elapsed_seconds(start, end) / (double)loops;
  volatile double checksum = destination[(size_t)(height / 2) * (size_t)destination_stride + (size_t)(width / 2)];
  if (status != 0 || !isfinite(checksum) || !isfinite(latency) || latency <= 0) return 65;
  if (strcmp(phase, "sample") == 0) {
    fputs("PHYOPT_MEASUREMENT {\"kind\":\"PERFORMANCE_SAMPLE\",\"role\":", stdout); print_string(role);
    fputs(",\"subject_id\":", stdout); print_string(workload_id);
    printf(",\"sample_index\":%d,\"value\":%.17g,\"unit\":\"seconds\",\"validity\":\"VALID\",\"domain_payload\":{\"parameters\":{\"width\":%d,\"height\":%d,\"src_padding\":%d,\"dst_padding\":%d,\"loops\":%d,\"seed\":%d},\"elapsed_seconds\":%.17g,\"latency_seconds\":%.17g,", iteration, latency, width, height, source_padding, destination_padding, loops, seed, latency * loops, latency);
    print_identity(artifact_path, library.resolved_path, "benchmark_identity");
    fputs("}}\n", stdout);
  }
  free(source); free(destination); dlclose(library.handle);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (strcmp(argv[1], "correctness") == 0) return correctness(argc, argv);
  if (strcmp(argv[1], "performance") == 0) return performance(argc, argv);
  return 64;
}
