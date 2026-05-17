// High-intensity regression coverage for seq-local-var scope equivalence versus explicit let nesting.

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
const fixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "seq-var-scope");
const abortFixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "seq-var-scope-typecheck");

const successCases: readonly SuccessCase[] = [
    {
        name: "seq-leading-vars",
        entry: "test~seq~var~scope~seq@main",
        expectedLines: ["3847"]
    },
    {
        name: "explicit-let-equivalent",
        entry: "test~seq~var~scope~let@main",
        expectedLines: ["3847"]
    }
];

const abortCases: readonly AbortCase[] = [
    {
        name: "seq-mutual-recursion",
        inputPath: join(abortFixtureDir, "test~seq~var~scope~seq~mutual_abort@main.iw"),
        expectedMessage: "Undefined variable: oddish"
    },
    {
        name: "seq-self-recursion",
        inputPath: join(abortFixtureDir, "test~seq~var~scope~seq~self_abort@main.iw"),
        expectedMessage: "Undefined variable: countdown"
    },
    {
        name: "let-mutual-recursion",
        inputPath: join(abortFixtureDir, "test~seq~var~scope~let~mutual_abort@main.iw"),
        expectedMessage: "Undefined variable: oddish"
    },
    {
        name: "let-self-recursion",
        inputPath: join(abortFixtureDir, "test~seq~var~scope~let~self_abort@main.iw"),
        expectedMessage: "Undefined variable: countdown"
    },
    {
        name: "seq-forward-c-scope",
        inputPath: join(abortFixtureDir, "test~seq~var~scope~seq~forward_c_abort@main.iw"),
        expectedMessage: "Undefined variable: c"
    }
];

const runs: readonly BackendRun[] = [
    {
        label: "optimized-frontend c-backend",
        runArgs: ["--frontend-profile", "optimized", "--backend-profile", "c-backend"]
    },
    {
        label: "optimized-frontend optimized-x64-backend",
        runArgs: ["--frontend-profile", "optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "optimized-frontend no-optimized-backend",
        runArgs: ["--frontend-profile", "optimized", "--backend-profile", "no-optimized-backend"]
    },
    {
        label: "no-optimized-frontend c-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "c-backend"]
    },
    {
        label: "no-optimized-frontend optimized-x64-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-frontend no-optimized-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "no-optimized-backend"]
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
        process.stdout.write(`seq-var-scope ${successCase.name} ${run.label} ok\n`);
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
        if (!(error instanceof Error)) {
            throw new Error(`${abortCase.name} failed with a non-Error value`);
        }
        const execError: Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string } = error;
        ok(
            execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
            `${abortCase.name} should fail typechecking with non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
        );
        const combinedOutput: string = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
        ok(
            combinedOutput.includes(abortCase.expectedMessage),
            `${abortCase.name} should mention '${abortCase.expectedMessage}', got output=${combinedOutput}`
        );
        process.stdout.write(`seq-var-scope-typecheck ${abortCase.name} ok\n`);
    }
}
