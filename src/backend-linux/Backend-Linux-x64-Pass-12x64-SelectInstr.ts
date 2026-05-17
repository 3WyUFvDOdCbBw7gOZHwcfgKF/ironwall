import type {
    X64CallConvention,
    X64MirBody,
    X64MirInstruction,
    X64MirOperand,
    X64MirProgram,
    X64MirRegisterBank,
    X64MirTerminator,
    X64MirVirtualRegisterOperand,
    X64PhysicalRegisterName,
    X64SelectedBody,
    X64SelectedInstruction,
    X64SelectedOperand,
    X64SelectedProgram,
    X64SelectedTerminator
} from "./Backend-Linux-IR-Shared";
import {
    x64NativeAllocSymbol,
    x64NativeClosureCallSymbol,
    x64NativeClosureCreateSymbol,
    x64NativeDirectCallWrapperSymbol,
    x64NativeObjectGetFieldSymbol,
    x64NativeObjectSetFieldSymbol,
    x64NativeSlotLoadSymbol,
    x64NativeSlotStoreSymbol,
    x64NativeUnionGetPayloadSymbol,
    x64NativeUnionHasTagSymbol,
    x64NativeUnionInjectSymbol
} from "./Backend-Linux-X64-NativeSupport";
const SYSV_GPR_ARG_REGS: readonly X64PhysicalRegisterName[] = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];
const SYSV_XMM_ARG_REGS: readonly X64PhysicalRegisterName[] = ["xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"];

function gprArgRegistersForCallingConvention(callingConvention: X64CallConvention): readonly X64PhysicalRegisterName[] {
    switch (callingConvention) {
        case "internal":
        case "sysv_c_ffi":
            return SYSV_GPR_ARG_REGS;
    }
}

function xmmArgRegistersForCallingConvention(callingConvention: X64CallConvention): readonly X64PhysicalRegisterName[] {
    switch (callingConvention) {
        case "internal":
        case "sysv_c_ffi":
            return SYSV_XMM_ARG_REGS;
    }
}

function physicalRegister(name: X64PhysicalRegisterName, bank: X64MirRegisterBank): X64SelectedOperand {
    return { kind: "preg", name, bank };
}

function incomingStackArg(index: number, bank: X64MirRegisterBank): X64SelectedOperand {
    return { kind: "incoming_stack_arg", index, bank };
}

function lowerOperand(operand: X64MirOperand): X64SelectedOperand {
    return operand;
}

function operandBank(operand: X64SelectedOperand): X64MirRegisterBank {
    switch (operand.kind) {
        case "vreg":
        case "preg":
        case "stack_arg":
        case "incoming_stack_arg":
            return operand.bank;
        case "imm_i64":
        case "symbol":
        case "text":
            return "gpr";
    }
}

function appendCallArgMoves(
    instructions: X64SelectedInstruction[],
    args: readonly X64MirOperand[],
    callingConvention: X64CallConvention
): readonly X64SelectedOperand[] {
    const gprArgRegs = gprArgRegistersForCallingConvention(callingConvention);
    const xmmArgRegs = xmmArgRegistersForCallingConvention(callingConvention);
    const stackArgs: X64SelectedOperand[] = [];
    let nextGpr = 0;
    let nextXmm = 0;
    for (const arg of args) {
        const lowered = lowerOperand(arg);
        const bank = operandBank(lowered);
        if (bank === "xmm") {
            const registerName = xmmArgRegs[nextXmm];
            if (registerName) {
                instructions.push({
                    kind: "copy",
                    target: physicalRegister(registerName, "xmm"),
                    source: lowered
                });
                nextXmm += 1;
                continue;
            }
            stackArgs.push(lowered);
            continue;
        }
        const registerName = gprArgRegs[nextGpr];
        if (registerName) {
            instructions.push({
                kind: "copy",
                target: physicalRegister(registerName, "gpr"),
                source: lowered
            });
            nextGpr += 1;
            continue;
        }
        stackArgs.push(lowered);
    }
    return stackArgs;
}

function appendReturnCopy(instructions: X64SelectedInstruction[], target: X64MirVirtualRegisterOperand | undefined): void {
    if (!target) {
        return;
    }
    instructions.push({
        kind: "copy",
        target,
        source: physicalRegister(target.bank === "xmm" ? "xmm0" : "rax", target.bank)
    });
}

function appendIncomingParamMoves(instructions: X64SelectedInstruction[], params: readonly X64MirVirtualRegisterOperand[]): void {
    const gprArgRegs = gprArgRegistersForCallingConvention("internal");
    const xmmArgRegs = xmmArgRegistersForCallingConvention("internal");
    let nextGpr = 0;
    let nextXmm = 0;
    let nextStack = 0;
    for (const param of params) {
        if (param.bank === "xmm") {
            const registerName = xmmArgRegs[nextXmm];
            if (registerName) {
                instructions.push({
                    kind: "copy",
                    target: param,
                    source: physicalRegister(registerName, "xmm")
                });
                nextXmm += 1;
                continue;
            }
            instructions.push({
                kind: "copy",
                target: param,
                source: incomingStackArg(nextStack, "xmm")
            });
            nextStack += 1;
            continue;
        }
        const registerName = gprArgRegs[nextGpr];
        if (registerName) {
            instructions.push({
                kind: "copy",
                target: param,
                source: physicalRegister(registerName, "gpr")
            });
            nextGpr += 1;
            continue;
        }
        instructions.push({
            kind: "copy",
            target: param,
            source: incomingStackArg(nextStack, "gpr")
        });
        nextStack += 1;
    }
}

function appendGcFrameBegin(
    instructions: X64SelectedInstruction[],
    gcRoots: readonly string[],
    gcRootOperands: readonly X64MirOperand[]
): void {
    instructions.push({
        kind: "gc_frame_begin",
        gcRoots,
        gcRootOperands: gcRootOperands.map((operand) => lowerOperand(operand))
    });
}

function appendGcFrameEnd(instructions: X64SelectedInstruction[], gcRoots: readonly string[]): void {
    instructions.push({
        kind: "gc_frame_end",
        gcRoots
    });
}

function lowerHelperCall(
    symbol: string,
    args: readonly X64MirOperand[],
    gcRoots: readonly string[],
    gcRootOperands: readonly X64MirOperand[],
    target?: X64MirVirtualRegisterOperand,
    callingConvention: X64CallConvention = "sysv_c_ffi"
): readonly X64SelectedInstruction[] {
    const selected: X64SelectedInstruction[] = [];
    if (gcRoots.length > 0) {
        appendGcFrameBegin(selected, gcRoots, gcRootOperands);
    }
    const stackArgs = appendCallArgMoves(selected, args, callingConvention);
    selected.push({
        kind: "call_direct",
        symbol,
        gcRoots,
        callingConvention,
        stackArgs
    });
    appendReturnCopy(selected, target);
    if (gcRoots.length > 0) {
        appendGcFrameEnd(selected, gcRoots);
    }
    return selected;
}

interface NativeCallContext {
    readonly programSymbols: ReadonlySet<string>;
    readonly externCallingConventions: ReadonlyMap<string, "c_ffi" | "iw_external">;
}

function resolveCallConvention(symbol: string, context: NativeCallContext): X64CallConvention {
    if (context.programSymbols.has(symbol)) {
        return "internal";
    }
    const externCallingConvention = context.externCallingConventions.get(symbol);
    if (externCallingConvention === "iw_external") {
        return "internal";
    }
    return "sysv_c_ffi";
}

function lowerInstruction(instruction: X64MirInstruction, context: NativeCallContext): readonly X64SelectedInstruction[] {
    switch (instruction.kind) {
        case "move":
            return [{
                kind: "copy",
                target: instruction.target,
                source: lowerOperand(instruction.source)
            }];
        case "call_direct": {
            const selected: X64SelectedInstruction[] = [];
            if (instruction.gcRoots.length > 0) {
                appendGcFrameBegin(selected, instruction.gcRoots, instruction.gcRootOperands);
            }
            const callingConvention = resolveCallConvention(instruction.symbol, context);
            const stackArgs = appendCallArgMoves(selected, instruction.args, callingConvention);
            selected.push({
                kind: "call_direct",
                symbol: callingConvention === "internal"
                    ? instruction.symbol
                    : x64NativeDirectCallWrapperSymbol(instruction.symbol),
                gcRoots: instruction.gcRoots,
                callingConvention,
                stackArgs
            });
            appendReturnCopy(selected, instruction.target);
            if (instruction.gcRoots.length > 0) {
                appendGcFrameEnd(selected, instruction.gcRoots);
            }
            return selected;
        }
        case "call_closure": {
            if (!instruction.target) {
                throw new Error("x64 instruction selection encountered closure_call without a target");
            }
            if (instruction.target.bank === "xmm" || instruction.args.some((arg) => operandBank(lowerOperand(arg)) === "xmm")) {
                throw new Error("x64 instruction selection invariant failed: closure_call operands/results must use iw_value_t-compatible GPR representation");
            }
            return lowerHelperCall(
                x64NativeClosureCallSymbol(instruction.args.length),
                [instruction.callee, ...instruction.args],
                instruction.gcRoots,
                instruction.gcRootOperands,
                instruction.target
            );
        }
        case "object_alloc":
            return lowerHelperCall(x64NativeAllocSymbol(instruction.className), [], instruction.gcRoots, instruction.gcRootOperands, instruction.target);
        case "object_get_field":
            return lowerHelperCall(
                x64NativeObjectGetFieldSymbol(instruction.className, instruction.fieldName),
                [instruction.receiver],
                instruction.gcRoots,
                instruction.gcRootOperands,
                instruction.target
            );
        case "object_set_field":
            return lowerHelperCall(
                x64NativeObjectSetFieldSymbol(instruction.className, instruction.fieldName),
                [instruction.receiver, instruction.value],
                instruction.gcRoots,
                instruction.gcRootOperands
            );
        case "slot_load":
            return lowerHelperCall(
                x64NativeSlotLoadSymbol(instruction.className, instruction.slotName),
                [instruction.receiver],
                instruction.gcRoots,
                instruction.gcRootOperands,
                instruction.target
            );
        case "slot_store":
            return lowerHelperCall(
                x64NativeSlotStoreSymbol(instruction.className, instruction.slotName),
                [instruction.receiver, instruction.value],
                instruction.gcRoots,
                instruction.gcRootOperands
            );
        case "union_inject":
            return lowerHelperCall(
                x64NativeUnionInjectSymbol(instruction.unionTypeTagId, instruction.memberTypeTagId),
                [instruction.value],
                instruction.gcRoots,
                instruction.gcRootOperands,
                instruction.target
            );
        case "union_has_tag":
            return lowerHelperCall(
                x64NativeUnionHasTagSymbol(instruction.unionTypeTagId, instruction.memberTypeTagId),
                [instruction.unionValue],
                instruction.gcRoots,
                instruction.gcRootOperands,
                instruction.target
            );
        case "union_get_payload":
            return lowerHelperCall(
                x64NativeUnionGetPayloadSymbol(instruction.unionTypeTagId, instruction.memberTypeTagId),
                [instruction.unionValue],
                instruction.gcRoots,
                instruction.gcRootOperands,
                instruction.target
            );
        case "closure_create":
            if (instruction.target.bank === "xmm" || instruction.captures.some((capture) => operandBank(lowerOperand(capture)) === "xmm")) {
                throw new Error("x64 instruction selection invariant failed: closure_create captures/result must use iw_value_t-compatible GPR representation");
            }
            return lowerHelperCall(
                x64NativeClosureCreateSymbol(instruction.closureId),
                instruction.captures,
                instruction.gcRoots,
                instruction.gcRootOperands,
                instruction.target
            );
    }
}

function lowerTerminator(terminator: X64MirTerminator): { readonly instructions: readonly X64SelectedInstruction[]; readonly terminator: X64SelectedTerminator } {
    switch (terminator.kind) {
        case "jump":
            return {
                instructions: [],
                terminator: {
                    kind: "jmp",
                    target: terminator.target,
                    args: terminator.args.map(lowerOperand)
                }
            };
        case "branch": {
            const cond = lowerOperand(terminator.cond);
            return {
                instructions: [{
                    kind: "test",
                    left: cond,
                    right: { kind: "imm_i64", value: 2 }
                }],
                terminator: {
                    kind: "jcc",
                    condition: "nz",
                    trueTarget: terminator.trueTarget,
                    trueArgs: terminator.trueArgs.map(lowerOperand),
                    falseTarget: terminator.falseTarget,
                    falseArgs: terminator.falseArgs.map(lowerOperand)
                }
            };
        }
        case "return": {
            const value = lowerOperand(terminator.value);
            const bank = operandBank(value);
            return {
                instructions: [{
                    kind: "copy",
                    target: physicalRegister(bank === "xmm" ? "xmm0" : "rax", bank),
                    source: value
                }],
                terminator: { kind: "ret" }
            };
        }
    }
}

function lowerBody(body: X64MirBody, context: NativeCallContext, functionParamCount = 0): X64SelectedBody {
    return {
        entryLabel: body.entryLabel,
        gcRootNames: body.gcRootNames,
        blocks: body.blocks.map((block) => {
            const instructionList: X64SelectedInstruction[] = [];
            if (block.label === body.entryLabel && functionParamCount > 0) {
                appendIncomingParamMoves(instructionList, block.params.slice(0, functionParamCount));
            }
            for (const instruction of block.instructions) {
                instructionList.push(...lowerInstruction(instruction, context));
            }
            const loweredTerminator = lowerTerminator(block.terminator);
            instructionList.push(...loweredTerminator.instructions);
            return {
                label: block.label,
                predecessors: block.predecessors,
                params: block.params,
                instructions: instructionList,
                terminator: loweredTerminator.terminator
            };
        })
    };
}

export function selectX64InstructionsPass(program: X64MirProgram): X64SelectedProgram {
    const context: NativeCallContext = {
        programSymbols: new Set<string>(program.functions.map((fn) => fn.symbol)),
        externCallingConventions: new Map(program.declaredFunctions.map((fn) => [fn.symbol, fn.callingConvention] as const))
    };
    return {
        kind: "x64_selected_program",
        entry: lowerBody(program.entry, context, program.metadata.entryParams.length),
        globals: program.globals,
        functions: program.functions.map((fn) => ({
            symbol: fn.symbol,
            params: fn.params,
            returnType: fn.returnType,
            body: lowerBody(fn.body, context, fn.params.length),
            origin: fn.origin
        })),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
