// No-opt lowering pass 4 core desugaring.
import type {
    DesugaredCoreProgram,
    LiftedLoweringProgram,
    LoweredExpr,
    LoweredFunctionDefinition
} from "./Lowering-Frontend-Shared";

function buildSeq(expressions: readonly LoweredExpr[]): LoweredExpr {
    if (expressions.length === 1) {
        return expressions[0];
    }
    return {
        kind: "seq",
        expressions
    };
}

function lowerStatementList(expressions: readonly LoweredExpr[]): readonly LoweredExpr[] {
    if (expressions.length === 0) {
        return [];
    }
    const [head, ...tail] = expressions;
    if (head.kind === "dvar") {
        const tailStatements = lowerStatementList(tail);
        const body = tailStatements.length === 0 ? { kind: "identifier", name: head.bind.name } as LoweredExpr : buildSeq(tailStatements);
        return [{
            kind: "let",
            bindings: [{
                bind: head.bind,
                value: desugarNoOptimizeCoreExpr(head.value)
            }],
            body
        }];
    }
    return [desugarNoOptimizeCoreExpr(head), ...lowerStatementList(tail)];
}

function desugarCondToIf(expr: Extract<LoweredExpr, { readonly kind: "cond" }>): LoweredExpr {
    if (expr.clauses.length === 0) {
        throw new Error("Pass 4 desugaring failed: cond requires at least one clause");
    }
    if (expr.clauses.length === 1) {
        const clause = expr.clauses[0];
        if (clause.cond.kind !== "identifier" || clause.cond.name !== "else") {
            throw new Error("Pass 4 desugaring failed: final cond clause must be an explicit else guard");
        }
        return desugarNoOptimizeCoreExpr(clause.body);
    }
    const [head, ...tail] = expr.clauses;
    return {
        kind: "if",
        condExpr: desugarNoOptimizeCoreExpr(head.cond),
        trueBranchExpr: desugarNoOptimizeCoreExpr(head.body),
        falseBranchExpr: desugarCondToIf({ kind: "cond", clauses: tail })
    };
}

    export function desugarNoOptimizeCoreExpr(expr: LoweredExpr): LoweredExpr {
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
                body: desugarNoOptimizeCoreExpr(expr.body)
            };
        case "let":
            return {
                ...expr,
                bindings: expr.bindings.map((binding) => ({
                    ...binding,
                    value: desugarNoOptimizeCoreExpr(binding.value)
                })),
                body: desugarNoOptimizeCoreExpr(expr.body)
            };
        case "if":
            return {
                ...expr,
                condExpr: desugarNoOptimizeCoreExpr(expr.condExpr),
                trueBranchExpr: desugarNoOptimizeCoreExpr(expr.trueBranchExpr),
                falseBranchExpr: desugarNoOptimizeCoreExpr(expr.falseBranchExpr)
            };
        case "while":
            return {
                ...expr,
                condExpr: desugarNoOptimizeCoreExpr(expr.condExpr),
                bodyExpr: desugarNoOptimizeCoreExpr(expr.bodyExpr)
            };
        case "cond":
            return desugarCondToIf(expr);
        case "dvar":
            return {
                kind: "let",
                bindings: [{
                    bind: expr.bind,
                    value: desugarNoOptimizeCoreExpr(expr.value)
                }],
                body: {
                    kind: "identifier",
                    name: expr.bind.name
                }
            };
        case "seq": {
            const statements = lowerStatementList(expr.expressions);
            return statements.length === 0 ? { kind: "identifier", name: "false" } : buildSeq(statements);
        }
        case "set_local":
            return {
                ...expr,
                value: desugarNoOptimizeCoreExpr(expr.value)
            };
        case "call":
            return {
                ...expr,
                callee: desugarNoOptimizeCoreExpr(expr.callee),
                args: expr.args.map((arg) => desugarNoOptimizeCoreExpr(arg))
            };
        case "direct_call":
            return {
                ...expr,
                args: expr.args.map((arg) => desugarNoOptimizeCoreExpr(arg))
            };
        case "object_get_field":
            return {
                ...expr,
                receiver: desugarNoOptimizeCoreExpr(expr.receiver)
            };
        case "object_set_field":
            return {
                ...expr,
                receiver: desugarNoOptimizeCoreExpr(expr.receiver),
                value: desugarNoOptimizeCoreExpr(expr.value)
            };
        case "method_closure_create":
            return {
                ...expr,
                receiver: desugarNoOptimizeCoreExpr(expr.receiver)
            };
        case "union_inject":
            return {
                ...expr,
                value: desugarNoOptimizeCoreExpr(expr.value)
            };
        case "match":
            return {
                ...expr,
                unionExpr: desugarNoOptimizeCoreExpr(expr.unionExpr),
                branches: expr.branches.map((branch) => ({
                    ...branch,
                    body: desugarNoOptimizeCoreExpr(branch.body)
                }))
            };
    }
}

function validateCoreExpr(expr: LoweredExpr): void {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return;
        case "fn":
            validateCoreExpr(expr.body);
            return;
        case "let":
            expr.bindings.forEach((binding) => validateCoreExpr(binding.value));
            validateCoreExpr(expr.body);
            return;
        case "if":
            validateCoreExpr(expr.condExpr);
            validateCoreExpr(expr.trueBranchExpr);
            validateCoreExpr(expr.falseBranchExpr);
            return;
        case "while":
            validateCoreExpr(expr.condExpr);
            validateCoreExpr(expr.bodyExpr);
            return;
        case "seq":
            expr.expressions.forEach((inner) => validateCoreExpr(inner));
            return;
        case "set_local":
            validateCoreExpr(expr.value);
            return;
        case "call":
            validateCoreExpr(expr.callee);
            expr.args.forEach((arg) => validateCoreExpr(arg));
            return;
        case "direct_call":
            expr.args.forEach((arg) => validateCoreExpr(arg));
            return;
        case "object_get_field":
            validateCoreExpr(expr.receiver);
            return;
        case "object_set_field":
            validateCoreExpr(expr.receiver);
            validateCoreExpr(expr.value);
            return;
        case "method_closure_create":
            validateCoreExpr(expr.receiver);
            return;
        case "union_inject":
            validateCoreExpr(expr.value);
            return;
        case "match":
            validateCoreExpr(expr.unionExpr);
            expr.branches.forEach((branch) => validateCoreExpr(branch.body));
            return;
        case "cond":
        case "dvar":
            throw new Error(`Pass 4 desugaring validation failed: unexpected residual node kind '${expr.kind}'`);
    }
}

export function validateNoOptimizeDesugaredCoreProgram(program: DesugaredCoreProgram): void {
    for (const statement of program.topLevelStatements) {
        validateCoreExpr(statement);
    }
    for (const fn of program.functions) {
        validateCoreExpr(fn.body);
    }
}

export function desugarNoOptimizeCorePass(program: LiftedLoweringProgram): DesugaredCoreProgram {
    const desugared: DesugaredCoreProgram = {
        kind: "desugared_core_program",
        topLevelStatements: lowerStatementList(program.topLevelStatements),
        globals: program.globals,
        functions: program.functions.map((fn): LoweredFunctionDefinition => ({
            ...fn,
            body: desugarNoOptimizeCoreExpr(fn.body)
        })),
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        metadata: program.metadata
    };
    validateNoOptimizeDesugaredCoreProgram(desugared);
    return desugared;
}
