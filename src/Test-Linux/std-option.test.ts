import { ok } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "std-option");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const runs: readonly BackendRun[] = [
    {
        label: "c-backend",
        runArgs: ["run", fixtureDir, "--entry", "test~std~option@main", "--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        runArgs: ["run", fixtureDir, "--entry", "test~std~option@main", ...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        runArgs: ["run", fixtureDir, "--entry", "test~std~option@main", ...x64FrontendArgs, "--backend-profile", "no-optimized-backend"]
    }
];

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
});

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, [...run.runArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    assertRunResult(result, [], 3158 & 0xff, `${run.label} success`);
    process.stdout.write(`std-option ${run.label} ok\n`);
}

for (const run of runs) {
    const abortArgs = [...run.runArgs];
    abortArgs[3] = "test~std~option~abort@main";
    try {
        execBuildJsonCliSync(cliPath, [...abortArgs], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        throw new Error(`${run.label} abort entry unexpectedly completed successfully`);
    } catch (error) {
        if (error instanceof Error && error.message.includes("unexpectedly completed successfully")) {
            throw error;
        }
        const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
        ok(
            execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
            `${run.label} abort entry should fail with a non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
        );
        ok(
            (execError.stderr ?? "").includes("Ironwall unreachable: exhaustive match failed at runtime"),
            `${run.label} abort entry should report the runtime abort message, got stderr=${execError.stderr ?? ""}`
        );
        process.stdout.write(`std-option-abort ${run.label} ok\n`);
    }
}
