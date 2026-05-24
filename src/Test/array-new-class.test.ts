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

interface AbortCase {
    readonly name: string;
    readonly inputPath: string;
    readonly expectedMessage: string;
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "array-new-class");
const abortFixturePath = join(repoRoot, "src", "Test", "Fixtures", "array-new-class-abort", "test~array~new~class~abort_param_ctor@main.iw");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const successCases: readonly SuccessCase[] = [
    {
        name: "default-constructor-fresh",
        entry: "test~array~new~class@main",
        expectedLines: ["17991717"]
    },
    {
        name: "generic-default-constructor-fresh",
        entry: "test~array~new~class~generic@main",
        expectedLines: ["772323"]
    },
    {
        name: "zero-length",
        entry: "test~array~new~class~zero_len@main",
        expectedLines: ["6644"]
    },
    {
        name: "zero-arg-builtins-and-nested-arrays",
        entry: "test~array~new~class~zero_arg_builtin@main",
        expectedLines: ["262143"]
    }
];

const abortCases: readonly AbortCase[] = [
    {
        name: "param-constructor-rejected",
        inputPath: abortFixturePath,
        expectedMessage: "zero-arg constructor"
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
        process.stdout.write(`array-new-class ${successCase.name} ${run.label} ok\n`);
    }
}

for (const abortCase of abortCases) {
    try {
        execBuildJsonCliSync(cliPath, ["check", abortCase.inputPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        throw new Error(`${abortCase.name} unexpectedly typechecked successfully`);
    } catch (error) {
        if (error instanceof Error && error.message.includes("unexpectedly typechecked successfully")) {
            throw error;
        }
        const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
        ok(
            execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
            `${abortCase.name} should fail typechecking with non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
        );
        const combinedOutput = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
        ok(
            combinedOutput.includes(abortCase.expectedMessage),
            `${abortCase.name} should mention '${abortCase.expectedMessage}', got output=${combinedOutput}`
        );
        process.stdout.write(`array-new-class-abort ${abortCase.name} ok\n`);
    }
}
