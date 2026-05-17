import type {
    BindingFact,
    FactsAnalysisResult,
    KnownCallProgram,
    KnownCallStats,
    LoweredExpr,
    LoweredFunctionDefinition,
    PropagatedFactsProgram,
    SimplifiedAnfProgram
} from "./Lowering-Frontend-Shared";

type MutableKnownCallStats = {
    -readonly [K in keyof KnownCallStats]: KnownCallStats[K];
};

interface KnownDirectFunctionCallee {
    readonly kind: "direct_function";
    readonly symbol: string;
}

interface KnownBoundMethodCallee {
    readonly kind: "bound_method";
    readonly symbol: string;
    readonly receiver: LoweredExpr;
}

type KnownCallee = KnownDirectFunctionCallee | KnownBoundMethodCallee;

interface RewriteState {
    factIndex: number;
    readonly stats: MutableKnownCallStats;
}

interface DirectCallEnv {
    readonly knownCallees: ReadonlyMap<string, KnownCallee>;
    readonly valueAliases: ReadonlyMap<string, LoweredExpr>;
}

function consumeBindingFact(
    facts: readonly BindingFact[],
    state: RewriteState,
    expectedDeclaredIn: BindingFact["declaredIn"],
    expectedName: string
): BindingFact {
    const fact = facts[state.factIndex];
    if (!fact) {
        throw new Error(`Pass 5c known-call conversion failed: missing fact for ${expectedDeclaredIn} binding '${expectedName}'`);
    }
    if (fact.declaredIn !== expectedDeclaredIn || fact.name !== expectedName) {
        throw new Error(`Pass 5c known-call conversion failed: fact mismatch, expected ${expectedDeclaredIn} binding '${expectedName}', got ${fact.declaredIn} binding '${fact.name}'`);
    }
    state.factIndex += 1;
    return fact;
}

function deepEqualExpr(left: LoweredExpr, right: LoweredExpr): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalizeValue(expr: LoweredExpr, env: DirectCallEnv): LoweredExpr {
    if (expr.kind !== "identifier") {
        return expr;
    }
    let current: LoweredExpr = expr;
    const seen = new Set<string>();
    while (current.kind === "identifier") {
        if (seen.has(current.name)) {
            return current;
        }
        seen.add(current.name);
        const aliased = env.valueAliases.get(current.name);
        if (!aliased) {
            return current;
        }
        current = aliased;
    }
    return current;
}

function knownCalleeForValue(expr: LoweredExpr, env: DirectCallEnv): KnownCallee | undefined {
    if (expr.kind === "direct_function_ref") {
        return {
            kind: "direct_function",
            symbol: expr.symbol
        };
    }
    if (expr.kind === "method_closure_create") {
        return {
            kind: "bound_method",
            symbol: expr.methodSymbol,
            receiver: canonicalizeValue(expr.receiver, env)
        };
    }
    if (expr.kind === "identifier") {
        return env.knownCallees.get(expr.name);
    }
    if (expr.kind === "if") {
        const trueCallee = knownCalleeForValue(expr.trueBranchExpr, env);
        if (!trueCallee) {
            return undefined;
        }
        const falseCallee = knownCalleeForValue(expr.falseBranchExpr, env);
        if (!falseCallee || falseCallee.kind !== trueCallee.kind) {
            return undefined;
        }
        if (trueCallee.kind === "direct_function") {
            return falseCallee.symbol === trueCallee.symbol ? trueCallee : undefined;
        }
        if (falseCallee.kind !== "bound_method") {
            return undefined;
        }
        return falseCallee.symbol === trueCallee.symbol && deepEqualExpr(falseCallee.receiver, trueCallee.receiver)
            ? trueCallee
            : undefined;
    }
    return undefined;
}

function rewriteExpr(expr: LoweredExpr, env: DirectCallEnv, facts: readonly BindingFact[], state: RewriteState): LoweredExpr {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "fn": {
            const scopedCallees = new Map(env.knownCallees);
            const scopedAliases = new Map(env.valueAliases);
            for (const param of expr.params) {
                consumeBindingFact(facts, state, "param", param.name);
                scopedCallees.delete(param.name);
                scopedAliases.delete(param.name);
            }
            return {
                ...expr,
                body: rewriteExpr(expr.body, { knownCallees: scopedCallees, valueAliases: scopedAliases }, facts, state)
            };
        }
        case "let": {
            const scopedCallees = new Map(env.knownCallees);
            const scopedAliases = new Map(env.valueAliases);
            const bindings = expr.bindings.map((binding) => {
                const rewrittenValue = rewriteExpr(binding.value, { knownCallees: scopedCallees, valueAliases: scopedAliases }, facts, state);
                const bindingFact = consumeBindingFact(facts, state, "let", binding.bind.name);
                const localEnv: DirectCallEnv = { knownCallees: scopedCallees, valueAliases: scopedAliases };
                const knownCallee = bindingFact.isAssigned ? undefined : knownCalleeForValue(rewrittenValue, localEnv);
                if (knownCallee) {
                    if (rewrittenValue.kind === "identifier") {
                        state.stats.convertedAliases += 1;
                    }
                    scopedCallees.set(binding.bind.name, knownCallee);
                } else {
                    scopedCallees.delete(binding.bind.name);
                }
                if (!bindingFact.isAssigned && rewrittenValue.kind === "identifier") {
                    scopedAliases.set(binding.bind.name, canonicalizeValue(rewrittenValue, localEnv));
                } else {
                    scopedAliases.delete(binding.bind.name);
                }
                return {
                    bind: binding.bind,
                    value: rewrittenValue
                };
            });
            return {
                kind: "let",
                bindings,
                body: rewriteExpr(expr.body, { knownCallees: scopedCallees, valueAliases: scopedAliases }, facts, state)
            };
        }
        case "if":
            return {
                kind: "if",
                condExpr: rewriteExpr(expr.condExpr, env, facts, state),
                trueBranchExpr: rewriteExpr(expr.trueBranchExpr, env, facts, state),
                falseBranchExpr: rewriteExpr(expr.falseBranchExpr, env, facts, state)
            };
        case "while":
            return {
                kind: "while",
                condExpr: rewriteExpr(expr.condExpr, env, facts, state),
                bodyExpr: rewriteExpr(expr.bodyExpr, env, facts, state)
            };
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => rewriteExpr(inner, env, facts, state))
            };
        case "set_local":
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value: rewriteExpr(expr.value, env, facts, state)
            };
        case "call": {
            const rewrittenCallee = rewriteExpr(expr.callee, env, facts, state);
            const rewrittenArgs = expr.args.map((arg) => rewriteExpr(arg, env, facts, state));
            const knownCallee = knownCalleeForValue(rewrittenCallee, env);
            if (knownCallee) {
                state.stats.convertedCalls += 1;
                return {
                    kind: "direct_call",
                    symbol: knownCallee.symbol,
                    args: knownCallee.kind === "bound_method"
                        ? [knownCallee.receiver, ...rewrittenArgs]
                        : rewrittenArgs
                };
            }
            return {
                kind: "call",
                callee: rewrittenCallee,
                args: rewrittenArgs
            };
        }
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
                    const scopedCallees = new Map(env.knownCallees);
                    const scopedAliases = new Map(env.valueAliases);
                    consumeBindingFact(facts, state, "match", branch.bind.name);
                    scopedCallees.delete(branch.bind.name);
                    scopedAliases.delete(branch.bind.name);
                    return {
                        bind: branch.bind,
                        memberTypeTagId: branch.memberTypeTagId,
                        body: rewriteExpr(branch.body, { knownCallees: scopedCallees, valueAliases: scopedAliases }, facts, state)
                    };
                })
            };
        case "cond":
        case "dvar":
            throw new Error(`Pass 5c known-call conversion failed: unexpected node kind '${expr.kind}'`);
    }
}

export function knownCallConversionPass(program: SimplifiedAnfProgram | PropagatedFactsProgram, factsResult: FactsAnalysisResult): KnownCallProgram {
    const state: RewriteState = {
        factIndex: 0,
        stats: {
            convertedCalls: 0,
            convertedAliases: 0
        }
    };
    const env: DirectCallEnv = {
        knownCallees: new Map(),
        valueAliases: new Map()
    };
    const topLevelStatements = program.topLevelStatements.map((statement) => rewriteExpr(statement, env, factsResult.bindings, state));
    const functions = program.functions.map((fn): LoweredFunctionDefinition => {
        const scopedCallees = new Map(env.knownCallees);
        const scopedAliases = new Map(env.valueAliases);
        for (const param of fn.params) {
            consumeBindingFact(factsResult.bindings, state, "param", param.name);
            scopedCallees.delete(param.name);
            scopedAliases.delete(param.name);
        }
        return {
            ...fn,
            body: rewriteExpr(fn.body, { knownCallees: scopedCallees, valueAliases: scopedAliases }, factsResult.bindings, state)
        };
    });
    if (state.factIndex !== factsResult.bindings.length) {
        throw new Error(`Pass 5c known-call conversion failed: consumed ${state.factIndex} facts but analysis produced ${factsResult.bindings.length}`);
    }
    return {
        kind: "known_call_program",
        topLevelStatements,
        globals: program.globals,
        functions,
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        metadata: program.metadata,
        stats: { ...state.stats }
    };
}
