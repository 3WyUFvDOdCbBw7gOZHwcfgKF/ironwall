import type {
    X64CopyPropagatedProgram,
    X64SelectedBlock,
    X64SelectedBody,
    X64SelectedFunctionDefinition,
    X64SelectedInstruction,
    X64SelectedOperand,
    X64SelectedProgram,
    X64SelectedTerminator
} from "./Backend-Linux-IR-Shared";

function operandKey(operand: X64SelectedOperand): string {
    switch (operand.kind) {
        case "vreg":
            return `vreg:${operand.name}:${operand.bank}`;
        case "preg":
            return `preg:${operand.name}:${operand.bank}`;
        case "stack_arg":
            return `stack:${operand.index}:${operand.bank}`;
        case "incoming_stack_arg":
            return `incoming_stack:${operand.index}:${operand.bank}`;
        case "imm_i64":
            return `imm_i64:${operand.value}`;
        case "symbol":
            return `symbol:${operand.symbol}`;
        case "text":
            return `text:${operand.referenceName}:${operand.typeName}:${operand.content}`;
    }
}

function cloneOperand(operand: X64SelectedOperand): X64SelectedOperand {
    switch (operand.kind) {
        case "vreg":
            return { kind: "vreg", name: operand.name, bank: operand.bank };
        case "preg":
            return { kind: "preg", name: operand.name, bank: operand.bank };
        case "stack_arg":
            return { kind: "stack_arg", index: operand.index, bank: operand.bank };
        case "incoming_stack_arg":
            return { kind: "incoming_stack_arg", index: operand.index, bank: operand.bank };
        case "imm_i64":
            return { kind: "imm_i64", value: operand.value };
        case "symbol":
            return { kind: "symbol", symbol: operand.symbol };
        case "text":
            return {
                kind: "text",
                typeName: operand.typeName,
                referenceName: operand.referenceName,
                content: operand.content
            };
    }
}

function resolveOperand(operand: X64SelectedOperand, substitutions: ReadonlyMap<string, X64SelectedOperand>): X64SelectedOperand {
    if (operand.kind !== "vreg") {
        return cloneOperand(operand);
    }
    let current: X64SelectedOperand = operand;
    const visited = new Set<string>();
    while (current.kind === "vreg" && substitutions.has(current.name) && !visited.has(current.name)) {
        visited.add(current.name);
        current = substitutions.get(current.name) ?? current;
    }
    return cloneOperand(current);
}

function invalidateForWrite(substitutions: Map<string, X64SelectedOperand>, written: X64SelectedOperand | null): void {
    if (!written) {
        return;
    }
    const writtenKey = operandKey(written);
    for (const [name, value] of [...substitutions.entries()]) {
        if (name === (written.kind === "vreg" ? written.name : "__never__") || operandKey(value) === writtenKey) {
            substitutions.delete(name);
        }
    }
}

function invalidateForCall(substitutions: Map<string, X64SelectedOperand>): void {
    for (const [name, value] of [...substitutions.entries()]) {
        if (value.kind === "preg") {
            substitutions.delete(name);
        }
    }
}

function propagateInstruction(
    instruction: X64SelectedInstruction,
    substitutions: Map<string, X64SelectedOperand>
): X64SelectedInstruction | null {
    switch (instruction.kind) {
        case "copy": {
            const source = resolveOperand(instruction.source, substitutions);
            const target = cloneOperand(instruction.target);
            invalidateForWrite(substitutions, target);
            if (target.kind === "vreg") {
                substitutions.set(target.name, source);
            }
            if (operandKey(target) === operandKey(source)) {
                return null;
            }
            return { kind: "copy", target, source };
        }
        case "call_direct":
            invalidateForCall(substitutions);
            return {
                ...instruction,
                stackArgs: instruction.stackArgs.map((operand) => resolveOperand(operand, substitutions))
            };
        case "call_indirect":
            invalidateForCall(substitutions);
            return {
                ...instruction,
                callee: resolveOperand(instruction.callee, substitutions)
            };
        case "gc_frame_begin": {
            const gcRootOperands = instruction.gcRootOperands.map((operand) => resolveOperand(operand, substitutions));
            invalidateForCall(substitutions);
            return {
                ...instruction,
                gcRootOperands
            };
        }
        case "gc_frame_end":
            return instruction;
        case "test":
            return {
                kind: "test",
                left: resolveOperand(instruction.left, substitutions),
                right: resolveOperand(instruction.right, substitutions)
            };
        case "pseudo_object_alloc":
            invalidateForWrite(substitutions, instruction.target);
            return instruction;
        case "pseudo_object_get_field":
            invalidateForWrite(substitutions, instruction.target);
            return {
                ...instruction,
                receiver: resolveOperand(instruction.receiver, substitutions)
            };
        case "pseudo_object_set_field":
            return {
                ...instruction,
                receiver: resolveOperand(instruction.receiver, substitutions),
                value: resolveOperand(instruction.value, substitutions)
            };
        case "pseudo_slot_load":
            invalidateForWrite(substitutions, instruction.target);
            return {
                ...instruction,
                receiver: resolveOperand(instruction.receiver, substitutions)
            };
        case "pseudo_slot_store":
            return {
                ...instruction,
                receiver: resolveOperand(instruction.receiver, substitutions),
                value: resolveOperand(instruction.value, substitutions)
            };
        case "pseudo_union_inject":
            invalidateForWrite(substitutions, instruction.target);
            return {
                ...instruction,
                value: resolveOperand(instruction.value, substitutions)
            };
        case "pseudo_union_has_tag":
            invalidateForWrite(substitutions, instruction.target);
            return {
                ...instruction,
                unionValue: resolveOperand(instruction.unionValue, substitutions)
            };
        case "pseudo_union_get_payload":
            invalidateForWrite(substitutions, instruction.target);
            return {
                ...instruction,
                unionValue: resolveOperand(instruction.unionValue, substitutions)
            };
        case "pseudo_closure_create":
            invalidateForWrite(substitutions, instruction.target);
            return {
                ...instruction,
                captures: instruction.captures.map((capture) => resolveOperand(capture, substitutions))
            };
    }
}

function propagateTerminator(terminator: X64SelectedTerminator, substitutions: ReadonlyMap<string, X64SelectedOperand>): X64SelectedTerminator {
    switch (terminator.kind) {
        case "ret":
            return terminator;
        case "jmp":
            return {
                kind: "jmp",
                target: terminator.target,
                args: terminator.args.map((arg) => resolveOperand(arg, substitutions))
            };
        case "jcc":
            return {
                kind: "jcc",
                condition: terminator.condition,
                trueTarget: terminator.trueTarget,
                trueArgs: terminator.trueArgs.map((arg) => resolveOperand(arg, substitutions)),
                falseTarget: terminator.falseTarget,
                falseArgs: terminator.falseArgs.map((arg) => resolveOperand(arg, substitutions))
            };
    }
}

function propagateBlock(block: X64SelectedBlock): X64SelectedBlock {
    const substitutions = new Map<string, X64SelectedOperand>();
    const instructions: X64SelectedInstruction[] = [];
    for (const instruction of block.instructions) {
        const propagated = propagateInstruction(instruction, substitutions);
        if (propagated) {
            instructions.push(propagated);
        }
    }
    return {
        ...block,
        instructions,
        terminator: propagateTerminator(block.terminator, substitutions)
    };
}

function propagateBody(body: X64SelectedBody): X64SelectedBody {
    return {
        ...body,
        blocks: body.blocks.map(propagateBlock)
    };
}

function propagateFunction(fn: X64SelectedFunctionDefinition): X64SelectedFunctionDefinition {
    return {
        ...fn,
        body: propagateBody(fn.body)
    };
}

export function copyPropagateX64Pass(program: X64SelectedProgram): X64CopyPropagatedProgram {
    return {
        kind: "x64_copy_propagated_program",
        entry: propagateBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(propagateFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
