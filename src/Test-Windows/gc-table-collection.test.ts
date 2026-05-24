import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { performNoOptimizeCBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateCFromFinalBackendIR } from "../backend-windows/Backend-Windows-C";
import { normalizeOutputLines, spawnBuildJsonCliSync } from "../Test/BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "gc-table-collection");
const entryUnitId = "test~gc~table~collection~app@main";

const ast = loadProgramAst(fixtureDir, {
    additionalInputPaths: getBaseLibSourceRoots("windows-x64")
});
performTypeChecking(ast, {
    disableBaseLibAutoLoad: false
});

const stageC = performNoOptimizeCBackendLoweringStageCFromArtifacts(ast, {
    disableBaseLibAutoLoad: false,
    entryUnitId,
    requireEntryPoint: true
});
const generatedC = generateCFromFinalBackendIR(stageC.pass10);

ok(generatedC.includes("iw_gc_all_metadata_tables"), "support C should emit metadata table collections");
ok(generatedC.includes("iw_gc_all_global_tables"), "support C should emit global table collections");
ok(generatedC.includes("iw_gc_metadata_table_all_keys"), "support C should emit one flat metadata key table");
ok(generatedC.includes("iw_gc_metadata_keys"), "support C should collect metadata UUID keys into one table");
ok(generatedC.includes("iw_gc_metadata_key_lookup_buckets"), "support C should build hashed metadata key lookup buckets");
ok(generatedC.includes("iw_gc_metadata_ref_lookup_buckets"), "support C should use hashed metadata ref lookup buckets");
ok(!generatedC.includes("iw_gc_metadata_table_unit_test_gc_table_collection_app_main"), "support C should not emit a main-unit metadata table");
ok(!generatedC.includes("iw_gc_metadata_table_unit_test_gc_table_collection_lib_box"), "support C should not emit a lib-unit metadata table");
ok(generatedC.includes("iw_gc_global_table_unit_test_gc_table_collection_app_main"), "support C should emit main-unit global table");
ok(generatedC.includes("iw_gc_global_table_unit_test_gc_table_collection_lib_box"), "support C should emit lib-unit global table");
ok(generatedC.includes("gc_tag1"), "support C should emit the first GC authentication tag");
ok(generatedC.includes("first_tag"), "support C should emit metadata first-tag fields");
ok(generatedC.includes("struct_uuid_hash"), "support C should emit struct UUID hash fields");
ok(generatedC.includes("table_uuid_hash"), "support C should emit metadata table UUID hash fields");
ok(generatedC.includes("gc_end_confirmation"), "support C should emit the trailing end confirmation tag");
ok(!generatedC.includes("gc_tag2"), "support C should not emit a second GC authentication tag");
ok(!generatedC.includes("gc_tag3"), "support C should not emit a third GC authentication tag");
ok(!generatedC.includes("gc_random"), "support C should not emit a trailing random slot");

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

strictEqual(result.signal, null, `gc table collection signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.status, 19, `gc table collection result mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
strictEqual(result.stderr, "", `gc table collection stderr mismatch\n${result.stderr}`);

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

strictEqual(globalLines.length, 2, `expected two gc-global lines\n${output}`);
ok(globalLines.some((line) => line.startsWith("gc-global global:test~gc~table~collection~app@main addr=")), `missing main-unit gc-global line\n${output}`);
ok(globalLines.some((line) => line.startsWith("gc-global global:test~gc~table~collection~lib@box addr=")), `missing lib-unit gc-global line\n${output}`);

strictEqual(liveGlobalLines.length, 2, `expected two gc-live-global lines\n${output}`);
const mainLiveGlobalLine = liveGlobalLines.find((line) => line.startsWith("gc-live-global global:test~gc~table~collection~app@main addr="));
const libLiveGlobalLine = liveGlobalLines.find((line) => line.startsWith("gc-live-global global:test~gc~table~collection~lib@box addr="));
ok(mainLiveGlobalLine !== undefined, `missing main-unit live global line\n${output}`);
ok(libLiveGlobalLine !== undefined, `missing lib-unit live global line\n${output}`);
ok(mainLiveGlobalLine.includes("test~gc~table~collection~app@main_rank=imm(7)"), `missing main_rank in main-unit live global\n${output}`);
ok(mainLiveGlobalLine.includes("test~gc~table~collection~app@main_text=heap:builtin:text@") && mainLiveGlobalLine.includes('="hhhh"'), `missing main_text in main-unit live global\n${output}`);
ok(
    mainLiveGlobalLine.indexOf("test~gc~table~collection~app@main_rank=") < mainLiveGlobalLine.indexOf("test~gc~table~collection~app@main_text="),
    `expected canonical main global field order\n${output}`
);
ok(libLiveGlobalLine.includes("test~gc~table~collection~lib@lib_rank=imm(2)"), `missing lib_rank in lib-unit live global\n${output}`);
ok(libLiveGlobalLine.includes("test~gc~table~collection~lib@lib_text=heap:builtin:text@") && libLiveGlobalLine.includes('="hhh"'), `missing lib_text in lib-unit live global\n${output}`);
ok(
    libLiveGlobalLine.indexOf("test~gc~table~collection~lib@lib_rank=") < libLiveGlobalLine.indexOf("test~gc~table~collection~lib@lib_text="),
    `expected canonical lib global field order\n${output}`
);

strictEqual(frameLines.length, 2, `expected two gc-frame lines\n${output}`);
strictEqual(liveFrameLines.length, 2, `expected two gc-live-frame lines\n${output}`);
ok(frameLines.some((line) => line.startsWith("gc-frame frame:args addr=")), `missing args wrapper gc-frame line\n${output}`);
const mainLiveFrameLine = liveFrameLines.find((line) => !line.startsWith("gc-live-frame frame:args addr="));
const argsLiveFrameLine = liveFrameLines.find((line) => line.startsWith("gc-live-frame frame:args addr="));
ok(mainLiveFrameLine !== undefined, `missing main gc-live-frame line\n${output}`);
ok(argsLiveFrameLine !== undefined, `missing args wrapper gc-live-frame line\n${output}`);
ok(argsLiveFrameLine.includes("roots={args=heap:builtin:array@"), `missing args root in wrapper gc-live-frame\n${output}`);
ok(mainLiveFrameLine.includes("lib_box=heap:class:test~gc~table~collection~lib@LibBox@"), `missing lib_box root in main gc-live-frame\n${output}`);
ok(mainLiveFrameLine.includes("main_box=heap:class:test~gc~table~collection~app@MainBox@"), `missing main_box root in main gc-live-frame\n${output}`);

strictEqual(heapLines.length, 5, `expected five gc-heap lines\n${output}`);
strictEqual(heapLines.filter((line) => line.includes("heap:builtin:text")).length, 2, `expected two text heap lines\n${output}`);
strictEqual(heapLines.filter((line) => line.includes("heap:builtin:array")).length, 1, `expected one array heap line\n${output}`);
strictEqual(heapLines.filter((line) => line.includes("heap:class:")).length, 2, `expected two class heap lines\n${output}`);

strictEqual(liveHeapLines.length, 5, `expected five gc-live-heap lines\n${output}`);
ok(liveHeapLines.some((line) => line.includes("heap:builtin:array") && line.includes("length=0") && line.includes("items=[]")), `missing live args array heap line\n${output}`);
strictEqual(liveHeapLines.filter((line) => line.includes('data="hhh"')).length, 1, `expected one lib text live heap line\n${output}`);
strictEqual(liveHeapLines.filter((line) => line.includes('data="hhhh"')).length, 1, `expected one main text live heap line\n${output}`);
ok(
    liveHeapLines.some((line) => line.includes("heap:class:test~gc~table~collection~lib@LibBox") && line.includes("name=heap:builtin:text@") && line.includes('="hhh"')),
    `missing live LibBox content line\n${output}`
);
ok(
    liveHeapLines.some((line) => line.includes("heap:class:test~gc~table~collection~app@MainBox") && line.includes("left=heap:class:test~gc~table~collection~lib@LibBox@") && line.includes("name=heap:builtin:text@") && line.includes('="hhhh"')),
    `missing live MainBox content line\n${output}`
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

process.stdout.write("gc-table-collection no-optimized-frontend c-backend ok\n");
