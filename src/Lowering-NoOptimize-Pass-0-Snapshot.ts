import type { AstNode } from "./AstNode";
import type { LoweringSnapshotProgram } from "./Lowering-Frontend-Shared";
import {
    createLoweringSnapshotProgram,
    validateLoweringSnapshotProgram,
    type LoweringSnapshotOptions
} from "./Lowering-Pass-0-Snapshot";
import type { MonomorphizedArtifacts } from "./Typecheck-Pipeline";

export interface NoOptimizeLoweringSnapshotOptions extends LoweringSnapshotOptions {}

export function validateNoOptimizeLoweringSnapshotProgram(program: LoweringSnapshotProgram): void {
    validateLoweringSnapshotProgram(program);
}

export function createNoOptimizeLoweringSnapshotProgram(
    ast: AstNode,
    artifacts: MonomorphizedArtifacts,
    options?: NoOptimizeLoweringSnapshotOptions
): LoweringSnapshotProgram {
    return createLoweringSnapshotProgram(ast, artifacts, options);
}
