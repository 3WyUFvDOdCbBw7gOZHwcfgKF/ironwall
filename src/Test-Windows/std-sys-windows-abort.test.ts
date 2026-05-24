import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { spawnBuildJsonCliSync } from "../Test/BuildJsonCliHarness";

interface AbortCase {
    readonly label: string;
    readonly entry: string;
    readonly expectedStderrFragment?: string;
}

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test-Windows", "Fixtures", "std-sys-windows");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];
const TEST_TIMEOUT_MS: number = 120000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;

const runs: readonly BackendRun[] = [
    {
        label: "optimized-x64-backend",
        runArgs: [...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        runArgs: [...x64FrontendArgs, "--backend-profile", "no-optimized-backend"]
    }
];

const abortCases: readonly AbortCase[] = [
    {
        label: "process-abort",
        entry: "test~std~sys~windows~abort@main"
    },
    {
        label: "invalid-handle-kind",
        entry: "test~std~sys~windows~invalid_handle_kind@main",
        expectedStderrFragment: "sys_wait_one"
    }
];

for (const abortCase of abortCases) {
    for (const run of runs) {
        const result = spawnBuildJsonCliSync(cliPath, ["run", fixtureDir, "--entry", abortCase.entry, ...run.runArgs], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        strictEqual(result.signal, null, `${abortCase.label} ${run.label} abort signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        ok(result.status !== null && result.status !== 0, `${abortCase.label} ${run.label} abort should exit non-zero\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        if (abortCase.expectedStderrFragment !== undefined) {
            ok(result.stderr.includes(abortCase.expectedStderrFragment), `${abortCase.label} ${run.label} stderr should mention '${abortCase.expectedStderrFragment}'\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        process.stdout.write(`std-sys-windows-abort ${abortCase.label} ${run.label} ok\n`);
    }
}