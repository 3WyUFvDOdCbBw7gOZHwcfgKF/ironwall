import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    CondNode,
    DvarNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    IdentifierNode,
    IfNode,
    WhileNode,
    LetNode,
    MatchNode,
    NumberLiteralNode,
    TextDatabaseReferenceNode,
    SeqNode,
    SetNode,
    TypeToFromNode,
    TypeUnionNode,
    TypeVarBindNode
} from "./AstNode";
import {
    astToTypeValue,
    getMonomorphizedClassName,
    getMonomorphizedFunctionName,
    typecheck,
    VarEnv,
    toplevelFunctionEnv
} from "./Typecheck-Pipeline";
import { getResolvedGenericFunctionInfo, getVisibleResolvedFunctionOverloads } from "./Typecheck-Pass-2-ResolveHeaders";
import { getVisibleClassInfo } from "./Typecheck-Definitions";
import {
    ClassTypeValue,
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    GenericFunctionInstanceTypeValue,
    GenericTypeEnv,
    PrimitiveTypeValue,
    TypeParameterValue,
    UnionTypeValue,
    builtinGenericTypeNames,
    getVisibleGlobalVarInfo,
    getRuntimeTypeId,
    getUnionTypeId,
    isAssignable,
    substituteTypeVariables,
    typeEqual,
    type TypeValue
} from "./Typecheck-Core";
import type {
    LoweredBinding,
    LoweredClassDefinition,
    LoweredClassPrimitiveProgram,
    LoweredConstructorDefinition,
    LoweredExpr,
    LoweredFunctionDefinition,
    LoweredLetBinding,
    LoweredMethodDefinition,
    LoweringClassLayout,
    LoweringConstructorLayout,
    LoweringLayoutTable,
    LoweringSnapshotProgram
} from "./Lowering-Frontend-Shared";

interface LoweringEnvironment {
    readonly variableClasses: Map<string, string>;
    readonly variableTypes: Map<string, TypeValue>;
    readonly localBindings: Set<string>;
    readonly functionSymbols: ReadonlySet<string>;
}

interface LoweringContext {
    readonly layouts: LoweringLayoutTable;
    readonly functionSymbols: ReadonlySet<string>;
    readonly callableTargetsBySourceName: ReadonlyMap<string, readonly CallableTarget[]>;
    readonly globalTypes: ReadonlyMap<string, TypeValue>;
    tempCounter: number;
}

interface CallableTarget {
    readonly sourceName: string;
    readonly symbol: string;
    readonly functionType: FunctionTypeValue;
}

interface BuiltinDirectCallSpec {
    readonly arity: number;
    readonly typeNames: readonly string[];
}

const BUILTIN_DIRECT_CALL_SPECS: Readonly<Record<string, BuiltinDirectCallSpec>> = {
    add: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] },
    sub: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] },
    mul: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] },
    div: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] },
    mod: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] },
    le: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7", "c3", "c4", "c5"] },
    lt: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7", "c3", "c4", "c5"] },
    ge: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7", "c3", "c4", "c5"] },
    gt: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7", "c3", "c4", "c5"] },
    eq: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7", "c3", "c4", "c5"] },
    neq: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7", "c3", "c4", "c5"] },
    bwand: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7"] },
    bwor: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7"] },
    bwxor: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7"] },
    ls: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7"] },
    rs: { arity: 2, typeNames: ["i5", "i6", "i7", "u5", "u6", "u7"] },
    and: { arity: 2, typeNames: ["bool"] },
    or: { arity: 2, typeNames: ["bool"] },
    xor: { arity: 2, typeNames: ["bool"] },
    not: { arity: 1, typeNames: ["bool"] },
};

const SCALAR_CONVERSION_TARGET_TYPE_NAMES = ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] as const;
const SCALAR_CONVERSION_NUMERIC_SOURCE_TYPE_NAMES = ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] as const;
const SCALAR_CONVERSION_CHAR_SOURCE_TYPE_NAMES = ["c3", "c4", "c5"] as const;

function isBuiltinDirectCallName(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(BUILTIN_DIRECT_CALL_SPECS, name);
}

function buildBuiltinDirectCallType(name: string, typeName: string): FunctionTypeValue {
    const paramType = new PrimitiveTypeValue(typeName);
    const paramTypes: PrimitiveTypeValue[] = name === "not"
        ? [paramType]
        : [paramType, paramType];
    const returnType = ["le", "lt", "ge", "gt", "eq", "neq", "and", "or", "xor", "not"].includes(name)
        ? new PrimitiveTypeValue("bool")
        : paramType;
    return new FunctionTypeValue(paramTypes, returnType);
}

function builtinDirectCallSymbol(name: string, typeName: string): string {
    if (typeName === "bool" && ["and", "or", "xor", "not"].includes(name)) {
        return name;
    }
    return `__iw_builtin_${name}_${typeName}`;
}

function resolveBuiltinDirectCall(name: string, args: readonly AstNode[], env: LoweringEnvironment): { readonly symbol: string; readonly functionType: FunctionTypeValue } | undefined {
    const spec: BuiltinDirectCallSpec | undefined = BUILTIN_DIRECT_CALL_SPECS[name];
    if (!spec || args.length !== spec.arity) {
        return undefined;
    }
    const argumentTypes = args.map((arg) => inferOverloadResolutionArgType(arg, env));
    const matches: string[] = spec.typeNames.filter((typeName) => {
        const expected = new PrimitiveTypeValue(typeName);
        return argumentTypes.every((argumentType) => isAssignable(argumentType, expected));
    });
    if (matches.length === 1) {
        const typeName = matches[0];
        return {
            symbol: builtinDirectCallSymbol(name, typeName),
            functionType: buildBuiltinDirectCallType(name, typeName)
        };
    }
    if (matches.length > 1) {
        throw new Error(`Pass 2 class primitive lowering failed: ambiguous builtin call '${name}'`);
    }
    return undefined;
}

function resolveScalarConversionDirectCall(name: string, args: readonly AstNode[], env: LoweringEnvironment): { readonly symbol: string; readonly functionType: FunctionTypeValue } | undefined {
    if (args.length !== 1) {
        return undefined;
    }

    const valueConversionMatch: RegExpMatchArray | null = name.match(/^val_to_([a-z0-9]+)$/);
    const binaryConversionMatch: RegExpMatchArray | null = name.match(/^bin_to_([a-z0-9]+)$/);
    const targetTypeName: string | undefined = valueConversionMatch?.[1] ?? binaryConversionMatch?.[1];
    if (targetTypeName === undefined || !SCALAR_CONVERSION_TARGET_TYPE_NAMES.includes(targetTypeName as typeof SCALAR_CONVERSION_TARGET_TYPE_NAMES[number])) {
        return undefined;
    }

    const sourceType: TypeValue = inferOverloadResolutionArgType(args[0], env);
    if (!(sourceType instanceof PrimitiveTypeValue)) {
        return undefined;
    }
    if (
        !SCALAR_CONVERSION_NUMERIC_SOURCE_TYPE_NAMES.includes(sourceType.name as typeof SCALAR_CONVERSION_NUMERIC_SOURCE_TYPE_NAMES[number])
        && !((targetTypeName === "i5" || targetTypeName === "u5")
            && SCALAR_CONVERSION_CHAR_SOURCE_TYPE_NAMES.includes(sourceType.name as typeof SCALAR_CONVERSION_CHAR_SOURCE_TYPE_NAMES[number]))
    ) {
        return undefined;
    }

    return {
        symbol: `${valueConversionMatch !== null ? "iw_ty_to" : "iw_bin_to"}_${targetTypeName}_${sourceType.name}`,
        functionType: new FunctionTypeValue([new PrimitiveTypeValue(sourceType.name)], new PrimitiveTypeValue(targetTypeName))
    };
}

interface TextPrimitiveBuiltinFamilySpec {
    readonly stringTypeName: "s3" | "s4" | "s5";
    readonly charTypeName: "c3" | "c4" | "c5";
}

interface ComplexPrimitiveBuiltinFamilySpec {
    readonly complexTypeName: "z5" | "z6" | "z7";
    readonly componentTypeName: "f5" | "f6" | "f7";
}

const TEXT_PRIMITIVE_BUILTIN_FAMILIES: readonly TextPrimitiveBuiltinFamilySpec[] = [
    { stringTypeName: "s3", charTypeName: "c3" },
    { stringTypeName: "s4", charTypeName: "c4" },
    { stringTypeName: "s5", charTypeName: "c5" }
];

const COMPLEX_PRIMITIVE_BUILTIN_FAMILIES: readonly ComplexPrimitiveBuiltinFamilySpec[] = [
    { complexTypeName: "z5", componentTypeName: "f5" },
    { complexTypeName: "z6", componentTypeName: "f6" },
    { complexTypeName: "z7", componentTypeName: "f7" }
];

function getTextPrimitiveBuiltinFamilySpec(name: string): TextPrimitiveBuiltinFamilySpec | undefined {
    for (const family of TEXT_PRIMITIVE_BUILTIN_FAMILIES) {
        if (
            name === `${family.stringTypeName}_new`
            || name === `${family.stringTypeName}_get`
            || name === `${family.stringTypeName}_set`
            || name === `${family.stringTypeName}_length`
        ) {
            return family;
        }
    }
    return undefined;
}

function getComplexPrimitiveBuiltinFamilySpec(name: string): ComplexPrimitiveBuiltinFamilySpec | undefined {
    for (const family of COMPLEX_PRIMITIVE_BUILTIN_FAMILIES) {
        if (
            name === `${family.complexTypeName}_new`
            || name === `${family.complexTypeName}_set`
            || name === `${family.complexTypeName}_real`
            || name === `${family.complexTypeName}_img`
        ) {
            return family;
        }
    }
    return undefined;
}

const ZERO_ARG_TEXT_DEFAULT_CONTENT = "default string";
const ZERO_ARG_ARRAY_DEFAULT_LENGTH = 5;
const ZERO_ARG_COMPLEX_DEFAULT_COMPONENT = 19;

function buildZeroArgTextLiteral(stringTypeName: "s3" | "s4" | "s5"): LoweredExpr {
    return {
        kind: "text_literal",
        typeName: stringTypeName,
        referenceName: `__iw_builtin_${stringTypeName}_zero_arg_default`,
        content: ZERO_ARG_TEXT_DEFAULT_CONTENT
    };
}

function typeValueToTypeAst(typeValue: TypeValue): AstNode {
    if (typeValue instanceof PrimitiveTypeValue) {
        return new IdentifierNode(typeValue.name);
    }
    if (typeValue instanceof ClassTypeValue) {
        return new IdentifierNode(typeValue.className);
    }
    if (typeValue instanceof GenericClassInstanceTypeValue) {
        if (!builtinGenericTypeNames.has(typeValue.genericName)) {
            return typeValueToTypeAst(materializeRuntimeType(typeValue));
        }
        return new GenericCallNode(
            new IdentifierNode(typeValue.genericName),
            typeValue.typeArgs.map((typeArg) => typeValueToTypeAst(typeArg))
        );
    }
    if (typeValue instanceof FunctionTypeValue) {
        return new TypeToFromNode(
            typeValueToTypeAst(typeValue.returnType),
            typeValue.paramTypes.map((paramType) => typeValueToTypeAst(paramType))
        );
    }
    if (typeValue instanceof UnionTypeValue) {
        return new TypeUnionNode(typeValue.types.map((member) => typeValueToTypeAst(member)));
    }
    throw new Error("Pass 2 class primitive lowering failed: unsupported type AST reconstruction");
}

function lowerZeroArgClassValue(className: string, context: LoweringContext): LoweredExpr {
    const layout = context.layouts.classes.get(className);
    if (!layout) {
        throw new Error(`Pass 2 class primitive lowering failed: missing layout for class '${className}'`);
    }
    const zeroArgConstructor = resolveZeroArgConstructorLayout(className, layout.constructors);
    const tempName = freshTemporary(context);
    const tempReference: LoweredExpr = { kind: "identifier", name: tempName };
    return {
        kind: "let",
        bindings: [{
            bind: { name: tempName, typeExp: new IdentifierNode(className) },
            value: { kind: "object_alloc", className }
        }],
        body: {
            kind: "seq",
            expressions: [
                {
                    kind: "direct_call",
                    symbol: zeroArgConstructor.symbol,
                    args: [tempReference]
                },
                tempReference
            ]
        }
    };
}

function lowerArrayNewWithZeroArgInitialization(
    arrayType: GenericClassInstanceTypeValue,
    env: LoweringEnvironment,
    context: LoweringContext
): LoweredExpr {
    const arrayTypeNode = typeValueToTypeAst(arrayType);
    const elementTypeNode = typeValueToTypeAst(arrayType.typeArgs[0]);
    const lengthName = freshTemporary(context);
    const seedName = freshTemporary(context);
    const rawName = freshTemporary(context);
    const indexName = freshTemporary(context);
    const i5Type = new IdentifierNode("i5");
    const zeroI5: LoweredExpr = { kind: "number_literal", value: 0, typeName: "i5" };
    const oneI5: LoweredExpr = { kind: "number_literal", value: 1, typeName: "i5" };
    const lengthRef: LoweredExpr = { kind: "identifier", name: lengthName };
    const seedRef: LoweredExpr = { kind: "identifier", name: seedName };
    const rawRef: LoweredExpr = { kind: "identifier", name: rawName };
    const indexRef: LoweredExpr = { kind: "identifier", name: indexName };

    return {
        kind: "let",
        bindings: [
            {
                bind: { name: lengthName, typeExp: i5Type },
                value: { kind: "number_literal", value: ZERO_ARG_ARRAY_DEFAULT_LENGTH, typeName: "i5" }
            },
            {
                bind: { name: seedName, typeExp: elementTypeNode },
                value: lowerZeroArgConstructedValue(arrayType.typeArgs[0], env, context)
            },
            {
                bind: { name: rawName, typeExp: arrayTypeNode },
                value: {
                    kind: "direct_call",
                    symbol: "array_new",
                    args: [lengthRef, seedRef]
                }
            }
        ],
        body: {
            kind: "seq",
            expressions: [
                {
                    kind: "dvar",
                    bind: { name: indexName, typeExp: i5Type },
                    value: zeroI5
                },
                {
                    kind: "while",
                    condExpr: {
                        kind: "direct_call",
                        symbol: "__iw_builtin_lt_i5",
                        args: [indexRef, lengthRef]
                    },
                    bodyExpr: {
                        kind: "seq",
                        expressions: [
                            {
                                kind: "direct_call",
                                symbol: "array_set",
                                args: [
                                    rawRef,
                                    indexRef,
                                    lowerZeroArgConstructedValue(arrayType.typeArgs[0], env, context)
                                ]
                            },
                            {
                                kind: "set_local",
                                identifier: indexName,
                                value: {
                                    kind: "direct_call",
                                    symbol: "__iw_builtin_add_i5",
                                    args: [indexRef, oneI5]
                                }
                            }
                        ]
                    }
                },
                rawRef
            ]
        }
    };
}

function lowerZeroArgConstructedValue(typeValue: TypeValue, env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (typeValue instanceof PrimitiveTypeValue) {
        if (typeValue.name === "s3" || typeValue.name === "s4" || typeValue.name === "s5") {
            return {
                kind: "direct_call",
                symbol: `${typeValue.name}_new_copy`,
                args: [buildZeroArgTextLiteral(typeValue.name)]
            };
        }
        if (typeValue.name === "z5") {
            return {
                kind: "direct_call",
                symbol: "iw_z5_rect",
                args: [
                    { kind: "number_literal", value: ZERO_ARG_COMPLEX_DEFAULT_COMPONENT, typeName: "f5" },
                    { kind: "number_literal", value: ZERO_ARG_COMPLEX_DEFAULT_COMPONENT, typeName: "f5" }
                ]
            };
        }
        if (typeValue.name === "z6") {
            return {
                kind: "direct_call",
                symbol: "iw_z6_rect",
                args: [
                    { kind: "number_literal", value: ZERO_ARG_COMPLEX_DEFAULT_COMPONENT, typeName: "f6" },
                    { kind: "number_literal", value: ZERO_ARG_COMPLEX_DEFAULT_COMPONENT, typeName: "f6" }
                ]
            };
        }
        if (typeValue.name === "z7") {
            return {
                kind: "direct_call",
                symbol: "iw_z7_rect",
                args: [
                    { kind: "number_literal", value: ZERO_ARG_COMPLEX_DEFAULT_COMPONENT, typeName: "f7" },
                    { kind: "number_literal", value: ZERO_ARG_COMPLEX_DEFAULT_COMPONENT, typeName: "f7" }
                ]
            };
        }
    }
    if (typeValue instanceof GenericClassInstanceTypeValue && typeValue.genericName === "array" && typeValue.typeArgs.length === 1) {
        return lowerArrayNewWithZeroArgInitialization(typeValue, env, context);
    }
    const className = classNameFromTypeValue(typeValue);
    if (className) {
        return lowerZeroArgClassValue(className, context);
    }
    throw new Error("Pass 2 class primitive lowering failed: zero-arg constructor lowering is unsupported for this type");
}

function lowerTextPrimitiveBuiltinCall(node: FunctionCallNode, env: LoweringEnvironment, context: LoweringContext): LoweredExpr | undefined {
    if (!(node.callee instanceof IdentifierNode)) {
        return undefined;
    }
    const family = getTextPrimitiveBuiltinFamilySpec(node.callee.name);
    if (!family) {
        return undefined;
    }
    const stringType = new PrimitiveTypeValue(family.stringTypeName);
    const charType = new PrimitiveTypeValue(family.charTypeName);

    if (node.callee.name === `${family.stringTypeName}_new`) {
        if (node.args.length === 0) {
            return lowerZeroArgConstructedValue(stringType, env, context);
        }
        if (node.args.length === 1) {
            return {
                kind: "direct_call",
                symbol: `${family.stringTypeName}_new_copy`,
                args: [lowerExprWithExpectedType(node.args[0], stringType, env, context)]
            };
        }
        if (node.args.length === 2) {
            return {
                kind: "direct_call",
                symbol: `${family.stringTypeName}_new_fill`,
                args: [
                    lowerExprWithExpectedType(node.args[0], new PrimitiveTypeValue("i5"), env, context),
                    lowerExprWithExpectedType(node.args[1], charType, env, context)
                ]
            };
        }
        throw new Error(`Pass 2 class primitive lowering failed: ${node.callee.name} expects 0, 1, or 2 arguments`);
    }

    if (node.callee.name === `${family.stringTypeName}_get`) {
        if (node.args.length !== 2) {
            throw new Error(`Pass 2 class primitive lowering failed: ${node.callee.name} expects string and index`);
        }
        return {
            kind: "direct_call",
            symbol: `${family.stringTypeName}_get`,
            args: [
                lowerExprWithExpectedType(node.args[0], stringType, env, context),
                lowerExprWithExpectedType(node.args[1], new PrimitiveTypeValue("i5"), env, context)
            ]
        };
    }

    if (node.callee.name === `${family.stringTypeName}_set`) {
        if (node.args.length !== 3) {
            throw new Error(`Pass 2 class primitive lowering failed: ${node.callee.name} expects string, index, and char`);
        }
        return {
            kind: "direct_call",
            symbol: `${family.stringTypeName}_set`,
            args: [
                lowerExprWithExpectedType(node.args[0], stringType, env, context),
                lowerExprWithExpectedType(node.args[1], new PrimitiveTypeValue("i5"), env, context),
                lowerExprWithExpectedType(node.args[2], charType, env, context)
            ]
        };
    }

    if (node.callee.name === `${family.stringTypeName}_length`) {
        if (node.args.length !== 1) {
            throw new Error(`Pass 2 class primitive lowering failed: ${node.callee.name} expects exactly one argument`);
        }
        return {
            kind: "direct_call",
            symbol: `${family.stringTypeName}_length`,
            args: [lowerExprWithExpectedType(node.args[0], stringType, env, context)]
        };
    }

    return undefined;
}

function lowerComplexPrimitiveBuiltinCall(node: FunctionCallNode, env: LoweringEnvironment, context: LoweringContext): LoweredExpr | undefined {
    if (!(node.callee instanceof IdentifierNode)) {
        return undefined;
    }
    const family = getComplexPrimitiveBuiltinFamilySpec(node.callee.name);
    if (!family) {
        return undefined;
    }
    const complexType = new PrimitiveTypeValue(family.complexTypeName);
    const componentType = new PrimitiveTypeValue(family.componentTypeName);

    if (node.callee.name === `${family.complexTypeName}_new`) {
        if (node.args.length === 0) {
            return lowerZeroArgConstructedValue(complexType, env, context);
        }
        if (node.args.length === 1) {
            return {
                kind: "direct_call",
                symbol: `${family.complexTypeName}_new`,
                args: [lowerExprWithExpectedType(node.args[0], complexType, env, context)]
            };
        }
        throw new Error(`Pass 2 class primitive lowering failed: ${node.callee.name} expects 0 or 1 arguments`);
    }

    if (node.callee.name === `${family.complexTypeName}_set`) {
        if (node.args.length === 2) {
            return {
                kind: "direct_call",
                symbol: `${family.complexTypeName}_set_value`,
                args: [
                    lowerExprWithExpectedType(node.args[0], complexType, env, context),
                    lowerExprWithExpectedType(node.args[1], complexType, env, context)
                ]
            };
        }
        if (node.args.length === 3) {
            return {
                kind: "direct_call",
                symbol: `${family.complexTypeName}_set_parts`,
                args: [
                    lowerExprWithExpectedType(node.args[0], complexType, env, context),
                    lowerExprWithExpectedType(node.args[1], componentType, env, context),
                    lowerExprWithExpectedType(node.args[2], componentType, env, context)
                ]
            };
        }
        throw new Error(`Pass 2 class primitive lowering failed: ${node.callee.name} expects either 2 or 3 arguments`);
    }

    if (node.callee.name === `${family.complexTypeName}_real` || node.callee.name === `${family.complexTypeName}_img`) {
        if (node.args.length !== 1) {
            throw new Error(`Pass 2 class primitive lowering failed: ${node.callee.name} expects exactly one argument`);
        }
        return {
            kind: "direct_call",
            symbol: node.callee.name,
            args: [lowerExprWithExpectedType(node.args[0], complexType, env, context)]
        };
    }

    return undefined;
}

function lowerNumericLiteral(value: number, typeName: string): LoweredExpr {
    return { kind: "number_literal", value, typeName };
}

function lowerComplexLiteral(node: NumberLiteralNode, env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (typeof node.value === "number") {
        throw new Error(`Pass 2 class primitive lowering failed: unsupported complex literal '${node.raw}'`);
    }

    const componentTypeName = node.typeName === "z5"
        ? "f5"
        : node.typeName === "z6"
            ? "f6"
            : node.typeName === "z7"
                ? "f7"
                : null;
    const rectBuiltinName = node.typeName === "z5"
        ? "iw_z5_rect"
        : node.typeName === "z6"
            ? "iw_z6_rect"
            : node.typeName === "z7"
                ? "iw_z7_rect"
                : null;
    if (componentTypeName === null || rectBuiltinName === null) {
        throw new Error(`Pass 2 class primitive lowering failed: unsupported complex literal '${node.raw}'`);
    }

    return {
        kind: "direct_call",
        symbol: rectBuiltinName,
        args: [
            lowerExprWithExpectedType(new NumberLiteralNode(componentTypeName, node.value.real, `$${node.value.realRaw}^${componentTypeName}`), new PrimitiveTypeValue(componentTypeName), env, context),
            lowerExprWithExpectedType(new NumberLiteralNode(componentTypeName, node.value.imag, `$${node.value.imagRaw}^${componentTypeName}`), new PrimitiveTypeValue(componentTypeName), env, context)
        ]
    };
}

function resolveLoweredNumberLiteralType(node: NumberLiteralNode, expectedType?: TypeValue): string {
    void expectedType;
    return node.typeName;
}

function cloneEnvironment(env: LoweringEnvironment): LoweringEnvironment {
    return {
        variableClasses: new Map(env.variableClasses),
        variableTypes: new Map(env.variableTypes),
        localBindings: new Set(env.localBindings),
        functionSymbols: env.functionSymbols
    };
}

function freshTemporary(context: LoweringContext): string {
    const nextValue = context.tempCounter;
    context.tempCounter += 1;
    return `__iw_lower_tmp_${nextValue}`;
}

function typeValueToConcreteTypeAst(typeValue: TypeValue): AstNode {
    if (typeValue instanceof PrimitiveTypeValue) {
        return new IdentifierNode(typeValue.name);
    }
    if (typeValue instanceof TypeParameterValue) {
        throw new Error(`Pass 2 class primitive lowering failed: expected concrete type, found type parameter '${typeValue.name}'`);
    }
    if (typeValue instanceof ClassTypeValue) {
        return new IdentifierNode(typeValue.className);
    }
    if (typeValue instanceof FunctionTypeValue) {
        return new TypeToFromNode(
            typeValueToConcreteTypeAst(typeValue.returnType),
            typeValue.paramTypes.map((paramType) => typeValueToConcreteTypeAst(paramType))
        );
    }
    if (typeValue instanceof UnionTypeValue) {
        return new TypeUnionNode(
            typeValue.types.map((member) => typeValueToConcreteTypeAst(member))
        );
    }
    if (typeValue instanceof GenericClassInstanceTypeValue) {
        if (builtinGenericTypeNames.has(typeValue.genericName)) {
            return new GenericCallNode(
                new IdentifierNode(typeValue.genericName),
                typeValue.typeArgs.map((typeArg) => typeValueToConcreteTypeAst(typeArg))
            );
        }
        return new IdentifierNode(getMonomorphizedClassName(normalizeRuntimeGenericClassInstance(typeValue)));
    }
    return new IdentifierNode(getMonomorphizedFunctionName(normalizeRuntimeGenericFunctionInstance(typeValue)));
}

function concretizeTypeAst(typeExp: AstNode): AstNode {
    return typeValueToConcreteTypeAst(astToTypeValue(typeExp));
}

function lowerBinding(bind: TypeVarBindNode): LoweredBinding {
    return {
        name: bind.var.name,
        typeExp: concretizeTypeAst(bind.typeExp)
    };
}

function lowerBindingWithType(bind: TypeVarBindNode, type: TypeValue): LoweredBinding {
    return {
        name: bind.var.name,
        typeExp: typeValueToConcreteTypeAst(materializeRuntimeType(type))
    };
}

function buildTypecheckVarEnv(env: LoweringEnvironment): VarEnv {
    const varEnv = new VarEnv();
    for (const [name, type] of env.variableTypes.entries()) {
        varEnv.set(name, type);
    }
    return varEnv;
}

function inferNodeType(node: AstNode, env: LoweringEnvironment): TypeValue {
    return typecheck(node, buildTypecheckVarEnv(env), toplevelFunctionEnv, new GenericTypeEnv());
}

function normalizeRuntimeGenericClassInstance(type: GenericClassInstanceTypeValue): GenericClassInstanceTypeValue {
    return new GenericClassInstanceTypeValue(
        type.genericName,
        type.typeArgs.map((typeArg) => materializeRuntimeType(typeArg))
    );
}

function normalizeRuntimeGenericFunctionInstance(type: GenericFunctionInstanceTypeValue): GenericFunctionInstanceTypeValue {
    return new GenericFunctionInstanceTypeValue(
        type.genericName,
        type.typeArgs.map((typeArg) => materializeRuntimeType(typeArg))
    );
}

function materializeRuntimeType(type: TypeValue): TypeValue {
    if (type instanceof GenericFunctionInstanceTypeValue) {
        const resolvedGenericFunction = getResolvedGenericFunctionInfo(type.genericName, type.typeArgs.length);
        if (!resolvedGenericFunction) {
            throw new Error(`Pass 2 class primitive lowering failed: unknown generic function '${type.genericName}'`);
        }
        const substitutions = new Map<string, TypeValue>();
        for (let index = 0; index < resolvedGenericFunction.typeParams.length; index += 1) {
            substitutions.set(resolvedGenericFunction.typeParams[index], type.typeArgs[index]);
        }
        return materializeRuntimeType(substituteTypeVariables(resolvedGenericFunction.functionType, substitutions));
    }

    if (type instanceof FunctionTypeValue) {
        return new FunctionTypeValue(
            type.paramTypes.map((paramType) => materializeRuntimeType(paramType)),
            materializeRuntimeType(type.returnType)
        );
    }

    if (type instanceof GenericClassInstanceTypeValue) {
        if (builtinGenericTypeNames.has(type.genericName)) {
            return normalizeRuntimeGenericClassInstance(type);
        }
        return new ClassTypeValue(getMonomorphizedClassName(normalizeRuntimeGenericClassInstance(type)));
    }

    if (type instanceof UnionTypeValue) {
        return new UnionTypeValue(type.types.map((member) => materializeRuntimeType(member)));
    }

    return type;
}

function inferOverloadResolutionArgType(node: AstNode, env: LoweringEnvironment): TypeValue {
    if (node instanceof TextDatabaseReferenceNode) {
        return new PrimitiveTypeValue(node.typeName);
    }
    return materializeRuntimeType(inferNodeType(node, env));
}

function lowerExprWithExpectedType(node: AstNode, expectedType: TypeValue, env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (node instanceof NumberLiteralNode) {
        if (typeof node.value !== "number") {
            return lowerComplexLiteral(node, env, context);
        }
        const literalTypeName = resolveLoweredNumberLiteralType(node, expectedType);
        const literalExpr = lowerNumericLiteral(node.value, literalTypeName);
        const concreteExpectedType = materializeRuntimeType(expectedType);
        if (concreteExpectedType instanceof UnionTypeValue) {
            const literalType = new PrimitiveTypeValue(literalTypeName);
            const matchedMember = concreteExpectedType.types.find((member) => typeEqual(member, literalType));
            if (matchedMember) {
                return {
                    kind: "union_inject",
                    unionTypeTagId: getUnionTypeId(concreteExpectedType),
                    memberTypeTagId: getRuntimeTypeId(literalType),
                    value: literalExpr
                };
            }
        }
        return literalExpr;
    }
    if (node instanceof IdentifierNode && !env.localBindings.has(node.name) && expectedType instanceof FunctionTypeValue) {
        const resolvedTarget = resolveCallableTargetByExpectedType(node, node.name, expectedType, context);
        if (resolvedTarget) {
            return { kind: "direct_function_ref", symbol: resolvedTarget.symbol };
        }
    }

    if (node instanceof IfNode) {
        return {
            kind: "if",
            condExpr: lowerExpr(node.condExpr, env, context),
            trueBranchExpr: lowerExprWithExpectedType(node.trueBranchExpr, expectedType, env, context),
            falseBranchExpr: lowerExprWithExpectedType(node.falseBranchExpr, expectedType, env, context)
        };
    }

    if (node instanceof CondNode) {
        return {
            kind: "cond",
            clauses: node.clausesExprs.map((clause) => ({
                cond: lowerExpr(clause.cond, env, context),
                body: lowerExprWithExpectedType(clause.body, expectedType, env, context)
            }))
        };
    }

    if (node instanceof LetNode) {
        const bodyEnv = cloneEnvironment(env);
        const recursiveFunctions = collectLetRecursiveFunctionTypes(node.bindings, env);
        const bindings: LoweredLetBinding[] = node.bindings.map((binding) => {
            if (!(binding.bind instanceof TypeVarBindNode)) {
                throw new Error("Pass 2 class primitive lowering failed: let bind must use TypeVarBindNode");
            }
            const boundType = bindTypeFromAnnotation(binding.bind, binding.value, bodyEnv);
            const loweredBind = lowerBindingWithType(binding.bind, boundType);
            const bindingValueEnv = binding.value instanceof FnNode
                ? extendEnvironmentWithRecursiveFunctions(bodyEnv, recursiveFunctions)
                : bodyEnv;
            bodyEnv.localBindings.add(loweredBind.name);
            bodyEnv.variableTypes.set(loweredBind.name, boundType);
            const boundClassName = classNameFromTypeValue(materializeRuntimeType(boundType));
            if (boundClassName) {
                bodyEnv.variableClasses.set(loweredBind.name, boundClassName);
            }
            return {
                bind: loweredBind,
                value: lowerExprWithExpectedType(binding.value, boundType, bindingValueEnv, context)
            };
        });
        return {
            kind: "let",
            bindings,
            body: lowerExprWithExpectedType(node.body, expectedType, bodyEnv, context)
        };
    }

    if (node instanceof SeqNode) {
        const loweredExpressions: LoweredExpr[] = [];
        let currentEnv = cloneEnvironment(env);
        for (let index = 0; index < node.expressions.length; index += 1) {
            const expression = node.expressions[index];
            const isLast = index === node.expressions.length - 1;
            loweredExpressions.push(isLast
                ? lowerExprWithExpectedType(expression, expectedType, currentEnv, context)
                : lowerExpr(expression, currentEnv, context));
            if (expression instanceof DvarNode) {
                if (!(expression.bind instanceof TypeVarBindNode)) {
                    throw new Error("Pass 2 class primitive lowering failed: dvar bind must use TypeVarBindNode");
                }
                currentEnv.localBindings.add(expression.bind.var.name);
                currentEnv.variableTypes.set(expression.bind.var.name, bindTypeFromAnnotation(expression.bind, expression.value, currentEnv));
                const boundClassName = maybeResolveBoundClassName(expression.bind.typeExp);
                if (boundClassName) {
                    currentEnv.variableClasses.set(expression.bind.var.name, boundClassName);
                }
            }
        }
        return { kind: "seq", expressions: loweredExpressions };
    }

    if (node instanceof MatchNode) {
        const unionType = inferNodeType(node.unionExpr, env);
        if (!(unionType instanceof UnionTypeValue)) {
            throw new Error("Pass 2 class primitive lowering failed: match target must be a union type");
        }
        return {
            kind: "match",
            unionTypeTagId: getUnionTypeId(unionType),
            unionExpr: lowerExpr(node.unionExpr, env, context),
            branches: node.branches.map((branch) => ({
                bind: lowerBinding(branch.bind),
                memberTypeTagId: getRuntimeTypeId(astToTypeValue(branch.bind.typeExp)),
                body: lowerExprWithExpectedType(branch.body, expectedType, (() => {
                    const branchEnv = cloneEnvironment(env);
                    branchEnv.localBindings.add(branch.bind.var.name);
                    branchEnv.variableTypes.set(branch.bind.var.name, astToTypeValue(branch.bind.typeExp));
                    const branchClassName = maybeResolveBoundClassName(branch.bind.typeExp);
                    if (branchClassName) {
                        branchEnv.variableClasses.set(branch.bind.var.name, branchClassName);
                    }
                    return branchEnv;
                })(), context)
            }))
        };
    }

    const lowered = lowerExpr(node, env, context);
    const concreteExpectedType = materializeRuntimeType(expectedType);
    if (!(concreteExpectedType instanceof UnionTypeValue)) {
        return lowered;
    }

    const actualType = materializeRuntimeType(inferNodeType(node, env));
    if (typeEqual(actualType, concreteExpectedType)) {
        return lowered;
    }
    const matchedMember = concreteExpectedType.types.find((member) => typeEqual(actualType, member));
    if (!matchedMember) {
        return lowered;
    }
    return {
        kind: "union_inject",
        unionTypeTagId: getUnionTypeId(concreteExpectedType),
        memberTypeTagId: getRuntimeTypeId(actualType),
        value: lowered
    };
}

function bindTypeFromAnnotation(bind: TypeVarBindNode, value: AstNode | undefined, env: LoweringEnvironment): TypeValue {
    try {
        return astToTypeValue(bind.typeExp);
    } catch {
        if (value === undefined) {
            throw new Error(`Pass 2 class primitive lowering failed: could not resolve inferred type for '${bind.var.name}'`);
        }
        if (value instanceof FnNode) {
            return new FunctionTypeValue(
                value.params.map((param) => astToTypeValue(param.typeExp)),
                astToTypeValue(value.returnType)
            );
        }
        return inferNodeType(value, env);
    }
}

function collectLetRecursiveFunctionTypes(bindings: readonly { bind: AstNode; value: AstNode }[], env: LoweringEnvironment): ReadonlyMap<string, FunctionTypeValue> {
    const recursiveFunctions = new Map<string, FunctionTypeValue>();
    for (const binding of bindings) {
        if (!(binding.bind instanceof TypeVarBindNode) || !(binding.value instanceof FnNode)) {
            continue;
        }
        const boundType = bindTypeFromAnnotation(binding.bind, binding.value, env);
        if (boundType instanceof FunctionTypeValue) {
            recursiveFunctions.set(binding.bind.var.name, boundType);
        }
    }
    return recursiveFunctions;
}

function extendEnvironmentWithRecursiveFunctions(baseEnv: LoweringEnvironment, recursiveFunctions: ReadonlyMap<string, FunctionTypeValue>): LoweringEnvironment {
    const extendedEnv = cloneEnvironment(baseEnv);
    for (const [name, functionType] of recursiveFunctions.entries()) {
        extendedEnv.localBindings.add(name);
        extendedEnv.variableTypes.set(name, functionType);
    }
    return extendedEnv;
}

function maybeResolveBoundClassName(typeExp: AstNode): string | undefined {
    return classNameFromTypeValue(materializeRuntimeType(astToTypeValue(typeExp)));
}

function resolveConcreteClassNameRef(node: AstNode, layouts: LoweringLayoutTable): string {
    if (node instanceof IdentifierNode) {
        if (layouts.classes.has(node.name)) {
            return node.name;
        }
        const classInfo = getVisibleClassInfo(node, node.name);
        if (classInfo !== undefined && layouts.classes.has(classInfo.name)) {
            return classInfo.name;
        }
    }
    if (node instanceof GenericCallNode) {
        const runtimeType = materializeRuntimeType(astToTypeValue(node));
        if (runtimeType instanceof ClassTypeValue && layouts.classes.has(runtimeType.className)) {
            return runtimeType.className;
        }
    }
    throw new Error("Pass 2 class primitive lowering failed: expected a concrete class reference");
}

function classNameFromTypeValue(typeValue: TypeValue): string | undefined {
    if (typeValue instanceof ClassTypeValue) {
        return typeValue.className;
    }
    if (typeValue instanceof GenericClassInstanceTypeValue && !builtinGenericTypeNames.has(typeValue.genericName)) {
        return classNameFromTypeValue(materializeRuntimeType(typeValue));
    }
    return undefined;
}

function inferConcreteClassName(node: AstNode, env: LoweringEnvironment, layouts: LoweringLayoutTable): string {
    if (node instanceof IdentifierNode) {
        const className = env.variableClasses.get(node.name);
        if (className) {
            return className;
        }
    }
    if (node instanceof FunctionCallNode && node.callee instanceof IdentifierNode && node.callee.name === "class_new" && node.args.length >= 1) {
        return resolveConcreteClassNameRef(node.args[0], layouts);
    }
    if (node instanceof FunctionCallNode
        && node.callee instanceof IdentifierNode
        && node.callee.name === "cm_get"
        && node.args.length === 2
        && node.args[1] instanceof IdentifierNode) {
        const receiverClassName = inferConcreteClassName(node.args[0], env, layouts);
        const receiverLayout = layouts.classes.get(receiverClassName);
        if (!receiverLayout) {
            throw new Error(`Pass 2 class primitive lowering failed: missing layout for class '${receiverClassName}'`);
        }
        const propertyType = receiverLayout.propertyTypes.get(node.args[1].name);
        if (propertyType) {
            const propertyClassName = classNameFromTypeValue(propertyType);
            if (propertyClassName) {
                return propertyClassName;
            }
        }
        const methodType = receiverLayout.methodTypes.get(node.args[1].name);
        if (methodType) {
            const methodReturnClassName = classNameFromTypeValue(methodType.returnType);
            if (methodReturnClassName) {
                return methodReturnClassName;
            }
        }
    }
    const inferredClassName = classNameFromTypeValue(materializeRuntimeType(inferNodeType(node, env)));
    if (inferredClassName) {
        return inferredClassName;
    }
    throw new Error("Pass 2 class primitive lowering failed: could not infer receiver class");
}

function lowerArrayNewWithClassInitialization(
    arrayTypeNode: AstNode,
    arrayType: GenericClassInstanceTypeValue,
    lengthNode: AstNode,
    initialValueNode: AstNode,
    env: LoweringEnvironment,
    context: LoweringContext
): LoweredExpr {
    const elementClassName = classNameFromTypeValue(arrayType.typeArgs[0]);
    if (!elementClassName) {
        throw new Error("Pass 2 class primitive lowering failed: expected class element type");
    }
    const layout = context.layouts.classes.get(elementClassName);
    if (!layout) {
        throw new Error(`Pass 2 class primitive lowering failed: missing layout for class '${elementClassName}'`);
    }
    const zeroArgConstructor = resolveZeroArgConstructorLayout(elementClassName, layout.constructors);

    const lengthName = freshTemporary(context);
    const seedName = freshTemporary(context);
    const rawName = freshTemporary(context);
    const indexName = freshTemporary(context);
    const itemName = freshTemporary(context);
    const i5Type = new IdentifierNode("i5");
    const zeroI5: LoweredExpr = { kind: "number_literal", value: 0, typeName: "i5" };
    const oneI5: LoweredExpr = { kind: "number_literal", value: 1, typeName: "i5" };
    const lengthRef: LoweredExpr = { kind: "identifier", name: lengthName };
    const seedRef: LoweredExpr = { kind: "identifier", name: seedName };
    const rawRef: LoweredExpr = { kind: "identifier", name: rawName };
    const indexRef: LoweredExpr = { kind: "identifier", name: indexName };
    const itemRef: LoweredExpr = { kind: "identifier", name: itemName };

    return {
        kind: "let",
        bindings: [
            {
                bind: { name: lengthName, typeExp: i5Type },
                value: lowerExprWithExpectedType(lengthNode, new PrimitiveTypeValue("i5"), env, context)
            },
            {
                bind: { name: seedName, typeExp: new IdentifierNode(elementClassName) },
                value: lowerExprWithExpectedType(initialValueNode, arrayType.typeArgs[0], env, context)
            },
            {
                bind: { name: rawName, typeExp: arrayTypeNode },
                value: {
                    kind: "direct_call",
                    symbol: "array_new",
                    args: [lengthRef, seedRef]
                }
            }
        ],
        body: {
            kind: "seq",
            expressions: [
                {
                    kind: "dvar",
                    bind: { name: indexName, typeExp: i5Type },
                    value: zeroI5
                },
                {
                    kind: "while",
                    condExpr: {
                        kind: "direct_call",
                        symbol: "__iw_builtin_lt_i5",
                        args: [indexRef, lengthRef]
                    },
                    bodyExpr: {
                        kind: "seq",
                        expressions: [
                            {
                                kind: "let",
                                bindings: [{
                                    bind: { name: itemName, typeExp: new IdentifierNode(elementClassName) },
                                    value: { kind: "object_alloc", className: elementClassName }
                                }],
                                body: {
                                    kind: "seq",
                                    expressions: [
                                        {
                                            kind: "direct_call",
                                            symbol: zeroArgConstructor.symbol,
                                            args: [itemRef]
                                        },
                                        {
                                            kind: "direct_call",
                                            symbol: "array_set",
                                            args: [rawRef, indexRef, itemRef]
                                        }
                                    ]
                                }
                            },
                            {
                                kind: "set_local",
                                identifier: indexName,
                                value: {
                                    kind: "direct_call",
                                    symbol: "__iw_builtin_add_i5",
                                    args: [indexRef, oneI5]
                                }
                            }
                        ]
                    }
                },
                rawRef
            ]
        }
    };
}

function resolveFunctionReference(node: AstNode): string | undefined {
    if (node instanceof GenericCallNode) {
        if (node.callee instanceof IdentifierNode && node.callee.name === "class_new") {
            return undefined;
        }
        const typeValue = astToTypeValue(node);
        if (typeValue instanceof GenericFunctionInstanceTypeValue) {
            return getMonomorphizedFunctionName(normalizeRuntimeGenericFunctionInstance(typeValue));
        }
    }
    return undefined;
}

function appendCallableTarget(targetsBySourceName: Map<string, CallableTarget[]>, target: CallableTarget): void {
    const existingTargets = targetsBySourceName.get(target.sourceName) ?? [];
    existingTargets.push(target);
    targetsBySourceName.set(target.sourceName, existingTargets);
}

function buildCallableTargetIndex(snapshot: LoweringSnapshotProgram): ReadonlyMap<string, readonly CallableTarget[]> {
    const targetsBySourceName = new Map<string, CallableTarget[]>();
    for (const fn of snapshot.concreteFunctions) {
        const target: CallableTarget = {
            sourceName: fn.sourceName,
            symbol: fn.concreteName,
            functionType: fn.functionType
        };
        appendCallableTarget(targetsBySourceName, target);
        if (fn.concreteName !== fn.sourceName) {
            appendCallableTarget(targetsBySourceName, {
                sourceName: fn.concreteName,
                symbol: fn.concreteName,
                functionType: fn.functionType
            });
        }
    }
    for (const fn of snapshot.declaredFunctions) {
        appendCallableTarget(targetsBySourceName, {
            sourceName: fn.sourceName,
            symbol: fn.symbol,
            functionType: fn.functionType
        });
    }
    return targetsBySourceName;
}

function getCallableTargets(referenceNode: AstNode, name: string, context: LoweringContext): readonly CallableTarget[] {
    const directTargets = context.callableTargetsBySourceName.get(name);
    if (directTargets !== undefined) {
        return directTargets;
    }

    const resolvedOverloads = getVisibleResolvedFunctionOverloads(referenceNode, name);
    if (resolvedOverloads.length > 0) {
        return context.callableTargetsBySourceName.get(resolvedOverloads[0].name) ?? [];
    }

    return [];
}

function resolveUniqueCallableTarget(referenceNode: AstNode, name: string, context: LoweringContext): CallableTarget | undefined {
    const targets = getCallableTargets(referenceNode, name, context);
    if (targets.length === 0) {
        return undefined;
    }
    if (targets.length === 1) {
        return targets[0];
    }
    throw new Error(`Pass 2 class primitive lowering failed: ambiguous overloaded function value '${name}'`);
}

function resolveCallableTargetByExpectedType(referenceNode: AstNode, name: string, expectedType: TypeValue, context: LoweringContext): CallableTarget | undefined {
    const targets = getCallableTargets(referenceNode, name, context);
    if (targets.length === 0) {
        return undefined;
    }
    const concreteExpectedType = materializeRuntimeType(expectedType);
    const matches = targets.filter((target) => isAssignable(materializeRuntimeType(target.functionType), concreteExpectedType));
    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        throw new Error(`Pass 2 class primitive lowering failed: ambiguous overloaded function value '${name}' for expected type`);
    }
    return undefined;
}

function resolveCallableTargetByArguments(referenceNode: AstNode, name: string, args: readonly AstNode[], env: LoweringEnvironment, context: LoweringContext): CallableTarget | undefined {
    const targets = getCallableTargets(referenceNode, name, context);
    if (targets.length === 0) {
        return undefined;
    }
    const argumentTypes = args.map((arg) => inferOverloadResolutionArgType(arg, env));
    const matches = targets.filter((target) => {
        const paramTypes = target.functionType.paramTypes.map((paramType) => materializeRuntimeType(paramType));
        return paramTypes.length === argumentTypes.length
            && paramTypes.every((paramType, index) => isAssignable(argumentTypes[index], paramType));
    });
    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const resolvedOverloads = getVisibleResolvedFunctionOverloads(referenceNode, name);
        if (resolvedOverloads.length > 0) {
            throw new Error(`Pass 2 class primitive lowering failed: ambiguous overloaded call '${name}'`);
        }
    }
    return undefined;
}

function resolveConstructorLayoutByArguments(className: string, constructors: readonly LoweringConstructorLayout[], args: readonly AstNode[], env: LoweringEnvironment): LoweringConstructorLayout {
    const argumentTypes = args.map((arg) => inferOverloadResolutionArgType(arg, env));
    const matches = constructors.filter((constructor) => constructor.paramTypes.length === argumentTypes.length
        && constructor.paramTypes.every((paramType, index) => isAssignable(argumentTypes[index], materializeRuntimeType(paramType))));

    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const exactMatches = matches.filter((constructor) => constructor.paramTypes.every((paramType, index) => typeEqual(materializeRuntimeType(paramType), argumentTypes[index])));
        if (exactMatches.length === 1) {
            return exactMatches[0];
        }
        throw new Error(`Pass 2 class primitive lowering failed: ambiguous constructor call '${className}'`);
    }

    throw new Error(`Pass 2 class primitive lowering failed: no constructor overload of '${className}' matches ${argumentTypes.length} arguments`);
}

function resolveZeroArgConstructorLayout(className: string, constructors: readonly LoweringConstructorLayout[]): LoweringConstructorLayout {
    const zeroArgConstructor = constructors.find((constructor) => constructor.paramTypes.length === 0);
    if (!zeroArgConstructor) {
        throw new Error(`Pass 2 class primitive lowering failed: array_new class element '${className}' requires zero-arg constructor lowering`);
    }
    return zeroArgConstructor;
}

function lowerIdentifier(node: IdentifierNode, env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (!env.localBindings.has(node.name)) {
        const resolvedTarget = resolveUniqueCallableTarget(node, node.name, context);
        if (resolvedTarget) {
            return { kind: "direct_function_ref", symbol: resolvedTarget.symbol };
        }
        const globalInfo = getVisibleGlobalVarInfo(node, node.name);
        if (globalInfo !== undefined) {
            return { kind: "identifier", name: globalInfo.name };
        }
    }
    return { kind: "identifier", name: node.name };
}

function lowerSeqExpressions(expressions: readonly AstNode[], env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    const loweredExpressions: LoweredExpr[] = [];
    let currentEnv = cloneEnvironment(env);
    for (const expression of expressions) {
        loweredExpressions.push(lowerExpr(expression, currentEnv, context));
        if (expression instanceof DvarNode) {
            if (!(expression.bind instanceof TypeVarBindNode)) {
                throw new Error("Pass 2 class primitive lowering failed: dvar bind must use TypeVarBindNode");
            }
            currentEnv.localBindings.add(expression.bind.var.name);
            currentEnv.variableTypes.set(expression.bind.var.name, bindTypeFromAnnotation(expression.bind, expression.value, currentEnv));
            const boundClassName = maybeResolveBoundClassName(expression.bind.typeExp);
            if (boundClassName) {
                currentEnv.variableClasses.set(expression.bind.var.name, boundClassName);
            }
        }
    }
    return { kind: "seq", expressions: loweredExpressions };
}

function lowerWhileLoop(node: WhileNode, env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    return {
        kind: "while",
        condExpr: lowerExpr(node.condExpr, env, context),
        bodyExpr: lowerExpr(node.bodyExpr, env, context)
    };
}

function lowerNewCall(args: readonly AstNode[], env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (args.length < 1) {
        throw new Error("Pass 2 class primitive lowering failed: class_new requires a class target");
    }
    const className = resolveConcreteClassNameRef(args[0], context.layouts);
    const layout = context.layouts.classes.get(className);
    if (!layout) {
        throw new Error(`Pass 2 class primitive lowering failed: missing layout for class '${className}'`);
    }
    const constructorLayout = resolveConstructorLayoutByArguments(className, layout.constructors, args.slice(1), env);
    const tempName = freshTemporary(context);
    const tempBinding: LoweredBinding = {
        name: tempName,
        typeExp: new IdentifierNode(className)
    };
    const tempReference: LoweredExpr = { kind: "identifier", name: tempName };
    return {
        kind: "let",
        bindings: [{
            bind: tempBinding,
            value: { kind: "object_alloc", className }
        }],
        body: {
            kind: "seq",
            expressions: [
                {
                    kind: "direct_call",
                    symbol: constructorLayout.symbol,
                    args: [
                        tempReference,
                        ...args.slice(1).map((arg, index) => lowerExprWithExpectedType(arg, constructorLayout.paramTypes[index] ?? inferNodeType(arg, env), env, context))
                    ]
                },
                tempReference
            ]
        }
    };
}

function lowerGetClassMember(args: readonly AstNode[], env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (args.length !== 2 || !(args[1] instanceof IdentifierNode)) {
        throw new Error("Pass 2 class primitive lowering failed: cm_get expects receiver and identifier member name");
    }
    const className = inferConcreteClassName(args[0], env, context.layouts);
    const layout = context.layouts.classes.get(className);
    if (!layout) {
        throw new Error(`Pass 2 class primitive lowering failed: missing layout for class '${className}'`);
    }
    const receiver = lowerExpr(args[0], env, context);
    if (layout.propertyOrder.includes(args[1].name)) {
        return {
            kind: "object_get_field",
            receiver,
            className,
            fieldName: args[1].name
        };
    }
    const methodSymbol = layout.methodSymbols.get(args[1].name);
    if (methodSymbol) {
        return {
            kind: "method_closure_create",
            receiver,
            className,
            methodName: args[1].name,
            methodSymbol
        };
    }
    throw new Error(`Pass 2 class primitive lowering failed: unknown member '${args[1].name}' on class '${className}'`);
}

function lowerSetClassMember(args: readonly AstNode[], env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (args.length !== 3 || !(args[1] instanceof IdentifierNode)) {
        throw new Error("Pass 2 class primitive lowering failed: cm_set expects receiver, identifier member name, and value");
    }
    const className = inferConcreteClassName(args[0], env, context.layouts);
    const layout = context.layouts.classes.get(className);
    if (!layout || !layout.propertyOrder.includes(args[1].name)) {
        throw new Error(`Pass 2 class primitive lowering failed: '${args[1].name}' is not a mutable property on class '${className}'`);
    }
    return {
        kind: "object_set_field",
        receiver: lowerExpr(args[0], env, context),
        className,
        fieldName: args[1].name,
        value: lowerExprWithExpectedType(args[2], layout.propertyTypes.get(args[1].name) ?? inferNodeType(args[2], env), env, context)
    };
}

function lowerFunctionCall(node: FunctionCallNode, env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (node.callee instanceof IdentifierNode) {
        if (node.callee.name === "iw_match_unreachable") {
            if (node.args.length !== 0) {
                throw new Error("Pass 2 class primitive lowering failed: iw_match_unreachable expects exactly 0 arguments");
            }
            return {
                kind: "direct_call",
                symbol: "iw_match_unreachable",
                args: []
            };
        }
        if (node.callee.name === "class_new") {
            return lowerNewCall(node.args, env, context);
        }
        if (node.callee.name === "cm_get") {
            return lowerGetClassMember(node.args, env, context);
        }
        if (node.callee.name === "cm_set") {
            return lowerSetClassMember(node.args, env, context);
        }
        const loweredTextPrimitiveBuiltin = lowerTextPrimitiveBuiltinCall(node, env, context);
        if (loweredTextPrimitiveBuiltin) {
            return loweredTextPrimitiveBuiltin;
        }
        const loweredComplexPrimitiveBuiltin = lowerComplexPrimitiveBuiltinCall(node, env, context);
        if (loweredComplexPrimitiveBuiltin) {
            return loweredComplexPrimitiveBuiltin;
        }
        if (node.callee.name === "array_new") {
            if (node.args.length !== 1 && node.args.length !== 3) {
                throw new Error("Pass 2 class primitive lowering failed: array_new expects either array type alone or array type, length, and initial value");
            }
            const arrayType = astToTypeValue(node.args[0]);
            if (!(arrayType instanceof GenericClassInstanceTypeValue) || arrayType.genericName !== "array" || arrayType.typeArgs.length !== 1) {
                throw new Error("Pass 2 class primitive lowering failed: array_new expects first argument to be an <array T> type");
            }
            if (node.args.length === 1) {
                return lowerArrayNewWithZeroArgInitialization(arrayType, env, context);
            }
            if (classNameFromTypeValue(arrayType.typeArgs[0])) {
                return lowerArrayNewWithClassInitialization(node.args[0], arrayType, node.args[1], node.args[2], env, context);
            }
            return {
                kind: "direct_call",
                symbol: "array_new",
                args: [
                    lowerExprWithExpectedType(node.args[1], new PrimitiveTypeValue("i5"), env, context),
                    lowerExprWithExpectedType(node.args[2], arrayType.typeArgs[0], env, context)
                ]
            };
        }
        if (node.callee.name === "array_get") {
            if (node.args.length !== 2) {
                throw new Error("Pass 2 class primitive lowering failed: array_get expects array and index");
            }
            const arrayType = inferNodeType(node.args[0], env);
            if (!(arrayType instanceof GenericClassInstanceTypeValue) || arrayType.genericName !== "array" || arrayType.typeArgs.length !== 1) {
                throw new Error("Pass 2 class primitive lowering failed: array_get expects first argument to have type <array T>");
            }
            return {
                kind: "direct_call",
                symbol: "array_get",
                args: [
                    lowerExprWithExpectedType(node.args[0], arrayType, env, context),
                    lowerExprWithExpectedType(node.args[1], new PrimitiveTypeValue("i5"), env, context)
                ]
            };
        }
        if (node.callee.name === "array_set") {
            if (node.args.length !== 3) {
                throw new Error("Pass 2 class primitive lowering failed: array_set expects array, index, and value");
            }
            const arrayType = inferNodeType(node.args[0], env);
            if (!(arrayType instanceof GenericClassInstanceTypeValue) || arrayType.genericName !== "array" || arrayType.typeArgs.length !== 1) {
                throw new Error("Pass 2 class primitive lowering failed: array_set expects first argument to have type <array T>");
            }
            return {
                kind: "direct_call",
                symbol: "array_set",
                args: [
                    lowerExprWithExpectedType(node.args[0], arrayType, env, context),
                    lowerExprWithExpectedType(node.args[1], new PrimitiveTypeValue("i5"), env, context),
                    lowerExprWithExpectedType(node.args[2], arrayType.typeArgs[0], env, context)
                ]
            };
        }
        if (node.callee.name === "array_length") {
            if (node.args.length !== 1) {
                throw new Error("Pass 2 class primitive lowering failed: array_length expects exactly one argument");
            }
            const arrayType = inferNodeType(node.args[0], env);
            if (!(arrayType instanceof GenericClassInstanceTypeValue) || arrayType.genericName !== "array" || arrayType.typeArgs.length !== 1) {
                throw new Error("Pass 2 class primitive lowering failed: array_length expects argument to have type <array T>");
            }
            return {
                kind: "direct_call",
                symbol: "array_length",
                args: [lowerExprWithExpectedType(node.args[0], arrayType, env, context)]
            };
        }
        const scalarConversionTarget = resolveScalarConversionDirectCall(node.callee.name, node.args, env);
        if (scalarConversionTarget) {
            return {
                kind: "direct_call",
                symbol: scalarConversionTarget.symbol,
                args: node.args.map((arg, index) => lowerExprWithExpectedType(arg, scalarConversionTarget.functionType.paramTypes[index], env, context))
            };
        }
        if (isBuiltinDirectCallName(node.callee.name)) {
            const builtinTarget = resolveBuiltinDirectCall(node.callee.name, node.args, env);
            if (builtinTarget) {
                return {
                    kind: "direct_call",
                    symbol: builtinTarget.symbol,
                    args: node.args.map((arg, index) => lowerExprWithExpectedType(arg, builtinTarget.functionType.paramTypes[index], env, context))
                };
            }
        }
        if (!env.localBindings.has(node.callee.name)) {
            const directTarget = resolveCallableTargetByArguments(node.callee, node.callee.name, node.args, env, context);
            if (directTarget) {
                return {
                    kind: "direct_call",
                    symbol: directTarget.symbol,
                    args: node.args.map((arg, index) => lowerExprWithExpectedType(arg, directTarget.functionType.paramTypes[index], env, context))
                };
            }
        }
    }

    const directSymbol = resolveFunctionReference(node.callee);
    const calleeType = inferNodeType(node.callee, env);
    const expectedArgTypes = calleeType instanceof FunctionTypeValue ? calleeType.paramTypes : [];
    const loweredArgs = node.args.map((arg, index) => lowerExprWithExpectedType(arg, expectedArgTypes[index] ?? inferNodeType(arg, env), env, context));
    if (directSymbol) {
        return {
            kind: "direct_call",
            symbol: directSymbol,
            args: loweredArgs
        };
    }

    const loweredCallee = lowerExpr(node.callee, env, context);
    if (loweredCallee.kind === "direct_function_ref") {
        return {
            kind: "direct_call",
            symbol: loweredCallee.symbol,
            args: loweredArgs
        };
    }

    return {
        kind: "call",
        callee: loweredCallee,
        args: loweredArgs
    };
}

function lowerExpr(node: AstNode, env: LoweringEnvironment, context: LoweringContext): LoweredExpr {
    if (node instanceof IdentifierNode) {
        if (node.name === "unit") {
            return lowerNumericLiteral(0, "i5");
        }
        if (node.name === "true") {
            return lowerNumericLiteral(1, "i5");
        }
        if (node.name === "false") {
            return lowerNumericLiteral(0, "i5");
        }
        return lowerIdentifier(node, env, context);
    }
    if (node instanceof NumberLiteralNode) {
        if (typeof node.value !== "number") {
            return lowerComplexLiteral(node, env, context);
        }
        return lowerNumericLiteral(node.value, resolveLoweredNumberLiteralType(node));
    }
    if (node instanceof TextDatabaseReferenceNode) {
        if (node.content === null) {
            throw new Error(`Pass 2 class primitive lowering failed: unresolved text database reference '${node.referenceName}'`);
        }
        if (typeof node.content === "number") {
            return lowerNumericLiteral(node.content, node.typeName);
        }
        return {
            kind: "text_literal",
            typeName: node.typeName,
            referenceName: node.referenceName,
            content: node.content
        };
    }
    if (node instanceof FnNode) {
        const fnEnv = cloneEnvironment(env);
        const params = node.params.map((param) => {
            fnEnv.localBindings.add(param.var.name);
            fnEnv.variableTypes.set(param.var.name, astToTypeValue(param.typeExp));
            const boundClassName = maybeResolveBoundClassName(param.typeExp);
            if (boundClassName) {
                fnEnv.variableClasses.set(param.var.name, boundClassName);
            }
            return lowerBinding(param);
        });
        return {
            kind: "fn",
            params,
            returnType: concretizeTypeAst(node.returnType),
            body: lowerExprWithExpectedType(node.body, astToTypeValue(node.returnType), fnEnv, context)
        };
    }
    if (node instanceof LetNode) {
        const bodyEnv = cloneEnvironment(env);
        const recursiveFunctions = collectLetRecursiveFunctionTypes(node.bindings, env);
        const bindings: LoweredLetBinding[] = node.bindings.map((binding) => {
            if (!(binding.bind instanceof TypeVarBindNode)) {
                throw new Error("Pass 2 class primitive lowering failed: let bind must use TypeVarBindNode");
            }
            const boundType = bindTypeFromAnnotation(binding.bind, binding.value, bodyEnv);
            const loweredBind = lowerBindingWithType(binding.bind, boundType);
            const bindingValueEnv = binding.value instanceof FnNode
                ? extendEnvironmentWithRecursiveFunctions(bodyEnv, recursiveFunctions)
                : bodyEnv;
            bodyEnv.localBindings.add(loweredBind.name);
            bodyEnv.variableTypes.set(loweredBind.name, boundType);
            const boundClassName = classNameFromTypeValue(materializeRuntimeType(boundType));
            if (boundClassName) {
                bodyEnv.variableClasses.set(loweredBind.name, boundClassName);
            }
            return {
                bind: loweredBind,
                value: lowerExprWithExpectedType(binding.value, boundType, bindingValueEnv, context)
            };
        });
        return {
            kind: "let",
            bindings,
            body: lowerExpr(node.body, bodyEnv, context)
        };
    }
    if (node instanceof IfNode) {
        return {
            kind: "if",
            condExpr: lowerExpr(node.condExpr, env, context),
            trueBranchExpr: lowerExpr(node.trueBranchExpr, env, context),
            falseBranchExpr: lowerExpr(node.falseBranchExpr, env, context)
        };
    }
    if (node instanceof WhileNode) {
        return lowerWhileLoop(node, env, context);
    }
    if (node instanceof CondNode) {
        return {
            kind: "cond",
            clauses: node.clausesExprs.map((clause) => ({
                cond: lowerExpr(clause.cond, env, context),
                body: lowerExpr(clause.body, env, context)
            }))
        };
    }
    if (node instanceof DvarNode) {
        if (!(node.bind instanceof TypeVarBindNode)) {
            throw new Error("Pass 2 class primitive lowering failed: dvar bind must use TypeVarBindNode");
        }
        const boundType = bindTypeFromAnnotation(node.bind, node.value, env);
        return {
            kind: "dvar",
            bind: lowerBindingWithType(node.bind, boundType),
            value: lowerExprWithExpectedType(node.value, boundType, env, context)
        };
    }
    if (node instanceof SeqNode) {
        return lowerSeqExpressions(node.expressions, env, context);
    }
    if (node instanceof SetNode) {
        const localTargetType = env.variableTypes.get(node.identifier.name);
        if (localTargetType === undefined) {
            const globalInfo = getVisibleGlobalVarInfo(node.identifier, node.identifier.name);
            if (globalInfo !== undefined) {
                const targetName = globalInfo.name;
                const targetType = context.globalTypes.get(targetName) ?? astToTypeValue(globalInfo.bind.typeExp);
                return {
                    kind: "set_local",
                    identifier: targetName,
                    value: lowerExprWithExpectedType(node.value, targetType, env, context)
                };
            }
        }
        return {
            kind: "set_local",
            identifier: node.identifier.name,
            value: lowerExprWithExpectedType(node.value, localTargetType ?? inferNodeType(node.value, env), env, context)
        };
    }
    if (node instanceof FunctionCallNode) {
        return lowerFunctionCall(node, env, context);
    }
    if (node instanceof GenericCallNode) {
        if (node.callee instanceof IdentifierNode && node.callee.name === "class_new") {
            if (node.typeArgs.length === 0) {
                throw new Error("Pass 2 class primitive lowering failed: class_new requires a class name");
            }
            const [classNameNode, ...classTypeArgs] = node.typeArgs;
            const classRefNode = classTypeArgs.length > 0
                ? new GenericCallNode(classNameNode, classTypeArgs)
                : classNameNode;
            return lowerFunctionCall(new FunctionCallNode(new IdentifierNode("class_new"), [classRefNode]), env, context);
        }
        const directSymbol = resolveFunctionReference(node);
        if (directSymbol) {
            return { kind: "direct_function_ref", symbol: directSymbol };
        }
        return { kind: "identifier", name: resolveConcreteClassNameRef(node, context.layouts) };
    }
    if (node instanceof MatchNode) {
        const unionType = inferNodeType(node.unionExpr, env);
        if (!(unionType instanceof UnionTypeValue)) {
            throw new Error("Pass 2 class primitive lowering failed: match target must be a union type");
        }
        return {
            kind: "match",
            unionTypeTagId: getUnionTypeId(unionType),
            unionExpr: lowerExpr(node.unionExpr, env, context),
            branches: node.branches.map((branch) => ({
                bind: lowerBinding(branch.bind),
                memberTypeTagId: getRuntimeTypeId(astToTypeValue(branch.bind.typeExp)),
                body: lowerExpr(branch.body, (() => {
                    const branchEnv = cloneEnvironment(env);
                    branchEnv.localBindings.add(branch.bind.var.name);
                    branchEnv.variableTypes.set(branch.bind.var.name, astToTypeValue(branch.bind.typeExp));
                    const branchClassName = maybeResolveBoundClassName(branch.bind.typeExp);
                    if (branchClassName) {
                        branchEnv.variableClasses.set(branch.bind.var.name, branchClassName);
                    }
                    return branchEnv;
                })(), context)
            }))
        };
    }
    throw new Error(`Pass 2 class primitive lowering failed: unsupported AST node kind '${String(node.kind)}'`);
}

function lowerMethodDefinition(method: ClassMethodNode, className: string, layout: LoweringClassLayout, context: LoweringContext): LoweredMethodDefinition {
    const env: LoweringEnvironment = {
        variableClasses: new Map([["self", className]]),
        variableTypes: new Map([["self", new ClassTypeValue(className)]]),
        localBindings: new Set(["self"]),
        functionSymbols: context.functionSymbols
    };
    const params = method.params.map((param) => {
        env.localBindings.add(param.var.name);
        env.variableTypes.set(param.var.name, astToTypeValue(param.typeExp));
        const boundClassName = maybeResolveBoundClassName(param.typeExp);
        if (boundClassName) {
            env.variableClasses.set(param.var.name, boundClassName);
        }
        return lowerBinding(param);
    });
    const methodSymbol = layout.methodSymbols.get(method.methodName.name);
    if (!methodSymbol) {
        throw new Error(`Pass 2 class primitive lowering failed: missing method symbol for '${className}.${method.methodName.name}'`);
    }
    return {
        methodName: method.methodName.name,
        symbol: methodSymbol,
        params,
        returnType: concretizeTypeAst(method.returnType),
        body: lowerExprWithExpectedType(method.body, astToTypeValue(method.returnType), env, context)
    };
}

function lowerConstructorDefinition(constructorNode: ClassConstructorNode, className: string, constructorLayout: LoweringConstructorLayout, context: LoweringContext): LoweredConstructorDefinition {
    const env: LoweringEnvironment = {
        variableClasses: new Map([["self", className]]),
        variableTypes: new Map([["self", new ClassTypeValue(className)]]),
        localBindings: new Set(["self"]),
        functionSymbols: context.functionSymbols
    };
    const params = constructorNode.params.map((param) => {
        env.localBindings.add(param.var.name);
        env.variableTypes.set(param.var.name, astToTypeValue(param.typeExp));
        const boundClassName = maybeResolveBoundClassName(param.typeExp);
        if (boundClassName) {
            env.variableClasses.set(param.var.name, boundClassName);
        }
        return lowerBinding(param);
    });
    return {
        symbol: constructorLayout.symbol,
        params,
        body: lowerExpr(constructorNode.body, env, context)
    };
}

function lowerTopLevelFunction(fn: LoweringSnapshotProgram["concreteFunctions"][number], context: LoweringContext): LoweredFunctionDefinition {
    const env: LoweringEnvironment = {
        variableClasses: new Map(),
        variableTypes: new Map(),
        localBindings: new Set(),
        functionSymbols: context.functionSymbols
    };
    const params = fn.functionNode.params.map((param) => {
        env.localBindings.add(param.var.name);
        env.variableTypes.set(param.var.name, astToTypeValue(param.typeExp));
        const boundClassName = maybeResolveBoundClassName(param.typeExp);
        if (boundClassName) {
            env.variableClasses.set(param.var.name, boundClassName);
        }
        return lowerBinding(param);
    });
    return {
        symbol: fn.concreteName,
        params,
        returnType: concretizeTypeAst(fn.functionNode.returnType),
        body: lowerExprWithExpectedType(fn.functionNode.body, astToTypeValue(fn.functionNode.returnType), env, context),
        origin: { kind: "top_level" },
        unitId: fn.unitId ?? null
    };
}

function validateLoweredExpr(expr: LoweredExpr): void {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return;
        case "fn":
            validateLoweredExpr(expr.body);
            return;
        case "let":
            expr.bindings.forEach((binding) => validateLoweredExpr(binding.value));
            validateLoweredExpr(expr.body);
            return;
        case "if":
            validateLoweredExpr(expr.condExpr);
            validateLoweredExpr(expr.trueBranchExpr);
            validateLoweredExpr(expr.falseBranchExpr);
            return;
        case "cond":
            expr.clauses.forEach((clause) => {
                validateLoweredExpr(clause.cond);
                validateLoweredExpr(clause.body);
            });
            return;
        case "dvar":
            validateLoweredExpr(expr.value);
            return;
        case "seq":
            expr.expressions.forEach((inner) => validateLoweredExpr(inner));
            return;
        case "set_local":
            validateLoweredExpr(expr.value);
            return;
        case "call":
            if (expr.callee.kind === "direct_function_ref") {
                throw new Error("Pass 2 validation failed: direct function references must be lowered to direct_call");
            }
            validateLoweredExpr(expr.callee);
            expr.args.forEach((arg) => validateLoweredExpr(arg));
            return;
        case "direct_call":
            expr.args.forEach((arg) => validateLoweredExpr(arg));
            return;
        case "object_get_field":
            validateLoweredExpr(expr.receiver);
            return;
        case "object_set_field":
            validateLoweredExpr(expr.receiver);
            validateLoweredExpr(expr.value);
            return;
        case "method_closure_create":
            validateLoweredExpr(expr.receiver);
            return;
        case "union_inject":
            validateLoweredExpr(expr.value);
            return;
        case "match":
            validateLoweredExpr(expr.unionExpr);
            expr.branches.forEach((branch) => validateLoweredExpr(branch.body));
            return;
    }
}

export function validateLoweredClassPrimitiveProgram(program: LoweredClassPrimitiveProgram): void {
    for (const statement of program.topLevelStatements) {
        validateLoweredExpr(statement);
    }
    for (const fn of program.functions) {
        validateLoweredExpr(fn.body);
    }
    for (const classDef of program.classes) {
        classDef.methods.forEach((method) => validateLoweredExpr(method.body));
        classDef.constructorDefs.forEach((constructorDef) => validateLoweredExpr(constructorDef.body));
    }
}

export function lowerClassPrimitivesPass(snapshot: LoweringSnapshotProgram, layouts: LoweringLayoutTable): LoweredClassPrimitiveProgram {
    const callableTargetsBySourceName = buildCallableTargetIndex(snapshot);
    const functionSymbols = new Set<string>([
        ...snapshot.concreteFunctions.map((fn) => fn.concreteName),
        ...snapshot.declaredFunctions.map((fn) => fn.symbol)
    ]);
    const context: LoweringContext = {
        layouts,
        functionSymbols,
        callableTargetsBySourceName,
        globalTypes: new Map(snapshot.globals.map((globalDef) => [globalDef.symbol, globalDef.type])),
        tempCounter: 0
    };
    const initialEnv: LoweringEnvironment = {
        variableClasses: new Map(),
        variableTypes: new Map(),
        localBindings: new Set(),
        functionSymbols
    };
    const topLevelStatements = lowerSeqExpressions(snapshot.topLevelStatements, initialEnv, context);
    const loweredClasses: LoweredClassDefinition[] = snapshot.concreteClasses.flatMap((classDef) => {
        if (classDef.isExternal) {
            return [];
        }
        const layout = layouts.classes.get(classDef.concreteName);
        if (!layout) {
            throw new Error(`Pass 2 class primitive lowering failed: missing layout for class '${classDef.concreteName}'`);
        }
        return [{
            className: classDef.concreteName,
            propertyOrder: classDef.classNode.propertyNodeList.map((property) => ({ bind: lowerBinding(property.bind) })),
            methods: classDef.classNode.methodNodeList.map((method) => lowerMethodDefinition(method, classDef.concreteName, layout, context)),
            constructorDefs: classDef.classNode.constructorNodeList.map((constructorNode, index) => {
                const constructorLayout = layout.constructors[index];
                if (!constructorLayout) {
                    throw new Error(`Pass 2 class primitive lowering failed: missing constructor layout for class '${classDef.concreteName}' overload ${index}`);
                }
                return lowerConstructorDefinition(constructorNode, classDef.concreteName, constructorLayout, context);
            })
        }];
    });
    const loweredFunctions = snapshot.concreteFunctions.map((fn) => lowerTopLevelFunction(fn, context));
    const program: LoweredClassPrimitiveProgram = {
        kind: "lowered_class_primitive_program",
        topLevelStatements: topLevelStatements.kind === "seq" ? topLevelStatements.expressions : [topLevelStatements],
        globals: snapshot.globals,
        functions: loweredFunctions,
        declaredFunctions: snapshot.declaredFunctions,
        classes: loweredClasses,
        layouts,
        metadata: snapshot.metadata
    };
    validateLoweredClassPrimitiveProgram(program);
    return program;
}
