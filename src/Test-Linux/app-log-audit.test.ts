import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { strictEqual } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const TEST_TIMEOUT_MS: number = 15000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const appDir: string = join(repoRoot, "src", "examples", "log-audit");
const artifactDir: string = join(repoRoot, "src", "examples", "log-audit", "runtime");
const inputPath: string = join(artifactDir, "input.log");
const reportsDir: string = join(artifactDir, "reports");
const scratchDir: string = join(reportsDir, "staging");
const markerPath: string = join(scratchDir, "marker.tmp");
const summaryTmpPath: string = join(scratchDir, "summary.tmp");
const summaryPath: string = join(reportsDir, "summary.txt");
const statusTmpPath: string = join(scratchDir, "status.tmp");
const statusPath: string = join(reportsDir, "status.txt");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];

const inputLines: readonly string[] = [
    "ERROR auth login_failed user=alice session=s1",
    "WARN auth password_expiring user=bob session=s2",
    "INFO deploy started service=api session=s3",
    "ERROR auth login_failed user=alice session=s1",
    "INFO deploy finished service=api session=s3",
    "WARN ops disk_near_full host=db1 session=s4",
    "ERROR ops disk_full host=db1 session=s4"
];
const inputText: string = `${inputLines.join("\n")}\n`;
const inputBytes: number = Buffer.byteLength(inputText, "utf8");
const expectedSummary: string = [
    "state: ready",
    `input-bytes=${inputBytes}`,
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
const expectedStatus: string = "LOG_AUDIT_OK\nwait-status=0\nchild-newline=yes\n";
const expectedStdoutLines: readonly string[] = ["log-audit ok", "errors=3 warnings=2 deploys=2"];

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

function prepareArtifacts(): void {
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(inputPath, inputText, "utf8");
}

function verifyArtifacts(): void {
    strictEqual(readFileSync(summaryPath, "utf8"), expectedSummary);
    strictEqual(readFileSync(statusPath, "utf8"), expectedStatus);
    strictEqual(existsSync(reportsDir), true);
    strictEqual(existsSync(scratchDir), false);
    strictEqual(existsSync(markerPath), false);
    strictEqual(existsSync(summaryTmpPath), false);
    strictEqual(existsSync(statusTmpPath), false);
}

execBuildJsonCliSync(cliPath, ["check", appDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TEST_TIMEOUT_MS
});

for (const run of runs) {
    prepareArtifacts();
    const result = spawnBuildJsonCliSync(cliPath, [
        "run",
        appDir,
        "--entry",
        "app~log~audit@main",
        ...run.runArgs
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    assertRunResult(result, expectedStdoutLines, 0, run.label);
    verifyArtifacts();
    process.stdout.write(`app-log-audit ${run.label} ok\n`);
}
