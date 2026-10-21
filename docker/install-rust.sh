#!/bin/sh
set -eu
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/rustup-cargo
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /opt/install-rustup.sh
sh /opt/install-rustup.sh -y --no-modify-path --profile minimal --default-toolchain 1.90.0 --component rust-analyzer --component rust-src
toolchain=$(/opt/rustup-cargo/bin/rustup show active-toolchain | cut -d ' ' -f 1)
ln -sfn "/opt/rustup/toolchains/$toolchain" /opt/rust
chmod -R a+rX /opt/rustup
rm /opt/install-rustup.sh
