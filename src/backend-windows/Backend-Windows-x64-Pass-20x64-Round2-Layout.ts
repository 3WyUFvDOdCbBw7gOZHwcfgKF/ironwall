import type {
    X64FrameLayoutBody,
    X64Round2BranchOptimizedFunctionDefinition,
    X64Round2BranchOptimizedProgram,
    X64Round2LaidOutFunctionDefinition,
    X64Round2LaidOutProgram
} from "./Backend-Windows-IR-Shared";

function successorScore(
    currentLabel: string,
    target: X64FrameLayoutBody["blocks"][number] | undefined,
    argCount: number
): number {
    if (!target) {
        return Number.NEGATIVE_INFINITY;
    }
    let score = 0;
    if (argCount === 0) {
        score += 8;
    }
    if (target.predecessors.length === 1 && target.predecessors[0] === currentLabel) {
        score += 12;
    }
    if (target.instructions.length > 0) {
        score += 2;
    }
    if (target.terminator.kind === "ret") {
        score -= 3;
    }
    score -= target.predecessors.length;
    return score;
}

function layoutBody(body: X64FrameLayoutBody): X64FrameLayoutBody {
    const blocksByLabel = new Map(body.blocks.map((block) => [block.label, block]));
    const originalOrder = new Map(body.blocks.map((block, index) => [block.label, index]));
    const ordered: Array<X64FrameLayoutBody["blocks"][number]> = [];
    const visited = new Set<string>();

    const visit = (label: string): void => {
        if (visited.has(label)) {
            return;
        }
        const block = blocksByLabel.get(label);
        if (!block) {
            return;
        }
        visited.add(label);
        ordered.push(block);
        switch (block.terminator.kind) {
            case "ret":
                return;
            case "jmp":
                visit(block.terminator.target);
                return;
            case "jcc": {
                const successors = [
                    {
                        label: block.terminator.trueTarget,
                        argCount: block.terminator.trueArgs.length
                    },
                    {
                        label: block.terminator.falseTarget,
                        argCount: block.terminator.falseArgs.length
                    }
                ].sort((left, right) => {
                    const leftScore = successorScore(block.label, blocksByLabel.get(left.label), left.argCount);
                    const rightScore = successorScore(block.label, blocksByLabel.get(right.label), right.argCount);
                    if (leftScore !== rightScore) {
                        return rightScore - leftScore;
                    }
                    return (originalOrder.get(left.label) ?? Number.MAX_SAFE_INTEGER) - (originalOrder.get(right.label) ?? Number.MAX_SAFE_INTEGER);
                });
                for (const successor of successors) {
                    visit(successor.label);
                }
                return;
            }
        }
    };

    visit(body.entryLabel);
    while (ordered.length < body.blocks.length) {
        const nextBlock = body.blocks
            .filter((block) => !visited.has(block.label))
            .sort((left, right) => {
                const leftVisitedPreds = left.predecessors.filter((label) => visited.has(label)).length;
                const rightVisitedPreds = right.predecessors.filter((label) => visited.has(label)).length;
                if (leftVisitedPreds !== rightVisitedPreds) {
                    return rightVisitedPreds - leftVisitedPreds;
                }
                return (originalOrder.get(left.label) ?? Number.MAX_SAFE_INTEGER) - (originalOrder.get(right.label) ?? Number.MAX_SAFE_INTEGER);
            })[0];
        if (!nextBlock) {
            break;
        }
        visit(nextBlock.label);
    }

    return {
        ...body,
        blocks: ordered
    };
}

function layoutFunction(fn: X64Round2BranchOptimizedFunctionDefinition): X64Round2LaidOutFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: layoutBody(fn.body),
        origin: fn.origin
    };
}

export function round2LayoutX64Pass(program: X64Round2BranchOptimizedProgram): X64Round2LaidOutProgram {
    return {
        kind: "x64_round_2_laid_out_program",
        entry: layoutBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(layoutFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}