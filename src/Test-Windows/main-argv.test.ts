import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { assertExpectedExitCode, assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";
import { execLinuxToolSync, spawnLinuxBinarySync } from "./LinuxHostToolchainHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

interface AbortCase {
    readonly inputPath: string;
    readonly expectedMessage: string;
}

const TEST_TIMEOUT_MS: number = 15000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test-Windows", "Fixtures", "main-argv");
const typecheckFixtureDir: string = join(repoRoot, "src", "Test-Windows", "Fixtures", "main-argv-typecheck");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];
const programArgs: readonly string[] = ["aa", "bbbb", "z"];
const expectedLines: readonly string[] = ["241"];

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

const abortCases: readonly AbortCase[] = [
    {
        inputPath: join(typecheckFixtureDir, "test~main~argv~zero_param@main.iw"),
        expectedMessage: "main must take exactly one parameter"
    },
    {
        inputPath: join(typecheckFixtureDir, "test~main~argv~wrong_name@main.iw"),
        expectedMessage: "main parameter must be named args"
    },
    {
        inputPath: join(typecheckFixtureDir, "test~main~argv~wrong_type@main.iw"),
        expectedMessage: "main parameter must have type <array s3>"
    },
    {
        inputPath: join(typecheckFixtureDir, "test~main~argv~wrong_return@main.iw"),
        expectedMessage: "main must return i5"
    }
];

function runFixture(run: BackendRun): void {
    const result = spawnBuildJsonCliSync(cliPath, [
        "run",
        fixtureDir,
        "--entry",
        "test~main~argv@main",
        ...run.runArgs,
        "--",
        ...programArgs
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    assertRunResult(result, [], Number(expectedLines[0]) & 0xff, `${run.label} argv`);
    process.stdout.write(`main-argv ${run.label} ok\n`);
}

function verifyEmitCWrapper(): void {
    const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-main-argv-"));
    const sourcePath: string = join(tempDir, "program.c");
    const binaryPath: string = join(tempDir, "program.out");
    try {
        const source: string = execBuildJsonCliSync(cliPath, [
            "emit-c",
            fixtureDir,
            "--entry",
            "test~main~argv@main"
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        writeFileSync(sourcePath, source, "utf8");
        execLinuxToolSync("cc", ["-w", "-std=c11", "-O0", "-pthread", sourcePath, "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });

        const result = spawnLinuxBinarySync(binaryPath, [...programArgs], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        strictEqual(result.signal, null, `emit-c argv signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assertExpectedExitCode(result.status, Number(expectedLines[0]) & 0xff, `emit-c argv exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        strictEqual(result.stdout, "", `emit-c argv stdout mismatch\n${result.stdout}`);
        strictEqual(result.stderr, "", `emit-c argv stderr mismatch\n${result.stderr}`);
        process.stdout.write("main-argv emit-c ok\n");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

for (const run of runs) {
    runFixture(run);
}

verifyEmitCWrapper();

for (const abortCase of abortCases) {
    try {
        execBuildJsonCliSync(cliPath, ["check", abortCase.inputPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        throw new Error(`${abortCase.inputPath} unexpectedly typechecked successfully`);
    } catch (error) {
        if (error instanceof Error && error.message.includes("unexpectedly typechecked successfully")) {
            throw error;
        }
        const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
        ok(
            execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
            `${abortCase.inputPath} should fail typechecking with non-zero exit`
        );
        const combinedOutput: string = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
        ok(
            combinedOutput.includes(abortCase.expectedMessage),
            `${abortCase.inputPath} should mention '${abortCase.expectedMessage}', got output=${combinedOutput}`
        );
        process.stdout.write(`main-argv typecheck ${abortCase.expectedMessage} ok\n`);
    }
}
