#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cblas.h"

#define ATOL 0.0001
#define RTOL 0.0001

static uint32_t next_random(uint32_t *state) {
    uint32_t value = *state ? *state : 1u;
    value ^= value << 13;
    value ^= value >> 17;
    value ^= value << 5;
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
        switch (*cursor) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (*cursor < 0x20) printf("\\u%04x", (unsigned int)*cursor);
                else putchar((int)*cursor);
        }
    }
    putchar('"');
}

static void emit_invalid(const char *case_id, const char *reason) {
    fputs("PHYOPT_MEASUREMENT {\"kind\":\"CORRECTNESS_CASE\",\"role\":\"EVALUATOR\",\"subject_id\":", stdout);
    json_string(case_id);
    fputs(",\"sample_index\":null,\"value\":\"FAIL\",\"unit\":null,\"validity\":\"INVALID\",\"domain_payload\":{\"error_reason\":", stdout);
    json_string(reason);
    fputs("}}\n", stdout);
}

static size_t vector_length(int logical_length, int increment) {
    if (logical_length <= 0) return 1u;
    return 1u + (size_t)(logical_length - 1) * (size_t)abs(increment);
}

static size_t vector_index(int logical_index, int logical_length, int increment) {
    size_t start = increment < 0 ? (size_t)(logical_length - 1) * (size_t)(-increment) : 0u;
    return (size_t)((long long)start + (long long)logical_index * (long long)increment);
}

int main(int argc, char **argv) {
    if (argc != 12) {
        emit_invalid(argc > 1 ? argv[1] : "unknown", "argument_contract_mismatch");
        return 64;
    }
    const char *case_id = argv[1];
    const char *artifact_path = argv[2];
    int m, n, lda, incx, incy, threads, seed;
    float alpha, beta;
    if (!parse_int(argv[3], &m) || !parse_int(argv[4], &n) || !parse_int(argv[5], &lda) ||
        !parse_int(argv[6], &incx) || !parse_int(argv[7], &incy) || !parse_float(argv[8], &alpha) ||
        !parse_float(argv[9], &beta) || !parse_int(argv[10], &threads) || !parse_int(argv[11], &seed) ||
        m < 0 || n < 0 || lda < (m > 1 ? m : 1) || incx == 0 || incy == 0 || threads < 1 || seed < 0) {
        emit_invalid(case_id, "invalid_case_parameters");
        return 64;
    }

    void *library = dlopen(artifact_path, RTLD_NOW | RTLD_LOCAL);
    if (!library) {
        const char *open_error = dlerror();
        emit_invalid(case_id, open_error ? open_error : "dlopen_failed");
        return 65;
    }
    dlerror();
    phyopt_cblas_sgemv_fn sgemv = (phyopt_cblas_sgemv_fn)dlsym(library, "cblas_sgemv");
    const char *symbol_error = dlerror();
    if (symbol_error != NULL || sgemv == NULL) {
        emit_invalid(case_id, symbol_error ? symbol_error : "dlsym_failed");
        return 65;
    }

    size_t matrix_count = n > 0 ? (size_t)lda * (size_t)n : 1u;
    size_t x_count = vector_length(n, incx);
    size_t y_count = vector_length(m, incy);
    float *matrix = (float *)calloc(matrix_count, sizeof(float));
    float *x = (float *)calloc(x_count, sizeof(float));
    float *y = (float *)calloc(y_count, sizeof(float));
    float *initial_y = (float *)calloc(y_count, sizeof(float));
    double *reference = (double *)calloc(m > 0 ? (size_t)m : 1u, sizeof(double));
    if (!matrix || !x || !y || !initial_y || !reference) {
        emit_invalid(case_id, "allocation_failed");
        free(matrix); free(x); free(y); free(initial_y); free(reference);
        return 70;
    }

    uint32_t random_state = (uint32_t)seed;
    for (int column = 0; column < n; ++column) {
        for (int row = 0; row < m; ++row) matrix[(size_t)column * (size_t)lda + (size_t)row] = random_float(&random_state);
    }
    for (int column = 0; column < n; ++column) x[vector_index(column, n, incx)] = random_float(&random_state);
    for (int row = 0; row < m; ++row) {
        size_t index = vector_index(row, m, incy);
        y[index] = random_float(&random_state);
        initial_y[index] = y[index];
        reference[row] = (double)y[index];
    }

    if (!(m == 0 || n == 0 || (alpha == 0.0f && beta == 1.0f))) {
        for (int row = 0; row < m; ++row) {
            double sum = 0.0;
            for (int column = 0; column < n; ++column) {
                sum += (double)matrix[(size_t)column * (size_t)lda + (size_t)row] *
                       (double)x[vector_index(column, n, incx)];
            }
            reference[row] = (double)alpha * sum + (double)beta * (double)initial_y[vector_index(row, m, incy)];
        }
    }

    sgemv(CblasColMajor, CblasNoTrans, m, n, alpha, matrix, lda, x, incx, beta, y, incy);

    double max_abs_error = 0.0;
    double max_relative_error = 0.0;
    int first_failure = -1;
    for (int row = 0; row < m; ++row) {
        double observed = (double)y[vector_index(row, m, incy)];
        double expected = reference[row];
        double absolute_error = fabs(observed - expected);
        double relative_error = absolute_error / fmax(fabs(expected), 1.0e-30);
        double tolerance = ATOL + RTOL * fabs(expected);
        if (absolute_error > max_abs_error) max_abs_error = absolute_error;
        if (relative_error > max_relative_error) max_relative_error = relative_error;
        if ((!isfinite(observed) || absolute_error > tolerance) && first_failure < 0) first_failure = row;
    }

    Dl_info symbol_info;
    memset(&symbol_info, 0, sizeof(symbol_info));
    const char *resolved_path = dladdr((void *)sgemv, &symbol_info) != 0 && symbol_info.dli_fname ? symbol_info.dli_fname : "unresolved";
    const char *artifact_sha256 = getenv("PHYOPT_ARTIFACT_SHA256");
    const char *harness_sha256 = getenv("PHYOPT_HARNESS_SHA256");
    const char *status = first_failure < 0 ? "PASS" : "FAIL";

    fputs("PHYOPT_MEASUREMENT {\"kind\":\"CORRECTNESS_CASE\",\"role\":\"EVALUATOR\",\"subject_id\":", stdout);
    json_string(case_id);
    printf(",\"sample_index\":null,\"value\":\"%s\",\"unit\":null,\"validity\":\"VALID\",\"domain_payload\":{", status);
    printf("\"parameters\":{\"m\":%d,\"n\":%d,\"lda\":%d,\"incx\":%d,\"incy\":%d,\"alpha\":%s,\"beta\":%s,\"threads\":%d,\"seed\":%d},", m, n, lda, incx, incy, argv[8], argv[9], threads, seed);
    printf("\"resource_observation\":{\"thread_environment\":%d,\"active_threads\":null,\"cpu_set\":null,\"numa_node\":null},", threads);
    printf("\"error_reason\":%s,", first_failure < 0 ? "null" : "\"tolerance_exceeded\"");
    printf("\"observed_summary\":{\"max_abs_error\":%.17g,\"max_relative_error\":%.17g,\"first_failure_index\":%d},", max_abs_error, max_relative_error, first_failure);
    printf("\"reference_summary\":{\"implementation\":\"scalar_binary64\",\"absolute_tolerance\":%.17g,\"relative_tolerance\":%.17g},", ATOL, RTOL);
    fputs("\"artifact_identity\":{\"input_path\":", stdout); json_string(artifact_path);
    fputs(",\"sha256\":", stdout); json_string(artifact_sha256 ? artifact_sha256 : "unavailable");
    fputs(",\"resolved_cblas_sgemv_path\":", stdout); json_string(resolved_path);
    fputs("},\"evaluator_binary_identity\":{\"sha256\":", stdout); json_string(harness_sha256 ? harness_sha256 : "unavailable");
    fputs("}}}\n", stdout);

    free(matrix); free(x); free(y); free(initial_y); free(reference);
    /* One case owns one process. Keep the OpenMP BLAS loaded until process exit
       so dlclose cannot unmap code while libgomp worker threads are alive. */
    return first_failure < 0 ? 0 : 1;
}
