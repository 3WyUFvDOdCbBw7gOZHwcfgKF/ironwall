import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface AbortCase {
    readonly name: string;
    readonly appDir: string;
    readonly expectedMessage: string;
}

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureRoot = join(repoRoot, "src", "Test", "Fixtures", "precompiled-lib-public-visibility");
const libDir = join(fixtureRoot, "lib");
const appOkDir = join(fixtureRoot, "app-ok");
const entryUnitId = "test~precompiled~visibility~app@main";

const abortCases: readonly AbortCase[] = [
    {
        name: "private-class-property",
        appDir: join(fixtureRoot, "app-private"),
        expectedMessage: "Member hidden is private in class"
    },
    {
        name: "private-generic-property",
        appDir: join(fixtureRoot, "app-private-generic"),
        expectedMessage: "Member hidden is private in generic class"
    }
];

const tempDir = mkdtempSync(join(tmpdir(), "ironwall-precompiled-lib-public-visibility-"));
const archivePath = join(tempDir, "test-precompiled-lib-public-visibility.tgz");

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

    execBuildJsonCliSync(cliPath, ["check", appOkDir, "--lib", archivePath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    const runResult = spawnBuildJsonCliSync(cliPath, [
        "run",
        appOkDir,
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

    strictEqual(runResult.signal, null, `precompiled-lib public visibility signal mismatch\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
    strictEqual(runResult.status, 35, `precompiled-lib public visibility exit code mismatch\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
    strictEqual(runResult.stdout, "", `precompiled-lib public visibility should not print main return value\n${runResult.stdout}`);
    strictEqual(runResult.stderr, "", `precompiled-lib public visibility stderr mismatch\n${runResult.stderr}`);

    for (const abortCase of abortCases) {
        try {
            execBuildJsonCliSync(cliPath, ["check", abortCase.appDir, "--lib", archivePath], {
                cwd: repoRoot,
                encoding: "utf8",
                maxBuffer: MAX_BUFFER_BYTES,
                timeout: TEST_TIMEOUT_MS
            });
            throw new Error(`${abortCase.name} unexpectedly typechecked successfully`);
        } catch (error) {
            if (error instanceof Error && error.message.includes("unexpectedly typechecked successfully")) {
                throw error;
            }
            const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
            ok(
                execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
                `${abortCase.name} should fail typechecking with non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
            );
            const combinedOutput = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
            ok(
                combinedOutput.includes(abortCase.expectedMessage),
                `${abortCase.name} should mention '${abortCase.expectedMessage}', got output=${combinedOutput}`
            );
            process.stdout.write(`precompiled-lib-public-visibility ${abortCase.name} ok\n`);
        }
    }

    process.stdout.write("precompiled-lib public visibility ok\n");
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}