import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { buildDeclaredCFunctionName, buildExportedIwFunctionName } from "../DeclaredCFunctionName";
import { performNoOptimizeCBackendLoweringStageCFromArtifacts, performNoOptimizeLoweringStageCFromArtifacts, performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { performLoweringStageCFromArtifacts, performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateCFromFinalBackendIR, generateX64NativeSupportCFromFinalBackendIR } from "../backend-windows/Backend-Windows-C";
import type { FinalBackendIRProgram, X64LaidOutProgram, X64TextualAssemblyProgram } from "../backend-windows/Backend-Windows-IR-Shared";
import { assertExpectedExitCode } from "../Test/BuildJsonCliHarness";
import { execLinuxToolSync, spawnLinuxBinarySync } from "./LinuxHostToolchainHarness";

interface X64Case {
    readonly label: string;
    readonly frontendProfile: "optimized" | "no-optimized";
    readonly backendProfile: "optimized-x64-backend" | "no-optimized-backend";
}

interface X64StageCResult {
    readonly pass10Support: FinalBackendIRProgram;
    readonly pass18x64layout: X64LaidOutProgram;
    readonly pass22x64emit: X64TextualAssemblyProgram;
}

const repoRoot = resolve(__dirname, "..", "..");
const entryUnitId = "test~ffi~iw_export@main";
const rawHostScaleSymbol = buildDeclaredCFunctionName("4a8b9c0d1e2f34567890abcdef123456", "iw_host_scale_i5");
const rawHostWrapTextSymbol = buildDeclaredCFunctionName("0c95086a0a5442d98c4c6ee3e476a85d", "iw_host_wrap_s3");
const rawHostValidateSymbol = buildDeclaredCFunctionName("210f5dbd46a3446a8b15e0f06e9d7b40", "iw_host_validate_exports");
const rawExportI5Symbol = buildExportedIwFunctionName("2c6c6793c93d4a21ae02c4ebc61838e1", "iw_export_i5_roundtrip");
const rawExportS3Symbol = buildExportedIwFunctionName("9b257fd3654c46df9811d56581c188f6", "iw_export_s3_roundtrip");
const rawExportArrayI5Symbol = buildExportedIwFunctionName("05c41829801949bba168d25585c7e0bf", "iw_export_array_i5_roundtrip");
const rawExportArrayS3Symbol = buildExportedIwFunctionName("1905a92ae238496490f0a3513d821d33", "iw_export_array_s3_roundtrip");
const expectedStdout = "944";

const X64_NATIVE_DRIVER_SOURCE = `#include <stdint.h>
#include <stdio.h>
typedef intptr_t iw_value_t;
extern void __iw_x64_init_runtime(void);
extern iw_value_t __iw_host_entry_main(int argc, char **argv);
static inline long long iw_as_i64(iw_value_t value) { return ((long long)value) >> 1; }
int main(int argc, char **argv) {
    __iw_x64_init_runtime();
    iw_value_t result = __iw_host_entry_main(argc, argv);
    printf("%lld\\n", iw_as_i64(result));
    return 0;
}
`;

const EXTRA_SUPPORT_SOURCE = `static inline void iw_export_assert(int condition, const char *context) {
    if (!condition) {
        fprintf(stderr, "Ironwall exported IW ffi assertion failed in %s\\n", context);
        abort();
    }
}

iw_value_t ${rawHostScaleSymbol}(iw_value_t raw_value) {
    int32_t value = (int32_t)iw_as_i64(raw_value);
    uint32_t doubled = ((uint32_t)value) * 2u;
    return iw_from_i64((int64_t)(int32_t)doubled);
}

iw_value_t ${rawHostWrapTextSymbol}(iw_value_t raw_value) {
    iw_text_value_t *value = iw_text_expect(raw_value, "iw_host_wrap_s3");
    size_t length = (size_t)value->length;
    char *buffer = (char*)malloc(length + 3u);
    iw_export_assert(buffer != NULL, "iw_host_wrap_s3 malloc");
    buffer[0] = '[';
    if (length > 0u) {
        memcpy(buffer + 1u, value->data, length);
    }
    buffer[length + 1u] = ']';
    buffer[length + 2u] = '\\0';
    iw_value_t result = make_iw_s3(buffer);
    free(buffer);
    return result;
}

iw_value_t ${rawHostValidateSymbol}(void) {
    int32_t input_numbers_storage[3] = { 1, 2, 3 };
    iw_host_array_i5_t input_numbers = { 3, input_numbers_storage };
    iw_host_array_i5_t output_numbers = ${rawExportArrayI5Symbol}(input_numbers);
    char *single_text = ${rawExportS3Symbol}("ok");
    char *input_words_storage[2] = { "red", "blue" };
    iw_host_array_s3_t input_words = { 2, input_words_storage };
    iw_host_array_s3_t output_words = ${rawExportArrayS3Symbol}(input_words);

    iw_export_assert(${rawExportI5Symbol}(7) == 15, "iw_export_i5_roundtrip result");
    iw_export_assert(${rawExportI5Symbol}(INT32_MAX) == -1, "iw_export_i5_roundtrip should use int32_t semantics");
    iw_export_assert(strcmp(single_text, "[ok]") == 0, "iw_export_s3_roundtrip result");
    iw_export_assert(output_numbers.length == 3, "iw_export_array_i5_roundtrip length");
    iw_export_assert(output_numbers.items != NULL, "iw_export_array_i5_roundtrip items");
    iw_export_assert(output_numbers.items[0] == 2, "iw_export_array_i5_roundtrip item0");
    iw_export_assert(output_numbers.items[1] == 4, "iw_export_array_i5_roundtrip item1");
    iw_export_assert(output_numbers.items[2] == 6, "iw_export_array_i5_roundtrip item2");
    iw_export_assert(output_words.length == 2, "iw_export_array_s3_roundtrip length");
    iw_export_assert(output_words.items != NULL, "iw_export_array_s3_roundtrip items");
    iw_export_assert(strcmp(output_words.items[0], "[red]") == 0, "iw_export_array_s3_roundtrip item0");
    iw_export_assert(strcmp(output_words.items[1], "[blue]") == 0, "iw_export_array_s3_roundtrip item1");

    iw_host_free_s3(single_text);
    iw_host_free_array_i5(output_numbers);
    iw_host_free_array_s3(output_words);
    return iw_from_i64(944);
}
`;

const x64Cases: readonly X64Case[] = [
    {
        label: "optimized-frontend optimized-backend",
        frontendProfile: "optimized",
        backendProfile: "optimized-x64-backend"
    },
    {
        label: "optimized-frontend no-optimized-backend",
        frontendProfile: "optimized",
        backendProfile: "no-optimized-backend"
    },
    {
        label: "no-optimized-frontend optimized-backend",
        frontendProfile: "no-optimized",
        backendProfile: "optimized-x64-backend"
    },
    {
        label: "no-optimized-frontend no-optimized-backend",
        frontendProfile: "no-optimized",
        backendProfile: "no-optimized-backend"
    }
];

function loadTypedProgramAst(fixtureDir: string) {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots("windows-x64")
    });
    performTypeChecking(ast, {
        disableBaseLibAutoLoad: false
    });
    return ast;
}

function assertBinaryReturns(binaryPath: string, expectedOutput: string, label: string): void {
    const result = spawnLinuxBinarySync(binaryPath, [], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });
    strictEqual(result.signal, null, `${label} signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertExpectedExitCode(result.status, Number(expectedOutput) & 0xff, `${label} exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.stdout, "", `${label} should not print main return value\n${result.stdout}`);
    strictEqual(result.stderr, "", `${label} stderr mismatch\n${result.stderr}`);
}

function assertBinaryPrints(binaryPath: string, expectedOutput: string, label: string): void {
    const result = spawnLinuxBinarySync(binaryPath, [], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });
    strictEqual(result.signal, null, `${label} signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.status, 0, `${label} exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.stdout.trim(), expectedOutput, `${label} stdout mismatch\n${result.stdout}`);
    strictEqual(result.stderr, "", `${label} stderr mismatch\n${result.stderr}`);
}

function assertCBackendLinksAndRuns(generatedC: string, expectedOutput: string): void {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-ffi-iw-export-c-"));
    try {
        const programPath = join(tempDir, "program.c");
        const binaryPath = join(tempDir, "program.out");

        writeFileSync(programPath, generatedC, "utf8");
        execLinuxToolSync("cc", ["-O0", "-std=c11", "-pthread", programPath, "-lm", "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });

        assertBinaryReturns(binaryPath, expectedOutput, "c-backend exported IW ffi");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function buildX64StageC(fixtureDir: string, testCase: X64Case): X64StageCResult {
    const ast = loadTypedProgramAst(fixtureDir);
    const loweringOptions = {
        target: "windows-x64" as const,
        disableBaseLibAutoLoad: false,
        entryUnitId,
        requireEntryPoint: true
    };

    if (testCase.frontendProfile === "optimized") {
        return testCase.backendProfile === "no-optimized-backend"
            ? performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts(ast, loweringOptions)
            : performLoweringStageCFromArtifacts(ast, loweringOptions);
    }

    return testCase.backendProfile === "no-optimized-backend"
        ? performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts(ast, loweringOptions)
        : performNoOptimizeLoweringStageCFromArtifacts(ast, loweringOptions);
}

function assertX64LinksAndRuns(supportC: string, assemblyText: string, expectedOutput: string): void {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-ffi-iw-export-x64-"));
    try {
        const supportPath = join(tempDir, "program.support.c");
        const driverPath = join(tempDir, "program.driver.c");
        const asmPath = join(tempDir, "program.s");
        const binaryPath = join(tempDir, "program.out");

        writeFileSync(supportPath, supportC, "utf8");
        writeFileSync(driverPath, X64_NATIVE_DRIVER_SOURCE, "utf8");
        writeFileSync(asmPath, assemblyText, "utf8");

        execLinuxToolSync("cc", ["-O0", "-std=c11", "-pthread", "-no-pie", supportPath, driverPath, asmPath, "-lm", "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });

        assertBinaryPrints(binaryPath, expectedOutput, "x64 exported IW ffi");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "ffi-iw-export");

    const cBackendAst = loadTypedProgramAst(fixtureDir);
    const cBackendStageC = performNoOptimizeCBackendLoweringStageCFromArtifacts(cBackendAst, {
        target: "windows-x64" as const,
        disableBaseLibAutoLoad: false,
        entryUnitId,
        requireEntryPoint: true
    });
    const generatedC = generateCFromFinalBackendIR(cBackendStageC.pass10, EXTRA_SUPPORT_SOURCE);

    ok(generatedC.includes(`int32_t IW_HOST_ABI ${rawExportI5Symbol}(int32_t iw_export_param_0)`), "c-backend should emit exported i5 wrapper");
    ok(generatedC.includes(`char * IW_HOST_ABI ${rawExportS3Symbol}(const char * iw_export_param_0)`), "c-backend should emit exported s3 wrapper");
    ok(generatedC.includes("typedef struct iw_host_array_i5_t { int64_t length; int32_t *items; } iw_host_array_i5_t;"), "c-backend should emit host array i5 ABI struct");
    ok(generatedC.includes("typedef struct iw_host_array_s3_t { int64_t length; char **items; } iw_host_array_s3_t;"), "c-backend should emit host array s3 ABI struct");
    assertCBackendLinksAndRuns(generatedC, expectedStdout);
    process.stdout.write("ffi-iw-export no-optimized-frontend c-backend ok\n");

    for (const testCase of x64Cases) {
        const stageC = buildX64StageC(fixtureDir, testCase);
        const asm = stageC.pass22x64emit.text;
        const supportC = generateX64NativeSupportCFromFinalBackendIR(
            stageC.pass10Support,
            EXTRA_SUPPORT_SOURCE,
            stageC.pass18x64layout.layouts.classes,
            asm
        );

        ok(supportC.includes(`int32_t IW_HOST_ABI ${rawExportI5Symbol}(int32_t iw_export_param_0)`), `${testCase.label} should emit exported i5 wrapper`);
        ok(supportC.includes(`char * IW_HOST_ABI ${rawExportS3Symbol}(const char * iw_export_param_0)`), `${testCase.label} should emit exported s3 wrapper`);
        ok(supportC.includes("typedef struct iw_host_array_i5_t { int64_t length; int32_t *items; } iw_host_array_i5_t;"), `${testCase.label} should emit host array i5 ABI struct`);
        ok(supportC.includes("typedef struct iw_host_array_s3_t { int64_t length; char **items; } iw_host_array_s3_t;"), `${testCase.label} should emit host array s3 ABI struct`);
        assertX64LinksAndRuns(supportC, asm, expectedStdout);
        process.stdout.write(`ffi-iw-export x64 ${testCase.label} ok\n`);
    }
