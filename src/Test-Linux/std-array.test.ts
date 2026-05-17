import { ok } from "assert";
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
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "std-array");
const abortInputPath = join(fixtureDir, "test~std~array~abort@main.iw");
const typecheckAbortInputPath = join(repoRoot, "src", "Test-Linux", "Fixtures", "std-array-typecheck", "test~std~array~class~abort_param_ctor@main.iw");
const ordAbortInputPath = join(fixtureDir, "test~std~array~ord~abort_empty@main.iw");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const successCases: readonly SuccessCase[] = [
    {
        name: "core",
        fileName: "test~std~array@main.iw",
        entry: "test~std~array@main",
        expectedLines: ["138"]
    },
    {
        name: "builder",
        fileName: "test~std~array~builder@main.iw",
        entry: "test~std~array~builder@main",
        expectedLines: ["24"]
    },
    {
        name: "class-fill",
        fileName: "test~std~array~class@main.iw",
        entry: "test~std~array~class@main",
        expectedLines: ["53536767"]
    },
    {
        name: "order-helpers",
        fileName: "test~std~array~ord@main.iw",
        entry: "test~std~array~ord@main",
        expectedLines: ["107"]
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
        process.stdout.write(`std-array ${successCase.name} ${run.label} ok\n`);
    }
}

for (const run of runs) {
    try {
        execBuildJsonCliSync(cliPath, ["run", abortInputPath, "--entry", "test~std~array~abort@main", ...run.runArgs], {
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
        process.stdout.write(`std-array-abort ${run.label} ok\n`);
    }
}

for (const run of runs) {
    try {
        execBuildJsonCliSync(cliPath, ["run", ordAbortInputPath, "--entry", "test~std~array~ord~abort_empty@main", ...run.runArgs], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        throw new Error(`${run.label} std-array empty max abort unexpectedly completed successfully`);
    } catch (error) {
        if (error instanceof Error && error.message.includes("unexpectedly completed successfully")) {
            throw error;
        }
        const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
        ok(
            execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
            `${run.label} std-array empty max abort should fail with a non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
        );
        ok(
            (execError.stderr ?? "").includes("Ironwall unreachable: exhaustive match failed at runtime"),
            `${run.label} std-array empty max abort should report the runtime abort message, got stderr=${execError.stderr ?? ""}`
        );
        process.stdout.write(`std-array-abort empty-max ${run.label} ok\n`);
    }
}

for (const run of runs) {
    try {
        execBuildJsonCliSync(cliPath, ["run", typecheckAbortInputPath, "--entry", "test~std~array~class~abort_param_ctor@main", ...run.runArgs], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        throw new Error(`${run.label} std-array class param-ctor abort unexpectedly completed successfully`);
    } catch (error) {
        if (error instanceof Error && error.message.includes("unexpectedly completed successfully")) {
            throw error;
        }
        const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
        ok(
            execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
            `${run.label} std-array class param-ctor abort should fail with a non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
        );
        const combinedOutput = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
        ok(
            combinedOutput.includes("zero-arg constructor"),
            `${run.label} std-array class param-ctor abort should mention zero-arg constructor, got output=${combinedOutput}`
        );
        process.stdout.write(`std-array-abort param-ctor ${run.label} ok\n`);
    }
}
