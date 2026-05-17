import { ok } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

interface InvalidCase {
    readonly label: string;
    readonly inputPath: string;
    readonly expectedMessage: string;
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Windows", "Fixtures", "builtin-ops");
const positiveInputPath = join(fixtureDir, "test~builtin~ops@main.iw");

const runs: readonly BackendRun[] = [
    {
        label: "optimized-frontend c-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~builtin~ops@main", "--frontend-profile", "optimized", "--backend-profile", "c-backend"]
    },
    {
        label: "optimized-frontend optimized-x64-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~builtin~ops@main", "--frontend-profile", "optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "optimized-frontend no-optimized-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~builtin~ops@main", "--frontend-profile", "optimized", "--backend-profile", "no-optimized-backend"]
    },
    {
        label: "no-optimized-frontend c-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~builtin~ops@main", "--frontend-profile", "no-optimized", "--backend-profile", "c-backend"]
    },
    {
        label: "no-optimized-frontend optimized-x64-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~builtin~ops@main", "--frontend-profile", "no-optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-frontend no-optimized-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~builtin~ops@main", "--frontend-profile", "no-optimized", "--backend-profile", "no-optimized-backend"]
    }
];

const invalidCases: readonly InvalidCase[] = [
    {
        label: "bwand-f5",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_bwand_f5@main.iw"),
        expectedMessage: "Type mismatch: expected i5, got f5"
    },
    {
        label: "ls-f6",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_ls_f6@main.iw"),
        expectedMessage: "Type mismatch: expected i5, got f6"
    },
    {
        label: "rs-f7",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_rs_f7@main.iw"),
        expectedMessage: "Type mismatch: expected i5, got f7"
    },
    {
        label: "xor-i5",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_xor_i5@main.iw"),
        expectedMessage: "Type mismatch: expected bool, got i5"
    },
    {
        label: "not-i5",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_not_i5@main.iw"),
        expectedMessage: "Type mismatch: expected bool, got i5"
    },
    {
        label: "not-arity2",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_not_arity2@main.iw"),
        expectedMessage: "Function not expects 1 arguments, got 2"
    },
    {
        label: "var-set-value",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_var_set_value@main.iw"),
        expectedMessage: "Type mismatch: expected i5, got unit"
    },
    {
        label: "array-set-value",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_array_set_value@main.iw"),
        expectedMessage: "Type mismatch: expected i5, got unit"
    },
    {
        label: "cm-set-value",
        inputPath: join(fixtureDir, "test~builtin~ops~invalid_cm_set_value@main.iw"),
        expectedMessage: "Type mismatch: expected i5, got unit"
    }
];

execBuildJsonCliSync(cliPath, ["check", positiveInputPath], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000
});

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, [...run.runArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });

    assertRunResult(result, [], 137, run.label);
    process.stdout.write(`builtin-ops ${run.label} ok\n`);
}

for (const invalidCase of invalidCases) {
    try {
        execBuildJsonCliSync(cliPath, ["check", invalidCase.inputPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });
        throw new Error(`${invalidCase.label} unexpectedly passed type checking`);
    } catch (error) {
        if (error instanceof Error && error.message.includes("unexpectedly passed type checking")) {
            throw error;
        }
        const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
        ok(
            execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
            `${invalidCase.label} should fail with a non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
        );
        ok(
            (execError.stderr ?? "").includes(invalidCase.expectedMessage),
            `${invalidCase.label} should report ${invalidCase.expectedMessage}, got stderr=${execError.stderr ?? ""}`
        );
        process.stdout.write(`builtin-ops-invalid ${invalidCase.label} ok\n`);
    }
}
