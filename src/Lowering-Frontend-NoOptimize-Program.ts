import type {
    AnfProgram,
    CapturedMutableCheckedProgram,
    CfgProgram,
    ClosureConvertedProgram,
    DesugaredCoreProgram,
    FreeVarAnalysisResult,
    LinearizedProgram,
    LoweringStageAResult,
    SsaProgram,
    TypedSlotProgram
} from "./Lowering-Frontend-Shared";
import type {
    CfgTrimmedRootCandidateProgram,
    FinalBackendIRProgram,
    GcRootPlan,
    MayCollectProgram,
    RepresentationSelectionProgram,
    TrimmedRootCandidateProgram
} from "./backend-linux/Backend-Linux-IR-Shared";

export interface NoOptimizeLoweringStageBResult extends LoweringStageAResult {
    readonly pass4: DesugaredCoreProgram;
    readonly pass5: AnfProgram;
    readonly pass6: FreeVarAnalysisResult;
}

export interface NoOptimizeLoweringFrontendStageCResult extends NoOptimizeLoweringStageBResult {
    readonly pass7: CapturedMutableCheckedProgram;
    readonly pass8: ClosureConvertedProgram;
    readonly pass8a: TypedSlotProgram;
    readonly pass9: LinearizedProgram;
    readonly pass9c: CfgProgram;
    readonly pass9f: SsaProgram;
    readonly pass9h: SsaProgram;
    readonly pass9b: RepresentationSelectionProgram;
    readonly pass9d: MayCollectProgram;
    readonly pass9e: TrimmedRootCandidateProgram;
    readonly pass9g: CfgTrimmedRootCandidateProgram;
    readonly pass9a: GcRootPlan;
    readonly pass10: FinalBackendIRProgram;
}