import { readFileSync } from "fs";
import { basename, dirname, extname, resolve } from "path";
import { defaultBuildTarget, normalizeBuildTarget, type BuildTarget } from "./Target";
import {
    resolveBuildConfigPath,
    stageBuildInputs,
    type BuildConfig,
    type LoadedBuildConfig,
    type StagedBuildInput
} from "./BuildConfig";

export type ReleaseBuildMode = "build" | "pack-lib";

interface ReleaseBuildDirectoryConfig {
    readonly path: string;
    readonly files?: readonly string[];
}

export interface ReleaseBuildConfig {
    readonly mode: ReleaseBuildMode;
    readonly target?: BuildTarget;
    readonly directories: readonly ReleaseBuildDirectoryConfig[];
    readonly main?: string;
    readonly output?: string;
    readonly precompiledLibs: readonly string[];
    readonly ffiLibs: readonly string[];
}

export interface LoadedReleaseBuildConfig {
    readonly configPath: string;
    readonly configDir: string;
    readonly config: ReleaseBuildConfig;
}

const releaseBuildModes = ["build", "pack-lib"] as const;
const releaseBuildTargets = ["linux-x64", "windows-x64"] as const;

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

function parseStringArray(value: unknown, path: string, issues: string[]): readonly string[] {
    if (value === undefined) {
        return [];
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

function parseReleaseDirectories(value: unknown, issues: string[]): readonly ReleaseBuildDirectoryConfig[] {
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

function parseReleaseBuildConfig(value: unknown, defaultTarget: BuildTarget, requiredTarget?: BuildTarget): { readonly config?: ReleaseBuildConfig; readonly issues: readonly string[] } {
    const issues: string[] = [];
    if (!isRecord(value)) {
        return { issues: ["<root>: expected object"] };
    }

    const mode = value.mode === undefined
        ? "build"
        : isOneOf(value.mode, releaseBuildModes) ? value.mode : undefined;
    if (mode === undefined) {
        issues.push("mode: expected one of build, pack-lib");
    }

    const target = value.target === undefined
        ? defaultTarget
        : isOneOf(value.target, releaseBuildTargets) ? value.target : undefined;
    if (target === undefined) {
        issues.push("target: expected one of linux-x64, windows-x64");
    }
    if (requiredTarget !== undefined && target !== undefined && target !== requiredTarget) {
        issues.push(`target: this release compiler only accepts '${requiredTarget}'`);
    }

    const directories = parseReleaseDirectories(value.directories, issues);
    const main = parseOptionalString(value.main, "main", issues);
    const output = parseOptionalString(value.output, "output", issues);
    const precompiledLibs = parseStringArray(value.precompiledLibs, "precompiledLibs", issues);
    const ffiLibs = parseStringArray(value.ffiLibs, "ffiLibs", issues);

    if (mode === "build" && main === undefined) {
        issues.push("main: main is required when mode is 'build'");
    }
    if (mode !== undefined && output === undefined) {
        issues.push(`output: output is required when mode is '${mode}'`);
    }

    ffiLibs.forEach((libPath, index) => {
        const allowedStaticLibExtensions = target === "windows-x64" ? [".a", ".lib"] : [".a"];
        if (!allowedStaticLibExtensions.includes(extname(libPath))) {
            issues.push(`ffiLibs.${index}: ffiLibs entries must be static library files for target '${target ?? defaultBuildTarget}'`);
        }
    });

    if (mode === undefined || target === undefined || issues.length > 0) {
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
            ffiLibs
        }
    };
}

function toDevLoadedBuildConfig(build: LoadedReleaseBuildConfig): LoadedBuildConfig {
    const devConfig: BuildConfig = {
        mode: build.config.mode === "build" ? "run" : "pack-lib",
        target: normalizeBuildTarget(build.config.target),
        directories: build.config.directories,
        main: build.config.main,
        output: build.config.output,
        precompiledLibs: build.config.precompiledLibs,
        ffiLibs: build.config.ffiLibs,
        frontendPipeline: "optimize",
        backendPipeline: "x64native",
        noBaseLib: false,
        programArgs: []
    };
    return {
        configPath: build.configPath,
        configDir: build.configDir,
        config: devConfig
    };
}

export function loadReleaseBuildConfig(configPath: string, defaultTarget: BuildTarget = defaultBuildTarget, requiredTarget?: BuildTarget): LoadedReleaseBuildConfig {
    const resolvedConfigPath = resolve(configPath);
    if (basename(resolvedConfigPath) !== "build-iw.json") {
        throw new Error(`Release CLI only accepts a file named 'build-iw.json', got '${basename(resolvedConfigPath)}'`);
    }

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(readFileSync(resolvedConfigPath, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid build-iw.json '${resolvedConfigPath}': ${message}`);
    }

    const result = parseReleaseBuildConfig(parsedJson, defaultTarget, requiredTarget);
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

export function stageReleaseBuildInputs(build: LoadedReleaseBuildConfig): StagedBuildInput {
    return stageBuildInputs(toDevLoadedBuildConfig(build));
}

export { resolveBuildConfigPath };
