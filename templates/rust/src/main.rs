fn solve(values: &[i32]) -> i32 {
    values.iter().sum()
}

fn main() {
    println!("{}", solve(&[1, 2, 3]));
}
