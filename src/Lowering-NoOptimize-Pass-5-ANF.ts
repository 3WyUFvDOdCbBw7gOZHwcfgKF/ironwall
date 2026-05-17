// No-opt lowering pass 5 ANF conversion.
import { IdentifierNode } from "./AstNode";
import type {
    AnfProgram,
    DesugaredCoreProgram,
    LoweredBinding,
    LoweredExpr,
    LoweredFunctionDefinition
} from "./Lowering-Frontend-Shared";

const ANF_TEMP_TYPE = new IdentifierNode("__iw_anf_tmp");

interface AnfContext {
    tempCounter: number;
}

function nextTempName(context: AnfContext): string {
    const current = context.tempCounter;
    context.tempCounter += 1;
    return `__iw_anf_${current}`;
}

function isAtomicExpr(expr: LoweredExpr): boolean {
    return expr.kind === "identifier"
        || expr.kind === "number_literal"
        || expr.kind === "direct_function_ref"
        || expr.kind === "fn";
}

function bindAtomic(expr: LoweredExpr, context: AnfContext, cont: (atomicExpr: LoweredExpr) => LoweredExpr): LoweredExpr {
    const normalized = noOptimizeAnfExpr(expr, context);
    if (isAtomicExpr(normalized)) {
        return cont(normalized);
    }
    const tempName = nextTempName(context);
    const binding: LoweredBinding = {
        name: tempName,
        typeExp: ANF_TEMP_TYPE
    };
    return {
        kind: "let",
        bindings: [{ bind: binding, value: normalized }],
        body: cont({ kind: "identifier", name: tempName })
    };
}

function bindAtomicList(expressions: readonly LoweredExpr[], context: AnfContext, cont: (atomicExprs: readonly LoweredExpr[]) => LoweredExpr): LoweredExpr {
    if (expressions.length === 0) {
        return cont([]);
    }
    const [head, ...tail] = expressions;
    return bindAtomic(head, context, (atomicHead) => bindAtomicList(tail, context, (atomicTail) => cont([atomicHead, ...atomicTail])));
}

export function noOptimizeAnfExpr(expr: LoweredExpr, context: AnfContext): LoweredExpr {
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
                body: noOptimizeAnfExpr(expr.body, context)
            };
        case "let":
            return {
                ...expr,
                bindings: expr.bindings.map((binding) => ({
                    ...binding,
                    value: noOptimizeAnfExpr(binding.value, context)
                })),
                body: noOptimizeAnfExpr(expr.body, context)
            };
        case "if":
            return bindAtomic(expr.condExpr, context, (atomicCond) => ({
                kind: "if",
                condExpr: atomicCond,
                trueBranchExpr: noOptimizeAnfExpr(expr.trueBranchExpr, context),
                falseBranchExpr: noOptimizeAnfExpr(expr.falseBranchExpr, context)
            }));
        case "while":
            return {
                kind: "while",
                condExpr: noOptimizeAnfExpr(expr.condExpr, context),
                bodyExpr: noOptimizeAnfExpr(expr.bodyExpr, context)
            };
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => noOptimizeAnfExpr(inner, context))
            };
        case "set_local":
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value: noOptimizeAnfExpr(expr.value, context)
            };
        case "call":
            return bindAtomic(expr.callee, context, (atomicCallee) => bindAtomicList(expr.args, context, (atomicArgs) => ({
                kind: "call",
                callee: atomicCallee,
                args: atomicArgs
            })));
        case "direct_call":
            return bindAtomicList(expr.args, context, (atomicArgs) => ({
                kind: "direct_call",
                symbol: expr.symbol,
                args: atomicArgs
            }));
        case "object_get_field":
            return bindAtomic(expr.receiver, context, (atomicReceiver) => ({
                kind: "object_get_field",
                receiver: atomicReceiver,
                className: expr.className,
                fieldName: expr.fieldName
            }));
        case "object_set_field":
            return bindAtomic(expr.receiver, context, (atomicReceiver) => bindAtomic(expr.value, context, (atomicValue) => ({
                kind: "object_set_field",
                receiver: atomicReceiver,
                className: expr.className,
                fieldName: expr.fieldName,
                value: atomicValue
            })));
        case "method_closure_create":
            return bindAtomic(expr.receiver, context, (atomicReceiver) => ({
                kind: "method_closure_create",
                receiver: atomicReceiver,
                className: expr.className,
                methodName: expr.methodName,
                methodSymbol: expr.methodSymbol
            }));
        case "union_inject":
            return bindAtomic(expr.value, context, (atomicValue) => ({
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: atomicValue
            }));
        case "match":
            return bindAtomic(expr.unionExpr, context, (atomicUnionExpr) => ({
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr: atomicUnionExpr,
                branches: expr.branches.map((branch) => ({
                    ...branch,
                    body: noOptimizeAnfExpr(branch.body, context)
                }))
            }));
        case "cond":
        case "dvar":
            throw new Error(`Pass 5 ANF failed: unexpected pre-desugaring node kind '${expr.kind}'`);
    }
}

function validateAnfExpr(expr: LoweredExpr): void {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return;
        case "fn":
            validateAnfExpr(expr.body);
            return;
        case "let":
            expr.bindings.forEach((binding) => validateAnfExpr(binding.value));
            validateAnfExpr(expr.body);
            return;
        case "if":
            if (!isAtomicExpr(expr.condExpr)) {
                throw new Error("Pass 5 ANF validation failed: if condition must be atomic");
            }
            validateAnfExpr(expr.trueBranchExpr);
            validateAnfExpr(expr.falseBranchExpr);
            return;
        case "while":
            validateAnfExpr(expr.condExpr);
            validateAnfExpr(expr.bodyExpr);
            return;
        case "seq":
            expr.expressions.forEach((inner) => validateAnfExpr(inner));
            return;
        case "set_local":
            validateAnfExpr(expr.value);
            return;
        case "call":
            if (!isAtomicExpr(expr.callee)) {
                throw new Error("Pass 5 ANF validation failed: call callee must be atomic");
            }
            expr.args.forEach((arg) => {
                if (!isAtomicExpr(arg)) {
                    throw new Error("Pass 5 ANF validation failed: call arguments must be atomic");
                }
            });
            return;
        case "direct_call":
            expr.args.forEach((arg) => {
                if (!isAtomicExpr(arg)) {
                    throw new Error("Pass 5 ANF validation failed: direct_call arguments must be atomic");
                }
            });
            return;
        case "object_get_field":
            if (!isAtomicExpr(expr.receiver)) {
                throw new Error("Pass 5 ANF validation failed: object_get_field receiver must be atomic");
            }
            return;
        case "object_set_field":
            if (!isAtomicExpr(expr.receiver)) {
                throw new Error("Pass 5 ANF validation failed: object_set_field receiver must be atomic");
            }
            if (!isAtomicExpr(expr.value)) {
                throw new Error("Pass 5 ANF validation failed: object_set_field value must be atomic");
            }
            return;
        case "method_closure_create":
            if (!isAtomicExpr(expr.receiver)) {
                throw new Error("Pass 5 ANF validation failed: method_closure_create receiver must be atomic");
            }
            return;
        case "union_inject":
            if (!isAtomicExpr(expr.value)) {
                throw new Error("Pass 5 ANF validation failed: union_inject value must be atomic");
            }
            return;
        case "match":
            if (!isAtomicExpr(expr.unionExpr)) {
                throw new Error("Pass 5 ANF validation failed: match union expression must be atomic");
            }
            expr.branches.forEach((branch) => validateAnfExpr(branch.body));
            return;
        case "cond":
        case "dvar":
            throw new Error(`Pass 5 ANF validation failed: unexpected node kind '${expr.kind}'`);
    }
}

export function validateNoOptimizeAnfProgram(program: AnfProgram): void {
    for (const statement of program.topLevelStatements) {
        validateAnfExpr(statement);
    }
    for (const fn of program.functions) {
        validateAnfExpr(fn.body);
    }
}

export function noOptimizeAnfPass(program: DesugaredCoreProgram): AnfProgram {
    const context: AnfContext = { tempCounter: 0 };
    const anfProgram: AnfProgram = {
        kind: "anf_program",
        topLevelStatements: program.topLevelStatements.map((statement) => noOptimizeAnfExpr(statement, context)),
        globals: program.globals,
        functions: program.functions.map((fn): LoweredFunctionDefinition => ({
            ...fn,
            body: noOptimizeAnfExpr(fn.body, context)
        })),
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        metadata: program.metadata
    };
    validateNoOptimizeAnfProgram(anfProgram);
    return anfProgram;
}

export function isNoOptimizeAnfAtomicExpr(expr: LoweredExpr): boolean {
    return isAtomicExpr(expr);
}
