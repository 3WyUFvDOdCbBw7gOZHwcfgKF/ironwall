import type {
    X64BranchOptimizedFunctionDefinition,
    X64BranchOptimizedProgram,
    X64FrameLayoutBody,
    X64FrameLayoutFunctionDefinition,
    X64PostRAPeepholeProgram
} from "./Backend-Linux-IR-Shared";

function isTrampolineBlock(block: X64FrameLayoutBody["blocks"][number], entryLabel: string): boolean {
    return block.label !== entryLabel
        && block.params.length === 0
        && block.instructions.length === 0
        && block.terminator.kind === "jmp"
        && block.terminator.args.length === 0;
}

function buildRedirectMap(body: X64FrameLayoutBody): ReadonlyMap<string, string> {
    const redirects = new Map<string, string>();
    for (const block of body.blocks) {
        if (isTrampolineBlock(block, body.entryLabel)) {
            redirects.set(block.label, block.terminator.kind === "jmp" ? block.terminator.target : block.label);
        }
    }
    const resolve = (label: string): string => {
        let current = label;
        const seen = new Set<string>();
        while (redirects.has(current) && !seen.has(current)) {
            seen.add(current);
            current = redirects.get(current)!;
        }
        return current;
    };
    return new Map([...redirects.keys()].map((label) => [label, resolve(label)]));
}

function optimizeBody(body: X64FrameLayoutBody): X64FrameLayoutBody {
    const redirects = buildRedirectMap(body);
    const keptBlocks = body.blocks.filter((block) => !redirects.has(block.label));
    const rewrittenBlocks = keptBlocks.map((block) => {
        const terminator = block.terminator.kind === "jmp"
            ? {
                kind: "jmp" as const,
                target: redirects.get(block.terminator.target) ?? block.terminator.target,
                args: block.terminator.args
            }
            : block.terminator.kind === "jcc"
                ? {
                    kind: "jcc" as const,
                    condition: block.terminator.condition,
                    trueTarget: redirects.get(block.terminator.trueTarget) ?? block.terminator.trueTarget,
                    trueArgs: block.terminator.trueArgs,
                    falseTarget: redirects.get(block.terminator.falseTarget) ?? block.terminator.falseTarget,
                    falseArgs: block.terminator.falseArgs
                }
                : block.terminator;
        const simplifiedTerminator = terminator.kind === "jcc"
            && terminator.trueTarget === terminator.falseTarget
            && terminator.trueArgs.length === terminator.falseArgs.length
            && terminator.trueArgs.every((arg, index) => JSON.stringify(arg) === JSON.stringify(terminator.falseArgs[index]))
            ? {
                kind: "jmp" as const,
                target: terminator.trueTarget,
                args: terminator.trueArgs
            }
            : terminator;
        return {
            ...block,
            predecessors: block.predecessors
                .map((predecessor) => redirects.get(predecessor) ?? predecessor)
                .filter((predecessor, index, all) => all.indexOf(predecessor) === index),
            terminator: simplifiedTerminator
        };
    });
    return {
        ...body,
        blocks: rewrittenBlocks
    };
}

function optimizeFunction(fn: X64FrameLayoutFunctionDefinition): X64BranchOptimizedFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: optimizeBody(fn.body),
        origin: fn.origin
    };
}

export function branchOptimizeX64Pass(program: X64PostRAPeepholeProgram): X64BranchOptimizedProgram {
    return {
        kind: "x64_branch_optimized_program",
        entry: optimizeBody(program.entry),
        globals: program.globals,
        functions: program.functions.map(optimizeFunction),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
