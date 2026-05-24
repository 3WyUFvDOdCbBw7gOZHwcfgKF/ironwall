import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

interface SuccessCase {
    readonly name: string;
    readonly fileName: string;
    readonly entry: string;
    readonly expectedLines: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "std-hof");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const successCases: readonly SuccessCase[] = [
    {
        name: "core",
        fileName: "test~std~hof@main.iw",
        entry: "test~std~hof@main",
        expectedLines: ["193"]
    },
    {
        name: "stress",
        fileName: "test~std~hof~stress@main.iw",
        entry: "test~std~hof~stress@main",
        expectedLines: ["4345"]
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

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
});

for (const successCase of successCases) {
    const inputPath = join(fixtureDir, successCase.fileName);
    for (const run of runs) {
        const result = spawnBuildJsonCliSync(cliPath, ["run", inputPath, "--entry", successCase.entry, ...run.runArgs], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        assertRunResult(result, [], Number(successCase.expectedLines[0]) & 0xff, `${run.label} ${successCase.name}`);
        process.stdout.write(`std-hof ${successCase.name} ${run.label} ok\n`);
    }
}
