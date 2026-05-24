import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { normalizeOutputLines, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "gc-global-print");
const entryUnitId = "test~gc~global~print@main";

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

strictEqual(result.signal, null, `gc global print signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.status, 16, `gc global print result mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.stderr, "", `gc global print stderr mismatch\n${result.stderr}`);

const output = result.stdout;
const gcLines = normalizeOutputLines(output);
const globalLines = gcLines.filter((line) => line.startsWith("gc-global "));
const liveGlobalLines = gcLines.filter((line) => line.startsWith("gc-live-global "));
const frameLines = gcLines.filter((line) => line.startsWith("gc-frame "));
const liveFrameLines = gcLines.filter((line) => line.startsWith("gc-live-frame "));
const heapLines = gcLines.filter((line) => line.startsWith("gc-heap "));
const liveHeapLines = gcLines.filter((line) => line.startsWith("gc-live-heap "));
const liveSummaryLines = gcLines.filter((line) => line.startsWith("gc-live-summary "));

strictEqual(globalLines.length, 1, `expected one gc-global line\n${output}`);
ok(globalLines[0].startsWith("gc-global global:"), `unexpected gc-global line\n${output}`);

strictEqual(liveGlobalLines.length, 1, `expected one gc-live-global line\n${output}`);
ok(liveGlobalLines[0].includes("global_text=heap:builtin:text@") && liveGlobalLines[0].includes('="hhhhh"'), `missing global_text in live global\n${output}`);
ok(liveGlobalLines[0].includes("global_rank=imm(11)"), `missing global_rank in live global\n${output}`);
ok(
    liveGlobalLines[0].indexOf("global_rank=") < liveGlobalLines[0].indexOf("global_text="),
    `expected canonical global field order\n${output}`
);

strictEqual(frameLines.length, 2, `expected two gc-frame lines\n${output}`);
strictEqual(liveFrameLines.length, 2, `expected two gc-live-frame lines\n${output}`);
ok(frameLines.some((line) => line.startsWith("gc-frame frame:args addr=")), `missing args wrapper gc-frame line\n${output}`);
const mainLiveFrameLine = liveFrameLines.find((line) => !line.startsWith("gc-live-frame frame:args addr="));
const argsLiveFrameLine = liveFrameLines.find((line) => line.startsWith("gc-live-frame frame:args addr="));
ok(mainLiveFrameLine !== undefined, `missing main gc-live-frame line\n${output}`);
ok(argsLiveFrameLine !== undefined, `missing args wrapper gc-live-frame line\n${output}`);
ok(argsLiveFrameLine.includes("roots={args=heap:builtin:array@"), `missing args root in wrapper gc-live-frame\n${output}`);
ok(mainLiveFrameLine.includes("local_text=heap:builtin:text@") && mainLiveFrameLine.includes('="hhhhh"'), `missing local_text in live frame\n${output}`);

strictEqual(heapLines.length, 2, `expected two gc-heap lines\n${output}`);
strictEqual(liveHeapLines.length, 2, `expected two gc-live-heap lines\n${output}`);
ok(liveHeapLines.some((line) => line.includes("heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `missing live args array heap line\n${output}`);
ok(liveHeapLines.some((line) => line.includes("heap:builtin:text") && line.includes('data="hhhhh"')), `missing live global text heap line\n${output}`);

strictEqual(liveSummaryLines.length, 1, `expected one gc-live-summary line\n${output}`);
const liveSummaryMatch = liveSummaryLines[0].match(/^gc-live-summary live_heap=(\d+) dead_heap=(\d+)$/);
ok(liveSummaryMatch !== null, `unexpected gc-live-summary line\n${output}`);
strictEqual(Number(liveSummaryMatch[1]), 2, `unexpected live heap count\n${output}`);
strictEqual(Number(liveSummaryMatch[2]), 0, `unexpected dead heap count\n${output}`);

process.stdout.write("gc-global-print no-optimized-frontend c-backend ok\n");
