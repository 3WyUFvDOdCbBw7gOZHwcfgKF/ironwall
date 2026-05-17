import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { performNoOptimizeCBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateCFromFinalBackendIR } from "../backend-windows/Backend-Windows-C";
import { assertExpectedExitCode } from "./BuildJsonCliHarness";
import { execLinuxToolSync, spawnLinuxBinarySync } from "./LinuxHostToolchainHarness";

const repoRoot = resolve(__dirname, "..", "..");
const entryUnitId = "test~gc~multithread~stw@main";
const threadCount = 4;
const iterations = 8;
const expectedResult = Array.from({ length: threadCount }, (_, index) => expectedWorkerResult(index + 1, iterations)).reduce((sum, value) => sum + value, 0);

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
    const fixtureDir = mkdtempSync(join(tmpdir(), "ironwall-gc-multithread-stw-"));
    writeFileSync(join(fixtureDir, `${entryUnitId}.iw`), PROGRAM_SOURCE, "utf8");
  writeFileSync(join(fixtureDir, "test~gc~multithread~stw$lit.json"), JSON.stringify({
    package: "test~gc~multithread~stw$lit",
    "dead_s3^s3": "dead",
    "hello_s3^s3": "hello"
  }, null, 2), "utf8");
    return fixtureDir;
}

function loadTypedProgramAst(fixtureDir: string) {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots("windows-x64")
    });
    performTypeChecking(ast, {
        disableBaseLibAutoLoad: false
    });
    return ast;
}

function assertCBackendLinksAndRuns(generatedC: string): { readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string } {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-gc-multithread-stw-c-"));
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

        const result = spawnLinuxBinarySync(binaryPath, [], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            timeout: 120000
        });
        return {
            status: result.status,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr
        };
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

const fixtureDir = createFixtureDir();

try {
    const ast = loadTypedProgramAst(fixtureDir);
    const stageC = performNoOptimizeCBackendLoweringStageCFromArtifacts(ast, {
    target: "windows-x64" as const,
        disableBaseLibAutoLoad: false,
        entryUnitId,
        requireEntryPoint: true
    });
    const generatedC = generateCFromFinalBackendIR(stageC.pass10);
    const result = assertCBackendLinksAndRuns(generatedC);
    strictEqual(result.signal, null, `multithread gc signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertExpectedExitCode(result.status, expectedResult & 0xff, `multithread gc result mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.stderr, "", `multithread gc stderr mismatch\n${result.stderr}`);
    const output = result.stdout;
    const lines = normalizeLines(output);

    const chunks = splitGcCollections(lines);
    ok(chunks.length >= iterations, `expected repeated GC collections across worker threads\n${output}`);

    const threadIds = new Set(
        chunks
            .flatMap((chunk) => chunk.filter((line) => line.startsWith("gc-thread tid=")))
            .map((line) => line.match(/^gc-thread tid=([0-9-]+)/)?.[1] ?? "")
            .filter((value) => value.length > 0)
    );
    ok(threadIds.size >= threadCount, `expected gc scans from at least ${threadCount} worker threads\n${output}`);

    ok(chunks.some((chunk) => chunk.filter((line) => line.startsWith("gc-thread tid=")).length >= threadCount), `expected at least one collection to scan all worker threads\n${output}`);
    ok(chunks.some((chunk) => chunk.some((line) => {
        const match = line.match(/^gc-summary frames=([0-9]+)/);
      return match !== null && Number(match[1]) >= threadCount;
    })), `expected live frames from multiple worker threads\n${output}`);
    ok(chunks.some((chunk) => chunk.some((line) => /^gc-sweep-summary reclaimed=[1-9][0-9]*/.test(line))), `expected at least one GC cycle to reclaim dead heap\n${output}`);

    process.stdout.write("gc-multithread-stw no-optimized-frontend c-backend ok\n");
} finally {
    rmSync(fixtureDir, { recursive: true, force: true });
}
