import type {
    KnownCallProgram,
    LoweredExpr,
    LoweredFunctionDefinition,
    TinyInlineStats,
    TinyInlinedProgram
} from "./Lowering-Frontend-Shared";
import { validateAnfProgram } from "./Lowering-Pass-5-ANF";

const MAX_INLINE_BODY_SIZE = 40;

type MutableTinyInlineStats = {
    -readonly [K in keyof TinyInlineStats]: TinyInlineStats[K];
};

interface InlineCandidate {
    readonly fn: LoweredFunctionDefinition;
}

interface RewriteState {
    freshCounter: number;
    readonly stats: MutableTinyInlineStats;
}

function createInitialStats(): MutableTinyInlineStats {
    return {
        inlinedCalls: 0,
        skippedRecursiveCalls: 0
    };
}

function nextFreshName(state: RewriteState, baseName: string): string {
    const current = state.freshCounter;
    state.freshCounter += 1;
    return `__iw_inline_${baseName}_${current}`;
}

function exprSize(expr: LoweredExpr): number {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return 1;
        case "fn":
            return 1 + exprSize(expr.body);
        case "let":
            return 1 + expr.bindings.reduce((sum, binding) => sum + exprSize(binding.value), 0) + exprSize(expr.body);
        case "if":
            return 1 + exprSize(expr.condExpr) + exprSize(expr.trueBranchExpr) + exprSize(expr.falseBranchExpr);
        case "while":
            return 1 + exprSize(expr.condExpr) + exprSize(expr.bodyExpr);
        case "seq":
            return 1 + expr.expressions.reduce((sum, inner) => sum + exprSize(inner), 0);
        case "set_local":
            return 1 + exprSize(expr.value);
        case "call":
            return 1 + exprSize(expr.callee) + expr.args.reduce((sum, arg) => sum + exprSize(arg), 0);
        case "direct_call":
            return 1 + expr.args.reduce((sum, arg) => sum + exprSize(arg), 0);
        case "object_get_field":
            return 1 + exprSize(expr.receiver);
        case "object_set_field":
            return 1 + exprSize(expr.receiver) + exprSize(expr.value);
        case "method_closure_create":
            return 1 + exprSize(expr.receiver);
        case "union_inject":
            return 1 + exprSize(expr.value);
        case "match":
            return 1 + exprSize(expr.unionExpr) + expr.branches.reduce((sum, branch) => sum + exprSize(branch.body), 0);
        case "cond":
        case "dvar":
            return 1;
    }
}

function hasDisallowedInlineNode(expr: LoweredExpr): boolean {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
        case "object_get_field":
            return false;
        case "let":
            return expr.bindings.some((binding) => hasDisallowedInlineNode(binding.value)) || hasDisallowedInlineNode(expr.body);
        case "if":
            return hasDisallowedInlineNode(expr.condExpr)
                || hasDisallowedInlineNode(expr.trueBranchExpr)
                || hasDisallowedInlineNode(expr.falseBranchExpr);
        case "seq":
            return expr.expressions.some((inner) => hasDisallowedInlineNode(inner));
        case "direct_call":
            return expr.symbol.includes("_clang_") || expr.args.some((arg) => hasDisallowedInlineNode(arg));
        case "union_inject":
            return hasDisallowedInlineNode(expr.value);
        case "fn":
        case "while":
        case "set_local":
        case "call":
        case "object_set_field":
        case "method_closure_create":
        case "match":
        case "cond":
        case "dvar":
            return true;
    }
}

function containsDirectSelfCall(expr: LoweredExpr, symbol: string): boolean {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return false;
        case "fn":
            return containsDirectSelfCall(expr.body, symbol);
        case "let":
            return expr.bindings.some((binding) => containsDirectSelfCall(binding.value, symbol)) || containsDirectSelfCall(expr.body, symbol);
        case "if":
            return containsDirectSelfCall(expr.condExpr, symbol)
                || containsDirectSelfCall(expr.trueBranchExpr, symbol)
                || containsDirectSelfCall(expr.falseBranchExpr, symbol);
        case "while":
            return containsDirectSelfCall(expr.condExpr, symbol) || containsDirectSelfCall(expr.bodyExpr, symbol);
        case "seq":
            return expr.expressions.some((inner) => containsDirectSelfCall(inner, symbol));
        case "set_local":
            return containsDirectSelfCall(expr.value, symbol);
        case "call":
            return containsDirectSelfCall(expr.callee, symbol) || expr.args.some((arg) => containsDirectSelfCall(arg, symbol));
        case "direct_call":
            return expr.symbol === symbol || expr.args.some((arg) => containsDirectSelfCall(arg, symbol));
        case "object_get_field":
            return containsDirectSelfCall(expr.receiver, symbol);
        case "object_set_field":
            return containsDirectSelfCall(expr.receiver, symbol) || containsDirectSelfCall(expr.value, symbol);
        case "method_closure_create":
            return containsDirectSelfCall(expr.receiver, symbol);
        case "union_inject":
            return containsDirectSelfCall(expr.value, symbol);
        case "match":
            return containsDirectSelfCall(expr.unionExpr, symbol) || expr.branches.some((branch) => containsDirectSelfCall(branch.body, symbol));
        case "cond":
        case "dvar":
            return false;
    }
}

function buildInlineCandidates(program: KnownCallProgram): ReadonlyMap<string, InlineCandidate> {
    const candidates = new Map<string, InlineCandidate>();
    for (const fn of program.functions) {
        if (fn.origin.kind !== "top_level") {
            continue;
        }
        if (exprSize(fn.body) > MAX_INLINE_BODY_SIZE) {
            continue;
        }
        if (hasDisallowedInlineNode(fn.body)) {
            continue;
        }
        if (containsDirectSelfCall(fn.body, fn.symbol)) {
            continue;
        }
        candidates.set(fn.symbol, { fn });
    }
    return candidates;
}

function substituteExpr(
    expr: LoweredExpr,
    state: RewriteState,
    paramBindings: ReadonlyMap<string, LoweredExpr>,
    renameBindings: ReadonlyMap<string, string>
): LoweredExpr {
    switch (expr.kind) {
        case "identifier": {
            const renamed = renameBindings.get(expr.name);
            if (renamed !== undefined) {
                return { kind: "identifier", name: renamed };
            }
            return paramBindings.get(expr.name) ?? expr;
        }
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "let": {
            const scopedRenames = new Map(renameBindings);
            const bindings = expr.bindings.map((binding) => {
                const value = substituteExpr(binding.value, state, paramBindings, scopedRenames);
                const freshName = nextFreshName(state, binding.bind.name);
                scopedRenames.set(binding.bind.name, freshName);
                return {
                    bind: {
                        ...binding.bind,
                        name: freshName
                    },
                    value
                };
            });
            return {
                kind: "let",
                bindings,
                body: substituteExpr(expr.body, state, paramBindings, scopedRenames)
            };
        }
        case "if":
            return {
                kind: "if",
                condExpr: substituteExpr(expr.condExpr, state, paramBindings, renameBindings),
                trueBranchExpr: substituteExpr(expr.trueBranchExpr, state, paramBindings, renameBindings),
                falseBranchExpr: substituteExpr(expr.falseBranchExpr, state, paramBindings, renameBindings)
            };
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => substituteExpr(inner, state, paramBindings, renameBindings))
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => substituteExpr(arg, state, paramBindings, renameBindings))
            };
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: substituteExpr(expr.receiver, state, paramBindings, renameBindings),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: substituteExpr(expr.value, state, paramBindings, renameBindings)
            };
        case "fn":
        case "while":
        case "set_local":
        case "call":
        case "object_set_field":
        case "method_closure_create":
        case "match":
        case "cond":
        case "dvar":
            throw new Error(`Pass 5e tiny inline encountered unsupported inline body node '${expr.kind}'`);
    }
}

function inlineDirectCall(
    expr: Extract<LoweredExpr, { readonly kind: "direct_call" }>,
    candidate: InlineCandidate,
    state: RewriteState
): LoweredExpr {
    const paramBindings = new Map<string, LoweredExpr>();
    for (let index = 0; index < candidate.fn.params.length; index += 1) {
        paramBindings.set(candidate.fn.params[index].name, expr.args[index]);
    }
    return substituteExpr(candidate.fn.body, state, paramBindings, new Map());
}

function rewriteExpr(
    expr: LoweredExpr,
    candidates: ReadonlyMap<string, InlineCandidate>,
    state: RewriteState,
    inlineStack: readonly string[]
): LoweredExpr {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "fn":
            return {
                ...expr,
                body: rewriteExpr(expr.body, candidates, state, inlineStack)
            };
        case "let":
            return {
                kind: "let",
                bindings: expr.bindings.map((binding) => ({
                    bind: binding.bind,
                    value: rewriteExpr(binding.value, candidates, state, inlineStack)
                })),
                body: rewriteExpr(expr.body, candidates, state, inlineStack)
            };
        case "if":
            return {
                kind: "if",
                condExpr: rewriteExpr(expr.condExpr, candidates, state, inlineStack),
                trueBranchExpr: rewriteExpr(expr.trueBranchExpr, candidates, state, inlineStack),
                falseBranchExpr: rewriteExpr(expr.falseBranchExpr, candidates, state, inlineStack)
            };
        case "while":
            return {
                kind: "while",
                condExpr: rewriteExpr(expr.condExpr, candidates, state, inlineStack),
                bodyExpr: rewriteExpr(expr.bodyExpr, candidates, state, inlineStack)
            };
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => rewriteExpr(inner, candidates, state, inlineStack))
            };
        case "set_local":
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value: rewriteExpr(expr.value, candidates, state, inlineStack)
            };
        case "call":
            return {
                kind: "call",
                callee: rewriteExpr(expr.callee, candidates, state, inlineStack),
                args: expr.args.map((arg) => rewriteExpr(arg, candidates, state, inlineStack))
            };
        case "direct_call": {
            const rewrittenArgs = expr.args.map((arg) => rewriteExpr(arg, candidates, state, inlineStack));
            const candidate = candidates.get(expr.symbol);
            if (!candidate) {
                return {
                    kind: "direct_call",
                    symbol: expr.symbol,
                    args: rewrittenArgs
                };
            }
            if (inlineStack.includes(expr.symbol)) {
                state.stats.skippedRecursiveCalls += 1;
                return {
                    kind: "direct_call",
                    symbol: expr.symbol,
                    args: rewrittenArgs
                };
            }
            state.stats.inlinedCalls += 1;
            return rewriteExpr(
                inlineDirectCall({ kind: "direct_call", symbol: expr.symbol, args: rewrittenArgs }, candidate, state),
                candidates,
                state,
                [...inlineStack, expr.symbol]
            );
        }
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: rewriteExpr(expr.receiver, candidates, state, inlineStack),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "object_set_field":
            return {
                kind: "object_set_field",
                receiver: rewriteExpr(expr.receiver, candidates, state, inlineStack),
                className: expr.className,
                fieldName: expr.fieldName,
                value: rewriteExpr(expr.value, candidates, state, inlineStack)
            };
        case "method_closure_create":
            return {
                kind: "method_closure_create",
                receiver: rewriteExpr(expr.receiver, candidates, state, inlineStack),
                className: expr.className,
                methodName: expr.methodName,
                methodSymbol: expr.methodSymbol
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: rewriteExpr(expr.value, candidates, state, inlineStack)
            };
        case "match":
            return {
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr: rewriteExpr(expr.unionExpr, candidates, state, inlineStack),
                branches: expr.branches.map((branch) => ({
                    bind: branch.bind,
                    memberTypeTagId: branch.memberTypeTagId,
                    body: rewriteExpr(branch.body, candidates, state, inlineStack)
                }))
            };
        case "cond":
        case "dvar":
            throw new Error(`Pass 5e tiny inline failed: unexpected node kind '${expr.kind}'`);
    }
}

export function inlineTinyDirectPass(program: KnownCallProgram): TinyInlinedProgram {
    const candidates = buildInlineCandidates(program);
    const state: RewriteState = {
        freshCounter: 0,
        stats: createInitialStats()
    };
    const inlined: TinyInlinedProgram = {
        kind: "tiny_inlined_program",
        topLevelStatements: program.topLevelStatements.map((statement) => rewriteExpr(statement, candidates, state, [])),
        globals: program.globals,
        functions: program.functions.map((fn) => ({
            ...fn,
            body: rewriteExpr(fn.body, candidates, state, [fn.symbol])
        })),
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        metadata: program.metadata,
        stats: { ...state.stats }
    };
    validateAnfProgram({
        kind: "anf_program",
        topLevelStatements: inlined.topLevelStatements,
        globals: inlined.globals,
        functions: inlined.functions,
        declaredFunctions: inlined.declaredFunctions,
        layouts: inlined.layouts,
        metadata: inlined.metadata
    });
    return inlined;
}
