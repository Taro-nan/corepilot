#include "dot_product.h"

/* Naive scalar implementation. This is the ONLY file a candidate may modify. */
double dot_product(const double* a, const double* b, int n) {
  double sum = 0.0;
  for (int i = 0; i < n; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
