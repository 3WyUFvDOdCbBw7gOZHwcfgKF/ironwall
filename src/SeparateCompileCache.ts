import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, resolve } from "path";
import type {
    PrecompiledLibraryCompiledUnitArtifact,
    PrecompiledUnitHashedFileRecord,
    PrecompiledUnitInputSignature
} from "./PrecompiledLib";

interface PackLibUnitCacheEntry {
    readonly format: "iw-pack-lib-unit-cache";
    readonly version: 1;
    readonly unitId: string;
    readonly metadataTableExportSymbol: string;
    readonly globalTableExportSymbol: string;
    readonly runtimeInitExportSymbol: string;
    readonly inputSignature: PrecompiledUnitInputSignature;
    readonly outputFiles: readonly PrecompiledUnitHashedFileRecord[];
    readonly cachedAssemblyPath: string;
    readonly cachedSupportPath: string;
}

export interface CompilerOutputInputSignature {
    readonly command: "check" | "emit-backend-ir" | "emit-c" | "emit-x64";
    readonly target: PrecompiledUnitInputSignature["target"];
    readonly frontendProfile: string;
    readonly backendProfile: string;
    readonly entryUnitId: string | null;
    readonly compilerSha256: string;
    readonly externalFrontendCommand: string | null;
    readonly externalFrontendCommandSha256: string | null;
    readonly sourceFiles: readonly PrecompiledUnitHashedFileRecord[];
}

export interface CompilerOutputReuseRequest extends CompilerOutputInputSignature {
    readonly sourceFiles: readonly PrecompiledUnitHashedFileRecord[];
}

export interface CompilerOutputBuildInfo extends CompilerOutputInputSignature {
    readonly dependencyFiles: readonly PrecompiledUnitHashedFileRecord[];
    readonly outputFiles: readonly PrecompiledUnitHashedFileRecord[];
}

interface CompilerOutputCacheEntry extends CompilerOutputBuildInfo {
    readonly format: "iw-output-cache";
    readonly version: 1;
}

function sha256FromBuffer(value: Buffer | string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function hashTextSha256(text: string): string {
    return sha256FromBuffer(Buffer.from(text, "utf8"));
}

export function hashFileSha256(filePath: string): string {
    return sha256FromBuffer(readFileSync(resolve(filePath)));
}

function sanitizeFileComponent(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function compareHashedFileRecords(left: readonly PrecompiledUnitHashedFileRecord[], right: readonly PrecompiledUnitHashedFileRecord[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((record, index) => record.filePath === right[index]?.filePath && record.sha256 === right[index]?.sha256);
}

function sameInputSignature(left: PrecompiledUnitInputSignature, right: PrecompiledUnitInputSignature): boolean {
    return left.target === right.target
        && left.frontendProfile === right.frontendProfile
        && left.backendProfile === right.backendProfile
        && left.compilerSha256 === right.compilerSha256
        && left.externalFrontendCommand === right.externalFrontendCommand
        && left.externalFrontendCommandSha256 === right.externalFrontendCommandSha256
        && compareHashedFileRecords(left.sourceFiles, right.sourceFiles)
        && compareHashedFileRecords(left.dependencyFiles, right.dependencyFiles);
}

function sameCompilerOutputInputSignature(left: CompilerOutputInputSignature, right: CompilerOutputInputSignature): boolean {
    return left.command === right.command
        && left.target === right.target
        && left.frontendProfile === right.frontendProfile
        && left.backendProfile === right.backendProfile
        && left.entryUnitId === right.entryUnitId
        && left.compilerSha256 === right.compilerSha256
        && left.externalFrontendCommand === right.externalFrontendCommand
        && left.externalFrontendCommandSha256 === right.externalFrontendCommandSha256
    && compareHashedFileRecords(left.sourceFiles, right.sourceFiles);
}

function buildCompilerOutputBuildInfoPath(outputPath: string): string {
    return `${resolve(outputPath)}.buildinfo.json`;
}

function computeCurrentHashes(records: readonly PrecompiledUnitHashedFileRecord[]): readonly PrecompiledUnitHashedFileRecord[] | undefined {
    const current: PrecompiledUnitHashedFileRecord[] = [];
    for (const record of records) {
        const resolvedPath = resolve(record.filePath);
        if (!existsSync(resolvedPath)) {
            return undefined;
        }
        current.push({
            filePath: record.filePath,
            sha256: hashFileSha256(resolvedPath)
        });
    }
    return current;
}

export function tryReuseCachedCompilerOutput(outputPath: string, expectedInputSignature: CompilerOutputReuseRequest): boolean {
    const resolvedOutputPath = resolve(outputPath);
    const buildInfoPath = buildCompilerOutputBuildInfoPath(resolvedOutputPath);
    if (!existsSync(resolvedOutputPath) || !existsSync(buildInfoPath)) {
        return false;
    }
    const parsed = JSON.parse(readFileSync(buildInfoPath, "utf8")) as CompilerOutputCacheEntry;
    if (parsed.format !== "iw-output-cache" || parsed.version !== 1) {
        return false;
    }
    if (!sameCompilerOutputInputSignature(parsed, expectedInputSignature)) {
        return false;
    }
    const currentSourceFiles = computeCurrentHashes(parsed.sourceFiles);
    const currentDependencyFiles = computeCurrentHashes(parsed.dependencyFiles);
    const currentOutputFiles = computeCurrentHashes(parsed.outputFiles);
    if (currentSourceFiles === undefined || currentDependencyFiles === undefined || currentOutputFiles === undefined) {
        return false;
    }
    return compareHashedFileRecords(parsed.sourceFiles, currentSourceFiles)
        && compareHashedFileRecords(parsed.dependencyFiles, currentDependencyFiles)
        && compareHashedFileRecords(parsed.outputFiles, currentOutputFiles);
}

export function writeCompilerOutputBuildInfo(outputPath: string, buildInfo: CompilerOutputBuildInfo): void {
    const resolvedOutputPath = resolve(outputPath);
    const cacheEntry: CompilerOutputCacheEntry = {
        format: "iw-output-cache",
        version: 1,
        ...buildInfo
    };
    writeFileSync(buildCompilerOutputBuildInfoPath(resolvedOutputPath), `${JSON.stringify(cacheEntry, null, 2)}\n`, "utf8");
}

function collectFilesRecursive(rootPath: string, predicate: (filePath: string) => boolean): string[] {
    const resolvedRoot = resolve(rootPath);
    const stats = statSync(resolvedRoot);
    if (stats.isFile()) {
        return predicate(resolvedRoot) ? [resolvedRoot] : [];
    }
    if (!stats.isDirectory()) {
        return [];
    }
    const results: string[] = [];
    for (const child of readdirSync(resolvedRoot).sort()) {
        results.push(...collectFilesRecursive(join(resolvedRoot, child), predicate));
    }
    return results;
}

export function computeCompilerSha256(compilerRootPath: string): string {
    const resolvedCompilerRoot = resolve(compilerRootPath);
    const compilerFiles = collectFilesRecursive(resolvedCompilerRoot, (filePath) => extname(filePath) === ".js")
        .sort((left, right) => left.localeCompare(right));
    const hash = createHash("sha256");
    for (const filePath of compilerFiles) {
        hash.update(`${filePath}\n`, "utf8");
        hash.update(readFileSync(filePath));
    }
    return hash.digest("hex");
}

export function computeExternalFrontendCommandFingerprint(): {
    readonly externalFrontendCommand: string | null;
    readonly externalFrontendCommandSha256: string | null;
} {
    const command = process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND?.trim() ?? "";
    if (command.length === 0) {
        return {
            externalFrontendCommand: null,
            externalFrontendCommandSha256: null
        };
    }
    if (existsSync(command) && statSync(command).isFile()) {
        return {
            externalFrontendCommand: command,
            externalFrontendCommandSha256: hashFileSha256(command)
        };
    }
    return {
        externalFrontendCommand: command,
        externalFrontendCommandSha256: hashTextSha256(command)
    };
}

export function computeHashedFileRecords(filePaths: readonly string[]): readonly PrecompiledUnitHashedFileRecord[] {
    const uniquePaths = Array.from(new Set(filePaths.map((filePath) => resolve(filePath)))).sort((left, right) => left.localeCompare(right));
    return uniquePaths.map((filePath) => ({
        filePath,
        sha256: hashFileSha256(filePath)
    }));
}

function buildPackLibCacheRoot(outputArchivePath: string): string {
    const resolvedArchivePath = resolve(outputArchivePath);
    return join(resolvedArchivePath + ".cache");
}

function buildPackLibCacheBaseName(unitId: string): string {
    return `${sanitizeFileComponent(unitId)}_${hashTextSha256(unitId).slice(0, 16)}`;
}

function buildPackLibCachePaths(outputArchivePath: string, unitId: string): {
    readonly cacheRoot: string;
    readonly manifestPath: string;
    readonly assemblyPath: string;
    readonly supportPath: string;
} {
    const cacheRoot = buildPackLibCacheRoot(outputArchivePath);
    const baseName = buildPackLibCacheBaseName(unitId);
    return {
        cacheRoot,
        manifestPath: join(cacheRoot, `${baseName}.json`),
        assemblyPath: join(cacheRoot, `${baseName}.s`),
        supportPath: join(cacheRoot, `${baseName}.c`)
    };
}

export function tryLoadCachedPackLibUnit(
    outputArchivePath: string,
    unitId: string,
    expectedInputSignature: PrecompiledUnitInputSignature
): PrecompiledLibraryCompiledUnitArtifact | undefined {
    const cachePaths = buildPackLibCachePaths(outputArchivePath, unitId);
    if (!existsSync(cachePaths.manifestPath) || !existsSync(cachePaths.assemblyPath) || !existsSync(cachePaths.supportPath)) {
        return undefined;
    }

    const parsed = JSON.parse(readFileSync(cachePaths.manifestPath, "utf8")) as PackLibUnitCacheEntry;
    if (parsed.format !== "iw-pack-lib-unit-cache" || parsed.version !== 1 || parsed.unitId !== unitId) {
        return undefined;
    }
    if (!sameInputSignature(parsed.inputSignature, expectedInputSignature)) {
        return undefined;
    }

    const actualOutputFiles: readonly PrecompiledUnitHashedFileRecord[] = [
        { filePath: basename(cachePaths.assemblyPath), sha256: hashFileSha256(cachePaths.assemblyPath) },
        { filePath: basename(cachePaths.supportPath), sha256: hashFileSha256(cachePaths.supportPath) }
    ];
    if (!compareHashedFileRecords(parsed.outputFiles, actualOutputFiles)) {
        return undefined;
    }

    return {
        unitId,
        assemblyText: readFileSync(cachePaths.assemblyPath, "utf8"),
        supportText: readFileSync(cachePaths.supportPath, "utf8"),
        metadataTableExportSymbol: parsed.metadataTableExportSymbol,
        globalTableExportSymbol: parsed.globalTableExportSymbol,
        runtimeInitExportSymbol: parsed.runtimeInitExportSymbol,
        buildInfo: {
            ...parsed.inputSignature,
            outputFiles: parsed.outputFiles
        }
    };
}

export function writeCachedPackLibUnit(outputArchivePath: string, artifact: PrecompiledLibraryCompiledUnitArtifact, inputSignature: PrecompiledUnitInputSignature): PrecompiledLibraryCompiledUnitArtifact {
    const cachePaths = buildPackLibCachePaths(outputArchivePath, artifact.unitId);
    mkdirSync(cachePaths.cacheRoot, { recursive: true });
    writeFileSync(cachePaths.assemblyPath, artifact.assemblyText, "utf8");
    writeFileSync(cachePaths.supportPath, artifact.supportText, "utf8");
    const outputFiles: readonly PrecompiledUnitHashedFileRecord[] = [
        { filePath: basename(cachePaths.assemblyPath), sha256: hashFileSha256(cachePaths.assemblyPath) },
        { filePath: basename(cachePaths.supportPath), sha256: hashFileSha256(cachePaths.supportPath) }
    ];
    const cacheEntry: PackLibUnitCacheEntry = {
        format: "iw-pack-lib-unit-cache",
        version: 1,
        unitId: artifact.unitId,
        metadataTableExportSymbol: artifact.metadataTableExportSymbol,
        globalTableExportSymbol: artifact.globalTableExportSymbol,
        runtimeInitExportSymbol: artifact.runtimeInitExportSymbol,
        inputSignature,
        outputFiles,
        cachedAssemblyPath: basename(cachePaths.assemblyPath),
        cachedSupportPath: basename(cachePaths.supportPath)
    };
    writeFileSync(cachePaths.manifestPath, `${JSON.stringify(cacheEntry, null, 2)}\n`, "utf8");
    return {
        ...artifact,
        buildInfo: {
            ...inputSignature,
            outputFiles
        }
    };
}