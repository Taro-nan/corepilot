#include "vector_add.h"

int main(void) {
  float left[4] = {1.0f, 2.0f, 3.0f, 4.0f};
  float right[4] = {4.0f, 3.0f, 2.0f, 1.0f};
  float output[4];
  vector_add(left, right, output, 4);
  return output[0] == 5.0f ? 0 : 1;
}
