import type { LoweringLayoutTable, LoweringSnapshotProgram } from "./Lowering-Frontend-Shared";
import {
    collectLoweringClassLayouts,
    getLoweredConstructorSymbol,
    getLoweredMethodSymbol,
    validateLoweringLayoutTable
} from "./Lowering-Pass-1-CollectLayouts";

export function validateNoOptimizeLoweringLayoutTable(layoutTable: LoweringLayoutTable, snapshot: LoweringSnapshotProgram): void {
    validateLoweringLayoutTable(layoutTable, snapshot);
}

export function collectNoOptimizeLoweringClassLayouts(snapshot: LoweringSnapshotProgram): LoweringLayoutTable {
    return collectLoweringClassLayouts(snapshot);
}

export function getNoOptimizeLoweredMethodSymbol(className: string, methodName: string): string {
    return getLoweredMethodSymbol(className, methodName);
}

export function getNoOptimizeLoweredConstructorSymbol(className: string, overloadIndex = 0): string {
    return getLoweredConstructorSymbol(className, overloadIndex);
}
