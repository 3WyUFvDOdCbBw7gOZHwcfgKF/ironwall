#!/usr/bin/env bash
set -euo pipefail

release_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
examples_root="$release_root/examples"
build_root="$examples_root/build"
cli_path="$release_root/ironwall"
build_timeout_seconds=120
raytracer_simple_timeout_seconds=8
raytracer_simple_max_as_bytes=$((256 * 1024 * 1024))

normalize_output() {
    printf '%s\n' "$1" | sed 's/\r$//' | sed '/^[[:space:]]*$/d'
}

run_and_expect_status() {
    local label="$1"
    local expected_status="$2"
    shift 2
    set +e
    local output
    output="$($@ 2>&1)"
    local status=$?
    set -e
    if [[ $status -ne $expected_status ]]; then
        printf '%s status mismatch: expected %s, got %s\n%s\n' "$label" "$expected_status" "$status" "$output" >&2
        exit 1
    fi
    if [[ "$(normalize_output "$output")" != "" ]]; then
        printf '%s output mismatch\n%s\n' "$label" "$output" >&2
        exit 1
    fi
}

run_build() {
    local label="$1"
    local expected_token="$2"
    local config_path="$3"
    local output

    output="$(/usr/bin/timeout "${build_timeout_seconds}s" "$cli_path" "$config_path" 2>&1)"
    if [[ "$output" == *"ExperimentalWarning"* ]] || [[ "$output" == *"warning:"* ]]; then
        printf '%s emitted warnings\n%s\n' "$label" "$output" >&2
        exit 1
    fi
    if [[ "$output" != *"$expected_token"* ]]; then
        printf '%s build output mismatch\n%s\n' "$label" "$output" >&2
        exit 1
    fi
}

run_raytracer_simple_limited() {
        local output
        set +e
        output="$(cd "$examples_root" && /usr/bin/timeout "${raytracer_simple_timeout_seconds}s" /usr/bin/prlimit --as="$raytracer_simple_max_as_bytes" -- ./build/raytracer-simple.out build/raytracer-simple-validation.ppm 24 18 2>&1)"
        local status=$?
        set -e
        if [[ $status -ne 0 ]]; then
            printf 'raytracer-simple failed under limits: timeout=%ss max_as_bytes=%s status=%s\n%s\n' "$raytracer_simple_timeout_seconds" "$raytracer_simple_max_as_bytes" "$status" "$output" >&2
            exit 1
        fi
        if [[ "$(normalize_output "$output")" != "" ]]; then
            printf 'raytracer-simple output mismatch\n%s\n' "$output" >&2
            exit 1
        fi
}

if [[ "${1:-}" == "clean" || "${1:-}" == "--clean" ]]; then
    rm -rf "$build_root"
    printf 'clean ok\n'
    exit 0
fi

if [[ ! -x "$cli_path" ]]; then
    printf 'missing release standalone executable: %s\n' "$cli_path" >&2
    exit 1
fi

mkdir -p "$build_root"

run_build "hello-argv" "Built executable:" "$release_root/examples/hello-argv/build-iw.json"
run_and_expect_status "hello-argv" 123 "$build_root/hello-argv.out" a bb ccc
printf 'hello-argv ok\n'

run_build "module-global-state" "Built executable:" "$release_root/examples/module-global-state/build-iw.json"
run_and_expect_status "module-global-state" 100 "$build_root/module-global-state.out"
printf 'module-global-state ok\n'

bash "$release_root/examples/ffi-static-lib/native/build-native.sh"
run_build "ffi-static-lib" "Built executable:" "$release_root/examples/ffi-static-lib/build-iw.json"
run_and_expect_status "ffi-static-lib" 225 "$build_root/ffi-static-lib.out"
printf 'ffi-static-lib ok\n'

run_build "precompiled-lib" "Packed lib:" "$release_root/examples/precompiled-lib/lib/build-iw.json"
run_build "precompiled-app" "Built executable:" "$release_root/examples/precompiled-lib/app/build-iw.json"
run_and_expect_status "precompiled-app" 15 "$build_root/precompiled-app.out"
printf 'precompiled-lib ok\n'

run_build "fft-bigint" "Built executable:" "$release_root/examples/fft-bigint/build-iw.json"
fft_runtime="$($build_root/fft-bigint.out 2>&1)"
fft_expected=$'fft_0008_ok\nfft_0016_ok\nfft_0032_ok\nfft_0064_ok\nfft_f6_0064_ok\nfft_f7_0065_ok'
if [[ "$(normalize_output "$fft_runtime")" != "$fft_expected" ]]; then
    printf 'fft-bigint runtime mismatch\n%s\n' "$fft_runtime" >&2
    exit 1
fi
printf 'fft-bigint ok\n'

run_build "raytracer-simple" "Built executable:" "$release_root/examples/raytracer-simple/build-iw.json"
run_raytracer_simple_limited
if [[ ! -f "$build_root/raytracer-simple-validation.ppm" ]]; then
    printf 'raytracer-simple did not produce output image\n' >&2
    exit 1
fi
first_ppm_line="$(head -n 1 "$build_root/raytracer-simple-validation.ppm" | tr -d '\r')"
if [[ "$first_ppm_line" != "P3" ]]; then
    printf 'raytracer-simple ppm header mismatch: %s\n' "$first_ppm_line" >&2
    exit 1
fi
printf 'raytracer-simple ok\n'
