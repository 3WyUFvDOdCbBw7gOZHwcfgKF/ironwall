import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";
import { AstNode, DfunNode, ProgramNode } from "../AstNode";
import { parseProgramSource } from "../ModuleLoader";
import { astToString } from "../parser";
import { performTypeChecking } from "../Typecheck-Pipeline";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

interface InvalidCase {
    readonly label: string;
    readonly inputPath: string;
    readonly expectedMessage: string;
}

const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "variadic-builtins");
const positiveInputPath: string = join(fixtureDir, "test~variadic~builtins@main.iw");
const parserSurfaceProgram: ProgramNode = parseProgramSource([
    "{program test~variadic~parser@main",
    "  (function fold_add () to i5 in (add $1^i5 $2^i5 $3^i5 $4^i5))",
    "  (function fold_sub () to i5 in (sub $10^i5 $3^i5 $2^i5 $1^i5))",
    "  (function fold_mul () to i5 in (mul $2^i5 $3^i5 $4^i5 $5^i5))",
    "  (function fold_and () to bool in (and true false true true))",
    "  (function fold_or () to bool in (or false false true false))",
    "  (function chain_le () to bool in (le $1^i5 $2^i5 $3^i5 $4^i5))",
    "  (function chain_eq () to bool in (eq $7^i5 $7^i5 $7^i5 $7^i5))",
    "}"
].join("\n"));

const runs: readonly BackendRun[] = [
    {
        label: "optimized-frontend c-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~variadic~builtins@main", "--frontend-profile", "optimized", "--backend-profile", "c-backend"]
    },
    {
        label: "optimized-frontend optimized-x64-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~variadic~builtins@main", "--frontend-profile", "optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "optimized-frontend no-optimized-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~variadic~builtins@main", "--frontend-profile", "optimized", "--backend-profile", "no-optimized-backend"]
    },
    {
        label: "no-optimized-frontend c-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~variadic~builtins@main", "--frontend-profile", "no-optimized", "--backend-profile", "c-backend"]
    },
    {
        label: "no-optimized-frontend optimized-x64-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~variadic~builtins@main", "--frontend-profile", "no-optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-frontend no-optimized-backend",
        runArgs: ["run", positiveInputPath, "--entry", "test~variadic~builtins@main", "--frontend-profile", "no-optimized", "--backend-profile", "no-optimized-backend"]
    }
];

const invalidCases: readonly InvalidCase[] = [
    {
        label: "add-arity1",
        inputPath: join(fixtureDir, "test~variadic~builtins~invalid_add_arity1@main.iw"),
        expectedMessage: "Function add expects 2 arguments, got 1"
    },
    {
        label: "le-arity1",
        inputPath: join(fixtureDir, "test~variadic~builtins~invalid_le_arity1@main.iw"),
        expectedMessage: "Function le expects 2 arguments, got 1"
    }
];

strictEqual(
    astToString(getFunctionBody(parserSurfaceProgram, "fold_add")),
    "(add $1^i5 (add $2^i5 (add $3^i5 $4^i5)))",
    "variadic add should normalize to a right-associated binary tree"
);
strictEqual(
    astToString(getFunctionBody(parserSurfaceProgram, "fold_sub")),
    "(sub (sub (sub $10^i5 $3^i5) $2^i5) $1^i5)",
    "variadic sub should normalize to a left-associated binary tree"
);
strictEqual(
    astToString(getFunctionBody(parserSurfaceProgram, "fold_mul")),
    "(mul $2^i5 (mul $3^i5 (mul $4^i5 $5^i5)))",
    "variadic mul should normalize to a right-associated binary tree"
);
strictEqual(
    astToString(getFunctionBody(parserSurfaceProgram, "fold_and")),
    "(and true (and false (and true true)))",
    "variadic and should normalize to a right-associated binary tree"
);
strictEqual(
    astToString(getFunctionBody(parserSurfaceProgram, "fold_or")),
    "(or false (or false (or true false)))",
    "variadic or should normalize to a right-associated binary tree"
);
strictEqual(
    astToString(getFunctionBody(parserSurfaceProgram, "chain_le")),
    "(le $1^i5 $2^i5 $3^i5 $4^i5)",
    "variadic le should stay n-ary before typechecking rewrites it"
);
strictEqual(
    astToString(getFunctionBody(parserSurfaceProgram, "chain_eq")),
    "(eq $7^i5 $7^i5 $7^i5 $7^i5)",
    "variadic eq should stay n-ary before typechecking rewrites it"
);

performTypeChecking(parserSurfaceProgram);

ok(
    /^\(let \(\(\[(_uuid[0-9a-f]+) i5\] \$1\^i5\) \(\[(_uuid[0-9a-f]+) i5\] \$2\^i5\) \(\[(_uuid[0-9a-f]+) i5\] \$3\^i5\) \(\[(_uuid[0-9a-f]+) i5\] \$4\^i5\)\) in \(and \(le \1 \2\) \(and \(le \2 \3\) \(le \3 \4\)\)\)\)$/.test(astToString(getFunctionBody(parserSurfaceProgram, "chain_le"))),
    `variadic le should rewrite after typechecking into typed let form, got ${astToString(getFunctionBody(parserSurfaceProgram, "chain_le"))}`
);
ok(
    /^\(let \(\(\[(_uuid[0-9a-f]+) i5\] \$7\^i5\) \(\[(_uuid[0-9a-f]+) i5\] \$7\^i5\) \(\[(_uuid[0-9a-f]+) i5\] \$7\^i5\) \(\[(_uuid[0-9a-f]+) i5\] \$7\^i5\)\) in \(and \(eq \1 \2\) \(and \(eq \2 \3\) \(eq \3 \4\)\)\)\)$/.test(astToString(getFunctionBody(parserSurfaceProgram, "chain_eq"))),
    `variadic eq should rewrite after typechecking into typed let form, got ${astToString(getFunctionBody(parserSurfaceProgram, "chain_eq"))}`
);

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

    assertRunResult(result, [], 13530 & 0xff, run.label);
    process.stdout.write(`variadic-builtins ${run.label} ok\n`);
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
        process.stdout.write(`variadic-builtins-invalid ${invalidCase.label} ok\n`);
    }
}

function getFunctionBody(program: ProgramNode, functionName: string): AstNode {
    for (const expression of program.topLevelExpressions) {
        if (
            expression instanceof DfunNode
            && (expression.name.name === functionName || expression.name.name.endsWith(`@${functionName}`))
        ) {
            return expression.body;
        }
    }
    throw new Error(`Function ${functionName} not found in parser surface program`);
}
