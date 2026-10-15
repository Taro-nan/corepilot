#include "vector_add.h"

int main(void) {
  float left[2] = {1.0f, 2.0f};
  float right[2] = {3.0f, 4.0f};
  float output[2] = {0.0f, 0.0f};
  vector_add(left, right, output, 2);
  return output[0] == 4.0f && output[1] == 6.0f ? 0 : 1;
}
