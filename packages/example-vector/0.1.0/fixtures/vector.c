void cblas_saxpy(const int count, const float scale, const float *input,
                 const int input_stride, float *output, const int output_stride) {
    int input_index = input_stride < 0 ? (1 - count) * input_stride : 0;
    int output_index = output_stride < 0 ? (1 - count) * output_stride : 0;
    for (int index = 0; index < count; index++) {
        output[output_index] += scale * input[input_index];
        input_index += input_stride;
        output_index += output_stride;
    }
}
