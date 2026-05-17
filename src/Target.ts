export type BuildTarget = "linux-x64" | "windows-x64";

export const defaultBuildTarget: BuildTarget = "linux-x64";

export function normalizeBuildTarget(target: BuildTarget | undefined): BuildTarget {
    return target ?? defaultBuildTarget;
}

export function isWindowsTarget(target: BuildTarget): target is "windows-x64" {
    return target === "windows-x64";
}
