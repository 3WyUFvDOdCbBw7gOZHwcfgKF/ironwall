import { execFileSync, spawnSync } from "child_process";
import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { performNoOptimizeCBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateCFromFinalBackendIR } from "../backend-linux/Backend-Linux-C";

const repoRoot = resolve(__dirname, "..", "..");
const entryUnitId = "test~gc~multithread~stw@main";
const threadCount = 4;
const iterations = 8;
const expectedResult = Array.from({ length: threadCount }, (_, index) => expectedWorkerResult(index + 1, iterations)).reduce((sum, value) => sum + value, 0);

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

function loadTypedProgramAst(fixtureDir: string) {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots()
    });
    performTypeChecking(ast, {
        disableBaseLibAutoLoad: false
    });
    return ast;
}

  interface NativeRunResult {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  function assertCBackendLinksAndRuns(generatedC: string, env: NodeJS.ProcessEnv): NativeRunResult {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-gc-multithread-stw-c-"));
    try {
        const programPath = join(tempDir, "program.c");
        const binaryPath = join(tempDir, "program.out");

        writeFileSync(programPath, generatedC, "utf8");
        execFileSync("cc", ["-O0", "-std=c11", "-pthread", programPath, "-lm", "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });

        const result = spawnSync(binaryPath, {
            cwd: repoRoot,
            encoding: "utf8",
          env,
            maxBuffer: 32 * 1024 * 1024,
            timeout: 120000
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
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "gc-multithread-stw");

    const ast = loadTypedProgramAst(fixtureDir);
    const stageC = performNoOptimizeCBackendLoweringStageCFromArtifacts(ast, {
        disableBaseLibAutoLoad: false,
        entryUnitId,
        requireEntryPoint: true
    });
    const generatedC = generateCFromFinalBackendIR(stageC.pass10);
    const result = assertCBackendLinksAndRuns(generatedC, process.env);
    strictEqual(result.signal, null, `multithread gc signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.status, expectedResult & 0xff, `multithread gc result mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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

    const quietResult = assertCBackendLinksAndRuns(generatedC, {
      ...process.env,
      IW_GC_PRINT: "0"
    });
    strictEqual(quietResult.signal, null, `quiet multithread gc signal mismatch\nstdout:\n${quietResult.stdout}\nstderr:\n${quietResult.stderr}`);
    strictEqual(quietResult.status, expectedResult & 0xff, `quiet multithread gc result mismatch\nstdout:\n${quietResult.stdout}\nstderr:\n${quietResult.stderr}`);
    strictEqual(quietResult.stderr, "", `quiet multithread gc stderr mismatch\n${quietResult.stderr}`);
    strictEqual(normalizeLines(quietResult.stdout).length, 0, `expected no gc print output when IW_GC_PRINT=0\n${quietResult.stdout}`);

    process.stdout.write("gc-multithread-stw no-optimized-frontend c-backend ok\n");
