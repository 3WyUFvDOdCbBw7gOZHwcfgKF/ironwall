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
    readonly expectedExitCode: number;
}

interface AbortCase {
    readonly name: string;
    readonly inputPath: string;
    readonly expectedMessage: string;
}

const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "public-visibility");
const abortFixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "public-visibility-typecheck");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];

const successCases: readonly SuccessCase[] = [
    {
        name: "source-public-members",
        entry: "test~public~visibility~app@main",
        expectedExitCode: 41
    }
];

const abortCases: readonly AbortCase[] = [
    {
        name: "private-property-read",
        inputPath: join(abortFixtureDir, "test~public~visibility~private_property_read@main.iw"),
        expectedMessage: "Member hidden is private in class"
    },
    {
        name: "private-property-write",
        inputPath: join(abortFixtureDir, "test~public~visibility~private_property_write@main.iw"),
        expectedMessage: "Property hidden is private in class"
    },
    {
        name: "private-method-call",
        inputPath: join(abortFixtureDir, "test~public~visibility~private_method_call@main.iw"),
        expectedMessage: "Member read_hidden is private in class"
    },
    {
        name: "generic-private-property-read",
        inputPath: join(abortFixtureDir, "test~public~visibility~generic_private_property_read@main.iw"),
        expectedMessage: "Member hidden is private in generic class"
    },
    {
        name: "public-outside-class",
        inputPath: join(abortFixtureDir, "test~public~visibility~outside_class@main.iw"),
        expectedMessage: "public declarations must appear inside class bodies"
    },
    {
        name: "public-arity-zero",
        inputPath: join(abortFixtureDir, "test~public~visibility~public_arity_zero@main.iw"),
        expectedMessage: "public expects exactly one argument"
    },
    {
        name: "public-arity-many",
        inputPath: join(abortFixtureDir, "test~public~visibility~public_arity_many@main.iw"),
        expectedMessage: "public expects exactly one argument"
    },
    {
        name: "public-wrap-constructor",
        inputPath: join(abortFixtureDir, "test~public~visibility~public_wrap_constructor@main.iw"),
        expectedMessage: "constructors are always public and cannot be wrapped in public"
    },
    {
        name: "public-wrap-expression",
        inputPath: join(abortFixtureDir, "test~public~visibility~public_wrap_expression@main.iw"),
        expectedMessage: "public may only wrap class properties and methods"
    },
    {
        name: "public-wrap-public",
        inputPath: join(abortFixtureDir, "test~public~visibility~public_wrap_public@main.iw"),
        expectedMessage: "public cannot wrap public"
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

        assertRunResult(result, [], successCase.expectedExitCode & 0xff, `${run.label} ${successCase.name}`);
        process.stdout.write(`public-visibility ${successCase.name} ${run.label} ok\n`);
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
        process.stdout.write(`public-visibility-typecheck ${abortCase.name} ok\n`);
    }
}