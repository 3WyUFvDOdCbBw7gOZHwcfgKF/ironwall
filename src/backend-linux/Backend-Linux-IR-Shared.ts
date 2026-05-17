import type { AstNode } from "../AstNode";
import type {
    BackendExternFunctionIR,
    ClosureFunctionOrigin,
    ClosureHelperDefinition,
    LinearOperand,
    LinearStatement,
    LoweredBinding,
    LoweringGlobalDefinition,
    LoweringLayoutTable,
    LoweringMetadata,
    LoweringSnapshotDeclaredFunction
} from "../Lowering-Frontend-Shared";

export type X64MirRegisterBank = "gpr" | "xmm";

export interface X64MirVirtualRegisterOperand {
    readonly kind: "vreg";
    readonly name: string;
    readonly bank: X64MirRegisterBank;
}

export interface X64MirImmediateI64Operand {
    readonly kind: "imm_i64";
    readonly value: number;
}

export interface X64MirSymbolOperand {
    readonly kind: "symbol";
    readonly symbol: string;
}

export interface X64MirTextOperand {
    readonly kind: "text";
    readonly typeName: string;
    readonly referenceName: string;
    readonly content: string;
}

export type X64MirOperand =
    | X64MirVirtualRegisterOperand
    | X64MirImmediateI64Operand
    | X64MirSymbolOperand
    | X64MirTextOperand;

export type X64MirCopyTargetOperand = X64MirVirtualRegisterOperand | X64MirSymbolOperand;

export interface X64MirMoveInstruction {
    readonly kind: "move";
    readonly target: X64MirCopyTargetOperand;
    readonly source: X64MirOperand;
    readonly gcRoots: readonly string[];
}

export interface X64MirCallDirectInstruction {
    readonly kind: "call_direct";
    readonly target?: X64MirVirtualRegisterOperand;
    readonly symbol: string;
    readonly args: readonly X64MirOperand[];
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirCallClosureInstruction {
    readonly kind: "call_closure";
    readonly target?: X64MirVirtualRegisterOperand;
    readonly callee: X64MirOperand;
    readonly args: readonly X64MirOperand[];
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirObjectAllocInstruction {
    readonly kind: "object_alloc";
    readonly target: X64MirVirtualRegisterOperand;
    readonly className: string;
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirObjectGetFieldInstruction {
    readonly kind: "object_get_field";
    readonly target: X64MirVirtualRegisterOperand;
    readonly receiver: X64MirOperand;
    readonly className: string;
    readonly fieldName: string;
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirObjectSetFieldInstruction {
    readonly kind: "object_set_field";
    readonly receiver: X64MirOperand;
    readonly className: string;
    readonly fieldName: string;
    readonly value: X64MirOperand;
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirSlotLoadInstruction {
    readonly kind: "slot_load";
    readonly target: X64MirVirtualRegisterOperand;
    readonly receiver: X64MirOperand;
    readonly className: string;
    readonly slotName: string;
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirSlotStoreInstruction {
    readonly kind: "slot_store";
    readonly receiver: X64MirOperand;
    readonly className: string;
    readonly slotName: string;
    readonly value: X64MirOperand;
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirUnionInjectInstruction {
    readonly kind: "union_inject";
    readonly target: X64MirVirtualRegisterOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly value: X64MirOperand;
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirUnionHasTagInstruction {
    readonly kind: "union_has_tag";
    readonly target: X64MirVirtualRegisterOperand;
    readonly unionValue: X64MirOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirUnionGetPayloadInstruction {
    readonly kind: "union_get_payload";
    readonly target: X64MirVirtualRegisterOperand;
    readonly unionValue: X64MirOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export interface X64MirClosureCreateInstruction {
    readonly kind: "closure_create";
    readonly target: X64MirVirtualRegisterOperand;
    readonly closureId: string;
    readonly applySymbol: string;
    readonly environmentLayout: string;
    readonly captures: readonly X64MirOperand[];
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64MirOperand[];
}

export type X64MirInstruction =
    | X64MirMoveInstruction
    | X64MirCallDirectInstruction
    | X64MirCallClosureInstruction
    | X64MirObjectAllocInstruction
    | X64MirObjectGetFieldInstruction
    | X64MirObjectSetFieldInstruction
    | X64MirSlotLoadInstruction
    | X64MirSlotStoreInstruction
    | X64MirUnionInjectInstruction
    | X64MirUnionHasTagInstruction
    | X64MirUnionGetPayloadInstruction
    | X64MirClosureCreateInstruction;

export interface X64MirJumpTerminator {
    readonly kind: "jump";
    readonly target: string;
    readonly args: readonly X64MirOperand[];
}

export interface X64MirBranchTerminator {
    readonly kind: "branch";
    readonly cond: X64MirOperand;
    readonly trueTarget: string;
    readonly trueArgs: readonly X64MirOperand[];
    readonly falseTarget: string;
    readonly falseArgs: readonly X64MirOperand[];
}

export interface X64MirReturnTerminator {
    readonly kind: "return";
    readonly value: X64MirOperand;
}

export type X64MirTerminator = X64MirJumpTerminator | X64MirBranchTerminator | X64MirReturnTerminator;

export interface X64MirBlock {
    readonly label: string;
    readonly predecessors: readonly string[];
    readonly params: readonly X64MirVirtualRegisterOperand[];
    readonly instructions: readonly X64MirInstruction[];
    readonly terminator: X64MirTerminator;
}

export interface X64MirBody {
    readonly entryLabel: string;
    readonly gcRootNames: readonly string[];
    readonly blocks: readonly X64MirBlock[];
}

export interface X64MirFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64MirBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64MirProgram {
    readonly kind: "x64_mir_program";
    readonly entry: X64MirBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64MirFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export type X64PhysicalRegisterName =
    | "rax"
    | "rdi"
    | "rsi"
    | "rdx"
    | "rcx"
    | "r8"
    | "r9"
    | "rbx"
    | "r10"
    | "r11"
    | "r12"
    | "r13"
    | "r14"
    | "r15"
    | "xmm0"
    | "xmm1"
    | "xmm2"
    | "xmm3"
    | "xmm4"
    | "xmm5"
    | "xmm6"
    | "xmm7"
    | "xmm8"
    | "xmm9"
    | "xmm10"
    | "xmm11"
    | "xmm12"
    | "xmm13"
    | "xmm14"
    | "xmm15";

export interface X64SelectedPhysicalRegisterOperand {
    readonly kind: "preg";
    readonly name: X64PhysicalRegisterName;
    readonly bank: X64MirRegisterBank;
}

export interface X64SelectedStackArgOperand {
    readonly kind: "stack_arg";
    readonly index: number;
    readonly bank: X64MirRegisterBank;
}

export interface X64SelectedIncomingStackArgOperand {
    readonly kind: "incoming_stack_arg";
    readonly index: number;
    readonly bank: X64MirRegisterBank;
}

export type X64SelectedOperand =
    | X64MirVirtualRegisterOperand
    | X64SelectedPhysicalRegisterOperand
    | X64SelectedStackArgOperand
    | X64SelectedIncomingStackArgOperand
    | X64MirImmediateI64Operand
    | X64MirSymbolOperand
    | X64MirTextOperand;

export interface X64SelectedCopyInstruction {
    readonly kind: "copy";
    readonly target: X64SelectedOperand;
    readonly source: X64SelectedOperand;
}

export type X64CallConvention = "internal" | "sysv_c_ffi";

export interface X64SelectedCallDirectInstruction {
    readonly kind: "call_direct";
    readonly symbol: string;
    readonly gcRoots: readonly string[];
    readonly callingConvention: X64CallConvention;
    readonly stackArgs: readonly X64SelectedOperand[];
}

export interface X64SelectedCallIndirectInstruction {
    readonly kind: "call_indirect";
    readonly callee: X64SelectedOperand;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedGcFrameBeginInstruction {
    readonly kind: "gc_frame_begin";
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64SelectedOperand[];
}

export interface X64SelectedGcFrameEndInstruction {
    readonly kind: "gc_frame_end";
    readonly gcRoots: readonly string[];
}

export interface X64SelectedTestInstruction {
    readonly kind: "test";
    readonly left: X64SelectedOperand;
    readonly right: X64SelectedOperand;
}

export interface X64SelectedPseudoObjectAllocInstruction {
    readonly kind: "pseudo_object_alloc";
    readonly target: X64MirVirtualRegisterOperand;
    readonly className: string;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedPseudoObjectGetFieldInstruction {
    readonly kind: "pseudo_object_get_field";
    readonly target: X64MirVirtualRegisterOperand;
    readonly receiver: X64SelectedOperand;
    readonly className: string;
    readonly fieldName: string;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedPseudoObjectSetFieldInstruction {
    readonly kind: "pseudo_object_set_field";
    readonly receiver: X64SelectedOperand;
    readonly className: string;
    readonly fieldName: string;
    readonly value: X64SelectedOperand;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedPseudoSlotLoadInstruction {
    readonly kind: "pseudo_slot_load";
    readonly target: X64MirVirtualRegisterOperand;
    readonly receiver: X64SelectedOperand;
    readonly className: string;
    readonly slotName: string;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedPseudoSlotStoreInstruction {
    readonly kind: "pseudo_slot_store";
    readonly receiver: X64SelectedOperand;
    readonly className: string;
    readonly slotName: string;
    readonly value: X64SelectedOperand;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedPseudoUnionInjectInstruction {
    readonly kind: "pseudo_union_inject";
    readonly target: X64MirVirtualRegisterOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly value: X64SelectedOperand;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedPseudoUnionHasTagInstruction {
    readonly kind: "pseudo_union_has_tag";
    readonly target: X64MirVirtualRegisterOperand;
    readonly unionValue: X64SelectedOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedPseudoUnionGetPayloadInstruction {
    readonly kind: "pseudo_union_get_payload";
    readonly target: X64MirVirtualRegisterOperand;
    readonly unionValue: X64SelectedOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly gcRoots: readonly string[];
}

export interface X64SelectedPseudoClosureCreateInstruction {
    readonly kind: "pseudo_closure_create";
    readonly target: X64MirVirtualRegisterOperand;
    readonly closureId: string;
    readonly applySymbol: string;
    readonly environmentLayout: string;
    readonly captures: readonly X64SelectedOperand[];
    readonly gcRoots: readonly string[];
}

export type X64SelectedInstruction =
    | X64SelectedCopyInstruction
    | X64SelectedCallDirectInstruction
    | X64SelectedCallIndirectInstruction
    | X64SelectedGcFrameBeginInstruction
    | X64SelectedGcFrameEndInstruction
    | X64SelectedTestInstruction
    | X64SelectedPseudoObjectAllocInstruction
    | X64SelectedPseudoObjectGetFieldInstruction
    | X64SelectedPseudoObjectSetFieldInstruction
    | X64SelectedPseudoSlotLoadInstruction
    | X64SelectedPseudoSlotStoreInstruction
    | X64SelectedPseudoUnionInjectInstruction
    | X64SelectedPseudoUnionHasTagInstruction
    | X64SelectedPseudoUnionGetPayloadInstruction
    | X64SelectedPseudoClosureCreateInstruction;

export interface X64SelectedJumpTerminator {
    readonly kind: "jmp";
    readonly target: string;
    readonly args: readonly X64SelectedOperand[];
}

export interface X64SelectedConditionalJumpTerminator {
    readonly kind: "jcc";
    readonly condition: "nz";
    readonly trueTarget: string;
    readonly trueArgs: readonly X64SelectedOperand[];
    readonly falseTarget: string;
    readonly falseArgs: readonly X64SelectedOperand[];
}

export interface X64SelectedReturnTerminator {
    readonly kind: "ret";
}

export type X64SelectedTerminator =
    | X64SelectedJumpTerminator
    | X64SelectedConditionalJumpTerminator
    | X64SelectedReturnTerminator;

export interface X64SelectedBlock {
    readonly label: string;
    readonly predecessors: readonly string[];
    readonly params: readonly X64MirVirtualRegisterOperand[];
    readonly instructions: readonly X64SelectedInstruction[];
    readonly terminator: X64SelectedTerminator;
}

export interface X64SelectedBody {
    readonly entryLabel: string;
    readonly gcRootNames: readonly string[];
    readonly blocks: readonly X64SelectedBlock[];
}

export interface X64SelectedFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64SelectedBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64SelectedProgram {
    readonly kind: "x64_selected_program";
    readonly entry: X64SelectedBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64SelectedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64CopyPropagatedProgram {
    readonly kind: "x64_copy_propagated_program";
    readonly entry: X64SelectedBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64SelectedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64LivenessInterval {
    readonly name: string;
    readonly bank: X64MirRegisterBank;
    readonly start: number;
    readonly end: number;
    readonly crossesCall: boolean;
    readonly mustSpill: boolean;
}

export interface X64LivenessBlockSummary {
    readonly label: string;
    readonly liveIn: readonly string[];
    readonly liveOut: readonly string[];
}

export interface X64LivenessBody {
    readonly entryLabel: string;
    readonly gcRootNames: readonly string[];
    readonly blocks: readonly X64SelectedBlock[];
    readonly blockSummaries: readonly X64LivenessBlockSummary[];
    readonly callPositions: readonly number[];
    readonly intervals: readonly X64LivenessInterval[];
}

export interface X64LivenessFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64LivenessBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64LivenessProgram {
    readonly kind: "x64_liveness_program";
    readonly entry: X64LivenessBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64LivenessFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64InterferenceGraphNode {
    readonly name: string;
    readonly bank: X64MirRegisterBank;
    readonly mustSpill: boolean;
    readonly neighbors: readonly string[];
}

export interface X64InterferenceBody {
    readonly entryLabel: string;
    readonly gcRootNames: readonly string[];
    readonly blocks: readonly X64SelectedBlock[];
    readonly blockSummaries: readonly X64LivenessBlockSummary[];
    readonly callPositions: readonly number[];
    readonly intervals: readonly X64LivenessInterval[];
    readonly graphNodes: readonly X64InterferenceGraphNode[];
}

export interface X64InterferenceFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64InterferenceBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64InterferenceProgram {
    readonly kind: "x64_interference_program";
    readonly entry: X64InterferenceBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64InterferenceFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64RegAllocatedStackSlotOperand {
    readonly kind: "stack_slot";
    readonly index: number;
    readonly bank: X64MirRegisterBank;
}

export type X64RegAllocatedOperand =
    | X64SelectedPhysicalRegisterOperand
    | X64RegAllocatedStackSlotOperand
    | X64SelectedStackArgOperand
    | X64SelectedIncomingStackArgOperand
    | X64MirImmediateI64Operand
    | X64MirSymbolOperand
    | X64MirTextOperand;

export interface X64AllocationEntry {
    readonly name: string;
    readonly operand: X64RegAllocatedOperand;
}

export interface X64AllocationBody {
    readonly entryLabel: string;
    readonly gcRootNames: readonly string[];
    readonly blocks: readonly X64SelectedBlock[];
    readonly assignments: readonly X64AllocationEntry[];
    readonly spillSlotCount: number;
}

export interface X64AllocationFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64AllocationBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64AllocationProgram {
    readonly kind: "x64_allocation_program";
    readonly entry: X64AllocationBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64AllocationFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64RegAllocatedCopyInstruction {
    readonly kind: "copy";
    readonly target: X64RegAllocatedOperand;
    readonly source: X64RegAllocatedOperand;
}

export interface X64RegAllocatedCallDirectInstruction {
    readonly kind: "call_direct";
    readonly symbol: string;
    readonly gcRoots: readonly string[];
    readonly callingConvention: X64CallConvention;
    readonly stackArgs: readonly X64RegAllocatedOperand[];
}

export interface X64RegAllocatedCallIndirectInstruction {
    readonly kind: "call_indirect";
    readonly callee: X64RegAllocatedOperand;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedGcFrameBeginInstruction {
    readonly kind: "gc_frame_begin";
    readonly gcRoots: readonly string[];
    readonly gcRootOperands: readonly X64RegAllocatedOperand[];
}

export interface X64RegAllocatedGcFrameEndInstruction {
    readonly kind: "gc_frame_end";
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedTestInstruction {
    readonly kind: "test";
    readonly left: X64RegAllocatedOperand;
    readonly right: X64RegAllocatedOperand;
}

export interface X64RegAllocatedPseudoObjectAllocInstruction {
    readonly kind: "pseudo_object_alloc";
    readonly target: X64RegAllocatedOperand;
    readonly className: string;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedPseudoObjectGetFieldInstruction {
    readonly kind: "pseudo_object_get_field";
    readonly target: X64RegAllocatedOperand;
    readonly receiver: X64RegAllocatedOperand;
    readonly className: string;
    readonly fieldName: string;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedPseudoObjectSetFieldInstruction {
    readonly kind: "pseudo_object_set_field";
    readonly receiver: X64RegAllocatedOperand;
    readonly className: string;
    readonly fieldName: string;
    readonly value: X64RegAllocatedOperand;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedPseudoSlotLoadInstruction {
    readonly kind: "pseudo_slot_load";
    readonly target: X64RegAllocatedOperand;
    readonly receiver: X64RegAllocatedOperand;
    readonly className: string;
    readonly slotName: string;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedPseudoSlotStoreInstruction {
    readonly kind: "pseudo_slot_store";
    readonly receiver: X64RegAllocatedOperand;
    readonly className: string;
    readonly slotName: string;
    readonly value: X64RegAllocatedOperand;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedPseudoUnionInjectInstruction {
    readonly kind: "pseudo_union_inject";
    readonly target: X64RegAllocatedOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly value: X64RegAllocatedOperand;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedPseudoUnionHasTagInstruction {
    readonly kind: "pseudo_union_has_tag";
    readonly target: X64RegAllocatedOperand;
    readonly unionValue: X64RegAllocatedOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedPseudoUnionGetPayloadInstruction {
    readonly kind: "pseudo_union_get_payload";
    readonly target: X64RegAllocatedOperand;
    readonly unionValue: X64RegAllocatedOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly gcRoots: readonly string[];
}

export interface X64RegAllocatedPseudoClosureCreateInstruction {
    readonly kind: "pseudo_closure_create";
    readonly target: X64RegAllocatedOperand;
    readonly closureId: string;
    readonly applySymbol: string;
    readonly environmentLayout: string;
    readonly captures: readonly X64RegAllocatedOperand[];
    readonly gcRoots: readonly string[];
}

export type X64RegAllocatedInstruction =
    | X64RegAllocatedCopyInstruction
    | X64RegAllocatedCallDirectInstruction
    | X64RegAllocatedCallIndirectInstruction
    | X64RegAllocatedGcFrameBeginInstruction
    | X64RegAllocatedGcFrameEndInstruction
    | X64RegAllocatedTestInstruction
    | X64RegAllocatedPseudoObjectAllocInstruction
    | X64RegAllocatedPseudoObjectGetFieldInstruction
    | X64RegAllocatedPseudoObjectSetFieldInstruction
    | X64RegAllocatedPseudoSlotLoadInstruction
    | X64RegAllocatedPseudoSlotStoreInstruction
    | X64RegAllocatedPseudoUnionInjectInstruction
    | X64RegAllocatedPseudoUnionHasTagInstruction
    | X64RegAllocatedPseudoUnionGetPayloadInstruction
    | X64RegAllocatedPseudoClosureCreateInstruction;

export interface X64RegAllocatedJumpTerminator {
    readonly kind: "jmp";
    readonly target: string;
    readonly args: readonly X64RegAllocatedOperand[];
}

export interface X64RegAllocatedConditionalJumpTerminator {
    readonly kind: "jcc";
    readonly condition: "nz";
    readonly trueTarget: string;
    readonly trueArgs: readonly X64RegAllocatedOperand[];
    readonly falseTarget: string;
    readonly falseArgs: readonly X64RegAllocatedOperand[];
}

export interface X64RegAllocatedReturnTerminator {
    readonly kind: "ret";
}

export type X64RegAllocatedTerminator =
    | X64RegAllocatedJumpTerminator
    | X64RegAllocatedConditionalJumpTerminator
    | X64RegAllocatedReturnTerminator;

export interface X64RegAllocatedBlock {
    readonly label: string;
    readonly predecessors: readonly string[];
    readonly params: readonly X64RegAllocatedOperand[];
    readonly instructions: readonly X64RegAllocatedInstruction[];
    readonly terminator: X64RegAllocatedTerminator;
}

export interface X64RegAllocatedBody {
    readonly entryLabel: string;
    readonly gcRootNames: readonly string[];
    readonly spillSlotCount: number;
    readonly blocks: readonly X64RegAllocatedBlock[];
}

export interface X64RegAllocatedFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64RegAllocatedBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64RegAllocatedProgram {
    readonly kind: "x64_reg_allocated_program";
    readonly entry: X64RegAllocatedBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64RegAllocatedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64FrameSlotLayout {
    readonly kind: "spill" | "outgoing_arg";
    readonly index: number;
    readonly bank: X64MirRegisterBank;
    readonly offsetFromRbp: number;
    readonly size: number;
}

export interface X64FrameLayoutBody {
    readonly entryLabel: string;
    readonly gcRootNames: readonly string[];
    readonly spillSlotCount: number;
    readonly outgoingStackArgCount: number;
    readonly calleeSavedRegisters: readonly X64PhysicalRegisterName[];
    readonly frameSizeBytes: number;
    readonly stackAlignmentBytes: number;
    readonly gcShadowFrameSizeBytes: number;
    readonly gcShadowFrameOffsetFromRbp: number;
    readonly slots: readonly X64FrameSlotLayout[];
    readonly blocks: readonly X64RegAllocatedBlock[];
}

export interface X64FrameLayoutFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64FrameLayoutBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64FrameLayoutProgram {
    readonly kind: "x64_frame_layout_program";
    readonly entry: X64FrameLayoutBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64FrameLayoutFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64TextualAssemblyFunctionDefinition {
    readonly symbol: string;
    readonly text: string;
}

export interface X64TextualAssemblyProgram {
    readonly kind: "x64_textual_assembly_program";
    readonly entrySymbol: string;
    readonly entryText: string;
    readonly functions: readonly X64TextualAssemblyFunctionDefinition[];
    readonly text: string;
}

export interface X64PostRAPeepholeFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64FrameLayoutBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64PostRAPeepholeProgram {
    readonly kind: "x64_post_ra_peephole_program";
    readonly entry: X64FrameLayoutBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64PostRAPeepholeFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64BranchOptimizedFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64FrameLayoutBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64BranchOptimizedProgram {
    readonly kind: "x64_branch_optimized_program";
    readonly entry: X64FrameLayoutBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64BranchOptimizedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64LaidOutFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64FrameLayoutBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64LaidOutProgram {
    readonly kind: "x64_laid_out_program";
    readonly entry: X64FrameLayoutBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64LaidOutFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64Round2BranchOptimizedFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64FrameLayoutBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64Round2BranchOptimizedProgram {
    readonly kind: "x64_round_2_branch_optimized_program";
    readonly entry: X64FrameLayoutBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64Round2BranchOptimizedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64Round2LaidOutFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64FrameLayoutBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64Round2LaidOutProgram {
    readonly kind: "x64_round_2_laid_out_program";
    readonly entry: X64FrameLayoutBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64Round2LaidOutFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface X64Round2PeepholeFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: X64FrameLayoutBody;
    readonly origin: ClosureFunctionOrigin;
}

export interface X64Round2PeepholeProgram {
    readonly kind: "x64_round_2_peephole_program";
    readonly entry: X64FrameLayoutBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly X64Round2PeepholeFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export type BackendValueRepresentation = "immediate" | "reference";

export interface RepresentationSelectionBody {
    readonly bindingRepresentations: ReadonlyMap<string, BackendValueRepresentation>;
    readonly resultRepresentation: BackendValueRepresentation;
}

export interface RepresentationSelectionFunction {
    readonly symbol: string;
    readonly body: RepresentationSelectionBody;
}

export interface RepresentationSelectionProgram {
    readonly kind: "representation_selection_program";
    readonly entry: RepresentationSelectionBody;
    readonly functions: readonly RepresentationSelectionFunction[];
}

export interface MayCollectAssignStatement {
    readonly kind: "assign";
    readonly mayCollect: boolean;
}

export interface MayCollectSetLocalStatement {
    readonly kind: "set_local";
    readonly mayCollect: boolean;
}

export interface MayCollectObjectSetFieldStatement {
    readonly kind: "object_set_field";
    readonly mayCollect: boolean;
}

export interface MayCollectSlotStoreStatement {
    readonly kind: "slot_store";
    readonly mayCollect: boolean;
}

export interface MayCollectIfStatement {
    readonly kind: "if";
    readonly mayCollect: boolean;
    readonly thenStatements: readonly MayCollectStatement[];
    readonly elseStatements: readonly MayCollectStatement[];
}

export interface MayCollectWhileStatement {
    readonly kind: "while";
    readonly mayCollect: boolean;
    readonly condStatements: readonly MayCollectStatement[];
    readonly bodyStatements: readonly MayCollectStatement[];
}

export type MayCollectStatement =
    | MayCollectAssignStatement
    | MayCollectSetLocalStatement
    | MayCollectObjectSetFieldStatement
    | MayCollectSlotStoreStatement
    | MayCollectIfStatement
    | MayCollectWhileStatement;

export interface MayCollectBody {
    readonly mayCollect: boolean;
    readonly statementAnnotations: readonly MayCollectStatement[];
}

export interface MayCollectFunction {
    readonly symbol: string;
    readonly body: MayCollectBody;
}

export interface MayCollectProgram {
    readonly kind: "may_collect_program";
    readonly entry: MayCollectBody;
    readonly functions: readonly MayCollectFunction[];
}

export interface TrimmedRootCandidateAssignStatement {
    readonly kind: "assign";
    readonly gcRoots: readonly string[];
}

export interface TrimmedRootCandidateSetLocalStatement {
    readonly kind: "set_local";
    readonly gcRoots: readonly string[];
}

export interface TrimmedRootCandidateObjectSetFieldStatement {
    readonly kind: "object_set_field";
    readonly gcRoots: readonly string[];
}

export interface TrimmedRootCandidateSlotStoreStatement {
    readonly kind: "slot_store";
    readonly gcRoots: readonly string[];
}

export interface TrimmedRootCandidateIfStatement {
    readonly kind: "if";
    readonly gcRoots: readonly string[];
    readonly thenStatements: readonly TrimmedRootCandidateStatement[];
    readonly elseStatements: readonly TrimmedRootCandidateStatement[];
}

export interface TrimmedRootCandidateWhileStatement {
    readonly kind: "while";
    readonly gcRoots: readonly string[];
    readonly condStatements: readonly TrimmedRootCandidateStatement[];
    readonly bodyStatements: readonly TrimmedRootCandidateStatement[];
}

export type TrimmedRootCandidateStatement =
    | TrimmedRootCandidateAssignStatement
    | TrimmedRootCandidateSetLocalStatement
    | TrimmedRootCandidateObjectSetFieldStatement
    | TrimmedRootCandidateSlotStoreStatement
    | TrimmedRootCandidateIfStatement
    | TrimmedRootCandidateWhileStatement;

export interface TrimmedRootCandidateBody {
    readonly gcRootNames: readonly string[];
    readonly statementRoots: readonly TrimmedRootCandidateStatement[];
    readonly resultGcRoots: readonly string[];
}

export interface TrimmedRootCandidateFunction {
    readonly symbol: string;
    readonly body: TrimmedRootCandidateBody;
}

export interface TrimmedRootCandidateProgram {
    readonly kind: "trimmed_root_candidate_program";
    readonly entry: TrimmedRootCandidateBody;
    readonly functions: readonly TrimmedRootCandidateFunction[];
}

export interface CfgTrimmedRootCandidateStatement {
    readonly kind: "assign" | "set_local" | "object_set_field" | "slot_store";
    readonly gcRoots: readonly string[];
    readonly mayCollect: boolean;
}

export interface CfgTrimmedRootCandidateBlock {
    readonly label: string;
    readonly predecessors: readonly string[];
    readonly liveIn: readonly string[];
    readonly liveOut: readonly string[];
    readonly terminatorRoots: readonly string[];
    readonly statementRoots: readonly CfgTrimmedRootCandidateStatement[];
}

export interface CfgTrimmedRootCandidateBody {
    readonly gcRootNames: readonly string[];
    readonly returnRoots: readonly string[];
    readonly blocks: readonly CfgTrimmedRootCandidateBlock[];
}

export interface CfgTrimmedRootCandidateFunction {
    readonly symbol: string;
    readonly body: CfgTrimmedRootCandidateBody;
}

export interface CfgTrimmedRootCandidateProgram {
    readonly kind: "cfg_trimmed_root_candidate_program";
    readonly entry: CfgTrimmedRootCandidateBody;
    readonly functions: readonly CfgTrimmedRootCandidateFunction[];
}

export interface GcRootPlanFunction {
    readonly symbol: string;
    readonly body: GcRootPlanBody;
}

export interface GcRootPlanAssignStatement {
    readonly kind: "assign";
    readonly gcRoots: readonly string[];
}

export interface GcRootPlanSetLocalStatement {
    readonly kind: "set_local";
    readonly gcRoots: readonly string[];
}

export interface GcRootPlanObjectSetFieldStatement {
    readonly kind: "object_set_field";
    readonly gcRoots: readonly string[];
}

export interface GcRootPlanSlotStoreStatement {
    readonly kind: "slot_store";
    readonly gcRoots: readonly string[];
}

export interface GcRootPlanIfStatement {
    readonly kind: "if";
    readonly gcRoots: readonly string[];
    readonly thenStatements: readonly GcRootPlanStatement[];
    readonly elseStatements: readonly GcRootPlanStatement[];
}

export interface GcRootPlanWhileStatement {
    readonly kind: "while";
    readonly gcRoots: readonly string[];
    readonly condStatements: readonly GcRootPlanStatement[];
    readonly bodyStatements: readonly GcRootPlanStatement[];
}

export type GcRootPlanStatement =
    | GcRootPlanAssignStatement
    | GcRootPlanSetLocalStatement
    | GcRootPlanObjectSetFieldStatement
    | GcRootPlanSlotStoreStatement
    | GcRootPlanIfStatement
    | GcRootPlanWhileStatement;

export interface GcRootPlanBody {
    readonly gcRootNames: readonly string[];
    readonly statementPlans: readonly GcRootPlanStatement[];
    readonly resultGcRoots: readonly string[];
}

export interface GcRootPlan {
    readonly kind: "gc_root_plan";
    readonly entry: GcRootPlanBody;
    readonly functions: readonly GcRootPlanFunction[];
}

export interface BackendFunctionIR {
    readonly symbol: string;
    readonly params: readonly string[];
    readonly locals: readonly string[];
    readonly bindingRepresentations: ReadonlyMap<string, BackendValueRepresentation>;
    readonly immediateNames: readonly string[];
    readonly resultRepresentation: BackendValueRepresentation;
    readonly gcRootNames: readonly string[];
    readonly gcPlan: GcRootPlanBody;
    readonly statements: readonly LinearStatement[];
    readonly result: LinearOperand;
    readonly origin: ClosureFunctionOrigin;
    readonly unitId?: string | null;
}

export interface FinalBackendIRProgram {
    readonly kind: "final_backend_ir_program";
    readonly entry: BackendFunctionIR;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly BackendFunctionIR[];
    readonly externFunctions: readonly BackendExternFunctionIR[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}
