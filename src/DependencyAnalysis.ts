import { basename, extname, resolve } from "path";
import { parseCompilationUnitId } from "./ModuleMetadata";
import { getAllUnitImportEntries, getUsedImportedSymbolsForUnit } from "./Typecheck-Modules";

export interface ProgramDependencyAnalysis {
    readonly sourceFiles: readonly string[];
    readonly dependencyFiles: readonly string[];
}

type UnitSourceInfo = {
    readonly unitId: string;
    readonly packageName: string;
    readonly filePath: string;
};

function buildUnitSourceInfos(allSourceFiles: readonly string[]): readonly UnitSourceInfo[] {
    return allSourceFiles
        .map((filePath) => resolve(filePath))
        .filter((filePath) => extname(filePath) === ".iw")
        .map((filePath) => {
            const unitId = basename(filePath, ".iw");
            const metadata = parseCompilationUnitId(unitId);
            return metadata === null ? null : {
                unitId,
                packageName: metadata.packageName,
                filePath
            };
        })
        .filter((info): info is UnitSourceInfo => info !== null);
}

function addFiles(target: Set<string>, filePaths: readonly string[]): void {
    for (const filePath of filePaths) {
        target.add(resolve(filePath));
    }
}

export function analyzeProgramDependencies(rootSourceFiles: readonly string[], allSourceFiles: readonly string[], packageDbFiles: readonly string[]): ProgramDependencyAnalysis {
    const normalizedRootSourceFiles = Array.from(new Set(rootSourceFiles.map((filePath) => resolve(filePath)))).sort((left, right) => left.localeCompare(right));
    const unitInfos = buildUnitSourceInfos(allSourceFiles);
    const packageFiles = new Map<string, string[]>();
    const unitFileById = new Map<string, string>();
    for (const info of unitInfos) {
        const packageEntries = packageFiles.get(info.packageName) ?? [];
        packageEntries.push(info.filePath);
        packageFiles.set(info.packageName, packageEntries);
        unitFileById.set(info.unitId, info.filePath);
    }

    const rootUnitIds = new Set(
        normalizedRootSourceFiles
            .filter((filePath) => extname(filePath) === ".iw")
            .map((filePath) => basename(filePath, ".iw"))
    );
    const queuedUnitIds = [...rootUnitIds];
    const visitedUnitIds = new Set<string>();
    const dependencyFiles = new Set<string>();
    const directImportEntries = new Map(Array.from(getAllUnitImportEntries(), ([unitId, packageImports]) => [unitId, new Map(packageImports)] as const));

    while (queuedUnitIds.length > 0) {
        const unitId = queuedUnitIds.pop();
        if (unitId === undefined || visitedUnitIds.has(unitId)) {
            continue;
        }
        visitedUnitIds.add(unitId);

        const unitImports = directImportEntries.get(unitId) ?? new Map();
        const usedImportedSymbols = getUsedImportedSymbolsForUnit(unitId);
        const usedImportedSymbolsByPackage = new Map<string, readonly string[]>();
        for (const usage of usedImportedSymbols) {
            const existing = usedImportedSymbolsByPackage.get(usage.packageName) ?? [];
            const specificFiles = Array.from(new Set(usage.records.map((record) => record.filePath).filter((filePath): filePath is string => filePath !== null))).map((filePath) => resolve(filePath));
            usedImportedSymbolsByPackage.set(usage.packageName, [...existing, ...specificFiles]);
        }

        for (const importedPackage of unitImports.keys()) {
            const exactFiles = Array.from(new Set(usedImportedSymbolsByPackage.get(importedPackage) ?? [])).sort((left, right) => left.localeCompare(right));
            const packageScopeFiles = Array.from(new Set((packageFiles.get(importedPackage) ?? []).map((filePath) => resolve(filePath)))).sort((left, right) => left.localeCompare(right));
            const selectedFiles = exactFiles.length > 0 ? exactFiles : packageScopeFiles;
            addFiles(dependencyFiles, selectedFiles);
            for (const filePath of selectedFiles) {
                const importedUnitId = basename(filePath, ".iw");
                if (!visitedUnitIds.has(importedUnitId) && unitFileById.has(importedUnitId)) {
                    queuedUnitIds.push(importedUnitId);
                }
            }
        }
    }

    const normalizedDependencyFiles = Array.from(dependencyFiles)
        .filter((filePath) => !normalizedRootSourceFiles.includes(filePath))
        .sort((left, right) => left.localeCompare(right));
    addFiles(dependencyFiles, packageDbFiles);
    return {
        sourceFiles: normalizedRootSourceFiles,
        dependencyFiles: Array.from(new Set([...normalizedDependencyFiles, ...packageDbFiles.map((filePath) => resolve(filePath))])).sort((left, right) => left.localeCompare(right))
    };
}