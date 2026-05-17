import type {
    X64FrameLayoutBody,
    X64RegAllocatedInstruction,
    X64RegAllocatedOperand,
    X64Round2LaidOutFunctionDefinition,
    X64Round2LaidOutProgram,
    X64Round2PeepholeFunctionDefinition,
    X64Round2PeepholeProgram
} from "./Backend-Windows-IR-Shared";

function operandsEqual(left: X64RegAllocatedOperand, right: X64RegAllocatedOperand): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    switch (left.kind) {
        case "preg":
            return left.name === (right as typeof left).name && left.bank === (right as typeof left).bank;
        case "stack_slot":
        case "stack_arg":
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

function instructionsEqual(left: X64RegAllocatedInstruction, right: X64RegAllocatedInstruction): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    if (left.kind === "copy" && right.kind === "copy") {
        return operandsEqual(left.target, right.target) && operandsEqual(left.source, right.source);
    }
    if (left.kind === "test" && right.kind === "test") {
        return operandsEqual(left.left, right.left) && operandsEqual(left.right, right.right);
    }
    return false;
}

function rewriteInstructions(instructions: readonly X64RegAllocatedInstruction[]): readonly X64RegAllocatedInstruction[] {
    const rewritten: X64RegAllocatedInstruction[] = [];
    for (const instruction of instructions) {
        if (instruction.kind === "copy" && operandsEqual(instruction.target, instruction.source)) {
            continue;
        }
        const previous = rewritten[rewritten.length - 1];
        if (
            previous
            && previous.kind === "copy"
            && instruction.kind === "copy"
            && operandsEqual(previous.target, instruction.target)
        ) {
            rewritten.pop();
        }
        const currentPrevious = rewritten[rewritten.length - 1];
        if (currentPrevious && instructionsEqual(currentPrevious, instruction)) {
            continue;
        }
        rewritten.push(instruction);
    }
    return rewritten;
}

function rewriteBody(body: X64FrameLayoutBody): X64FrameLayoutBody {
    return {
        ...body,
        blocks: body.blocks.map((block) => ({
            ...block,
            instructions: rewriteInstructions(block.instructions)
        }))
    };
}

function rewriteFunction(fn: X64Round2LaidOutFunctionDefinition): X64Round2PeepholeFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: rewriteBody(fn.body),
        origin: fn.origin
    };
}

export function round2PeepholeX64Pass(program: X64Round2LaidOutProgram): X64Round2PeepholeProgram {
    return {
        kind: "x64_round_2_peephole_program",
        entry: rewriteBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(rewriteFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
