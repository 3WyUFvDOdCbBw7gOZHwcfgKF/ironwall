import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { formatLoweredExpr } from "../Lowering-Debug";
import { desugarNoOptimizeCorePass } from "../Lowering-NoOptimize-Pass-4-DesugarCore";
import { performNoOptimizeLoweringStageAFromArtifacts } from "../Lowering-NoOptimize-Pass-3-LiftMethods";
import { desugarCorePass } from "../Lowering-Pass-4-DesugarCore";
import { performLoweringStageAFromArtifacts } from "../Lowering-Pass-3-LiftMethods";
import { loadProgramAst } from "../ModuleLoader";
import type { LoweredFunctionDefinition } from "../Lowering-Frontend-Shared";
import { getMonomorphizedArtifacts } from "../Typecheck-Pass-8-Monomorphize";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "cond-semantics");
const entryUnitId: string = "test~cond~semantics@main";
const expectedExitCode: number = 121;

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

const ast = loadProgramAst(fixtureDir, {
    additionalInputPaths: getBaseLibSourceRoots()
});

performTypeChecking(ast, {
    disableBaseLibAutoLoad: false
});

const artifacts = getMonomorphizedArtifacts();

const optimizedStageA = performLoweringStageAFromArtifacts(ast, artifacts);
const optimizedDesugared = desugarCorePass(optimizedStageA.pass3);
const optimizedCondBody = formatLoweredExpr(getFunctionByName(optimizedStageA.pass3.functions, "cond_score").body);
const optimizedNestedIfBody = formatLoweredExpr(getFunctionByName(optimizedStageA.pass3.functions, "nested_if_score").body);
ok(optimizedCondBody.startsWith("(cond "), `optimized lowering should preserve cond before pass 4, got ${optimizedCondBody}`);
assertClauseOrder(optimizedCondBody, ["11", "22", "33", "44"], "optimized cond clause order");
ok(optimizedNestedIfBody.startsWith("(if "), `optimized lowering should preserve nested if before pass 4, got ${optimizedNestedIfBody}`);
strictEqual(
    formatLoweredExpr(getFunctionByName(optimizedDesugared.functions, "cond_score").body),
    formatLoweredExpr(getFunctionByName(optimizedDesugared.functions, "nested_if_score").body),
    "optimized pass 4 cond body should match manual nested if body"
);

const noOptimizeStageA = performNoOptimizeLoweringStageAFromArtifacts(ast, artifacts);
const noOptimizeDesugared = desugarNoOptimizeCorePass(noOptimizeStageA.pass3);
const noOptimizeCondBody = formatLoweredExpr(getFunctionByName(noOptimizeStageA.pass3.functions, "cond_score").body);
const noOptimizeNestedIfBody = formatLoweredExpr(getFunctionByName(noOptimizeStageA.pass3.functions, "nested_if_score").body);
ok(noOptimizeCondBody.startsWith("(cond "), `no-opt lowering should preserve cond before pass 4, got ${noOptimizeCondBody}`);
assertClauseOrder(noOptimizeCondBody, ["11", "22", "33", "44"], "no-opt cond clause order");
ok(noOptimizeNestedIfBody.startsWith("(if "), `no-opt lowering should preserve nested if before pass 4, got ${noOptimizeNestedIfBody}`);
strictEqual(
    formatLoweredExpr(getFunctionByName(noOptimizeDesugared.functions, "cond_score").body),
    formatLoweredExpr(getFunctionByName(noOptimizeDesugared.functions, "nested_if_score").body),
    "no-opt pass 4 cond body should match manual nested if body"
);

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000
});

for (const run of runs) {
    const result = spawnBuildJsonCliSync(cliPath, [
        "run",
        fixtureDir,
        "--entry",
        entryUnitId,
        ...run.runArgs
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });

    assertRunResult(result, [], expectedExitCode & 0xff, run.label);
    process.stdout.write(`cond-semantics ${run.label} ok\n`);
}

function getFunctionByName(functions: readonly LoweredFunctionDefinition[], name: string): LoweredFunctionDefinition {
    const matches = functions.filter((fn) => fn.symbol.endsWith(`@${name}`));
    ok(matches.length === 1, `expected exactly one lowered function for ${name}, got ${matches.map((fn) => fn.symbol).join(", ")}`);
    return matches[0];
}

function assertClauseOrder(text: string, expectedFragments: readonly string[], label: string): void {
    let previousIndex = -1;
    for (const fragment of expectedFragments) {
        const index = text.indexOf(fragment, previousIndex + 1);
        ok(index >= 0, `${label} should include '${fragment}', got ${text}`);
        ok(index > previousIndex, `${label} should preserve clause order for '${fragment}', got ${text}`);
        previousIndex = index;
    }
}