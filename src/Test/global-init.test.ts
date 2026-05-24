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

const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "global-init");
const abortFixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "global-init-typecheck");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];

const successCases: readonly SuccessCase[] = [
    {
        name: "static-primitive-and-union",
        entry: "test~global~init@main",
        expectedLines: ["42"]
    },
    {
        name: "conversions",
        entry: "test~global~init~conversions@main",
        expectedLines: ["6"]
    },
    {
        name: "logical-not",
        entry: "test~global~init~logical_not@main",
        expectedLines: ["4"]
    }
];

const abortCases: readonly AbortCase[] = [
    {
        name: "invalid-class-type",
        inputPath: join(abortFixtureDir, "test~global~init~invalid_class_type@main.iw"),
        expectedMessage: "must have a primitive type or a union containing at least one primitive member"
    },
    {
        name: "invalid-union-without-primitive",
        inputPath: join(abortFixtureDir, "test~global~init~invalid_union_without_primitive@main.iw"),
        expectedMessage: "must have a primitive type or a union containing at least one primitive member"
    },
    {
        name: "non-static-function-call",
        inputPath: join(abortFixtureDir, "test~global~init~non_static_function_call@main.iw"),
        expectedMessage: "is not part of the static primitive global initializer subset"
    },
    {
        name: "non-static-global-read",
        inputPath: join(abortFixtureDir, "test~global~init~non_static_global_read@main.iw"),
        expectedMessage: "is not a static primitive binding"
    },
    {
        name: "invalid-union-payload",
        inputPath: join(abortFixtureDir, "test~global~init~invalid_union_payload@main.iw"),
        expectedMessage: "is not part of the static primitive global initializer subset"
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
        process.stdout.write(`global-init ${successCase.name} ${run.label} ok\n`);
    }
}

for (const abortCase of abortCases) {
    try {
        execBuildJsonCliSync(cliPath, ["check", abortCase.inputPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
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
        const combinedOutput: string = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
        ok(
            combinedOutput.includes(abortCase.expectedMessage),
            `${abortCase.name} should mention '${abortCase.expectedMessage}', got output=${combinedOutput}`
        );
        process.stdout.write(`global-init-typecheck ${abortCase.name} ok\n`);
    }
}
