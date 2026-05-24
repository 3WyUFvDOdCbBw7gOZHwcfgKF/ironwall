import { deepStrictEqual } from "assert";
import { join, resolve } from "path";
import { execBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const TEST_TIMEOUT_MS: number = 15000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "std-io-stdin-forward");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];
const stdinPayload: string = "41 82\n7\n";
const expectedTokens: readonly string[] = ["41", "82", "7"];

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

function tokenize(output: string): string[] {
    return output
        .split(/\s+/)
        .map((token: string) => token.trim())
        .filter((token: string) => token.length > 0);
}

for (const run of runs) {
    const output: string = execBuildJsonCliSync(cliPath, [
        "run",
        fixtureDir,
        "--entry",
        "test~std~io~stdin~forward@main",
        ...run.runArgs
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        input: stdinPayload,
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    deepStrictEqual(tokenize(output), expectedTokens, `${run.label} stdin forwarding mismatch\n${output}`);
    process.stdout.write(`std-io-stdin-forward ${run.label} ok\n`);
}
