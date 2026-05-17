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
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "std-string");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const successCases: readonly SuccessCase[] = [
    {
        name: "s3-len",
        fileName: "test~std~string@main.iw",
        entry: "test~std~string@main",
        expectedLines: ["24"]
    },
    {
        name: "s4-len",
        fileName: "test~std~string@s4_main.iw",
        entry: "test~std~string@s4_main",
        expectedLines: ["24"]
    },
    {
        name: "s5-len",
        fileName: "test~std~string@s5_main.iw",
        entry: "test~std~string@s5_main",
        expectedLines: ["24"]
    },
    {
        name: "s3-ops",
        fileName: "test~std~string~ops@main.iw",
        entry: "test~std~string~ops@main",
        expectedLines: ["14"]
    },
    {
        name: "s4-ops",
        fileName: "test~std~string~ops@s4_main.iw",
        entry: "test~std~string~ops@s4_main",
        expectedLines: ["14"]
    },
    {
        name: "s5-ops",
        fileName: "test~std~string~ops@s5_main.iw",
        entry: "test~std~string~ops@s5_main",
        expectedLines: ["14"]
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
    for (const run of runs) {
        const result = spawnBuildJsonCliSync(cliPath, ["run", fixtureDir, "--entry", successCase.entry, ...run.runArgs], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        assertRunResult(result, [], Number(successCase.expectedLines[0]) & 0xff, `${run.label} ${successCase.name}`);
        process.stdout.write(`std-string ${successCase.name} ${run.label} ok\n`);
    }
}
