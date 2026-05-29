import { execBuildJsonCliSync } from "./BuildJsonCliHarness";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { ensureCurrentNodeProcessHasMemoryLimit } from "./NodeMemoryLimit";

ensureCurrentNodeProcessHasMemoryLimit();

const TEST_TIMEOUT_MS: number = 120000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const commandPath: string = join(repoRoot, "src", "examples", "json-lib", "run-iw-frontend-json.js");
const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-iw-frontend-json-check-"));
const sourceFileName: string = "test~json~frontend~smoke@main.iw";
const sourcePath: string = join(tempDir, sourceFileName);

try {
    writeFileSync(
        sourcePath,
        "{program test~json~frontend~smoke@main (function main ([args <array s3>]) to i5 in $0^i5)}\n",
        "utf8"
    );

    const previousCommand: string | undefined = process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND;
    process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND = commandPath;
    try {
        execBuildJsonCliSync(cliPath, [
            "check",
            sourcePath,
            "--entry",
            "test~json~frontend~smoke@main",
            "--frontend-profile",
            "no-optimized",
            "--no-base-lib"
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
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

process.stdout.write("iw-frontend-json-compiler-smoke ok\n");
