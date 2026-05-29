import { deepStrictEqual, strictEqual } from "assert";
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams, type ExecFileSyncOptionsWithStringEncoding, type SpawnOptionsWithoutStdio, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import type { BackendPipelineName, BuildConfig, FrontendPipelineName } from "../BuildConfig";
import { buildNodeScriptInvocation } from "./NodeMemoryLimit";

type LegacyFrontendProfile = "optimized" | "no-optimized";
type LegacyBackendProfile = "c-backend" | "optimized-x64-backend" | "no-optimized-backend";

interface PreparedBuildJsonCliInvocation {
    readonly configPath: string;
    readonly cleanup: () => void;
}

type TestTargetName = NonNullable<BuildConfig["target"]>;

export interface BuildJsonCliResult {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
}

export function normalizeOutputLines(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string): boolean => line.length > 0);
}

export function exitCodeMatchesExpected(actualExitCode: number | null, expectedExitCode: number): boolean {
    if (actualExitCode === expectedExitCode) {
        return true;
    }
    return process.platform === "win32"
        && actualExitCode !== null
        && (actualExitCode & 0xff) === expectedExitCode;
}

export function assertExpectedExitCode(actualExitCode: number | null, expectedExitCode: number, message: string): void {
    strictEqual(
        exitCodeMatchesExpected(actualExitCode, expectedExitCode),
        true,
        `${message} actual=${String(actualExitCode)} expected=${expectedExitCode}`
    );
}

export function assertRunResult(result: BuildJsonCliResult, expectedStdoutLines: readonly string[], expectedExitCode: number, message: string): void {
    strictEqual(result.signal, null, `${message} signal mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertExpectedExitCode(result.status, expectedExitCode, `${message} exit code mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    deepStrictEqual(normalizeOutputLines(result.stdout), expectedStdoutLines, `${message} stdout mismatch\n${result.stdout}`);
    strictEqual(result.stderr, "", `${message} stderr mismatch\n${result.stderr}`);
}

function translateFrontendProfile(frontendProfile: LegacyFrontendProfile): FrontendPipelineName {
    return frontendProfile === "optimized" ? "optimize" : "nooptimize";
}

function translateBackendProfile(backendProfile: LegacyBackendProfile): BackendPipelineName {
    switch (backendProfile) {
        case "c-backend":
            return "c";
        case "optimized-x64-backend":
            return "x64native";
        case "no-optimized-backend":
            return "x64native-nooptimize";
    }
}

function inferTestTarget(): TestTargetName | undefined {
    const configuredTarget: string | undefined = process.env.IW_TEST_TARGET;
    if (configuredTarget === "linux-x64" || configuredTarget === "windows-x64") {
        return configuredTarget;
    }

    const entryPointPath: string | undefined = process.argv[1];
    if (entryPointPath !== undefined && /[\\/]Test-Windows[\\/]/.test(entryPointPath)) {
        return "windows-x64";
    }
    if (entryPointPath !== undefined && /[\\/]Test-Linux[\\/]/.test(entryPointPath)) {
        return "linux-x64";
    }
    return process.platform === "win32" ? "windows-x64" : "linux-x64";
}

function collectSiblingPackageDatabaseFiles(resolvedInputPath: string): string[] {
    const inputDirectory = dirname(resolvedInputPath);
    const inputFileName = basename(resolvedInputPath);
    const packageDelimiterIndex = inputFileName.indexOf("@");
    if (packageDelimiterIndex < 0) {
        return [];
    }

    const packagePrefix = inputFileName.slice(0, packageDelimiterIndex);
    return readdirSync(inputDirectory).filter((entryName) => entryName.startsWith(`${packagePrefix}$`) && entryName.endsWith(".json"));
}

function buildDirectoriesEntry(inputPath: string): BuildConfig["directories"][number] {
    const resolvedInputPath = resolve(inputPath);
    const stats = statSync(resolvedInputPath);
    if (stats.isFile()) {
        return {
            path: dirname(resolvedInputPath),
            files: [basename(resolvedInputPath), ...collectSiblingPackageDatabaseFiles(resolvedInputPath)]
        };
    }
    if (stats.isDirectory()) {
        return { path: resolvedInputPath };
    }
    throw new Error(`Expected a file or directory, got '${resolvedInputPath}'`);
}

function translateLegacyCliArgsToBuildConfig(legacyArgs: readonly string[]): BuildConfig {
    if (legacyArgs.length < 2) {
        throw new Error(`Expected at least a command and input path, got '${legacyArgs.join(" ")}'`);
    }

    const [commandRaw, inputPath, ...rest] = legacyArgs;
    if (
        commandRaw !== "check"
        && commandRaw !== "run"
        && commandRaw !== "emit-backend-ir"
        && commandRaw !== "emit-c"
        && commandRaw !== "emit-x64"
        && commandRaw !== "pack-lib"
    ) {
        throw new Error(`Unsupported legacy CLI command '${commandRaw}' in test harness`);
    }

    let main: string | undefined;
    let output: string | undefined;
    let precompiledLibs: string[] = [];
    let frontendProfile: LegacyFrontendProfile = "optimized";
    let backendProfile: LegacyBackendProfile = commandRaw === "pack-lib" ? "no-optimized-backend" : "c-backend";
    let noBaseLib = false;
    let programArgs: string[] = [];
    let monomorphizationMaxRounds: number | undefined;
    const additionalInputPaths: string[] = [];

    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === "--") {
            if (commandRaw !== "run") {
                throw new Error("legacy test harness only allows '--' with run");
            }
            programArgs = rest.slice(index + 1);
            break;
        }
        if (arg === "--entry") {
            const value = rest[index + 1];
            if (value === undefined) {
                throw new Error("--entry requires a unit id value");
            }
            main = value;
            index += 1;
            continue;
        }
        if (arg === "--out") {
            const value = rest[index + 1];
            if (value === undefined) {
                throw new Error("--out requires a path value");
            }
            output = resolve(value);
            index += 1;
            continue;
        }
        if (arg === "--frontend-profile") {
            const value = rest[index + 1];
            if (value !== "optimized" && value !== "no-optimized") {
                throw new Error(`Invalid legacy --frontend-profile value '${value ?? ""}'`);
            }
            frontendProfile = value;
            index += 1;
            continue;
        }
        if (arg === "--backend-profile") {
            const value = rest[index + 1];
            if (value !== "c-backend" && value !== "optimized-x64-backend" && value !== "no-optimized-backend") {
                throw new Error(`Invalid legacy --backend-profile value '${value ?? ""}'`);
            }
            backendProfile = value;
            index += 1;
            continue;
        }
        if (arg === "--lib") {
            const value = rest[index + 1];
            if (value === undefined) {
                throw new Error("--lib requires a path value");
            }
            precompiledLibs.push(resolve(value));
            index += 1;
            continue;
        }
        if (arg === "--include") {
            const value = rest[index + 1];
            if (value === undefined) {
                throw new Error("--include requires an input path value");
            }
            additionalInputPaths.push(value);
            index += 1;
            continue;
        }
        if (arg === "--no-base-lib") {
            noBaseLib = true;
            continue;
        }
        if (arg === "--monomorphization-max-rounds") {
            const value = rest[index + 1];
            if (value === undefined) {
                throw new Error("--monomorphization-max-rounds requires an integer value");
            }
            const parsedValue = Number.parseInt(value, 10);
            if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
                throw new Error(`Invalid legacy --monomorphization-max-rounds value '${value}'`);
            }
            monomorphizationMaxRounds = parsedValue;
            index += 1;
            continue;
        }
        throw new Error(`Unsupported legacy CLI option '${arg}' in test harness`);
    }

    const target: TestTargetName | undefined = inferTestTarget();
    return {
        mode: commandRaw,
        ...(target === undefined ? {} : { target }),
        directories: [inputPath, ...additionalInputPaths].map((entryPath) => buildDirectoriesEntry(entryPath)),
        main,
        output,
        precompiledLibs,
        ffiLibs: [],
        frontendPipeline: translateFrontendProfile(frontendProfile),
        backendPipeline: translateBackendProfile(backendProfile),
        noBaseLib,
        programArgs,
        monomorphizationMaxRounds
    };
}

function prepareBuildJsonCliInvocation(legacyArgs: readonly string[]): PreparedBuildJsonCliInvocation {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-test-cli-"));
    const configPath = join(tempDir, "build-iw.json");
    const config = translateLegacyCliArgsToBuildConfig(legacyArgs);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return {
        configPath,
        cleanup: () => rmSync(tempDir, { recursive: true, force: true })
    };
}

export function execBuildJsonCliSync(cliPath: string, legacyArgs: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string {
    const prepared = prepareBuildJsonCliInvocation(legacyArgs);
    try {
        const invocation = buildNodeScriptInvocation(cliPath, [prepared.configPath]);
        return execFileSync(invocation.command, invocation.args, options);
    } finally {
        prepared.cleanup();
    }
}

export function spawnBuildJsonCliSync(cliPath: string, legacyArgs: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
    const prepared = prepareBuildJsonCliInvocation(legacyArgs);
    try {
        const invocation = buildNodeScriptInvocation(cliPath, [prepared.configPath]);
        const result = spawnSync(invocation.command, invocation.args, options);
        if (result.error !== undefined) {
            throw result.error;
        }
        return result;
    } finally {
        prepared.cleanup();
    }
}

export function spawnBuildJsonCli(cliPath: string, legacyArgs: readonly string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams {
    const prepared = prepareBuildJsonCliInvocation(legacyArgs);
    const invocation = buildNodeScriptInvocation(cliPath, [prepared.configPath]);
    const child = spawn(invocation.command, invocation.args, options) as ChildProcessWithoutNullStreams;
    const cleanup = (): void => {
        prepared.cleanup();
    };
    child.once("exit", cleanup);
    child.once("error", cleanup);
    return child;
}
