cmake_minimum_required(VERSION 3.16)
project(example_vector C)
add_library(vector STATIC src/vector_add.c)
target_include_directories(vector PUBLIC include)
