import { existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { normalizeBuildTarget, type BuildTarget } from "./Target";

function directoryExists(path: string): boolean {
    return existsSync(path) && statSync(path).isDirectory();
}

function resolveExistingBaseLibDir(candidates: readonly string[], description: string): string {
    for (const candidate of candidates) {
        if (directoryExists(candidate)) {
            return resolve(candidate);
        }
    }

    throw new Error(`Unable to locate ${description} directory for base lib`);
}

function resolveCombinedBaseLibDir(candidates: readonly string[], platformStdFileName: string): string | undefined {
    for (const candidate of candidates) {
        if (
            directoryExists(candidate) &&
            existsSync(join(candidate, "std~array@v1.iw")) &&
            existsSync(join(candidate, platformStdFileName))
        ) {
            return resolve(candidate);
        }
    }
    return undefined;
}

export function resolveBaseLibDirs(target?: BuildTarget): readonly string[] {
    const normalizedTarget = normalizeBuildTarget(target);
    const platformStdDirectoryName = normalizedTarget === "windows-x64" ? "std-windows" : "std-linux";
    const platformStdFileName = normalizedTarget === "windows-x64" ? "std~windows~sys@v1.iw" : "std~linux~sys@v1.iw";
    const combinedDir = resolveCombinedBaseLibDir([
        join(dirname(process.execPath), "std"),
        join(__dirname, "std"),
        join(process.cwd(), "std"),
        join(process.cwd(), "src/std"),
        join(__dirname, "../src/std"),
    ], platformStdFileName);
    if (combinedDir !== undefined) {
        return [combinedDir];
    }

    const commonDir = resolveExistingBaseLibDir([
        join(dirname(process.execPath), "std"),
        join(__dirname, "std"),
        join(__dirname, "../src/std"),
        join(process.cwd(), "src/std"),
        join(process.cwd(), "std"),
    ], "shared std");
    const platformDir = resolveExistingBaseLibDir([
        join(dirname(process.execPath), platformStdDirectoryName),
        join(__dirname, platformStdDirectoryName),
        join(__dirname, `../src/${platformStdDirectoryName}`),
        join(process.cwd(), `src/${platformStdDirectoryName}`),
        join(process.cwd(), platformStdDirectoryName),
    ], platformStdDirectoryName);
    return [commonDir, platformDir];
}

export function getBaseLibSourceRoots(target?: BuildTarget): readonly string[] {
    return resolveBaseLibDirs(target);
}
