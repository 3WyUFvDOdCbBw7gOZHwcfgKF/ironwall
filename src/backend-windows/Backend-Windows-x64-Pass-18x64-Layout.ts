import type {
    X64BranchOptimizedProgram,
    X64FrameLayoutBody,
    X64FrameLayoutFunctionDefinition,
    X64RegAllocatedBlock,
    X64LaidOutFunctionDefinition,
    X64LaidOutProgram
} from "./Backend-Windows-IR-Shared";

function layoutBody(body: X64FrameLayoutBody): X64FrameLayoutBody {
    const blocksByLabel = new Map(body.blocks.map((block) => [block.label, block]));
    const ordered: X64RegAllocatedBlock[] = [];
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
            case "jcc":
                visit(block.terminator.falseTarget);
                visit(block.terminator.trueTarget);
                return;
        }
    };

    visit(body.entryLabel);
    for (const block of body.blocks) {
        visit(block.label);
    }

    return {
        ...body,
        blocks: ordered
    };
}

function layoutFunction(fn: X64FrameLayoutFunctionDefinition): X64LaidOutFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: layoutBody(fn.body),
        origin: fn.origin
    };
}

export function layoutX64Pass(program: X64BranchOptimizedProgram): X64LaidOutProgram {
    return {
        kind: "x64_laid_out_program",
        entry: layoutBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(layoutFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
