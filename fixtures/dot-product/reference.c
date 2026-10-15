#include "dot_product.h"

/* Independent reference: extended-precision (long double) accumulation. */
double reference_dot_product(const double* a, const double* b, int n) {
  long double sum = 0.0L;
  for (int i = 0; i < n; i++) {
    sum += (long double)a[i] * (long double)b[i];
  }
  return (double)sum;
}
