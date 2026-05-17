import type {
    AnfProgram,
    EscapeAnalysisResult,
    BoundMethodCaptureInfo,
    FactsAnalysisResult,
    FreeVarAnalysisResult,
    KnownCallProgram,
    LambdaFreeVarInfo,
    LoweredExpr,
    LoweringStageBResult,
    ShrunkClosureProgram,
    TinyInlinedProgram,
    SimplifiedAnfProgram
} from "./Lowering-Frontend-Shared";
import type { MonomorphizedArtifacts } from "./Typecheck-Pipeline";
import { desugarCorePass } from "./Lowering-Pass-4-DesugarCore";
import { anfPass } from "./Lowering-Pass-5-ANF";
import { simplifyAnfPass } from "./Lowering-Pass-5a-Simplify";
import { analyzeFactsPass } from "./Lowering-Pass-5b-AnalyzeFacts";
import { propagateSimpleFactsPass } from "./Lowering-Pass-5c-PropagateSimpleFacts";
import { knownCallConversionPass } from "./Lowering-Pass-5c-KnownCalls";
import { inlineTinyDirectPass } from "./Lowering-Pass-5e-InlineTinyDirect";
import { classifyEscapePass } from "./Lowering-Pass-5f-ClassifyEscape";
import { shrinkClosuresPass } from "./Lowering-Pass-5g-ShrinkClosures";
import { performLoweringStageAFromArtifacts } from "./Lowering-Pass-3-LiftMethods";
import type { LoweringSnapshotOptions } from "./Lowering-Pass-0-Snapshot";

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

function buildGlobalIdentifiers(program: { readonly globals: readonly { readonly symbol: string; }[] }): ReadonlySet<string> {
    return new Set([
        ...BUILTIN_GLOBAL_IDENTIFIERS,
        ...program.globals.map((globalDef) => globalDef.symbol)
    ]);
}

interface AnalysisState {
    lambdaCounter: number;
    boundMethodCounter: number;
    lambdaSites: Map<string, LambdaFreeVarInfo>;
    boundMethodSites: Map<string, BoundMethodCaptureInfo>;
}

function unionSets(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
    return new Set([...left, ...right]);
}

function sortNames(values: ReadonlySet<string>): string[] {
    return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function collectMutatedLocals(expr: LoweredExpr, scope: ReadonlySet<string>): Set<string> {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return new Set();
        case "fn":
            return new Set();
        case "let": {
            const localMutations = new Set<string>();
            let bodyScope = new Set(scope);
            for (const binding of expr.bindings) {
                const bindingMutations = collectMutatedLocals(binding.value, bodyScope);
                bindingMutations.forEach((name) => localMutations.add(name));
                bodyScope.add(binding.bind.name);
            }
            const bodyMutations = collectMutatedLocals(expr.body, bodyScope);
            bodyMutations.forEach((name) => localMutations.add(name));
            return localMutations;
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
            for (const inner of expr.expressions) {
                collectMutatedLocals(inner, scope).forEach((name) => result.add(name));
            }
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
            throw new Error(`Pass 6 free-var analysis failed: unexpected node kind '${expr.kind}'`);
    }
}

function collectCapturedLocalRefs(expr: LoweredExpr, scope: ReadonlySet<string>, globalIdentifiers: ReadonlySet<string>): Set<string> {
    switch (expr.kind) {
        case "identifier":
            return scope.has(expr.name) && !globalIdentifiers.has(expr.name) ? new Set([expr.name]) : new Set();
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return new Set();
        case "fn":
            return new Set();
        case "let": {
            const result = new Set<string>();
            let bodyScope = new Set(scope);
            for (const binding of expr.bindings) {
                collectCapturedLocalRefs(binding.value, bodyScope, globalIdentifiers).forEach((name) => result.add(name));
                bodyScope.add(binding.bind.name);
            }
            collectCapturedLocalRefs(expr.body, bodyScope, globalIdentifiers).forEach((name) => result.add(name));
            return result;
        }
        case "if": {
            const result = collectCapturedLocalRefs(expr.condExpr, scope, globalIdentifiers);
            collectCapturedLocalRefs(expr.trueBranchExpr, scope, globalIdentifiers).forEach((name) => result.add(name));
            collectCapturedLocalRefs(expr.falseBranchExpr, scope, globalIdentifiers).forEach((name) => result.add(name));
            return result;
        }
        case "while": {
            const result = collectCapturedLocalRefs(expr.condExpr, scope, globalIdentifiers);
            collectCapturedLocalRefs(expr.bodyExpr, scope, globalIdentifiers).forEach((name) => result.add(name));
            return result;
        }
        case "seq": {
            const result = new Set<string>();
            expr.expressions.forEach((inner) => collectCapturedLocalRefs(inner, scope, globalIdentifiers).forEach((name) => result.add(name)));
            return result;
        }
        case "set_local":
            return collectCapturedLocalRefs(expr.value, scope, globalIdentifiers);
        case "call": {
            const result = collectCapturedLocalRefs(expr.callee, scope, globalIdentifiers);
            expr.args.forEach((arg) => collectCapturedLocalRefs(arg, scope, globalIdentifiers).forEach((name) => result.add(name)));
            return result;
        }
        case "direct_call": {
            const result = new Set<string>();
            expr.args.forEach((arg) => collectCapturedLocalRefs(arg, scope, globalIdentifiers).forEach((name) => result.add(name)));
            return result;
        }
        case "object_get_field":
            return collectCapturedLocalRefs(expr.receiver, scope, globalIdentifiers);
        case "object_set_field": {
            const result = collectCapturedLocalRefs(expr.receiver, scope, globalIdentifiers);
            collectCapturedLocalRefs(expr.value, scope, globalIdentifiers).forEach((name) => result.add(name));
            return result;
        }
        case "method_closure_create":
            return collectCapturedLocalRefs(expr.receiver, scope, globalIdentifiers);
        case "union_inject":
            return collectCapturedLocalRefs(expr.value, scope, globalIdentifiers);
        case "match": {
            const result = collectCapturedLocalRefs(expr.unionExpr, scope, globalIdentifiers);
            for (const branch of expr.branches) {
                const branchScope = new Set(scope);
                branchScope.add(branch.bind.name);
                collectCapturedLocalRefs(branch.body, branchScope, globalIdentifiers).forEach((name) => result.add(name));
            }
            return result;
        }
        case "cond":
        case "dvar":
            throw new Error(`Pass 6 free-var analysis failed: unexpected node kind '${expr.kind}'`);
    }
}

function analyzeExpr(
    expr: LoweredExpr,
    scope: ReadonlySet<string>,
    mutableFromOuterScopes: ReadonlySet<string>,
    globalIdentifiers: ReadonlySet<string>,
    state: AnalysisState
): Set<string> {
    switch (expr.kind) {
        case "identifier":
            if (scope.has(expr.name) || globalIdentifiers.has(expr.name)) {
                return new Set();
            }
            return new Set([expr.name]);
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return new Set();
        case "fn": {
            const siteId = `fn_${state.lambdaCounter}`;
            state.lambdaCounter += 1;
            const fnScope = new Set(expr.params.map((param) => param.name));
            const fnMutables = collectMutatedLocals(expr.body, fnScope);
            const bodyFreeVars = analyzeExpr(expr.body, fnScope, unionSets(mutableFromOuterScopes, fnMutables), globalIdentifiers, state);
            const freeVariables = sortNames(bodyFreeVars);
            state.lambdaSites.set(siteId, {
                siteId,
                boundVariables: sortNames(fnScope),
                freeVariables,
                capturesMutableLocal: freeVariables.some((name) => mutableFromOuterScopes.has(name))
            });
            return new Set(Array.from(bodyFreeVars).filter((name) => !scope.has(name) && !globalIdentifiers.has(name)));
        }
        case "let": {
            const result = new Set<string>();
            let bodyScope = new Set(scope);
            for (const binding of expr.bindings) {
                analyzeExpr(binding.value, bodyScope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name));
                bodyScope.add(binding.bind.name);
            }
            analyzeExpr(expr.body, bodyScope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name));
            return result;
        }
        case "if": {
            const result = analyzeExpr(expr.condExpr, scope, mutableFromOuterScopes, globalIdentifiers, state);
            analyzeExpr(expr.trueBranchExpr, scope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name));
            analyzeExpr(expr.falseBranchExpr, scope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name));
            return result;
        }
        case "while": {
            const result = analyzeExpr(expr.condExpr, scope, mutableFromOuterScopes, globalIdentifiers, state);
            analyzeExpr(expr.bodyExpr, scope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name));
            return result;
        }
        case "seq": {
            const result = new Set<string>();
            expr.expressions.forEach((inner) => analyzeExpr(inner, scope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name)));
            return result;
        }
        case "set_local": {
            const result = analyzeExpr(expr.value, scope, mutableFromOuterScopes, globalIdentifiers, state);
            if (!scope.has(expr.identifier) && !globalIdentifiers.has(expr.identifier)) {
                result.add(expr.identifier);
            }
            return result;
        }
        case "call": {
            const result = analyzeExpr(expr.callee, scope, mutableFromOuterScopes, globalIdentifiers, state);
            expr.args.forEach((arg) => analyzeExpr(arg, scope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name)));
            return result;
        }
        case "direct_call": {
            const result = new Set<string>();
            expr.args.forEach((arg) => analyzeExpr(arg, scope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name)));
            return result;
        }
        case "object_get_field":
            return analyzeExpr(expr.receiver, scope, mutableFromOuterScopes, globalIdentifiers, state);
        case "object_set_field": {
            const result = analyzeExpr(expr.receiver, scope, mutableFromOuterScopes, globalIdentifiers, state);
            analyzeExpr(expr.value, scope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name));
            return result;
        }
        case "method_closure_create": {
            const siteId = `method_closure_${state.boundMethodCounter}`;
            state.boundMethodCounter += 1;
            const receiverFreeVars = analyzeExpr(expr.receiver, scope, mutableFromOuterScopes, globalIdentifiers, state);
            state.boundMethodSites.set(siteId, {
                siteId,
                className: expr.className,
                methodName: expr.methodName,
                methodSymbol: expr.methodSymbol,
                capturedVariables: sortNames(collectCapturedLocalRefs(expr.receiver, scope, globalIdentifiers))
            });
            return receiverFreeVars;
        }
        case "union_inject":
            return analyzeExpr(expr.value, scope, mutableFromOuterScopes, globalIdentifiers, state);
        case "match": {
            const result = analyzeExpr(expr.unionExpr, scope, mutableFromOuterScopes, globalIdentifiers, state);
            for (const branch of expr.branches) {
                const branchScope = new Set(scope);
                branchScope.add(branch.bind.name);
                analyzeExpr(branch.body, branchScope, mutableFromOuterScopes, globalIdentifiers, state).forEach((name) => result.add(name));
            }
            return result;
        }
        case "cond":
        case "dvar":
            throw new Error(`Pass 6 free-var analysis failed: unexpected node kind '${expr.kind}'`);
    }
}

export function validateFreeVarAnalysis(result: FreeVarAnalysisResult): void {
    result.lambdaSites.forEach((site) => {
        if (site.freeVariables.some((name) => site.boundVariables.includes(name))) {
            throw new Error(`Pass 6 free-var validation failed: lambda site '${site.siteId}' contains a bound variable in its free set`);
        }
    });
    result.boundMethodSites.forEach((site) => {
        if (site.capturedVariables.length === 0) {
            throw new Error(`Pass 6 free-var validation failed: bound method site '${site.siteId}' must capture at least one variable`);
        }
    });
}

export function analyzeFreeVariablesPass(program: AnfProgram | SimplifiedAnfProgram | KnownCallProgram | TinyInlinedProgram | ShrunkClosureProgram): FreeVarAnalysisResult {
    const globalIdentifiers = buildGlobalIdentifiers(program);
    const state: AnalysisState = {
        lambdaCounter: 0,
        boundMethodCounter: 0,
        lambdaSites: new Map(),
        boundMethodSites: new Map()
    };
    const topLevelMutables = new Set<string>();
    program.topLevelStatements.forEach((statement) => collectMutatedLocals(statement, new Set()).forEach((name) => topLevelMutables.add(name)));
    program.topLevelStatements.forEach((statement) => {
        analyzeExpr(statement, new Set(), topLevelMutables, globalIdentifiers, state);
    });
    for (const fn of program.functions) {
        const fnScope = new Set(fn.params.map((param) => param.name));
        const fnMutables = collectMutatedLocals(fn.body, fnScope);
        analyzeExpr(fn.body, fnScope, fnMutables, globalIdentifiers, state);
    }
    const result: FreeVarAnalysisResult = {
        kind: "free_var_analysis",
        lambdaSites: state.lambdaSites,
        boundMethodSites: state.boundMethodSites
    };
    validateFreeVarAnalysis(result);
    return result;
}

export function performLoweringStageBFromArtifacts(programAst: import("./AstNode").AstNode, artifacts: MonomorphizedArtifacts, options?: LoweringSnapshotOptions): LoweringStageBResult {
    const stageA = performLoweringStageAFromArtifacts(programAst, artifacts, options);
    const pass4 = desugarCorePass(stageA.pass3);
    const pass5 = anfPass(pass4);
    const pass5a = simplifyAnfPass(pass5);
    const pass5b: FactsAnalysisResult = analyzeFactsPass(pass5a);
    const pass5c = propagateSimpleFactsPass(pass5a, pass5b);
    const pass5cFacts: FactsAnalysisResult = analyzeFactsPass(pass5c);
    const pass5d = knownCallConversionPass(pass5c, pass5cFacts);
    const pass5e = inlineTinyDirectPass(pass5d);
    const pass6 = analyzeFreeVariablesPass(pass5e);
    const pass6a: EscapeAnalysisResult = classifyEscapePass(pass5e, pass6);
    const pass6b: ShrunkClosureProgram = shrinkClosuresPass(pass5e, pass6, pass6a);
    const pass6c: FreeVarAnalysisResult = analyzeFreeVariablesPass(pass6b);
    const pass6d: EscapeAnalysisResult = classifyEscapePass(pass6b, pass6c);
    return {
        ...stageA,
        pass4,
        pass5,
        pass5a,
        pass5b,
        pass5c,
        pass5cFacts,
        pass5d,
        pass5e,
        pass6,
        pass6a,
        pass6b,
        pass6c,
        pass6d
    };
}
