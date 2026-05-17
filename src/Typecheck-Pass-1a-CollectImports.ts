import { AstNode, ImportNode, ProgramNode, SeqNode } from "./AstNode";
import { getCompilationUnitMetadata } from "./ModuleMetadata";
import {
    formatUnitImportRecord,
    getAllUnitImportEntries,
    getUnitImportRecord,
    getUsedImportedPackagesForUnit,
    hasPackageSymbols,
    registerUnitImport
} from "./Typecheck-Modules";

export function collectImportsPass(ast: AstNode): void {
    if (ast instanceof ProgramNode) {
        ast.topLevelExpressions.forEach((expression) => collectImportsPass(expression));
        return;
    }

    if (ast instanceof SeqNode) {
        ast.expressions.forEach((expression) => collectImportsPass(expression));
        return;
    }

    if (!(ast instanceof ImportNode)) {
        return;
    }

    const metadata = getCompilationUnitMetadata(ast);
    const unitId = metadata?.unitId ?? null;
    const existingImport = getUnitImportRecord(unitId, ast.packagePath.name);
    if (existingImport !== undefined) {
        throw new Error(`${formatUnitImportRecord(existingImport)}: duplicate import of package '${ast.packagePath.name}'`);
    }
    registerUnitImport({
        unitId,
        packageName: ast.packagePath.name,
        filePath: metadata?.filePath ?? null
    });
}

export function validateImportsPass(): void {
    for (const [, imports] of getAllUnitImportEntries()) {
        for (const importRecord of imports.values()) {
            if (!hasPackageSymbols(importRecord.packageName)) {
                throw new Error(`${formatUnitImportRecord(importRecord)}: imported package '${importRecord.packageName}' does not exist`);
            }
        }
    }
}

export function validateUnusedImportsPass(): void {
    for (const [unitId, imports] of getAllUnitImportEntries()) {
        const usedImports = getUsedImportedPackagesForUnit(unitId);
        for (const importRecord of imports.values()) {
            if (!usedImports.has(importRecord.packageName)) {
                throw new Error(`${formatUnitImportRecord(importRecord)}: unused import of package '${importRecord.packageName}'`);
            }
        }
    }
}