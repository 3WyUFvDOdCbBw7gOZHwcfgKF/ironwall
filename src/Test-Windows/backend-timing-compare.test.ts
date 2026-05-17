// End-to-end backend timing comparison across stable real workloads.

import { deepStrictEqual, strictEqual } from "assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { assertExpectedExitCode, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

interface TimedRunResult {
    readonly label: string;
    readonly samplesMs: readonly number[];
    readonly elapsedMs: number;
}

const TIMING_SAMPLE_COUNT: number = 3;
const TEST_TIMEOUT_MS: number = 120000;
const MAX_BUFFER_BYTES: number = 64 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];

const runs: readonly BackendRun[] = [
    {
        label: "c-backend",
        runArgs: ["--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        runArgs: [...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        runArgs: [...x64FrontendArgs, "--backend-profile", "no-optimized-backend"]
    }
];

const backendTimingFixtureDir: string = join(repoRoot, "src", "Test-Windows", "Fixtures", "backend-timing");
const backendTimingExpectedExitCode: number = 120;

const appDir: string = join(repoRoot, "src", "Test-Windows", "Fixtures", "app-log-audit");
const artifactDir: string = join(repoRoot, "artifacts", "app-log-audit");
const inputPath: string = join(artifactDir, "input.log");
const reportsDir: string = join(artifactDir, "reports");
const scratchDir: string = join(reportsDir, "staging");
const markerPath: string = join(scratchDir, "marker.tmp");
const summaryTmpPath: string = join(scratchDir, "summary.tmp");
const summaryPath: string = join(reportsDir, "summary.txt");
const statusTmpPath: string = join(scratchDir, "status.tmp");
const statusPath: string = join(reportsDir, "status.txt");
const appInputLines: readonly string[] = [
    "ERROR auth login_failed user=alice session=s1",
    "WARN auth password_expiring user=bob session=s2",
    "INFO deploy started service=api session=s3",
    "ERROR auth login_failed user=alice session=s1",
    "INFO deploy finished service=api session=s3",
    "WARN ops disk_near_full host=db1 session=s4",
    "ERROR ops disk_full host=db1 session=s4"
];
const appInputText: string = `${appInputLines.join("\n")}\n`;
const appInputBytes: number = Buffer.byteLength(appInputText, "utf8");
const appExpectedStdoutLines: readonly string[] = ["log-audit ok", "errors=3 warnings=2 deploys=2"];
const appExpectedSummary: string = [
    "state: ready",
    `input-bytes=${appInputBytes}`,
    "total-lines=7",
    "error-events=3",
    "warning-events=2",
    "deploy-events=2",
    "pread-offset-ok=yes",
    "pwrite-offset-ok=yes",
    "child-status-ok=yes",
    "",
    "== metric order ==",
    "ERROR ",
    "warning-events=",
    "deploy",
    "== active alerts ==",
    "login_failed",
    "disk_full",
    "password_expiring",
    "deploy started",
    "deploy finished",
    "== highlights ==",
    "ERROR ",
    "warning-events=",
    "deploy",
    "deploy finished",
    "deploy started",
    "password_expiring",
    "disk_full",
    "login_failed",
    ""
].join("\n");
const appExpectedStatus: string = "LOG_AUDIT_OK\nwait-status=0\nchild-newline=yes\n";

function normalizeLines(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0);
}

function runCliAndMeasure(args: readonly string[]): { readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly output: string; readonly stderr: string; readonly elapsedMs: number } {
    const startNs: bigint = process.hrtime.bigint();
    const result = spawnBuildJsonCliSync(cliPath, [...args], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    const endNs: bigint = process.hrtime.bigint();
    return {
        status: result.status,
        signal: result.signal,
        output: result.stdout,
        stderr: result.stderr,
        elapsedMs: Number(endNs - startNs) / 1_000_000
    };
}

function medianElapsedMs(samplesMs: readonly number[]): number {
    const sortedSamples: number[] = [...samplesMs].sort((left: number, right: number) => left - right);
    return sortedSamples[Math.floor(sortedSamples.length / 2)];
}

function printTimingSummary(workloadLabel: string, results: readonly TimedRunResult[]): void {
    const baseline: TimedRunResult | undefined = results.find((result: TimedRunResult) => result.label === "c-backend");
    for (const result of results) {
        let suffix: string = "";
        if (baseline) {
            const ratio: number = result.elapsedMs / baseline.elapsedMs;
            suffix = ` ratio_vs_c=${ratio.toFixed(2)}`;
        }
        const sampleSummary: string = result.samplesMs.map((sample: number) => sample.toFixed(2)).join(",");
        process.stdout.write(
            `backend-timing ${workloadLabel} ${result.label} median_ms=${result.elapsedMs.toFixed(2)} samples_ms=[${sampleSummary}]${suffix}\n`
        );
    }
}

function verifyBackendTimingWorkload(): void {
    execBuildJsonCliSync(cliPath, ["check", backendTimingFixtureDir], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    const timingResults: TimedRunResult[] = [];
    for (const run of runs) {
        const samplesMs: number[] = [];
        let sampleIndex: number = 0;
        while (sampleIndex < TIMING_SAMPLE_COUNT) {
            const measured = runCliAndMeasure([
                "run",
                backendTimingFixtureDir,
                "--entry",
                "test~backend~timing@main",
                ...run.runArgs
            ]);
            strictEqual(measured.signal, null, `${run.label} backend-timing signal mismatch\nstdout:\n${measured.output}\nstderr:\n${measured.stderr}`);
            assertExpectedExitCode(measured.status, backendTimingExpectedExitCode, `${run.label} backend-timing exit code mismatch\nstdout:\n${measured.output}\nstderr:\n${measured.stderr}`);
            strictEqual(measured.output, "", `${run.label} backend-timing should not print main return value\n${measured.output}`);
            strictEqual(measured.stderr, "", `${run.label} backend-timing stderr mismatch\n${measured.stderr}`);
            samplesMs.push(measured.elapsedMs);
            sampleIndex += 1;
        }
        timingResults.push({
            label: run.label,
            samplesMs,
            elapsedMs: medianElapsedMs(samplesMs)
        });
    }
    printTimingSummary("backend-timing", timingResults);
}

function prepareAppArtifacts(): void {
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(inputPath, appInputText, "utf8");
}

function verifyAppArtifacts(): void {
    strictEqual(readFileSync(summaryPath, "utf8"), appExpectedSummary);
    strictEqual(readFileSync(statusPath, "utf8"), appExpectedStatus);
    strictEqual(existsSync(reportsDir), true);
    strictEqual(existsSync(scratchDir), false);
    strictEqual(existsSync(markerPath), false);
    strictEqual(existsSync(summaryTmpPath), false);
    strictEqual(existsSync(statusTmpPath), false);
}

function verifyAppLogAuditWorkload(): void {
    execBuildJsonCliSync(cliPath, ["check", appDir], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    const timingResults: TimedRunResult[] = [];
    for (const run of runs) {
        const samplesMs: number[] = [];
        let sampleIndex: number = 0;
        while (sampleIndex < TIMING_SAMPLE_COUNT) {
            prepareAppArtifacts();
            const measured = runCliAndMeasure([
                "run",
                appDir,
                "--entry",
                "app~log~audit@main",
                ...run.runArgs
            ]);
            strictEqual(measured.signal, null, `${run.label} app-log-audit signal mismatch\nstdout:\n${measured.output}\nstderr:\n${measured.stderr}`);
            strictEqual(measured.status, 0, `${run.label} app-log-audit exit code mismatch\nstdout:\n${measured.output}\nstderr:\n${measured.stderr}`);
            deepStrictEqual(normalizeLines(measured.output), appExpectedStdoutLines, `${run.label} app-log-audit stdout mismatch\n${measured.output}`);
            strictEqual(measured.stderr, "", `${run.label} app-log-audit stderr mismatch\n${measured.stderr}`);
            verifyAppArtifacts();
            samplesMs.push(measured.elapsedMs);
            sampleIndex += 1;
        }
        timingResults.push({
            label: run.label,
            samplesMs,
            elapsedMs: medianElapsedMs(samplesMs)
        });
    }
    printTimingSummary("app-log-audit", timingResults);
}

verifyBackendTimingWorkload();
verifyAppLogAuditWorkload();
