import type {
    EscapeAnalysisResult,
    FreeVarAnalysisResult,
    LoweredExpr,
    LoweredFunctionDefinition,
    ShrinkClosureStats,
    ShrunkClosureProgram,
    TinyInlinedProgram
} from "./Lowering-Frontend-Shared";

type AtomicReplacement = Extract<LoweredExpr, { kind: "identifier" | "number_literal" | "text_literal" | "direct_function_ref" }>;

interface LightweightBoundMethod {
    readonly symbol: string;
    readonly receiver: LoweredExpr;
}

interface RewriteEnv {
    readonly atomicValues: ReadonlyMap<string, AtomicReplacement>;
    readonly boundMethods: ReadonlyMap<string, LightweightBoundMethod>;
}

type MutableShrinkClosureStats = {
    -readonly [K in keyof ShrinkClosureStats]: ShrinkClosureStats[K];
};

interface RewriteState {
    lambdaCounter: number;
    boundMethodCounter: number;
    readonly freeVarAnalysis: FreeVarAnalysisResult;
    readonly escapeAnalysis: EscapeAnalysisResult;
    readonly helperFunctions: LoweredFunctionDefinition[];
    readonly globalIdentifiers: ReadonlySet<string>;
    readonly stats: MutableShrinkClosureStats;
}

const BUILTIN_GLOBAL_IDENTIFIERS: ReadonlySet<string> = new Set([
    "true",
    "false",
    "add",
    "sub",
    "mul",
    "eq",
    "not",
    "array_new",
    "array_get",
    "array_set",
    "array_length"
]);

function createInitialStats(): MutableShrinkClosureStats {
    return {
        loweredNonCapturedLambdas: 0,
        rewrittenDirectCalls: 0,
        rewrittenImmediateCalls: 0,
        rewrittenBoundMethodCalls: 0
    };
}

function getLambdaEscapeSite(state: RewriteState, lambdaSiteId: string) {
    return state.escapeAnalysis.sites.find((site) => site.sourceKind === "lambda" && site.lambdaSiteId === lambdaSiteId);
}

function getBoundMethodEscapeSite(state: RewriteState, boundMethodSiteId: string) {
    return state.escapeAnalysis.sites.find((site) => site.sourceKind === "bound_method" && site.boundMethodSiteId === boundMethodSiteId);
}

function rewriteLambdaValue(expr: Extract<LoweredExpr, { kind: "fn" }>, env: RewriteEnv, state: RewriteState): { readonly lambdaSiteId: string; readonly rewrittenValue: LoweredExpr; readonly rewrittenBody: LoweredExpr; } {
    const siteId = `fn_${state.lambdaCounter}`;
    state.lambdaCounter += 1;
    const siteInfo = state.freeVarAnalysis.lambdaSites.get(siteId);
    if (!siteInfo) {
        throw new Error(`Pass 5g closure shrinking failed: missing free-var info for lambda site '${siteId}'`);
    }
    const lambdaAtomicEnv = new Map(env.atomicValues);
    const lambdaBoundMethodEnv = new Map(env.boundMethods);
    const lambdaScope = new Set(expr.params.map((param) => param.name));
    expr.params.forEach((param) => {
        lambdaAtomicEnv.delete(param.name);
        lambdaBoundMethodEnv.delete(param.name);
    });
    const rewrittenBody = rewriteExpr(expr.body, { atomicValues: lambdaAtomicEnv, boundMethods: lambdaBoundMethodEnv }, lambdaScope, state);
    const remainingFreeVariables = collectFreeIdentifiers(rewrittenBody, lambdaScope, state.globalIdentifiers);
    if (siteInfo.freeVariables.length === 0 || remainingFreeVariables.size === 0) {
        const helperSymbol = `__iw_shrunk_lambda_${siteId}`;
        state.helperFunctions.push({
            symbol: helperSymbol,
            params: expr.params,
            returnType: expr.returnType,
            body: rewrittenBody,
            origin: {
                kind: "closure_shrink"
            }
        });
        state.stats.loweredNonCapturedLambdas += 1;
        return {
            lambdaSiteId: siteId,
            rewrittenBody,
            rewrittenValue: {
                kind: "direct_function_ref",
                symbol: helperSymbol
            }
        };
    }
    return {
        lambdaSiteId: siteId,
        rewrittenBody,
        rewrittenValue: {
            ...expr,
            body: rewrittenBody
        }
    };
}

function rewriteBoundMethodValue(expr: Extract<LoweredExpr, { kind: "method_closure_create" }>, env: RewriteEnv, scope: ReadonlySet<string>, state: RewriteState): { readonly boundMethodSiteId: string; readonly rewrittenValue: LoweredExpr; readonly lightweightCallee: LightweightBoundMethod; } {
    const siteId = `method_closure_${state.boundMethodCounter}`;
    state.boundMethodCounter += 1;
    const rewrittenReceiver = rewriteExpr(expr.receiver, env, scope, state);
    return {
        boundMethodSiteId: siteId,
        rewrittenValue: {
            ...expr,
            receiver: rewrittenReceiver
        },
        lightweightCallee: {
            symbol: expr.methodSymbol,
            receiver: rewrittenReceiver
        }
    };
}

function buildGlobalIdentifiers(program: TinyInlinedProgram): ReadonlySet<string> {
    return new Set([
        ...BUILTIN_GLOBAL_IDENTIFIERS,
        ...program.globals.map((globalDef) => globalDef.symbol)
    ]);
}

function isAtomicReplacement(expr: LoweredExpr): expr is AtomicReplacement {
    return expr.kind === "identifier" || expr.kind === "number_literal" || expr.kind === "text_literal" || expr.kind === "direct_function_ref";
}

function collectMutatedLocals(expr: LoweredExpr, scope: ReadonlySet<string>): Set<string> {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return new Set();
        case "fn": {
            const fnScope = new Set(expr.params.map((param) => param.name));
            return collectAssignedOuterRefs(expr.body, fnScope);
        }
        case "let": {
            const result = new Set<string>();
            let bodyScope = new Set(scope);
            for (const binding of expr.bindings) {
                collectMutatedLocals(binding.value, bodyScope).forEach((name) => result.add(name));
                bodyScope.add(binding.bind.name);
            }
            collectMutatedLocals(expr.body, bodyScope).forEach((name) => result.add(name));
            return result;
        }
        case "if": {
            const result = collectMutatedLocals(expr.condExpr, scope);
            collectMutatedLocals(expr.trueBranchExpr, scope).forEach((name) => result.add(name));
            collectMutatedLocals(expr.falseBranchExpr, scope).forEach((name) => result.add(name));
            return result;
        }
        case "while": {
            const result = collectMutatedLocals(expr.condExpr, scope);
            collectMutatedLocals(expr.bodyExpr, scope).forEach((name) => result.add(name));
            return result;
        }
        case "seq": {
            const result = new Set<string>();
            expr.expressions.forEach((inner) => collectMutatedLocals(inner, scope).forEach((name) => result.add(name)));
            return result;
        }
        case "set_local": {
            const result = collectMutatedLocals(expr.value, scope);
            if (scope.has(expr.identifier)) {
                result.add(expr.identifier);
            }
            return result;
        }
        case "call": {
            const result = collectMutatedLocals(expr.callee, scope);
            expr.args.forEach((arg) => collectMutatedLocals(arg, scope).forEach((name) => result.add(name)));
            return result;
        }
        case "direct_call": {
            const result = new Set<string>();
            expr.args.forEach((arg) => collectMutatedLocals(arg, scope).forEach((name) => result.add(name)));
            return result;
        }
        case "object_get_field":
            return collectMutatedLocals(expr.receiver, scope);
        case "object_set_field": {
            const result = collectMutatedLocals(expr.receiver, scope);
            collectMutatedLocals(expr.value, scope).forEach((name) => result.add(name));
            return result;
        }
        case "method_closure_create":
            return collectMutatedLocals(expr.receiver, scope);
        case "union_inject":
            return collectMutatedLocals(expr.value, scope);
        case "match": {
            const result = collectMutatedLocals(expr.unionExpr, scope);
            for (const branch of expr.branches) {
                const branchScope = new Set(scope);
                branchScope.add(branch.bind.name);
                collectMutatedLocals(branch.body, branchScope).forEach((name) => result.add(name));
            }
            return result;
        }
        case "cond":
        case "dvar":
            throw new Error(`Pass 5g closure shrinking failed: unexpected node kind '${expr.kind}'`);
    }
}

function collectAssignedOuterRefs(expr: LoweredExpr, scope: ReadonlySet<string>): Set<string> {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return new Set();
        case "fn": {
            const fnScope = new Set(expr.params.map((param) => param.name));
            return collectAssignedOuterRefs(expr.body, fnScope);
        }
        case "let": {
            const result = new Set<string>();
            let bodyScope = new Set(scope);
            for (const binding of expr.bindings) {
                collectAssignedOuterRefs(binding.value, bodyScope).forEach((name) => result.add(name));
                bodyScope.add(binding.bind.name);
            }
            collectAssignedOuterRefs(expr.body, bodyScope).forEach((name) => result.add(name));
            return result;
        }
        case "if": {
            const result = collectAssignedOuterRefs(expr.condExpr, scope);
            collectAssignedOuterRefs(expr.trueBranchExpr, scope).forEach((name) => result.add(name));
            collectAssignedOuterRefs(expr.falseBranchExpr, scope).forEach((name) => result.add(name));
            return result;
        }
        case "while": {
            const result = collectAssignedOuterRefs(expr.condExpr, scope);
            collectAssignedOuterRefs(expr.bodyExpr, scope).forEach((name) => result.add(name));
            return result;
        }
        case "seq": {
            const result = new Set<string>();
            expr.expressions.forEach((inner) => collectAssignedOuterRefs(inner, scope).forEach((name) => result.add(name)));
            return result;
        }
        case "set_local": {
            const result = collectAssignedOuterRefs(expr.value, scope);
            if (!scope.has(expr.identifier)) {
                result.add(expr.identifier);
            }
            return result;
        }
        case "call": {
            const result = collectAssignedOuterRefs(expr.callee, scope);
            expr.args.forEach((arg) => collectAssignedOuterRefs(arg, scope).forEach((name) => result.add(name)));
            return result;
        }
        case "direct_call": {
            const result = new Set<string>();
            expr.args.forEach((arg) => collectAssignedOuterRefs(arg, scope).forEach((name) => result.add(name)));
            return result;
        }
        case "object_get_field":
            return collectAssignedOuterRefs(expr.receiver, scope);
        case "object_set_field": {
            const result = collectAssignedOuterRefs(expr.receiver, scope);
            collectAssignedOuterRefs(expr.value, scope).forEach((name) => result.add(name));
            return result;
        }
        case "method_closure_create":
            return collectAssignedOuterRefs(expr.receiver, scope);
        case "union_inject":
            return collectAssignedOuterRefs(expr.value, scope);
        case "match": {
            const result = collectAssignedOuterRefs(expr.unionExpr, scope);
            for (const branch of expr.branches) {
                const branchScope = new Set(scope);
                branchScope.add(branch.bind.name);
                collectAssignedOuterRefs(branch.body, branchScope).forEach((name) => result.add(name));
            }
            return result;
        }
        case "cond":
        case "dvar":
            throw new Error(`Pass 5g closure shrinking failed: unexpected node kind '${expr.kind}'`);
    }
}

function collectFreeIdentifiers(expr: LoweredExpr, scope: ReadonlySet<string>, globalIdentifiers: ReadonlySet<string>): Set<string> {
    switch (expr.kind) {
        case "identifier":
            return scope.has(expr.name) || globalIdentifiers.has(expr.name) ? new Set() : new Set([expr.name]);
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return new Set();
        case "fn": {
            const fnScope = new Set(expr.params.map((param) => param.name));
            const bodyFreeVars = collectFreeIdentifiers(expr.body, fnScope, globalIdentifiers);
            return new Set(Array.from(bodyFreeVars).filter((name) => !scope.has(name) && !globalIdentifiers.has(name)));
        }
        case "let": {
            const result = new Set<string>();
            let bodyScope = new Set(scope);
            for (const binding of expr.bindings) {
                collectFreeIdentifiers(binding.value, bodyScope, globalIdentifiers).forEach((name) => result.add(name));
                bodyScope.add(binding.bind.name);
            }
            collectFreeIdentifiers(expr.body, bodyScope, globalIdentifiers).forEach((name) => result.add(name));
            return result;
        }
        case "if": {
            const result = collectFreeIdentifiers(expr.condExpr, scope, globalIdentifiers);
            collectFreeIdentifiers(expr.trueBranchExpr, scope, globalIdentifiers).forEach((name) => result.add(name));
            collectFreeIdentifiers(expr.falseBranchExpr, scope, globalIdentifiers).forEach((name) => result.add(name));
            return result;
        }
        case "while": {
            const result = collectFreeIdentifiers(expr.condExpr, scope, globalIdentifiers);
            collectFreeIdentifiers(expr.bodyExpr, scope, globalIdentifiers).forEach((name) => result.add(name));
            return result;
        }
        case "seq": {
            const result = new Set<string>();
            expr.expressions.forEach((inner) => collectFreeIdentifiers(inner, scope, globalIdentifiers).forEach((name) => result.add(name)));
            return result;
        }
        case "set_local": {
            const result = collectFreeIdentifiers(expr.value, scope, globalIdentifiers);
            if (!scope.has(expr.identifier) && !globalIdentifiers.has(expr.identifier)) {
                result.add(expr.identifier);
            }
            return result;
        }
        case "call": {
            const result = collectFreeIdentifiers(expr.callee, scope, globalIdentifiers);
            expr.args.forEach((arg) => collectFreeIdentifiers(arg, scope, globalIdentifiers).forEach((name) => result.add(name)));
            return result;
        }
        case "direct_call": {
            const result = new Set<string>();
            expr.args.forEach((arg) => collectFreeIdentifiers(arg, scope, globalIdentifiers).forEach((name) => result.add(name)));
            return result;
        }
        case "object_get_field":
            return collectFreeIdentifiers(expr.receiver, scope, globalIdentifiers);
        case "object_set_field": {
            const result = collectFreeIdentifiers(expr.receiver, scope, globalIdentifiers);
            collectFreeIdentifiers(expr.value, scope, globalIdentifiers).forEach((name) => result.add(name));
            return result;
        }
        case "method_closure_create":
            return collectFreeIdentifiers(expr.receiver, scope, globalIdentifiers);
        case "union_inject":
            return collectFreeIdentifiers(expr.value, scope, globalIdentifiers);
        case "match": {
            const result = collectFreeIdentifiers(expr.unionExpr, scope, globalIdentifiers);
            for (const branch of expr.branches) {
                const branchScope = new Set(scope);
                branchScope.add(branch.bind.name);
                collectFreeIdentifiers(branch.body, branchScope, globalIdentifiers).forEach((name) => result.add(name));
            }
            return result;
        }
        case "cond":
        case "dvar":
            throw new Error(`Pass 5g closure shrinking failed: unexpected node kind '${expr.kind}'`);
    }
}

function computeLaterMutationsByBinding(expr: Extract<LoweredExpr, { kind: "let" }>, scope: ReadonlySet<string>): ReadonlyArray<ReadonlySet<string>> {
    const scopeBeforeBinding: Array<ReadonlySet<string>> = [];
    let currentScope = new Set(scope);
    for (const binding of expr.bindings) {
        scopeBeforeBinding.push(new Set(currentScope));
        currentScope.add(binding.bind.name);
    }
    const laterMutations = collectMutatedLocals(expr.body, currentScope);
    const result: Array<ReadonlySet<string>> = new Array(expr.bindings.length);
    for (let index = expr.bindings.length - 1; index >= 0; index -= 1) {
        result[index] = new Set(laterMutations);
        collectMutatedLocals(expr.bindings[index].value, scopeBeforeBinding[index]).forEach((name) => laterMutations.add(name));
    }
    return result;
}

function collectMutations(exprs: readonly LoweredExpr[], scope: ReadonlySet<string>): Set<string> {
    const result = new Set<string>();
    exprs.forEach((expr) => collectMutatedLocals(expr, scope).forEach((name) => result.add(name)));
    return result;
}

function cloneRewriteEnv(env: RewriteEnv): { readonly atomicValues: Map<string, AtomicReplacement>; readonly boundMethods: Map<string, LightweightBoundMethod>; } {
    return {
        atomicValues: new Map(env.atomicValues),
        boundMethods: new Map(env.boundMethods)
    };
}

function invalidateRewriteEnv(env: RewriteEnv, names: ReadonlySet<string>): void {
    if (env.atomicValues instanceof Map) {
        const atomicValues = env.atomicValues as Map<string, AtomicReplacement>;
        names.forEach((name) => atomicValues.delete(name));
    }
    if (env.boundMethods instanceof Map) {
        const boundMethods = env.boundMethods as Map<string, LightweightBoundMethod>;
        names.forEach((name) => boundMethods.delete(name));
    }
}

function cloneRewriteEnvWithoutNames(env: RewriteEnv, names: ReadonlySet<string>): { readonly atomicValues: Map<string, AtomicReplacement>; readonly boundMethods: Map<string, LightweightBoundMethod>; } {
    const cloned = cloneRewriteEnv(env);
    invalidateRewriteEnv(cloned, names);
    return cloned;
}

function canReuseAtomicBindingValue(value: AtomicReplacement, laterMutations: ReadonlySet<string>, bindingName: string): boolean {
    if (laterMutations.has(bindingName)) {
        return false;
    }
    return value.kind !== "identifier" || !laterMutations.has(value.name);
}

function canReuseBoundMethodAlias(lightweightBoundMethod: LightweightBoundMethod, laterMutations: ReadonlySet<string>): boolean {
    return lightweightBoundMethod.receiver.kind !== "identifier" || !laterMutations.has(lightweightBoundMethod.receiver.name);
}

function rewriteExpr(expr: LoweredExpr, env: RewriteEnv, scope: ReadonlySet<string>, state: RewriteState): LoweredExpr {
    switch (expr.kind) {
        case "identifier":
            return env.atomicValues.get(expr.name) ?? expr;
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "fn": {
            return rewriteLambdaValue(expr, env, state).rewrittenValue;
        }
        case "let": {
            const scopedAtomicEnv = new Map(env.atomicValues);
            const scopedBoundMethodEnv = new Map(env.boundMethods);
            const scopedScope = new Set(scope);
            const laterMutationsByBinding = computeLaterMutationsByBinding(expr, scope);
            const bindings = expr.bindings.map((binding, index) => {
                let value: LoweredExpr;
                let boundMethodSiteId: string | undefined;
                let lightweightBoundMethod: LightweightBoundMethod | undefined;
                if (binding.value.kind === "method_closure_create") {
                    const rewrittenBoundMethod = rewriteBoundMethodValue(binding.value, { atomicValues: scopedAtomicEnv, boundMethods: scopedBoundMethodEnv }, scopedScope, state);
                    value = rewrittenBoundMethod.rewrittenValue;
                    boundMethodSiteId = rewrittenBoundMethod.boundMethodSiteId;
                    lightweightBoundMethod = rewrittenBoundMethod.lightweightCallee;
                } else {
                    value = rewriteExpr(binding.value, { atomicValues: scopedAtomicEnv, boundMethods: scopedBoundMethodEnv }, scopedScope, state);
                }
                if (isAtomicReplacement(value) && canReuseAtomicBindingValue(value, laterMutationsByBinding[index], binding.bind.name)) {
                    scopedAtomicEnv.set(binding.bind.name, value);
                } else {
                    scopedAtomicEnv.delete(binding.bind.name);
                }
                if (
                    boundMethodSiteId
                    && lightweightBoundMethod
                    && getBoundMethodEscapeSite(state, boundMethodSiteId)?.classification === "non_escaping"
                    && canReuseBoundMethodAlias(lightweightBoundMethod, laterMutationsByBinding[index])
                ) {
                    scopedBoundMethodEnv.set(binding.bind.name, lightweightBoundMethod);
                } else {
                    scopedBoundMethodEnv.delete(binding.bind.name);
                }
                scopedScope.add(binding.bind.name);
                return {
                    bind: binding.bind,
                    value
                };
            });
            return {
                kind: "let",
                bindings,
                body: rewriteExpr(expr.body, { atomicValues: scopedAtomicEnv, boundMethods: scopedBoundMethodEnv }, scopedScope, state)
            };
        }
        case "if":
            const branchMutations = collectMutations([expr.condExpr, expr.trueBranchExpr, expr.falseBranchExpr], scope);
            const condEnv = cloneRewriteEnvWithoutNames(env, branchMutations);
            const trueEnv = cloneRewriteEnvWithoutNames(env, branchMutations);
            const falseEnv = cloneRewriteEnvWithoutNames(env, branchMutations);
            invalidateRewriteEnv(env, branchMutations);
            return {
                kind: "if",
                condExpr: rewriteExpr(expr.condExpr, condEnv, scope, state),
                trueBranchExpr: rewriteExpr(expr.trueBranchExpr, trueEnv, scope, state),
                falseBranchExpr: rewriteExpr(expr.falseBranchExpr, falseEnv, scope, state)
            };
        case "while": {
            const loopMutations = collectMutations([expr.condExpr, expr.bodyExpr], scope);
            const condEnv = cloneRewriteEnvWithoutNames(env, loopMutations);
            const bodyEnv = cloneRewriteEnvWithoutNames(env, loopMutations);
            invalidateRewriteEnv(env, loopMutations);
            return {
                kind: "while",
                condExpr: rewriteExpr(expr.condExpr, condEnv, scope, state),
                bodyExpr: rewriteExpr(expr.bodyExpr, bodyEnv, scope, state)
            };
        }
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => rewriteExpr(inner, env, scope, state))
            };
        case "set_local": {
            let value: LoweredExpr;
            let boundMethodSiteId: string | undefined;
            let lightweightBoundMethod: LightweightBoundMethod | undefined;
            if (expr.value.kind === "method_closure_create") {
                const rewrittenBoundMethod = rewriteBoundMethodValue(expr.value, env, scope, state);
                value = rewrittenBoundMethod.rewrittenValue;
                boundMethodSiteId = rewrittenBoundMethod.boundMethodSiteId;
                lightweightBoundMethod = rewrittenBoundMethod.lightweightCallee;
            } else {
                value = rewriteExpr(expr.value, env, scope, state);
            }
            if (env.atomicValues instanceof Map) {
                if (isAtomicReplacement(value)) {
                    env.atomicValues.set(expr.identifier, value);
                } else {
                    env.atomicValues.delete(expr.identifier);
                }
            }
            if (env.boundMethods instanceof Map) {
                if (boundMethodSiteId && lightweightBoundMethod && getBoundMethodEscapeSite(state, boundMethodSiteId)?.classification === "non_escaping") {
                    env.boundMethods.set(expr.identifier, lightweightBoundMethod);
                } else {
                    env.boundMethods.delete(expr.identifier);
                }
            }
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value
            };
        }
        case "call": {
            const args = expr.args.map((arg) => rewriteExpr(arg, env, scope, state));
            if (expr.callee.kind === "fn") {
                const rewrittenLambda = rewriteLambdaValue(expr.callee, env, state);
                const lambdaEscapeSite = getLambdaEscapeSite(state, rewrittenLambda.lambdaSiteId);
                if (lambdaEscapeSite?.classification === "non_escaping") {
                    state.stats.rewrittenImmediateCalls += 1;
                    if (expr.callee.params.length === 0) {
                        return rewrittenLambda.rewrittenBody;
                    }
                    return {
                        kind: "let",
                        bindings: expr.callee.params.map((param, index) => ({
                            bind: param,
                            value: args[index]
                        })),
                        body: rewrittenLambda.rewrittenBody
                    };
                }
                const callee = rewrittenLambda.rewrittenValue;
                if (callee.kind === "direct_function_ref") {
                    state.stats.rewrittenDirectCalls += 1;
                    return {
                        kind: "direct_call",
                        symbol: callee.symbol,
                        args
                    };
                }
                return {
                    kind: "call",
                    callee,
                    args
                };
            }
            if (expr.callee.kind === "method_closure_create") {
                const rewrittenBoundMethod = rewriteBoundMethodValue(expr.callee, env, scope, state);
                if (getBoundMethodEscapeSite(state, rewrittenBoundMethod.boundMethodSiteId)?.classification === "non_escaping") {
                    state.stats.rewrittenBoundMethodCalls += 1;
                    return {
                        kind: "direct_call",
                        symbol: rewrittenBoundMethod.lightweightCallee.symbol,
                        args: [rewrittenBoundMethod.lightweightCallee.receiver, ...args]
                    };
                }
                return {
                    kind: "call",
                    callee: rewrittenBoundMethod.rewrittenValue,
                    args
                };
            }
            if (expr.callee.kind === "identifier") {
                const lightweightBoundMethod = env.boundMethods.get(expr.callee.name);
                if (lightweightBoundMethod) {
                    state.stats.rewrittenBoundMethodCalls += 1;
                    return {
                        kind: "direct_call",
                        symbol: lightweightBoundMethod.symbol,
                        args: [lightweightBoundMethod.receiver, ...args]
                    };
                }
            }
            const callee = rewriteExpr(expr.callee, env, scope, state);
            if (callee.kind === "direct_function_ref") {
                state.stats.rewrittenDirectCalls += 1;
                return {
                    kind: "direct_call",
                    symbol: callee.symbol,
                    args
                };
            }
            return {
                kind: "call",
                callee,
                args
            };
        }
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => rewriteExpr(arg, env, scope, state))
            };
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: rewriteExpr(expr.receiver, env, scope, state),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "object_set_field":
            return {
                kind: "object_set_field",
                receiver: rewriteExpr(expr.receiver, env, scope, state),
                className: expr.className,
                fieldName: expr.fieldName,
                value: rewriteExpr(expr.value, env, scope, state)
            };
        case "method_closure_create":
            return rewriteBoundMethodValue(expr, env, scope, state).rewrittenValue;
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: rewriteExpr(expr.value, env, scope, state)
            };
        case "match":
            const matchMutations = collectMutations([expr.unionExpr, ...expr.branches.map((branch) => branch.body)], scope);
            const unionEnv = cloneRewriteEnvWithoutNames(env, matchMutations);
            invalidateRewriteEnv(env, matchMutations);
            return {
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr: rewriteExpr(expr.unionExpr, unionEnv, scope, state),
                branches: expr.branches.map((branch) => {
                    const branchEnv = cloneRewriteEnvWithoutNames(env, matchMutations);
                    const branchAtomicEnv = branchEnv.atomicValues;
                    const branchBoundMethodEnv = branchEnv.boundMethods;
                    branchAtomicEnv.delete(branch.bind.name);
                    branchBoundMethodEnv.delete(branch.bind.name);
                    return {
                        bind: branch.bind,
                        memberTypeTagId: branch.memberTypeTagId,
                        body: rewriteExpr(branch.body, { atomicValues: branchAtomicEnv, boundMethods: branchBoundMethodEnv }, new Set([...scope, branch.bind.name]), state)
                    };
                })
            };
        case "cond":
        case "dvar":
            throw new Error(`Pass 5g closure shrinking failed: unexpected node kind '${expr.kind}'`);
    }
}

export function shrinkClosuresPass(program: TinyInlinedProgram, freeVarAnalysis: FreeVarAnalysisResult, escapeAnalysis: EscapeAnalysisResult): ShrunkClosureProgram {
    const state: RewriteState = {
        lambdaCounter: 0,
        boundMethodCounter: 0,
        freeVarAnalysis,
        escapeAnalysis,
        helperFunctions: [],
        globalIdentifiers: buildGlobalIdentifiers(program),
        stats: createInitialStats()
    };
    const emptyEnv: RewriteEnv = {
        atomicValues: new Map(),
        boundMethods: new Map()
    };
    const functions = program.functions.map((fn) => ({
        ...fn,
        body: rewriteExpr(fn.body, { atomicValues: new Map(emptyEnv.atomicValues), boundMethods: new Map(emptyEnv.boundMethods) }, new Set(fn.params.map((param) => param.name)), state)
    }));
    return {
        kind: "shrunk_closure_program",
        topLevelStatements: program.topLevelStatements.map((statement) => rewriteExpr(statement, { atomicValues: new Map(emptyEnv.atomicValues), boundMethods: new Map(emptyEnv.boundMethods) }, new Set(), state)),
        globals: program.globals,
        functions: [...functions, ...state.helperFunctions],
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        metadata: program.metadata,
        stats: { ...state.stats }
    };
}