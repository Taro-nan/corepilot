#define _GNU_SOURCE
#include <dlfcn.h>
#include <hmppi.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef HmppResult (*DilateFunction)(const double *, int32_t, double *, int32_t, HmppiSize);

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <entry-library>\n", argv[0]);
        return 2;
    }
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (library == NULL) {
        fprintf(stderr, "dlopen: %s\n", dlerror());
        return 3;
    }
    DilateFunction dilate = (DilateFunction)dlsym(library, "HMPPI_Dilate3x3_64f_C1R");
    if (dilate == NULL) {
        fprintf(stderr, "dlsym: %s\n", dlerror());
        return 4;
    }
    Dl_info loaded;
    if (dladdr((void *)dilate, &loaded) == 0) {
        fprintf(stderr, "dladdr failed\n");
        return 5;
    }
    printf("loaded=%s\n", loaded.dli_fname);
    const char *loader_path = getenv("LD_LIBRARY_PATH");
    const char *preload = getenv("LD_PRELOAD");
    printf("LD_LIBRARY_PATH=%s\n", loader_path == NULL ? "" : loader_path);
    printf("LD_PRELOAD=%s\n", preload == NULL ? "" : preload);
    void *fft_symbol = dlsym(RTLD_DEFAULT, "kml_fft_execute_dft_c2r");
    Dl_info fft_provider;
    if (fft_symbol == NULL || dladdr(fft_symbol, &fft_provider) == 0) {
        fprintf(stderr, "kml_fft_execute_dft_c2r provider not loaded\n");
        return 5;
    }
    printf("fft_provider=%s\n", fft_provider.dli_fname);
    const char *additional_symbols[] = { "HMPP_Malloc", "cblas_dgemm" };
    for (size_t symbol_index = 0; symbol_index < sizeof(additional_symbols) / sizeof(additional_symbols[0]); symbol_index++) {
        void *resolved_symbol = dlsym(RTLD_DEFAULT, additional_symbols[symbol_index]);
        Dl_info provider;
        if (resolved_symbol == NULL || dladdr(resolved_symbol, &provider) == 0) {
            fprintf(stderr, "provider not loaded: %s\n", additional_symbols[symbol_index]);
            return 5;
        }
        printf("symbol_provider=%s:%s\n", additional_symbols[symbol_index], provider.dli_fname);
    }
    fflush(stdout);

    enum { SOURCE_ROWS = 6, SOURCE_STRIDE = 9, DESTINATION_STRIDE = 11, ROI_WIDTH = 5, ROI_HEIGHT = 4 };
    double source[SOURCE_ROWS * SOURCE_STRIDE];
    double destination[ROI_HEIGHT * DESTINATION_STRIDE];
    for (int row = 0; row < SOURCE_ROWS; row++) {
        for (int column = 0; column < SOURCE_STRIDE; column++) {
            source[row * SOURCE_STRIDE + column] = (double)(row * 47 - column * 13);
        }
    }
    for (int index = 0; index < ROI_HEIGHT * DESTINATION_STRIDE; index++) destination[index] = -9999.0;
    const double *source_roi = source + SOURCE_STRIDE + 1;
    HmppiSize roi = { ROI_WIDTH, ROI_HEIGHT };
    HmppResult status = dilate(source_roi, SOURCE_STRIDE * (int)sizeof(double), destination,
                              DESTINATION_STRIDE * (int)sizeof(double), roi);
    printf("status=%d\n", (int)status);
    if (status != HMPP_STS_NO_ERR) return 6;
    for (int row = 0; row < ROI_HEIGHT; row++) {
        for (int column = 0; column < ROI_WIDTH; column++) {
            double expected = source_roi[row * SOURCE_STRIDE + column];
            for (int vertical = -1; vertical <= 1; vertical++) {
                for (int horizontal = -1; horizontal <= 1; horizontal++) {
                    double value = source_roi[(row + vertical) * SOURCE_STRIDE + column + horizontal];
                    if (value > expected) expected = value;
                }
            }
            double actual = destination[row * DESTINATION_STRIDE + column];
            if (actual != expected) {
                fprintf(stderr, "mismatch at (%d,%d): actual=%g expected=%g\n", column, row, actual, expected);
                return 7;
            }
        }
    }
    puts("valid_roi_exact_match=true");
    FILE *maps = fopen("/proc/self/maps", "r");
    if (maps == NULL) {
        perror("/proc/self/maps");
        return 8;
    }
    char line[1024];
    char previous[1024] = "";
    while (fgets(line, sizeof(line), maps) != NULL) {
        char *loaded_path = strchr(line, '/');
        if (loaded_path == NULL || strstr(loaded_path, ".so") == NULL) continue;
        loaded_path[strcspn(loaded_path, "\n")] = '\0';
        if (strcmp(loaded_path, previous) == 0) continue;
        printf("map_path=%s\n", loaded_path);
        snprintf(previous, sizeof(previous), "%s", loaded_path);
    }
    fclose(maps);
    return 0;
}
