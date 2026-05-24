import { mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "../Test/BuildJsonCliHarness";

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
const fixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "std-sys-policy");
const sharedSysLibPath: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "std-sys", "test~std~sys~lib@defs.iw");
const fixtureInputArgs: readonly string[] = [fixtureDir, "--include", sharedSysLibPath];
const artifactDir: string = join(repoRoot, "artifacts", "std-sys-policy");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];
const TEST_TIMEOUT_MS: number = 120000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const caseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    IRONWALL_STD_SYS_ENV_CASE: "linux-case"
};

const cases: readonly FixtureCase[] = [
    {
        label: "env-platform-time",
        entry: "test~std~sys~linux~env_platform_time@main",
        expectedExitCode: 5
    },
    {
        label: "argv-path",
        entry: "test~std~sys~linux~argv_path@main",
        expectedExitCode: 11,
        programArgs: ["aa", "bbbb", "z"]
    },
    {
        label: "dir-iterate",
        entry: "test~std~sys~linux~dir_iterate@main",
        expectedExitCode: 3
    },
    {
        label: "aliases-misc",
        entry: "test~std~sys~linux~aliases_misc@main",
        expectedExitCode: 38
    },
    {
        label: "spawn-processes",
        entry: "test~std~sys~linux~spawn_processes@main",
        expectedExitCode: 9
    },
    {
        label: "socket-loopback",
        entry: "test~std~sys~linux~socket_loopback@main",
        expectedExitCode: 4
    },
    {
        label: "accept4-loopback",
        entry: "test~std~sys~linux~accept4_loopback@main",
        expectedExitCode: 6
    },
    {
        label: "epoll-loopback",
        entry: "test~std~sys~linux~epoll_loopback@main",
        expectedExitCode: 7
    },
    {
        label: "signalfd-epoll-sigchld",
        entry: "test~std~sys~linux~signalfd_epoll_sigchld@main",
        expectedExitCode: 8
    }
];

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

function prepareArtifactDir(): void {
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
}

prepareArtifactDir();

execBuildJsonCliSync(cliPath, ["check", ...fixtureInputArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TEST_TIMEOUT_MS,
    env: caseEnv
});

for (const fixtureCase of cases) {
    for (const run of runs) {
        const result = spawnBuildJsonCliSync(cliPath, [
            "run",
            ...fixtureInputArgs,
            "--entry",
            fixtureCase.entry,
            ...run.runArgs,
            ...(fixtureCase.programArgs === undefined ? [] : ["--", ...fixtureCase.programArgs])
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS,
            env: caseEnv
        });

        assertRunResult(result, [], fixtureCase.expectedExitCode, `${fixtureCase.label} ${run.label}`);
        process.stdout.write(`std-sys-policy ${fixtureCase.label} ${run.label} ok\n`);
    }
}
