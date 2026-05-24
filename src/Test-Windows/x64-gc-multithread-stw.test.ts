import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { performNoOptimizeLoweringStageCFromArtifacts, performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateX64NativeSupportCFromFinalBackendIR } from "../backend-windows/Backend-Windows-C";
import type { FinalBackendIRProgram, X64LaidOutProgram, X64TextualAssemblyProgram } from "../backend-windows/Backend-Windows-IR-Shared";
import { execLinuxBinarySync, execLinuxToolSync } from "./LinuxHostToolchainHarness";

interface X64Case {
    readonly label: string;
    readonly backendProfile: "optimized-x64-backend" | "no-optimized-backend";
}

interface X64StageCResult {
    readonly pass10Support: FinalBackendIRProgram;
    readonly pass18x64layout: X64LaidOutProgram;
    readonly pass22x64emit: X64TextualAssemblyProgram;
}

const TEST_TIMEOUT_MS = 120000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const entryUnitId = "test~gc~multithread~stw@main";
const threadCount = 4;
const iterations = 8;
const expectedLoggedThreadCount = threadCount - 1;
const expectedResult = Array.from({ length: threadCount }, (_, index) => expectedWorkerResult(index + 1, iterations)).reduce((sum, value) => sum + value, 0);

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

const x64Cases: readonly X64Case[] = [
    {
        label: "no-optimized-frontend optimized-backend",
        backendProfile: "optimized-x64-backend"
    },
    {
        label: "no-optimized-frontend no-optimized-backend",
        backendProfile: "no-optimized-backend"
    }
];

function expectedWorkerResult(workerId: number, limit: number): number {
    return (limit * ((2 * workerId) + 8)) + ((3 * limit * (limit - 1)) / 2);
}

function normalizeLines(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function splitGcCollections(gcLines: readonly string[]): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    for (const line of gcLines) {
        current.push(line);
        if (line.startsWith("gc-sweep-summary ")) {
            chunks.push(current);
            current = [];
        }
    }
    strictEqual(current.length, 0, `unterminated gc collection chunk\n${gcLines.join("\n")}`);
    return chunks;
}

function buildStageC(fixtureDir: string, testCase: X64Case): X64StageCResult {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots("windows-x64")
    });
    performTypeChecking(ast, {
        disableBaseLibAutoLoad: false
    });

    const loweringOptions = {
      target: "windows-x64" as const,
        disableBaseLibAutoLoad: false,
        entryUnitId,
        requireEntryPoint: true
    };

    return testCase.backendProfile === "no-optimized-backend"
        ? performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts(ast, loweringOptions)
        : performNoOptimizeLoweringStageCFromArtifacts(ast, loweringOptions);
}

function runNative(supportC: string, assemblyText: string): string {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-x64-gc-multithread-stw-"));
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
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });

        return execLinuxBinarySync(binaryPath, [], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

const fixtureDir = join(repoRoot, "src", "Test-Windows", "Fixtures", "gc-multithread-stw");

    for (const testCase of x64Cases) {
        const stageC = buildStageC(fixtureDir, testCase);
        const asm = stageC.pass22x64emit.text;
        ok(asm.includes("gc_frame_begin"), `${testCase.label} should materialize x64 gc_frame_begin comments`);

        const supportC = generateX64NativeSupportCFromFinalBackendIR(
            stageC.pass10Support,
            "",
            stageC.pass18x64layout.layouts.classes,
            asm
        );
        ok(supportC.includes("iw_builtin_thread_spawn_i5"), `${testCase.label} support C should materialize the shared thread runtime`);

        const output = runNative(supportC, asm);
        const lines = normalizeLines(output);

        strictEqual(lines[lines.length - 1], String(expectedResult), `${testCase.label} multithread gc result mismatch\n${output}`);

        const chunks = splitGcCollections(lines.slice(0, -1));
        ok(chunks.length >= iterations, `${testCase.label} expected repeated GC collections across worker threads\n${output}`);

        const threadIds = new Set(
            chunks
                .flatMap((chunk) => chunk.filter((line) => line.startsWith("gc-thread tid=")))
                .map((line) => line.match(/^gc-thread tid=([0-9-]+)/)?.[1] ?? "")
                .filter((value) => value.length > 0)
        );
        ok(threadIds.size >= expectedLoggedThreadCount, `${testCase.label} expected gc scans from at least ${expectedLoggedThreadCount} non-collector threads\n${output}`);
        ok(chunks.some((chunk) => chunk.filter((line) => line.startsWith("gc-thread tid=")).length >= expectedLoggedThreadCount), `${testCase.label} expected at least one collection to scan ${expectedLoggedThreadCount} non-collector threads\n${output}`);
        ok(chunks.some((chunk) => chunk.some((line) => {
            const match = line.match(/^gc-summary frames=([0-9]+)/);
            return match !== null && Number(match[1]) >= threadCount;
        })), `${testCase.label} expected live frames from multiple worker threads\n${output}`);
        ok(chunks.some((chunk) => chunk.some((line) => /^gc-sweep-summary reclaimed=[1-9][0-9]*/.test(line))), `${testCase.label} expected at least one GC cycle to reclaim dead heap\n${output}`);

        process.stdout.write(`x64-gc-multithread-stw ${testCase.label} ok\n`);
    }
