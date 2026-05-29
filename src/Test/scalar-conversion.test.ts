import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const TEST_TIMEOUT_MS: number =
    process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND !== undefined && process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND.trim().length > 0
        ? 120000
        : process.env.IW_TEST_TARGET === "windows-x64"
            ? 60000
        : 15000;

const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "scalar-conversion");
const entry: string = "test~scalar~conversion@main";
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

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: TEST_TIMEOUT_MS
});

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, ["run", fixtureDir, "--entry", entry, ...run.runArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: TEST_TIMEOUT_MS
    });

    assertRunResult(result, [], 20, run.label);
    process.stdout.write(`scalar-conversion ${run.label} ok\n`);
}
