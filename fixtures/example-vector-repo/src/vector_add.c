#include "vector_add.h"

void vector_add(const float *left, const float *right, float *output, int count) {
  for (int index = 0; index < count; index++) output[index] = left[index] + right[index];
}
