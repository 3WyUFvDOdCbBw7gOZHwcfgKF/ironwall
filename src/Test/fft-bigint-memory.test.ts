import { ok, strictEqual } from "assert";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execBuildJsonCliSync, normalizeOutputLines } from "./BuildJsonCliHarness";

interface NativeRunMeasurement {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly rssKb: number;
}

const TEST_TIMEOUT_MS: number = 120000;
const MAX_BUFFER_BYTES: number = 64 * 1024 * 1024;
const TIME_PATH: string = "/usr/bin/time";
const PRLIMIT_PATH: string = "/usr/bin/prlimit";
const FFT_BIGINT_MAX_ADDRESS_SPACE_KB: number = 128 * 1024;
const FFT_BIGINT_RSS_MAX_KB: number = 64 * 1024;
const expectedLines: readonly string[] = [
    "fft_0008_ok",
    "fft_0016_ok",
    "fft_0032_ok",
    "fft_0064_ok",
    "fft_f6_0064_ok",
    "fft_f7_0065_ok"
];
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "fft-bigint");

function compileEmitCFixture(outputDir: string): string {
    const sourcePath: string = join(outputDir, "fft-bigint.c");
    const binaryPath: string = join(outputDir, "fft-bigint.out");
    const sourceText: string = execBuildJsonCliSync(cliPath, [
        "emit-c",
        fixtureDir,
        "--entry",
        "test~fft~bigint@main",
        "--backend-profile",
        "c-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    writeFileSync(sourcePath, sourceText, "utf8");
    execFileSync("cc", ["-w", "-std=c11", "-O0", "-pthread", sourcePath, "-o", binaryPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    return binaryPath;
}

function parseMaximumResidentSetSize(statsText: string): number {
    const statsMatch: RegExpExecArray | null = /^\s*Maximum resident set size \(kbytes\):\s*(\d+)\s*$/m.exec(statsText);
    if (statsMatch === null) {
        throw new Error(`Missing maximum resident set size in time output\n${statsText}`);
    }

    const rssKb: number = Number.parseInt(statsMatch[1], 10);
    if (!Number.isFinite(rssKb) || rssKb <= 0) {
        throw new Error(`Invalid maximum resident set size '${statsMatch[1]}'`);
    }
    return rssKb;
}

function runMeasuredBinary(binaryPath: string, outputDir: string): NativeRunMeasurement {
    const statsPath: string = join(outputDir, "fft-bigint.time.txt");
    const result: SpawnSyncReturns<string> = spawnSync(TIME_PATH, [
        "-v",
        "-o",
        statsPath,
        PRLIMIT_PATH,
        `--as=${String(FFT_BIGINT_MAX_ADDRESS_SPACE_KB * 1024)}`,
        "--",
        binaryPath
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    if (result.error !== undefined) {
        throw result.error;
    }

    return {
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        rssKb: parseMaximumResidentSetSize(readFileSync(statsPath, "utf8"))
    };
}

const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-fft-bigint-memory-"));
try {
    const binaryPath: string = compileEmitCFixture(tempDir);
    const measurement: NativeRunMeasurement = runMeasuredBinary(binaryPath, tempDir);

    strictEqual(measurement.signal, null, `fft-bigint signal mismatch stdout=${measurement.stdout} stderr=${measurement.stderr}`);
    strictEqual(measurement.status, 0, `fft-bigint exit code mismatch stdout=${measurement.stdout} stderr=${measurement.stderr}`);
    strictEqual(measurement.stderr, "", `fft-bigint stderr mismatch\n${measurement.stderr}`);
    strictEqual(
        normalizeOutputLines(measurement.stdout).join("\n"),
        expectedLines.join("\n"),
        `fft-bigint stdout mismatch\n${measurement.stdout}`
    );
    ok(
        measurement.rssKb <= FFT_BIGINT_RSS_MAX_KB,
        `fft-bigint RSS should stay within ${FFT_BIGINT_RSS_MAX_KB}KB, got ${measurement.rssKb}KB`
    );

    process.stdout.write(`fft-bigint memory rss=${measurement.rssKb}KB cap_kb=${FFT_BIGINT_MAX_ADDRESS_SPACE_KB} ok\n`);
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}