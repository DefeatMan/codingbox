package main

import "fmt"

func solve(values []int) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total
}

func main() {
	fmt.Println(solve([]int{1, 2, 3}))
}
