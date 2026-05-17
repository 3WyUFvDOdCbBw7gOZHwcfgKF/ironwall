#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
USACO_DIR="$ROOT_DIR/src/examples/USACO_TEST"
COMPILER_NODE="${NODE:-node}"
COMPILER_CLI="$ROOT_DIR/build/main.js"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

compiler_path_arg() {
  local path_value="$1"
  if [[ "$COMPILER_NODE" == *.exe ]] && command -v wslpath >/dev/null 2>&1; then
    wslpath -m "$path_value"
  else
    printf '%s' "$path_value"
  fi
}

run_compiler() {
  local config_path="$1"
  timeout 60s "$COMPILER_NODE" "$(compiler_path_arg "$COMPILER_CLI")" "$(compiler_path_arg "$config_path")"
}

problem_entry_unit() {
  case "$1" in
    usaco-prob1)
      printf '%s' 'usaco~prob1@main'
      ;;
    usaco-prob2)
      printf '%s' 'usaco~prob2@main'
      ;;
    usaco-prob3)
      printf '%s' 'usaco~prob3@main'
      ;;
    *)
      return 1
      ;;
  esac
}

problem_source_file() {
  case "$1" in
    usaco-prob1)
      printf '%s' 'usaco~prob1@main.iw'
      ;;
    usaco-prob2)
      printf '%s' 'usaco~prob2@main.iw'
      ;;
    usaco-prob3)
      printf '%s' 'usaco~prob3@main.iw'
      ;;
    *)
      return 1
      ;;
  esac
}

create_run_config() {
  local problem_key="$1"
  local backend_pipeline="$2"
  local frontend_pipeline="$3"
  local config_dir="$TMP_DIR/$problem_key-$backend_pipeline"
  local entry_unit
  local source_file
  local source_dir

  entry_unit="$(problem_entry_unit "$problem_key")"
  source_file="$(problem_source_file "$problem_key")"
  source_dir="$(compiler_path_arg "$USACO_DIR/iw")"
  mkdir -p "$config_dir"
  cat > "$config_dir/build-iw.json" <<EOF
{
  "mode": "run",
  "directories": [
    {
      "path": "$source_dir",
      "files": [
        "usaco~shared@defs.iw",
        "$source_file"
      ]
    }
  ],
  "main": "$entry_unit",
  "precompiledLibs": [],
  "ffiLibs": [],
  "frontendPipeline": "$frontend_pipeline",
  "backendPipeline": "$backend_pipeline",
  "noBaseLib": false,
  "programArgs": []
}
EOF
  printf '%s' "$config_dir/build-iw.json"
}

normalize_tokens() {
  local file_path="$1"
  tr -s '[:space:]' '\n' < "$file_path" | sed '/^$/d'
}

compare_outputs() {
  local expected_file="$1"
  local actual_file="$2"
  local -a expected_tokens=()
  local -a actual_tokens=()
  mapfile -t expected_tokens < <(normalize_tokens "$expected_file")
  mapfile -t actual_tokens < <(normalize_tokens "$actual_file")

  if [[ ${#expected_tokens[@]} -ne ${#actual_tokens[@]} ]]; then
    echo "token-count mismatch: expected ${#expected_tokens[@]}, got ${#actual_tokens[@]}" >&2
    echo "expected: $(printf '%s ' "${expected_tokens[@]}")" >&2
    echo "actual:   $(printf '%s ' "${actual_tokens[@]}")" >&2
    return 1
  fi

  local index=0
  while [[ $index -lt ${#expected_tokens[@]} ]]; do
    if [[ ${expected_tokens[$index]} != ${actual_tokens[$index]} ]]; then
      echo "token mismatch at index $index: expected ${expected_tokens[$index]}, got ${actual_tokens[$index]}" >&2
      echo "expected: $(printf '%s ' "${expected_tokens[@]}")" >&2
      echo "actual:   $(printf '%s ' "${actual_tokens[@]}")" >&2
      return 1
    fi
    index=$((index + 1))
  done
}

compile_problem() {
  local problem_key="$1"
  local build_config="$2"
  local generated_c="$3"
  local generated_bin="$4"

  echo "[build] $problem_key"
  run_compiler "$build_config"
  timeout 30s cc -O2 "$generated_c" -lm -pthread -o "$generated_bin"
}

run_problem_backend_smoke() {
  local problem_key="$1"
  local cases_dir="$2"
  local backend_pipeline="$3"
  local frontend_pipeline="$4"
  local label="$5"
  local run_config
  local actual_file="$TMP_DIR/$problem_key-$backend_pipeline-smoke.actual"

  run_config="$(create_run_config "$problem_key" "$backend_pipeline" "$frontend_pipeline")"
  run_compiler "$run_config" < "$cases_dir/1.in" > "$actual_file"
  compare_outputs "$cases_dir/1.out" "$actual_file"
  echo "[smoke] $problem_key $label ok"
}

run_problem_cases() {
  local problem_key="$1"
  local cases_dir="$2"
  local generated_bin="$3"
  local total=0

  local input_file
  for input_file in "$cases_dir"/*.in; do
    local base_name
    base_name="$(basename "$input_file" .in)"
    local expected_file="$cases_dir/$base_name.out"
    local actual_file="$TMP_DIR/$problem_key-$base_name.actual"

    total=$((total + 1))
    timeout 30s "$generated_bin" < "$input_file" > "$actual_file"
    if ! compare_outputs "$expected_file" "$actual_file"; then
      echo "[fail] $problem_key case $base_name" >&2
      return 1
    fi
  done

  echo "[pass] $problem_key $total cases"
}

run_problem() {
  local problem_key="$1"
  local build_config="$USACO_DIR/build-json-cli/$problem_key/build-iw.json"
  local generated_c="$USACO_DIR/generated/$problem_key.c"
  local generated_bin="$USACO_DIR/generated/$problem_key.out"
  local cases_dir

  case "$problem_key" in
    usaco-prob1)
      cases_dir="$USACO_DIR/prob1_platinum_dec24"
      ;;
    usaco-prob2)
      cases_dir="$USACO_DIR/prob2_platinum_dec24"
      ;;
    usaco-prob3)
      cases_dir="$USACO_DIR/prob3_platinum_dec24"
      ;;
    *)
      echo "unknown problem key: $problem_key" >&2
      return 1
      ;;
  esac

  run_problem_backend_smoke "$problem_key" "$cases_dir" c optimize c-backend
  run_problem_backend_smoke "$problem_key" "$cases_dir" x64native nooptimize x64native
  compile_problem "$problem_key" "$build_config" "$generated_c" "$generated_bin"
  run_problem_cases "$problem_key" "$cases_dir" "$generated_bin"
}

main() {
  local -a targets=()
  if [[ $# -eq 0 ]]; then
    targets=(usaco-prob1 usaco-prob2 usaco-prob3)
  else
    targets=("$@")
  fi

  local target
  for target in "${targets[@]}"; do
    run_problem "$target"
  done
}

main "$@"