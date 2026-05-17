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
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "gc-validate");
const entryUnitId = "test~gc~validate@main";

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

function runNative(supportC: string, assemblyText: string): string {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-x64-gc-validate-"));
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
    strictEqual(lines[lines.length - 1], "17", `${testCase.label} gc validate result mismatch\n${output}`);

    const gcLines = lines.slice(0, -1);
    const globalLines = gcLines.filter((line) => line.startsWith("gc-global "));
    const liveGlobalLines = gcLines.filter((line) => line.startsWith("gc-live-global "));
    const frameLines = gcLines.filter((line) => line.startsWith("gc-frame "));
    const liveFrameLines = gcLines.filter((line) => line.startsWith("gc-live-frame "));
    const heapLines = gcLines.filter((line) => line.startsWith("gc-heap "));
    const liveHeapLines = gcLines.filter((line) => line.startsWith("gc-live-heap "));
    const liveSummaryLines = gcLines.filter((line) => line.startsWith("gc-live-summary "));
    const summaryLines = gcLines.filter((line) => line.startsWith("gc-summary "));

    const mainGlobalLine = globalLines.find((line) => line.startsWith("gc-global global:test~gc~validate@main addr="));
    ok(mainGlobalLine !== undefined, `${testCase.label} missing main-unit gc-global line\n${output}`);

    const mainLiveGlobalLine = liveGlobalLines.find((line) => line.startsWith("gc-live-global global:test~gc~validate@main addr="));
    ok(mainLiveGlobalLine !== undefined, `${testCase.label} missing main-unit gc-live-global line\n${output}`);
    ok(mainLiveGlobalLine.includes("fields={<none>}"), `${testCase.label} expected empty live global content\n${output}`);

    strictEqual(frameLines.length, 2, `${testCase.label} expected two gc-frame lines\n${output}`);
    ok(frameLines.some((line) => line.startsWith("gc-frame frame:args addr=")), `${testCase.label} missing args wrapper gc-frame line\n${output}`);
    ok(frameLines.some((line) => !line.startsWith("gc-frame frame:args addr=")), `${testCase.label} missing main gc-frame line\n${output}`);

    strictEqual(liveFrameLines.length, 2, `${testCase.label} expected two gc-live-frame lines\n${output}`);
    const mainLiveFrameLine = liveFrameLines.find((line) => !line.startsWith("gc-live-frame frame:args addr="));
    const argsLiveFrameLine = liveFrameLines.find((line) => line.startsWith("gc-live-frame frame:args addr="));
    ok(mainLiveFrameLine !== undefined, `${testCase.label} missing main gc-live-frame line\n${output}`);
    ok(argsLiveFrameLine !== undefined, `${testCase.label} missing args wrapper gc-live-frame line\n${output}`);
    ok(argsLiveFrameLine.includes("roots={args=heap:builtin:array@"), `${testCase.label} missing args root in wrapper gc-live-frame\n${output}`);
    ok(mainLiveFrameLine.startsWith("gc-live-frame frame:"), `${testCase.label} unexpected main gc-live-frame line\n${output}`);
    ok(mainLiveFrameLine.includes("heap:builtin:text@") && mainLiveFrameLine.includes('="hhhhh"'), `${testCase.label} missing live text value in frame\n${output}`);
    ok(mainLiveFrameLine.includes("heap:builtin:array@"), `${testCase.label} missing live array value in frame\n${output}`);
    ok(mainLiveFrameLine.includes("heap:class:test~gc~validate@Marker@"), `${testCase.label} missing live Marker value in frame\n${output}`);
    ok(mainLiveFrameLine.includes("heap:class:test~gc~validate@Payload@"), `${testCase.label} missing live Payload value in frame\n${output}`);

    strictEqual(heapLines.length, 5, `${testCase.label} expected five gc-heap lines\n${output}`);
    strictEqual(heapLines.filter((line) => line.includes("heap:builtin:text")).length, 1, `${testCase.label} expected one text heap line\n${output}`);
    strictEqual(heapLines.filter((line) => line.includes("heap:builtin:array")).length, 2, `${testCase.label} expected two array heap lines\n${output}`);
    strictEqual(heapLines.filter((line) => line.includes("heap:class:")).length, 2, `${testCase.label} expected two class heap lines\n${output}`);

    strictEqual(liveHeapLines.length, 5, `${testCase.label} expected five gc-live-heap lines\n${output}`);
    ok(liveHeapLines.some((line) => line.includes("heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `${testCase.label} missing live args array heap line\n${output}`);
    strictEqual(liveHeapLines.filter((line) => line.includes('data="hhhhh"')).length, 1, `${testCase.label} expected one repeated-char live text\n${output}`);
    ok(
        liveHeapLines.some((line) => line.includes("heap:class:test~gc~validate@Marker") && line.includes("label=heap:builtin:text@") && line.includes('="hhhhh"')),
        `${testCase.label} missing live Marker content line\n${output}`
    );
    ok(
        liveHeapLines.some((line) => line.includes("heap:class:test~gc~validate@Payload") && line.includes("marker=heap:class:test~gc~validate@Marker@") && line.includes("name=heap:builtin:text@") && line.includes('="hhhhh"')),
        `${testCase.label} missing live Payload content line\n${output}`
    );
    ok(
        liveHeapLines.some((line) => line.includes("heap:builtin:array") && line.includes("length=2") && line.includes("items=[heap:builtin:text@") && line.includes('="hhhhh"')),
        `${testCase.label} missing live array content line\n${output}`
    );

    strictEqual(liveSummaryLines.length, 1, `${testCase.label} expected one gc-live-summary line\n${output}`);
    const liveSummaryMatch = liveSummaryLines[0].match(/^gc-live-summary live_heap=(\d+) dead_heap=(\d+)$/);
    ok(liveSummaryMatch !== null, `${testCase.label} unexpected gc-live-summary line\n${output}`);
    strictEqual(Number(liveSummaryMatch[1]), 5, `${testCase.label} unexpected live heap count\n${output}`);
    strictEqual(Number(liveSummaryMatch[2]), 0, `${testCase.label} unexpected dead heap count\n${output}`);

    strictEqual(summaryLines.length, 1, `${testCase.label} expected one gc-summary line\n${output}`);
    const summaryMatch = summaryLines[0].match(/^gc-summary frames=(\d+) heap=(\d+)$/);
    ok(summaryMatch !== null, `${testCase.label} unexpected gc-summary line\n${output}`);
    strictEqual(Number(summaryMatch[1]), 2, `${testCase.label} unexpected frame count\n${output}`);
    strictEqual(Number(summaryMatch[2]), 5, `${testCase.label} unexpected heap count\n${output}`);

    process.stdout.write(`x64-gc-validate ${testCase.label} ok\n`);
}
