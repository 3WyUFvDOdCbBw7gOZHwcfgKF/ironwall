// No-opt lowering pass 8 closure conversion.
import { AstNode, GenericCallNode, IdentifierNode, TypeToFromNode, TypeUnionNode } from "./AstNode";
import type {
    CapturedMutableCheckedProgram,
    ClosureConvertedFunctionDefinition,
    ClosureConvertedProgram,
    ClosureExpr,
    ClosureHelperDefinition,
    LoweredBinding,
    LoweredExpr
} from "./Lowering-Frontend-Shared";
import type { TypeValue, GenericFunctionInstanceTypeValue } from "./Typecheck-Core";
import {
    PrimitiveTypeValue as PrimitiveTypeCtor,
    ClassTypeValue as ClassTypeCtor,
    FunctionTypeValue as FunctionTypeCtor,
    UnionTypeValue as UnionTypeCtor,
    GenericClassInstanceTypeValue as GenericClassCtor,
    TypeParameterValue as TypeParameterCtor,
    builtinGenericTypeNames
} from "./Typecheck-Core";
import { getMonomorphizedClassName, getMonomorphizedFunctionName, astToTypeValue } from "./Typecheck-Pipeline";

interface ClosureConversionState {
    lambdaCounter: number;
    boundMethodCounter: number;
    helperDefinitions: ClosureHelperDefinition[];
    helperFunctions: ClosureConvertedFunctionDefinition[];
}

interface CaptureEnvironment {
    readonly envParamName?: string;
    readonly environmentLayout?: string;
    readonly capturedNames: ReadonlySet<string>;
    readonly valueTypes: ReadonlyMap<string, TypeValue>;
}

function extendValueTypes(base: ReadonlyMap<string, TypeValue>, bindings: readonly LoweredBinding[]): Map<string, TypeValue> {
    const extended = new Map(base);
    for (const binding of bindings) {
        if (binding.typeExp instanceof IdentifierNode && binding.typeExp.name === "__iw_anf_tmp") {
            continue;
        }
        extended.set(binding.name, astToTypeValue(binding.typeExp));
    }
    return extended;
}

function typeValueToAst(typeValue: TypeValue): AstNode {
    if (typeValue instanceof PrimitiveTypeCtor) {
        return new IdentifierNode(typeValue.name);
    }
    if (typeValue instanceof TypeParameterCtor) {
        return new IdentifierNode(typeValue.name);
    }
    if (typeValue instanceof ClassTypeCtor) {
        return new IdentifierNode(typeValue.className);
    }
    if (typeValue instanceof FunctionTypeCtor) {
        return new TypeToFromNode(typeValueToAst(typeValue.returnType), typeValue.paramTypes.map((paramType) => typeValueToAst(paramType)));
    }
    if (typeValue instanceof UnionTypeCtor) {
        return new TypeUnionNode(typeValue.types.map((member) => typeValueToAst(member)));
    }
    if (typeValue instanceof GenericClassCtor) {
        if (builtinGenericTypeNames.has(typeValue.genericName)) {
            return new GenericCallNode(new IdentifierNode(typeValue.genericName), typeValue.typeArgs.map((typeArg) => typeValueToAst(typeArg)));
        }
        return new IdentifierNode(getMonomorphizedClassName(typeValue));
    }
    return new IdentifierNode(getMonomorphizedFunctionName(typeValue as GenericFunctionInstanceTypeValue));
}

function atomicCaptureReference(name: string, captureEnv: CaptureEnvironment): ClosureExpr {
    if (captureEnv.envParamName && captureEnv.environmentLayout && captureEnv.capturedNames.has(name)) {
        return {
            kind: "object_get_field",
            receiver: { kind: "identifier", name: captureEnv.envParamName },
            className: captureEnv.environmentLayout,
            fieldName: name
        };
    }
    return { kind: "identifier", name };
}

function convertExpr(expr: LoweredExpr, state: ClosureConversionState, program: CapturedMutableCheckedProgram, captureEnv: CaptureEnvironment): ClosureExpr {
    switch (expr.kind) {
        case "identifier":
            return atomicCaptureReference(expr.name, captureEnv);
        case "number_literal":
        case "text_literal":
            return expr;
        case "let":
            let bindingValueTypes = new Map(captureEnv.valueTypes);
            const recursiveFunctionTypes = new Map<string, TypeValue>();
            for (const binding of expr.bindings) {
                if (binding.value.kind === "fn") {
                    recursiveFunctionTypes.set(binding.bind.name, astToTypeValue(binding.bind.typeExp));
                }
            }
            const convertedBindings = expr.bindings.map((binding) => {
                const valueTypesForBinding = binding.value.kind === "fn"
                    ? new Map([...bindingValueTypes, ...recursiveFunctionTypes])
                    : bindingValueTypes;
                const convertedBinding = {
                    bind: binding.bind,
                    value: convertExpr(binding.value, state, program, { ...captureEnv, valueTypes: valueTypesForBinding })
                };
                bindingValueTypes = extendValueTypes(bindingValueTypes, [binding.bind]);
                return convertedBinding;
            });
            return {
                kind: "let",
                bindings: convertedBindings,
                body: convertExpr(expr.body, state, program, { ...captureEnv, valueTypes: bindingValueTypes })
            };
        case "if":
            return {
                kind: "if",
                condExpr: convertExpr(expr.condExpr, state, program, captureEnv),
                trueBranchExpr: convertExpr(expr.trueBranchExpr, state, program, captureEnv),
                falseBranchExpr: convertExpr(expr.falseBranchExpr, state, program, captureEnv)
            };
        case "while":
            return {
                kind: "while",
                condExpr: convertExpr(expr.condExpr, state, program, captureEnv),
                bodyExpr: convertExpr(expr.bodyExpr, state, program, captureEnv)
            };
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => convertExpr(inner, state, program, captureEnv))
            };
        case "set_local":
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value: convertExpr(expr.value, state, program, captureEnv)
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => convertExpr(arg, state, program, captureEnv))
            };
        case "direct_function_ref":
            return expr;
        case "object_alloc":
            return expr;
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: convertExpr(expr.receiver, state, program, captureEnv),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "object_set_field":
            return {
                kind: "object_set_field",
                receiver: convertExpr(expr.receiver, state, program, captureEnv),
                className: expr.className,
                fieldName: expr.fieldName,
                value: convertExpr(expr.value, state, program, captureEnv)
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: convertExpr(expr.value, state, program, captureEnv)
            };
        case "call":
            return {
                kind: "closure_call",
                callee: convertExpr(expr.callee, state, program, captureEnv),
                args: expr.args.map((arg) => convertExpr(arg, state, program, captureEnv))
            };
        case "fn": {
            const siteId = `fn_${state.lambdaCounter}`;
            state.lambdaCounter += 1;
            const analysis = program.analysis.lambdaSites.get(siteId);
            if (!analysis) {
                throw new Error(`Pass 8 closure conversion failed: missing free-var info for lambda site '${siteId}'`);
            }
            const closureId = `closure_${siteId}`;
            const applySymbol = `__iw_closure_apply_${siteId}`;
            const environmentLayout = `__iw_closure_env_${siteId}`;
            const envBinding: LoweredBinding = {
                name: "__env",
                typeExp: new IdentifierNode(environmentLayout)
            };
            const captureTypes = new Map<string, TypeValue>();
            for (const captureName of analysis.freeVariables) {
                const captureType = captureEnv.valueTypes.get(captureName);
                if (!captureType) {
                    throw new Error(`Pass 8 closure conversion failed: missing capture type for '${captureName}' in '${closureId}'`);
                }
                captureTypes.set(captureName, captureType);
            }
            const helperValueTypes = new Map<string, TypeValue>([[envBinding.name, new ClassTypeCtor(environmentLayout)]]);
            captureTypes.forEach((captureType, captureName) => helperValueTypes.set(captureName, captureType));
            const helperCaptureEnv: CaptureEnvironment = {
                envParamName: envBinding.name,
                environmentLayout,
                capturedNames: new Set(analysis.freeVariables),
                valueTypes: extendValueTypes(helperValueTypes, expr.params)
            };
            const helperFunction: ClosureConvertedFunctionDefinition = {
                symbol: applySymbol,
                params: [envBinding, ...expr.params],
                returnType: expr.returnType,
                body: convertExpr(expr.body, state, program, helperCaptureEnv),
                origin: {
                    kind: "closure_apply",
                    closureId
                }
            };
            state.helperDefinitions.push({
                closureId,
                applySymbol,
                environmentLayout,
                captureOrder: analysis.freeVariables,
                captureTypes,
                sourceKind: "lambda"
            });
            state.helperFunctions.push(helperFunction);
            return {
                kind: "closure_create",
                closureId,
                applySymbol,
                environmentLayout,
                captures: analysis.freeVariables.map((name) => atomicCaptureReference(name, captureEnv))
            };
        }
        case "method_closure_create": {
            const siteId = `method_closure_${state.boundMethodCounter}`;
            state.boundMethodCounter += 1;
            const layout = program.layouts.classes.get(expr.className);
            if (!layout) {
                throw new Error(`Pass 8 closure conversion failed: missing class layout '${expr.className}'`);
            }
            const methodType = layout.methodTypes.get(expr.methodName);
            if (!methodType) {
                throw new Error(`Pass 8 closure conversion failed: missing method type for '${expr.className}.${expr.methodName}'`);
            }
            const closureId = `closure_${siteId}`;
            const applySymbol = `__iw_bound_method_apply_${siteId}`;
            const environmentLayout = `__iw_bound_method_env_${siteId}`;
            const envBinding: LoweredBinding = {
                name: "__env",
                typeExp: new IdentifierNode(environmentLayout)
            };
            const selfExpr: ClosureExpr = {
                kind: "object_get_field",
                receiver: { kind: "identifier", name: envBinding.name },
                className: environmentLayout,
                fieldName: "self"
            };
            const paramBindings: LoweredBinding[] = methodType.paramTypes.map((paramType, index) => ({
                name: `arg${index}`,
                typeExp: typeValueToAst(paramType)
            }));
            state.helperDefinitions.push({
                closureId,
                applySymbol,
                environmentLayout,
                captureOrder: ["self"],
                captureTypes: new Map([["self", new ClassTypeCtor(expr.className)]]),
                sourceKind: "bound_method"
            });
            state.helperFunctions.push({
                symbol: applySymbol,
                params: [envBinding, ...paramBindings],
                returnType: typeValueToAst(methodType.returnType),
                body: {
                    kind: "direct_call",
                    symbol: expr.methodSymbol,
                    args: [selfExpr, ...paramBindings.map((binding) => ({ kind: "identifier", name: binding.name } as ClosureExpr))]
                },
                origin: {
                    kind: "closure_apply",
                    closureId,
                    className: expr.className,
                    methodName: expr.methodName
                }
            });
            return {
                kind: "closure_create",
                closureId,
                applySymbol,
                environmentLayout,
                captures: [convertExpr(expr.receiver, state, program, captureEnv)]
            };
        }
        case "match":
            return {
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr: convertExpr(expr.unionExpr, state, program, captureEnv),
                branches: expr.branches.map((branch) => ({
                    bind: branch.bind,
                    memberTypeTagId: branch.memberTypeTagId,
                    body: convertExpr(branch.body, state, program, captureEnv)
                }))
            };
        case "cond":
        case "dvar":
            throw new Error(`Pass 8 closure conversion failed: unexpected node kind '${expr.kind}'`);
    }
}

function validateClosureExpr(expr: ClosureExpr): void {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return;
        case "let":
            expr.bindings.forEach((binding) => validateClosureExpr(binding.value));
            validateClosureExpr(expr.body);
            return;
        case "if":
            validateClosureExpr(expr.condExpr);
            validateClosureExpr(expr.trueBranchExpr);
            validateClosureExpr(expr.falseBranchExpr);
            return;
        case "seq":
            expr.expressions.forEach((inner) => validateClosureExpr(inner));
            return;
        case "set_local":
            validateClosureExpr(expr.value);
            return;
        case "direct_call":
            expr.args.forEach((arg) => validateClosureExpr(arg));
            return;
        case "object_get_field":
            validateClosureExpr(expr.receiver);
            return;
        case "object_set_field":
            validateClosureExpr(expr.receiver);
            validateClosureExpr(expr.value);
            return;
        case "union_inject":
            validateClosureExpr(expr.value);
            return;
        case "closure_create":
            expr.captures.forEach((capture) => validateClosureExpr(capture));
            return;
        case "closure_call":
            validateClosureExpr(expr.callee);
            expr.args.forEach((arg) => validateClosureExpr(arg));
            return;
        case "match":
            validateClosureExpr(expr.unionExpr);
            expr.branches.forEach((branch) => validateClosureExpr(branch.body));
            return;
    }
}

export function validateNoOptimizeClosureConvertedProgram(program: ClosureConvertedProgram): void {
    for (const statement of program.topLevelStatements) {
        validateClosureExpr(statement);
    }
    for (const fn of program.functions) {
        validateClosureExpr(fn.body);
    }
    for (const helper of program.closureHelpers) {
        const applyCount = program.functions.filter((fn) => fn.symbol === helper.applySymbol).length;
        if (applyCount !== 1) {
            throw new Error(`Pass 8 closure conversion validation failed: expected exactly one helper function for '${helper.applySymbol}'`);
        }
    }
}

export function noOptimizeClosureConvertPass(program: CapturedMutableCheckedProgram): ClosureConvertedProgram {
    const state: ClosureConversionState = {
        lambdaCounter: 0,
        boundMethodCounter: 0,
        helperDefinitions: [],
        helperFunctions: []
    };
    const convertedProgram: ClosureConvertedProgram = {
        kind: "closure_converted_program",
        topLevelStatements: program.topLevelStatements.map((statement) => convertExpr(statement, state, program, { capturedNames: new Set(), valueTypes: new Map() })),
        globals: program.globals,
        functions: [
            ...program.functions.map((fn): ClosureConvertedFunctionDefinition => ({
                symbol: fn.symbol,
                params: fn.params,
                returnType: fn.returnType,
                body: convertExpr(fn.body, state, program, { capturedNames: new Set(), valueTypes: extendValueTypes(new Map(), fn.params) }),
                origin: fn.origin
            })),
            ...state.helperFunctions
        ],
        declaredFunctions: program.declaredFunctions,
        closureHelpers: state.helperDefinitions,
        layouts: program.layouts,
        metadata: program.metadata
    };
    validateNoOptimizeClosureConvertedProgram(convertedProgram);
    return convertedProgram;
}
