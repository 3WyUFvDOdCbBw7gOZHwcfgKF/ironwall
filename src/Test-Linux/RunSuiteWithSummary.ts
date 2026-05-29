import { spawnSync, type SpawnSyncReturns } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

interface SuiteProgressEntry {
    readonly index: number;
    readonly total: number;
    readonly testFileName: string;
}

interface SuiteSummary {
    readonly summaryPath: string;
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly completionMarkerSeen: boolean;
    readonly failedTestFileName: string | null;
    readonly totalTestCount: number | null;
    readonly passedTests: readonly SuiteProgressEntry[];
    readonly skippedHeavyTests: readonly SuiteProgressEntry[];
    readonly stdoutLineCount: number;
    readonly stderrLineCount: number;
    readonly stdoutTail: readonly string[];
    readonly stderrTail: readonly string[];
    readonly excludedTestsSeen: Readonly<Record<string, boolean>>;
}

const TEST_TIMEOUT_MS: number = 60 * 60 * 1000;
const MAX_BUFFER_BYTES: number = 256 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const suiteScriptPath: string = join(repoRoot, "build", "Test-Linux", "RunSuite.js");
const defaultSummaryPath: string = join(repoRoot, "artifacts", "linux-suite-summary.json");
const excludedTestFileNames: readonly string[] = [
    "frontend-json-parity.test.js",
    "frontend-json-restore-fixture.test.js",
    "iw-frontend-json-compiler-smoke.test.js",
    "iw-frontend-json-external-scaffold.test.js",
    "iw-frontend-json-backend-smoke.test.js",
    "iw-frontend-json-fixture-check-smoke.test.js"
];

function parseSummaryPath(argv: readonly string[]): string {
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === "--summary-json") {
            const configuredPath: string | undefined = argv[index + 1];
            if (configuredPath === undefined || configuredPath.trim().length === 0) {
                throw new Error("RunSuiteWithSummary requires a non-empty path after --summary-json");
            }
            return resolve(configuredPath);
        }
    }
    return defaultSummaryPath;
}

function toOutputLines(output: string | null | undefined): string[] {
    return (output ?? "")
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
}

function collectExcludedTestHits(lines: readonly string[]): Readonly<Record<string, boolean>> {
    const joinedOutput: string = lines.join("\n");
    return Object.fromEntries(
        excludedTestFileNames.map((testFileName) => [testFileName, joinedOutput.includes(testFileName)])
    );
}

function collectFailedTestFileName(lines: readonly string[]): string | null {
    for (const line of lines) {
        const match: RegExpMatchArray | null = line.match(/linux-suite failed in (.+)$/);
        if (match !== null) {
            return match[1];
        }
    }
    return null;
}

function collectProgressEntries(lines: readonly string[], prefix: string): SuiteProgressEntry[] {
    const progressEntries: SuiteProgressEntry[] = [];
    const pattern: RegExp = new RegExp(`^linux-suite ${prefix} \\[(\\d+)\\/(\\d+)\\] (.+)$`);
    for (const line of lines) {
        const match: RegExpMatchArray | null = line.match(pattern);
        if (match === null) {
            continue;
        }
        progressEntries.push({
            index: Number.parseInt(match[1], 10),
            total: Number.parseInt(match[2], 10),
            testFileName: match[3]
        });
    }
    return progressEntries;
}

function collectTotalTestCount(lines: readonly string[]): number | null {
    for (const line of lines) {
        const match: RegExpMatchArray | null = line.match(/^linux-suite ok (\d+) tests$/);
        if (match !== null) {
            return Number.parseInt(match[1], 10);
        }
    }
    return null;
}

const summaryPath: string = parseSummaryPath(process.argv.slice(2));
const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [suiteScriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TEST_TIMEOUT_MS
});

const stdoutLines: string[] = toOutputLines(result.stdout);
const stderrLines: string[] = toOutputLines(result.stderr);
const combinedLines: string[] = [...stdoutLines, ...stderrLines];
const summary: SuiteSummary = {
    summaryPath,
    status: result.status ?? null,
    signal: result.signal ?? null,
    completionMarkerSeen: combinedLines.some((line) => /^linux-suite ok \d+ tests$/.test(line)),
    failedTestFileName: collectFailedTestFileName(combinedLines),
    totalTestCount: collectTotalTestCount(combinedLines),
    passedTests: collectProgressEntries(combinedLines, "passed"),
    skippedHeavyTests: collectProgressEntries(combinedLines, "skipped heavy"),
    stdoutLineCount: stdoutLines.length,
    stderrLineCount: stderrLines.length,
    stdoutTail: stdoutLines.slice(-80),
    stderrTail: stderrLines.slice(-80),
    excludedTestsSeen: collectExcludedTestHits(combinedLines)
};

mkdirSync(dirname(summaryPath), { recursive: true });
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

if (result.error !== undefined) {
    throw result.error;
}
process.exit(result.status ?? 1);