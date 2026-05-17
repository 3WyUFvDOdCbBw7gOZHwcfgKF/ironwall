// Regression coverage for imported-package top-level global var_set on a union global that can hold nested class payloads.

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
const fixtureDir: string = join(repoRoot, "src", "Test-Windows", "Fixtures", "module-global-var-set");
const entryUnitId: string = "test~module~global~var~set~app@main";
const expectedLines: readonly string[] = ["100"];

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

    assertRunResult(result, [], Number(expectedLines[0]) & 0xff, `${run.label} module-global-var-set`);
    process.stdout.write(`module-global-var-set ${run.label} ok\n`);
}
