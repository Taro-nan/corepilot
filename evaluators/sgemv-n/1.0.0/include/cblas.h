#ifndef PHYOPT_FORMAL_CBLAS_H
#define PHYOPT_FORMAL_CBLAS_H

enum CBLAS_ORDER { CblasRowMajor = 101, CblasColMajor = 102 };
enum CBLAS_TRANSPOSE { CblasNoTrans = 111, CblasTrans = 112, CblasConjTrans = 113, CblasConjNoTrans = 114 };

typedef void (*phyopt_cblas_sgemv_fn)(
    enum CBLAS_ORDER, enum CBLAS_TRANSPOSE, int, int, float,
    const float *, int, const float *, int, float, float *, int);

#endif
