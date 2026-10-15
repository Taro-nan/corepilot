CC = gcc
# No -ffast-math: mathematical semantics must not be relaxed.
CFLAGS = -O2 -std=c11 -Wall

test: dot_product.o reference.o test_main.o
	$(CC) $(CFLAGS) -o test dot_product.o reference.o test_main.o -lm

dot_product.o: dot_product.c dot_product.h
	$(CC) $(CFLAGS) -c dot_product.c -o dot_product.o

reference.o: reference.c dot_product.h
	$(CC) $(CFLAGS) -c reference.c -o reference.o

test_main.o: test_main.c dot_product.h
	$(CC) $(CFLAGS) -c test_main.c -o test_main.o

clean:
	rm -f test test.exe *.o
