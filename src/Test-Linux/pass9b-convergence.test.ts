import { ok } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface FrontendCase {
    readonly label: string;
    readonly frontendArgs: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "compiler-pass9b");
const entryUnitId = "test~compiler~pass9b_array_index@main";
const expectedLines = ["2"];

const frontendCases: readonly FrontendCase[] = [
    {
        label: "optimized-frontend",
        frontendArgs: []
    },
    {
        label: "no-optimized-frontend",
        frontendArgs: ["--frontend-profile", "no-optimized"]
    }
];

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000
});

for (const testCase of frontendCases) {
    const backendIr = execBuildJsonCliSync(cliPath, [
        "emit-backend-ir",
        fixtureDir,
        "--entry",
        entryUnitId,
        ...testCase.frontendArgs
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });

    ok(
        backendIr.includes("final_backend_ir_program") && backendIr.includes("__iw_backend_entry"),
        `${testCase.label} should complete backend IR emission, got:\n${backendIr}`
    );

    const result = spawnBuildJsonCliSync(cliPath, [
        "run",
        fixtureDir,
        "--entry",
        entryUnitId,
        ...testCase.frontendArgs,
        "--backend-profile",
        "c-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000
    });

    assertRunResult(result, [], Number(expectedLines[0]) & 0xff, testCase.label);
    process.stdout.write(`pass9b-convergence ${testCase.label} ok\n`);
}
