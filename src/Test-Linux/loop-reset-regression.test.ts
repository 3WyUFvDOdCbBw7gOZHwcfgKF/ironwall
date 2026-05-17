import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "loop-reset-regression");
const inputPath = join(fixtureDir, "test~loop~reset~regression@main.iw");
const entry = "test~loop~reset~regression@main";

const runs: readonly BackendRun[] = [
    {
        label: "optimized c-backend",
        runArgs: ["--backend-profile", "c-backend"]
    },
    {
        label: "optimized no-optimized-backend",
        runArgs: ["--backend-profile", "no-optimized-backend"]
    },
    {
        label: "optimized optimized-x64-backend",
        runArgs: ["--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized c-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "c-backend"]
    }
];

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
});

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, ["run", inputPath, "--entry", entry, ...run.runArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });

    assertRunResult(result, [], 6, run.label);
    process.stdout.write(`loop-reset-regression ${run.label} ok\n`);
}
