import type {
    X64BranchOptimizedProgram,
    X64CopyPropagatedProgram,
    X64InterferenceProgram,
    X64FrameLayoutProgram,
    X64LivenessProgram,
    X64LaidOutProgram,
    X64MirProgram,
    X64AllocationProgram,
    X64PostRAPeepholeProgram,
    X64RegAllocatedProgram,
    X64Round2BranchOptimizedProgram,
    X64Round2LaidOutProgram,
    X64Round2PeepholeProgram,
    X64SelectedProgram,
    X64TextualAssemblyProgram
} from "./Backend-Windows-IR-Shared";

export interface OptimizedX64PassBundle {
    readonly pass11x64mir: X64MirProgram;
    readonly pass12x64selected: X64SelectedProgram;
    readonly pass13x64copyprop: X64CopyPropagatedProgram;
    readonly pass14ax64liveness: X64LivenessProgram;
    readonly pass14bx64interference: X64InterferenceProgram;
    readonly pass14cx64allocation: X64AllocationProgram;
    readonly pass14x64regalloc: X64RegAllocatedProgram;
    readonly pass15x64framelayout: X64FrameLayoutProgram;
    readonly pass16x64postra: X64PostRAPeepholeProgram;
    readonly pass17x64branchopt: X64BranchOptimizedProgram;
    readonly pass18x64layout: X64LaidOutProgram;
    readonly pass19x64round2branchopt: X64Round2BranchOptimizedProgram;
    readonly pass20x64round2layout: X64Round2LaidOutProgram;
    readonly pass21x64round2peephole: X64Round2PeepholeProgram;
    readonly pass22x64emit: X64TextualAssemblyProgram;
}