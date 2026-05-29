import { ok, strictEqual } from "assert";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

interface ModeResourceSummary {
    readonly caseCount: number;
    readonly maxDurationMs: number;
    readonly maxDurationCase: string | null;
    readonly maxRssKb: number;
    readonly maxRssCase: string | null;
    readonly resourceFailureCount: number;
    readonly timeoutCount: number;
    readonly rssLimitExceededCount: number;
}

interface ResourceSummaryFile {
    readonly parsing: ModeResourceSummary | null;
    readonly transform: ModeResourceSummary | null;
}

const TEST_TIMEOUT_MS: number = 30 * 60 * 1000;
const MAX_BUFFER_BYTES: number = 64 * 1024 * 1024;
const EXTERNAL_TIMEOUT_MS: number = 12000;
const EXTERNAL_MAX_RSS_KB: number = 128 * 1024;
const EXTERNAL_MAX_ADDRESS_SPACE_KB: number = 192 * 1024;
const LARGE_ARRAY_ITEM_COUNT: number = 300000;
const LARGE_OBJECT_PROPERTY_COUNT: number = 45000;
const LONG_STRING_REPEAT_COUNT: number = 110000;
const repoRoot: string = resolve(__dirname, "..", "..");
const suiteScriptPath: string = join(repoRoot, "src", "examples", "json-lib", "validate-json-suite.js");
const validatorScriptPath: string = join(repoRoot, "src", "examples", "json-lib", "run-json-validator.js");
const transformerScriptPath: string = join(repoRoot, "src", "examples", "json-lib", "run-json-transformer.js");

function buildFlatNumericArrayJson(itemCount: number): string {
    const parts: string[] = new Array<string>(itemCount);
    for (let index = 0; index < itemCount; index += 1) {
        parts[index] = String(index % 100000);
    }
    return `[${parts.join(",")}]`;
}

function buildManySmallKeysObjectJson(propertyCount: number): string {
    const parts: string[] = new Array<string>(propertyCount);
    for (let index = 0; index < propertyCount; index += 1) {
        parts[index] = `"k${String(index)}":${String(index % 997)}`;
    }
    return `{${parts.join(",")}}`;
}

function buildLongEscapedStringJson(repeatCount: number): string {
    return `{"text":"${"line\\nquote\\\"slash\\\\tab\\t".repeat(repeatCount)}"}`;
}

function assertResourceSummary(mode: string, summary: ModeResourceSummary | null, minimumCaseCount: number): void {
    ok(summary !== null, `${mode} resource summary should be present`);
    strictEqual(summary.resourceFailureCount, 0, `${mode} should not hit resource failures`);
    strictEqual(summary.timeoutCount, 0, `${mode} should not hit timeouts`);
    strictEqual(summary.rssLimitExceededCount, 0, `${mode} should not exceed the RSS limit`);
    ok(summary.caseCount >= minimumCaseCount, `${mode} should measure at least ${minimumCaseCount} cases, got ${summary.caseCount}`);
    ok(summary.maxDurationMs > 0 && summary.maxDurationMs <= EXTERNAL_TIMEOUT_MS, `${mode} peak duration should stay within ${EXTERNAL_TIMEOUT_MS}ms, got ${summary.maxDurationMs}`);
    ok(summary.maxRssKb > 0 && summary.maxRssKb <= EXTERNAL_MAX_RSS_KB, `${mode} peak RSS should stay within ${EXTERNAL_MAX_RSS_KB}KB, got ${summary.maxRssKb}KB`);
}

function prewarmExternalRunner(scriptPath: string, inputPath: string): void {
    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [scriptPath, inputPath, repoRoot], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    strictEqual(result.signal, null, `prewarm ${scriptPath} signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.status, 0, `prewarm ${scriptPath} exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-json-lib-resource-guard-"));
try {
    const suiteRoot: string = join(tempDir, "suite");
    const parsingDir: string = join(suiteRoot, "test_parsing");
    const transformDir: string = join(suiteRoot, "test_transform");
    const summaryPath: string = join(tempDir, "resource-summary.json");
    mkdirSync(parsingDir, { recursive: true });
    mkdirSync(transformDir, { recursive: true });

    const flatArrayJson: string = buildFlatNumericArrayJson(LARGE_ARRAY_ITEM_COUNT);
    const largeObjectJson: string = buildManySmallKeysObjectJson(LARGE_OBJECT_PROPERTY_COUNT);
    const longEscapedStringJson: string = buildLongEscapedStringJson(LONG_STRING_REPEAT_COUNT);
    const warmupPath: string = join(parsingDir, "y_warmup_small.json");

    writeFileSync(warmupPath, "{\"warmup\":true}\n", "utf8");
    writeFileSync(join(parsingDir, "y_array_flat_numbers_large.json"), `${flatArrayJson}\n`, "utf8");
    writeFileSync(join(parsingDir, "n_array_flat_numbers_large_truncated.json"), flatArrayJson.slice(0, -2), "utf8");
    writeFileSync(join(parsingDir, "y_object_many_small_keys_large.json"), `${largeObjectJson}\n`, "utf8");
    writeFileSync(join(parsingDir, "y_string_long_escapes_large.json"), `${longEscapedStringJson}\n`, "utf8");
    writeFileSync(join(transformDir, "array_flat_numbers_large.json"), `${flatArrayJson}\n`, "utf8");
    writeFileSync(join(transformDir, "object_many_small_keys_large.json"), `${largeObjectJson}\n`, "utf8");
    writeFileSync(join(transformDir, "string_long_escapes_large.json"), `${longEscapedStringJson}\n`, "utf8");

    prewarmExternalRunner(validatorScriptPath, warmupPath);
    prewarmExternalRunner(transformerScriptPath, warmupPath);

    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [
        suiteScriptPath,
        "--suite-root",
        suiteRoot,
        "--mode",
        "all",
        "--runner",
        "external-command",
        "--validator-command",
        "node src/examples/json-lib/run-json-validator.js {file}",
        "--transform-command",
        "node src/examples/json-lib/run-json-transformer.js {file}",
        "--max-failures",
        "1",
        "--external-timeout-ms",
        String(EXTERNAL_TIMEOUT_MS),
        "--external-max-rss-kb",
        String(EXTERNAL_MAX_RSS_KB),
        "--external-max-address-space-kb",
        String(EXTERNAL_MAX_ADDRESS_SPACE_KB),
        "--resource-summary-json",
        summaryPath
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    if (result.error !== undefined) {
        throw result.error;
    }

    strictEqual(result.signal, null, `json-lib resource guard signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.status, 0, `json-lib resource guard exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    strictEqual(result.stderr, "", `json-lib resource guard stderr mismatch\n${result.stderr}`);

    const summary: ResourceSummaryFile = JSON.parse(readFileSync(summaryPath, "utf8")) as ResourceSummaryFile;
    assertResourceSummary("parsing", summary.parsing, 4);
    assertResourceSummary("transform", summary.transform, 3);
    ok(result.stdout.includes("parsing summary"), `expected parsing summary in output\n${result.stdout}`);
    ok(result.stdout.includes("transform summary"), `expected transform summary in output\n${result.stdout}`);

    process.stdout.write(
        `json-lib-resource-guard parsing_peak_ms=${summary.parsing?.maxDurationMs.toFixed(2) ?? "0.00"} parsing_peak_rss_kb=${String(summary.parsing?.maxRssKb ?? 0)} transform_peak_ms=${summary.transform?.maxDurationMs.toFixed(2) ?? "0.00"} transform_peak_rss_kb=${String(summary.transform?.maxRssKb ?? 0)} ok\n`
    );
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}