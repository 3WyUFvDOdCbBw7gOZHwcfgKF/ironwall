import { strictEqual } from "assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureRoot = join(repoRoot, "src", "Test", "Fixtures", "precompiled-lib-global-closure");
const libDir = join(fixtureRoot, "lib");
const appDir = join(fixtureRoot, "app");
const entryUnitId = "test~precompiled~closure~app@main";

const tempDir = mkdtempSync(join(tmpdir(), "ironwall-precompiled-lib-global-closure-"));
const archivePath = join(tempDir, "test-precompiled-lib-global-closure.tgz");

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

    strictEqual(runResult.signal, null, `precompiled-lib global closure signal mismatch\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
    strictEqual(runResult.status, 63, `precompiled-lib global closure exit code mismatch\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
    strictEqual(runResult.stdout, "", `precompiled-lib global closure should not print main return value\n${runResult.stdout}`);
    strictEqual(runResult.stderr, "", `precompiled-lib global closure stderr mismatch\n${runResult.stderr}`);

    process.stdout.write("precompiled-lib global closure capture ok\n");
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}