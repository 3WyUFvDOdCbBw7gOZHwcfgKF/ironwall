#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
examples_root="$(cd "$script_dir/../.." && pwd)"
release_root="$(cd "$script_dir/../../.." && pwd)"
build_root="$examples_root/build/native"
cc_bin="${CC:-cc}"
ar_bin="${AR:-ar}"

mkdir -p "$build_root"
rm -f "$build_root/ffi_sum4.o" "$build_root/ffi_negate.o" "$build_root/libffi_example.a"

"$cc_bin" -O2 -std=c11 -I"$release_root/cheader" -c "$script_dir/ffi_sum4.c" -o "$build_root/ffi_sum4.o"
"$cc_bin" -O2 -std=c11 -I"$release_root/cheader" -c "$script_dir/ffi_negate.c" -o "$build_root/ffi_negate.o"
"$ar_bin" rcs "$build_root/libffi_example.a" "$build_root/ffi_sum4.o" "$build_root/ffi_negate.o"