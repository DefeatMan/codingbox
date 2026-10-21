#include <iostream>
#include <numeric>
#include <vector>

int solve(const std::vector<int>& values) {
    return std::accumulate(values.begin(), values.end(), 0);
}

int main() {
    std::cout << solve({1, 2, 3}) << '\n';
}
