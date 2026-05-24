import { ok, strictEqual } from "assert";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execBuildJsonCliSync } from "../Test/BuildJsonCliHarness";

interface NativeRunMeasurement {
    readonly label: string;
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly rssKb: number;
    readonly ppmText: string | null;
}

const TEST_TIMEOUT_MS: number = 1800000;
const MAX_BUFFER_BYTES: number = 64 * 1024 * 1024;
const TIME_PATH: string = "/usr/bin/time";
const PRLIMIT_PATH: string = "/usr/bin/prlimit";
const BUILD_PHASE_MAX_ADDRESS_SPACE_KB: number = 2 * 1024 * 1024;
const RENDER_MAX_ADDRESS_SPACE_KB: number = 768 * 1024;
const BUILD_PHASE_RSS_REDUCTION_PERCENT_MIN: number = 40;
const BUILD_PHASE_RSS_REDUCTION_KB_MIN: number = 150 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const releaseRaytracerSourceRoot: string = join(repoRoot, "release-package-linux", "examples", "raytracer");
const raytracerEntryUnitId: string = "ray~tracer@main";
const buildPhaseArgs: readonly string[] = ["1", "1"];
const releaseValidationArgs: readonly string[] = ["64", "48"];

function compileEmitCSource(sourceRoot: string, outputDir: string, label: string): string {
    const sourcePath: string = join(outputDir, `${label}.c`);
    const binaryPath: string = join(outputDir, `${label}.out`);
    const sourceText: string = execBuildJsonCliSync(cliPath, [
        "emit-c",
        sourceRoot,
        "--entry",
        raytracerEntryUnitId,
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

function createNoGcBaselineSource(outputRoot: string): string {
    cpSync(releaseRaytracerSourceRoot, outputRoot, { recursive: true });
    const entryPath: string = join(outputRoot, "src", "ray~tracer@main.iw");
    const baselineSource: string = readFileSync(entryPath, "utf8")
        .replace(/^\s*\(import std~gc\)\s*$/m, "")
        .replace(/^\s*\(gc_collect\)\s*$/gm, "");
    writeFileSync(entryPath, baselineSource, "utf8");
    return outputRoot;
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

function isMemoryPressureFailure(measurement: NativeRunMeasurement): boolean {
    return /allocation failed|heap registry allocation failed/i.test(measurement.stderr);
}

function runMeasuredBinary(binaryPath: string, sourceRoot: string, label: string, outputDir: string, width: string, height: string, maxAddressSpaceKb: number): NativeRunMeasurement {
    const ppmPath: string = join(outputDir, `${label}-${width}x${height}.ppm`);
    const statsPath: string = join(outputDir, `${label}-${width}x${height}.time.txt`);
    const result: SpawnSyncReturns<string> = spawnSync(TIME_PATH, [
        "-v",
        "-o",
        statsPath,
        PRLIMIT_PATH,
        `--as=${String(maxAddressSpaceKb * 1024)}`,
        "--",
        binaryPath,
        join(sourceRoot, "utah_teapot.obj"),
        ppmPath,
        width,
        height
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    if (result.error !== undefined) {
        throw result.error;
    }

    const statsText: string = readFileSync(statsPath, "utf8");
    const ppmText: string | null = result.status === 0 ? readFileSync(ppmPath, "utf8") : null;
    return {
        label,
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        rssKb: parseMaximumResidentSetSize(statsText),
        ppmText
    };
}

const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-raytracer-memory-"));
try {
    const baselineSourceRoot: string = createNoGcBaselineSource(join(tempDir, "baseline-src"));
    const outputDir: string = join(tempDir, "out");
    mkdirSync(outputDir, { recursive: true });

    const optimizedBinaryPath: string = compileEmitCSource(releaseRaytracerSourceRoot, outputDir, "raytracer-optimized");
    const baselineBinaryPath: string = compileEmitCSource(baselineSourceRoot, outputDir, "raytracer-baseline");

    const optimizedBuildMeasurement: NativeRunMeasurement = runMeasuredBinary(
        optimizedBinaryPath,
        releaseRaytracerSourceRoot,
        "optimized-build-phase",
        outputDir,
        buildPhaseArgs[0],
        buildPhaseArgs[1],
        BUILD_PHASE_MAX_ADDRESS_SPACE_KB
    );
    const baselineBuildMeasurement: NativeRunMeasurement = runMeasuredBinary(
        baselineBinaryPath,
        baselineSourceRoot,
        "baseline-build-phase",
        outputDir,
        buildPhaseArgs[0],
        buildPhaseArgs[1],
        BUILD_PHASE_MAX_ADDRESS_SPACE_KB
    );

    strictEqual(optimizedBuildMeasurement.signal, null, `optimized build-phase signal mismatch stdout=${optimizedBuildMeasurement.stdout} stderr=${optimizedBuildMeasurement.stderr}`);
    strictEqual(baselineBuildMeasurement.signal, null, `baseline build-phase signal mismatch stdout=${baselineBuildMeasurement.stdout} stderr=${baselineBuildMeasurement.stderr}`);
    strictEqual(optimizedBuildMeasurement.status, 0, `optimized build-phase exit code mismatch stdout=${optimizedBuildMeasurement.stdout} stderr=${optimizedBuildMeasurement.stderr}`);
    strictEqual(baselineBuildMeasurement.status, 0, `baseline build-phase exit code mismatch stdout=${baselineBuildMeasurement.stdout} stderr=${baselineBuildMeasurement.stderr}`);
    strictEqual(optimizedBuildMeasurement.stdout, "", `optimized build-phase stdout mismatch\n${optimizedBuildMeasurement.stdout}`);
    strictEqual(baselineBuildMeasurement.stdout, "", `baseline build-phase stdout mismatch\n${baselineBuildMeasurement.stdout}`);
    strictEqual(optimizedBuildMeasurement.stderr, "", `optimized build-phase stderr mismatch\n${optimizedBuildMeasurement.stderr}`);
    strictEqual(baselineBuildMeasurement.stderr, "", `baseline build-phase stderr mismatch\n${baselineBuildMeasurement.stderr}`);
    strictEqual(optimizedBuildMeasurement.ppmText, baselineBuildMeasurement.ppmText, "optimized and baseline build-phase PPM output mismatch");
    ok(
        optimizedBuildMeasurement.rssKb + BUILD_PHASE_RSS_REDUCTION_KB_MIN <= baselineBuildMeasurement.rssKb,
        `optimized build-phase RSS should improve by at least ${BUILD_PHASE_RSS_REDUCTION_KB_MIN}KB, got optimized=${optimizedBuildMeasurement.rssKb}KB baseline=${baselineBuildMeasurement.rssKb}KB`
    );
    ok(
        optimizedBuildMeasurement.rssKb * 100 <= baselineBuildMeasurement.rssKb * (100 - BUILD_PHASE_RSS_REDUCTION_PERCENT_MIN),
        `optimized build-phase RSS should improve by at least ${BUILD_PHASE_RSS_REDUCTION_PERCENT_MIN}%, got optimized=${optimizedBuildMeasurement.rssKb}KB baseline=${baselineBuildMeasurement.rssKb}KB`
    );
    process.stdout.write(`raytracer-memory build-phase optimized=${optimizedBuildMeasurement.rssKb}KB baseline=${baselineBuildMeasurement.rssKb}KB ok\n`);

    const optimizedRenderMeasurement: NativeRunMeasurement = runMeasuredBinary(
        optimizedBinaryPath,
        releaseRaytracerSourceRoot,
        "optimized-release-render",
        outputDir,
        releaseValidationArgs[0],
        releaseValidationArgs[1],
        RENDER_MAX_ADDRESS_SPACE_KB
    );
    strictEqual(optimizedRenderMeasurement.signal, null, `optimized release render signal mismatch stdout=${optimizedRenderMeasurement.stdout} stderr=${optimizedRenderMeasurement.stderr}`);
    strictEqual(optimizedRenderMeasurement.status, 0, `optimized release render exit code mismatch stdout=${optimizedRenderMeasurement.stdout} stderr=${optimizedRenderMeasurement.stderr}`);
    strictEqual(optimizedRenderMeasurement.stdout, "", `optimized release render stdout mismatch\n${optimizedRenderMeasurement.stdout}`);
    strictEqual(optimizedRenderMeasurement.stderr, "", `optimized release render stderr mismatch\n${optimizedRenderMeasurement.stderr}`);
    ok(optimizedRenderMeasurement.ppmText !== null && optimizedRenderMeasurement.ppmText.startsWith("P3\n"), "optimized release render should produce a P3 PPM file");

    const baselineRenderMeasurement: NativeRunMeasurement = runMeasuredBinary(
        baselineBinaryPath,
        baselineSourceRoot,
        "baseline-release-render",
        outputDir,
        releaseValidationArgs[0],
        releaseValidationArgs[1],
        RENDER_MAX_ADDRESS_SPACE_KB
    );
    ok(
        baselineRenderMeasurement.status !== 0 && isMemoryPressureFailure(baselineRenderMeasurement),
        `no-GC baseline should exceed the ${RENDER_MAX_ADDRESS_SPACE_KB}KB release render cap, got status=${String(baselineRenderMeasurement.status)} signal=${String(baselineRenderMeasurement.signal)} stderr=${baselineRenderMeasurement.stderr}`
    );
    process.stdout.write(
        `raytracer-memory render-cap optimized=${optimizedRenderMeasurement.rssKb}KB baseline-failed=${baselineRenderMeasurement.rssKb}KB cap_kb=${RENDER_MAX_ADDRESS_SPACE_KB} ok\n`
    );
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}