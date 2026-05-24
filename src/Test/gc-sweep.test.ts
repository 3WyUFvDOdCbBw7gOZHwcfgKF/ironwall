import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { normalizeOutputLines, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "gc-sweep");
const entryUnitId = "test~gc~sweep@main";

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

const result = spawnBuildJsonCliSync(join(repoRoot, "build", "main.js"), [
    "run",
    fixtureDir,
    "--entry",
    entryUnitId,
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

strictEqual(result.signal, null, `gc sweep signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.status, 29, `gc sweep result mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.stderr, "", `gc sweep stderr mismatch\n${result.stderr}`);

const output = result.stdout;
const chunks = splitGcCollections(normalizeOutputLines(output));
strictEqual(chunks.length, 2, `expected two gc collection chunks\n${output}`);

const [firstChunk, secondChunk] = chunks;

strictEqual(firstChunk.filter((line) => line.startsWith("gc-global ")).length, 1, `expected one gc-global line in first chunk\n${output}`);
strictEqual(firstChunk.filter((line) => line.startsWith("gc-live-global ")).length, 1, `expected one gc-live-global line in first chunk\n${output}`);
strictEqual(firstChunk.filter((line) => line.startsWith("gc-frame ")).length, 2, `expected two gc-frame lines in first chunk\n${output}`);
strictEqual(firstChunk.filter((line) => line.startsWith("gc-live-frame ")).length, 2, `expected two gc-live-frame lines in first chunk\n${output}`);
strictEqual(firstChunk.filter((line) => line.startsWith("gc-heap ")).length, 8, `expected eight gc-heap lines in first chunk\n${output}`);
strictEqual(firstChunk.filter((line) => line.startsWith("gc-live-heap ")).length, 5, `expected five gc-live-heap lines in first chunk\n${output}`);
strictEqual(firstChunk.filter((line) => line === "gc-live-summary live_heap=5 dead_heap=3").length, 1, `unexpected first gc-live-summary line\n${output}`);
strictEqual(firstChunk.filter((line) => line === "gc-summary frames=2 heap=8").length, 1, `unexpected first gc-summary line\n${output}`);
strictEqual(firstChunk.filter((line) => line === "gc-sweep-summary reclaimed=3 remaining_heap=5").length, 1, `unexpected first gc-sweep-summary line\n${output}`);
ok(firstChunk.some((line) => line.startsWith("gc-live-frame frame:args addr=")), `missing args wrapper gc-live-frame line in first chunk\n${output}`);
ok(firstChunk.some((line) => line.includes("gc-live-heap heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `missing live args array heap line in first chunk\n${output}`);

strictEqual(secondChunk.filter((line) => line.startsWith("gc-global ")).length, 1, `expected one gc-global line in second chunk\n${output}`);
strictEqual(secondChunk.filter((line) => line.startsWith("gc-live-global ")).length, 1, `expected one gc-live-global line in second chunk\n${output}`);
strictEqual(secondChunk.filter((line) => line.startsWith("gc-frame ")).length, 2, `expected two gc-frame lines in second chunk\n${output}`);
strictEqual(secondChunk.filter((line) => line.startsWith("gc-live-frame ")).length, 2, `expected two gc-live-frame lines in second chunk\n${output}`);
strictEqual(secondChunk.filter((line) => line.startsWith("gc-heap ")).length, 5, `expected five gc-heap lines in second chunk\n${output}`);
strictEqual(secondChunk.filter((line) => line.startsWith("gc-live-heap ")).length, 5, `expected five gc-live-heap lines in second chunk\n${output}`);
strictEqual(secondChunk.filter((line) => line === "gc-live-summary live_heap=5 dead_heap=0").length, 1, `unexpected second gc-live-summary line\n${output}`);
strictEqual(secondChunk.filter((line) => line === "gc-summary frames=2 heap=5").length, 1, `unexpected second gc-summary line\n${output}`);
strictEqual(secondChunk.filter((line) => line === "gc-sweep-summary reclaimed=0 remaining_heap=5").length, 1, `unexpected second gc-sweep-summary line\n${output}`);
ok(secondChunk.some((line) => line.startsWith("gc-live-frame frame:args addr=")), `missing args wrapper gc-live-frame line in second chunk\n${output}`);
ok(secondChunk.some((line) => line.includes("gc-live-heap heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `missing live args array heap line in second chunk\n${output}`);

ok(secondChunk.every((line) => !line.includes('data="d"') && !line.includes('data="dddd"') && !line.includes("imm(9)")), `dead heap content leaked after sweep\n${output}`);

process.stdout.write("gc-sweep no-optimized-frontend c-backend ok\n");
