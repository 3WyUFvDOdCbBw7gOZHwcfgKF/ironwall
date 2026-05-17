import type {
    ClosureConvertedFunctionDefinition,
    ClosureExpr,
    FoldedTypedPrimitiveProgram,
    FoldedTypedPrimitiveProgramStats,
    TypedSlotProgram
} from "./Lowering-Frontend-Shared";

interface FoldState {
    forwardedSlotLoads: number;
    foldedInjectedMatches: number;
}

interface SlotStoreFact {
    readonly receiverName: string;
    readonly className: string;
    readonly slotName: string;
    readonly value: ClosureExpr;
}

function getIdentifierName(expr: ClosureExpr): string | undefined {
    return expr.kind === "identifier" ? expr.name : undefined;
}

function getSlotStoreFact(expr: ClosureExpr): SlotStoreFact | undefined {
    if (expr.kind !== "slot_store") {
        return undefined;
    }
    const receiverName = getIdentifierName(expr.receiver);
    if (receiverName === undefined) {
        return undefined;
    }
    return {
        receiverName,
        className: expr.className,
        slotName: expr.slotName,
        value: expr.value
    };
}

function tryForwardSlotLoad(expr: ClosureExpr, lastStore: SlotStoreFact | undefined, state: FoldState): ClosureExpr {
    if (expr.kind !== "slot_load" || lastStore === undefined) {
        return expr;
    }
    const receiverName = getIdentifierName(expr.receiver);
    if (receiverName !== lastStore.receiverName || expr.className !== lastStore.className || expr.slotName !== lastStore.slotName) {
        return expr;
    }
    state.forwardedSlotLoads += 1;
    return lastStore.value;
}

function rewriteSeq(expr: Extract<ClosureExpr, { kind: "seq" }>, state: FoldState): ClosureExpr {
    const expressions: ClosureExpr[] = [];
    let lastStore: SlotStoreFact | undefined;
    for (const inner of expr.expressions) {
        const rewritten = rewriteExpr(inner, state);
        const forwarded = tryForwardSlotLoad(rewritten, lastStore, state);
        expressions.push(forwarded);
        if (rewritten.kind === "slot_load") {
            continue;
        }
        lastStore = getSlotStoreFact(rewritten);
    }
    return {
        kind: "seq",
        expressions
    };
}

function rewriteExpr(expr: ClosureExpr, state: FoldState): ClosureExpr {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
        case "object_get_field":
        case "object_set_field":
            return expr;
        case "let":
            return rewriteLet(expr, state);
        case "if":
            return {
                kind: "if",
                condExpr: rewriteExpr(expr.condExpr, state),
                trueBranchExpr: rewriteExpr(expr.trueBranchExpr, state),
                falseBranchExpr: rewriteExpr(expr.falseBranchExpr, state)
            };
        case "while":
            return {
                kind: "while",
                condExpr: rewriteExpr(expr.condExpr, state),
                bodyExpr: rewriteExpr(expr.bodyExpr, state)
            };
        case "seq":
            return rewriteSeq(expr, state);
        case "set_local":
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value: rewriteExpr(expr.value, state)
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => rewriteExpr(arg, state))
            };
        case "slot_load":
            return {
                kind: "slot_load",
                receiver: rewriteExpr(expr.receiver, state),
                className: expr.className,
                slotName: expr.slotName
            };
        case "slot_store":
            return {
                kind: "slot_store",
                receiver: rewriteExpr(expr.receiver, state),
                className: expr.className,
                slotName: expr.slotName,
                value: rewriteExpr(expr.value, state)
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: rewriteExpr(expr.value, state)
            };
        case "closure_create":
            return {
                kind: "closure_create",
                closureId: expr.closureId,
                applySymbol: expr.applySymbol,
                environmentLayout: expr.environmentLayout,
                captures: expr.captures.map((capture) => rewriteExpr(capture, state))
            };
        case "closure_call":
            return {
                kind: "closure_call",
                callee: rewriteExpr(expr.callee, state),
                args: expr.args.map((arg) => rewriteExpr(arg, state))
            };
        case "match":
            return rewriteMatch(expr, state);
    }
}

function tryFoldKnownInjectedMatch(unionExpr: ClosureExpr, matchExpr: Extract<ClosureExpr, { kind: "match" }>, state: FoldState): ClosureExpr | undefined {
    if (unionExpr.kind !== "union_inject") {
        return undefined;
    }
    const matchingBranch = matchExpr.branches.find((branch) => branch.memberTypeTagId === unionExpr.memberTypeTagId);
    if (!matchingBranch) {
        return undefined;
    }
    state.foldedInjectedMatches += 1;
    return {
        kind: "let",
        bindings: [{
            bind: matchingBranch.bind,
            value: unionExpr.value
        }],
        body: matchingBranch.body
    };
}

function rewriteLet(expr: Extract<ClosureExpr, { kind: "let" }>, state: FoldState): ClosureExpr {
    const bindings = expr.bindings.map((binding) => ({
        bind: binding.bind,
        value: rewriteExpr(binding.value, state)
    }));
    const body = rewriteExpr(expr.body, state);
    if (bindings.length === 1 && body.kind === "match" && body.unionExpr.kind === "identifier" && body.unionExpr.name === bindings[0].bind.name) {
        const folded = tryFoldKnownInjectedMatch(bindings[0].value, body, state);
        if (folded) {
            return folded;
        }
    }
    return {
        kind: "let",
        bindings,
        body
    };
}

function rewriteMatch(expr: Extract<ClosureExpr, { kind: "match" }>, state: FoldState): ClosureExpr {
    const unionExpr = rewriteExpr(expr.unionExpr, state);
    const branches = expr.branches.map((branch) => ({
        bind: branch.bind,
        memberTypeTagId: branch.memberTypeTagId,
        body: rewriteExpr(branch.body, state)
    }));
    const folded = tryFoldKnownInjectedMatch(unionExpr, { ...expr, branches }, state);
    if (folded) {
        return folded;
    }
    return {
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr,
                branches
            };
}

export function foldTypedPrimitivesPass(program: TypedSlotProgram): FoldedTypedPrimitiveProgram {
    const state: FoldState = { forwardedSlotLoads: 0, foldedInjectedMatches: 0 };
    const functions: ClosureConvertedFunctionDefinition[] = program.functions.map((fn) => ({
        ...fn,
        body: rewriteExpr(fn.body, state)
    }));
    const stats: FoldedTypedPrimitiveProgramStats = {
        forwardedSlotLoads: state.forwardedSlotLoads,
        foldedInjectedMatches: state.foldedInjectedMatches
    };
    return {
        kind: "folded_typed_primitive_program",
        topLevelStatements: program.topLevelStatements.map((statement) => rewriteExpr(statement, state)),
        globals: program.globals,
        functions,
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata,
        stats
    };
}