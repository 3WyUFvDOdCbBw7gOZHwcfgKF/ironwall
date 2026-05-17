// Minimal no-opt x64 backend pass 3: linear-scan register allocation.
import type {
    X64MirRegisterBank,
    X64PhysicalRegisterName,
    X64RegAllocatedBlock,
    X64RegAllocatedBody,
    X64RegAllocatedFunctionDefinition,
    X64RegAllocatedInstruction,
    X64RegAllocatedOperand,
    X64RegAllocatedProgram,
    X64RegAllocatedTerminator,
    X64SelectedBlock,
    X64SelectedBody,
    X64SelectedFunctionDefinition,
    X64SelectedInstruction,
    X64SelectedOperand,
    X64SelectedProgram
} from "./Backend-Linux-IR-Shared";

interface Interval {
    readonly name: string;
    readonly bank: X64MirRegisterBank;
    readonly start: number;
    readonly end: number;
    readonly crossesCall: boolean;
    readonly mustSpill: boolean;
}

const GPR_ALLOCATABLE: readonly X64PhysicalRegisterName[] = ["rbx", "r12", "r13", "r14", "r15"];
const XMM_ALLOCATABLE: readonly X64PhysicalRegisterName[] = ["xmm8", "xmm9", "xmm10", "xmm11", "xmm12", "xmm13", "xmm14", "xmm15"];

function noteBlockOccurrence(name: string, blockLabel: string, occurrences: Map<string, Set<string>>): void {
    const blocks = occurrences.get(name) ?? new Set<string>();
    blocks.add(blockLabel);
    occurrences.set(name, blocks);
}

function collectOperandUses(
    operand: X64SelectedOperand,
    into: Map<string, X64MirRegisterBank>,
    position: number,
    positions: Map<string, { start: number; end: number }>,
    blockLabel: string,
    blockOccurrences: Map<string, Set<string>>
): void {
    if (operand.kind !== "vreg") {
        return;
    }
    into.set(operand.name, operand.bank);
    noteBlockOccurrence(operand.name, blockLabel, blockOccurrences);
    const existing = positions.get(operand.name);
    if (!existing) {
        positions.set(operand.name, { start: position, end: position });
        return;
    }
    existing.start = Math.min(existing.start, position);
    existing.end = Math.max(existing.end, position);
}

function blockSuccessors(block: X64SelectedBlock): readonly string[] {
    switch (block.terminator.kind) {
        case "ret": {
            return [];
        }
        case "jmp": {
            return [block.terminator.target];
        }
        case "jcc": {
            return [block.terminator.falseTarget, block.terminator.trueTarget];
        }
    }
}

function orderBlocks(body: X64SelectedBody): readonly X64SelectedBlock[] {
    const blockMap = new Map(body.blocks.map((block) => [block.label, block]));
    const ordered: X64SelectedBlock[] = [];
    const visited = new Set<string>();
    const visit = (label: string): void => {
        if (visited.has(label)) {
            return;
        }
        visited.add(label);
        const block = blockMap.get(label);
        if (!block) {
            return;
        }
        ordered.push(block);
        for (const successor of blockSuccessors(block)) {
            visit(successor);
        }
    };
    visit(body.entryLabel);
    for (const block of body.blocks) {
        visit(block.label);
    }
    return ordered;
}

function flattenBody(body: X64SelectedBody): {
    readonly positions: Map<string, { start: number; end: number }>;
    readonly banks: Map<string, X64MirRegisterBank>;
    readonly callPositions: readonly number[];
    readonly blockOccurrences: ReadonlyMap<string, ReadonlySet<string>>;
} {
    const positions = new Map<string, { start: number; end: number }>();
    const banks = new Map<string, X64MirRegisterBank>();
    const callPositions: number[] = [];
    const blockOccurrences = new Map<string, Set<string>>();
    let position = 0;
    for (const block of orderBlocks(body)) {
        for (const param of block.params) {
            banks.set(param.name, param.bank);
            noteBlockOccurrence(param.name, block.label, blockOccurrences);
            const existing = positions.get(param.name);
            if (!existing) {
                positions.set(param.name, { start: position, end: position });
            }
        }
        for (const instruction of block.instructions) {
            position += 1;
            switch (instruction.kind) {
                case "copy": {
                    collectOperandUses(instruction.source, banks, position, positions, block.label, blockOccurrences);
                    if (instruction.target.kind === "vreg") {
                        banks.set(instruction.target.name, instruction.target.bank);
                        noteBlockOccurrence(instruction.target.name, block.label, blockOccurrences);
                        const existing = positions.get(instruction.target.name);
                        if (!existing) {
                            positions.set(instruction.target.name, { start: position, end: position });
                        } else {
                            existing.start = Math.min(existing.start, position);
                            existing.end = Math.max(existing.end, position);
                        }
                    }
                    break;
                }
                case "call_direct": {
                    instruction.stackArgs.forEach((operand) => collectOperandUses(operand, banks, position, positions, block.label, blockOccurrences));
                    callPositions.push(position);
                    break;
                }
                case "call_indirect": {
                    callPositions.push(position);
                    collectOperandUses(instruction.callee, banks, position, positions, block.label, blockOccurrences);
                    break;
                }
                case "gc_frame_begin": {
                    callPositions.push(position);
                    instruction.gcRootOperands.forEach((operand) => collectOperandUses(operand, banks, position, positions, block.label, blockOccurrences));
                    break;
                }
                case "gc_frame_end": {
                    break;
                }
                case "test": {
                    collectOperandUses(instruction.left, banks, position, positions, block.label, blockOccurrences);
                    collectOperandUses(instruction.right, banks, position, positions, block.label, blockOccurrences);
                    break;
                }
                case "pseudo_object_alloc":
                case "pseudo_object_get_field":
                case "pseudo_slot_load":
                case "pseudo_union_inject":
                case "pseudo_union_has_tag":
                case "pseudo_union_get_payload":
                case "pseudo_closure_create": {
                    const target = instruction.target;
                    if (target.kind === "vreg") {
                        banks.set(target.name, target.bank);
                        noteBlockOccurrence(target.name, block.label, blockOccurrences);
                        const existing = positions.get(target.name);
                        if (!existing) {
                            positions.set(target.name, { start: position, end: position });
                        } else {
                            existing.start = Math.min(existing.start, position);
                            existing.end = Math.max(existing.end, position);
                        }
                    }
                    if (instruction.kind === "pseudo_object_get_field" || instruction.kind === "pseudo_slot_load") {
                        collectOperandUses(instruction.receiver, banks, position, positions, block.label, blockOccurrences);
                    } else if (instruction.kind === "pseudo_union_inject") {
                        collectOperandUses(instruction.value, banks, position, positions, block.label, blockOccurrences);
                    } else if (instruction.kind === "pseudo_union_has_tag" || instruction.kind === "pseudo_union_get_payload") {
                        collectOperandUses(instruction.unionValue, banks, position, positions, block.label, blockOccurrences);
                    } else if (instruction.kind === "pseudo_closure_create") {
                        instruction.captures.forEach((capture) => collectOperandUses(capture, banks, position, positions, block.label, blockOccurrences));
                    }
                    break;
                }
                case "pseudo_object_set_field":
                case "pseudo_slot_store": {
                    collectOperandUses(instruction.receiver, banks, position, positions, block.label, blockOccurrences);
                    collectOperandUses(instruction.value, banks, position, positions, block.label, blockOccurrences);
                    break;
                }
            }
        }
        position += 1;
        switch (block.terminator.kind) {
            case "ret": {
                break;
            }
            case "jmp": {
                block.terminator.args.forEach((arg) => collectOperandUses(arg, banks, position, positions, block.label, blockOccurrences));
                break;
            }
            case "jcc": {
                block.terminator.trueArgs.forEach((arg) => collectOperandUses(arg, banks, position, positions, block.label, blockOccurrences));
                block.terminator.falseArgs.forEach((arg) => collectOperandUses(arg, banks, position, positions, block.label, blockOccurrences));
                break;
            }
        }
    }
    return { positions, banks, callPositions, blockOccurrences };
}

function buildIntervals(body: X64SelectedBody): readonly Interval[] {
    const { positions, banks, callPositions, blockOccurrences } = flattenBody(body);
    const blockParamNames = new Set(body.blocks.flatMap((block) => block.params.map((param) => param.name)));
    const crossBlockNames = new Set(
        [...blockOccurrences.entries()]
            .filter(([, blocks]) => blocks.size > 1)
            .map(([name]) => name)
    );
    return [...positions.entries()]
        .map(([name, range]): Interval => ({
            name,
            bank: banks.get(name) ?? "gpr",
            start: range.start,
            end: range.end,
            crossesCall: callPositions.some((position) => position > range.start && position < range.end),
            mustSpill: blockParamNames.has(name)
                || crossBlockNames.has(name)
                || callPositions.some((position) => position > range.start && position < range.end)
        }))
        .sort((left, right) => left.start - right.start || left.end - right.end);
}

function allocateIntervals(intervals: readonly Interval[]): { readonly assignments: ReadonlyMap<string, X64RegAllocatedOperand>; readonly spillSlotCount: number } {
    const assignments = new Map<string, X64RegAllocatedOperand>();
    const spillCounts = new Map<X64MirRegisterBank, number>([["gpr", 0], ["xmm", 0]]);
    const active = new Map<X64MirRegisterBank, Interval[]>();
    const pools = new Map<X64MirRegisterBank, readonly X64PhysicalRegisterName[]>([
        ["gpr", GPR_ALLOCATABLE],
        ["xmm", XMM_ALLOCATABLE]
    ]);

    for (const interval of intervals) {
        const bank = interval.bank;
        const currentActive = (active.get(bank) ?? []).filter((candidate) => candidate.end >= interval.start);
        active.set(bank, currentActive);
        const usedRegisters = new Set(
            currentActive
                .map((candidate) => assignments.get(candidate.name))
                .filter((operand): operand is Extract<X64RegAllocatedOperand, { kind: "preg" }> => operand?.kind === "preg")
                .map((operand) => operand.name)
        );
        const available = (pools.get(bank) ?? []).find((name) => !usedRegisters.has(name));
        const mustSpill = interval.mustSpill || (bank === "xmm" && interval.crossesCall);
        if (available && !mustSpill) {
            assignments.set(interval.name, { kind: "preg", name: available, bank });
            currentActive.push(interval);
            currentActive.sort((left, right) => left.end - right.end);
            active.set(bank, currentActive);
            continue;
        }
        const index = spillCounts.get(bank) ?? 0;
        spillCounts.set(bank, index + 1);
        assignments.set(interval.name, { kind: "stack_slot", index, bank });
    }

    return {
        assignments,
        spillSlotCount: (spillCounts.get("gpr") ?? 0) + (spillCounts.get("xmm") ?? 0)
    };
}

function mapOperand(operand: X64SelectedOperand, assignments: ReadonlyMap<string, X64RegAllocatedOperand>): X64RegAllocatedOperand {
    switch (operand.kind) {
        case "vreg": {
            return assignments.get(operand.name) ?? { kind: "stack_slot", index: 0, bank: operand.bank };
        }
        case "preg": {
            return { kind: "preg", name: operand.name, bank: operand.bank };
        }
        case "stack_arg": {
            return { kind: "stack_arg", index: operand.index, bank: operand.bank };
        }
        case "incoming_stack_arg": {
            return { kind: "incoming_stack_arg", index: operand.index, bank: operand.bank };
        }
        case "imm_i64": {
            return { kind: "imm_i64", value: operand.value };
        }
        case "symbol": {
            return { kind: "symbol", symbol: operand.symbol };
        }
        case "text": {
            return {
                kind: "text",
                typeName: operand.typeName,
                referenceName: operand.referenceName,
                content: operand.content
            };
        }
    }
}

function mapInstruction(instruction: X64SelectedInstruction, assignments: ReadonlyMap<string, X64RegAllocatedOperand>): X64RegAllocatedInstruction {
    switch (instruction.kind) {
        case "copy": {
            return { kind: "copy", target: mapOperand(instruction.target, assignments), source: mapOperand(instruction.source, assignments) };
        }
        case "call_direct": {
            return {
                ...instruction,
                stackArgs: instruction.stackArgs.map((operand) => mapOperand(operand, assignments))
            };
        }
        case "call_indirect": {
            return { ...instruction, callee: mapOperand(instruction.callee, assignments) };
        }
        case "gc_frame_begin": {
            return {
                ...instruction,
                gcRootOperands: instruction.gcRootOperands.map((operand) => mapOperand(operand, assignments))
            };
        }
        case "gc_frame_end": {
            return instruction;
        }
        case "test": {
            return { kind: "test", left: mapOperand(instruction.left, assignments), right: mapOperand(instruction.right, assignments) };
        }
        case "pseudo_object_alloc": {
            return { ...instruction, target: mapOperand(instruction.target, assignments) };
        }
        case "pseudo_object_get_field": {
            return { ...instruction, target: mapOperand(instruction.target, assignments), receiver: mapOperand(instruction.receiver, assignments) };
        }
        case "pseudo_object_set_field": {
            return { ...instruction, receiver: mapOperand(instruction.receiver, assignments), value: mapOperand(instruction.value, assignments) };
        }
        case "pseudo_slot_load": {
            return { ...instruction, target: mapOperand(instruction.target, assignments), receiver: mapOperand(instruction.receiver, assignments) };
        }
        case "pseudo_slot_store": {
            return { ...instruction, receiver: mapOperand(instruction.receiver, assignments), value: mapOperand(instruction.value, assignments) };
        }
        case "pseudo_union_inject": {
            return { ...instruction, target: mapOperand(instruction.target, assignments), value: mapOperand(instruction.value, assignments) };
        }
        case "pseudo_union_has_tag": {
            return { ...instruction, target: mapOperand(instruction.target, assignments), unionValue: mapOperand(instruction.unionValue, assignments) };
        }
        case "pseudo_union_get_payload": {
            return { ...instruction, target: mapOperand(instruction.target, assignments), unionValue: mapOperand(instruction.unionValue, assignments) };
        }
        case "pseudo_closure_create": {
            return { ...instruction, target: mapOperand(instruction.target, assignments), captures: instruction.captures.map((capture) => mapOperand(capture, assignments)) };
        }
    }
}

function mapTerminator(terminator: X64SelectedBlock["terminator"], assignments: ReadonlyMap<string, X64RegAllocatedOperand>): X64RegAllocatedTerminator {
    switch (terminator.kind) {
        case "ret": {
            return terminator;
        }
        case "jmp": {
            return { kind: "jmp", target: terminator.target, args: terminator.args.map((arg) => mapOperand(arg, assignments)) };
        }
        case "jcc": {
            return {
                kind: "jcc",
                condition: terminator.condition,
                trueTarget: terminator.trueTarget,
                trueArgs: terminator.trueArgs.map((arg) => mapOperand(arg, assignments)),
                falseTarget: terminator.falseTarget,
                falseArgs: terminator.falseArgs.map((arg) => mapOperand(arg, assignments))
            };
        }
    }
}

function allocateBody(body: X64SelectedBody): X64RegAllocatedBody {
    const { assignments, spillSlotCount } = allocateIntervals(buildIntervals(body));
    const blocks: X64RegAllocatedBlock[] = body.blocks.map((block) => ({
        label: block.label,
        predecessors: block.predecessors,
        params: block.params.map((param) => mapOperand(param, assignments)),
        instructions: block.instructions.map((instruction) => mapInstruction(instruction, assignments)),
        terminator: mapTerminator(block.terminator, assignments)
    }));
    return {
        entryLabel: body.entryLabel,
        gcRootNames: body.gcRootNames,
        spillSlotCount,
        blocks
    };
}

function allocateFunction(fn: X64SelectedFunctionDefinition): X64RegAllocatedFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: allocateBody(fn.body),
        origin: fn.origin
    };
}

export function linearScanRegallocX64Pass(program: X64SelectedProgram): X64RegAllocatedProgram {
    return {
        kind: "x64_reg_allocated_program",
        entry: allocateBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(allocateFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
