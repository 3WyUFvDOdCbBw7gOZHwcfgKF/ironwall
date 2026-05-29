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

interface SuiteRunResult {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly summary: ResourceSummaryFile;
}

const TEST_TIMEOUT_MS: number = 5 * 60 * 1000;
const MAX_BUFFER_BYTES: number = 64 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const suiteScriptPath: string = join(repoRoot, "src", "examples", "json-lib", "validate-json-suite.js");
const TIMEOUT_LIMIT_MS: number = 200;
const RSS_LIMIT_KB: number = 16 * 1024;
const ADDRESS_SPACE_LIMIT_KB: number = 256 * 1024;

function runSuiteWithSummary(args: readonly string[], summaryPath: string): SuiteRunResult {
    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [suiteScriptPath, ...args, "--resource-summary-json", summaryPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    const summary: ResourceSummaryFile = JSON.parse(readFileSync(summaryPath, "utf8")) as ResourceSummaryFile;
    return {
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        summary
    };
}

const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-json-lib-resource-failure-"));
try {
    const suiteRoot: string = join(tempDir, "suite");
    const parsingDir: string = join(suiteRoot, "test_parsing");
    const transformDir: string = join(suiteRoot, "test_transform");
    const timeoutScriptPath: string = join(tempDir, "timeout-validator.js");
    const rssScriptPath: string = join(tempDir, "rss-validator.js");
    const timeoutSummaryPath: string = join(tempDir, "timeout-summary.json");
    const rssSummaryPath: string = join(tempDir, "rss-summary.json");
    mkdirSync(parsingDir, { recursive: true });
    mkdirSync(transformDir, { recursive: true });

    writeFileSync(join(parsingDir, "y_small.json"), "{\"value\":1}\n", "utf8");
    writeFileSync(join(transformDir, "small.json"), "{\"value\":1}\n", "utf8");
    writeFileSync(
        timeoutScriptPath,
        [
            "setTimeout(() => {",
            "  process.exit(0);",
            "}, 5000);"
        ].join("\n") + "\n",
        "utf8"
    );
    writeFileSync(
        rssScriptPath,
        [
            "const chunks = [];",
            "for (let index = 0; index < 48; index += 1) {",
            "  chunks.push(Buffer.alloc(1024 * 1024, index));",
            "}",
            "process.stdout.write(\"ok\\n\");"
        ].join("\n") + "\n",
        "utf8"
    );

    const timeoutRun: SuiteRunResult = runSuiteWithSummary([
        "--suite-root",
        suiteRoot,
        "--mode",
        "parsing",
        "--runner",
        "external-command",
        "--validator-command",
        `${process.execPath} ${timeoutScriptPath} {file}`,
        "--max-failures",
        "1",
        "--external-timeout-ms",
        String(TIMEOUT_LIMIT_MS),
        "--external-max-rss-kb",
        String(128 * 1024),
        "--external-max-address-space-kb",
        String(ADDRESS_SPACE_LIMIT_KB)
    ], timeoutSummaryPath);
    strictEqual(timeoutRun.signal, null, `timeout guard run signal mismatch\nstdout:\n${timeoutRun.stdout}\nstderr:\n${timeoutRun.stderr}`);
    strictEqual(timeoutRun.status, 1, `timeout guard run should fail the suite\nstdout:\n${timeoutRun.stdout}\nstderr:\n${timeoutRun.stderr}`);
    strictEqual(timeoutRun.stderr, "", `timeout guard run stderr mismatch\n${timeoutRun.stderr}`);
    ok(timeoutRun.stdout.includes(`timeout after ${String(TIMEOUT_LIMIT_MS)}ms`), `timeout guard output should mention the timeout\n${timeoutRun.stdout}`);
    ok(timeoutRun.summary.parsing !== null, "timeout guard parsing summary should be present");
    strictEqual(timeoutRun.summary.parsing.resourceFailureCount, 1, `timeout guard should record one resource failure\n${JSON.stringify(timeoutRun.summary, null, 2)}`);
    strictEqual(timeoutRun.summary.parsing.timeoutCount, 1, `timeout guard should record one timeout\n${JSON.stringify(timeoutRun.summary, null, 2)}`);
    strictEqual(timeoutRun.summary.parsing.rssLimitExceededCount, 0, `timeout guard should not record an RSS overflow\n${JSON.stringify(timeoutRun.summary, null, 2)}`);

    const rssRun: SuiteRunResult = runSuiteWithSummary([
        "--suite-root",
        suiteRoot,
        "--mode",
        "parsing",
        "--runner",
        "external-command",
        "--validator-command",
        `${process.execPath} ${rssScriptPath} {file}`,
        "--max-failures",
        "1",
        "--external-timeout-ms",
        "2000",
        "--external-max-rss-kb",
        String(RSS_LIMIT_KB),
        "--external-max-address-space-kb",
        String(ADDRESS_SPACE_LIMIT_KB)
    ], rssSummaryPath);
    strictEqual(rssRun.signal, null, `rss guard run signal mismatch\nstdout:\n${rssRun.stdout}\nstderr:\n${rssRun.stderr}`);
    strictEqual(rssRun.status, 1, `rss guard run should fail the suite\nstdout:\n${rssRun.stdout}\nstderr:\n${rssRun.stderr}`);
    strictEqual(rssRun.stderr, "", `rss guard run stderr mismatch\n${rssRun.stderr}`);
    ok(rssRun.stdout.includes("peak RSS"), `rss guard output should mention peak RSS\n${rssRun.stdout}`);
    ok(rssRun.summary.parsing !== null, "rss guard parsing summary should be present");
    strictEqual(rssRun.summary.parsing.resourceFailureCount, 1, `rss guard should record one resource failure\n${JSON.stringify(rssRun.summary, null, 2)}`);
    strictEqual(rssRun.summary.parsing.timeoutCount, 0, `rss guard should not record a timeout\n${JSON.stringify(rssRun.summary, null, 2)}`);
    strictEqual(rssRun.summary.parsing.rssLimitExceededCount, 1, `rss guard should record one RSS overflow\n${JSON.stringify(rssRun.summary, null, 2)}`);
    ok(rssRun.summary.parsing.maxRssKb > RSS_LIMIT_KB, `rss guard should capture peak RSS beyond the limit\n${JSON.stringify(rssRun.summary, null, 2)}`);

    process.stdout.write(
        `json-lib-resource-failure-regression timeout_limit_ms=${String(TIMEOUT_LIMIT_MS)} rss_limit_kb=${String(RSS_LIMIT_KB)} timeout_peak_rss_kb=${String(timeoutRun.summary.parsing?.maxRssKb ?? 0)} rss_peak_kb=${String(rssRun.summary.parsing?.maxRssKb ?? 0)} ok\n`
    );
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}