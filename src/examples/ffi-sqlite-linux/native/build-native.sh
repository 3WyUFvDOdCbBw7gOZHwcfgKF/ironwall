#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd)"
EXAMPLE_ROOT="$(cd "$SCRIPT_ROOT/.." && pwd)"
NATIVE_ROOT="$EXAMPLE_ROOT/native"

mkdir -p "$NATIVE_ROOT"
chmod +x "$EXAMPLE_ROOT/sqlite-tools-linux-x64-3530100/sqlite3"

cc -O2 -std=c11 -c "$NATIVE_ROOT/sqlite-self-check.c" -o "$NATIVE_ROOT/sqlite-self-check.o"
ar rcs "$NATIVE_ROOT/libsqlite_ffi_example.a" "$NATIVE_ROOT/sqlite-self-check.o"