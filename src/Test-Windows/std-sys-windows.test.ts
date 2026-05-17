import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface FixtureCase {
    readonly label: string;
    readonly entry: string;
    readonly expectedExitCode: number;
    readonly programArgs?: readonly string[];
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

const cases: readonly FixtureCase[] = [
    {
        label: "env-platform-time",
        entry: "test~std~sys~windows~env_platform_time@main",
        expectedExitCode: 6
    },
    {
        label: "event-wait",
        entry: "test~std~sys~windows~event_wait@main",
        expectedExitCode: 7
    },
    {
        label: "net-loopback-shutdown",
        entry: "test~std~sys~windows~net_loopback_shutdown@main",
        expectedExitCode: 4
    },
    {
        label: "argv-path",
        entry: "test~std~sys~windows~argv_path@main",
        expectedExitCode: 11,
        programArgs: ["aa", "bbbb", "z"]
    },
    {
        label: "process-thread-ids",
        entry: "test~std~sys~windows~process_thread_ids@main",
        expectedExitCode: 4
    },
    {
        label: "process-exit",
        entry: "test~std~sys~windows~process_exit@main",
        expectedExitCode: 41
    },
    {
        label: "cwd-chdir",
        entry: "test~std~sys~windows~cwd_chdir@main",
        expectedExitCode: 3
    },
    {
        label: "file-handles",
        entry: "test~std~sys~windows~file_handles@main",
        expectedExitCode: 11
    },
    {
        label: "fd-seek-stat",
        entry: "test~std~sys~windows~fd_seek_stat@main",
        expectedExitCode: 11
    },
    {
        label: "spawn-wait-kill",
        entry: "test~std~sys~windows~spawn_wait_kill@main",
        expectedExitCode: 4
    },
    {
        label: "dir-iterate",
        entry: "test~std~sys~windows~dir_iterate@main",
        expectedExitCode: 3
    },
    {
        label: "spawn-stdio",
        entry: "test~std~sys~windows~spawn_stdio@main",
        expectedExitCode: 5
    },
    {
        label: "net-misc",
        entry: "test~std~sys~windows~net_misc@main",
        expectedExitCode: 6
    },
];

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

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TEST_TIMEOUT_MS
});

for (const fixtureCase of cases) {
    for (const run of runs) {
        const result = spawnBuildJsonCliSync(cliPath, [
            "run",
            fixtureDir,
            "--entry",
            fixtureCase.entry,
            ...run.runArgs,
            ...(fixtureCase.programArgs === undefined ? [] : ["--", ...fixtureCase.programArgs])
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });

        assertRunResult(result, [], fixtureCase.expectedExitCode, `${fixtureCase.label} ${run.label}`);
        process.stdout.write(`std-sys-windows ${fixtureCase.label} ${run.label} ok\n`);
    }
}