#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AstNode } from "./AstNode";
import { getBaseLibSourceRoots } from "./BaseLib";
import { formatErrorAsJson } from "./Diagnostics";
import { formatIronwallVersionLine, IRONWALL_VERSION } from "./IronwallVersion";
import {
    loadReleaseBuildConfig,
    resolveBuildConfigPath,
    stageReleaseBuildInputs,
    type ReleaseBuildMode
} from "./ReleaseBuildConfig";
import { execToolchainOrThrow, getPlatformToolchain } from "./PlatformToolchain";
import type { BuildTarget } from "./Target";
import { loadProgramAst } from "./ModuleLoader";
import {
    buildPrecompiledLibraryPackagingPlan,
    createPrecompiledLibraryArchive,
    disposeLoadedPrecompiledLibraries,
    loadPrecompiledLibraryArchives,
    type LoadedPrecompiledLibrary,
    type PrecompiledLibraryCompiledUnitArtifact,
    type PrecompiledLibrarySnapshotSource
} from "./PrecompiledLib";
import { getMonomorphizedArtifacts, performTypeChecking } from "./Typecheck-Pipeline";

type CommandName = ReleaseBuildMode;

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

type PlatformSupportOptions = {
    readonly omitHostEntryWrapper?: boolean;
    readonly omitRuntimeInit?: boolean;
    readonly entryAsmSymbolOverride?: string;
    readonly exportedGcMetadataTableSymbols?: readonly { readonly tableKey: string; readonly exportSymbol: string; }[];
    readonly exportedGcGlobalTableSymbols?: readonly { readonly tableKey: string; readonly exportSymbol: string; }[];
    readonly exportedRuntimeInitSymbol?: string;
    readonly linkedGcMetadataTableSymbols?: readonly string[];
    readonly linkedGcGlobalTableSymbols?: readonly string[];
    readonly linkedRuntimeInitSymbols?: readonly string[];
};

type PlatformStageCResult = {
    readonly pass10Support: unknown;
    readonly pass18x64layout: { readonly layouts: { readonly classes: unknown; }; };
    readonly pass22x64emit: {
        readonly entryText: string;
        readonly text: string;
        readonly functions: readonly { readonly text: string; }[];
    };
};

type PlatformLoweringOptions = {
    readonly target?: BuildTarget;
    readonly disableBaseLibAutoLoad: boolean;
    readonly entryUnitId?: string;
    readonly requireEntryPoint: boolean;
    readonly precompiledLibraries?: readonly PrecompiledLibrarySnapshotSource[];
};

export interface PlatformReleaseHooks {
    readonly platformTarget: BuildTarget;
    readonly performLoweringStageCFromArtifacts: (programAst: AstNode, options: PlatformLoweringOptions) => PlatformStageCResult;
    readonly generateX64NativeSupportCFromFinalBackendIR: (
        pass10Support: unknown,
        extraSupportSource: string,
        classLayouts: unknown,
        assemblyText: string,
        options?: PlatformSupportOptions
    ) => string;
    readonly buildX64TextualAssembly: (entryText: string, functionTexts: readonly string[]) => string;
}

interface ReleaseCliOptions {
    readonly command: CommandName;
    readonly target: BuildTarget;
    readonly inputPath: string;
    readonly configPath: string;
    readonly outputPath: string;
    readonly entryUnitId?: string;
    readonly libPaths: readonly string[];
    readonly ffiLibPaths: readonly string[];
    readonly cleanupInputPath: () => void;
}

function usage(): string {
    return [
        "Ironwall Release CLI",
        `Version: ${IRONWALL_VERSION}`,
        "",
        "Usage:",
        "  ironwall --version",
        "  ironwall path/to/build-iw.json",
        "",
        "This release build only accepts a file named build-iw.json.",
        "Supported modes:",
        "  - build: compile one optimized native x64 executable",
        "  - pack-lib: pack one optimized native x64 precompiled library",
        "",
        "The release compiler always enables the base lib and always uses the optimized x64 backend.",
    ].join("\n");
}

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

function parseArgs(argv: readonly string[], hooks: PlatformReleaseHooks): ReleaseCliOptions {
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

    const build = loadReleaseBuildConfig(argv[0], hooks.platformTarget, hooks.platformTarget);
    const stagedInput = stageReleaseBuildInputs(build);
    if (build.config.output === undefined) {
        throw new Error(`build-iw.json '${build.configPath}' requires an output path`);
    }

    return {
        command: build.config.mode,
        target: hooks.platformTarget,
        inputPath: stagedInput.inputPath,
        configPath: build.configPath,
        outputPath: resolveBuildConfigPath(build.configPath, build.config.output),
        entryUnitId: build.config.main,
        libPaths: build.config.precompiledLibs.map((libPath) => resolveBuildConfigPath(build.configPath, libPath)),
        ffiLibPaths: build.config.ffiLibs.map((libPath) => resolveBuildConfigPath(build.configPath, libPath)),
        cleanupInputPath: stagedInput.cleanup
    };
}

function extractExecErrorText(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const sanitizeCapturedStderr = (text: string): string => {
        const withoutNulls = text.replace(/\u0000/g, "");
        const filteredLines = withoutNulls
            .split(/\r?\n/)
            .filter((line) => line.trim() !== "wsl: A localhost proxy configuration was detected but not mirrored into WSL. WSL in NAT mode does not support localhost proxies.");
        return filteredLines.join("\n").trimEnd();
    };

    const stderr = "stderr" in error
        ? (error as Error & { stderr?: string | Buffer }).stderr
        : undefined;
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

function validatePrecompiledLibraryTargets(target: BuildTarget, precompiledLibraries: readonly LoadedPrecompiledLibrary[]): void {
    for (const library of precompiledLibraries) {
        if (library.manifest.target !== target) {
            throw new Error(`precompiled lib '${library.archivePath}' targets '${library.manifest.target}', but build target is '${target}'`);
        }
    }
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

function buildLinkedX64Executable(
    hooks: PlatformReleaseHooks,
    stageC: PlatformStageCResult,
    libraries: readonly LoadedPrecompiledLibrary[],
    ffiLibPaths: readonly string[],
    outputPath: string
): void {
    const toolchain = getPlatformToolchain(hooks.platformTarget);
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-release-build-x64-"));
    try {
        const supportPath = join(tempDir, "program.support.c");
        const driverPath = join(tempDir, "program.driver.c");
        const asmPath = join(tempDir, `program${toolchain.nativeAssemblySuffix}`);
        const linkedGcMetadataTableSymbols = libraries.flatMap((library) => library.compiledUnits.map((unit) => unit.metadataTableExportSymbol));
        const linkedGcGlobalTableSymbols = libraries.flatMap((library) => library.compiledUnits.map((unit) => unit.globalTableExportSymbol));
        const linkedRuntimeInitSymbols = libraries.flatMap((library) => library.compiledUnits.map((unit) => unit.runtimeInitExportSymbol));
        const programSupportText = hooks.generateX64NativeSupportCFromFinalBackendIR(
            stageC.pass10Support,
            "",
            stageC.pass18x64layout.layouts.classes,
            stageC.pass22x64emit.text,
            {
                linkedGcMetadataTableSymbols,
                linkedGcGlobalTableSymbols,
                linkedRuntimeInitSymbols
            }
        );
        const scopedProgramArtifacts = scopeX64UnitArtifacts(stageC.pass22x64emit.text, programSupportText, "program");

        writeFileSync(supportPath, scopedProgramArtifacts.supportText, "utf8");
        writeFileSync(driverPath, toolchain.x64DriverSource, "utf8");
        writeFileSync(asmPath, scopedProgramArtifacts.assemblyText, "utf8");
        mkdirSync(dirname(outputPath), { recursive: true });

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
            toolchain.linkObjectsArgs(objectPaths, ffiLibPaths, outputPath),
            "x64 native compilation",
            extractExecErrorText
        );
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function buildPackLibUnitArtifacts(
    hooks: PlatformReleaseHooks,
    plan: ReturnType<typeof buildPrecompiledLibraryPackagingPlan>,
    archivePath: string,
    loadedLibraries: readonly LoadedPrecompiledLibrary[]
): readonly PrecompiledLibraryCompiledUnitArtifact[] {
    const selfLibrary: PrecompiledLibrarySnapshotSource = {
        archivePath,
        manifest: plan.manifest
    };
    const unitManifestById = new Map(plan.manifest.compiledUnits.map((unit) => [unit.unitId, unit] as const));

    return Array.from(plan.compilationUnits.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([unitId, unitProgram]) => {
            const manifestUnit = unitManifestById.get(unitId);
            if (manifestUnit === undefined) {
                throw new Error(`pack-lib missing manifest unit '${unitId}'`);
            }
            const stageC = hooks.performLoweringStageCFromArtifacts(unitProgram as AstNode, {
                target: hooks.platformTarget,
                disableBaseLibAutoLoad: false,
                requireEntryPoint: false,
                precompiledLibraries: [...loadedLibraries, selfLibrary]
            });
            const runtimeInitBodySymbol = `${manifestUnit.runtimeInitExportSymbol}__body`;
            const libraryEntryText = stageC.pass22x64emit.entryText.split("iw_x64_entry").join(runtimeInitBodySymbol);
            const libraryAssemblyText = hooks.buildX64TextualAssembly(libraryEntryText, stageC.pass22x64emit.functions.map((fn) => fn.text));
            const librarySupportText = hooks.generateX64NativeSupportCFromFinalBackendIR(
                stageC.pass10Support,
                "",
                stageC.pass18x64layout.layouts.classes,
                libraryAssemblyText,
                {
                    omitHostEntryWrapper: true,
                    omitRuntimeInit: true,
                    entryAsmSymbolOverride: runtimeInitBodySymbol,
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
            return {
                unitId,
                assemblyText: scopedUnitArtifacts.assemblyText,
                supportText: scopedUnitArtifacts.supportText,
                metadataTableExportSymbol: manifestUnit.metadataTableExportSymbol,
                globalTableExportSymbol: manifestUnit.globalTableExportSymbol,
                runtimeInitExportSymbol: manifestUnit.runtimeInitExportSymbol
            };
        });
}

export function runPlatformReleaseCli(argv: readonly string[], hooks: PlatformReleaseHooks): number {
    const options = parseArgs(argv, hooks);
    let loadedLibraries: readonly LoadedPrecompiledLibrary[] = [];
    try {
        loadedLibraries = loadPrecompiledLibraryArchives(options.libPaths);
        validatePrecompiledLibraryTargets(options.target, loadedLibraries);
        const ast = loadProgramAst(options.inputPath, {
            additionalInputPaths: getBaseLibSourceRoots(options.target)
        });

        performTypeChecking(ast, {
            disableBaseLibAutoLoad: false,
            precompiledLibraries: loadedLibraries
        });

        if (options.command === "pack-lib") {
            const artifacts = getMonomorphizedArtifacts();
            const plan = buildPrecompiledLibraryPackagingPlan(
                options.inputPath,
                ast,
                Array.from(artifacts.classes.values()),
                Array.from(artifacts.functions.values()),
                options.target
            );
            const archivePath = options.outputPath;
            const compiledUnitArtifacts = buildPackLibUnitArtifacts(hooks, plan, archivePath, loadedLibraries);
            createPrecompiledLibraryArchive(archivePath, plan.manifest, compiledUnitArtifacts);
            process.stdout.write(`Packed lib: ${archivePath}\n`);
            return 0;
        }

        const stageC = hooks.performLoweringStageCFromArtifacts(ast as AstNode, {
            target: options.target,
            disableBaseLibAutoLoad: false,
            entryUnitId: options.entryUnitId,
            requireEntryPoint: true,
            precompiledLibraries: loadedLibraries
        });

        buildLinkedX64Executable(hooks, stageC, loadedLibraries, options.ffiLibPaths, options.outputPath);
        process.stdout.write(`Built executable: ${options.outputPath}\n`);
        return 0;
    } finally {
        disposeLoadedPrecompiledLibraries(loadedLibraries);
        options.cleanupInputPath();
    }
}

export function runPlatformReleaseCliMain(argv: readonly string[], hooks: PlatformReleaseHooks): void {
    try {
        process.exitCode = runPlatformReleaseCli(argv, hooks);
    } catch (error) {
        process.stderr.write(`${formatErrorAsJson(error, "cli", "CLI_ERROR")}\n`);
        process.exitCode = 1;
    }
}