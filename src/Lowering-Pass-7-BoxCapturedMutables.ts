import { IdentifierNode } from "./AstNode";
import type {
    AnfProgram,
    CapturedMutableCheckedProgram,
    FreeVarAnalysisResult,
    KnownCallProgram,
    LoweredBinding,
    LoweredExpr,
    LoweredFunctionDefinition,
    LoweringClassLayout,
    LoweringLayoutTable,
    MutableCaptureDiagnostic,
    ShrunkClosureProgram,
    TinyInlinedProgram,
    SimplifiedAnfProgram
} from "./Lowering-Frontend-Shared";
import { astToTypeValue } from "./Typecheck-TypeAst";
import { getClassTypeId } from "./TypeSystem";

const MUTBOX_CLASS_PREFIX = "__iw_mono_class_mutbox_";
const MUTBOX_FIELD_NAME = "value";

interface RequirementState {
    lambdaCounter: number;
}

interface BoxingPlan {
    readonly letBindings: WeakMap<Extract<LoweredExpr, { kind: "let" }>, ReadonlySet<string>>;
    readonly lambdaParams: WeakMap<Extract<LoweredExpr, { kind: "fn" }>, ReadonlySet<string>>;
    readonly matchBranchBindings: WeakMap<object, boolean>;
    readonly functionParams: WeakMap<LoweredFunctionDefinition, ReadonlySet<string>>;
}

interface RewriteState {
    boxCounter: number;
    tempCounter: number;
    layouts: Map<string, LoweringClassLayout>;
}

type BoxBindingMap = ReadonlyMap<string, string>;

function unionSets(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
    return new Set([...left, ...right]);
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
            throw new Error(`Pass 7 mutable capture boxing failed: unexpected node kind '${expr.kind}'`);
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
        case "fn":
            return new Set();
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
            throw new Error(`Pass 7 mutable capture boxing failed: unexpected node kind '${expr.kind}'`);
    }
}

function collectBoxRequirements(
    expr: LoweredExpr,
    scope: ReadonlySet<string>,
    mutableFromOuterScopes: ReadonlySet<string>,
    analysis: FreeVarAnalysisResult,
    plan: BoxingPlan,
    state: RequirementState
): Set<string> {
    switch (expr.kind) {
        case "identifier":
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
            const innerRequirements = collectBoxRequirements(expr.body, fnScope, unionSets(mutableFromOuterScopes, fnMutables), analysis, plan, state);
            const assignedOuterRefs = collectAssignedOuterRefs(expr.body, fnScope);
            const boxedParams = new Set(expr.params.map((param) => param.name).filter((name) => innerRequirements.has(name)));
            if (boxedParams.size > 0) {
                plan.lambdaParams.set(expr, boxedParams);
            }
            const lambdaSite = analysis.lambdaSites.get(siteId);
            if (!lambdaSite) {
                throw new Error(`Pass 7 mutable capture boxing failed: missing free-var info for lambda site '${siteId}'`);
            }
            return new Set(lambdaSite.freeVariables.filter((name) => mutableFromOuterScopes.has(name) || assignedOuterRefs.has(name) || innerRequirements.has(name)));
        }
        case "let": {
            const result = new Set<string>();
            const bindingNames = new Set<string>();
            const recursiveFunctionBindings = new Set<string>();
            expr.bindings.forEach((binding) => bindingNames.add(binding.bind.name));
            let bodyScope = new Set(scope);
            for (const binding of expr.bindings) {
                const lambdaSiteId = binding.value.kind === "fn" ? `fn_${state.lambdaCounter}` : undefined;
                collectBoxRequirements(binding.value, bodyScope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name));
                if (lambdaSiteId) {
                    const lambdaSite = analysis.lambdaSites.get(lambdaSiteId);
                    if (!lambdaSite) {
                        throw new Error(`Pass 7 mutable capture boxing failed: missing free-var info for lambda site '${lambdaSiteId}'`);
                    }
                    if (lambdaSite.freeVariables.some((name) => bindingNames.has(name))) {
                        recursiveFunctionBindings.add(binding.bind.name);
                    }
                }
                bodyScope.add(binding.bind.name);
            }
            collectBoxRequirements(expr.body, bodyScope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name));
            recursiveFunctionBindings.forEach((name) => result.add(name));
            const boxedBindings = new Set(Array.from(result).filter((name) => bindingNames.has(name)));
            if (boxedBindings.size > 0) {
                plan.letBindings.set(expr, boxedBindings);
            }
            return new Set(Array.from(result).filter((name) => !bindingNames.has(name)));
        }
        case "if": {
            const result = collectBoxRequirements(expr.condExpr, scope, mutableFromOuterScopes, analysis, plan, state);
            collectBoxRequirements(expr.trueBranchExpr, scope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name));
            collectBoxRequirements(expr.falseBranchExpr, scope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name));
            return result;
        }
        case "while": {
            const result = collectBoxRequirements(expr.condExpr, scope, mutableFromOuterScopes, analysis, plan, state);
            collectBoxRequirements(expr.bodyExpr, scope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name));
            return result;
        }
        case "seq": {
            const result = new Set<string>();
            expr.expressions.forEach((inner) => collectBoxRequirements(inner, scope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name)));
            return result;
        }
        case "set_local":
            return collectBoxRequirements(expr.value, scope, mutableFromOuterScopes, analysis, plan, state);
        case "call": {
            const result = collectBoxRequirements(expr.callee, scope, mutableFromOuterScopes, analysis, plan, state);
            expr.args.forEach((arg) => collectBoxRequirements(arg, scope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name)));
            return result;
        }
        case "direct_call": {
            const result = new Set<string>();
            expr.args.forEach((arg) => collectBoxRequirements(arg, scope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name)));
            return result;
        }
        case "object_get_field":
            return collectBoxRequirements(expr.receiver, scope, mutableFromOuterScopes, analysis, plan, state);
        case "object_set_field": {
            const result = collectBoxRequirements(expr.receiver, scope, mutableFromOuterScopes, analysis, plan, state);
            collectBoxRequirements(expr.value, scope, mutableFromOuterScopes, analysis, plan, state).forEach((name) => result.add(name));
            return result;
        }
        case "method_closure_create":
            return collectBoxRequirements(expr.receiver, scope, mutableFromOuterScopes, analysis, plan, state);
        case "union_inject":
            return collectBoxRequirements(expr.value, scope, mutableFromOuterScopes, analysis, plan, state);
        case "match": {
            const result = collectBoxRequirements(expr.unionExpr, scope, mutableFromOuterScopes, analysis, plan, state);
            for (const branch of expr.branches) {
                const branchScope = new Set(scope);
                branchScope.add(branch.bind.name);
                const branchRequirements = collectBoxRequirements(branch.body, branchScope, mutableFromOuterScopes, analysis, plan, state);
                if (branchRequirements.has(branch.bind.name)) {
                    plan.matchBranchBindings.set(branch, true);
                }
                branchRequirements.forEach((name) => {
                    if (name !== branch.bind.name) {
                        result.add(name);
                    }
                });
            }
            return result;
        }
        case "cond":
        case "dvar":
            throw new Error(`Pass 7 mutable capture boxing failed: unexpected node kind '${expr.kind}'`);
    }
}

function nextMutboxLayout(binding: LoweredBinding, state: RewriteState): string {
    const className = `${MUTBOX_CLASS_PREFIX}${state.boxCounter}`;
    state.boxCounter += 1;
    state.layouts.set(className, {
        className,
        runtimeTypeTagId: getClassTypeId(className),
        propertyOrder: [MUTBOX_FIELD_NAME],
        propertyTypes: new Map([[MUTBOX_FIELD_NAME, astToTypeValue(binding.typeExp)]]),
        methodOrder: [],
        methodTypes: new Map(),
        methodSymbols: new Map(),
        constructors: [{
            symbol: `${className}_ctor`,
            paramTypes: []
        }]
    });
    return className;
}

function nextTempName(state: RewriteState): string {
    const name = `__iw_mutbox_tmp_${state.tempCounter}`;
    state.tempCounter += 1;
    return name;
}

function shadowBoxBindings(boxBindings: BoxBindingMap, names: readonly string[]): Map<string, string> {
    const shadowed = new Map(boxBindings);
    names.forEach((name) => shadowed.delete(name));
    return shadowed;
}

function rawIdentifier(name: string): LoweredExpr {
    return { kind: "identifier", name };
}

function rewriteIdentifier(name: string, boxBindings: BoxBindingMap): LoweredExpr {
    const boxLayout = boxBindings.get(name);
    if (!boxLayout) {
        return rawIdentifier(name);
    }
    return {
        kind: "object_get_field",
        receiver: rawIdentifier(name),
        className: boxLayout,
        fieldName: MUTBOX_FIELD_NAME
    };
}

function createBoxInitializer(boxLayout: string, value: LoweredExpr, state: RewriteState): LoweredExpr {
    const tempName = nextTempName(state);
    return {
        kind: "let",
        bindings: [{
            bind: {
                name: tempName,
                typeExp: new IdentifierNode(boxLayout)
            },
            value: {
                kind: "object_alloc",
                className: boxLayout
            }
        }],
        body: {
            kind: "seq",
            expressions: [{
                kind: "object_set_field",
                receiver: rawIdentifier(tempName),
                className: boxLayout,
                fieldName: MUTBOX_FIELD_NAME,
                value
            }, rawIdentifier(tempName)]
        }
    };
}

function rewriteExpr(expr: LoweredExpr, plan: BoxingPlan, boxBindings: BoxBindingMap, state: RewriteState): LoweredExpr {
    switch (expr.kind) {
        case "identifier":
            return rewriteIdentifier(expr.name, boxBindings);
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "fn": {
            const paramBoxes = plan.lambdaParams.get(expr) ?? new Set<string>();
            const childBindings = shadowBoxBindings(boxBindings, expr.params.map((param) => param.name));
            const boxLayouts = new Map<string, string>();
            expr.params.forEach((param) => {
                if (!paramBoxes.has(param.name)) {
                    return;
                }
                const boxLayout = nextMutboxLayout(param, state);
                childBindings.set(param.name, boxLayout);
                boxLayouts.set(param.name, boxLayout);
            });
            let rewrittenBody = rewriteExpr(expr.body, plan, childBindings, state);
            if (boxLayouts.size > 0) {
                rewrittenBody = {
                    kind: "let",
                    bindings: expr.params
                        .filter((param) => boxLayouts.has(param.name))
                        .map((param) => ({
                            bind: {
                                name: param.name,
                                typeExp: new IdentifierNode(boxLayouts.get(param.name)!)
                            },
                            value: createBoxInitializer(boxLayouts.get(param.name)!, rawIdentifier(param.name), state)
                        })),
                    body: rewrittenBody
                };
            }
            return {
                ...expr,
                body: rewrittenBody
            };
        }
        case "let": {
            const boxedBindings = plan.letBindings.get(expr) ?? new Set<string>();
            const recursiveFunctionBoxes = new Map<string, string>();
            for (const binding of expr.bindings) {
                if (boxedBindings.has(binding.bind.name) && binding.value.kind === "fn") {
                    recursiveFunctionBoxes.set(binding.bind.name, nextMutboxLayout(binding.bind, state));
                }
            }

            const recursivePlaceholderValue: LoweredExpr = {
                kind: "number_literal",
                value: 0,
                typeName: "i5"
            };

            const buildTail = (index: number, visibleBindings: Map<string, string>): LoweredExpr => {
                if (index >= expr.bindings.length) {
                    return rewriteExpr(expr.body, plan, visibleBindings, state);
                }

                const binding = expr.bindings[index];
                const recursiveBoxLayout = recursiveFunctionBoxes.get(binding.bind.name);
                if (recursiveBoxLayout) {
                    const rewrittenValue = rewriteExpr(binding.value, plan, visibleBindings, state);
                    return {
                        kind: "seq",
                        expressions: [
                            {
                                kind: "object_set_field",
                                receiver: rawIdentifier(binding.bind.name),
                                className: recursiveBoxLayout,
                                fieldName: MUTBOX_FIELD_NAME,
                                value: rewrittenValue
                            },
                            buildTail(index + 1, visibleBindings)
                        ]
                    };
                }

                const rewrittenValue = rewriteExpr(binding.value, plan, visibleBindings, state);
                if (!boxedBindings.has(binding.bind.name)) {
                    const nextVisibleBindings = new Map(visibleBindings);
                    nextVisibleBindings.delete(binding.bind.name);
                    return {
                        kind: "let",
                        bindings: [{
                            bind: binding.bind,
                            value: rewrittenValue
                        }],
                        body: buildTail(index + 1, nextVisibleBindings)
                    };
                }

                const boxLayout = nextMutboxLayout(binding.bind, state);
                const nextVisibleBindings = new Map(visibleBindings);
                nextVisibleBindings.set(binding.bind.name, boxLayout);
                return {
                    kind: "let",
                    bindings: [{
                        bind: {
                            name: binding.bind.name,
                            typeExp: new IdentifierNode(boxLayout)
                        },
                        value: createBoxInitializer(boxLayout, rewrittenValue, state)
                    }],
                    body: buildTail(index + 1, nextVisibleBindings)
                };
            };

            const visibleBindings = new Map(boxBindings);
            const placeholderBindings = expr.bindings
                .filter((binding) => recursiveFunctionBoxes.has(binding.bind.name))
                .map((binding) => {
                    const boxLayout = recursiveFunctionBoxes.get(binding.bind.name)!;
                    visibleBindings.set(binding.bind.name, boxLayout);
                    return {
                        bind: {
                            name: binding.bind.name,
                            typeExp: new IdentifierNode(boxLayout)
                        },
                        value: createBoxInitializer(boxLayout, recursivePlaceholderValue, state)
                    };
                });

            const rewrittenBody = buildTail(0, visibleBindings);
            if (placeholderBindings.length === 0) {
                return rewrittenBody;
            }
            return {
                kind: "let",
                bindings: placeholderBindings,
                body: rewrittenBody
            };
        }
        case "if":
            return {
                kind: "if",
                condExpr: rewriteExpr(expr.condExpr, plan, boxBindings, state),
                trueBranchExpr: rewriteExpr(expr.trueBranchExpr, plan, boxBindings, state),
                falseBranchExpr: rewriteExpr(expr.falseBranchExpr, plan, boxBindings, state)
            };
        case "while":
            return {
                kind: "while",
                condExpr: rewriteExpr(expr.condExpr, plan, boxBindings, state),
                bodyExpr: rewriteExpr(expr.bodyExpr, plan, boxBindings, state)
            };
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => rewriteExpr(inner, plan, boxBindings, state))
            };
        case "set_local": {
            const rewrittenValue = rewriteExpr(expr.value, plan, boxBindings, state);
            const boxLayout = boxBindings.get(expr.identifier);
            if (!boxLayout) {
                return {
                    kind: "set_local",
                    identifier: expr.identifier,
                    value: rewrittenValue
                };
            }
            return {
                kind: "object_set_field",
                receiver: rawIdentifier(expr.identifier),
                className: boxLayout,
                fieldName: MUTBOX_FIELD_NAME,
                value: rewrittenValue
            };
        }
        case "call":
            return {
                kind: "call",
                callee: rewriteExpr(expr.callee, plan, boxBindings, state),
                args: expr.args.map((arg) => rewriteExpr(arg, plan, boxBindings, state))
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => rewriteExpr(arg, plan, boxBindings, state))
            };
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: rewriteExpr(expr.receiver, plan, boxBindings, state),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "object_set_field":
            return {
                kind: "object_set_field",
                receiver: rewriteExpr(expr.receiver, plan, boxBindings, state),
                className: expr.className,
                fieldName: expr.fieldName,
                value: rewriteExpr(expr.value, plan, boxBindings, state)
            };
        case "method_closure_create":
            return {
                kind: "method_closure_create",
                receiver: rewriteExpr(expr.receiver, plan, boxBindings, state),
                className: expr.className,
                methodName: expr.methodName,
                methodSymbol: expr.methodSymbol
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: rewriteExpr(expr.value, plan, boxBindings, state)
            };
        case "match":
            return {
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr: rewriteExpr(expr.unionExpr, plan, boxBindings, state),
                branches: expr.branches.map((branch) => {
                    const branchBindings = shadowBoxBindings(boxBindings, [branch.bind.name]);
                    let rewrittenBody: LoweredExpr;
                    if (plan.matchBranchBindings.get(branch)) {
                        const boxLayout = nextMutboxLayout(branch.bind, state);
                        branchBindings.set(branch.bind.name, boxLayout);
                        rewrittenBody = {
                            kind: "let",
                            bindings: [{
                                bind: {
                                    name: branch.bind.name,
                                    typeExp: new IdentifierNode(boxLayout)
                                },
                                value: createBoxInitializer(boxLayout, rawIdentifier(branch.bind.name), state)
                            }],
                            body: rewriteExpr(branch.body, plan, branchBindings, state)
                        };
                    } else {
                        rewrittenBody = rewriteExpr(branch.body, plan, branchBindings, state);
                    }
                    return {
                        bind: branch.bind,
                        memberTypeTagId: branch.memberTypeTagId,
                        body: rewrittenBody
                    };
                })
            };
        case "cond":
        case "dvar":
            throw new Error(`Pass 7 mutable capture boxing failed: unexpected node kind '${expr.kind}'`);
    }
}

function collectProgramBoxingPlan(program: AnfProgram | SimplifiedAnfProgram | KnownCallProgram | TinyInlinedProgram | ShrunkClosureProgram, analysis: FreeVarAnalysisResult): BoxingPlan {
    const plan: BoxingPlan = {
        letBindings: new WeakMap(),
        lambdaParams: new WeakMap(),
        matchBranchBindings: new WeakMap(),
        functionParams: new WeakMap()
    };
    const state: RequirementState = {
        lambdaCounter: 0
    };
    const topLevelMutables = new Set<string>();
    program.topLevelStatements.forEach((statement) => collectMutatedLocals(statement, new Set()).forEach((name) => topLevelMutables.add(name)));
    program.topLevelStatements.forEach((statement) => {
        collectBoxRequirements(statement, new Set(), topLevelMutables, analysis, plan, state);
    });
    for (const fn of program.functions) {
        const fnScope = new Set(fn.params.map((param) => param.name));
        const fnMutables = collectMutatedLocals(fn.body, fnScope);
        const fnRequirements = collectBoxRequirements(fn.body, fnScope, fnMutables, analysis, plan, state);
        const boxedParams = new Set(fn.params.map((param) => param.name).filter((name) => fnRequirements.has(name)));
        if (boxedParams.size > 0) {
            plan.functionParams.set(fn, boxedParams);
        }
    }
    return plan;
}

function rewriteFunction(fn: LoweredFunctionDefinition, plan: BoxingPlan, state: RewriteState): LoweredFunctionDefinition {
    const paramBoxes = plan.functionParams.get(fn) ?? new Set<string>();
    const childBindings = new Map<string, string>();
    const paramLayouts = new Map<string, string>();
    fn.params.forEach((param) => {
        if (!paramBoxes.has(param.name)) {
            return;
        }
        const boxLayout = nextMutboxLayout(param, state);
        childBindings.set(param.name, boxLayout);
        paramLayouts.set(param.name, boxLayout);
    });
    let rewrittenBody = rewriteExpr(fn.body, plan, childBindings, state);
    if (paramLayouts.size > 0) {
        rewrittenBody = {
            kind: "let",
            bindings: fn.params
                .filter((param) => paramLayouts.has(param.name))
                .map((param) => ({
                    bind: {
                        name: param.name,
                        typeExp: new IdentifierNode(paramLayouts.get(param.name)!)
                    },
                    value: createBoxInitializer(paramLayouts.get(param.name)!, rawIdentifier(param.name), state)
                })),
            body: rewrittenBody
        };
    }
    return {
        ...fn,
        body: rewrittenBody
    };
}

export function validateCapturedMutableCheckProgram(program: CapturedMutableCheckedProgram): void {
    if (program.diagnostics.length !== 0) {
        throw new Error("Pass 7 mutable-capture validation failed: boxing pass should not emit diagnostics");
    }
}

export function boxCapturedMutablesPass(program: AnfProgram | SimplifiedAnfProgram | KnownCallProgram | TinyInlinedProgram | ShrunkClosureProgram, analysis: FreeVarAnalysisResult): CapturedMutableCheckedProgram {
    const plan = collectProgramBoxingPlan(program, analysis);
    const rewriteState: RewriteState = {
        boxCounter: 0,
        tempCounter: 0,
        layouts: new Map(program.layouts.classes)
    };
    const layouts: LoweringLayoutTable = {
        kind: "lowering_layout_table",
        classes: rewriteState.layouts
    };
    const result: CapturedMutableCheckedProgram = {
        kind: "captured_mutable_checked_program",
        topLevelStatements: program.topLevelStatements.map((statement) => rewriteExpr(statement, plan, new Map(), rewriteState)),
        globals: program.globals,
        functions: program.functions.map((fn) => rewriteFunction(fn, plan, rewriteState)),
        declaredFunctions: program.declaredFunctions,
        layouts,
        metadata: program.metadata,
        analysis,
        diagnostics: [] as MutableCaptureDiagnostic[]
    };
    validateCapturedMutableCheckProgram(result);
    return result;
}
