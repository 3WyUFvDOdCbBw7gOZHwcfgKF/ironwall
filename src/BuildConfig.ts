import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { isPackageStringDatabaseStem } from "./StringDatabase";
import { defaultBuildTarget, type BuildTarget } from "./Target";

export type BuildMode = "check" | "emit-backend-ir" | "emit-c" | "emit-x64" | "pack-lib" | "run";
export type FrontendPipelineName = "optimize" | "nooptimize";
export type BackendPipelineName = "c" | "x64native" | "x64native-nooptimize";

interface BuildDirectoryConfig {
    readonly path: string;
    readonly files?: readonly string[];
}

export interface BuildConfig {
    readonly mode: BuildMode;
    readonly target?: BuildTarget;
    readonly directories: readonly BuildDirectoryConfig[];
    readonly main?: string;
    readonly precompiledLibs: readonly string[];
    readonly ffiLibs: readonly string[];
    readonly frontendPipeline: FrontendPipelineName;
    readonly backendPipeline: BackendPipelineName;
    readonly output?: string;
    readonly noBaseLib: boolean;
    readonly programArgs: readonly string[];
    readonly monomorphizationMaxRounds?: number;
}

export interface LoadedBuildConfig {
    readonly configPath: string;
    readonly configDir: string;
    readonly config: BuildConfig;
}

export interface StagedBuildFileMapping {
    readonly originalPath: string;
    readonly stagedPath: string;
}

export interface StagedBuildInput {
    readonly inputPath: string;
    readonly fileMappings: readonly StagedBuildFileMapping[];
    readonly cleanup: () => void;
}

const buildModes = ["check", "emit-backend-ir", "emit-c", "emit-x64", "pack-lib", "run"] as const;
const buildTargets = ["linux-x64", "windows-x64"] as const;
const frontendPipelines = ["optimize", "nooptimize"] as const;
const backendPipelines = ["c", "x64native", "x64native-nooptimize"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
    return typeof value === "string" && values.includes(value as T);
}

function parseOptionalString(value: unknown, path: string, issues: string[]): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
        issues.push(`${path}: expected non-empty string`);
        return undefined;
    }
    return value;
}

function parseStringArray(value: unknown, path: string, issues: string[], defaultValue: readonly string[] = []): readonly string[] {
    if (value === undefined) {
        return defaultValue;
    }
    if (!Array.isArray(value)) {
        issues.push(`${path}: expected array`);
        return [];
    }
    return value.map((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
            issues.push(`${path}.${index}: expected non-empty string`);
            return "";
        }
        return entry;
    });
}

function parseBuildDirectories(value: unknown, issues: string[]): readonly BuildDirectoryConfig[] {
    if (!Array.isArray(value) || value.length === 0) {
        issues.push("directories: expected non-empty array");
        return [];
    }
    return value.map((entry, index) => {
        if (!isRecord(entry)) {
            issues.push(`directories.${index}: expected object`);
            return { path: "" };
        }
        const path = parseOptionalString(entry.path, `directories.${index}.path`, issues) ?? "";
        const files = entry.files === undefined ? undefined : parseStringArray(entry.files, `directories.${index}.files`, issues);
        if (files !== undefined && files.length === 0) {
            issues.push(`directories.${index}.files: expected non-empty array`);
        }
        return files === undefined ? { path } : { path, files };
    });
}

function parseBuildConfig(value: unknown): { readonly config?: BuildConfig; readonly issues: readonly string[] } {
    const issues: string[] = [];
    if (!isRecord(value)) {
        return { issues: ["<root>: expected object"] };
    }

    const mode = value.mode === undefined
        ? "run"
        : isOneOf(value.mode, buildModes) ? value.mode : undefined;
    if (mode === undefined) {
        issues.push("mode: expected one of check, emit-backend-ir, emit-c, emit-x64, pack-lib, run");
    }

    const target = value.target === undefined
        ? defaultBuildTarget
        : isOneOf(value.target, buildTargets) ? value.target : undefined;
    if (target === undefined) {
        issues.push("target: expected one of linux-x64, windows-x64");
    }

    const frontendPipeline = value.frontendPipeline === undefined
        ? "optimize"
        : isOneOf(value.frontendPipeline, frontendPipelines) ? value.frontendPipeline : undefined;
    if (frontendPipeline === undefined) {
        issues.push("frontendPipeline: expected one of optimize, nooptimize");
    }

    const backendPipeline = value.backendPipeline === undefined
        ? "c"
        : isOneOf(value.backendPipeline, backendPipelines) ? value.backendPipeline : undefined;
    if (backendPipeline === undefined) {
        issues.push("backendPipeline: expected one of c, x64native, x64native-nooptimize");
    }

    const directories = parseBuildDirectories(value.directories, issues);
    const main = parseOptionalString(value.main, "main", issues);
    const output = parseOptionalString(value.output, "output", issues);
    const precompiledLibs = parseStringArray(value.precompiledLibs, "precompiledLibs", issues);
    const ffiLibs = parseStringArray(value.ffiLibs, "ffiLibs", issues);
    const programArgs = parseStringArray(value.programArgs, "programArgs", issues);

    const noBaseLib = value.noBaseLib === undefined ? false : value.noBaseLib;
    if (typeof noBaseLib !== "boolean") {
        issues.push("noBaseLib: expected boolean");
    }

    const rawMonomorphizationMaxRounds = value.monomorphizationMaxRounds;
    const monomorphizationMaxRounds = typeof rawMonomorphizationMaxRounds === "number" ? rawMonomorphizationMaxRounds : undefined;
    if (rawMonomorphizationMaxRounds !== undefined && (typeof rawMonomorphizationMaxRounds !== "number" || !Number.isInteger(rawMonomorphizationMaxRounds) || rawMonomorphizationMaxRounds <= 0)) {
        issues.push("monomorphizationMaxRounds: expected positive integer");
    }

    if (mode !== undefined && ["run", "emit-backend-ir", "emit-c", "emit-x64"].includes(mode) && main === undefined) {
        issues.push(`main: main is required when mode is '${mode}'`);
    }
    if (mode === "pack-lib" && output === undefined) {
        issues.push("output: output is required when mode is 'pack-lib'");
    }

    ffiLibs.forEach((libPath, index) => {
        const allowedStaticLibExtensions = target === "windows-x64" ? [".a", ".lib"] : [".a"];
        if (!allowedStaticLibExtensions.includes(extname(libPath))) {
            issues.push(`ffiLibs.${index}: ffiLibs entries must be static library files for target '${target ?? defaultBuildTarget}'`);
        }
    });

    if (mode === undefined || target === undefined || frontendPipeline === undefined || backendPipeline === undefined || typeof noBaseLib !== "boolean" || issues.length > 0) {
        return { issues };
    }

    return {
        issues,
        config: {
            mode,
            target,
            directories,
            main,
            output,
            precompiledLibs,
            ffiLibs,
            frontendPipeline,
            backendPipeline,
            noBaseLib,
            programArgs,
            monomorphizationMaxRounds
        }
    };
}

function isPathInsideDirectory(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath);
    return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSupportedBuildInputFile(filePath: string): boolean {
    if (extname(filePath) === ".iw") {
        return true;
    }
    return extname(filePath) === ".json" && isPackageStringDatabaseStem(basename(filePath, ".json"));
}

function collectSupportedBuildInputFiles(inputPath: string): string[] {
    const resolvedPath = resolve(inputPath);
    const stats = statSync(resolvedPath);
    if (stats.isFile()) {
        if (!isSupportedBuildInputFile(resolvedPath)) {
            throw new Error(`Unsupported build input file '${resolvedPath}'. Expected .iw or '<package>$<db>.json'.`);
        }
        return [resolvedPath];
    }
    if (!stats.isDirectory()) {
        throw new Error(`Expected a file or directory, got '${resolvedPath}'`);
    }

    const results: string[] = [];
    for (const child of readdirSync(resolvedPath).sort()) {
        const childPath = join(resolvedPath, child);
        const childStats = statSync(childPath);
        if (childStats.isDirectory()) {
            results.push(...collectSupportedBuildInputFiles(childPath));
            continue;
        }
        if (childStats.isFile() && isSupportedBuildInputFile(childPath)) {
            results.push(childPath);
        }
    }
    return results;
}

export function resolveBuildConfigPath(configOrDirPath: string, targetPath: string): string {
    const resolvedConfigOrDirPath = resolve(configOrDirPath);
    const stats = statSync(resolvedConfigOrDirPath);
    const baseDir = stats.isDirectory() ? resolvedConfigOrDirPath : dirname(resolvedConfigOrDirPath);
    return resolve(baseDir, targetPath);
}

export function loadBuildConfig(configPath: string): LoadedBuildConfig {
    const resolvedConfigPath = resolve(configPath);
    if (basename(resolvedConfigPath) !== "build-iw.json") {
        throw new Error(`CLI only accepts a file named 'build-iw.json', got '${basename(resolvedConfigPath)}'`);
    }

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(readFileSync(resolvedConfigPath, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid build-iw.json '${resolvedConfigPath}': ${message}`);
    }

    const result = parseBuildConfig(parsedJson);
    if (result.config === undefined) {
        throw new Error([
            `Invalid build-iw.json '${resolvedConfigPath}':`,
            ...result.issues
        ].join("\n"));
    }

    return {
        configPath: resolvedConfigPath,
        configDir: dirname(resolvedConfigPath),
        config: result.config
    };
}

export function stageBuildInputs(build: LoadedBuildConfig): StagedBuildInput {
    const stagingDir = mkdtempSync(join(tmpdir(), "ironwall-build-config-"));
    const seenFiles = new Set<string>();
    let copiedFiles = 0;
    const fileMappings: StagedBuildFileMapping[] = [];

    try {
        build.config.directories.forEach((directory, index) => {
            const resolvedDirectoryPath = resolve(build.configDir, directory.path);
            const directoryStats = statSync(resolvedDirectoryPath);
            if (!directoryStats.isDirectory()) {
                throw new Error(`build-iw.json directories[${index}].path must point to a directory, got '${resolvedDirectoryPath}'`);
            }

            const roots = directory.files === undefined
                ? [resolvedDirectoryPath]
                : directory.files.map((filePath) => {
                    const resolvedFilePath = resolve(resolvedDirectoryPath, filePath);
                    if (!isPathInsideDirectory(resolvedDirectoryPath, resolvedFilePath)) {
                        throw new Error(`build-iw.json directories[${index}].files entry '${filePath}' escapes '${resolvedDirectoryPath}'`);
                    }
                    return resolvedFilePath;
                });

            const selectedFiles = roots.flatMap((rootPath) => collectSupportedBuildInputFiles(rootPath));
            if (selectedFiles.length === 0) {
                throw new Error(`build-iw.json directories[${index}] did not resolve to any .iw or package db .json files`);
            }

            for (const sourceFilePath of selectedFiles) {
                if (seenFiles.has(sourceFilePath)) {
                    continue;
                }
                seenFiles.add(sourceFilePath);
                const relativeSourcePath = relative(resolvedDirectoryPath, sourceFilePath);
                const destinationPath = join(stagingDir, `input-${index}`, relativeSourcePath);
                mkdirSync(dirname(destinationPath), { recursive: true });
                copyFileSync(sourceFilePath, destinationPath);
                fileMappings.push({
                    originalPath: sourceFilePath,
                    stagedPath: destinationPath
                });
                copiedFiles += 1;
            }
        });

        if (copiedFiles === 0) {
            throw new Error(`build-iw.json '${build.configPath}' did not stage any input files`);
        }

        return {
            inputPath: stagingDir,
            fileMappings,
            cleanup: () => rmSync(stagingDir, { recursive: true, force: true })
        };
    } catch (error) {
        rmSync(stagingDir, { recursive: true, force: true });
        throw error;
    }
}
