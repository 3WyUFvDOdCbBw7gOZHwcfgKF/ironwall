import { join, resolve } from "path";
import { assertRunResult, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly args: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Windows", "Fixtures", "fft-bigint");
const expectedLines = [
    "fft_0008_ok",
    "fft_0016_ok",
    "fft_0032_ok",
    "fft_0064_ok",
    "fft_f6_0064_ok",
    "fft_f7_0065_ok"
];
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const runs: readonly BackendRun[] = [
    {
        label: "c-backend",
        args: ["run", fixtureDir, "--entry", "test~fft~bigint@main", "--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        args: ["run", fixtureDir, "--entry", "test~fft~bigint@main", ...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        args: ["run", fixtureDir, "--entry", "test~fft~bigint@main", ...x64FrontendArgs, "--backend-profile", "no-optimized-backend"]
    }
];

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, [...run.args], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120000
    });

    assertRunResult(result, expectedLines, 0, run.label);
    process.stdout.write(`fft-bigint ${run.label} ok\n`);
}
