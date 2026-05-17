import type {
    LoweredClassPrimitiveProgram,
    LoweringLayoutTable,
    LoweringSnapshotProgram
} from "./Lowering-Frontend-Shared";
import {
    lowerClassPrimitivesPass,
    validateLoweredClassPrimitiveProgram
} from "./Lowering-Pass-2-LowerClassPrimitives";

export function validateNoOptimizeLoweredClassPrimitiveProgram(program: LoweredClassPrimitiveProgram): void {
    validateLoweredClassPrimitiveProgram(program);
}

export function lowerNoOptimizeClassPrimitivesPass(
    snapshot: LoweringSnapshotProgram,
    layouts: LoweringLayoutTable
): LoweredClassPrimitiveProgram {
    return lowerClassPrimitivesPass(snapshot, layouts);
}
