import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { buildDeclaredCFunctionName } from "../DeclaredCFunctionName";
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
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "ffi-c-heap-return");
const entryUnitId = "test~ffi~c~heap_return@main";
const rawMakeS3Symbol = buildDeclaredCFunctionName("2e5a592513cbf7c516add0ab3f485299", "iw_ffi_make_s3");
const rawMakeArrayS3Symbol = buildDeclaredCFunctionName("506e62be1de771259a772f31fa3d9e56", "iw_ffi_make_array_s3");
const rawMakeArrayI5Symbol = buildDeclaredCFunctionName("7c781994f516c9bfbb7d8643b86d00f2", "iw_ffi_make_array_i5");
const expectedStdout = "910";

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

const EXTRA_SUPPORT_SOURCE = `static inline void iw_ffi_host_assert(int condition, const char *context) {
    if (!condition) {
        fprintf(stderr, "Ironwall ffi host helper assertion failed in %s\\n", context);
        abort();
    }
}

iw_value_t ${rawMakeS3Symbol}(void) {
    iw_value_t value = make_iw_s3("hxllo");
    iw_ffi_host_assert(_iw_s3_length(value) == 5, "make_iw_s3 length");
    iw_ffi_host_assert(_iw_s3_length(_iw_s3_get(value, 1)) == 1, "_iw_s3_get length");
    _iw_s3_set(value, 1, make_iw_s3("e"));
    return value;
}

iw_value_t ${rawMakeArrayS3Symbol}(void) {
    iw_value_t value = make_iw_array_s3(3);
    iw_ffi_host_assert(_iw_array_s3_length(value) == 3, "make_iw_array_s3 length");
    _iw_array_s3_set(value, 0, make_iw_s3("red"));
    _iw_array_s3_set(value, 1, make_iw_s3("green"));
    _iw_array_s3_set(value, 2, make_iw_s3("blue"));
    iw_ffi_host_assert(_iw_s3_length(_iw_array_s3_get(value, 2)) == 4, "_iw_array_s3_get length");
    return value;
}

iw_value_t ${rawMakeArrayI5Symbol}(void) {
    iw_value_t value = make_iw_array_i5(4);
    iw_ffi_host_assert(_iw_array_i5_length(value) == 4, "make_iw_array_i5 length");
    _iw_array_i5_set(value, 0, 7);
    _iw_array_i5_set(value, 1, 11);
    _iw_array_i5_set(value, 2, 13);
    _iw_array_i5_set(value, 3, _iw_array_i5_get(value, 0) + 10);
    iw_ffi_host_assert(_iw_array_i5_get(value, 3) == 17, "_iw_array_i5_get value");
    return value;
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

function loadTypedProgramAst() {
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
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-ffi-c-heap-return-"));
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

        assertBinaryReturns(binaryPath, expectedOutput, "c-backend ffi heap return");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function buildX64StageC(testCase: X64Case): X64StageCResult {
    const ast = loadTypedProgramAst();
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
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-ffi-x64-heap-return-"));
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

        assertBinaryPrints(binaryPath, expectedOutput, "x64 ffi heap return");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

const cBackendAst = loadTypedProgramAst();
const cBackendStageC = performNoOptimizeCBackendLoweringStageCFromArtifacts(cBackendAst, {
    target: "windows-x64" as const,
    disableBaseLibAutoLoad: false,
    entryUnitId,
    requireEntryPoint: true
});
const generatedC = generateCFromFinalBackendIR(cBackendStageC.pass10, EXTRA_SUPPORT_SOURCE);

ok(generatedC.includes("static inline iw_value_t make_iw_s3(const char *data)"), "c-backend should emit s3 ffi host helper");
ok(generatedC.includes("static inline iw_value_t make_iw_array_s3(int64_t length)"), "c-backend should emit array s3 ffi host helper");
ok(generatedC.includes("static inline iw_value_t make_iw_array_i5(int64_t length)"), "c-backend should emit array i5 ffi host helper");
assertCBackendLinksAndRuns(generatedC, expectedStdout);
process.stdout.write("ffi-c-heap-return no-optimized-frontend c-backend ok\n");

for (const testCase of x64Cases) {
    const stageC = buildX64StageC(testCase);
    const asm = stageC.pass22x64emit.text;
    const supportC = generateX64NativeSupportCFromFinalBackendIR(
        stageC.pass10Support,
        EXTRA_SUPPORT_SOURCE,
        stageC.pass18x64layout.layouts.classes,
        asm
    );

    ok(supportC.includes("static inline iw_value_t make_iw_s3(const char *data)"), `${testCase.label} should emit s3 ffi host helper`);
    ok(supportC.includes("static inline iw_value_t make_iw_array_s3(int64_t length)"), `${testCase.label} should emit array s3 ffi host helper`);
    ok(supportC.includes("static inline iw_value_t make_iw_array_i5(int64_t length)"), `${testCase.label} should emit array i5 ffi host helper`);
    assertX64LinksAndRuns(supportC, asm, expectedStdout);
    process.stdout.write(`ffi-c-heap-return x64 ${testCase.label} ok\n`);
}
