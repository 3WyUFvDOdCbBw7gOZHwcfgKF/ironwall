import { execFileSync, spawnSync } from "child_process";
import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { performNoOptimizeLoweringStageCFromArtifacts, performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateX64NativeSupportCFromFinalBackendIR } from "../backend-linux/Backend-Linux-C";
import type { FinalBackendIRProgram, X64LaidOutProgram, X64TextualAssemblyProgram } from "../backend-linux/Backend-Linux-IR-Shared";

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

const PROGRAM_SOURCE = `{program ${entryUnitId}
  (import std~gc)
  (import std~thread)
  (class Token
    (property [label s3])
    (property [value i5])
    (constructor ([label0 s3] [value0 i5]) in
      {
        (cm_set self label label0)
        (cm_set self value value0)
      }
    )
  )
  (class Bundle
    (property [token Token])
    (property [items <array s3>])
    (property [score i5])
    (constructor ([token0 Token] [items0 <array s3>] [score0 i5]) in
      {
        (cm_set self token token0)
        (cm_set self items items0)
        (cm_set self score score0)
      }
    )
  )
  (class StartGate
    (property [lock Mutex])
    (property [ready Cond])
    (property [ready_count i5])
    (property [started i5])
    (constructor ([lock0 Mutex] [ready0 Cond]) in
      {
        (cm_set self lock lock0)
        (cm_set self ready ready0)
        (cm_set self ready_count $0^i5)
        (cm_set self started $0^i5)
      }
    )
  )
  (function wait_for_start ([gate StartGate] [worker_count i5]) to unit in
    {
      (lock gate.lock)
      (var [next_ready i5] (add gate.ready_count $1^i5))
      (cm_set gate ready_count next_ready)
      (if (eq next_ready worker_count) then
        {
          (cm_set gate started $1^i5)
          (broadcast gate.ready)
        }
        else
        (while (eq gate.started $0^i5) in
          (wait gate.ready gate.lock)
        )
      )
      (unlock gate.lock)
      unit
    }
  )
  (function dead_noise ([seed i5]) to i5 in
    {
      (var [dead_text s3] (s3_new $4^i5 (s3_get $dead_s3^s3 $0^i5)))
      (var [dead_items <array s3>] (array_new <array s3> $2^i5 dead_text))
      $0^i5
    }
  )
  (function make_token ([seed i5]) to Token in
    {
      (var [label s3] (s3_new $5^i5 (s3_get $hello_s3^s3 $0^i5)))
      (class_new Token label seed)
    }
  )
  (function leaf ([worker_id i5] [bundle Bundle] [token Token] [iteration i5]) to i5 in
    {
      (var [reclaimed i5] (if (eq worker_id $1^i5) then (gc_collect) else $0^i5))
      (add
        bundle.score
        (add token.value (add (s3_length token.label) (array_length bundle.items)))
      )
    }
  )
  (function middle ([worker_id i5] [seed i5] [iteration i5]) to i5 in
    {
      (var [waste i5] (dead_noise seed))
      (var [token Token] (make_token seed))
      (var [items <array s3>] (array_new <array s3> $3^i5 token.label))
      (var [bundle Bundle] (class_new Bundle token items (add seed iteration)))
      (add waste (leaf worker_id bundle token iteration))
    }
  )
  (function exit_worker ([value i5]) to i5 in
    {
      (var [token Token] (make_token value))
      (var [items <array s3>] (array_new <array s3> $2^i5 token.label))
      (var [bundle Bundle] (class_new Bundle token items value))
      (exit_thread bundle.score)
    }
  )
  (function worker_entry ([worker_id i5] [limit i5] [gate StartGate]) to i5 in
    {
      (wait_for_start gate $${threadCount}^i5)
      (var [index i5] $0^i5)
      (var [total i5] $0^i5)
      (while (lt index limit) in
        {
          (var [seed i5] (add worker_id index))
          (var_set total (add total (middle worker_id seed index)))
          (yield)
          (var_set index (add index $1^i5))
        }
      )
      (if (eq worker_id $1^i5) then
        (exit_worker total)
        else
        total
      )
    }
  )
  (function main ([args <array s3>]) to i5 in
    {
      (var [gate StartGate] (class_new StartGate (mutex) (cond_var)))
      (var [thread1 Thread] (spawn (fn ([ignored unit]) to i5 in (worker_entry $1^i5 $${iterations}^i5 gate))))
      (var [thread2 Thread] (spawn (fn ([ignored unit]) to i5 in (worker_entry $2^i5 $${iterations}^i5 gate))))
      (var [thread3 Thread] (spawn (fn ([ignored unit]) to i5 in (worker_entry $3^i5 $${iterations}^i5 gate))))
      (var [thread4 Thread] (spawn (fn ([ignored unit]) to i5 in (worker_entry $4^i5 $${iterations}^i5 gate))))
      (var [result1 i5] (join thread1))
      (var [result2 i5] (join thread2))
      (var [result3 i5] (join thread3))
      (var [result4 i5] (join thread4))
      (destroy_cond gate.ready)
      (destroy_mutex gate.lock)
      (add result1 (add result2 (add result3 result4)))
    }
  )
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

function createFixtureDir(): string {
    const fixtureDir = mkdtempSync(join(tmpdir(), "ironwall-x64-gc-multithread-stw-fixture-"));
    writeFileSync(join(fixtureDir, `${entryUnitId}.iw`), PROGRAM_SOURCE, "utf8");
    writeFileSync(join(fixtureDir, "test~gc~multithread~stw$lit.json"), JSON.stringify({
        package: "test~gc~multithread~stw$lit",
        "dead_s3^s3": "dead",
        "hello_s3^s3": "hello"
    }, null, 2), "utf8");
    return fixtureDir;
}

function buildStageC(fixtureDir: string, testCase: X64Case): X64StageCResult {
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

    return testCase.backendProfile === "no-optimized-backend"
        ? performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts(ast, loweringOptions)
        : performNoOptimizeLoweringStageCFromArtifacts(ast, loweringOptions);
}

  function runNative(supportC: string, assemblyText: string, env: NodeJS.ProcessEnv): string {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-x64-gc-multithread-stw-"));
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
            env,
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

const fixtureDir = createFixtureDir();

try {
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

        const output = runNative(supportC, asm, process.env);
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

        const quietOutput = runNative(supportC, asm, {
          ...process.env,
          IW_GC_PRINT: "0"
        });
        strictEqual(normalizeLines(quietOutput).join("\n"), String(expectedResult), `${testCase.label} expected only the final result when IW_GC_PRINT=0\n${quietOutput}`);

        process.stdout.write(`x64-gc-multithread-stw ${testCase.label} ok\n`);
    }
} finally {
    rmSync(fixtureDir, { recursive: true, force: true });
}
