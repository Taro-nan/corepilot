#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "cblas.h"

static uint32_t next_random(uint32_t *state) {
    uint32_t value = *state ? *state : 1u;
    value ^= value << 13; value ^= value >> 17; value ^= value << 5;
    *state = value;
    return value;
}

static float random_float(uint32_t *state) {
    return ((float)(next_random(state) & 0xffffu) / 32768.0f) - 1.0f;
}

static int parse_int(const char *text, int *output) {
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value < INT32_MIN || value > INT32_MAX) return 0;
    *output = (int)value;
    return 1;
}

static int parse_float(const char *text, float *output) {
    char *end = NULL;
    errno = 0;
    float value = strtof(text, &end);
    if (errno != 0 || end == text || *end != '\0' || !isfinite(value)) return 0;
    *output = value;
    return 1;
}

static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor; ++cursor) {
        if (*cursor == '"') fputs("\\\"", stdout);
        else if (*cursor == '\\') fputs("\\\\", stdout);
        else if (*cursor == '\n') fputs("\\n", stdout);
        else if (*cursor < 0x20) printf("\\u%04x", (unsigned int)*cursor);
        else putchar((int)*cursor);
    }
    putchar('"');
}

static size_t vector_length(int logical_length, int increment) {
    if (logical_length <= 0) return 1u;
    return 1u + (size_t)(logical_length - 1) * (size_t)abs(increment);
}

static double seconds_between(struct timespec start, struct timespec end) {
    return (double)(end.tv_sec - start.tv_sec) + (double)(end.tv_nsec - start.tv_nsec) / 1000000000.0;
}

int main(int argc, char **argv) {
    if (argc != 16) {
        fputs("benchmark argument contract mismatch\n", stderr);
        return 64;
    }
    const char *phase = argv[1];
    const char *role = argv[2];
    const char *workload_id = argv[3];
    const char *artifact_path = argv[4];
    int m, n, lda, incx, incy, threads, loops, seed, iteration_index;
    float alpha, beta;
    if ((strcmp(phase, "warmup") != 0 && strcmp(phase, "sample") != 0) ||
        (strcmp(role, "BASELINE") != 0 && strcmp(role, "CANDIDATE") != 0) ||
        !parse_int(argv[5], &m) || !parse_int(argv[6], &n) || !parse_int(argv[7], &lda) ||
        !parse_int(argv[8], &incx) || !parse_int(argv[9], &incy) || !parse_float(argv[10], &alpha) ||
        !parse_float(argv[11], &beta) || !parse_int(argv[12], &threads) || !parse_int(argv[13], &loops) ||
        !parse_int(argv[14], &seed) || !parse_int(argv[15], &iteration_index) ||
        m < 1 || n < 1 || lda < m || incx == 0 || incy == 0 || threads < 1 || loops < 1 || seed < 0 || iteration_index < 0) {
        fputs("invalid benchmark parameters\n", stderr);
        return 64;
    }

    void *library = dlopen(artifact_path, RTLD_NOW | RTLD_LOCAL);
    if (!library) { fprintf(stderr, "dlopen failed: %s\n", dlerror()); return 65; }
    dlerror();
    phyopt_cblas_sgemv_fn sgemv = (phyopt_cblas_sgemv_fn)dlsym(library, "cblas_sgemv");
    const char *symbol_error = dlerror();
    if (symbol_error != NULL || sgemv == NULL) { fprintf(stderr, "dlsym failed: %s\n", symbol_error ? symbol_error : "unknown"); return 65; }

    size_t matrix_count = (size_t)lda * (size_t)n;
    size_t x_count = vector_length(n, incx);
    size_t y_count = vector_length(m, incy);
    float *matrix = (float *)malloc(matrix_count * sizeof(float));
    float *x = (float *)malloc(x_count * sizeof(float));
    float *y = (float *)malloc(y_count * sizeof(float));
    if (!matrix || !x || !y) { fputs("allocation failed\n", stderr); free(matrix); free(x); free(y); return 70; }
    uint32_t random_state = (uint32_t)seed;
    for (size_t index = 0; index < matrix_count; ++index) matrix[index] = random_float(&random_state);
    for (size_t index = 0; index < x_count; ++index) x[index] = random_float(&random_state);
    for (size_t index = 0; index < y_count; ++index) y[index] = random_float(&random_state);

    struct timespec start, end;
    if (clock_gettime(CLOCK_MONOTONIC, &start) != 0) { perror("clock_gettime"); return 71; }
    for (int loop = 0; loop < loops; ++loop) sgemv(CblasColMajor, CblasNoTrans, m, n, alpha, matrix, lda, x, incx, beta, y, incy);
    if (clock_gettime(CLOCK_MONOTONIC, &end) != 0) { perror("clock_gettime"); return 71; }
    double elapsed = seconds_between(start, end);
    double latency = elapsed / (double)loops;
    double gflops = (2.0 * (double)m * (double)n) / latency / 1000000000.0;
    if (!(elapsed > 0.0) || !isfinite(latency) || !isfinite(gflops)) { fputs("invalid timing result\n", stderr); return 72; }

    Dl_info symbol_info;
    memset(&symbol_info, 0, sizeof(symbol_info));
    const char *resolved_path = dladdr((void *)sgemv, &symbol_info) != 0 && symbol_info.dli_fname ? symbol_info.dli_fname : "unresolved";
    const char *artifact_sha256 = getenv("PHYOPT_ARTIFACT_SHA256");
    const char *harness_sha256 = getenv("PHYOPT_HARNESS_SHA256");
    volatile float checksum = y[0];

    if (strcmp(phase, "sample") == 0) {
        fputs("PHYOPT_MEASUREMENT {\"kind\":\"PERFORMANCE_SAMPLE\",\"role\":", stdout); json_string(role);
        fputs(",\"subject_id\":", stdout); json_string(workload_id);
        printf(",\"sample_index\":%d,\"value\":%.17g,\"unit\":\"seconds\",\"validity\":\"VALID\",\"domain_payload\":{", iteration_index, latency);
        printf("\"parameters\":{\"m\":%d,\"n\":%d,\"lda\":%d,\"incx\":%d,\"incy\":%d,\"alpha\":%s,\"beta\":%s,\"threads\":%d,\"loops\":%d,\"seed\":%d},", m, n, lda, incx, incy, argv[10], argv[11], threads, loops, seed);
        printf("\"resource_observation\":{\"thread_environment\":%d,\"active_threads\":null,\"cpu_set\":null,\"numa_node\":null},", threads);
        printf("\"elapsed_seconds\":%.17g,\"latency_seconds\":%.17g,\"gflops\":%.17g,\"checksum\":%.9g,", elapsed, latency, gflops, (double)checksum);
        fputs("\"artifact_identity\":{\"input_path\":", stdout); json_string(artifact_path);
        fputs(",\"sha256\":", stdout); json_string(artifact_sha256 ? artifact_sha256 : "unavailable");
        fputs(",\"resolved_cblas_sgemv_path\":", stdout); json_string(resolved_path);
        fputs("},\"benchmark_identity\":{\"sha256\":", stdout); json_string(harness_sha256 ? harness_sha256 : "unavailable");
        fputs("}}}\n", stdout);
    } else {
        fputs("PHYOPT_WARMUP {\"role\":", stdout); json_string(role);
        fputs(",\"workload_id\":", stdout); json_string(workload_id);
        printf(",\"warmup_index\":%d,\"latency_seconds\":%.17g}\n", iteration_index, latency);
    }

    free(matrix); free(x); free(y);
    /* One sample owns one process. Keep the OpenMP BLAS loaded until process
       exit so dlclose cannot unmap code while libgomp workers are alive. */
    return 0;
}
