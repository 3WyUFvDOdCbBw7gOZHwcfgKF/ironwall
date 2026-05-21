import { AstNode } from "./AstNode";
import { getCompilationUnitMetadata } from "./ModuleMetadata";
import { relative } from "path";

export type PackageSymbolKind = "class" | "generic_class" | "function" | "generic_function" | "global" | "db";

export interface PackageSymbolRecord {
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly filePath: string | null;
    readonly exportedName: string;
    readonly canonicalName: string;
    readonly kind: PackageSymbolKind;
    readonly isExported: boolean;
    readonly genericArity?: number;
}

export interface PackageSymbolTableEntry {
    readonly exportedName: string;
    readonly records: PackageSymbolRecord[];
}

export interface UnitImportRecord {
    readonly unitId: string | null;
    readonly packageName: string;
    readonly filePath: string | null;
}

export interface UsedImportedSymbolRecord {
    readonly packageName: string;
    readonly exportedName: string;
    readonly records: readonly PackageSymbolRecord[];
}

export const packageSymbolTable: Map<string | null, Map<string, PackageSymbolRecord[]>> = new Map();
export const unitImportTable: Map<string | null, Map<string, UnitImportRecord>> = new Map();
export const usedUnitImportTable: Map<string | null, Set<string>> = new Map();
export const usedImportedSymbolTable: Map<string | null, Map<string, Map<string, PackageSymbolRecord[]>>> = new Map();

const MONOMORPHIZED_PACKAGE_PREFIXES = ["__iw_mono_class_", "__iw_mono_fn_"] as const;

export function resetPackageSymbolTable(): void {
    packageSymbolTable.clear();
    unitImportTable.clear();
    usedUnitImportTable.clear();
    usedImportedSymbolTable.clear();
}

export function registerPackageSymbol(record: PackageSymbolRecord): void {
    const packageExports = packageSymbolTable.get(record.packageName) ?? new Map<string, PackageSymbolRecord[]>();
    const existing = packageExports.get(record.exportedName) ?? [];
    existing.push(record);
    packageExports.set(record.exportedName, existing);
    packageSymbolTable.set(record.packageName, packageExports);
}

export function getPackageSymbolEntries(): PackageSymbolTableEntry[] {
    const entries: PackageSymbolTableEntry[] = [];
    for (const packageExports of packageSymbolTable.values()) {
        for (const [exportedName, records] of packageExports.entries()) {
            entries.push({ exportedName, records: [...records] });
        }
    }
    return entries;
}

export function registerUnitImport(record: UnitImportRecord): void {
    const imports = unitImportTable.get(record.unitId) ?? new Map<string, UnitImportRecord>();
    imports.set(record.packageName, record);
    unitImportTable.set(record.unitId, imports);
}

export function getUnitImportRecord(unitId: string | null, packageName: string): UnitImportRecord | undefined {
    return unitImportTable.get(unitId)?.get(packageName);
}

export function getUnitImportRecords(unitId: string | null): readonly UnitImportRecord[] {
    return Array.from((unitImportTable.get(unitId) ?? new Map<string, UnitImportRecord>()).values());
}

export function getAllUnitImportEntries(): IterableIterator<[string | null, Map<string, UnitImportRecord>]> {
    return unitImportTable.entries();
}

export function getImportedPackagesForUnit(unitId: string | null): ReadonlySet<string> {
    return new Set((unitImportTable.get(unitId) ?? new Map<string, UnitImportRecord>()).keys());
}

export function formatDiagnosticPath(filePath: string | null): string {
    if (filePath === null) {
        return "<unknown file>";
    }
    const relativePath = relative(process.cwd(), filePath);
    return relativePath.length === 0 ? filePath : relativePath;
}

export function formatUnitImportRecord(record: UnitImportRecord): string {
    const unitLabel = record.unitId ?? "<legacy>";
    return `unit ${unitLabel} (${formatDiagnosticPath(record.filePath)})`;
}

export function markUnitImportUsed(unitId: string | null, packageName: string): void {
    const usedImports = usedUnitImportTable.get(unitId) ?? new Set<string>();
    usedImports.add(packageName);
    usedUnitImportTable.set(unitId, usedImports);
}

export function getUsedImportedPackagesForUnit(unitId: string | null): ReadonlySet<string> {
    return usedUnitImportTable.get(unitId) ?? new Set<string>();
}

function mergeDistinctPackageSymbolRecords(existingRecords: readonly PackageSymbolRecord[], newRecords: readonly PackageSymbolRecord[]): PackageSymbolRecord[] {
    const result = [...existingRecords];
    const seenKeys = new Set(existingRecords.map((record) => `${record.kind}\u0000${record.canonicalName}\u0000${record.filePath ?? ""}`));
    for (const record of newRecords) {
        const key = `${record.kind}\u0000${record.canonicalName}\u0000${record.filePath ?? ""}`;
        if (seenKeys.has(key)) {
            continue;
        }
        seenKeys.add(key);
        result.push(record);
    }
    return result;
}

export function markImportedPackageSymbolsUsed(unitId: string | null, packageName: string, exportedName: string, records: readonly PackageSymbolRecord[]): void {
    if (records.length === 0) {
        return;
    }
    const unitRecords = usedImportedSymbolTable.get(unitId) ?? new Map<string, Map<string, PackageSymbolRecord[]>>();
    const packageRecords = unitRecords.get(packageName) ?? new Map<string, PackageSymbolRecord[]>();
    const existingRecords = packageRecords.get(exportedName) ?? [];
    packageRecords.set(exportedName, mergeDistinctPackageSymbolRecords(existingRecords, records));
    unitRecords.set(packageName, packageRecords);
    usedImportedSymbolTable.set(unitId, unitRecords);
}

export function getUsedImportedSymbolsForUnit(unitId: string | null): readonly UsedImportedSymbolRecord[] {
    const unitRecords = usedImportedSymbolTable.get(unitId);
    if (unitRecords === undefined) {
        return [];
    }
    const result: UsedImportedSymbolRecord[] = [];
    for (const [packageName, packageEntries] of unitRecords.entries()) {
        for (const [exportedName, records] of packageEntries.entries()) {
            result.push({
                packageName,
                exportedName,
                records: [...records]
            });
        }
    }
    return result;
}

export function hasPackageSymbols(packageName: string): boolean {
    return (packageSymbolTable.get(packageName)?.size ?? 0) > 0;
}

function formatPackageSymbolRecord(record: PackageSymbolRecord): string {
    const unitLabel = record.unitId ?? "<legacy>";
    return `${record.canonicalName} from unit ${unitLabel} (${formatDiagnosticPath(record.filePath)})`;
}

function collectRecordsForPackage(packageName: string, exportedName: string, acceptedKindSet: ReadonlySet<PackageSymbolKind>, includeNonExported = false): PackageSymbolRecord[] {
    const packageExports = packageSymbolTable.get(packageName);
    const records = packageExports?.get(exportedName) ?? [];
    return records.filter((record) => acceptedKindSet.has(record.kind) && (includeNonExported || record.isExported));
}

function collectHiddenRecordsForPackage(packageName: string, exportedName: string, acceptedKindSet: ReadonlySet<PackageSymbolKind>): PackageSymbolRecord[] {
    const packageExports = packageSymbolTable.get(packageName);
    const records = packageExports?.get(exportedName) ?? [];
    return records.filter((record) => acceptedKindSet.has(record.kind) && !record.isExported);
}

function collectGenericRecordsForPackage(packageName: string, exportedName: string, kind: "generic_class" | "generic_function", genericArity?: number, includeNonExported = false): PackageSymbolRecord[] {
    const packageExports = packageSymbolTable.get(packageName);
    const records = packageExports?.get(exportedName) ?? [];
    return records.filter((record) => record.kind === kind && (genericArity === undefined || record.genericArity === genericArity) && (includeNonExported || record.isExported));
}

function collectHiddenGenericRecordsForPackage(packageName: string, exportedName: string, kind: "generic_class" | "generic_function", genericArity?: number): PackageSymbolRecord[] {
    const packageExports = packageSymbolTable.get(packageName);
    const records = packageExports?.get(exportedName) ?? [];
    return records.filter((record) => record.kind === kind && (genericArity === undefined || record.genericArity === genericArity) && !record.isExported);
}

function collectDbRecordsForPackage(packageName: string, exportedName: string): PackageSymbolRecord[] {
    const packageExports = packageSymbolTable.get(packageName);
    const records = packageExports?.get(exportedName) ?? [];
    return records.filter((record) => record.kind === "db");
}

function getSourcePackageNameForMonomorphizedPackage(packageName: string): string | undefined {
    for (const prefix of MONOMORPHIZED_PACKAGE_PREFIXES) {
        if (packageName.startsWith(prefix) && packageName.length > prefix.length) {
            return packageName.slice(prefix.length);
        }
    }
    return undefined;
}

function resolveImportedPackageUsageKey(referenceNode: AstNode, packageName: string): string | undefined {
    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined || metadata.packageName === packageName) {
        return undefined;
    }
    if (getImportedPackagesForUnit(metadata.unitId).has(packageName)) {
        return packageName;
    }
    const sourcePackageName = getSourcePackageNameForMonomorphizedPackage(packageName);
    if (sourcePackageName !== undefined && getImportedPackagesForUnit(metadata.unitId).has(sourcePackageName)) {
        return sourcePackageName;
    }
    return undefined;
}

function markImportedPackageSymbolRecordsUsed(referenceNode: AstNode, packageName: string, exportedName: string, records: readonly PackageSymbolRecord[]): void {
    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return;
    }
    const importedPackageKey = resolveImportedPackageUsageKey(referenceNode, packageName);
    if (importedPackageKey === undefined) {
        return;
    }
    markUnitImportUsed(metadata.unitId, importedPackageKey);
    markImportedPackageSymbolsUsed(metadata.unitId, importedPackageKey, exportedName, records);
}

function getVisibleQualifiedPackageName(referenceNode: AstNode, qualifiedName: string, separator: "@" | "$"): string | undefined {
    const separatorIndex = qualifiedName.lastIndexOf(separator);
    if (separatorIndex <= 0 || separatorIndex >= qualifiedName.length - 1) {
        return undefined;
    }

    const packageName = qualifiedName.slice(0, separatorIndex);
    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return packageName;
    }
    const sourcePackageName = getSourcePackageNameForMonomorphizedPackage(packageName);

    if (metadata.packageName === packageName) {
        return packageName;
    }

    if (metadata.packageName.startsWith("std~") && (packageName.startsWith("std~") || sourcePackageName?.startsWith("std~") === true)) {
        return packageName;
    }

    if (getImportedPackagesForUnit(metadata.unitId).has(packageName)) {
        markUnitImportUsed(metadata.unitId, packageName);
        return packageName;
    }

    if (sourcePackageName !== undefined) {
        if (metadata.packageName === sourcePackageName) {
            return packageName;
        }
        if (getImportedPackagesForUnit(metadata.unitId).has(sourcePackageName)) {
            markUnitImportUsed(metadata.unitId, sourcePackageName);
            return packageName;
        }
    }

    throw new Error(`unit ${metadata.unitId}: package '${packageName}' is not visible; import it explicitly`);
}

function getQualifiedDatabaseReferenceCanonicalNames(referenceNode: AstNode, qualifiedName: string): string[] {
    const separatorIndex = qualifiedName.lastIndexOf("$");
    const packageName = getVisibleQualifiedPackageName(referenceNode, qualifiedName, "$");
    if (packageName === undefined) {
        return [];
    }
    const exportedName = qualifiedName.slice(separatorIndex + 1);
    const records = collectDbRecordsForPackage(packageName, exportedName);
    markImportedPackageSymbolRecordsUsed(referenceNode, packageName, exportedName, records);
    return Array.from(new Set(records.map((record) => record.canonicalName)));
}

function getQualifiedPackageSymbolCanonicalNames(referenceNode: AstNode, qualifiedName: string, acceptedKindSet: ReadonlySet<PackageSymbolKind>): string[] {
    const separatorIndex = qualifiedName.lastIndexOf("@");
    const packageName = getVisibleQualifiedPackageName(referenceNode, qualifiedName, "@");
    if (packageName === undefined) {
        return [];
    }

    const exportedName = qualifiedName.slice(separatorIndex + 1);
    const metadata = getCompilationUnitMetadata(referenceNode);
    const includeNonExported = metadata !== undefined && metadata.packageName === packageName;
    const records = collectRecordsForPackage(packageName, exportedName, acceptedKindSet, includeNonExported);
    if (records.length === 0 && !includeNonExported && metadata !== undefined) {
        const hiddenRecords = collectHiddenRecordsForPackage(packageName, exportedName, acceptedKindSet);
        if (hiddenRecords.length > 0) {
            throw new Error(`unit ${metadata.unitId}: symbol '${exportedName}' is not exported by package '${packageName}'`);
        }
    }
    markImportedPackageSymbolRecordsUsed(referenceNode, packageName, exportedName, records);
    return Array.from(new Set(records.map((record) => record.canonicalName)));
}

export function getVisiblePackageSymbolCanonicalNames(referenceNode: AstNode, exportedName: string, acceptedKinds: readonly PackageSymbolKind[]): string[] {
    const acceptedKindSet = new Set<PackageSymbolKind>(acceptedKinds);
    if (exportedName.includes("@")) {
        return getQualifiedPackageSymbolCanonicalNames(referenceNode, exportedName, acceptedKindSet);
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return [];
    }

    const currentPackageRecords = collectRecordsForPackage(metadata.packageName, exportedName, acceptedKindSet, true);
    const currentPackageMatches = Array.from(new Set(currentPackageRecords.map((record) => record.canonicalName)));
    if (currentPackageMatches.length > 1) {
        const candidates = currentPackageRecords.map((record) => formatPackageSymbolRecord(record)).join(", ");
        throw new Error(`unit ${metadata.unitId}: ambiguous current-package symbol '${exportedName}'; candidates: ${candidates}`);
    }
    if (currentPackageMatches.length === 1) {
        return currentPackageMatches;
    }

    const canonicalNames = new Set<string>();
    const matchedPackages = new Set<string>();
    const matchedRecords: PackageSymbolRecord[] = [];
    const hiddenMatchedPackages = new Set<string>();

    for (const packageName of getImportedPackagesForUnit(metadata.unitId)) {
        const packageRecords = collectRecordsForPackage(packageName, exportedName, acceptedKindSet);
        const packageMatches = Array.from(new Set(packageRecords.map((record) => record.canonicalName)));
        packageMatches.forEach((canonicalName) => canonicalNames.add(canonicalName));
        if (packageMatches.length > 0) {
            matchedPackages.add(packageName);
            matchedRecords.push(...packageRecords);
            continue;
        }
        if (collectHiddenRecordsForPackage(packageName, exportedName, acceptedKindSet).length > 0) {
            hiddenMatchedPackages.add(packageName);
        }
    }

    if (canonicalNames.size > 1) {
        const packageList = Array.from(matchedPackages).sort().join(", ");
        const candidates = matchedRecords.map((record) => formatPackageSymbolRecord(record)).join(", ");
        throw new Error(`unit ${metadata.unitId}: ambiguous imported symbol '${exportedName}'${packageList.length > 0 ? ` from packages ${packageList}` : ""}; candidates: ${candidates}`);
    }

    if (canonicalNames.size === 0 && hiddenMatchedPackages.size > 0) {
        const packageList = Array.from(hiddenMatchedPackages).sort();
        if (packageList.length === 1) {
            throw new Error(`unit ${metadata.unitId}: symbol '${exportedName}' is not exported by package '${packageList[0]}'`);
        }
        throw new Error(`unit ${metadata.unitId}: symbol '${exportedName}' is not exported by imported packages ${packageList.join(", ")}`);
    }

    if (canonicalNames.size === 1 && matchedPackages.size === 1) {
        const matchedPackage = Array.from(matchedPackages)[0];
        const matchedCanonicalNames = new Set(canonicalNames);
        markUnitImportUsed(metadata.unitId, matchedPackage);
        markImportedPackageSymbolsUsed(metadata.unitId, matchedPackage, exportedName, matchedRecords.filter((record) => matchedCanonicalNames.has(record.canonicalName)));
    }

    return Array.from(canonicalNames);
}

export function getVisibleGenericPackageSymbolCanonicalNames(referenceNode: AstNode, exportedName: string, kind: "generic_class" | "generic_function", genericArity?: number): string[] {
    if (exportedName.includes("@")) {
        const separatorIndex = exportedName.lastIndexOf("@");
        const packageName = getVisibleQualifiedPackageName(referenceNode, exportedName, "@");
        if (packageName === undefined) {
            return [];
        }
        const shortName = exportedName.slice(separatorIndex + 1);
        const metadata = getCompilationUnitMetadata(referenceNode);
        const includeNonExported = metadata !== undefined && metadata.packageName === packageName;
        const records = collectGenericRecordsForPackage(packageName, shortName, kind, genericArity, includeNonExported);
        if (records.length === 0 && !includeNonExported && metadata !== undefined) {
            const hiddenRecords = collectHiddenGenericRecordsForPackage(packageName, shortName, kind, genericArity);
            if (hiddenRecords.length > 0) {
                throw new Error(`unit ${metadata.unitId}: symbol '${shortName}' is not exported by package '${packageName}'`);
            }
        }
        return Array.from(new Set(records.map((record) => record.canonicalName)));
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return [];
    }

    const currentPackageMatches = Array.from(new Set(
        collectGenericRecordsForPackage(metadata.packageName, exportedName, kind, genericArity, true).map((record) => record.canonicalName)
    ));
    if (currentPackageMatches.length > 0) {
        return currentPackageMatches;
    }

    const canonicalNames = new Set<string>();
    const matchedPackages = new Set<string>();
    const matchedRecords: PackageSymbolRecord[] = [];
    const hiddenMatchedPackages = new Set<string>();

    for (const packageName of getImportedPackagesForUnit(metadata.unitId)) {
        const packageRecords = collectGenericRecordsForPackage(packageName, exportedName, kind, genericArity);
        const packageMatches = Array.from(new Set(packageRecords.map((record) => record.canonicalName)));
        packageMatches.forEach((canonicalName) => canonicalNames.add(canonicalName));
        if (packageMatches.length > 0) {
            matchedPackages.add(packageName);
            matchedRecords.push(...packageRecords);
            continue;
        }
        if (collectHiddenGenericRecordsForPackage(packageName, exportedName, kind, genericArity).length > 0) {
            hiddenMatchedPackages.add(packageName);
        }
    }

    if (matchedPackages.size > 1) {
        const packageList = Array.from(matchedPackages).sort().join(", ");
        const candidates = matchedRecords.map((record) => formatPackageSymbolRecord(record)).join(", ");
        throw new Error(`unit ${metadata.unitId}: ambiguous imported symbol '${exportedName}'${packageList.length > 0 ? ` from packages ${packageList}` : ""}; candidates: ${candidates}`);
    }

    if (canonicalNames.size === 0 && hiddenMatchedPackages.size > 0) {
        const packageList = Array.from(hiddenMatchedPackages).sort();
        if (packageList.length === 1) {
            throw new Error(`unit ${metadata.unitId}: symbol '${exportedName}' is not exported by package '${packageList[0]}'`);
        }
        throw new Error(`unit ${metadata.unitId}: symbol '${exportedName}' is not exported by imported packages ${packageList.join(", ")}`);
    }

    if (canonicalNames.size > 0 && matchedPackages.size === 1) {
        const matchedPackage = Array.from(matchedPackages)[0];
        markUnitImportUsed(metadata.unitId, matchedPackage);
        markImportedPackageSymbolsUsed(metadata.unitId, matchedPackage, exportedName, matchedRecords);
    }

    return Array.from(canonicalNames);
}

export function getVisibleDatabaseReferenceCanonicalNames(referenceNode: AstNode, sourceReferenceName: string, exportedName: string): string[] {
    if (!sourceReferenceName.startsWith("$") && sourceReferenceName.includes("$")) {
        return getQualifiedDatabaseReferenceCanonicalNames(referenceNode, sourceReferenceName);
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return [];
    }

    const currentPackageRecords = collectDbRecordsForPackage(metadata.packageName, exportedName);
    const currentPackageMatches = Array.from(new Set(currentPackageRecords.map((record) => record.canonicalName)));
    if (currentPackageMatches.length > 1) {
        const candidates = currentPackageRecords.map((record) => formatPackageSymbolRecord(record)).join(", ");
        throw new Error(`unit ${metadata.unitId}: ambiguous current-package db reference '${sourceReferenceName}'; candidates: ${candidates}`);
    }
    if (currentPackageMatches.length === 1) {
        return currentPackageMatches;
    }

    const canonicalNames = new Set<string>();
    const matchedPackages = new Set<string>();
    const matchedRecords: PackageSymbolRecord[] = [];

    for (const packageName of getImportedPackagesForUnit(metadata.unitId)) {
        const packageRecords = collectDbRecordsForPackage(packageName, exportedName);
        const packageMatches = Array.from(new Set(packageRecords.map((record) => record.canonicalName)));
        packageMatches.forEach((canonicalName) => canonicalNames.add(canonicalName));
        if (packageMatches.length > 0) {
            matchedPackages.add(packageName);
            matchedRecords.push(...packageRecords);
        }
    }

    if (canonicalNames.size > 1) {
        const packageList = Array.from(matchedPackages).sort().join(", ");
        const candidates = matchedRecords.map((record) => formatPackageSymbolRecord(record)).join(", ");
        throw new Error(`unit ${metadata.unitId}: ambiguous imported db reference '${sourceReferenceName}'${packageList.length > 0 ? ` from packages ${packageList}` : ""}; candidates: ${candidates}`);
    }

    if (canonicalNames.size === 1 && matchedPackages.size === 1) {
        const matchedPackage = Array.from(matchedPackages)[0];
        const matchedCanonicalNames = new Set(canonicalNames);
        markUnitImportUsed(metadata.unitId, matchedPackage);
        markImportedPackageSymbolsUsed(metadata.unitId, matchedPackage, exportedName, matchedRecords.filter((record) => matchedCanonicalNames.has(record.canonicalName)));
    }

    return Array.from(canonicalNames);
}
