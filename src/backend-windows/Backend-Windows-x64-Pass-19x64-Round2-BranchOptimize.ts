import type {
    X64FrameLayoutBody,
    X64RegAllocatedOperand,
    X64Round2BranchOptimizedFunctionDefinition,
    X64Round2BranchOptimizedProgram,
    X64LaidOutFunctionDefinition,
    X64LaidOutProgram
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

function edgeArgsEqual(left: readonly X64RegAllocatedOperand[], right: readonly X64RegAllocatedOperand[]): boolean {
    return left.length === right.length && left.every((operand, index) => operandsEqual(operand, right[index]));
}

function recomputePredecessors(blocks: readonly X64FrameLayoutBody["blocks"][number][]): readonly X64FrameLayoutBody["blocks"][number][] {
    const predecessors = new Map<string, Set<string>>();
    for (const block of blocks) {
        predecessors.set(block.label, new Set<string>());
    }
    for (const block of blocks) {
        switch (block.terminator.kind) {
            case "ret":
                break;
            case "jmp":
                predecessors.get(block.terminator.target)?.add(block.label);
                break;
            case "jcc":
                predecessors.get(block.terminator.trueTarget)?.add(block.label);
                predecessors.get(block.terminator.falseTarget)?.add(block.label);
                break;
        }
    }
    return blocks.map((block) => ({
        ...block,
        predecessors: [...(predecessors.get(block.label) ?? [])]
    }));
}

function simplifyTerminator(terminator: X64FrameLayoutBody["blocks"][number]["terminator"]): X64FrameLayoutBody["blocks"][number]["terminator"] {
    if (
        terminator.kind === "jcc"
        && terminator.trueTarget === terminator.falseTarget
        && edgeArgsEqual(terminator.trueArgs, terminator.falseArgs)
    ) {
        return {
            kind: "jmp",
            target: terminator.trueTarget,
            args: terminator.trueArgs
        };
    }
    return terminator;
}

function canMergeStraightLineSuccessor(
    body: X64FrameLayoutBody,
    block: X64FrameLayoutBody["blocks"][number],
    successor: X64FrameLayoutBody["blocks"][number]
): boolean {
    return block.terminator.kind === "jmp"
        && block.terminator.args.length === 0
        && successor.label !== body.entryLabel
        && successor.params.length === 0
        && successor.predecessors.length === 1
        && successor.predecessors[0] === block.label;
}

function optimizeBody(body: X64FrameLayoutBody): X64FrameLayoutBody {
    let blocks = recomputePredecessors(body.blocks);

    while (true) {
        let merged = false;
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
            const block = blocks[blockIndex];
            if (block.terminator.kind !== "jmp") {
                continue;
            }
            const targetLabel = block.terminator.target;
            const successorIndex = blocks.findIndex((candidate) => candidate.label === targetLabel);
            if (successorIndex <= blockIndex) {
                continue;
            }
            const successor = blocks[successorIndex];
            if (!canMergeStraightLineSuccessor(body, block, successor)) {
                continue;
            }

            const mergedBlock = {
                ...block,
                instructions: [...block.instructions, ...successor.instructions],
                terminator: simplifyTerminator(successor.terminator)
            };
            blocks = recomputePredecessors(blocks.map((candidate, index) => {
                if (index === blockIndex) {
                    return mergedBlock;
                }
                return candidate;
            }).filter((_, index) => index !== successorIndex));
            merged = true;
            break;
        }
        if (!merged) {
            break;
        }
    }

    return {
        ...body,
        blocks: blocks.map((block) => ({
            ...block,
            terminator: simplifyTerminator(block.terminator)
        }))
    };
}

function optimizeFunction(fn: X64LaidOutFunctionDefinition): X64Round2BranchOptimizedFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: optimizeBody(fn.body),
        origin: fn.origin
    };
}

export function round2BranchOptimizeX64Pass(program: X64LaidOutProgram): X64Round2BranchOptimizedProgram {
    return {
        kind: "x64_round_2_branch_optimized_program",
        entry: optimizeBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(optimizeFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
