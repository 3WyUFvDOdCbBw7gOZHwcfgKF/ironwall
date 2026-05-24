import { execFileSync, spawnSync } from "child_process";
import { ok, strictEqual } from "assert";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import type { BackendPipelineName, BuildConfig } from "../BuildConfig";
import { buildDeclaredCFunctionName } from "../DeclaredCFunctionName";
import { assertExpectedExitCode } from "../Test/BuildJsonCliHarness";
import { execLinuxToolSync } from "./LinuxHostToolchainHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const seqFixtureDir = join(repoRoot, "src", "Test", "Fixtures", "seq-var-scope");
const precompiledFixtureRoot = join(repoRoot, "src", "Test", "Fixtures", "precompiled-lib");
const precompiledLibDir = join(precompiledFixtureRoot, "lib");
const precompiledAppDir = join(precompiledFixtureRoot, "app");

interface FfiSourceCase {
    readonly fileName: string;
    readonly source: string;
}

interface FfiStaticLibCase {
    readonly label: string;
    readonly unitId: string;
    readonly entrySource: string;
    readonly nativeSources: readonly FfiSourceCase[];
    readonly expectedOutput: string;
}

function writeBuildConfig(configDir: string, config: BuildConfig): string {
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "build-iw.json");
    writeFileSync(configPath, `${JSON.stringify({
        target: "windows-x64",
        ...config
    }, null, 2)}\n`, "utf8");
    return configPath;
}

function runConfig(configPath: string): string {
    return execFileSync(process.execPath, [cliPath, configPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
}

function runConfigResult(configPath: string): { readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string } {
    const result = spawnSync(process.execPath, [cliPath, configPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    return {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr
    };
}

function assertRunConfigResult(configPath: string, expectedExitCode: number, label: string): void {
    const result = runConfigResult(configPath);
    strictEqual(result.signal, null, `${label} signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertExpectedExitCode(result.status, expectedExitCode & 0xff, `${label} exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.stdout, "", `${label} should not print main return value\n${result.stdout}`);
    strictEqual(result.stderr, "", `${label} stderr mismatch\n${result.stderr}`);
}

function compileStaticArchive(archivePath: string, sourceDir: string, sources: readonly FfiSourceCase[]): void {
    const objectPaths = sources.map((source) => join(sourceDir, source.fileName.replace(/\.c$/, ".o")));
    sources.forEach((source, index) => {
        const cPath = join(sourceDir, source.fileName);
        const objectPath = objectPaths[index];
        writeFileSync(cPath, source.source, "utf8");
        execLinuxToolSync("cc", ["-O0", "-std=c11", "-c", cPath, "-o", objectPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
    });
    execLinuxToolSync("ar", ["rcs", archivePath, ...objectPaths], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
}

const tempDir = mkdtempSync(join(tmpdir(), "ironwall-build-json-cli-"));

try {
    const invalidConfigPath = join(tempDir, "bad-name", "not-build.json");
    mkdirSync(join(tempDir, "bad-name"), { recursive: true });
    writeFileSync(invalidConfigPath, "{}\n", "utf8");
    const invalidResult = spawnSync(process.execPath, [cliPath, invalidConfigPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    strictEqual(invalidResult.status, 1, `unexpected status for invalid config name\nstdout:\n${invalidResult.stdout}\nstderr:\n${invalidResult.stderr}`);
    ok(invalidResult.stderr.includes("only accepts a file named 'build-iw.json'"), `invalid config name should be rejected\nstdout:\n${invalidResult.stdout}\nstderr:\n${invalidResult.stderr}`);
    process.stdout.write("build-json-cli invalid-config-name ok\n");

    const cRunConfigDir = join(tempDir, "c-run");
    const cRunConfigPath = writeBuildConfig(cRunConfigDir, {
        mode: "run",
        directories: [{
            path: relative(cRunConfigDir, seqFixtureDir),
            files: ["test~seq~var~scope~seq@main.iw"]
        }],
        main: "test~seq~var~scope~seq@main",
        frontendPipeline: "optimize",
        backendPipeline: "c",
        precompiledLibs: [],
        ffiLibs: [],
        noBaseLib: false,
        programArgs: []
    });
    assertRunConfigResult(cRunConfigPath, 3847, "build-json-cli c-backend");
    process.stdout.write("build-json-cli c-backend ok\n");

    const archivePath = join(tempDir, "test-precompiled-lib.tgz");
    const packConfigDir = join(tempDir, "pack-lib");
    const packConfigPath = writeBuildConfig(packConfigDir, {
        mode: "pack-lib",
        directories: [{
            path: relative(packConfigDir, precompiledLibDir)
        }],
        output: relative(packConfigDir, archivePath),
        frontendPipeline: "nooptimize",
        backendPipeline: "x64native-nooptimize",
        precompiledLibs: [],
        ffiLibs: [],
        noBaseLib: false,
        programArgs: []
    });
    const packOutput = runConfig(packConfigPath);
    ok(packOutput.includes(`Packed lib: ${archivePath}`), `pack-lib output mismatch\n${packOutput}`);
    ok(statSync(archivePath).isFile(), `pack-lib should create ${archivePath}`);
    process.stdout.write("build-json-cli pack-lib ok\n");

    const x64Runs: readonly { label: string; backendPipeline: BackendPipelineName }[] = [
        {
            label: "x64native",
            backendPipeline: "x64native"
        },
        {
            label: "x64native-nooptimize",
            backendPipeline: "x64native-nooptimize"
        }
    ];

    for (const run of x64Runs) {
        const runConfigDir = join(tempDir, run.label);
        const runConfigPath = writeBuildConfig(runConfigDir, {
            mode: "run",
            directories: [{
                path: relative(runConfigDir, seqFixtureDir),
                files: ["test~seq~var~scope~seq@main.iw"]
            }],
            main: "test~seq~var~scope~seq@main",
            precompiledLibs: [],
            ffiLibs: [],
            frontendPipeline: "nooptimize",
            backendPipeline: run.backendPipeline,
            noBaseLib: false,
            programArgs: []
        });
        assertRunConfigResult(runConfigPath, 3847, run.label);
        process.stdout.write(`build-json-cli ${run.label} ok\n`);
    }

    const precompiledCheckConfigDir = join(tempDir, "precompiled-check");
    const precompiledCheckConfigPath = writeBuildConfig(precompiledCheckConfigDir, {
        mode: "check",
        directories: [{
            path: relative(precompiledCheckConfigDir, precompiledAppDir)
        }],
        precompiledLibs: [relative(precompiledCheckConfigDir, archivePath)],
        ffiLibs: [],
        frontendPipeline: "nooptimize",
        backendPipeline: "x64native",
        noBaseLib: false,
        programArgs: []
    });
    ok(runConfig(precompiledCheckConfigPath).includes("Typecheck OK: unit"), "precompiled lib check should typecheck through build-iw.json");
    process.stdout.write("build-json-cli precompiled-check ok\n");

    const ffiConfigRoot = join(tempDir, "ffi-static-lib");
    const ffiRuns: readonly { label: string; backendPipeline: BackendPipelineName }[] = [
        { label: "c", backendPipeline: "c" },
        { label: "x64native", backendPipeline: "x64native" },
        { label: "x64native-nooptimize", backendPipeline: "x64native-nooptimize" }
    ];

    const ffiCases: readonly FfiStaticLibCase[] = [
        {
            label: "unary-add",
            unitId: "test~build~json~ffi~unary@main",
            entrySource: (() => {
                const symbol = buildDeclaredCFunctionName("81af42c9d7354eb08bfe95163c04ad20", "iw_build_json_add_seven");
                return `{program test~build~json~ffi~unary@main
  (declare (function ${symbol} ([value i5]) to i5))
  (function main ([args <array s3>]) to i5 in (${symbol} $35^i5))
}
`;
            })(),
            nativeSources: [(() => {
                const symbol = buildDeclaredCFunctionName("81af42c9d7354eb08bfe95163c04ad20", "iw_build_json_add_seven");
                return {
                    fileName: "ffi_add.c",
                    source: `#include <stdint.h>
typedef intptr_t iw_value_t;
static inline int64_t iw_as_i64(iw_value_t value) { return ((int64_t)value) >> 1; }
static inline iw_value_t iw_from_i64(int64_t value) { return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL); }
iw_value_t ${symbol}(iw_value_t value) {
    return iw_from_i64(iw_as_i64(value) + 7);
}
`
                };
            })()],
            expectedOutput: "42"
        },
        {
            label: "seed-and-mix",
            unitId: "test~build~json~ffi~seed_mix@main",
            entrySource: (() => {
                const seedSymbol = buildDeclaredCFunctionName("12f1e8bb90ca40d1a25d6457ce1b2e20", "iw_build_json_seed");
                const mixSymbol = buildDeclaredCFunctionName("b7c8d11df8d2442a8f83e9831a69b8f4", "iw_build_json_mix3");
                return `{program test~build~json~ffi~seed_mix@main
  (declare (function ${seedSymbol} () to i5))
  (declare (function ${mixSymbol} ([left i5] [right i5] [extra i5]) to i5))
  (function main ([args <array s3>]) to i5 in (${mixSymbol} (${seedSymbol}) $10^i5 $11^i5))
}
`;
            })(),
            nativeSources: [(() => {
                const seedSymbol = buildDeclaredCFunctionName("12f1e8bb90ca40d1a25d6457ce1b2e20", "iw_build_json_seed");
                const mixSymbol = buildDeclaredCFunctionName("b7c8d11df8d2442a8f83e9831a69b8f4", "iw_build_json_mix3");
                return {
                    fileName: "ffi_seed_mix.c",
                    source: `#include <stdint.h>
typedef intptr_t iw_value_t;
static inline int64_t iw_as_i64(iw_value_t value) { return ((int64_t)value) >> 1; }
static inline iw_value_t iw_from_i64(int64_t value) { return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL); }
iw_value_t ${seedSymbol}(void) {
    return iw_from_i64(5);
}
iw_value_t ${mixSymbol}(iw_value_t left, iw_value_t right, iw_value_t extra) {
    return iw_from_i64((iw_as_i64(left) * iw_as_i64(right)) + iw_as_i64(extra));
}
`
                };
            })()],
            expectedOutput: "61"
        },
        {
            label: "multi-file-negate-sum",
            unitId: "test~build~json~ffi~multi_file@main",
            entrySource: (() => {
                const sum4Symbol = buildDeclaredCFunctionName("ab6f7ef4c1de43fb8d5cf17ae7e36c50", "iw_build_json_sum4");
                const negSymbol = buildDeclaredCFunctionName("efa5590b9e1b497b9088681cc92f15a2", "iw_build_json_negate");
                return `{program test~build~json~ffi~multi_file@main
  (declare (function ${sum4Symbol} ([a i5] [b i5] [c i5] [d i5]) to i5))
  (declare (function ${negSymbol} ([value i5]) to i5))
  (function main ([args <array s3>]) to i5 in (${negSymbol} (${sum4Symbol} $4^i5 $9^i5 $12^i5 $6^i5)))
}
`;
            })(),
            nativeSources: [
                (() => {
                    const sum4Symbol = buildDeclaredCFunctionName("ab6f7ef4c1de43fb8d5cf17ae7e36c50", "iw_build_json_sum4");
                    return {
                        fileName: "ffi_sum4.c",
                        source: `#include <stdint.h>
typedef intptr_t iw_value_t;
static inline int64_t iw_as_i64(iw_value_t value) { return ((int64_t)value) >> 1; }
static inline iw_value_t iw_from_i64(int64_t value) { return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL); }
iw_value_t ${sum4Symbol}(iw_value_t a, iw_value_t b, iw_value_t c, iw_value_t d) {
    return iw_from_i64(iw_as_i64(a) + iw_as_i64(b) + iw_as_i64(c) + iw_as_i64(d));
}
`
                    };
                })(),
                (() => {
                    const negSymbol = buildDeclaredCFunctionName("efa5590b9e1b497b9088681cc92f15a2", "iw_build_json_negate");
                    return {
                        fileName: "ffi_negate.c",
                        source: `#include <stdint.h>
typedef intptr_t iw_value_t;
static inline int64_t iw_as_i64(iw_value_t value) { return ((int64_t)value) >> 1; }
static inline iw_value_t iw_from_i64(int64_t value) { return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL); }
iw_value_t ${negSymbol}(iw_value_t value) {
    return iw_from_i64(-iw_as_i64(value));
}
`
                    };
                })()
            ],
            expectedOutput: "-31"
        }
    ];

    for (const ffiCase of ffiCases) {
        const ffiCaseRoot = join(ffiConfigRoot, ffiCase.label);
        const ffiSourceDir = join(ffiCaseRoot, "src");
        const ffiBuildDir = join(ffiCaseRoot, "native");
        mkdirSync(ffiSourceDir, { recursive: true });
        mkdirSync(ffiBuildDir, { recursive: true });
        writeFileSync(join(ffiSourceDir, `${ffiCase.unitId}.iw`), ffiCase.entrySource, "utf8");
        const ffiArchivePath = join(ffiBuildDir, `lib${ffiCase.label}.a`);
        compileStaticArchive(ffiArchivePath, ffiBuildDir, ffiCase.nativeSources);

        for (const run of ffiRuns) {
            const ffiConfigDir = join(ffiCaseRoot, run.label);
            const ffiConfigPath = writeBuildConfig(ffiConfigDir, {
                mode: "run",
                directories: [{
                    path: relative(ffiConfigDir, ffiSourceDir)
                }],
                main: ffiCase.unitId,
                precompiledLibs: [],
                ffiLibs: [relative(ffiConfigDir, ffiArchivePath)],
                frontendPipeline: "optimize",
                backendPipeline: run.backendPipeline,
                noBaseLib: false,
                programArgs: []
            });
            assertRunConfigResult(ffiConfigPath, Number(ffiCase.expectedOutput), `build-json-cli ffi static lib ${ffiCase.label} ${run.label}`);
            process.stdout.write(`build-json-cli ffi static lib ${ffiCase.label} ${run.label} ok\n`);
        }
    }
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}
