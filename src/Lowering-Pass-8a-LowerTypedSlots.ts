import type {
    ClosureConvertedFunctionDefinition,
    ClosureConvertedProgram,
    ClosureExpr,
    TypedSlotProgram
} from "./Lowering-Frontend-Shared";

function rewriteExpr(expr: ClosureExpr): ClosureExpr {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "let":
            return {
                kind: "let",
                bindings: expr.bindings.map((binding) => ({
                    bind: binding.bind,
                    value: rewriteExpr(binding.value)
                })),
                body: rewriteExpr(expr.body)
            };
        case "if":
            return {
                kind: "if",
                condExpr: rewriteExpr(expr.condExpr),
                trueBranchExpr: rewriteExpr(expr.trueBranchExpr),
                falseBranchExpr: rewriteExpr(expr.falseBranchExpr)
            };
        case "while":
            return {
                kind: "while",
                condExpr: rewriteExpr(expr.condExpr),
                bodyExpr: rewriteExpr(expr.bodyExpr)
            };
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => rewriteExpr(inner))
            };
        case "set_local":
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value: rewriteExpr(expr.value)
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => rewriteExpr(arg))
            };
        case "object_get_field":
            return {
                kind: "slot_load",
                receiver: rewriteExpr(expr.receiver),
                className: expr.className,
                slotName: expr.fieldName
            };
        case "object_set_field":
            return {
                kind: "slot_store",
                receiver: rewriteExpr(expr.receiver),
                className: expr.className,
                slotName: expr.fieldName,
                value: rewriteExpr(expr.value)
            };
        case "slot_load":
        case "slot_store":
            return expr;
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: rewriteExpr(expr.value)
            };
        case "closure_create":
            return {
                kind: "closure_create",
                closureId: expr.closureId,
                applySymbol: expr.applySymbol,
                environmentLayout: expr.environmentLayout,
                captures: expr.captures.map((capture) => rewriteExpr(capture))
            };
        case "closure_call":
            return {
                kind: "closure_call",
                callee: rewriteExpr(expr.callee),
                args: expr.args.map((arg) => rewriteExpr(arg))
            };
        case "match":
            return {
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr: rewriteExpr(expr.unionExpr),
                branches: expr.branches.map((branch) => ({
                    bind: branch.bind,
                    memberTypeTagId: branch.memberTypeTagId,
                    body: rewriteExpr(branch.body)
                }))
            };
    }
}

export function lowerTypedSlotsPass(program: ClosureConvertedProgram): TypedSlotProgram {
    const functions: ClosureConvertedFunctionDefinition[] = program.functions.map((fn) => ({
        ...fn,
        body: rewriteExpr(fn.body)
    }));
    return {
        kind: "typed_slot_program",
        topLevelStatements: program.topLevelStatements.map((statement) => rewriteExpr(statement)),
        globals: program.globals,
        functions,
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}