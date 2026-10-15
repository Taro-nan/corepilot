#include "scalar_oracle.h"

void scalar_dilate3x3(const double *source, int source_stride, double *destination, int destination_stride, int width, int height) {
  for (int row = 0; row < height; ++row) {
    for (int column = 0; column < width; ++column) {
      double maximum = source[(row - 1) * source_stride + column - 1];
      for (int neighbor_row = -1; neighbor_row <= 1; ++neighbor_row) {
        for (int neighbor_column = -1; neighbor_column <= 1; ++neighbor_column) {
          double value = source[(row + neighbor_row) * source_stride + column + neighbor_column];
          if (value > maximum) maximum = value;
        }
      }
      destination[row * destination_stride + column] = maximum;
    }
  }
}
