import type {
    AnfProgram,
    LoweredExpr,
    LoweredFunctionDefinition,
    SimplifiedAnfProgram,
    SimplifiedAnfStats
} from "./Lowering-Frontend-Shared";
import { validateAnfProgram } from "./Lowering-Pass-5-ANF";

type MutableSimplifiedAnfStats = {
    -readonly [K in keyof SimplifiedAnfStats]: SimplifiedAnfStats[K];
};

interface SimplifyState {
    stats: MutableSimplifiedAnfStats;
}

function createInitialStats(): MutableSimplifiedAnfStats {
    return {
        foldedConstantIfs: 0,
        removedDeadLets: 0,
        collapsedIdentityLets: 0,
        flattenedSeqs: 0,
        removedRedundantIfs: 0
    };
}

function deepEqualExpr(left: LoweredExpr, right: LoweredExpr): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function getStaticBooleanValue(expr: LoweredExpr): boolean | undefined {
    if (expr.kind === "identifier") {
        if (expr.name === "true") {
            return true;
        }
        if (expr.name === "false") {
            return false;
        }
        return undefined;
    }
    if (expr.kind === "number_literal" && expr.typeName === "i5") {
        if (expr.value === 0) {
            return false;
        }
        if (expr.value === 1) {
            return true;
        }
    }
    return undefined;
}

function isAtomicExpr(expr: LoweredExpr): boolean {
    return expr.kind === "identifier"
        || expr.kind === "number_literal"
        || expr.kind === "text_literal"
        || expr.kind === "direct_function_ref"
        || expr.kind === "fn";
}

function isPureExpr(expr: LoweredExpr): boolean {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
            return true;
        case "fn":
            return false;
        case "let":
            return expr.bindings.every((binding) => isPureExpr(binding.value)) && isPureExpr(expr.body);
        case "if":
            return isPureExpr(expr.condExpr) && isPureExpr(expr.trueBranchExpr) && isPureExpr(expr.falseBranchExpr);
        case "while":
            return false;
        case "seq":
            return expr.expressions.every((inner) => isPureExpr(inner));
        case "call":
        case "direct_call":
        case "dvar":
        case "set_local":
        case "object_alloc":
        case "object_set_field":
        case "method_closure_create":
        case "union_inject":
        case "match":
            return false;
        case "object_get_field":
            return isPureExpr(expr.receiver);
        case "cond":
            return false;
    }
}

function countIdentifierUses(expr: LoweredExpr, target: string): number {
    switch (expr.kind) {
        case "identifier":
            return expr.name === target ? 1 : 0;
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return 0;
        case "fn":
            if (expr.params.some((param) => param.name === target)) {
                return 0;
            }
            return countIdentifierUses(expr.body, target);
        case "let": {
            let count = 0;
            for (const binding of expr.bindings) {
                count += countIdentifierUses(binding.value, target);
                if (binding.bind.name === target) {
                    return count;
                }
            }
            return count + countIdentifierUses(expr.body, target);
        }
        case "if":
            return countIdentifierUses(expr.condExpr, target)
                + countIdentifierUses(expr.trueBranchExpr, target)
                + countIdentifierUses(expr.falseBranchExpr, target);
        case "while":
            return countIdentifierUses(expr.condExpr, target)
                + countIdentifierUses(expr.bodyExpr, target);
        case "seq":
            return expr.expressions.reduce((sum, inner) => sum + countIdentifierUses(inner, target), 0);
        case "set_local":
            return (expr.identifier === target ? 1 : 0) + countIdentifierUses(expr.value, target);
        case "call":
            return countIdentifierUses(expr.callee, target)
                + expr.args.reduce((sum, arg) => sum + countIdentifierUses(arg, target), 0);
        case "direct_call":
            return expr.args.reduce((sum, arg) => sum + countIdentifierUses(arg, target), 0);
        case "object_get_field":
            return countIdentifierUses(expr.receiver, target);
        case "object_set_field":
            return countIdentifierUses(expr.receiver, target) + countIdentifierUses(expr.value, target);
        case "method_closure_create":
            return countIdentifierUses(expr.receiver, target);
        case "union_inject":
            return countIdentifierUses(expr.value, target);
        case "match": {
            let count = countIdentifierUses(expr.unionExpr, target);
            for (const branch of expr.branches) {
                if (branch.bind.name !== target) {
                    count += countIdentifierUses(branch.body, target);
                }
            }
            return count;
        }
        case "cond":
        case "dvar":
            return 0;
    }
}

function simplifyIfExpr(expr: Extract<LoweredExpr, { readonly kind: "if" }>, state: SimplifyState): LoweredExpr {
    const condExpr = simplifyExpr(expr.condExpr, state);
    const trueBranchExpr = simplifyExpr(expr.trueBranchExpr, state);
    const falseBranchExpr = simplifyExpr(expr.falseBranchExpr, state);
    const staticBooleanValue = getStaticBooleanValue(condExpr);

    if (staticBooleanValue === true) {
        state.stats.foldedConstantIfs += 1;
        return trueBranchExpr;
    }
    if (staticBooleanValue === false) {
        state.stats.foldedConstantIfs += 1;
        return falseBranchExpr;
    }
    if (deepEqualExpr(trueBranchExpr, falseBranchExpr)) {
        state.stats.removedRedundantIfs += 1;
        return trueBranchExpr;
    }

    return {
        kind: "if",
        condExpr,
        trueBranchExpr,
        falseBranchExpr
    };
}

function simplifyWhileExpr(expr: Extract<LoweredExpr, { readonly kind: "while" }>, state: SimplifyState): LoweredExpr {
    return {
        kind: "while",
        condExpr: simplifyExpr(expr.condExpr, state),
        bodyExpr: simplifyExpr(expr.bodyExpr, state)
    };
}

function simplifySeqExpr(expr: Extract<LoweredExpr, { readonly kind: "seq" }>, state: SimplifyState): LoweredExpr {
    const simplifiedExpressions: LoweredExpr[] = [];
    for (const inner of expr.expressions) {
        const simplified = simplifyExpr(inner, state);
        if (simplified.kind === "seq") {
            state.stats.flattenedSeqs += 1;
            simplifiedExpressions.push(...simplified.expressions);
            continue;
        }
        simplifiedExpressions.push(simplified);
    }
    if (simplifiedExpressions.length === 1) {
        return simplifiedExpressions[0];
    }
    return {
        kind: "seq",
        expressions: simplifiedExpressions
    };
}

function simplifyLetExpr(expr: Extract<LoweredExpr, { readonly kind: "let" }>, state: SimplifyState): LoweredExpr {
    const bindings = expr.bindings.map((binding) => ({
        ...binding,
        value: simplifyExpr(binding.value, state)
    }));
    const body = simplifyExpr(expr.body, state);

    const keptBindings: typeof bindings = [];
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
        const binding = bindings[index];
        const tailExpr: LoweredExpr = keptBindings.length === 0
            ? body
            : { kind: "let", bindings: keptBindings, body };
        if (countIdentifierUses(tailExpr, binding.bind.name) === 0 && isPureExpr(binding.value)) {
            state.stats.removedDeadLets += 1;
            continue;
        }
        keptBindings.unshift(binding);
    }

    if (keptBindings.length === 0) {
        return body;
    }
    if (keptBindings.length === 1 && body.kind === "identifier" && body.name === keptBindings[0].bind.name && isAtomicExpr(keptBindings[0].value)) {
        state.stats.collapsedIdentityLets += 1;
        return keptBindings[0].value;
    }

    return {
        kind: "let",
        bindings: keptBindings,
        body
    };
}

function simplifyExpr(expr: LoweredExpr, state: SimplifyState): LoweredExpr {
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
                body: simplifyExpr(expr.body, state)
            };
        case "let":
            return simplifyLetExpr(expr, state);
        case "if":
            return simplifyIfExpr(expr, state);
        case "while":
            return simplifyWhileExpr(expr, state);
        case "seq":
            return simplifySeqExpr(expr, state);
        case "set_local":
            return {
                ...expr,
                value: simplifyExpr(expr.value, state)
            };
        case "call":
            return {
                ...expr,
                callee: simplifyExpr(expr.callee, state),
                args: expr.args.map((arg) => simplifyExpr(arg, state))
            };
        case "direct_call":
            return {
                ...expr,
                args: expr.args.map((arg) => simplifyExpr(arg, state))
            };
        case "object_get_field":
            return {
                ...expr,
                receiver: simplifyExpr(expr.receiver, state)
            };
        case "object_set_field":
            return {
                ...expr,
                receiver: simplifyExpr(expr.receiver, state),
                value: simplifyExpr(expr.value, state)
            };
        case "method_closure_create":
            return {
                ...expr,
                receiver: simplifyExpr(expr.receiver, state)
            };
        case "union_inject":
            return {
                ...expr,
                value: simplifyExpr(expr.value, state)
            };
        case "match":
            return {
                ...expr,
                unionExpr: simplifyExpr(expr.unionExpr, state),
                branches: expr.branches.map((branch) => ({
                    ...branch,
                    body: simplifyExpr(branch.body, state)
                }))
            };
        case "cond":
        case "dvar":
            throw new Error(`Pass 5a simplify failed: unexpected node kind '${expr.kind}'`);
    }
}

export function simplifyAnfPass(program: AnfProgram): SimplifiedAnfProgram {
    const state: SimplifyState = {
        stats: createInitialStats()
    };
    const simplified: SimplifiedAnfProgram = {
        kind: "simplified_anf_program",
        topLevelStatements: program.topLevelStatements.map((statement) => simplifyExpr(statement, state)),
        globals: program.globals,
        functions: program.functions.map((fn): LoweredFunctionDefinition => ({
            ...fn,
            body: simplifyExpr(fn.body, state)
        })),
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        metadata: program.metadata,
        stats: { ...state.stats }
    };
    validateAnfProgram({
        kind: "anf_program",
        topLevelStatements: simplified.topLevelStatements,
        globals: simplified.globals,
        functions: simplified.functions,
        declaredFunctions: simplified.declaredFunctions,
        layouts: simplified.layouts,
        metadata: simplified.metadata
    });
    return simplified;
}
