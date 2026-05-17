import type {
    X64FrameLayoutBody,
    X64FrameLayoutFunctionDefinition,
    X64FrameLayoutProgram,
    X64PostRAPeepholeFunctionDefinition,
    X64PostRAPeepholeProgram,
    X64RegAllocatedInstruction,
    X64RegAllocatedOperand
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
    return false;
}

function rewriteInstructions(instructions: readonly X64RegAllocatedInstruction[]): readonly X64RegAllocatedInstruction[] {
    const rewritten: X64RegAllocatedInstruction[] = [];
    for (const instruction of instructions) {
        if (instruction.kind === "copy" && operandsEqual(instruction.target, instruction.source)) {
            continue;
        }
        const previous = rewritten[rewritten.length - 1];
        if (previous && instructionsEqual(previous, instruction)) {
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

function rewriteFunction(fn: X64FrameLayoutFunctionDefinition): X64PostRAPeepholeFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: rewriteBody(fn.body),
        origin: fn.origin
    };
}

export function postRaPeepholeX64Pass(program: X64FrameLayoutProgram): X64PostRAPeepholeProgram {
    return {
        kind: "x64_post_ra_peephole_program",
        entry: rewriteBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(rewriteFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
