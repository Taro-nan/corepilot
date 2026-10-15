#include <math.h>
#include <stdio.h>

#include "dot_product.h"

/*
 * Correctness test (frozen, never modified by a candidate). Covers empty
 * input, single element, non-multiple-of-unroll lengths, mixed signs, gentle
 * cancellation, and a larger length. Each case prints exactly one PASS or FAIL
 * line; the harness counts PASS/FAIL occurrences.
 */
static int check(const char* name, const double* a, const double* b, int n) {
  double actual = dot_product(a, b, n);
  double expected = reference_dot_product(a, b, n);
  double scale = fabs(expected) > 1.0 ? fabs(expected) : 1.0;
  double tol = 1e-12 * scale;
  if (fabs(actual - expected) > tol) {
    printf("FAIL %s actual=%.17g expected=%.17g\n", name, actual, expected);
    return 1;
  }
  printf("PASS %s\n", name);
  return 0;
}

int main(void) {
  int fails = 0;

  /* empty input (n=0) */
  fails += check("empty", 0, 0, 0);

  /* single element (n=1) */
  {
    double a[1] = {2.5};
    double b[1] = {4.0};
    fails += check("single", a, b, 1);
  }

  /* non-multiple-of-unroll lengths */
  {
    double a[3] = {1.0, 2.0, 3.0};
    double b[3] = {4.0, 5.0, 6.0};
    fails += check("len3", a, b, 3);
  }
  {
    double a[5] = {1.0, 2.0, 3.0, 4.0, 5.0};
    double b[5] = {1.0, 1.0, 1.0, 1.0, 1.0};
    fails += check("len5", a, b, 5);
  }
  {
    double a[7] = {1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0};
    double b[7] = {7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0};
    fails += check("len7", a, b, 7);
  }

  /* mixed signs */
  {
    double a[4] = {1.0, -2.0, 3.0, -4.0};
    double b[4] = {-1.0, 2.0, -3.0, 4.0};
    fails += check("mixed_sign", a, b, 4);
  }

  /* gentle cancellation (magnitude ~1e6, no double precision loss) */
  {
    double a[4] = {1e6, 1.0, -1e6, 1.0};
    double b[4] = {1.0, 1.0, 1.0, 1.0};
    fails += check("cancellation", a, b, 4);
  }

  /* larger length (257) */
  {
    double a[257];
    double b[257];
    for (int i = 0; i < 257; i++) {
      a[i] = i * 0.5;
      b[i] = (i % 2) ? -0.25 : 0.25;
    }
    fails += check("len257", a, b, 257);
  }

  return fails > 0 ? 1 : 0;
}
