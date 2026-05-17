import type {
    BindingFact,
    FactsAnalysisResult,
    LoweredExpr,
    LoweredFunctionDefinition,
    PropagatedFactStats,
    PropagatedFactsProgram,
    SimplifiedAnfProgram
} from "./Lowering-Frontend-Shared";
import { validateAnfProgram } from "./Lowering-Pass-5-ANF";

type MutablePropagatedFactStats = {
    -readonly [K in keyof PropagatedFactStats]: PropagatedFactStats[K];
};

interface RewriteState {
    factIndex: number;
    readonly stats: MutablePropagatedFactStats;
}

interface RewriteEnv {
    readonly replacements: ReadonlyMap<string, LoweredExpr>;
}

function createInitialStats(): MutablePropagatedFactStats {
    return {
        inlinedSingleUseBindings: 0,
        propagatedConstants: 0,
        propagatedBooleans: 0,
        propagatedDirectFunctions: 0,
        foldedConstantIfs: 0,
        collapsedEquivalentIfs: 0,
        removedDeadLets: 0
    };
}

function consumeBindingFact(
    facts: readonly BindingFact[],
    state: RewriteState,
    expectedDeclaredIn: BindingFact["declaredIn"],
    expectedName: string
): BindingFact {
    const fact = facts[state.factIndex];
    if (!fact) {
        throw new Error(`Pass 5c fact propagation failed: missing fact for ${expectedDeclaredIn} binding '${expectedName}'`);
    }
    if (fact.declaredIn !== expectedDeclaredIn || fact.name !== expectedName) {
        throw new Error(`Pass 5c fact propagation failed: fact mismatch, expected ${expectedDeclaredIn} binding '${expectedName}', got ${fact.declaredIn} binding '${fact.name}'`);
    }
    state.factIndex += 1;
    return fact;
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
    }
    if (expr.kind === "number_literal" && expr.typeName === "i5") {
        if (expr.value === 1) {
            return true;
        }
        if (expr.value === 0) {
            return false;
        }
    }
    return undefined;
}

function replacementClass(expr: LoweredExpr): "boolean" | "constant" | "direct_function" | undefined {
    if (expr.kind === "identifier" && (expr.name === "true" || expr.name === "false")) {
        return "boolean";
    }
    if (expr.kind === "number_literal") {
        return "constant";
    }
    if (expr.kind === "direct_function_ref") {
        return "direct_function";
    }
    return undefined;
}

function noteReplacement(expr: LoweredExpr, state: RewriteState, singleUse: boolean): void {
    const kind = replacementClass(expr);
    if (!kind) {
        return;
    }
    if (singleUse) {
        state.stats.inlinedSingleUseBindings += 1;
    }
    if (kind === "boolean") {
        state.stats.propagatedBooleans += 1;
        return;
    }
    if (kind === "constant") {
        state.stats.propagatedConstants += 1;
        return;
    }
    state.stats.propagatedDirectFunctions += 1;
}

function rewriteIdentifier(expr: Extract<LoweredExpr, { readonly kind: "identifier" }>, env: RewriteEnv): LoweredExpr {
    return env.replacements.get(expr.name) ?? expr;
}

function rewriteIfExpr(
    expr: Extract<LoweredExpr, { readonly kind: "if" }>,
    env: RewriteEnv,
    facts: readonly BindingFact[],
    state: RewriteState
): LoweredExpr {
    const condExpr = rewriteExpr(expr.condExpr, env, facts, state);
    const trueBranchExpr = rewriteExpr(expr.trueBranchExpr, env, facts, state);
    const falseBranchExpr = rewriteExpr(expr.falseBranchExpr, env, facts, state);
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
        state.stats.collapsedEquivalentIfs += 1;
        return trueBranchExpr;
    }

    return {
        kind: "if",
        condExpr,
        trueBranchExpr,
        falseBranchExpr
    };
}

function rewriteSeqExpr(
    expr: Extract<LoweredExpr, { readonly kind: "seq" }>,
    env: RewriteEnv,
    facts: readonly BindingFact[],
    state: RewriteState
): LoweredExpr {
    const scopedReplacements = new Map(env.replacements);
    const expressions = expr.expressions.map((inner) => {
        const rewritten = rewriteExpr(inner, { replacements: scopedReplacements }, facts, state);
        if (rewritten.kind === "set_local") {
            scopedReplacements.delete(rewritten.identifier);
        }
        return rewritten;
    });
    return {
        kind: "seq",
        expressions
    };
}

function rewriteLetExpr(
    expr: Extract<LoweredExpr, { readonly kind: "let" }>,
    env: RewriteEnv,
    facts: readonly BindingFact[],
    state: RewriteState
): LoweredExpr {
    const scopedReplacements = new Map(env.replacements);
    const bindings: Array<(typeof expr.bindings)[number]> = [];

    for (const binding of expr.bindings) {
        const rewrittenValue = rewriteExpr(binding.value, { replacements: scopedReplacements }, facts, state);
        const bindingFact = consumeBindingFact(facts, state, "let", binding.bind.name);
        const singleUse = bindingFact.useCount === 1;
        const canInlineSingleUse = singleUse && bindingFact.isPure && !bindingFact.isAssigned;
        const canPropagateFact = bindingFact.isPure && !bindingFact.isAssigned;
        const replacement = replacementClass(rewrittenValue) !== undefined && (canInlineSingleUse || canPropagateFact)
            ? rewrittenValue
            : undefined;

        if (replacement) {
            noteReplacement(replacement, state, singleUse);
            scopedReplacements.set(binding.bind.name, replacement);
            state.stats.removedDeadLets += 1;
            continue;
        }

        scopedReplacements.delete(binding.bind.name);
        bindings.push({
            bind: binding.bind,
            value: rewrittenValue
        });
    }

    const body = rewriteExpr(expr.body, { replacements: scopedReplacements }, facts, state);
    if (bindings.length === 0) {
        return body;
    }
    return {
        kind: "let",
        bindings,
        body
    };
}

function rewriteExpr(expr: LoweredExpr, env: RewriteEnv, facts: readonly BindingFact[], state: RewriteState): LoweredExpr {
    switch (expr.kind) {
        case "identifier":
            return rewriteIdentifier(expr, env);
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "fn": {
            const scopedReplacements = new Map(env.replacements);
            for (const param of expr.params) {
                consumeBindingFact(facts, state, "param", param.name);
                scopedReplacements.delete(param.name);
            }
            return {
                ...expr,
                body: rewriteExpr(expr.body, { replacements: scopedReplacements }, facts, state)
            };
        }
        case "let":
            return rewriteLetExpr(expr, env, facts, state);
        case "if":
            return rewriteIfExpr(expr, env, facts, state);
        case "while":
            return {
                kind: "while",
                condExpr: rewriteExpr(expr.condExpr, env, facts, state),
                bodyExpr: rewriteExpr(expr.bodyExpr, env, facts, state)
            };
        case "seq":
            return rewriteSeqExpr(expr, env, facts, state);
        case "set_local":
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value: rewriteExpr(expr.value, env, facts, state)
            };
        case "call":
            return {
                kind: "call",
                callee: rewriteExpr(expr.callee, env, facts, state),
                args: expr.args.map((arg) => rewriteExpr(arg, env, facts, state))
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => rewriteExpr(arg, env, facts, state))
            };
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: rewriteExpr(expr.receiver, env, facts, state),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "object_set_field":
            return {
                kind: "object_set_field",
                receiver: rewriteExpr(expr.receiver, env, facts, state),
                className: expr.className,
                fieldName: expr.fieldName,
                value: rewriteExpr(expr.value, env, facts, state)
            };
        case "method_closure_create":
            return {
                kind: "method_closure_create",
                receiver: rewriteExpr(expr.receiver, env, facts, state),
                className: expr.className,
                methodName: expr.methodName,
                methodSymbol: expr.methodSymbol
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: rewriteExpr(expr.value, env, facts, state)
            };
        case "match":
            return {
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr: rewriteExpr(expr.unionExpr, env, facts, state),
                branches: expr.branches.map((branch) => {
                    const scopedReplacements = new Map(env.replacements);
                    consumeBindingFact(facts, state, "match", branch.bind.name);
                    scopedReplacements.delete(branch.bind.name);
                    return {
                        bind: branch.bind,
                        memberTypeTagId: branch.memberTypeTagId,
                        body: rewriteExpr(branch.body, { replacements: scopedReplacements }, facts, state)
                    };
                })
            };
        case "cond":
        case "dvar":
            throw new Error(`Pass 5c fact propagation failed: unexpected node kind '${expr.kind}'`);
    }
}

function validatePropagatedFactsProgram(program: PropagatedFactsProgram): void {
    validateAnfProgram({
        kind: "anf_program",
        topLevelStatements: program.topLevelStatements,
        globals: program.globals,
        functions: program.functions,
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        metadata: program.metadata
    });
}

export function propagateSimpleFactsPass(program: SimplifiedAnfProgram, factsResult: FactsAnalysisResult): PropagatedFactsProgram {
    const state: RewriteState = {
        factIndex: 0,
        stats: createInitialStats()
    };
    const env: RewriteEnv = {
        replacements: new Map()
    };
    const propagated: PropagatedFactsProgram = {
        kind: "propagated_facts_program",
        topLevelStatements: program.topLevelStatements.map((statement) => rewriteExpr(statement, env, factsResult.bindings, state)),
        globals: program.globals,
        functions: program.functions.map((fn): LoweredFunctionDefinition => {
            const scopedReplacements = new Map(env.replacements);
            for (const param of fn.params) {
                consumeBindingFact(factsResult.bindings, state, "param", param.name);
                scopedReplacements.delete(param.name);
            }
            return {
                ...fn,
                body: rewriteExpr(fn.body, { replacements: scopedReplacements }, factsResult.bindings, state)
            };
        }),
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        metadata: program.metadata,
        stats: { ...state.stats }
    };
    if (state.factIndex !== factsResult.bindings.length) {
        throw new Error(`Pass 5c fact propagation failed: consumed ${state.factIndex} facts but analysis produced ${factsResult.bindings.length}`);
    }
    validatePropagatedFactsProgram(propagated);
    return propagated;
}
