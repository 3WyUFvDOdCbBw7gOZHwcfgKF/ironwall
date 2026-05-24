import { join, resolve } from "path";
import { assertRunResult, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly args: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "std-support-layer");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const runs: readonly BackendRun[] = [
    {
        label: "c-backend",
        args: ["run", fixtureDir, "--entry", "test~std~support_layer@main", "--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        args: ["run", fixtureDir, "--entry", "test~std~support_layer@main", ...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        args: ["run", fixtureDir, "--entry", "test~std~support_layer@main", ...x64FrontendArgs, "--backend-profile", "no-optimized-backend"]
    }
];

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, [...run.args], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    assertRunResult(result, [], 275 & 0xff, run.label);
    process.stdout.write(`std-support-layer ${run.label} ok\n`);
}
