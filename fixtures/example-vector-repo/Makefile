CC ?= cc
CFLAGS ?= -O2 -std=c11

all: libvector.a

libvector.a: src/vector_add.o
	ar rcs $@ $<

src/vector_add.o: src/vector_add.c include/vector_add.h
	$(CC) $(CFLAGS) -Iinclude -c $< -o $@

test: src/vector_add.c tests/test_vector_add.c
	$(CC) $(CFLAGS) -Iinclude $^ -o vector-test
	./vector-test
