import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, normalizeOutputLines, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "closure-hof-stress");
const functionalInputPath = join(fixtureDir, "test~closure~hof~stress@main.iw");
const functionalEntry = "test~closure~hof~stress@main";
const f5CaptureInputPath = join(fixtureDir, "test~closure~capture~f5@main.iw");
const f5CaptureEntry = "test~closure~capture~f5@main";
const gcInputPath = join(fixtureDir, "test~closure~gc~lifecycle@main.iw");
const gcEntry = "test~closure~gc~lifecycle@main";

const functionalRuns: readonly BackendRun[] = [
    {
        label: "optimized c-backend",
        runArgs: ["--backend-profile", "c-backend"]
    },
    {
        label: "optimized no-optimized-backend",
        runArgs: ["--backend-profile", "no-optimized-backend"]
    },
    {
        label: "optimized optimized-x64-backend",
        runArgs: ["--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized c-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "c-backend"]
    }
];

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

function parseReclaimedCount(chunk: readonly string[], output: string): number {
    const summaryLine = chunk.find((line) => line.startsWith("gc-sweep-summary "));
    ok(summaryLine !== undefined, `missing gc-sweep-summary line\n${output}`);
    const match = summaryLine.match(/^gc-sweep-summary reclaimed=(\d+) remaining_heap=(\d+)$/);
    ok(match !== null, `unexpected gc-sweep-summary line\n${output}`);
    return Number(match[1]);
}

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TEST_TIMEOUT_MS
});

for (const run of functionalRuns) {
    const result = spawnBuildJsonCliSync(cliPath, ["run", functionalInputPath, "--entry", functionalEntry, ...run.runArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    assertRunResult(result, [], 180, `${run.label} closure/hof stress`);
    process.stdout.write(`closure-hof-stress ${run.label} ok\n`);

    const f5Result = spawnBuildJsonCliSync(cliPath, ["run", f5CaptureInputPath, "--entry", f5CaptureEntry, ...run.runArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    assertRunResult(f5Result, [], 35, `${run.label} closure f5 capture`);
    process.stdout.write(`closure-hof-stress ${run.label} f5 capture ok\n`);
}

const gcResult = spawnBuildJsonCliSync(cliPath, [
    "run",
    gcInputPath,
    "--entry",
    gcEntry,
    "--frontend-profile",
    "no-optimized",
    "--backend-profile",
    "c-backend"
], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TEST_TIMEOUT_MS
});

strictEqual(gcResult.signal, null, `gc closure lifecycle signal mismatch\nstdout:\n${gcResult.stdout}\nstderr:\n${gcResult.stderr}`);
strictEqual(gcResult.stderr, "", `gc closure lifecycle stderr mismatch\n${gcResult.stderr}`);
const gcOutput = gcResult.stdout;
const chunks = splitGcCollections(normalizeOutputLines(gcOutput));
strictEqual(chunks.length, 2, `expected two gc collection chunks\n${gcOutput}`);

const [firstChunk, secondChunk] = chunks;
const firstReclaimed = parseReclaimedCount(firstChunk, gcOutput);
const secondReclaimed = parseReclaimedCount(secondChunk, gcOutput);
strictEqual(firstReclaimed > 0, true, `expected first gc collection to reclaim dead closure state\n${gcOutput}`);
strictEqual(secondReclaimed, 0, `expected second gc collection to find no additional dead closure state\n${gcOutput}`);
strictEqual(gcResult.status, (131 + firstReclaimed + secondReclaimed) & 0xff, `gc closure lifecycle final result mismatch\n${gcOutput}`);

ok(firstChunk.some((line) => line.startsWith("gc-live-frame frame:args addr=")), `missing args wrapper live frame in first gc chunk\n${gcOutput}`);
ok(secondChunk.some((line) => line.startsWith("gc-live-frame frame:args addr=")), `missing args wrapper live frame in second gc chunk\n${gcOutput}`);

const liveReaderFrame = secondChunk.find((line) => line.startsWith("gc-live-frame ") && line.includes("live_reader="));
ok(liveReaderFrame !== undefined, `missing live_reader root after gc\n${gcOutput}`);

ok(secondChunk.some((line) => line.includes("heap:class:test~closure~gc~lifecycle@Marker") && line.includes('label=heap:builtin:text@') && line.includes('="hhhhh"') && line.includes("rank=imm(7)")), `missing live Marker heap retained by closure\n${gcOutput}`);
ok(secondChunk.some((line) => line.includes("heap:class:test~closure~gc~lifecycle@Payload") && line.includes("marker=heap:class:test~closure~gc~lifecycle@Marker@") && line.includes('name=heap:builtin:text@') && line.includes('="hhhhh"') && line.includes("size=imm(2)")), `missing live Payload heap retained by closure\n${gcOutput}`);

ok(secondChunk.every((line) => !line.includes('="ddddd"') && !line.includes('="jjjjj"')), `dead closure payload text leaked after sweep\n${gcOutput}`);

process.stdout.write("closure-hof-stress gc lifecycle no-optimized-frontend c-backend ok\n");
