# Ironwall Release Compiler Manual (Windows x64)

This manual is for the Windows x64 Ironwall release package. Unless stated otherwise, run the commands below from the release package root.

You should see at least these entries in the package root:

- `ironwall.exe`
- `iw-compiler-manual-windows-x64.md`
- `validate-examples.ps1`
- `std-windows/`
- `examples/`
- `iw-spec/`
- `cheader/`

## 1. Quick Checks

Show the release compiler version:

```powershell
.\ironwall.exe --version
```

Run the official example validation suite:

```powershell
powershell -ExecutionPolicy Bypass -File .\validate-examples.ps1
```

The validation script writes build products under the package-level `build\` directory, so it will not leave `.exe`, `.lib`, `.obj`, `.tgz`, or similar build products in your `examples\` directories. Run `powershell -ExecutionPolicy Bypass -File .\validate-examples.ps1 -Clean` to remove the validation build directory.

## 2. `build-iw.json`

The release compiler accepts only these seven top-level fields in `build-iw.json`:

- `mode`
- `target`
- `directories`
- `main`
- `output`
- `precompiledLibs`
- `ffiLibs`

Development-only fields are rejected by the release compiler.

### `target`

- Optional.
- If omitted, this Windows release package defaults to `windows-x64`.
- If present, it must be `windows-x64`.

### `mode`

- `build`: compile a native executable.
- `pack-lib`: package a set of IW units as a precompiled library `.tgz`.

### `directories`

Each entry has this shape:

```json
{
  "path": "src",
  "files": ["foo.iw", "subdir/bar.iw"]
}
```

- `path` must be a directory.
- `files` is optional. If omitted, the compiler recursively collects `.iw` files and package database `.json` files under `path`.
- All paths are resolved relative to the location of the current `build-iw.json` file.

### `main`

- Required only when `mode` is `build`.
- This is an entry unit id, not a file path.

### `output`

- Required for both modes.
- In `build` mode, it names the native executable output path.
- In `pack-lib` mode, it names the `.tgz` archive output path.

### `precompiledLibs`

- A list of `.tgz` precompiled library archives.
- If the current project depends on public definitions from those archives, it can import their packages directly.

### `ffiLibs`

- A list of static libraries, usually `.lib`.
- Used only in `build` mode during final linking.

## 3. Minimal Executable Example

```powershell
.\ironwall.exe examples\hello-argv\build-iw.json
.\build\hello-argv.exe a bb ccc
```

Expected output:

```text
123
```

## 4. Multi-File IW Program

```powershell
.\ironwall.exe examples\module-global-state\build-iw.json
.\build\module-global-state.exe
```

Expected output:

```text
100
```

## 5. Calling a C Static Library from IW

The release package includes a minimal offline C static library example under `examples\ffi-static-lib\`.

First build the static library:

```powershell
powershell -ExecutionPolicy Bypass -File .\examples\ffi-static-lib\native\build-native.ps1
```

Then compile and run the IW program:

```powershell
.\ironwall.exe examples\ffi-static-lib\build-iw.json
.\build\ffi-static-lib.exe
```

Expected output:

```text
-31
```

The common workflow is:

1. Declare the external C symbol in IW with `declare (function ...)`.
2. Implement that symbol in C.
3. Compile the `.c` files into a static library `.lib`.
4. Add that `.lib` file to `ffiLibs` in `build-iw.json`.

The C files in `examples\ffi-static-lib\native\*.c` use `iw_value_t`, `iw_as_i64`, and `iw_from_i64` from `cheader\iw_value_abi.h`. For external C libraries called by IW, that header is the most stable release ABI starting point.

## 6. Current C FFI Data Boundary

For the current release package, use this boundary when designing C FFI:

- For "external C static library called by IW", the most stable documented boundary is `iw_value_t` in `cheader\iw_value_abi.h`, especially tagged integer helpers such as `iw_as_i64` and `iw_from_i64`.
- For "host C calls Ironwall exported wrappers", `cheader\iw_export_abi.h` currently provides `iw_host_array_i5_t`, `iw_host_array_s3_t`, `iw_host_free_s3`, `iw_host_free_array_i5`, and `iw_host_free_array_s3`. These cover the documented host-side transfer types `s3`, `<array i5>`, and `<array s3>`.
- For long-term stable external ABI work, keep interfaces within these documented boundaries.
- Do not treat Ironwall heap objects, arbitrary objects/classes/records/closures, or their memory layout as a stable external ABI.

## 7. Packaging and Using a Precompiled Library

First package the library:

```powershell
.\ironwall.exe examples\precompiled-lib\lib\build-iw.json
```

Then compile the app:

```powershell
.\ironwall.exe examples\precompiled-lib\app\build-iw.json
.\build\precompiled-app.exe
```

Expected output:

```text
15
```

## 8. Environment and Platform Scope

This release package targets Windows x64.

- The `ironwall.exe` executable in this package targets a Win64 user-space environment.
- Non-Windows or non-x64 environments are outside the official target scope for this package.
- Generated executables are linked with your local Windows toolchain, so linker/runtime constraints follow your local build environment.

Common prerequisites:

- `powershell`: used by `validate-examples.ps1` and `examples\ffi-static-lib\native\build-native.ps1`.
- `clang-cl`: default C compiler for the bundled FFI static-library example. Override with `$env:CC` if needed.
- `lib`: default librarian for the bundled FFI static-library example. Override with `$env:AR` if needed.
- `tar`: required for `pack-lib` output and for reading `precompiledLibs`.

## 9. Directory Overview

- `iw-compiler-manual-windows-x64.md`: this manual.
- `validate-examples.ps1`: one-command validation for the official examples.
- `examples/README.md`: quick manual commands for the examples.
- `iw-spec/ironwall-spec.md`: single-file Traditional Chinese language specification covering the language, C FFI, base library, runtime, and thesis.
- `iw-spec/zh-TC/`, `iw-spec/zh-SC/`, `iw-spec/en/`: split spec directories by language. Each directory also contains a merged `ironwall-spec.md`.
- `html/zh-TC/`, `html/zh-SC/`, `html/en/`: `ironwall-spec.html` for each language. The version comes from `version.json`.
- `version.json`: release version declaration. Its checksum is `sha256(version + uuid)` in hexadecimal.
- `cheader/iw_value_abi.h`: minimal ABI header for external C static libraries.
- `cheader/iw_export_abi.h`: host-side structures and release helpers for exported IW wrappers.