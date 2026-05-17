import { existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { normalizeBuildTarget, type BuildTarget } from "./Target";

export function resolveBaseLibDir(target?: BuildTarget): string {
    const normalizedTarget = normalizeBuildTarget(target);
    const stdDirectoryName = normalizedTarget === "windows-x64" ? "std-windows" : "std-linux";
    const candidates = [
        join(dirname(process.execPath), stdDirectoryName),
        join(__dirname, stdDirectoryName),
        join(__dirname, `../src/${stdDirectoryName}`),
        join(process.cwd(), `src/${stdDirectoryName}`),
        join(process.cwd(), stdDirectoryName),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return resolve(candidate);
        }
    }

    throw new Error(`Unable to locate ${stdDirectoryName} directory for base lib`);
}

export function getBaseLibSourceRoots(target?: BuildTarget): readonly string[] {
    return [resolveBaseLibDir(target)];
}
