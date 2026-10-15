#ifndef DOT_PRODUCT_H
#define DOT_PRODUCT_H

/*
 * dot_product: compute the dot product of two double-precision vectors of
 * length n. Returns 0.0 when n <= 0. Inputs a and b are non-overlapping arrays
 * of length n (n <= 0 means both are ignored).
 */
double dot_product(const double* a, const double* b, int n);

/*
 * reference_dot_product: independent reference implementation using extended
 * precision accumulation. Used ONLY by the correctness test; never part of the
 * candidate under optimization.
 */
double reference_dot_product(const double* a, const double* b, int n);

#endif /* DOT_PRODUCT_H */
