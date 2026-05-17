import type {
    X64FrameLayoutBody,
    X64FrameSlotLayout,
    X64MirRegisterBank,
    X64RegAllocatedInstruction,
    X64RegAllocatedOperand,
    X64RegAllocatedTerminator,
    X64TextualAssemblyFunctionDefinition,
    X64TextualAssemblyProgram
} from "./Backend-Windows-IR-Shared";
import { buildX64TextualAssembly } from "./Backend-Windows-x64-TextualAssembly";
import { x64NativeGcFrameInitSymbol, x64NativeGcFrameKey, x64NativeTextValueSymbol } from "./Backend-Windows-X64-NativeSupport";

type X64EmittableFunctionDefinition = {
    readonly symbol: string;
    readonly body: X64FrameLayoutBody;
};

type X64EmittableProgram = {
    readonly entry: X64FrameLayoutBody;
    readonly functions: readonly X64EmittableFunctionDefinition[];
};

const GPR_SCRATCH = "r10";
const XMM_SCRATCH = "xmm7";
const ENTRY_SYMBOL = "iw_x64_entry";
const GC_SHADOW_FRAME_ROOT_OFFSET_BYTES = 8;
const GC_SHADOW_FRAME_FIXED_SLOT_COUNT = 2;
const GC_SHADOW_FRAME_SLOT_SIZE_BYTES = 8;
const WIN64_SHADOW_SPACE_BYTES = 32;
const WIN64_STACK_SLOT_SIZE_BYTES = 8;

function mangleAsmSymbol(symbol: string): string {
    return symbol.replace(/[^A-Za-z0-9_.$]/g, "_");
}

function asmComment(text: string): string {
    return `# ${text}`;
}

function slotKey(kind: "spill" | "outgoing_arg", bank: X64MirRegisterBank, index: number): string {
    return `${kind}:${bank}:${index}`;
}

function buildSlotMap(body: X64FrameLayoutBody): ReadonlyMap<string, X64FrameSlotLayout> {
    return new Map(body.slots.map((slot) => [slotKey(slot.kind, slot.bank, slot.index), slot]));
}

function formatOffset(offset: number): string {
    return offset >= 0 ? `+${offset}` : `${offset}`;
}

function stackAddressFromSlot(slot: X64FrameSlotLayout): string {
    return `[rbp${formatOffset(slot.offsetFromRbp)}]`;
}

function stackAddressFromRbpOffset(offsetFromRbp: number): string {
    return `[rbp${formatOffset(offsetFromRbp)}]`;
}

function stackAddressFromRspOffset(offsetFromRsp: number): string {
    return offsetFromRsp === 0 ? "[rsp]" : `[rsp+${offsetFromRsp}]`;
}

function ripRelativeAddress(symbol: string): string {
    return `[rip+${symbol}]`;
}

function alignUp(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function spillAddress(bank: X64MirRegisterBank, index: number, slots: ReadonlyMap<string, X64FrameSlotLayout>): string {
    const slot = slots.get(slotKey("spill", bank, index));
    if (!slot) {
        throw new Error(`x64 emit failed: missing spill slot ${bank}#${index}`);
    }
    return stackAddressFromSlot(slot);
}

function outgoingArgAddress(bank: X64MirRegisterBank, index: number, slots: ReadonlyMap<string, X64FrameSlotLayout>): string {
    const slot = slots.get(slotKey("outgoing_arg", bank, index));
    if (!slot) {
        throw new Error(`x64 emit failed: missing outgoing arg slot ${bank}#${index}`);
    }
    return stackAddressFromSlot(slot);
}

function incomingArgAddress(index: number): string {
    return `[rbp+${16 + (index * 8)}]`;
}

function gcShadowFrameSizeBytes(rootCount: number): number {
    return (GC_SHADOW_FRAME_FIXED_SLOT_COUNT + rootCount) * GC_SHADOW_FRAME_SLOT_SIZE_BYTES;
}

function formatReadOperand(operand: X64RegAllocatedOperand, slots: ReadonlyMap<string, X64FrameSlotLayout>): string {
    switch (operand.kind) {
        case "preg":
            return operand.name;
        case "stack_slot":
            return spillAddress(operand.bank, operand.index, slots);
        case "stack_arg":
            return outgoingArgAddress(operand.bank, operand.index, slots);
        case "incoming_stack_arg":
            return incomingArgAddress(operand.index);
        case "imm_i64":
            return `${operand.value}`;
        case "symbol":
            return operand.symbol.startsWith("__iw_x64_direct_value_")
                ? `offset ${mangleAsmSymbol(operand.symbol)}`
                : ripRelativeAddress(mangleAsmSymbol(operand.symbol));
        case "text":
            return `offset ${x64NativeTextValueSymbol(operand.referenceName)}`;
    }
}

function isImmediateSymbolOperand(operand: X64RegAllocatedOperand): boolean {
    return operand.kind === "symbol" && operand.symbol.startsWith("__iw_x64_direct_value_");
}

function isImmediateAddressOperand(operand: X64RegAllocatedOperand): boolean {
    return isImmediateSymbolOperand(operand) || operand.kind === "text";
}

function formatImmediateAddressOperand(operand: X64RegAllocatedOperand): string {
    if (operand.kind === "symbol") {
        return ripRelativeAddress(mangleAsmSymbol(operand.symbol));
    }
    if (operand.kind === "text") {
        return ripRelativeAddress(x64NativeTextValueSymbol(operand.referenceName));
    }
    throw new Error(`x64 emit failed: expected immediate address operand, got '${operand.kind}'`);
}

function isMemoryOperand(operand: X64RegAllocatedOperand): boolean {
    return operand.kind === "stack_slot"
        || operand.kind === "stack_arg"
        || operand.kind === "incoming_stack_arg"
        || (operand.kind === "symbol" && !isImmediateSymbolOperand(operand));
}

function operandsEqual(left: X64RegAllocatedOperand, right: X64RegAllocatedOperand): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    switch (left.kind) {
        case "preg":
            return left.name === (right as typeof left).name && left.bank === (right as typeof left).bank;
        case "stack_slot":
        case "stack_arg":
            return left.index === (right as typeof left).index && left.bank === (right as typeof left).bank;
        case "incoming_stack_arg":
            return left.index === (right as typeof left).index && left.bank === (right as typeof left).bank;
        case "imm_i64":
            return left.value === (right as typeof left).value;
        case "symbol":
            return left.symbol === (right as typeof left).symbol;
        case "text":
            return left.referenceName === (right as typeof left).referenceName && left.typeName === (right as typeof left).typeName;
    }
}

function emitCopyLines(target: X64RegAllocatedOperand, source: X64RegAllocatedOperand, slots: ReadonlyMap<string, X64FrameSlotLayout>): readonly string[] {
    const bank = target.kind === "preg" || target.kind === "stack_slot" || target.kind === "stack_arg" || target.kind === "incoming_stack_arg"
        ? target.bank
        : source.kind === "preg" || source.kind === "stack_slot" || source.kind === "stack_arg" || source.kind === "incoming_stack_arg"
            ? source.bank
            : "gpr";
    const mnemonic = bank === "xmm" ? "movss" : "mov";
    const targetText = formatReadOperand(target, slots);
    const sourceText = formatReadOperand(source, slots);
    const scratch = bank === "xmm" ? XMM_SCRATCH : GPR_SCRATCH;
    const targetIsMemory = isMemoryOperand(target);
    const sourceIsMemory = isMemoryOperand(source);

    if (bank === "gpr" && isImmediateAddressOperand(source)) {
        const sourceAddress = formatImmediateAddressOperand(source);
        if (targetIsMemory) {
            return [`lea ${GPR_SCRATCH}, ${sourceAddress}`, `mov qword ptr ${targetText}, ${GPR_SCRATCH}`];
        }
        return [`lea ${targetText}, ${sourceAddress}`];
    }
    if (targetIsMemory && sourceIsMemory) {
        return [`${mnemonic} ${scratch}, ${sourceText}`, `${mnemonic} ${targetText}, ${scratch}`];
    }
    if (bank === "gpr" && targetIsMemory && source.kind === "imm_i64") {
        return [`mov qword ptr ${targetText}, ${sourceText}`];
    }
    return [`${mnemonic} ${targetText}, ${sourceText}`];
}

function emitStoreToAddressLines(
    targetAddress: string,
    source: X64RegAllocatedOperand,
    slots: ReadonlyMap<string, X64FrameSlotLayout>
): readonly string[] {
    const bank = source.kind === "preg" || source.kind === "stack_slot" || source.kind === "stack_arg" || source.kind === "incoming_stack_arg"
        ? source.bank
        : "gpr";
    if (bank === "xmm") {
        throw new Error("x64 emit failed: GC shadow frames do not support xmm roots");
    }
    const sourceText = formatReadOperand(source, slots);
    const sourceIsMemory = isMemoryOperand(source);
    if (isImmediateAddressOperand(source)) {
        return [`lea ${GPR_SCRATCH}, ${formatImmediateAddressOperand(source)}`, `mov qword ptr ${targetAddress}, ${GPR_SCRATCH}`];
    }
    if (sourceIsMemory) {
        return [`mov ${GPR_SCRATCH}, ${sourceText}`, `mov qword ptr ${targetAddress}, ${GPR_SCRATCH}`];
    }
    return [`mov qword ptr ${targetAddress}, ${sourceText}`];
}

function emitStoreToCallStackLines(
    targetAddress: string,
    source: X64RegAllocatedOperand,
    slots: ReadonlyMap<string, X64FrameSlotLayout>
): readonly string[] {
    const bank = source.kind === "preg" || source.kind === "stack_slot" || source.kind === "stack_arg" || source.kind === "incoming_stack_arg"
        ? source.bank
        : "gpr";
    const sourceText = formatReadOperand(source, slots);
    const sourceIsMemory = isMemoryOperand(source);
    if (bank === "gpr" && isImmediateAddressOperand(source)) {
        return [`lea ${GPR_SCRATCH}, ${formatImmediateAddressOperand(source)}`, `mov qword ptr ${targetAddress}, ${GPR_SCRATCH}`];
    }
    if (bank === "xmm") {
        if (sourceIsMemory) {
            return [`movss ${XMM_SCRATCH}, ${sourceText}`, `movss dword ptr ${targetAddress}, ${XMM_SCRATCH}`];
        }
        return [`movss dword ptr ${targetAddress}, ${sourceText}`];
    }
    if (sourceIsMemory) {
        return [`mov ${GPR_SCRATCH}, ${sourceText}`, `mov qword ptr ${targetAddress}, ${GPR_SCRATCH}`];
    }
    return [`mov qword ptr ${targetAddress}, ${sourceText}`];
}

function emitWin64CallLines(
    symbol: string,
    stackArgs: readonly X64RegAllocatedOperand[],
    slots: ReadonlyMap<string, X64FrameSlotLayout>
): readonly string[] {
    const stackReserveBytes = alignUp(WIN64_SHADOW_SPACE_BYTES + (stackArgs.length * WIN64_STACK_SLOT_SIZE_BYTES), 16);
    const lines = [`sub rsp, ${stackReserveBytes}`];
    stackArgs.forEach((operand, index) => {
        lines.push(...emitStoreToCallStackLines(
            stackAddressFromRspOffset(WIN64_SHADOW_SPACE_BYTES + (index * WIN64_STACK_SLOT_SIZE_BYTES)),
            operand,
            slots
        ));
    });
    lines.push(`call ${mangleAsmSymbol(symbol)}`);
    lines.push(`add rsp, ${stackReserveBytes}`);
    return lines;
}

function emitGcFrameBeginLines(
    instruction: Extract<X64RegAllocatedInstruction, { kind: "gc_frame_begin" }>,
    body: X64FrameLayoutBody,
    slots: ReadonlyMap<string, X64FrameSlotLayout>
): readonly string[] {
    if (body.gcShadowFrameSizeBytes <= 0) {
        throw new Error("x64 emit failed: missing GC shadow frame reservation");
    }
    if (instruction.gcRoots.length !== instruction.gcRootOperands.length) {
        throw new Error(`x64 emit failed: GC root/value count mismatch for [${instruction.gcRoots.join(", ")}]`);
    }
    const frameKey = x64NativeGcFrameKey(instruction.gcRoots);
    const lines = [instruction.gcRoots.length > 0 ? asmComment(`gc_frame_begin ${instruction.gcRoots.join(", ")} | key=${frameKey}`) : asmComment(`gc_frame_begin <none> | key=${frameKey}`)];
    const operandsByRoot = new Map(instruction.gcRoots.map((root, index) => [root, instruction.gcRootOperands[index]] as const));
    const canonicalRoots = [...instruction.gcRoots].sort((left, right) => left.localeCompare(right));
    for (let index = 0; index < canonicalRoots.length; index += 1) {
        const operand = operandsByRoot.get(canonicalRoots[index]);
        if (operand === undefined) {
            throw new Error(`x64 emit failed: missing GC root operand for '${canonicalRoots[index]}'`);
        }
        lines.push(...emitStoreToAddressLines(
            stackAddressFromRbpOffset(body.gcShadowFrameOffsetFromRbp + GC_SHADOW_FRAME_ROOT_OFFSET_BYTES + (index * GC_SHADOW_FRAME_SLOT_SIZE_BYTES)),
            operand,
            slots
        ));
    }
    lines.push(`lea rcx, ${stackAddressFromRbpOffset(body.gcShadowFrameOffsetFromRbp)}`);
    lines.push(...emitWin64CallLines(x64NativeGcFrameInitSymbol(frameKey), [], slots));
    return lines;
}

function emitGcFrameEndLines(
    instruction: Extract<X64RegAllocatedInstruction, { kind: "gc_frame_end" }>,
    body: X64FrameLayoutBody
): readonly string[] {
    if (body.gcShadowFrameSizeBytes <= 0) {
        throw new Error("x64 emit failed: missing GC shadow frame reservation");
    }
    const sizeBytes = gcShadowFrameSizeBytes(instruction.gcRoots.length);
    return [
        instruction.gcRoots.length > 0 ? asmComment(`gc_frame_end ${instruction.gcRoots.join(", ")}`) : asmComment("gc_frame_end <none>"),
        `mov qword ptr ${stackAddressFromRbpOffset(body.gcShadowFrameOffsetFromRbp)}, 0`,
        `mov qword ptr ${stackAddressFromRbpOffset(body.gcShadowFrameOffsetFromRbp + sizeBytes - GC_SHADOW_FRAME_SLOT_SIZE_BYTES)}, 0`
    ];
}

function emitInstruction(
    instruction: X64RegAllocatedInstruction,
    body: X64FrameLayoutBody,
    slots: ReadonlyMap<string, X64FrameSlotLayout>
): readonly string[] {
    switch (instruction.kind) {
        case "copy":
            return emitCopyLines(instruction.target, instruction.source, slots);
        case "call_direct":
            return instruction.callingConvention === "win64"
                ? [
                    instruction.gcRoots.length > 0 ? asmComment(`gc_roots ${instruction.gcRoots.join(", ")}`) : asmComment("gc_roots <none>"),
                    ...emitWin64CallLines(instruction.symbol, instruction.stackArgs, slots)
                ]
                : [instruction.gcRoots.length > 0 ? asmComment(`gc_roots ${instruction.gcRoots.join(", ")}`) : asmComment("gc_roots <none>"), `call ${mangleAsmSymbol(instruction.symbol)}`];
        case "call_indirect":
            return [instruction.gcRoots.length > 0 ? asmComment(`gc_roots ${instruction.gcRoots.join(", ")}`) : asmComment("gc_roots <none>"), `call ${formatReadOperand(instruction.callee, slots)}`];
        case "gc_frame_begin":
            return emitGcFrameBeginLines(instruction, body, slots);
        case "gc_frame_end":
            return emitGcFrameEndLines(instruction, body);
        case "test": {
            const leftText = formatReadOperand(instruction.left, slots);
            const rightText = formatReadOperand(instruction.right, slots);
            const leftIsMemory = isMemoryOperand(instruction.left);
            const rightIsMemory = isMemoryOperand(instruction.right);
            if (leftIsMemory && rightIsMemory) {
                return [`mov ${GPR_SCRATCH}, ${leftText}`, `test ${GPR_SCRATCH}, ${rightText}`];
            }
            if (leftIsMemory && instruction.right.kind === "imm_i64") {
                return [`test qword ptr ${leftText}, ${rightText}`];
            }
            if (rightIsMemory && instruction.left.kind === "imm_i64") {
                return [`test qword ptr ${rightText}, ${leftText}`];
            }
            return [`test ${leftText}, ${rightText}`];
        }
        case "pseudo_object_alloc":
            return [asmComment(`pseudo_object_alloc ${instruction.className} -> ${formatReadOperand(instruction.target, slots)}`)];
        case "pseudo_object_get_field":
            return [asmComment(`pseudo_object_get_field ${instruction.className}.${instruction.fieldName} ${formatReadOperand(instruction.receiver, slots)} -> ${formatReadOperand(instruction.target, slots)}`)];
        case "pseudo_object_set_field":
            return [asmComment(`pseudo_object_set_field ${instruction.className}.${instruction.fieldName} ${formatReadOperand(instruction.receiver, slots)} <- ${formatReadOperand(instruction.value, slots)}`)];
        case "pseudo_slot_load":
            return [asmComment(`pseudo_slot_load ${instruction.className}.${instruction.slotName} ${formatReadOperand(instruction.receiver, slots)} -> ${formatReadOperand(instruction.target, slots)}`)];
        case "pseudo_slot_store":
            return [asmComment(`pseudo_slot_store ${instruction.className}.${instruction.slotName} ${formatReadOperand(instruction.receiver, slots)} <- ${formatReadOperand(instruction.value, slots)}`)];
        case "pseudo_union_inject":
            return [asmComment(`pseudo_union_inject ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatReadOperand(instruction.value, slots)} -> ${formatReadOperand(instruction.target, slots)}`)];
        case "pseudo_union_has_tag":
            return [asmComment(`pseudo_union_has_tag ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatReadOperand(instruction.unionValue, slots)} -> ${formatReadOperand(instruction.target, slots)}`)];
        case "pseudo_union_get_payload":
            return [asmComment(`pseudo_union_get_payload ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatReadOperand(instruction.unionValue, slots)} -> ${formatReadOperand(instruction.target, slots)}`)];
        case "pseudo_closure_create":
            return [asmComment(`pseudo_closure_create ${instruction.closureId} env=${instruction.environmentLayout} -> ${formatReadOperand(instruction.target, slots)}`)];
    }
}

function emitEdgeCopies(
    targetLabel: string,
    args: readonly X64RegAllocatedOperand[],
    paramMap: ReadonlyMap<string, readonly X64RegAllocatedOperand[]>,
    slots: ReadonlyMap<string, X64FrameSlotLayout>
): readonly string[] {
    const params = paramMap.get(targetLabel) ?? [];
    if (params.length !== args.length) {
        throw new Error(`x64 emit failed: edge arg count mismatch for '${targetLabel}': params=${params.length} args=${args.length}`);
    }
    const pending = params
        .map((target, index) => ({ target, source: args[index] }))
        .filter(({ target, source }) => !operandsEqual(target, source));
    const lines: string[] = [];

    while (pending.length > 0) {
        const readyIndex = pending.findIndex(({ target }) => !pending.some(({ source }) => operandsEqual(source, target)));
        if (readyIndex >= 0) {
            const [move] = pending.splice(readyIndex, 1);
            lines.push(...emitCopyLines(move.target, move.source, slots));
            continue;
        }

        const cycleMove = pending.shift();
        if (!cycleMove) {
            break;
        }
        const scratch: X64RegAllocatedOperand = cycleMove.target.kind === "preg" && cycleMove.target.bank === "xmm"
            ? { kind: "preg", name: XMM_SCRATCH, bank: "xmm" }
            : { kind: "preg", name: GPR_SCRATCH, bank: "gpr" };
        lines.push(...emitCopyLines(scratch, cycleMove.source, slots));
        for (const move of pending) {
            if (operandsEqual(move.source, cycleMove.source)) {
                move.source = scratch;
            }
        }
        lines.push(...emitCopyLines(cycleMove.target, scratch, slots));
    }

    return lines;
}

function emitTerminator(
    blockLabel: string,
    terminator: X64RegAllocatedTerminator,
    nextLabel: string | undefined,
    epilogueLabel: string,
    paramMap: ReadonlyMap<string, readonly X64RegAllocatedOperand[]>,
    slots: ReadonlyMap<string, X64FrameSlotLayout>
): readonly string[] {
    switch (terminator.kind) {
        case "ret":
            return [`jmp ${epilogueLabel}`];
        case "jmp": {
            const edgeCopies = emitEdgeCopies(terminator.target, terminator.args, paramMap, slots);
            if (nextLabel === terminator.target && terminator.args.length === 0) {
                return [];
            }
            return [
                ...edgeCopies,
                ...(nextLabel === terminator.target ? [] : [`jmp ${terminator.target}`])
            ];
        }
        case "jcc": {
            const trueCopies = emitEdgeCopies(terminator.trueTarget, terminator.trueArgs, paramMap, slots);
            const falseCopies = emitEdgeCopies(terminator.falseTarget, terminator.falseArgs, paramMap, slots);
            if (trueCopies.length === 0 && falseCopies.length === 0) {
                if (nextLabel === terminator.falseTarget) {
                    return [`jnz ${terminator.trueTarget}`];
                }
                if (nextLabel === terminator.trueTarget) {
                    return [`jz ${terminator.falseTarget}`];
                }
            }
            const trueEdgeLabel = `${blockLabel}__edge_true`;
            return [
                `jnz ${trueEdgeLabel}`,
                ...falseCopies,
                `jmp ${terminator.falseTarget}`,
                `${trueEdgeLabel}:`,
                ...trueCopies,
                `jmp ${terminator.trueTarget}`
            ];
        }
    }
}

function emitPrologue(body: X64FrameLayoutBody): readonly string[] {
    const lines = ["push rbp", "mov rbp, rsp"];
    if (body.frameSizeBytes > 0) {
        lines.push(`sub rsp, ${body.frameSizeBytes}`);
    }
    const saveSlots = body.slots.filter((slot) => slot.kind === "spill" && slot.bank === "gpr" && slot.offsetFromRbp < 0).slice(0, body.calleeSavedRegisters.length);
    body.calleeSavedRegisters.forEach((registerName, index) => {
        const slot = saveSlots[index];
        if (!slot) {
            throw new Error(`x64 emit failed: missing callee-saved spill slot for ${registerName}`);
        }
        lines.push(`mov ${stackAddressFromSlot(slot)}, ${registerName}`);
    });
    if (body.gcRootNames.length > 0) {
        lines.push(asmComment(`gc_roots ${body.gcRootNames.join(", ")}`));
    }
    return lines;
}

function emitEpilogue(body: X64FrameLayoutBody): readonly string[] {
    const lines: string[] = [];
    const saveSlots = body.slots.filter((slot) => slot.kind === "spill" && slot.bank === "gpr" && slot.offsetFromRbp < 0).slice(0, body.calleeSavedRegisters.length);
    [...body.calleeSavedRegisters].reverse().forEach((registerName, reverseIndex) => {
        const slot = saveSlots[body.calleeSavedRegisters.length - 1 - reverseIndex];
        if (slot) {
            lines.push(`mov ${registerName}, ${stackAddressFromSlot(slot)}`);
        }
    });
    if (body.frameSizeBytes > 0) {
        lines.push(`add rsp, ${body.frameSizeBytes}`);
    }
    lines.push("pop rbp", "ret");
    return lines;
}

function emitBody(symbol: string, body: X64FrameLayoutBody): string {
    const slots = buildSlotMap(body);
    const paramMap = new Map(body.blocks.map((block) => [block.label, block.params]));
    const epilogueLabel = `${symbol}__epilogue`;
    const lines: string[] = [".intel_syntax noprefix", ".text", `.globl ${symbol}`, `${symbol}:`, ...emitPrologue(body)].filter((line) => line.length > 0);
    for (let index = 0; index < body.blocks.length; index += 1) {
        const block = body.blocks[index];
        const nextLabel = body.blocks[index + 1]?.label;
        lines.push(`${block.label}:`);
        block.instructions.forEach((instruction) => lines.push(...emitInstruction(instruction, body, slots).map((line) => `  ${line}`)));
        lines.push(...emitTerminator(block.label, block.terminator, nextLabel, epilogueLabel, paramMap, slots).map((line) => line.endsWith(":") ? line : `  ${line}`));
    }
    lines.push(`${epilogueLabel}:`);
    lines.push(...emitEpilogue(body).map((line) => `  ${line}`));
    return lines.join("\n");
}

function emitFunction(fn: X64EmittableFunctionDefinition): X64TextualAssemblyFunctionDefinition {
    return {
        symbol: fn.symbol,
        text: emitBody(mangleAsmSymbol(fn.symbol), fn.body)
    };
}

export function emitX64TextualAssemblyPass(program: X64EmittableProgram): X64TextualAssemblyProgram {
    const functions = program.functions.map(emitFunction);
    const entryText = emitBody(ENTRY_SYMBOL, program.entry);
    const text = buildX64TextualAssembly(entryText, functions.map((fn) => fn.text));
    return {
        kind: "x64_textual_assembly_program",
        entrySymbol: ENTRY_SYMBOL,
        entryText,
        functions,
        text
    };
}
