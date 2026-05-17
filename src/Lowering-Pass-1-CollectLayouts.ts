import type { LoweringClassLayout, LoweringLayoutTable, LoweringSnapshotProgram } from "./Lowering-Frontend-Shared";

const LOWERED_METHOD_PREFIX = "__iw_lowered_method";
const LOWERED_CONSTRUCTOR_PREFIX = "__iw_lowered_ctor";

function buildMethodSymbol(className: string, methodName: string): string {
    return `${LOWERED_METHOD_PREFIX}_${className}_${methodName}`;
}

function buildConstructorSymbol(className: string, overloadIndex: number): string {
    return `${LOWERED_CONSTRUCTOR_PREFIX}_${className}_${overloadIndex}`;
}

export function validateLoweringLayoutTable(layoutTable: LoweringLayoutTable, snapshot: LoweringSnapshotProgram): void {
    if (layoutTable.kind !== "lowering_layout_table") {
        throw new Error("Pass 1 layout validation failed: unexpected table kind");
    }

    for (const classDef of snapshot.concreteClasses) {
        const layout = layoutTable.classes.get(classDef.concreteName);
        if (!layout) {
            throw new Error(`Pass 1 layout validation failed: missing layout for class '${classDef.concreteName}'`);
        }
        if (layout.propertyOrder.length !== classDef.classNode.propertyNodeList.length) {
            throw new Error(`Pass 1 layout validation failed: field order mismatch for class '${classDef.concreteName}'`);
        }
        if (layout.runtimeTypeTagId !== classDef.runtimeTypeTagId) {
            throw new Error(`Pass 1 layout validation failed: runtime tag mismatch for class '${classDef.concreteName}'`);
        }
        if (layout.methodOrder.length !== classDef.classNode.methodNodeList.length) {
            throw new Error(`Pass 1 layout validation failed: method order mismatch for class '${classDef.concreteName}'`);
        }
        if (classDef.classNode.constructorNodeList.length === 0) {
            throw new Error(`Pass 1 layout validation failed: class '${classDef.concreteName}' must have at least one constructor`);
        }
        if (layout.constructors.length !== classDef.classNode.constructorNodeList.length) {
            throw new Error(`Pass 1 layout validation failed: constructor overload count mismatch for class '${classDef.concreteName}'`);
        }
        const seenMethodSymbols = new Set<string>();
        for (const methodName of layout.methodOrder) {
            const symbol = layout.methodSymbols.get(methodName);
            if (!symbol) {
                throw new Error(`Pass 1 layout validation failed: missing method symbol for '${classDef.concreteName}.${methodName}'`);
            }
            if (seenMethodSymbols.has(symbol)) {
                throw new Error(`Pass 1 layout validation failed: duplicate method symbol '${symbol}'`);
            }
            seenMethodSymbols.add(symbol);
        }
        const seenConstructorSymbols = new Set<string>();
        for (const constructor of layout.constructors) {
            if (seenConstructorSymbols.has(constructor.symbol)) {
                throw new Error(`Pass 1 layout validation failed: duplicate constructor symbol '${constructor.symbol}'`);
            }
            seenConstructorSymbols.add(constructor.symbol);
        }
    }
}

export function collectLoweringClassLayouts(snapshot: LoweringSnapshotProgram): LoweringLayoutTable {
    const layouts = new Map<string, LoweringClassLayout>();
    for (const classDef of snapshot.concreteClasses) {
        const propertyOrder = classDef.classNode.propertyNodeList.map((property) => property.bind.var.name);
        const methodOrder = classDef.classNode.methodNodeList.map((method) => method.methodName.name);
        const methodSymbols = new Map<string, string>();
        for (const methodName of methodOrder) {
            methodSymbols.set(methodName, buildMethodSymbol(classDef.concreteName, methodName));
        }
        const constructors = classDef.constructorParamTypes.map((paramTypes, index) => ({
            symbol: buildConstructorSymbol(classDef.concreteName, index),
            paramTypes
        }));
        layouts.set(classDef.concreteName, {
            className: classDef.concreteName,
            runtimeTypeTagId: classDef.runtimeTypeTagId,
            isExternal: classDef.isExternal ?? false,
            unitId: classDef.unitId ?? null,
            propertyOrder,
            propertyTypes: classDef.propertyTypes,
            methodOrder,
            methodTypes: classDef.methodTypes,
            methodSymbols,
            constructors
        });
    }

    const layoutTable: LoweringLayoutTable = {
        kind: "lowering_layout_table",
        classes: layouts
    };
    validateLoweringLayoutTable(layoutTable, snapshot);
    return layoutTable;
}

export function getLoweredMethodSymbol(className: string, methodName: string): string {
    return buildMethodSymbol(className, methodName);
}

export function getLoweredConstructorSymbol(className: string, overloadIndex = 0): string {
    return buildConstructorSymbol(className, overloadIndex);
}
