import { ok } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";
import { getBaseLibSourceRoots } from "../BaseLib";
import { GenericCallNode, GenericClassNode, GenericDfunNode, IdentifierNode } from "../AstNode";
import { loadProgramAst } from "../ModuleLoader";
import { formatMonomorphizedAst, getMonomorphizedConcreteProgram } from "../Typecheck-Pass-8-Monomorphize";
import { performTypeChecking } from "../Typecheck-Pipeline";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "pkg-monomorphization");
const entryUnitId = "test~pkg~mono~app@main";

const runs: readonly BackendRun[] = [
    {
        label: "c-backend",
        runArgs: ["--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        runArgs: ["--frontend-profile", "no-optimized", "--backend-profile", "no-optimized-backend"]
    }
];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function assertNoUserGenericAst(value: unknown): void {
    if (Array.isArray(value)) {
        value.forEach((item) => assertNoUserGenericAst(item));
        return;
    }
    if (!isObjectRecord(value)) {
        return;
    }
    if (value instanceof GenericClassNode || value instanceof GenericDfunNode) {
        throw new Error("concrete program still contains generic definitions");
    }
    if (value instanceof GenericCallNode) {
        if (!(value.callee instanceof IdentifierNode)) {
            throw new Error("concrete program still contains non-identifier generic callee");
        }
        if (value.callee.name !== "array" && value.callee.name !== "class_new") {
            throw new Error(`concrete program still contains user generic call ${value.callee.name}`);
        }
        if (value.callee.name === "class_new" && value.typeArgs.length !== 1) {
            throw new Error("concrete program still contains generic constructor type arguments");
        }
    }
    Object.values(value).forEach((fieldValue) => assertNoUserGenericAst(fieldValue));
}

const ast = loadProgramAst(fixtureDir, {
    additionalInputPaths: getBaseLibSourceRoots()
});
performTypeChecking(ast, {
    disableBaseLibAutoLoad: false
});

const concreteProgram = getMonomorphizedConcreteProgram();
const formattedConcrete = formatMonomorphizedAst(concreteProgram);

ok(
    formattedConcrete.includes("test~pkg~mono~lib@Box"),
    `concrete program should contain canonical package-qualified class names, got:\n${formattedConcrete}`
);
ok(
    !formattedConcrete.includes("<generic"),
    `concrete program should not contain generic definitions after monomorphization, got:\n${formattedConcrete}`
);
assertNoUserGenericAst(concreteProgram);

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000
});

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, ["run", fixtureDir, "--entry", entryUnitId, ...run.runArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });
    assertRunResult(result, [], 16, run.label);
    process.stdout.write(`pkg-monomorphization ${run.label} ok\n`);
}
