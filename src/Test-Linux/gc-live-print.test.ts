import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { normalizeOutputLines, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "gc-live-print");
const entryUnitId = "test~gc~live~print@main";

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

strictEqual(result.signal, null, `gc live print signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.status, 29, `gc live print result mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.stderr, "", `gc live print stderr mismatch\n${result.stderr}`);

const output = result.stdout;
const gcLines = normalizeOutputLines(output);
const liveGlobalLines = gcLines.filter((line) => line.startsWith("gc-live-global "));
const liveFrameLines = gcLines.filter((line) => line.startsWith("gc-live-frame "));
const heapLines = gcLines.filter((line) => line.startsWith("gc-heap "));
const liveHeapLines = gcLines.filter((line) => line.startsWith("gc-live-heap "));
const liveSummaryLines = gcLines.filter((line) => line.startsWith("gc-live-summary "));

strictEqual(liveGlobalLines.length, 1, `expected one gc-live-global line\n${output}`);
ok(liveGlobalLines[0].includes("fields={<none>}"), `expected empty live global content\n${output}`);
strictEqual(liveFrameLines.length, 2, `expected two gc-live-frame lines\n${output}`);
const mainLiveFrameLine = liveFrameLines.find((line) => !line.startsWith("gc-live-frame frame:args addr="));
const argsLiveFrameLine = liveFrameLines.find((line) => line.startsWith("gc-live-frame frame:args addr="));
ok(mainLiveFrameLine !== undefined, `missing main gc-live-frame line\n${output}`);
ok(argsLiveFrameLine !== undefined, `missing args wrapper gc-live-frame line\n${output}`);
ok(argsLiveFrameLine.includes("roots={args=heap:builtin:array@"), `missing args root in wrapper gc-live-frame\n${output}`);
ok(mainLiveFrameLine.includes("dynamic_text=heap:builtin:text@") && mainLiveFrameLine.includes('="hhhhh"'), `missing dynamic_text in live frame\n${output}`);
ok(mainLiveFrameLine.includes("items=heap:builtin:array@"), `missing items root in live frame\n${output}`);
ok(mainLiveFrameLine.includes("marker=heap:class:test~gc~live~print@Marker@"), `missing marker root in live frame\n${output}`);
ok(mainLiveFrameLine.includes("payload=heap:class:test~gc~live~print@Payload@"), `missing payload root in live frame\n${output}`);

strictEqual(heapLines.length, 8, `expected eight total heap lines\n${output}`);
strictEqual(liveHeapLines.length, 5, `expected five live heap lines\n${output}`);
strictEqual(liveSummaryLines.length, 1, `expected one gc-live-summary line\n${output}`);

const liveSummaryMatch = liveSummaryLines[0].match(/^gc-live-summary live_heap=(\d+) dead_heap=(\d+)$/);
ok(liveSummaryMatch !== null, `unexpected gc-live-summary line\n${output}`);
strictEqual(Number(liveSummaryMatch[1]), 5, `unexpected live heap count\n${output}`);
strictEqual(Number(liveSummaryMatch[2]), 3, `unexpected dead heap count\n${output}`);

ok(liveHeapLines.some((line) => line.includes("heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `missing live args array heap line\n${output}`);
strictEqual(liveHeapLines.filter((line) => line.includes('data="hhhhh"')).length, 1, `expected one repeated-char live text\n${output}`);
ok(liveHeapLines.every((line) => !line.includes("dead") && !line.includes('data="d"') && !line.includes('data="dddd"') && !line.includes("imm(9)")), `dead heap content leaked into live output\n${output}`);
ok(
    liveHeapLines.some((line) => line.includes("heap:class:test~gc~live~print@Marker") && line.includes("label=heap:builtin:text@") && line.includes('="hhhhh"') && line.includes("rank=imm(7)")),
    `missing live Marker content line\n${output}`
);
ok(
    liveHeapLines.some((line) => line.includes("heap:class:test~gc~live~print@Payload") && line.includes("marker=heap:class:test~gc~live~print@Marker@") && line.includes("name=heap:builtin:text@") && line.includes('="hhhhh"') && line.includes("size=imm(2)")),
    `missing live Payload content line\n${output}`
);
ok(
    liveHeapLines.some((line) => line.includes("heap:builtin:array") && line.includes("length=2") && line.includes("items=[heap:builtin:text@") && line.includes('="hhhhh"')),
    `missing live array content line\n${output}`
);

process.stdout.write("gc-live-print no-optimized-frontend c-backend ok\n");
