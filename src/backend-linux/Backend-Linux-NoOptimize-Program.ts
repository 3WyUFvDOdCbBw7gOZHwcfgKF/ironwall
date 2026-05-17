import type {
    X64FrameLayoutProgram,
    X64LaidOutProgram,
    X64MirProgram,
    X64RegAllocatedProgram,
    X64SelectedProgram,
    X64TextualAssemblyProgram
} from "./Backend-Linux-IR-Shared";

export interface NoOptimizeX64PassBundle {
    readonly pass11x64mir: X64MirProgram;
    readonly pass12x64selected: X64SelectedProgram;
    readonly pass14x64regalloc: X64RegAllocatedProgram;
    readonly pass15x64framelayout: X64FrameLayoutProgram;
    readonly pass18x64layout: X64LaidOutProgram;
    readonly pass22x64emit: X64TextualAssemblyProgram;
}