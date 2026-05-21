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

interface CheckSuccessCase {
    readonly name: string;
    readonly inputPath: string;
}

interface AbortCase {
    readonly name: string;
    readonly inputPath: string;
    readonly expectedMessage: string;
}

const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "language-rules");
const checkFixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "language-rules-check");
const abortFixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "language-rules-typecheck");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];

const checkOnlyCases: readonly CheckSuccessCase[] = [
    {
        name: "export-declared-function",
        inputPath: join(checkFixtureDir, "export-declared-success")
    }
];

const successCases: readonly SuccessCase[] = [
    {
        name: "integrated-rules",
        entry: "test~language~rules~app@main",
        expectedLines: ["524"]
    },
    {
        name: "export-visibility",
        entry: "test~language~rules~export~app@main",
        expectedLines: ["43"]
    }
];

const abortCases: readonly AbortCase[] = [
    {
        name: "duplicate-function-overload",
        inputPath: join(abortFixtureDir, "test~language~rules~duplicate_function@main.iw"),
        expectedMessage: "duplicate overload with the same parameter list"
    },
    {
        name: "duplicate-generic-function-arity",
        inputPath: join(abortFixtureDir, "test~language~rules~duplicate_generic_function@main.iw"),
        expectedMessage: "duplicate exported symbol 'pack'"
    },
    {
        name: "duplicate-generic-class-arity",
        inputPath: join(abortFixtureDir, "test~language~rules~duplicate_generic_class@main.iw"),
        expectedMessage: "duplicate exported symbol 'Bucket'"
    },
    {
        name: "missing-constructor",
        inputPath: join(abortFixtureDir, "test~language~rules~missing_constructor@main.iw"),
        expectedMessage: "at least one constructor is required"
    },
    {
        name: "duplicate-constructor-overload",
        inputPath: join(abortFixtureDir, "test~language~rules~duplicate_constructor@main.iw"),
        expectedMessage: "duplicate constructor with the same parameter list"
    },
    {
        name: "constructor-direct-read-before-init",
        inputPath: join(abortFixtureDir, "test~language~rules~constructor_direct_read_before_init@main.iw"),
        expectedMessage: "reads property value before it is initialized"
    },
    {
        name: "constructor-method-transitive-read-before-init",
        inputPath: join(abortFixtureDir, "test~language~rules~constructor_method_transitive_read_before_init@main.iw"),
        expectedMessage: "method read_via may read properties right before they are initialized"
    },
    {
        name: "constructor-direct-self-escape",
        inputPath: join(abortFixtureDir, "test~language~rules~constructor_direct_self_escape@main.iw"),
        expectedMessage: "constructor cannot let self escape before initialization is complete"
    },
    {
        name: "constructor-method-transitive-self-escape",
        inputPath: join(abortFixtureDir, "test~language~rules~constructor_method_transitive_self_escape@main.iw"),
        expectedMessage: "method leak_via may let self escape before initialization is complete"
    },
    {
        name: "duplicate-union-member",
        inputPath: join(abortFixtureDir, "test~language~rules~duplicate_union_member@main.iw"),
        expectedMessage: "Duplicate union member type: i5"
    },
    {
        name: "qualified-cross-package-without-import",
        inputPath: join(abortFixtureDir, "qualified-cross-package-without-import"),
        expectedMessage: "package 'test~language~rules~qualified~lib' is not visible; import it explicitly"
    },
    {
        name: "parent-import-does-not-import-child",
        inputPath: join(abortFixtureDir, "parent-import-does-not-import-child"),
        expectedMessage: "package 'test~language~rules~parent~child' is not visible; import it explicitly"
    },
    {
        name: "export-non-exported-cross-package",
        inputPath: join(abortFixtureDir, "export-non-exported-cross-package"),
        expectedMessage: "symbol 'hidden_add_one' is not exported by package 'test~language~rules~export~hidden~lib'"
    },
    {
        name: "export-arity-zero",
        inputPath: join(abortFixtureDir, "test~language~rules~export_arity_zero@main.iw"),
        expectedMessage: "export expects exactly one argument"
    },
    {
        name: "export-arity-many",
        inputPath: join(abortFixtureDir, "test~language~rules~export_arity_many@main.iw"),
        expectedMessage: "export expects exactly one argument"
    },
    {
        name: "nested-export",
        inputPath: join(abortFixtureDir, "test~language~rules~nested_export@main.iw"),
        expectedMessage: "export declarations must appear at top level"
    },
    {
        name: "export-plain-expression",
        inputPath: join(abortFixtureDir, "test~language~rules~export_plain_expression@main.iw"),
        expectedMessage: "export may only wrap top-level definitions and top-level var"
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

for (const checkOnlyCase of checkOnlyCases) {
    execBuildJsonCliSync(cliPath, ["check", checkOnlyCase.inputPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });
    process.stdout.write(`language-rules-check ${checkOnlyCase.name} ok\n`);
}

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
        process.stdout.write(`language-rules ${successCase.name} ${run.label} ok\n`);
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
        process.stdout.write(`language-rules-typecheck ${abortCase.name} ok\n`);
    }
}
