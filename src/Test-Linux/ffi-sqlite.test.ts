import { execFileSync, spawnSync } from "child_process";
import { ok, strictEqual } from "assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { buildDeclaredCFunctionName } from "../DeclaredCFunctionName";
import { performNoOptimizeCBackendLoweringStageCFromArtifacts, performNoOptimizeLoweringStageCFromArtifacts, performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { performLoweringStageCFromArtifacts, performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateCFromFinalBackendIR, generateX64NativeSupportCFromFinalBackendIR } from "../backend-linux/Backend-Linux-C";
import type { FinalBackendIRProgram, X64LaidOutProgram, X64TextualAssemblyProgram } from "../backend-linux/Backend-Linux-IR-Shared";

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
const fixtureBase = "test~ffi~sqlite";
const entryUnitId = `${fixtureBase}@main`;
const rawOpenMemorySymbol = buildDeclaredCFunctionName("8c1e4f6a2b3d5e7091a2b3c4d5e6f708", "iw_sqlite_open_memory");
const rawCloseSymbol = buildDeclaredCFunctionName("98a5e6af761a4f08b60da8a9d6e1f24b", "iw_sqlite_close");
const rawExecSymbol = buildDeclaredCFunctionName("f1620959820545f7a58df989768880bc", "iw_sqlite_exec");
const rawQueryRowsS3Symbol = buildDeclaredCFunctionName("ef73e96c2ec44781b66f365d9e792e14", "iw_sqlite_query_rows_s3");
const rawQueryRowsI5Symbol = buildDeclaredCFunctionName("55de8f5cf60c41ea8d86b480f9f0d97c", "iw_sqlite_query_rows_i5");
const expectedStdout = "1048575";
const sqliteExampleDir = join(repoRoot, "src", "examples", "ffi-sqlite-linux");
const programTemplatePath = join(sqliteExampleDir, `${entryUnitId}.iw.in`);
const litDataPath = join(sqliteExampleDir, `${fixtureBase}$lit.json`);
const extraSupportTemplatePath = join(sqliteExampleDir, "ffi-sqlite-support.c.in");

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

function hydrateTemplate(templateText: string): string {
    return templateText
        .split("{{RAW_OPEN_MEMORY_SYMBOL}}").join(rawOpenMemorySymbol)
        .split("{{RAW_CLOSE_SYMBOL}}").join(rawCloseSymbol)
        .split("{{RAW_EXEC_SYMBOL}}").join(rawExecSymbol)
        .split("{{RAW_QUERY_ROWS_S3_SYMBOL}}").join(rawQueryRowsS3Symbol)
        .split("{{RAW_QUERY_ROWS_I5_SYMBOL}}").join(rawQueryRowsI5Symbol);
}

const EXTRA_SUPPORT_SOURCE = hydrateTemplate(readFileSync(extraSupportTemplatePath, "utf8"));

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

function createFixtureDir(): string {
    const fixtureDir = mkdtempSync(join(tmpdir(), "ironwall-ffi-sqlite-fixture-"));
  writeFileSync(join(fixtureDir, `${entryUnitId}.iw`), hydrateTemplate(readFileSync(programTemplatePath, "utf8")), "utf8");
  writeFileSync(join(fixtureDir, `${fixtureBase}$lit.json`), readFileSync(litDataPath, "utf8"), "utf8");
    return fixtureDir;
}

function loadTypedProgramAst(fixtureDir: string) {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots()
    });
    performTypeChecking(ast, {
        disableBaseLibAutoLoad: false
    });
    return ast;
}

function assertBinaryReturns(binaryPath: string, expectedOutput: string, label: string): void {
    const result = spawnSync(binaryPath, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    strictEqual(result.signal, null, `${label} signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.status, Number(expectedOutput) & 0xff, `${label} exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.stdout, "", `${label} should not print main return value\n${result.stdout}`);
    strictEqual(result.stderr, "", `${label} stderr mismatch\n${result.stderr}`);
}

function assertBinaryPrints(binaryPath: string, expectedOutput: string, label: string): void {
    const result = spawnSync(binaryPath, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    strictEqual(result.signal, null, `${label} signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.status, 0, `${label} exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.stdout.trim(), expectedOutput, `${label} stdout mismatch\n${result.stdout}`);
    strictEqual(result.stderr, "", `${label} stderr mismatch\n${result.stderr}`);
}

function assertCBackendLinksAndRuns(generatedC: string, expectedOutput: string): void {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-ffi-sqlite-c-"));
    try {
        const programPath = join(tempDir, "program.c");
        const binaryPath = join(tempDir, "program.out");

        writeFileSync(programPath, generatedC, "utf8");
        execFileSync("cc", ["-O0", "-std=c11", "-pthread", programPath, "-lm", "-lsqlite3", "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });

        assertBinaryReturns(binaryPath, expectedOutput, "c-backend sqlite ffi");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function buildX64StageC(fixtureDir: string, testCase: X64Case): X64StageCResult {
    const ast = loadTypedProgramAst(fixtureDir);
    const loweringOptions = {
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
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-ffi-sqlite-x64-"));
    try {
        const supportPath = join(tempDir, "program.support.c");
        const driverPath = join(tempDir, "program.driver.c");
        const asmPath = join(tempDir, "program.s");
        const binaryPath = join(tempDir, "program.out");

        writeFileSync(supportPath, supportC, "utf8");
        writeFileSync(driverPath, X64_NATIVE_DRIVER_SOURCE, "utf8");
        writeFileSync(asmPath, assemblyText, "utf8");

        execFileSync("cc", ["-O0", "-std=c11", "-pthread", "-no-pie", supportPath, driverPath, asmPath, "-lm", "-lsqlite3", "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });

        assertBinaryPrints(binaryPath, expectedOutput, "x64 sqlite ffi");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

const fixtureDir = createFixtureDir();

try {
    const cBackendAst = loadTypedProgramAst(fixtureDir);
    const cBackendStageC = performNoOptimizeCBackendLoweringStageCFromArtifacts(cBackendAst, {
        disableBaseLibAutoLoad: false,
        entryUnitId,
        requireEntryPoint: true
    });
    const generatedC = generateCFromFinalBackendIR(cBackendStageC.pass10, EXTRA_SUPPORT_SOURCE);

    ok(generatedC.includes(rawExecSymbol), "c-backend should declare the sqlite exec wrapper");
    ok(generatedC.includes(rawQueryRowsS3Symbol), "c-backend should declare the sqlite row query wrapper");
    assertCBackendLinksAndRuns(generatedC, expectedStdout);
    process.stdout.write("ffi-sqlite no-optimized-frontend c-backend ok\n");

    for (const testCase of x64Cases) {
        const stageC = buildX64StageC(fixtureDir, testCase);
        const asm = stageC.pass22x64emit.text;
        const supportC = generateX64NativeSupportCFromFinalBackendIR(
            stageC.pass10Support,
            EXTRA_SUPPORT_SOURCE,
            stageC.pass18x64layout.layouts.classes,
            asm
        );

        ok(supportC.includes(rawExecSymbol), `${testCase.label} should declare the sqlite exec wrapper`);
        ok(supportC.includes(rawQueryRowsS3Symbol), `${testCase.label} should declare the sqlite row query wrapper`);
        assertX64LinksAndRuns(supportC, asm, expectedStdout);
        process.stdout.write(`ffi-sqlite x64 ${testCase.label} ok\n`);
    }
} finally {
    rmSync(fixtureDir, { recursive: true, force: true });
}
