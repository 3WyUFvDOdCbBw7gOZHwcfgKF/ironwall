import { execFileSync, spawnSync } from "child_process";
import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { performNoOptimizeLoweringStageCFromArtifacts, performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { performLoweringStageCFromArtifacts, performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateX64NativeSupportCFromFinalBackendIR } from "../backend-linux/Backend-Linux-C";
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

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "gc-sweep");
const entryUnitId = "test~gc~sweep@main";

const X64_NATIVE_DRIVER_SOURCE = `#include <stdint.h>
#include <stdio.h>
typedef intptr_t iw_value_t;
extern void __iw_x64_init_runtime(void);
extern iw_value_t __iw_host_entry_main(int argc, char **argv);
int main(int argc, char **argv) {
    __iw_x64_init_runtime();
    iw_value_t result = __iw_host_entry_main(argc, argv);
    printf("%ld\\n", (long)(((intptr_t)result) >> 1));
    return 0;
}
`;

const x64Cases: readonly X64Case[] = [
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

function buildStageC(testCase: X64Case): X64StageCResult {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots()
    });
    performTypeChecking(ast, {
        disableBaseLibAutoLoad: false
    });

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

function runNative(supportC: string, assemblyText: string): string {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-x64-gc-sweep-"));
    try {
        const supportPath = join(tempDir, "program.support.c");
        const driverPath = join(tempDir, "program.driver.c");
        const asmPath = join(tempDir, "program.s");
        const binaryPath = join(tempDir, "program.out");

        writeFileSync(supportPath, supportC, "utf8");
        writeFileSync(driverPath, X64_NATIVE_DRIVER_SOURCE, "utf8");
        writeFileSync(asmPath, assemblyText, "utf8");

        execFileSync("cc", ["-O0", "-std=c11", "-pthread", "-no-pie", supportPath, driverPath, asmPath, "-lm", "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });

        const result = spawnSync(binaryPath, [], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        if (result.error !== undefined) {
            throw result.error;
        }
        if (result.status !== 0 || result.signal !== null) {
            throw new Error(`x64 native run failed status=${result.status} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        return result.stdout;
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

for (const testCase of x64Cases) {
    const stageC = buildStageC(testCase);
    const asm = stageC.pass22x64emit.text;
    ok(asm.includes("gc_frame_begin"), `${testCase.label} should materialize x64 gc_frame_begin comments`);

    const supportC = generateX64NativeSupportCFromFinalBackendIR(
        stageC.pass10Support,
        "",
        stageC.pass18x64layout.layouts.classes,
        asm
    );
    ok(supportC.includes("__iw_x64_gc_frame_init_"), `${testCase.label} support C should materialize x64 GC frame init helpers`);

    const output = runNative(supportC, asm);
    const lines = normalizeLines(output);
    strictEqual(lines[lines.length - 1], "29", `${testCase.label} gc sweep result mismatch\n${output}`);

    const chunks = splitGcCollections(lines.slice(0, -1));
    strictEqual(chunks.length, 2, `${testCase.label} expected two gc collection chunks\n${output}`);

    const [firstChunk, secondChunk] = chunks;

    ok(firstChunk.some((line) => line.startsWith("gc-global global:test~gc~sweep@main addr=")), `${testCase.label} missing main-unit gc-global line in first chunk\n${output}`);
    ok(firstChunk.some((line) => line.startsWith("gc-live-global global:test~gc~sweep@main addr=")), `${testCase.label} missing main-unit gc-live-global line in first chunk\n${output}`);
    strictEqual(firstChunk.filter((line) => line.startsWith("gc-frame ")).length, 2, `${testCase.label} expected two gc-frame lines in first chunk\n${output}`);
    strictEqual(firstChunk.filter((line) => line.startsWith("gc-live-frame ")).length, 2, `${testCase.label} expected two gc-live-frame lines in first chunk\n${output}`);
    strictEqual(firstChunk.filter((line) => line.startsWith("gc-heap ")).length, 8, `${testCase.label} expected eight gc-heap lines in first chunk\n${output}`);
    strictEqual(firstChunk.filter((line) => line.startsWith("gc-live-heap ")).length, 5, `${testCase.label} expected five gc-live-heap lines in first chunk\n${output}`);
    strictEqual(firstChunk.filter((line) => line === "gc-live-summary live_heap=5 dead_heap=3").length, 1, `${testCase.label} unexpected first gc-live-summary line\n${output}`);
    strictEqual(firstChunk.filter((line) => line === "gc-summary frames=2 heap=8").length, 1, `${testCase.label} unexpected first gc-summary line\n${output}`);
    strictEqual(firstChunk.filter((line) => line === "gc-sweep-summary reclaimed=3 remaining_heap=5").length, 1, `${testCase.label} unexpected first gc-sweep-summary line\n${output}`);
    ok(firstChunk.some((line) => line.startsWith("gc-live-frame frame:args addr=")), `${testCase.label} missing args wrapper gc-live-frame line in first chunk\n${output}`);
    ok(firstChunk.some((line) => line.includes("gc-live-heap heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `${testCase.label} missing live args array heap line in first chunk\n${output}`);

    ok(secondChunk.some((line) => line.startsWith("gc-global global:test~gc~sweep@main addr=")), `${testCase.label} missing main-unit gc-global line in second chunk\n${output}`);
    ok(secondChunk.some((line) => line.startsWith("gc-live-global global:test~gc~sweep@main addr=")), `${testCase.label} missing main-unit gc-live-global line in second chunk\n${output}`);
    strictEqual(secondChunk.filter((line) => line.startsWith("gc-frame ")).length, 2, `${testCase.label} expected two gc-frame lines in second chunk\n${output}`);
    strictEqual(secondChunk.filter((line) => line.startsWith("gc-live-frame ")).length, 2, `${testCase.label} expected two gc-live-frame lines in second chunk\n${output}`);
    strictEqual(secondChunk.filter((line) => line.startsWith("gc-heap ")).length, 5, `${testCase.label} expected five gc-heap lines in second chunk\n${output}`);
    strictEqual(secondChunk.filter((line) => line.startsWith("gc-live-heap ")).length, 5, `${testCase.label} expected five gc-live-heap lines in second chunk\n${output}`);
    strictEqual(secondChunk.filter((line) => line === "gc-live-summary live_heap=5 dead_heap=0").length, 1, `${testCase.label} unexpected second gc-live-summary line\n${output}`);
    strictEqual(secondChunk.filter((line) => line === "gc-summary frames=2 heap=5").length, 1, `${testCase.label} unexpected second gc-summary line\n${output}`);
    strictEqual(secondChunk.filter((line) => line === "gc-sweep-summary reclaimed=0 remaining_heap=5").length, 1, `${testCase.label} unexpected second gc-sweep-summary line\n${output}`);
    ok(secondChunk.some((line) => line.startsWith("gc-live-frame frame:args addr=")), `${testCase.label} missing args wrapper gc-live-frame line in second chunk\n${output}`);
    ok(secondChunk.some((line) => line.includes("gc-live-heap heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `${testCase.label} missing live args array heap line in second chunk\n${output}`);

    ok(secondChunk.every((line) => !line.includes('data="d"') && !line.includes('data="dddd"') && !line.includes("imm(9)")), `${testCase.label} dead heap content leaked after sweep\n${output}`);

    process.stdout.write(`x64-gc-sweep ${testCase.label} ok\n`);
}
