// Real RSS regression coverage for stdlib memory-hot paths on Linux.
import { ok, strictEqual } from "assert";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execBuildJsonCliSync } from "./BuildJsonCliHarness";

interface MemoryRiskCase {
    readonly name: string;
    readonly optimizedFileName: string;
    readonly optimizedEntryUnitId: string;
    readonly baselineFileName: string;
    readonly baselineEntryUnitId: string;
    readonly minimumRssReductionPercent: number;
    readonly minimumRssReductionKb: number;
    readonly maxAddressSpaceKb: number;
}

interface NativeRunMeasurement {
    readonly label: string;
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly rssKb: number;
}

const TEST_TIMEOUT_MS: number = 900000;
const MAX_BUFFER_BYTES: number = 64 * 1024 * 1024;
const TIME_PATH: string = "/usr/bin/time";
const PRLIMIT_PATH: string = "/usr/bin/prlimit";
const CORE_MAX_ADDRESS_SPACE_KB: number = 4 * 1024 * 1024;
const SET_UPDATE_MAX_ADDRESS_SPACE_KB: number = 1024 * 1024;
const LIST_SORT_MAX_ADDRESS_SPACE_KB: number = 2 * 1024 * 1024;
const LIST_CONCAT_MAX_ADDRESS_SPACE_KB: number = 512 * 1024;
const STRING_CONCAT_MAX_ADDRESS_SPACE_KB: number = 4 * 1024 * 1024;
const STRING_OPS_MAX_ADDRESS_SPACE_KB: number = 1024 * 1024;
const CORE_RSS_REDUCTION_PERCENT_MIN: number = 20;
const CORE_RSS_REDUCTION_KB_MIN: number = 2048;
const SET_UPDATE_RSS_REDUCTION_PERCENT_MIN: number = 10;
const SET_UPDATE_RSS_REDUCTION_KB_MIN: number = 10240;
const LIST_SORT_RSS_REDUCTION_PERCENT_MIN: number = 20;
const LIST_SORT_RSS_REDUCTION_KB_MIN: number = 4096;
const LIST_CONCAT_RSS_REDUCTION_PERCENT_MIN: number = 20;
const LIST_CONCAT_RSS_REDUCTION_KB_MIN: number = 16384;
const STRING_CONCAT_RSS_REDUCTION_PERCENT_MIN: number = 20;
const STRING_CONCAT_RSS_REDUCTION_KB_MIN: number = 16384;
const STRING_OPS_RSS_REDUCTION_PERCENT_MIN: number = 35;
const STRING_OPS_RSS_REDUCTION_KB_MIN: number = 4096;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const fixtureDir: string = join(repoRoot, "src", "Test-Linux", "Fixtures", "std-memory-risk");
const memoryRiskCases: readonly MemoryRiskCase[] = [
    {
        name: "core",
        optimizedFileName: "test~std~memory~optimized@main.iw",
        optimizedEntryUnitId: "test~std~memory~optimized@main",
        baselineFileName: "test~std~memory~baseline@main.iw",
        baselineEntryUnitId: "test~std~memory~baseline@main",
        minimumRssReductionPercent: CORE_RSS_REDUCTION_PERCENT_MIN,
        minimumRssReductionKb: CORE_RSS_REDUCTION_KB_MIN,
        maxAddressSpaceKb: CORE_MAX_ADDRESS_SPACE_KB
    },
    {
        name: "set-update",
        optimizedFileName: "test~std~memory~set~update~optimized@main.iw",
        optimizedEntryUnitId: "test~std~memory~set~update~optimized@main",
        baselineFileName: "test~std~memory~set~update~baseline@main.iw",
        baselineEntryUnitId: "test~std~memory~set~update~baseline@main",
        minimumRssReductionPercent: SET_UPDATE_RSS_REDUCTION_PERCENT_MIN,
        minimumRssReductionKb: SET_UPDATE_RSS_REDUCTION_KB_MIN,
        maxAddressSpaceKb: SET_UPDATE_MAX_ADDRESS_SPACE_KB
    },
    {
        name: "list-sorted",
        optimizedFileName: "test~std~memory~list~sorted~optimized@main.iw",
        optimizedEntryUnitId: "test~std~memory~list~sorted~optimized@main",
        baselineFileName: "test~std~memory~list~sorted~baseline@main.iw",
        baselineEntryUnitId: "test~std~memory~list~sorted~baseline@main",
        minimumRssReductionPercent: LIST_SORT_RSS_REDUCTION_PERCENT_MIN,
        minimumRssReductionKb: LIST_SORT_RSS_REDUCTION_KB_MIN,
        maxAddressSpaceKb: LIST_SORT_MAX_ADDRESS_SPACE_KB
    },
    {
        name: "list-concat",
        optimizedFileName: "test~std~memory~list~concat~optimized@main.iw",
        optimizedEntryUnitId: "test~std~memory~list~concat~optimized@main",
        baselineFileName: "test~std~memory~list~concat~baseline@main.iw",
        baselineEntryUnitId: "test~std~memory~list~concat~baseline@main",
        minimumRssReductionPercent: LIST_CONCAT_RSS_REDUCTION_PERCENT_MIN,
        minimumRssReductionKb: LIST_CONCAT_RSS_REDUCTION_KB_MIN,
        maxAddressSpaceKb: LIST_CONCAT_MAX_ADDRESS_SPACE_KB
    },
    {
        name: "string-concat",
        optimizedFileName: "test~std~memory~string~concat~optimized@main.iw",
        optimizedEntryUnitId: "test~std~memory~string~concat~optimized@main",
        baselineFileName: "test~std~memory~string~concat~baseline@main.iw",
        baselineEntryUnitId: "test~std~memory~string~concat~baseline@main",
        minimumRssReductionPercent: STRING_CONCAT_RSS_REDUCTION_PERCENT_MIN,
        minimumRssReductionKb: STRING_CONCAT_RSS_REDUCTION_KB_MIN,
        maxAddressSpaceKb: STRING_CONCAT_MAX_ADDRESS_SPACE_KB
    },
    {
        name: "string-ops",
        optimizedFileName: "test~std~memory~string~ops~optimized@main.iw",
        optimizedEntryUnitId: "test~std~memory~string~ops~optimized@main",
        baselineFileName: "test~std~memory~string~ops~baseline@main.iw",
        baselineEntryUnitId: "test~std~memory~string~ops~baseline@main",
        minimumRssReductionPercent: STRING_OPS_RSS_REDUCTION_PERCENT_MIN,
        minimumRssReductionKb: STRING_OPS_RSS_REDUCTION_KB_MIN,
        maxAddressSpaceKb: STRING_OPS_MAX_ADDRESS_SPACE_KB
    }
];

function compileEmitCFixture(fileName: string, entryUnitId: string, outputDir: string): string {
    const inputPath: string = join(fixtureDir, fileName);
    const sourcePath: string = join(outputDir, `${entryUnitId}.c`);
    const binaryPath: string = join(outputDir, `${entryUnitId}.out`);
    const sourceText: string = execBuildJsonCliSync(cliPath, [
        "emit-c",
        inputPath,
        "--entry",
        entryUnitId,
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

function isAllocationFailure(measurement: NativeRunMeasurement): boolean {
    return /allocation failed/i.test(measurement.stderr);
}

function getMaxAddressSpaceBytes(memoryRiskCase: MemoryRiskCase): string {
    const envKey: string = `IW_STD_MEMORY_RISK_MAX_AS_KB_${memoryRiskCase.name.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`;
    const rawOverride: string | undefined = process.env[envKey] ?? process.env.IW_STD_MEMORY_RISK_MAX_AS_KB;
    if (rawOverride !== undefined) {
        const parsedOverrideKb: number = Number.parseInt(rawOverride, 10);
        if (!Number.isFinite(parsedOverrideKb) || parsedOverrideKb <= 0) {
            throw new Error(`Invalid ${envKey}='${rawOverride}'`);
        }
        return String(parsedOverrideKb * 1024);
    }
    return String(memoryRiskCase.maxAddressSpaceKb * 1024);
}

function runMeasuredBinary(binaryPath: string, label: string, outputDir: string, memoryRiskCase: MemoryRiskCase): NativeRunMeasurement {
    const statsPath: string = join(outputDir, `${label}.time.txt`);
    const maxAddressSpaceBytes: string = getMaxAddressSpaceBytes(memoryRiskCase);
    const result: SpawnSyncReturns<string> = spawnSync(TIME_PATH, ["-v", "-o", statsPath, PRLIMIT_PATH, `--as=${maxAddressSpaceBytes}`, "--", binaryPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    if (result.error !== undefined) {
        throw result.error;
    }

    const statsText: string = readFileSync(statsPath, "utf8");
    return {
        label,
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        rssKb: parseMaximumResidentSetSize(statsText)
    };
}

const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-std-memory-risk-"));
try {
    const failureMessages: string[] = [];
    for (const memoryRiskCase of memoryRiskCases) {
        try {
            const caseOutputDir: string = join(tempDir, memoryRiskCase.name);
            mkdirSync(caseOutputDir, { recursive: true });

            const optimizedBinaryPath: string = compileEmitCFixture(memoryRiskCase.optimizedFileName, memoryRiskCase.optimizedEntryUnitId, caseOutputDir);
            const baselineBinaryPath: string = compileEmitCFixture(memoryRiskCase.baselineFileName, memoryRiskCase.baselineEntryUnitId, caseOutputDir);

            const optimizedMeasurement: NativeRunMeasurement = runMeasuredBinary(optimizedBinaryPath, `${memoryRiskCase.name}-optimized`, caseOutputDir, memoryRiskCase);
            const baselineMeasurement: NativeRunMeasurement = runMeasuredBinary(baselineBinaryPath, `${memoryRiskCase.name}-baseline`, caseOutputDir, memoryRiskCase);
            const maxAddressSpaceBytes: string = getMaxAddressSpaceBytes(memoryRiskCase);

            strictEqual(
                optimizedMeasurement.signal,
                null,
                `${memoryRiskCase.name} optimized workload signal mismatch under address-space cap ${maxAddressSpaceBytes} bytes stdout=${optimizedMeasurement.stdout} stderr=${optimizedMeasurement.stderr}`
            );
            strictEqual(optimizedMeasurement.stderr, "", `${memoryRiskCase.name} optimized workload stderr mismatch\n${optimizedMeasurement.stderr}`);

            if (isAllocationFailure(baselineMeasurement)) {
                ok(baselineMeasurement.status !== optimizedMeasurement.status || baselineMeasurement.stdout !== optimizedMeasurement.stdout, `${memoryRiskCase.name} baseline hit allocation failure unexpectedly without observable divergence`);
                process.stdout.write(
                    `std-memory-risk ${memoryRiskCase.name} optimized=${optimizedMeasurement.rssKb}KB baseline-hit-cap=${baselineMeasurement.rssKb}KB cap_bytes=${maxAddressSpaceBytes} ok\n`
                );
                continue;
            }

            strictEqual(
                baselineMeasurement.signal,
                null,
                `${memoryRiskCase.name} baseline workload signal mismatch under address-space cap ${maxAddressSpaceBytes} bytes stdout=${baselineMeasurement.stdout} stderr=${baselineMeasurement.stderr}`
            );
            strictEqual(baselineMeasurement.stderr, "", `${memoryRiskCase.name} baseline workload stderr mismatch\n${baselineMeasurement.stderr}`);
            strictEqual(optimizedMeasurement.stdout, baselineMeasurement.stdout, `${memoryRiskCase.name} optimized and baseline stdout mismatch\noptimized=${optimizedMeasurement.stdout}\nbaseline=${baselineMeasurement.stdout}`);
            strictEqual(optimizedMeasurement.status, baselineMeasurement.status, `${memoryRiskCase.name} optimized and baseline exit code mismatch\noptimized=${String(optimizedMeasurement.status)}\nbaseline=${String(baselineMeasurement.status)}`);
            ok(
                optimizedMeasurement.rssKb + memoryRiskCase.minimumRssReductionKb <= baselineMeasurement.rssKb,
                `${memoryRiskCase.name} optimized RSS should improve by at least ${memoryRiskCase.minimumRssReductionKb}KB, got optimized=${optimizedMeasurement.rssKb}KB baseline=${baselineMeasurement.rssKb}KB`
            );
            ok(
                optimizedMeasurement.rssKb * 100 <= baselineMeasurement.rssKb * (100 - memoryRiskCase.minimumRssReductionPercent),
                `${memoryRiskCase.name} optimized RSS should improve by at least ${memoryRiskCase.minimumRssReductionPercent}%, got optimized=${optimizedMeasurement.rssKb}KB baseline=${baselineMeasurement.rssKb}KB`
            );

            process.stdout.write(`std-memory-risk ${memoryRiskCase.name} optimized=${optimizedMeasurement.rssKb}KB baseline=${baselineMeasurement.rssKb}KB ok\n`);
        } catch (error) {
            const message: string = error instanceof Error ? error.stack ?? error.message : String(error);
            failureMessages.push(`[${memoryRiskCase.name}] ${message}`);
        }
    }

    if (failureMessages.length > 0) {
        throw new Error(`std-memory-risk failures\n${failureMessages.join("\n\n")}`);
    }
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}