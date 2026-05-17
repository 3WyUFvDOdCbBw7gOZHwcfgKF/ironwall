#!/usr/bin/env node

import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, extname, join, resolve } from "path";
import { ProgramNode } from "./AstNode";
import { getBaseLibSourceRoots } from "./BaseLib";
import { formatErrorAsJson } from "./Diagnostics";
import { analyzeProgramDependencies } from "./DependencyAnalysis";
import { formatIronwallVersionLine, IRONWALL_VERSION } from "./IronwallVersion";
import { type BackendPipelineName, type BuildMode, loadBuildConfig, resolveBuildConfigPath, stageBuildInputs, type FrontendPipelineName, type StagedBuildFileMapping } from "./BuildConfig";
import { execToolchainOrThrow, getPlatformToolchain } from "./PlatformToolchain";
import { isWindowsTarget, normalizeBuildTarget, type BuildTarget } from "./Target";
import { getCompilationUnitMetadata } from "./ModuleMetadata";
import {
    generateCFromFinalBackendIR as generateLinuxCFromFinalBackendIR,
    generateX64NativeSupportCFromFinalBackendIR as generateLinuxX64NativeSupportCFromFinalBackendIR
} from "./backend-linux/Backend-Linux-C";
import type { FinalBackendIRProgram, X64LaidOutProgram, X64TextualAssemblyProgram } from "./backend-linux/Backend-Linux-IR-Shared";
import { buildX64TextualAssembly as buildLinuxX64TextualAssembly } from "./backend-linux/Backend-Linux-x64-TextualAssembly";
import {
    generateCFromFinalBackendIR as generateWindowsCFromFinalBackendIR,
    generateX64NativeSupportCFromFinalBackendIR as generateWindowsX64NativeSupportCFromFinalBackendIR
} from "./backend-windows/Backend-Windows-C";
import type {
    FinalBackendIRProgram as WindowsFinalBackendIRProgram,
    X64LaidOutProgram as WindowsX64LaidOutProgram,
    X64TextualAssemblyProgram as WindowsX64TextualAssemblyProgram
} from "./backend-windows/Backend-Windows-IR-Shared";
import { buildX64TextualAssembly as buildWindowsX64TextualAssembly } from "./backend-windows/Backend-Windows-x64-TextualAssembly";
import { formatFinalBackendIRProgram, formatX64TextualAssemblyProgram } from "./Lowering-Debug";
import { performOptimizedCBackendLoweringStageCFromArtifacts, performLoweringStageCFromArtifacts, performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts } from "./Lowering-Pass-10-PackageBackendIR";
import { performNoOptimizeCBackendLoweringStageCFromArtifacts, performNoOptimizeLoweringStageCFromArtifacts, performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts } from "./Lowering-NoOptimize-Pass-10-PackageBackendIR";
import {
    performLoweringStageCFromArtifacts as performWindowsLoweringStageCFromArtifacts,
    performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts as performWindowsOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts
} from "./Lowering-Windows-Pass-10-PackageBackendIR";
import {
    performNoOptimizeLoweringStageCFromArtifacts as performWindowsNoOptimizeLoweringStageCFromArtifacts,
    performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts as performWindowsNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts
} from "./Lowering-Windows-NoOptimize-Pass-10-PackageBackendIR";
import { loadProgramAstWithSources } from "./ModuleLoader";
import {
    buildPrecompiledLibraryPackagingPlan,
    createPrecompiledLibraryArchive,
    disposeLoadedPrecompiledLibraries,
    loadPrecompiledLibraryArchives,
    type LoadedPrecompiledLibrary,
    type PrecompiledLibraryCompiledUnitArtifact,
    type PrecompiledUnitBuildInfo,
    type PrecompiledUnitInputSignature,
    type PrecompiledLibrarySnapshotSource
} from "./PrecompiledLib";
import {
    type CompilerOutputBuildInfo,
    type CompilerOutputReuseRequest,
    computeCompilerSha256,
    computeExternalFrontendCommandFingerprint,
    computeHashedFileRecords,
    hashTextSha256,
    tryReuseCachedCompilerOutput,
    tryLoadCachedPackLibUnit,
    writeCompilerOutputBuildInfo,
    writeCachedPackLibUnit
} from "./SeparateCompileCache";
import { printTypeValue } from "./Typecheck-Core";
import { getMonomorphizedArtifacts, performTypeChecking, TypeCheckingOptions } from "./Typecheck-Pipeline";

type CommandName = BuildMode;
type FrontendProfile = "optimized" | "no-optimized";
type BackendProfile = "c-backend" | "optimized-x64-backend" | "no-optimized-backend";
type CacheableCommand = "check" | "emit-backend-ir" | "emit-c" | "emit-x64";

interface CliOptions {
    readonly command: CommandName;
    readonly target: BuildTarget;
    readonly inputPath: string;
    readonly configPath: string;
    readonly outputPath?: string;
    readonly entryUnitId?: string;
    readonly monomorphizationMaxRounds?: number;
    readonly disableBaseLibAutoLoad: boolean;
    readonly frontendProfile: FrontendProfile;
    readonly backendProfile: BackendProfile;
    readonly libPaths: readonly string[];
    readonly ffiLibPaths: readonly string[];
    readonly programArgs: readonly string[];
    readonly stagedFileMappings: readonly StagedBuildFileMapping[];
    readonly cleanupInputPath: () => void;
}

interface ProgramRunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly status: number;
}

function usage(): string {
    return [
        "Ironwall CLI",
        `Version: ${IRONWALL_VERSION}`,
        "",
        "Usage:",
        "  ironwall --version",
        "  ironwall path/to/build-iw.json",
        "",
        "The CLI only accepts a file named build-iw.json.",
        "All compilation inputs, pipeline selection, entry selection, output path, and precompiled libs",
        "must be declared inside that JSON file.",
    ].join("\n");
}

function mapFrontendPipeline(frontendPipeline: FrontendPipelineName): FrontendProfile {
    return frontendPipeline === "optimize" ? "optimized" : "no-optimized";
}

function mapBackendPipeline(backendPipeline: BackendPipelineName): BackendProfile {
    switch (backendPipeline) {
        case "c":
            return "c-backend";
        case "x64native":
            return "optimized-x64-backend";
        case "x64native-nooptimize":
            return "no-optimized-backend";
    }
}

function parseArgs(argv: readonly string[]): CliOptions {
    if (argv.includes("--version") || argv.includes("-v")) {
        process.stdout.write(`${formatIronwallVersionLine()}\n`);
        process.exit(0);
    }

    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(usage());
        process.exit(0);
    }

    if (argv.length !== 1) {
        throw new Error(`Expected exactly one build-iw.json path.\n\n${usage()}`);
    }

    const build = loadBuildConfig(argv[0]);
    const stagedInput = stageBuildInputs(build);

    return {
        command: build.config.mode,
        target: normalizeBuildTarget(build.config.target),
        inputPath: stagedInput.inputPath,
        configPath: build.configPath,
        outputPath: build.config.output === undefined ? undefined : resolveBuildConfigPath(build.configPath, build.config.output),
        entryUnitId: build.config.main,
        monomorphizationMaxRounds: build.config.monomorphizationMaxRounds,
        disableBaseLibAutoLoad: build.config.noBaseLib,
        frontendProfile: mapFrontendPipeline(build.config.frontendPipeline),
        backendProfile: mapBackendPipeline(build.config.backendPipeline),
        libPaths: build.config.precompiledLibs.map((libPath) => resolveBuildConfigPath(build.configPath, libPath)),
        ffiLibPaths: build.config.ffiLibs.map((libPath) => resolveBuildConfigPath(build.configPath, libPath)),
        programArgs: build.config.programArgs,
        stagedFileMappings: stagedInput.fileMappings,
        cleanupInputPath: stagedInput.cleanup
    };
}

function buildTypecheckOptions(options: CliOptions, precompiledLibraries: readonly LoadedPrecompiledLibrary[]): TypeCheckingOptions {
    return {
        monomorphizationMaxRounds: options.monomorphizationMaxRounds,
        disableBaseLibAutoLoad: options.disableBaseLibAutoLoad,
        precompiledLibraries,
    };
}

function validatePrecompiledLibraryTargets(target: BuildTarget, precompiledLibraries: readonly LoadedPrecompiledLibrary[]): void {
    for (const library of precompiledLibraries) {
        if (library.manifest.target !== target) {
            throw new Error(`precompiled lib '${library.archivePath}' targets '${library.manifest.target}', but build target is '${target}'`);
        }
    }
}

function writeOutput(text: string, outputPath?: string): void {
    if (outputPath) {
        writeFileSync(resolve(outputPath), text, "utf8");
        return;
    }
    process.stdout.write(text);
    if (!text.endsWith("\n")) {
        process.stdout.write("\n");
    }
}

function writeRawOutput(text: string, outputPath?: string): void {
    if (outputPath) {
        writeFileSync(resolve(outputPath), text, "utf8");
        return;
    }
    if (text.length > 0) {
        process.stdout.write(text);
    }
}

const WSL_LOCALHOST_PROXY_WARNING = "wsl: A localhost proxy configuration was detected but not mirrored into WSL. WSL in NAT mode does not support localhost proxies.";

function sanitizeCapturedStderr(text: string): string {
    const withoutNulls = text.replace(/\u0000/g, "");
    const filteredLines = withoutNulls
        .split(/\r?\n/)
        .filter((line) => line.trim() !== WSL_LOCALHOST_PROXY_WARNING);
    return filteredLines.join("\n").trimEnd();
}

function extractExecErrorText(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const stdout = "stdout" in error
        ? (error as Error & { stdout?: string | Buffer }).stdout
        : undefined;
    const stderr = "stderr" in error
        ? (error as Error & { stderr?: string | Buffer }).stderr
        : undefined;
    if (Buffer.isBuffer(stdout)) {
        const text = sanitizeCapturedStderr(stdout.toString("utf8")).trim();
        if (text.length > 0) {
            return text;
        }
    }
    if (typeof stdout === "string") {
        const text = sanitizeCapturedStderr(stdout).trim();
        if (text.length > 0) {
            return text;
        }
    }
    if (Buffer.isBuffer(stderr)) {
        const text = sanitizeCapturedStderr(stderr.toString("utf8")).trim();
        if (text.length > 0) {
            return text;
        }
    }
    if (typeof stderr === "string") {
        const text = sanitizeCapturedStderr(stderr).trim();
        if (text.length > 0) {
            return text;
        }
    }
    return error.message;
}

function runBinary(target: BuildTarget, binaryPath: string, programArgs: readonly string[]): ProgramRunResult {
    const toolchain = getPlatformToolchain(target);
    const invocation = toolchain.runBinaryInvocation(binaryPath, programArgs);
    const result = spawnSync(invocation.command, [...invocation.args], {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"]
    });

    if (result.error !== undefined) {
        throw new Error(result.error.message);
    }
    if (result.signal !== null) {
        const stderrText = typeof result.stderr === "string" ? sanitizeCapturedStderr(result.stderr).trim() : "";
        throw new Error(stderrText.length > 0 ? stderrText : `Program terminated by signal ${result.signal}`);
    }

    return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? sanitizeCapturedStderr(result.stderr) : "",
        status: result.status ?? 1
    };
}

function compileAndRunProgram(target: BuildTarget, source: string, ffiLibPaths: readonly string[], programArgs: readonly string[]): ProgramRunResult {
    const toolchain = getPlatformToolchain(target);
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-run-"));
    try {
        const sourcePath = join(tempDir, "program.c");
        const binaryPath = join(tempDir, `program${toolchain.executableSuffix}`);
        writeFileSync(sourcePath, source, "utf8");
        execToolchainOrThrow(
            toolchain.cCompileCommand,
            toolchain.cCompileArgs(sourcePath, ffiLibPaths, binaryPath),
            "C compilation",
            extractExecErrorText
        );

        try {
            return runBinary(target, binaryPath, programArgs);
        } catch (error) {
            throw new Error(extractExecErrorText(error));
        }
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

interface LinuxX64ExecutableStageCResult {
    readonly targetPlatform: "linux";
    readonly pass10: FinalBackendIRProgram;
    readonly pass10Support: FinalBackendIRProgram;
    readonly pass18x64layout: X64LaidOutProgram;
    readonly pass22x64emit: X64TextualAssemblyProgram;
}

interface WindowsX64ExecutableStageCResult {
    readonly targetPlatform: "windows";
    readonly pass10: WindowsFinalBackendIRProgram;
    readonly pass10Support: WindowsFinalBackendIRProgram;
    readonly pass18x64layout: WindowsX64LaidOutProgram;
    readonly pass22x64emit: WindowsX64TextualAssemblyProgram;
}

type X64ExecutableStageCResult = LinuxX64ExecutableStageCResult | WindowsX64ExecutableStageCResult;

type NativeLinkSourceInput = {
    readonly kind: "c" | "asm";
    readonly sourcePath: string;
    readonly objectPath: string;
    readonly label: string;
};

type ScopedX64UnitArtifacts = {
    readonly assemblyText: string;
    readonly supportText: string;
};

function applyScopedSymbolSuffix(text: string, scopeSuffix: string, patterns: readonly RegExp[]): string {
    return patterns.reduce((currentText, pattern) => currentText.replace(pattern, (symbol: string) => `${symbol}__unit_${scopeSuffix}`), text);
}

function scopeX64UnitArtifacts(assemblyText: string, supportText: string, scopeSuffix: string): ScopedX64UnitArtifacts {
    const sharedPatterns = [
        /__iw_x64_call_[A-Za-z0-9_]+/g,
        /__iw_x64_closure_call_[A-Za-z0-9_]+/g,
        /__iw_x64_make_[A-Za-z0-9_]+/g,
        /__iw_x64_direct_value_[A-Za-z0-9_]+/g,
        /__iw_x64_alloc_[A-Za-z0-9_]+/g,
        /__iw_x64_object_get_[A-Za-z0-9_]+/g,
        /__iw_x64_object_set_[A-Za-z0-9_]+/g,
        /__iw_x64_slot_load_[A-Za-z0-9_]+/g,
        /__iw_x64_slot_store_[A-Za-z0-9_]+/g,
        /__iw_x64_union_inject_[A-Za-z0-9_]+/g,
        /__iw_x64_union_has_tag_[A-Za-z0-9_]+/g,
        /__iw_x64_union_get_payload_[A-Za-z0-9_]+/g,
        /__iw_x64_gc_frame_init_[A-Za-z0-9_]+/g,
        /iw_text_value_[A-Za-z0-9_]+/g,
    ] as const;
    return {
        assemblyText: applyScopedSymbolSuffix(assemblyText, scopeSuffix, sharedPatterns),
        supportText: applyScopedSymbolSuffix(supportText, scopeSuffix, [...sharedPatterns, /iw_text_bytes_[A-Za-z0-9_]+/g])
    };
}

function generateTargetX64NativeSupportC(
    _target: BuildTarget,
    stageC: X64ExecutableStageCResult,
    assemblyText: string,
    options: Parameters<typeof generateLinuxX64NativeSupportCFromFinalBackendIR>[4] = {}
): string {
    return stageC.targetPlatform === "windows"
        ? generateWindowsX64NativeSupportCFromFinalBackendIR(
            stageC.pass10Support,
            "",
            stageC.pass18x64layout.layouts.classes,
            assemblyText,
            options
        )
        : generateLinuxX64NativeSupportCFromFinalBackendIR(
            stageC.pass10Support,
            "",
            stageC.pass18x64layout.layouts.classes,
            assemblyText,
            options
        );
}

function buildTargetX64TextualAssembly(target: BuildTarget, entryText: string, functionTexts: readonly string[]): string {
    return isWindowsTarget(target)
        ? buildWindowsX64TextualAssembly(entryText, functionTexts)
        : buildLinuxX64TextualAssembly(entryText, functionTexts);
}

function generateTargetCFromFinalBackendIR(target: BuildTarget, program: FinalBackendIRProgram): string {
    return isWindowsTarget(target)
        ? generateWindowsCFromFinalBackendIR(program)
        : generateLinuxCFromFinalBackendIR(program);
}

function buildAdditionalInputPaths(options: CliOptions, _libraries: readonly LoadedPrecompiledLibrary[]): readonly string[] {
    return [
        ...(options.disableBaseLibAutoLoad ? [] : getBaseLibSourceRoots(options.target))
    ];
}

function buildOriginalPathResolver(fileMappings: readonly StagedBuildFileMapping[]): (filePath: string) => string {
    const originalPathByStagedPath = new Map(
        fileMappings.map((mapping) => [resolve(mapping.stagedPath), resolve(mapping.originalPath)] as const)
    );
    return (filePath: string) => originalPathByStagedPath.get(resolve(filePath)) ?? resolve(filePath);
}

function collectUnitOriginalSourceFiles(
    unitProgram: ProgramNode,
    unitId: string,
    sourceFilesByUnitId: ReadonlyMap<string, readonly string[]>,
    resolveOriginalPath: (filePath: string) => string
): readonly string[] {
    const sourceFileSet = new Set(sourceFilesByUnitId.get(unitId) ?? []);
    for (const expression of unitProgram.topLevelExpressions) {
        const filePath = getCompilationUnitMetadata(expression)?.filePath;
        if (filePath === null || filePath === undefined) {
            continue;
        }
        sourceFileSet.add(resolveOriginalPath(filePath));
    }
    return Array.from(sourceFileSet).sort((left, right) => left.localeCompare(right));
}

function buildUnitBuildInfo(
    inputSignature: PrecompiledUnitInputSignature,
    artifact: { readonly assemblyText: string; readonly supportText: string; },
    assemblyPath: string,
    supportPath: string
): PrecompiledUnitBuildInfo {
    return {
        ...inputSignature,
        outputFiles: [
            {
                filePath: assemblyPath,
                sha256: hashTextSha256(artifact.assemblyText)
            },
            {
                filePath: supportPath,
                sha256: hashTextSha256(artifact.supportText)
            }
        ]
    };
}

function collectOriginalBuildInputFiles(fileMappings: readonly StagedBuildFileMapping[]): {
    readonly sourceFiles: readonly string[];
    readonly packageDbFiles: readonly string[];
} {
    const sourceFiles = new Set<string>();
    const packageDbFiles = new Set<string>();
    for (const mapping of fileMappings) {
        const originalPath = resolve(mapping.originalPath);
        const extension = extname(originalPath);
        if (extension === ".iw") {
            sourceFiles.add(originalPath);
            continue;
        }
        if (extension === ".json") {
            packageDbFiles.add(originalPath);
        }
    }
    return {
        sourceFiles: Array.from(sourceFiles).sort((left, right) => left.localeCompare(right)),
        packageDbFiles: Array.from(packageDbFiles).sort((left, right) => left.localeCompare(right))
    };
}

function buildCompilerOutputReuseRequest(command: CacheableCommand, options: CliOptions, compilerSha256: string, externalFrontendFingerprint: ReturnType<typeof computeExternalFrontendCommandFingerprint>, rootInputFiles: readonly string[]): CompilerOutputReuseRequest {
    return {
        command,
        target: options.target,
        frontendProfile: options.frontendProfile,
        backendProfile: options.backendProfile,
        entryUnitId: options.entryUnitId ?? null,
        compilerSha256,
        externalFrontendCommand: externalFrontendFingerprint.externalFrontendCommand,
        externalFrontendCommandSha256: externalFrontendFingerprint.externalFrontendCommandSha256,
        sourceFiles: computeHashedFileRecords(rootInputFiles)
    };
}

function buildCompilerOutputBuildInfo(reuseRequest: CompilerOutputReuseRequest, dependencyFiles: readonly string[], outputPath: string, outputText: string): CompilerOutputBuildInfo {
    return {
        ...reuseRequest,
        dependencyFiles: computeHashedFileRecords(dependencyFiles),
        outputFiles: [{
            filePath: resolve(outputPath),
            sha256: hashTextSha256(outputText)
        }]
    };
}

function compileNativeLinkObjects(
    toolchain: ReturnType<typeof getPlatformToolchain>,
    inputs: readonly NativeLinkSourceInput[]
): readonly string[] {
    for (const input of inputs) {
        if (input.kind === "c") {
            execToolchainOrThrow(
                toolchain.compileCToObjectCommand,
                toolchain.compileCToObjectArgs(input.sourcePath, input.objectPath),
                input.label,
                extractExecErrorText
            );
            continue;
        }
        execToolchainOrThrow(
            toolchain.compileAssemblyToObjectCommand,
            toolchain.compileAssemblyToObjectArgs(input.sourcePath, input.objectPath),
            input.label,
            extractExecErrorText
        );
    }
    return inputs.map((input) => input.objectPath);
}

function lowerToX64StageC(ast: Parameters<typeof performLoweringStageCFromArtifacts>[0], options: CliOptions, loweringOptions: {
    readonly disableBaseLibAutoLoad: boolean;
    readonly entryUnitId?: string;
    readonly requireEntryPoint: boolean;
    readonly precompiledLibraries?: readonly PrecompiledLibrarySnapshotSource[];
}): X64ExecutableStageCResult {
    const effectiveBackendProfile = options.backendProfile === "c-backend"
        ? "optimized-x64-backend"
        : options.backendProfile;

    if (isWindowsTarget(options.target)) {
        const stageCOptions = {
            ...loweringOptions,
            target: options.target,
        };
        if (options.frontendProfile === "optimized") {
            const stageC = effectiveBackendProfile === "no-optimized-backend"
                ? performWindowsOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts(ast, stageCOptions)
                : performWindowsLoweringStageCFromArtifacts(ast, stageCOptions);
            return {
                targetPlatform: "windows",
                ...stageC
            };
        }

        const stageC = effectiveBackendProfile === "no-optimized-backend"
            ? performWindowsNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts(ast, stageCOptions)
            : performWindowsNoOptimizeLoweringStageCFromArtifacts(ast, stageCOptions);
        return {
            targetPlatform: "windows",
            ...stageC
        };
    }

    const stageCOptions = {
        ...loweringOptions,
        target: options.target,
    };

    if (options.frontendProfile === "optimized") {
        const stageC = effectiveBackendProfile === "no-optimized-backend"
            ? performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts(ast, stageCOptions)
            : performLoweringStageCFromArtifacts(ast, stageCOptions);
        return {
            targetPlatform: "linux",
            ...stageC
        };
    }

    const stageC = effectiveBackendProfile === "no-optimized-backend"
        ? performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts(ast, stageCOptions)
        : performNoOptimizeLoweringStageCFromArtifacts(ast, stageCOptions);
    return {
        targetPlatform: "linux",
        ...stageC
    };
}

function compileAndRunLinkedX64Program(
    target: BuildTarget,
    stageC: X64ExecutableStageCResult,
    libraries: readonly LoadedPrecompiledLibrary[],
    ffiLibPaths: readonly string[],
    programArgs: readonly string[]
): ProgramRunResult {
    const toolchain = getPlatformToolchain(target);
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-run-x64-"));
    try {
        const supportPath = join(tempDir, "program.support.c");
        const driverPath = join(tempDir, "program.driver.c");
        const asmPath = join(tempDir, `program${toolchain.nativeAssemblySuffix}`);
        const binaryPath = join(tempDir, `program${toolchain.executableSuffix}`);
        const linkedGcMetadataTableSymbols = libraries.flatMap((library) => library.compiledUnits.map((unit) => unit.metadataTableExportSymbol));
        const linkedGcGlobalTableSymbols = libraries.flatMap((library) => library.compiledUnits.map((unit) => unit.globalTableExportSymbol));
        const linkedRuntimeInitSymbols = libraries.flatMap((library) => library.compiledUnits.map((unit) => unit.runtimeInitExportSymbol));
        const programSupportText = generateTargetX64NativeSupportC(
            target,
            stageC,
            stageC.pass22x64emit.text,
            {
                linkedGcMetadataTableSymbols,
                linkedGcGlobalTableSymbols,
                linkedRuntimeInitSymbols
            }
        );
        const scopedProgramArtifacts = scopeX64UnitArtifacts(stageC.pass22x64emit.text, programSupportText, "program");

        writeFileSync(
            supportPath,
            scopedProgramArtifacts.supportText,
            "utf8"
        );
        writeFileSync(asmPath, scopedProgramArtifacts.assemblyText, "utf8");
        writeFileSync(driverPath, toolchain.x64DriverSource, "utf8");

        const objectPaths = compileNativeLinkObjects(toolchain, [
            {
                kind: "c",
                sourcePath: supportPath,
                objectPath: join(tempDir, `program.support${toolchain.objectFileSuffix}`),
                label: "x64 support C compilation"
            },
            {
                kind: "c",
                sourcePath: driverPath,
                objectPath: join(tempDir, `program.driver${toolchain.objectFileSuffix}`),
                label: "x64 driver compilation"
            },
            {
                kind: "asm",
                sourcePath: asmPath,
                objectPath: join(tempDir, `program.asm${toolchain.objectFileSuffix}`),
                label: "x64 assembly compilation"
            },
            ...libraries.flatMap((library, libraryIndex) => library.compiledUnits.flatMap((unit, unitIndex) => [
                {
                    kind: "c" as const,
                    sourcePath: unit.supportPath,
                    objectPath: join(tempDir, `precompiled-${libraryIndex}-${unitIndex}.support${toolchain.objectFileSuffix}`),
                    label: `precompiled support compilation (${unit.unitId})`
                },
                {
                    kind: "asm" as const,
                    sourcePath: unit.assemblyPath,
                    objectPath: join(tempDir, `precompiled-${libraryIndex}-${unitIndex}.asm${toolchain.objectFileSuffix}`),
                    label: `precompiled assembly compilation (${unit.unitId})`
                }
            ]))
        ]);

        execToolchainOrThrow(
            toolchain.linkObjectsCommand,
            toolchain.linkObjectsArgs(objectPaths, ffiLibPaths, binaryPath),
            "x64 native compilation",
            extractExecErrorText
        );

        try {
            return runBinary(target, binaryPath, programArgs);
        } catch (error) {
            throw new Error(extractExecErrorText(error));
        }
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function buildPackLibUnitArtifacts(
    plan: ReturnType<typeof buildPrecompiledLibraryPackagingPlan>,
    archivePath: string,
    options: CliOptions,
    loadedLibraries: readonly LoadedPrecompiledLibrary[],
    loadedSourceFiles: readonly string[],
    packageDbFiles: readonly string[]
): readonly PrecompiledLibraryCompiledUnitArtifact[] {
    const selfLibrary = {
        archivePath,
        manifest: plan.manifest
    };
    const unitManifestById = new Map(plan.manifest.compiledUnits.map((unit) => [unit.unitId, unit] as const));
    const resolveOriginalPath = buildOriginalPathResolver(options.stagedFileMappings);
    const allSourceFiles = Array.from(new Set(loadedSourceFiles.map((filePath) => resolveOriginalPath(filePath)))).sort((left, right) => left.localeCompare(right));
    const allPackageDbFiles = Array.from(new Set(packageDbFiles.map((filePath) => resolveOriginalPath(filePath)))).sort((left, right) => left.localeCompare(right));
    const libraryArchivePaths = Array.from(new Set(loadedLibraries.map((library) => resolve(library.archivePath)))).sort((left, right) => left.localeCompare(right));
    const compilerSha256 = computeCompilerSha256(__dirname);
    const externalFrontendFingerprint = computeExternalFrontendCommandFingerprint();
    const sourceFilesByUnitId = new Map<string, string[]>();
    for (const filePath of allSourceFiles) {
        if (extname(filePath) !== ".iw") {
            continue;
        }
        const unitId = basename(filePath, ".iw");
        const existing = sourceFilesByUnitId.get(unitId) ?? [];
        existing.push(filePath);
        sourceFilesByUnitId.set(unitId, existing);
    }

    return Array.from(plan.compilationUnits.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([unitId, unitProgram]) => {
            const manifestUnit = unitManifestById.get(unitId);
            if (manifestUnit === undefined) {
                throw new Error(`pack-lib missing manifest unit '${unitId}'`);
            }
            const unitSourceFiles = collectUnitOriginalSourceFiles(unitProgram, unitId, sourceFilesByUnitId, resolveOriginalPath);
            const dependencyAnalysis = analyzeProgramDependencies(unitSourceFiles, allSourceFiles, allPackageDbFiles);
            const inputSignature: PrecompiledUnitInputSignature = {
                target: options.target,
                frontendProfile: options.frontendProfile,
                backendProfile: options.backendProfile,
                compilerSha256,
                externalFrontendCommand: externalFrontendFingerprint.externalFrontendCommand,
                externalFrontendCommandSha256: externalFrontendFingerprint.externalFrontendCommandSha256,
                sourceFiles: computeHashedFileRecords(dependencyAnalysis.sourceFiles),
                dependencyFiles: computeHashedFileRecords([
                    ...dependencyAnalysis.dependencyFiles,
                    ...libraryArchivePaths
                ])
            };
            const cachedArtifact = tryLoadCachedPackLibUnit(archivePath, unitId, inputSignature);
            if (cachedArtifact !== undefined) {
                return {
                    ...cachedArtifact,
                    buildInfo: buildUnitBuildInfo(inputSignature, cachedArtifact, manifestUnit.assemblyPath, manifestUnit.supportPath)
                };
            }
            const stageC = lowerToX64StageC(unitProgram, options, {
                disableBaseLibAutoLoad: options.disableBaseLibAutoLoad,
                requireEntryPoint: false,
                precompiledLibraries: [...loadedLibraries, selfLibrary]
            });
            const runtimeInitBodySymbol = `${manifestUnit.runtimeInitExportSymbol}__body`;
            const libraryEntryText = stageC.pass22x64emit.entryText.split("iw_x64_entry").join(runtimeInitBodySymbol);
            const libraryAssemblyText = buildTargetX64TextualAssembly(options.target, libraryEntryText, stageC.pass22x64emit.functions.map((fn) => fn.text));
            const librarySupportText = generateTargetX64NativeSupportC(
                options.target,
                stageC,
                libraryAssemblyText,
                {
                    omitHostEntryWrapper: true,
                    omitRuntimeInit: true,
                    entryAsmSymbolOverride: runtimeInitBodySymbol,
                    sharedGcMetadataTableKeyOverride: `unit:${unitId}`,
                    exportedGcMetadataTableSymbols: [{
                        tableKey: `unit:${unitId}`,
                        exportSymbol: manifestUnit.metadataTableExportSymbol
                    }],
                    exportedGcGlobalTableSymbols: [{
                        tableKey: `unit:${unitId}`,
                        exportSymbol: manifestUnit.globalTableExportSymbol
                    }],
                    exportedRuntimeInitSymbol: manifestUnit.runtimeInitExportSymbol
                }
            );
            const scopedUnitArtifacts = scopeX64UnitArtifacts(libraryAssemblyText, librarySupportText, manifestUnit.runtimeInitExportSymbol);
            const compiledArtifact = writeCachedPackLibUnit(archivePath, {
                unitId,
                assemblyText: scopedUnitArtifacts.assemblyText,
                supportText: scopedUnitArtifacts.supportText,
                metadataTableExportSymbol: manifestUnit.metadataTableExportSymbol,
                globalTableExportSymbol: manifestUnit.globalTableExportSymbol,
                runtimeInitExportSymbol: manifestUnit.runtimeInitExportSymbol
            }, inputSignature);
            return {
                ...compiledArtifact,
                buildInfo: buildUnitBuildInfo(inputSignature, compiledArtifact, manifestUnit.assemblyPath, manifestUnit.supportPath)
            };
        });
}

function runCli(argv: readonly string[]): number {
    const options = parseArgs(argv);
    let loadedLibraries: readonly LoadedPrecompiledLibrary[] = [];
    try {
        loadedLibraries = loadPrecompiledLibraryArchives(options.libPaths);
        validatePrecompiledLibraryTargets(options.target, loadedLibraries);
        if (loadedLibraries.length > 0 && (options.command === "emit-c" || (options.command === "run" && options.backendProfile === "c-backend"))) {
            throw new Error("source-less precompiled libs currently require x64 backends; use backendPipeline 'x64native' or 'x64native-nooptimize'");
        }
        const compilerSha256 = computeCompilerSha256(__dirname);
        const externalFrontendFingerprint = computeExternalFrontendCommandFingerprint();
        const originalBuildInputs = collectOriginalBuildInputFiles(options.stagedFileMappings);
        const cacheableCommand: CacheableCommand | undefined = options.command === "check" || options.command === "emit-backend-ir" || options.command === "emit-c" || options.command === "emit-x64"
            ? options.command
            : undefined;
        const normalCacheEligible = options.outputPath !== undefined && cacheableCommand !== undefined;
        if (normalCacheEligible) {
            const reuseRequest = buildCompilerOutputReuseRequest(cacheableCommand, options, compilerSha256, externalFrontendFingerprint, [...originalBuildInputs.sourceFiles, ...originalBuildInputs.packageDbFiles]);
            if (tryReuseCachedCompilerOutput(options.outputPath, reuseRequest)) {
                return 0;
            }
        }
        const loadedProgram = loadProgramAstWithSources(options.inputPath, {
            additionalInputPaths: buildAdditionalInputPaths(options, loadedLibraries),
        });
        const ast = loadedProgram.ast;
        const resolveOriginalPath = buildOriginalPathResolver(options.stagedFileMappings);
        const resolvedLoadedSourceFiles = loadedProgram.sourceFiles.map((filePath) => resolveOriginalPath(filePath));
        const resolvedLoadedPackageDbFiles = loadedProgram.packageDbFiles.map((filePath) => resolveOriginalPath(filePath));
        const linkedLibraryArchivePaths = Array.from(new Set(loadedLibraries.map((library) => resolve(library.archivePath)))).sort((left, right) => left.localeCompare(right));
        const compilerOutputReuseRequest = options.outputPath === undefined || cacheableCommand === undefined
            ? undefined
            : buildCompilerOutputReuseRequest(cacheableCommand, options, compilerSha256, externalFrontendFingerprint, [...originalBuildInputs.sourceFiles, ...originalBuildInputs.packageDbFiles]);

        const typecheckOptions = buildTypecheckOptions(options, loadedLibraries);
        const resultType = performTypeChecking(ast, typecheckOptions);
        const dependencyAnalysis = analyzeProgramDependencies(originalBuildInputs.sourceFiles, resolvedLoadedSourceFiles, resolvedLoadedPackageDbFiles);

        if (options.command === "check") {
            const output = `Typecheck OK: ${printTypeValue(resultType)}`;
            writeOutput(output, options.outputPath);
            if (options.outputPath !== undefined && compilerOutputReuseRequest !== undefined) {
                writeCompilerOutputBuildInfo(options.outputPath, buildCompilerOutputBuildInfo(compilerOutputReuseRequest, [...dependencyAnalysis.dependencyFiles, ...linkedLibraryArchivePaths], options.outputPath, output));
            }
            return 0;
        }

        if (options.command === "pack-lib") {
            if (options.outputPath === undefined) {
                throw new Error(`build-iw.json '${options.configPath}' requires an output path when mode is 'pack-lib'`);
            }
            if (options.backendProfile === "c-backend") {
                throw new Error("pack-lib requires backendPipeline 'x64native' or 'x64native-nooptimize'");
            }

            const artifacts = getMonomorphizedArtifacts();
            const archivePath = resolve(options.outputPath);
            const plan = buildPrecompiledLibraryPackagingPlan(
                options.inputPath,
                ast,
                Array.from(artifacts.classes.values()),
                Array.from(artifacts.functions.values()),
                options.target
            );
            const compiledUnitArtifacts = buildPackLibUnitArtifacts(plan, archivePath, options, loadedLibraries, loadedProgram.sourceFiles, loadedProgram.packageDbFiles);
            createPrecompiledLibraryArchive(
                archivePath,
                plan.manifest,
                compiledUnitArtifacts
            );
            process.stdout.write(`Packed lib: ${archivePath}\n`);
            return 0;
        }

        const loweringOptions = {
            target: options.target,
            disableBaseLibAutoLoad: options.disableBaseLibAutoLoad,
            entryUnitId: options.entryUnitId,
            requireEntryPoint: options.command === "emit-backend-ir" || options.command === "emit-c" || options.command === "emit-x64" || options.command === "run",
            precompiledLibraries: loadedLibraries
        };

        if (options.command !== "emit-x64" && (options.command !== "run" || options.backendProfile === "c-backend")) {
            const stageC = options.frontendProfile === "optimized"
                ? performOptimizedCBackendLoweringStageCFromArtifacts(ast, loweringOptions)
                : performNoOptimizeCBackendLoweringStageCFromArtifacts(ast, loweringOptions);

            if (options.command === "run") {
                const runResult = compileAndRunProgram(options.target, generateTargetCFromFinalBackendIR(options.target, stageC.pass10), options.ffiLibPaths, options.programArgs);
                if (runResult.stderr.length > 0) {
                    process.stderr.write(runResult.stderr);
                }
                writeRawOutput(runResult.stdout, options.outputPath);
                return runResult.status;
            }

            const output = options.command === "emit-backend-ir"
                ? formatFinalBackendIRProgram(stageC.pass10)
                : generateTargetCFromFinalBackendIR(options.target, stageC.pass10);
            writeOutput(output, options.outputPath);
            if (options.outputPath !== undefined && compilerOutputReuseRequest !== undefined) {
                writeCompilerOutputBuildInfo(options.outputPath, buildCompilerOutputBuildInfo(compilerOutputReuseRequest, [...dependencyAnalysis.dependencyFiles, ...linkedLibraryArchivePaths], options.outputPath, output));
            }
            return 0;
        }

        const stageC = lowerToX64StageC(ast, options, loweringOptions);

        if (options.command === "run") {
            const runResult = compileAndRunLinkedX64Program(options.target, stageC, loadedLibraries, options.ffiLibPaths, options.programArgs);
            if (runResult.stderr.length > 0) {
                process.stderr.write(runResult.stderr);
            }
            writeRawOutput(runResult.stdout, options.outputPath);
            return runResult.status;
        }

        const output = formatX64TextualAssemblyProgram(stageC.pass22x64emit);
        writeOutput(output, options.outputPath);
        if (options.outputPath !== undefined && compilerOutputReuseRequest !== undefined) {
            writeCompilerOutputBuildInfo(options.outputPath, buildCompilerOutputBuildInfo(compilerOutputReuseRequest, [...dependencyAnalysis.dependencyFiles, ...linkedLibraryArchivePaths], options.outputPath, output));
        }
        return 0;
    } finally {
        disposeLoadedPrecompiledLibraries(loadedLibraries);
        options.cleanupInputPath();
    }
}

if (require.main === module) {
    try {
        process.exitCode = runCli(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${formatErrorAsJson(error, "cli", "CLI_ERROR")}\n`);
        process.exitCode = 1;
    }
}

export { runCli };
