import type {
    X64FrameLayoutBody,
    X64FrameLayoutFunctionDefinition,
    X64FrameLayoutProgram,
    X64FrameSlotLayout,
    X64PhysicalRegisterName,
    X64RegAllocatedBody,
    X64RegAllocatedFunctionDefinition,
    X64RegAllocatedOperand,
    X64RegAllocatedProgram
} from "./Backend-Windows-IR-Shared";

const CALLEE_SAVED_ORDER: readonly X64PhysicalRegisterName[] = ["rbx", "r12", "r13", "r14", "r15"];
const SLOT_SIZE_BYTES = 8;
const STACK_ALIGNMENT_BYTES = 16;
const GC_SHADOW_FRAME_FIXED_SLOT_COUNT = 5;

function collectOperandsFromOperand(operand: X64RegAllocatedOperand, into: X64RegAllocatedOperand[]): void {
    into.push(operand);
}

function collectOperands(body: X64RegAllocatedBody): readonly X64RegAllocatedOperand[] {
    const operands: X64RegAllocatedOperand[] = [];
    for (const block of body.blocks) {
        block.params.forEach((param) => collectOperandsFromOperand(param, operands));
        for (const instruction of block.instructions) {
            switch (instruction.kind) {
                case "copy":
                    collectOperandsFromOperand(instruction.target, operands);
                    collectOperandsFromOperand(instruction.source, operands);
                    break;
                case "call_direct":
                    instruction.stackArgs.forEach((operand) => collectOperandsFromOperand(operand, operands));
                    break;
                case "call_indirect":
                    collectOperandsFromOperand(instruction.callee, operands);
                    break;
                case "gc_frame_begin":
                    instruction.gcRootOperands.forEach((operand) => collectOperandsFromOperand(operand, operands));
                    break;
                case "gc_frame_end":
                    break;
                case "test":
                    collectOperandsFromOperand(instruction.left, operands);
                    collectOperandsFromOperand(instruction.right, operands);
                    break;
                case "pseudo_object_alloc":
                    collectOperandsFromOperand(instruction.target, operands);
                    break;
                case "pseudo_object_get_field":
                    collectOperandsFromOperand(instruction.target, operands);
                    collectOperandsFromOperand(instruction.receiver, operands);
                    break;
                case "pseudo_object_set_field":
                    collectOperandsFromOperand(instruction.receiver, operands);
                    collectOperandsFromOperand(instruction.value, operands);
                    break;
                case "pseudo_slot_load":
                    collectOperandsFromOperand(instruction.target, operands);
                    collectOperandsFromOperand(instruction.receiver, operands);
                    break;
                case "pseudo_slot_store":
                    collectOperandsFromOperand(instruction.receiver, operands);
                    collectOperandsFromOperand(instruction.value, operands);
                    break;
                case "pseudo_union_inject":
                    collectOperandsFromOperand(instruction.target, operands);
                    collectOperandsFromOperand(instruction.value, operands);
                    break;
                case "pseudo_union_has_tag":
                case "pseudo_union_get_payload":
                    collectOperandsFromOperand(instruction.target, operands);
                    collectOperandsFromOperand(instruction.unionValue, operands);
                    break;
                case "pseudo_closure_create":
                    collectOperandsFromOperand(instruction.target, operands);
                    instruction.captures.forEach((capture) => collectOperandsFromOperand(capture, operands));
                    break;
            }
        }
        switch (block.terminator.kind) {
            case "ret":
                break;
            case "jmp":
                block.terminator.args.forEach((arg) => collectOperandsFromOperand(arg, operands));
                break;
            case "jcc":
                block.terminator.trueArgs.forEach((arg) => collectOperandsFromOperand(arg, operands));
                block.terminator.falseArgs.forEach((arg) => collectOperandsFromOperand(arg, operands));
                break;
        }
    }
    return operands;
}

function alignUp(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function gcShadowFrameSizeBytesForRootCount(rootCount: number): number {
    return (GC_SHADOW_FRAME_FIXED_SLOT_COUNT + rootCount) * SLOT_SIZE_BYTES;
}

function layoutBody(body: X64RegAllocatedBody): X64FrameLayoutBody {
    const operands = collectOperands(body);
    const spillSlots = new Map<string, X64FrameSlotLayout>();
    const outgoingSlots = new Map<number, X64FrameSlotLayout>();
    const calleeSaved = new Set<X64PhysicalRegisterName>();
    const maxGcShadowRootCount = Math.max(
        0,
        ...body.blocks.flatMap((block) => block.instructions
            .filter((instruction): instruction is Extract<typeof block.instructions[number], { kind: "gc_frame_begin" }> => instruction.kind === "gc_frame_begin")
            .map((instruction) => instruction.gcRoots.length))
    );
    const gcShadowFrameSizeBytes = maxGcShadowRootCount > 0 || body.blocks.some((block) => block.instructions.some((instruction) => instruction.kind === "gc_frame_begin"))
        ? gcShadowFrameSizeBytesForRootCount(maxGcShadowRootCount)
        : 0;

    for (const operand of operands) {
        if (operand.kind === "stack_slot") {
            const key = `${operand.bank}:${operand.index}`;
            if (!spillSlots.has(key)) {
                spillSlots.set(key, {
                    kind: "spill",
                    index: operand.index,
                    bank: operand.bank,
                    offsetFromRbp: 0,
                    size: SLOT_SIZE_BYTES
                });
            }
            continue;
        }
        if (operand.kind === "stack_arg") {
            if (!outgoingSlots.has(operand.index)) {
                outgoingSlots.set(operand.index, {
                    kind: "outgoing_arg",
                    index: operand.index,
                    bank: operand.bank,
                    offsetFromRbp: 0,
                    size: SLOT_SIZE_BYTES
                });
            }
            continue;
        }
        if (operand.kind === "incoming_stack_arg") {
            continue;
        }
        if (operand.kind === "preg" && CALLEE_SAVED_ORDER.includes(operand.name)) {
            calleeSaved.add(operand.name);
        }
    }

    const calleeSavedRegisters = CALLEE_SAVED_ORDER.filter((name) => calleeSaved.has(name));
    const localSlotCount = calleeSavedRegisters.length + spillSlots.size;
    const outgoingSlotCount = outgoingSlots.size;
    const localAreaBytes = (localSlotCount * SLOT_SIZE_BYTES) + gcShadowFrameSizeBytes;
    const outgoingAreaBytes = outgoingSlotCount * SLOT_SIZE_BYTES;
    const frameSizeBytes = alignUp(localAreaBytes + outgoingAreaBytes, STACK_ALIGNMENT_BYTES);

    const slots: X64FrameSlotLayout[] = [];
    let nextNegativeOffset = -SLOT_SIZE_BYTES;
    for (let index = 0; index < calleeSavedRegisters.length; index += 1) {
        slots.push({
            kind: "spill",
            index: slots.length,
            bank: "gpr",
            offsetFromRbp: nextNegativeOffset,
            size: SLOT_SIZE_BYTES
        });
        nextNegativeOffset -= SLOT_SIZE_BYTES;
    }
    for (const slot of [...spillSlots.values()].sort((left, right) => left.bank.localeCompare(right.bank) || left.index - right.index)) {
        slots.push({
            ...slot,
            offsetFromRbp: nextNegativeOffset
        });
        nextNegativeOffset -= SLOT_SIZE_BYTES;
    }
    const gcShadowFrameOffsetFromRbp = gcShadowFrameSizeBytes > 0
        ? nextNegativeOffset - gcShadowFrameSizeBytes + SLOT_SIZE_BYTES
        : 0;
    if (gcShadowFrameSizeBytes > 0) {
        nextNegativeOffset -= gcShadowFrameSizeBytes;
    }

    let nextOutgoingOffset = -frameSizeBytes;
    for (const slot of [...outgoingSlots.values()].sort((left, right) => left.index - right.index)) {
        slots.push({
            ...slot,
            offsetFromRbp: nextOutgoingOffset
        });
        nextOutgoingOffset += SLOT_SIZE_BYTES;
    }

    return {
        entryLabel: body.entryLabel,
        gcRootNames: body.gcRootNames,
        spillSlotCount: body.spillSlotCount,
        outgoingStackArgCount: outgoingSlots.size,
        calleeSavedRegisters,
        frameSizeBytes,
        stackAlignmentBytes: STACK_ALIGNMENT_BYTES,
        gcShadowFrameSizeBytes,
        gcShadowFrameOffsetFromRbp,
        slots,
        blocks: body.blocks
    };
}

function layoutFunction(fn: X64RegAllocatedFunctionDefinition): X64FrameLayoutFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: layoutBody(fn.body),
        origin: fn.origin
    };
}

export function frameLayoutX64Pass(program: X64RegAllocatedProgram): X64FrameLayoutProgram {
    return {
        kind: "x64_frame_layout_program",
        entry: layoutBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(layoutFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
