import { execFileSync, spawnSync, type SpawnSyncReturns } from "child_process";
import { strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const releaseCliPath = join(repoRoot, "build", "main-release.js");
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "main-exit-code");
const entryUnitId = "test~main~exit~code@main";
const expectedExitCode = 17;

function assertExitCodeResult(result: SpawnSyncReturns<string>, label: string): void {
    strictEqual(
        result.signal ?? null,
        null,
        `${label} should exit normally stdout=${result.stdout ?? ""} stderr=${result.stderr ?? ""}`
    );
    strictEqual(
        result.status ?? null,
        expectedExitCode,
        `${label} exit code mismatch stdout=${result.stdout ?? ""} stderr=${result.stderr ?? ""}`
    );
    strictEqual(result.stdout ?? "", "", `${label} should not print main return to stdout`);
    strictEqual(result.stderr ?? "", "", `${label} should not print main return to stderr`);
}

function verifyEmitCExitCode(): void {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-main-exit-c-"));
    const sourcePath = join(tempDir, "program.c");
    const binaryPath = join(tempDir, "program.out");
    try {
        const source = execBuildJsonCliSync(cliPath, [
            "emit-c",
            fixtureDir,
            "--entry",
            entryUnitId
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        writeFileSync(sourcePath, source, "utf8");
        execFileSync("cc", ["-w", "-std=c11", "-O0", "-pthread", sourcePath, "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });

        const result = spawnSync(binaryPath, [], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        assertExitCodeResult(result, "emit-c binary");
        process.stdout.write("main-exit-code emit-c ok\n");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function verifyRunCliExitCode(): void {
    const result = spawnBuildJsonCliSync(cliPath, [
        "run",
        fixtureDir,
        "--entry",
        entryUnitId
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    assertExitCodeResult(result, "cli run");
    process.stdout.write("main-exit-code cli-run ok\n");
}

function verifyReleaseBuildExitCode(): void {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-main-exit-release-"));
    const configPath = join(tempDir, "build-iw.json");
    const binaryPath = join(tempDir, "program.out");
    try {
        writeFileSync(configPath, `${JSON.stringify({
            mode: "build",
            directories: [{
                path: relative(tempDir, fixtureDir)
            }],
            main: entryUnitId,
            output: relative(tempDir, binaryPath),
            precompiledLibs: [],
            ffiLibs: []
        }, null, 2)}\n`, "utf8");

        const output = execFileSync(process.execPath, [releaseCliPath, configPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        strictEqual(output.includes(`Built executable: ${binaryPath}`), true, `release build output mismatch\n${output}`);

        const result = spawnSync(binaryPath, [], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        assertExitCodeResult(result, "release build binary");
        process.stdout.write("main-exit-code release-build ok\n");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

verifyEmitCExitCode();
verifyRunCliExitCode();
verifyReleaseBuildExitCode();