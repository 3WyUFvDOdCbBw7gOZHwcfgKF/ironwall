import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { normalizeOutputLines, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "gc-validate");
const entryUnitId = "test~gc~validate@main";

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

strictEqual(result.signal, null, `gc validate signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.status, 17, `gc validate result mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.stderr, "", `gc validate stderr mismatch\n${result.stderr}`);

const output = result.stdout;
const gcLines = normalizeOutputLines(output);
const globalLines = gcLines.filter((line) => line.startsWith("gc-global "));
const liveGlobalLines = gcLines.filter((line) => line.startsWith("gc-live-global "));
const frameLines = gcLines.filter((line) => line.startsWith("gc-frame "));
const liveFrameLines = gcLines.filter((line) => line.startsWith("gc-live-frame "));
const heapLines = gcLines.filter((line) => line.startsWith("gc-heap "));
const liveHeapLines = gcLines.filter((line) => line.startsWith("gc-live-heap "));
const liveSummaryLines = gcLines.filter((line) => line.startsWith("gc-live-summary "));
const summaryLines = gcLines.filter((line) => line.startsWith("gc-summary "));

strictEqual(globalLines.length, 1, `expected one gc-global line\n${output}`);
ok(globalLines[0].startsWith("gc-global global:"), `unexpected gc-global line\n${output}`);

strictEqual(liveGlobalLines.length, 1, `expected one gc-live-global line\n${output}`);
ok(liveGlobalLines[0].startsWith("gc-live-global global:"), `unexpected gc-live-global line\n${output}`);
ok(liveGlobalLines[0].includes("fields={<none>}"), `expected empty live global content\n${output}`);

strictEqual(frameLines.length, 2, `expected two gc-frame lines\n${output}`);
ok(frameLines.some((line) => line.startsWith("gc-frame frame:args addr=")), `missing args wrapper gc-frame line\n${output}`);
ok(frameLines.some((line) => !line.startsWith("gc-frame frame:args addr=")), `missing main gc-frame line\n${output}`);

strictEqual(liveFrameLines.length, 2, `expected two gc-live-frame lines\n${output}`);
const mainLiveFrameLine = liveFrameLines.find((line) => !line.startsWith("gc-live-frame frame:args addr="));
const argsLiveFrameLine = liveFrameLines.find((line) => line.startsWith("gc-live-frame frame:args addr="));
ok(mainLiveFrameLine !== undefined, `missing main gc-live-frame line\n${output}`);
ok(argsLiveFrameLine !== undefined, `missing args wrapper gc-live-frame line\n${output}`);
ok(argsLiveFrameLine.includes("roots={args=heap:builtin:array@"), `missing args root in wrapper gc-live-frame\n${output}`);
ok(mainLiveFrameLine.startsWith("gc-live-frame frame:"), `unexpected main gc-live-frame line\n${output}`);
ok(mainLiveFrameLine.includes("dynamic_text=heap:builtin:text@") && mainLiveFrameLine.includes('="hhhhh"'), `missing dynamic_text in live frame\n${output}`);
ok(mainLiveFrameLine.includes("items=heap:builtin:array@"), `missing items root in live frame\n${output}`);
ok(mainLiveFrameLine.includes("marker=heap:class:test~gc~validate@Marker@"), `missing marker root in live frame\n${output}`);
ok(mainLiveFrameLine.includes("payload=heap:class:test~gc~validate@Payload@"), `missing payload root in live frame\n${output}`);

strictEqual(heapLines.length, 5, `expected five gc-heap lines\n${output}`);
strictEqual(heapLines.filter((line) => line.includes("heap:builtin:text")).length, 1, `expected one text heap line\n${output}`);
strictEqual(heapLines.filter((line) => line.includes("heap:builtin:array")).length, 2, `expected two array heap lines\n${output}`);
strictEqual(heapLines.filter((line) => line.includes("heap:class:")).length, 2, `expected two class heap lines\n${output}`);

strictEqual(liveHeapLines.length, 5, `expected five gc-live-heap lines\n${output}`);
ok(liveHeapLines.some((line) => line.includes("heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `missing live args array heap line\n${output}`);
strictEqual(liveHeapLines.filter((line) => line.includes('data="hhhhh"')).length, 1, `expected one repeated-char live text\n${output}`);
ok(
    liveHeapLines.some((line) => line.includes("heap:class:test~gc~validate@Marker") && line.includes("label=heap:builtin:text@") && line.includes('="hhhhh"')),
    `missing live Marker content line\n${output}`
);
ok(
    liveHeapLines.some((line) => line.includes("heap:class:test~gc~validate@Payload") && line.includes("marker=heap:class:test~gc~validate@Marker@") && line.includes("name=heap:builtin:text@") && line.includes('="hhhhh"')),
    `missing live Payload content line\n${output}`
);
ok(
    liveHeapLines.some((line) => line.includes("heap:builtin:array") && line.includes("length=2") && line.includes("items=[heap:builtin:text@") && line.includes('="hhhhh"')),
    `missing live array content line\n${output}`
);

strictEqual(liveSummaryLines.length, 1, `expected one gc-live-summary line\n${output}`);
const liveSummaryMatch = liveSummaryLines[0].match(/^gc-live-summary live_heap=(\d+) dead_heap=(\d+)$/);
ok(liveSummaryMatch !== null, `unexpected gc-live-summary line\n${output}`);
strictEqual(Number(liveSummaryMatch[1]), 5, `unexpected live heap count\n${output}`);
strictEqual(Number(liveSummaryMatch[2]), 0, `unexpected dead heap count\n${output}`);

strictEqual(summaryLines.length, 1, `expected one gc-summary line\n${output}`);
const summaryMatch = summaryLines[0].match(/^gc-summary frames=(\d+) heap=(\d+)$/);
ok(summaryMatch !== null, `unexpected gc-summary line\n${output}`);
strictEqual(Number(summaryMatch[1]), 2, `unexpected frame count\n${output}`);
strictEqual(Number(summaryMatch[2]), 5, `unexpected heap count\n${output}`);

process.stdout.write("gc-validate no-optimized-frontend c-backend ok\n");
