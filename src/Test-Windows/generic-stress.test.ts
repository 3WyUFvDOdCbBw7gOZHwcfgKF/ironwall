// High-intensity generic regression coverage for helper resolution, traversal, concrete parity, and wrapper constraints.

import { ok } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

interface SuccessCase {
    readonly name: string;
    readonly entry: string;
    readonly expectedLines: readonly string[];
}

const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test-Windows", "Fixtures", "generic-stress");
const abortInputPath: string = join(repoRoot, "src", "Test-Windows", "Fixtures", "generic-stress-typecheck", "test~generic~stress~array_wrapper_abort@main.iw");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];

const successCases: readonly SuccessCase[] = [
    {
        name: "helpers-package",
        entry: "test~generic~stress~helpers@main",
        expectedLines: ["42"]
    },
    {
        name: "walk-loop",
        entry: "test~generic~stress~walk@main",
        expectedLines: ["60"]
    },
    {
        name: "control-flow",
        entry: "test~generic~stress~flow@main",
        expectedLines: ["42"]
    },
    {
        name: "imported-array-capture-f5",
        entry: "test~generic~stress~imported_array_capture_f5@main",
        expectedLines: ["10"]
    },
    {
        name: "nested-container",
        entry: "test~generic~stress~nested_container@main",
        expectedLines: ["210"]
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
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000
});

for (const successCase of successCases) {
    for (const run of runs) {
        const result = spawnBuildJsonCliSync(cliPath, [
            "run",
            fixtureDir,
            "--entry",
            successCase.entry,
            ...run.runArgs
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });

        assertRunResult(result, [], Number(successCase.expectedLines[0]) & 0xff, `${run.label} ${successCase.name}`);
        process.stdout.write(`generic-stress ${successCase.name} ${run.label} ok\n`);
    }
}

try {
    execBuildJsonCliSync(cliPath, ["check", abortInputPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });
    throw new Error("generic array wrapper abort unexpectedly typechecked successfully");
} catch (error) {
    if (error instanceof Error && error.message.includes("unexpectedly typechecked successfully")) {
        throw error;
    }
    const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
    ok(
        execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
        `generic array wrapper abort should fail typechecking with non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
    );
    const combinedOutput: string = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
    ok(
        combinedOutput.includes("zero-arg constructor"),
        `generic array wrapper abort should mention zero-arg constructor, got output=${combinedOutput}`
    );
    process.stdout.write("generic-stress abort array-wrapper ok\n");
}
