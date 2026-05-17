import { strictEqual } from "assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureRoot = join(repoRoot, "src", "Test-Windows", "Fixtures", "precompiled-lib-hof");
const libDir = join(fixtureRoot, "lib");
const appDir = join(fixtureRoot, "app");
const entryUnitId = "test~precompiled~hof~app@main";

const tempDir = mkdtempSync(join(tmpdir(), "ironwall-precompiled-lib-hof-"));
const archivePath = join(tempDir, "test-precompiled-lib-hof.tgz");

try {
    execBuildJsonCliSync(cliPath, [
        "pack-lib",
        libDir,
        "--out",
        archivePath,
        "--frontend-profile",
        "no-optimized",
        "--backend-profile",
        "no-optimized-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    execBuildJsonCliSync(cliPath, ["check", appDir, "--lib", archivePath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    const runResult = spawnBuildJsonCliSync(cliPath, [
        "run",
        appDir,
        "--entry",
        entryUnitId,
        "--lib",
        archivePath,
        "--frontend-profile",
        "no-optimized",
        "--backend-profile",
        "no-optimized-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    strictEqual(runResult.signal, null, `precompiled-lib hof signal mismatch\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
    strictEqual(runResult.status, 13, `precompiled-lib hof exit code mismatch\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
    strictEqual(runResult.stdout, "", `precompiled-lib hof should not print main return value\n${runResult.stdout}`);
    strictEqual(runResult.stderr, "", `precompiled-lib hof stderr mismatch\n${runResult.stderr}`);

    process.stdout.write("precompiled-lib hof closure boxing ok\n");
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}