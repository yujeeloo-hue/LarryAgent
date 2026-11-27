#include <cstdio>

int add(int a, int b) {
  int sum = a + b; // BREAK
  return sum;
}

int main() {
  int x = 40;
  int y = 2;
  int z = add(x, y);
  std::printf("%d\n", z);
  return 0;
}
