// Regression coverage for cross-package closures reading and mutating a top-level global var.

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
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "module-global-closure-capture");
const entryUnitId: string = "test~module~global~closure~capture~app@main";
const expectedExitCode: number = 63;

const runs: readonly BackendRun[] = [
    {
        label: "optimized-frontend c-backend",
        runArgs: ["--frontend-profile", "optimized", "--backend-profile", "c-backend"]
    },
    {
        label: "optimized-frontend optimized-x64-backend",
        runArgs: ["--frontend-profile", "optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "optimized-frontend no-optimized-backend",
        runArgs: ["--frontend-profile", "optimized", "--backend-profile", "no-optimized-backend"]
    },
    {
        label: "no-optimized-frontend c-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "c-backend"]
    },
    {
        label: "no-optimized-frontend optimized-x64-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-frontend no-optimized-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "no-optimized-backend"]
    }
];

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TEST_TIMEOUT_MS
});

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, [
        "run",
        fixtureDir,
        "--entry",
        entryUnitId,
        ...run.runArgs
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    assertRunResult(result, [], expectedExitCode, `${run.label} module-global-closure-capture`);
    process.stdout.write(`module-global-closure-capture ${run.label} ok\n`);
}