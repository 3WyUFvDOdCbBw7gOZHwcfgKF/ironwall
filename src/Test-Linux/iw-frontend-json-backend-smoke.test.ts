import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { assertRunResult, spawnBuildJsonCliSync } from "../Test/BuildJsonCliHarness";
import { ensureCurrentNodeProcessHasMemoryLimit } from "../Test/NodeMemoryLimit";

ensureCurrentNodeProcessHasMemoryLimit();

interface BackendRun {
    readonly label: string;
    readonly args: readonly string[];
}

const TEST_TIMEOUT_MS: number = 240000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const commandPath: string = join(repoRoot, "src", "examples", "json-lib", "run-iw-frontend-json.js");
const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-iw-frontend-json-backend-"));
const sourceFileName: string = "test~json~frontend~backend~smoke@main.iw";
const unitId: string = "test~json~frontend~backend~smoke@main";
const sourcePath: string = join(tempDir, sourceFileName);
const sharedArgs: readonly string[] = [
    "run",
    sourcePath,
    "--entry",
    unitId,
    "--frontend-profile",
    "no-optimized",
    "--no-base-lib"
];

const runs: readonly BackendRun[] = [
    {
        label: "c-backend",
        args: [...sharedArgs, "--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        args: [...sharedArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        args: [...sharedArgs, "--backend-profile", "no-optimized-backend"]
    }
];

try {
    writeFileSync(
        sourcePath,
        "{program test~json~frontend~backend~smoke@main (function main ([args <array s3>]) to i5 in $0^i5)}\n",
        "utf8"
    );

    const previousCommand: string | undefined = process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND;
    process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND = commandPath;
    try {
        for (const run of runs) {
            const result = spawnBuildJsonCliSync(cliPath, [...run.args], {
                cwd: repoRoot,
                encoding: "utf8",
                maxBuffer: MAX_BUFFER_BYTES,
                timeout: TEST_TIMEOUT_MS
            });

            assertRunResult(result, [], 0, run.label);
            process.stdout.write(`iw-frontend-json-backend-smoke ${run.label} ok\n`);
        }
    } finally {
        if (previousCommand === undefined) {
            delete process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND;
        } else {
            process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND = previousCommand;
        }
    }
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}