function solve(values: number[]): number {
  // Write your solution here.
  return values.reduce((total, value) => total + value, 0);
}

console.log(solve([1, 2, 3]));
