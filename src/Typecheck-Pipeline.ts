

import { randomUUID } from "crypto";
import {
    createDiagnostic,
    getActiveTypecheckNode,
    IronwallDiagnosticError,
    withActiveTypecheckNode,
    wrapErrorAsDiagnostic
} from "./Diagnostics";

import {
    AstNode,
    AstNodeType,
    IdentifierNode,
    TextDatabaseReferenceNode,
    NumberLiteralNode,
    FnNode,
    LetNode,
    IfNode,
    WhileNode,
    CondNode,
    DvarNode,
    DfunNode,
    DeclaredDfunNode,
    ExportNode,
    PublicNode,
    SeqNode,
    SetNode,
    TypeVarBindNode,
    ClassNode,
    ClassPropertyNode,
    ClassMethodNode,
    ClassConstructorNode,
    GenericClassNode,
    GenericDfunNode,
    ImportNode,
    ProgramNode,
    MatchNode,
    FunctionCallNode,
    GenericCallNode,
    AngleParenListNode,
    isExportableTopLevelAstNode,
    unwrapExportNode
} from "./AstNode";
import { getAnnotatedProgramPackageStringDatabase, StringDatabase } from "./StringDatabase";

import {
    TypeValue,
    PrimitiveTypeValue,
    FunctionTypeValue,
    ClassTypeValue,
    GenericClassInstanceTypeValue,
    GenericFunctionInstanceTypeValue,
    UnionTypeValue,
    typeEqual,
    isAssignable,
    GenericTypeEnv,
    TypeParameterValue,
    substituteTypeVariables,
    collectClassInfoPass,
    getClassInfo,
    getVisibleGlobalVarInfo,
    getVisibleClassInfo,
    getVisibleGenericClassInfo,
    hasVisibleGenericClassInfo,
    getGenericClassInfo,
    resetDefinitionInfoTables
} from "./Typecheck-Core";

import { astToTypeValue, typeValueToTypeAst } from "./Typecheck-TypeAst"; // 引入类型检查工具函数
import {
    getResolvedGenericFunctionInfo,
    getVisibleResolvedFunctionOverloads,
    getVisibleResolvedGenericFunctionInfo,
    resolveDefinitionHeadersPass,
    resetResolvedHeaderTables
} from "./Typecheck-Pass-2-ResolveHeaders";
import { validateDeclarationsPass } from "./Typecheck-Pass-3-ValidateDeclarations";
import { collectImportsPass, validateImportsPass, validateUnusedImportsPass } from "./Typecheck-Pass-1a-CollectImports";
import { resetGenericInstantiationTables } from "./Typecheck-Pass-4-CollectInstantiations";
import { resetPackageSymbolTable } from "./Typecheck-Modules";
import { validateFiniteTypeTerminationPass } from "./Typecheck-Pass-7-CheckFiniteTypes";
import { getMonomorphizedConcreteProgram, materializeMonomorphizedDefinitionsPass, monomorphizedClassTable, monomorphizedFunctionTable, resetMonomorphizedTables } from "./Typecheck-Pass-8-Monomorphize";
import { ensureProgramCompilationUnitMetadata, getCompilationUnitMetadata } from "./ModuleMetadata";
import { resetModuleGlobalInitPlan, validateAndBuildModuleGlobalInitPlan } from "./ModuleGlobalInit";
import { getVisibleDatabaseReferenceCanonicalNames, registerPackageSymbol } from "./Typecheck-Modules";
import { canonicalizePackageNamesPass } from "./Typecheck-Pass-1c-CanonicalizePackages";
import { performConcreteTypeChecking } from "./Typecheck-Pass-9-ConcreteTypecheck";
import { StaticPrimitiveEvalError, evaluateStaticPrimitiveInitializer, isAllowedTopLevelGlobalType } from "./Typecheck-StaticPrimitiveEval";
import { installPrecompiledLibraryTypecheckState, resetPrecompiledLibraryState, type LoadedPrecompiledLibrary } from "./PrecompiledLib";

export interface TypeCheckingOptions {
    readonly monomorphizationMaxRounds?: number;
    readonly disableBaseLibAutoLoad?: boolean;
    readonly precompiledLibraries?: readonly LoadedPrecompiledLibrary[];
}

/**
 * 类型检查错误类
 */
export class TypeCheckError extends IronwallDiagnosticError {
    constructor(message: string) {
        super(createDiagnostic("typecheck", "TYPECHECK_ERROR", `[TypeCheck Error] ${message}`, {
            ast: getActiveTypecheckNode(),
        }));
        this.name = "TypeCheckError";
    }
}

let currentStringDatabase: StringDatabase | null = null;
const variadicComparisonBuiltinNames: ReadonlySet<string> = new Set(["le", "lt", "ge", "gt", "eq"]);
const memberVisibilityAccessContextStack: TypeValue[] = [];

export function withMemberVisibilityAccessContext<T>(selfType: TypeValue, callback: () => T): T {
    memberVisibilityAccessContextStack.push(selfType);
    try {
        return callback();
    } finally {
        memberVisibilityAccessContextStack.pop();
    }
}

function canAccessPrivateMember(objectType: TypeValue): boolean {
    const currentSelfType = memberVisibilityAccessContextStack[memberVisibilityAccessContextStack.length - 1];
    if (currentSelfType === undefined) {
        return false;
    }
    if (objectType instanceof ClassTypeValue) {
        return currentSelfType instanceof ClassTypeValue && currentSelfType.className === objectType.className;
    }
    if (objectType instanceof GenericClassInstanceTypeValue) {
        return currentSelfType instanceof GenericClassInstanceTypeValue
            && currentSelfType.genericName === objectType.genericName
            && currentSelfType.typeArgs.length === objectType.typeArgs.length
            && currentSelfType.typeArgs.every((typeArg, index) => typeEqual(typeArg, objectType.typeArgs[index]));
    }
    return false;
}

function formatMemberOwner(type: ClassTypeValue | GenericClassInstanceTypeValue): string {
    if (type instanceof ClassTypeValue) {
        return `class ${type.className}`;
    }
    return `generic class ${type.genericName}`;
}

function ensureReadableMemberVisibility(memberName: string, objectType: ClassTypeValue | GenericClassInstanceTypeValue, isPublic: boolean): void {
    if (isPublic || canAccessPrivateMember(objectType)) {
        return;
    }
    throw new TypeCheckError(`Member ${memberName} is private in ${formatMemberOwner(objectType)}`);
}

function ensureWritablePropertyVisibility(memberName: string, objectType: ClassTypeValue | GenericClassInstanceTypeValue, isPublic: boolean): void {
    if (isPublic || canAccessPrivateMember(objectType)) {
        return;
    }
    throw new TypeCheckError(`Property ${memberName} is private in ${formatMemberOwner(objectType)}`);
}

function resolveStringDatabase(ast: AstNode): StringDatabase | null {
    if (ast instanceof ProgramNode) {
        const annotatedDatabase = getAnnotatedProgramPackageStringDatabase(ast);
        if (annotatedDatabase !== undefined) {
            return annotatedDatabase.entries;
        }
    }

    return null;
}

function registerAnnotatedPackageStringDatabaseSymbols(ast: AstNode): void {
    if (!(ast instanceof ProgramNode)) {
        return;
    }
    const annotatedDatabase = getAnnotatedProgramPackageStringDatabase(ast);
    if (annotatedDatabase === undefined) {
        return;
    }

    for (const record of annotatedDatabase.records) {
        registerPackageSymbol({
            kind: "db",
            exportedName: record.exportedName,
            canonicalName: record.canonicalName,
            isExported: true,
            packageName: record.packageName,
            unitId: null,
            filePath: record.filePath,
        });
    }
}

function parseNumericPayload(typeName: string, payload: string | number): number {
    if (typeof payload === "number") {
        return payload;
    }

    const raw = payload.trim();
    if (["i5", "i6", "i7", "u5", "u6", "u7"].includes(typeName)) {
        if (/^[0-9]+$/.test(raw)) {
            return Number(raw);
        }
        if (/^0neg[0-9]+$/.test(raw)) {
            return -Number(raw.slice(4));
        }
        if (/^0x[0-9A-Fa-f]+$/.test(raw)) {
            return parseInt(raw.slice(2), 16);
        }
        throw new TypeCheckError(`Literal db entry for ${typeName} must contain an integer payload, got '${raw}'`);
    }

    if (["f5", "f6", "f7"].includes(typeName)) {
        if (raw === "inf") {
            return Number.POSITIVE_INFINITY;
        }
        if (raw === "0neginf") {
            return Number.NEGATIVE_INFINITY;
        }
        if (raw === "nan") {
            return Number.NaN;
        }
        const negativeFiniteMatch = raw.match(/^0neg(.+)$/);
        if (negativeFiniteMatch !== null) {
            const innerRaw = negativeFiniteMatch[1];
            if (/^0x/i.test(innerRaw) || innerRaw === "inf" || innerRaw === "0neginf" || innerRaw === "nan") {
                throw new TypeCheckError(`Literal db entry for ${typeName} must contain a floating payload, got '${raw}'`);
            }
            return -parseNumericPayload(typeName, innerRaw);
        }
        if (/^[0-9]+p[0-9]+$/.test(raw)) {
            const [whole, fraction] = raw.split("p");
            return Number(`${whole}.${fraction}`);
        }
        const scientificMatch = raw.match(/^([0-9]+(?:p[0-9]+)?)(ep|en)([0-9]+)$/);
        if (scientificMatch !== null) {
            const mantissa = parseNumericPayload("f5", scientificMatch[1]);
            const exponent = Number(scientificMatch[3]);
            return scientificMatch[2] === "ep"
                ? mantissa * (10 ** exponent)
                : mantissa * (10 ** (-exponent));
        }
        if (/^[0-9]+$/.test(raw)) {
            return Number(raw);
        }
        throw new TypeCheckError(`Literal db entry for ${typeName} must contain a floating payload, got '${raw}'`);
    }

    throw new TypeCheckError(`Numeric literal db reference is not supported for type ${typeName}`);
}

function resolveTypedReferenceContent(node: TextDatabaseReferenceNode, content: string | number): string | number {
    if (node.typeName.startsWith("s") || node.typeName.startsWith("c")) {
        if (typeof content !== "string") {
            throw new TypeCheckError(`Literal db entry ${node.referenceName} must contain a string value for type ${node.typeName}`);
        }
        if (node.typeName.startsWith("c") && [...content].length !== 1) {
            throw new TypeCheckError(`Literal db entry ${node.referenceName} must contain exactly one character for type ${node.typeName}`);
        }
        return content;
    }

    return parseNumericPayload(node.typeName, content);
}

/**
 * 变量环境，记录变量名到类型值的映射
 */
export class VarEnv {
    private readonly env: Map<string, TypeValue>;
    private readonly immutableBindings: Set<string>;
    public readonly parent?: VarEnv;

    constructor(initEnv?: Map<string, TypeValue>, parent?: VarEnv, immutableBindings?: Set<string>) {
        this.env = initEnv ? new Map(initEnv) : new Map();
        this.immutableBindings = immutableBindings ? new Set(immutableBindings) : new Set();
        this.parent = parent;
    }

    get(name: string): TypeValue | undefined {
        if (this.env.has(name)) {
            return this.env.get(name);
        } else if (this.parent) {
            return this.parent.get(name);
        } else {
            return undefined;
        }
    }

    set(name: string, value: TypeValue): void {
        this.env.set(name, value);
    }

    setImmutable(name: string, value: TypeValue): void {
        this.env.set(name, value);
        this.immutableBindings.add(name);
    }

    isImmutable(name: string): boolean {
        if (this.env.has(name)) {
            return this.immutableBindings.has(name);
        }
        return this.parent ? this.parent.isImmutable(name) : false;
    }

    has(name: string): boolean {
        return this.env.has(name) || (this.parent ? this.parent.has(name) : false);
    }

    clear(): void {
        this.env.clear();
        this.immutableBindings.clear();
    }

    clone(): VarEnv {
        return new VarEnv(this.env, this.parent, this.immutableBindings);
    }

    extend(): VarEnv {
        return new VarEnv(undefined, this);
    }
}

/**
 * 函数环境，记录函数名到函数类型的映射
 */
export class FunctionEnv {
    private readonly env: Map<string, FunctionTypeValue>;
    public readonly parent?: FunctionEnv;

    constructor(initEnv?: Map<string, FunctionTypeValue>, parent?: FunctionEnv) {
        this.env = initEnv ? new Map(initEnv) : new Map();
        this.parent = parent;
    }

    get(name: string): FunctionTypeValue | undefined {
        if (this.env.has(name)) {
            return this.env.get(name);
        } else if (this.parent) {
            return this.parent.get(name);
        } else {
            return undefined;
        }
    }

    set(name: string, value: FunctionTypeValue): void {
        this.env.set(name, value);
    }

    has(name: string): boolean {
        return this.env.has(name) || (this.parent ? this.parent.has(name) : false);
    }

    clear(): void {
        this.env.clear();
    }

    extend(): FunctionEnv {
        return new FunctionEnv(undefined, this);
    }
}

/**
 * 顶层变量环境
 */
export const toplevelVarEnv = new VarEnv();

/**
 * 顶层函数环境
 */
export const toplevelFunctionEnv = new FunctionEnv();

/**
 * 初始化内置类型和函数
 */
function initBuiltins(): void {
    // 内置算术运算函数
    const arithmeticOps = ['add', 'sub', 'mul', 'div', 'mod'];
    for (const op of arithmeticOps) {
        const numTypes = ['i5'];
        for (const numType of numTypes) {
            const type = new PrimitiveTypeValue(numType);
            const funcType = new FunctionTypeValue([type, type], type);
            toplevelFunctionEnv.set(op, funcType);
        }
    }

    // 内置比较运算函数
    const comparisonOps = ['le', 'lt', 'ge', 'gt', 'eq', 'neq'];
    const boolType = new PrimitiveTypeValue('bool');
    for (const op of comparisonOps) {
        const numTypes = ['i5'];//, 'i6', 'i7', 'u5', 'u6', 'u7', 'f5', 'f6', 'f7'];
        for (const numType of numTypes) {
            const type = new PrimitiveTypeValue(numType);
            const funcType = new FunctionTypeValue([type, type], boolType);
            toplevelFunctionEnv.set(op, funcType);
        }
    }

    // 内置逻辑运算函数
    const logicOps = ['and', 'or', 'xor'];
    for (const op of logicOps) {
        const funcType = new FunctionTypeValue([boolType, boolType], boolType);
        toplevelFunctionEnv.set(op, funcType);
    }
    const logicalNotType: FunctionTypeValue = new FunctionTypeValue([boolType], boolType);
    toplevelFunctionEnv.set('not', logicalNotType);

    // 内置位运算函数
    const bitOps = ['bwand', 'bwor', 'bwxor', 'ls', 'rs'];
    for (const op of bitOps) {
        const intTypes = ['i5'];//, 'i6', 'i7', 'u5', 'u6', 'u7'];
        for (const intType of intTypes) {
            const type = new PrimitiveTypeValue(intType);
            const funcType = new FunctionTypeValue([type, type], type);
            toplevelFunctionEnv.set(op, funcType);
        }
    }

    // 内置类相关函数
    // class_new 函数会在类型检查时动态处理
    // cm_get 和 cm_set 会在类型检查时动态处理
}

function buildBuiltinCallCandidates(funcName: string): readonly FunctionTypeValue[] {
    const boolType = new PrimitiveTypeValue("bool");
    const integerTypes = ["i5", "i6", "i7", "u5", "u6", "u7"].map((name) => new PrimitiveTypeValue(name));
    const floatTypes = ["f5", "f6", "f7"].map((name) => new PrimitiveTypeValue(name));
    const charTypes = ["c3", "c4", "c5"].map((name) => new PrimitiveTypeValue(name));

    const valueConversionMatch: RegExpMatchArray | null = funcName.match(/^val_to_([a-z0-9]+)$/);
    if (valueConversionMatch !== null) {
        const targetTypeName = valueConversionMatch[1];
        if (["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"].includes(targetTypeName)) {
            const targetType = new PrimitiveTypeValue(targetTypeName);
            const sourceTypes = [
                ...integerTypes,
                ...floatTypes,
                ...((targetTypeName === "i5" || targetTypeName === "u5") ? charTypes : [])
            ];
            return sourceTypes.map((sourceType) => new FunctionTypeValue([sourceType], targetType));
        }
        return [];
    }

    const binaryConversionMatch: RegExpMatchArray | null = funcName.match(/^bin_to_([a-z0-9]+)$/);
    if (binaryConversionMatch !== null) {
        const targetTypeName = binaryConversionMatch[1];
        if (["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"].includes(targetTypeName)) {
            const targetType = new PrimitiveTypeValue(targetTypeName);
            const sourceTypes = [
                ...integerTypes,
                ...floatTypes,
                ...((targetTypeName === "i5" || targetTypeName === "u5") ? charTypes : [])
            ];
            return sourceTypes.map((sourceType) => new FunctionTypeValue([sourceType], targetType));
        }
        return [];
    }

    if (["add", "sub", "mul", "div", "mod"].includes(funcName)) {
        return [
            ...integerTypes.map((type) => new FunctionTypeValue([type, type], type)),
            ...floatTypes.map((type) => new FunctionTypeValue([type, type], type))
        ];
    }
    if (["le", "lt", "ge", "gt", "eq", "neq"].includes(funcName)) {
        return [
            ...integerTypes.map((type) => new FunctionTypeValue([type, type], boolType)),
            ...floatTypes.map((type) => new FunctionTypeValue([type, type], boolType)),
            ...charTypes.map((type) => new FunctionTypeValue([type, type], boolType))
        ];
    }
    if (["and", "or", "xor"].includes(funcName)) {
        return [new FunctionTypeValue([boolType, boolType], boolType)];
    }
    if (funcName === "not") {
        return [new FunctionTypeValue([boolType], boolType)];
    }
    if (["bwand", "bwor", "bwxor", "ls", "rs"].includes(funcName)) {
        return integerTypes.map((type) => new FunctionTypeValue([type, type], type));
    }
    return [];
}

function isBuiltinCallName(funcName: string): boolean {
    return buildBuiltinCallCandidates(funcName).length > 0;
}

function resolveBuiltinCallByArguments(funcName: string, args: readonly AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): FunctionTypeValue | undefined {
    const candidates = buildBuiltinCallCandidates(funcName).filter((candidate) => candidate.paramTypes.length === args.length);
    const matches: FunctionTypeValue[] = [];

    for (const candidate of candidates) {
        let compatible = true;
        try {
            candidate.paramTypes.forEach((paramType, index) => {
                typecheckAgainstExpectedType(args[index], paramType, varEnv, funcEnv, typeEnv);
            });
        } catch {
            compatible = false;
        }

        if (compatible) {
            matches.push(candidate);
        }
    }

    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const actualArgTypes = args.map((arg) => typecheck(arg, varEnv, funcEnv, typeEnv));
        const exactMatches = matches.filter((candidate) => candidate.paramTypes.every((paramType, index) => typeEqual(paramType, actualArgTypes[index])));
        if (exactMatches.length === 1) {
            return exactMatches[0];
        }
        throw new TypeCheckError(`Ambiguous builtin call to ${funcName}`);
    }
    const variadicComparisonCandidate = resolveVariadicComparisonBuiltinByArguments(funcName, args, varEnv, funcEnv, typeEnv);
    if (variadicComparisonCandidate !== undefined) {
        return variadicComparisonCandidate;
    }
    return undefined;
}

function resolveVariadicComparisonBuiltinByArguments(funcName: string, args: readonly AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): FunctionTypeValue | undefined {
    if (!variadicComparisonBuiltinNames.has(funcName) || args.length <= 2) {
        return undefined;
    }

    const candidates = buildBuiltinCallCandidates(funcName);
    const matches: FunctionTypeValue[] = [];

    for (const candidate of candidates) {
        let compatible = true;
        const operandType = candidate.paramTypes[0];
        try {
            args.forEach((arg) => {
                typecheckAgainstExpectedType(arg, operandType, varEnv, funcEnv, typeEnv);
            });
        } catch {
            compatible = false;
        }

        if (compatible) {
            matches.push(candidate);
        }
    }

    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const actualArgTypes = args.map((arg) => typecheck(arg, varEnv, funcEnv, typeEnv));
        const exactMatches = matches.filter((candidate) => actualArgTypes.every((actualArgType) => typeEqual(candidate.paramTypes[0], actualArgType)));
        if (exactMatches.length === 1) {
            return exactMatches[0];
        }
        throw new TypeCheckError(`Ambiguous variadic comparison builtin call to ${funcName}`);
    }
    return undefined;
}

function isMatchUnreachableCall(ast: AstNode): ast is FunctionCallNode {
    return ast instanceof FunctionCallNode
        && ast.callee instanceof IdentifierNode
        && ast.callee.name === "iw_match_unreachable";
}

function requireTypeAnnotation(bindNode: TypeVarBindNode, typeEnv: GenericTypeEnv): TypeValue {
    return astToTypeValue(bindNode.typeExp, typeEnv);
}

function materializeExpectedType(type: TypeValue): TypeValue {
    if (type instanceof GenericFunctionInstanceTypeValue) {
        const resolvedGenericFunction = getResolvedGenericFunctionInfo(type.genericName, type.typeArgs.length);
        if (!resolvedGenericFunction) {
            throw new TypeCheckError(`Unknown generic function: ${type.genericName}`);
        }
        const substitutions = new Map<string, TypeValue>();
        for (let i = 0; i < resolvedGenericFunction.typeParams.length; i++) {
            substitutions.set(resolvedGenericFunction.typeParams[i], type.typeArgs[i]);
        }
        return materializeExpectedType(substituteTypeVariables(resolvedGenericFunction.functionType, substitutions));
    }
    if (type instanceof FunctionTypeValue) {
        return new FunctionTypeValue(
            type.paramTypes.map((paramType) => materializeExpectedType(paramType)),
            materializeExpectedType(type.returnType)
        );
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return new GenericClassInstanceTypeValue(
            type.genericName,
            type.typeArgs.map((typeArg) => materializeExpectedType(typeArg))
        );
    }
    if (type instanceof UnionTypeValue) {
        return new UnionTypeValue(type.types.map((member) => materializeExpectedType(member)));
    }
    return type;
}

function resolveOverloadByExpectedType(referenceNode: AstNode, name: string, expectedType: TypeValue): FunctionTypeValue | undefined {
    const overloads = getVisibleResolvedFunctionOverloads(referenceNode, name);
    const concreteExpectedType = materializeExpectedType(expectedType);
    const matches = overloads.filter((overload) => isAssignable(overload.functionType, concreteExpectedType));
    if (matches.length === 1) {
        return matches[0].functionType;
    }
    if (matches.length > 1) {
        throw new TypeCheckError(`Ambiguous overloaded function value: ${name}`);
    }
    return undefined;
}

function resolveNamedCallByArguments(referenceNode: AstNode, name: string, args: AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): FunctionTypeValue | undefined {
    const overloads = getVisibleResolvedFunctionOverloads(referenceNode, name);
    const arityMatches = overloads.filter((overload) => overload.functionType.paramTypes.length === args.length);
    const matches: FunctionTypeValue[] = [];

    for (const overload of arityMatches) {
        let compatible = true;
        try {
            overload.functionType.paramTypes.forEach((paramType, index) => {
                typecheckAgainstExpectedType(args[index], paramType, varEnv, funcEnv, typeEnv);
            });
        } catch {
            compatible = false;
        }

        if (compatible) {
            matches.push(overload.functionType);
        }
    }

    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const actualArgTypes = args.map((arg) => typecheck(arg, varEnv, funcEnv, typeEnv));
        const exactMatches = matches.filter((candidate) => candidate.paramTypes.every((paramType, index) => typeEqual(paramType, actualArgTypes[index])));
        if (exactMatches.length === 1) {
            return exactMatches[0];
        }
        throw new TypeCheckError(`Ambiguous overloaded call to ${name}`);
    }
    return undefined;
}

interface ConstructorOverloadCandidate {
    readonly paramTypes: readonly TypeValue[];
}

function resolveConstructorOverloadByArguments(
    className: string,
    constructors: readonly ConstructorOverloadCandidate[],
    args: readonly AstNode[],
    varEnv: VarEnv,
    funcEnv: FunctionEnv,
    typeEnv: GenericTypeEnv
): readonly TypeValue[] {
    const arityMatches = constructors.filter((constructor) => constructor.paramTypes.length === args.length);
    const matches: (readonly TypeValue[])[] = [];

    for (const constructor of arityMatches) {
        let compatible = true;
        try {
            constructor.paramTypes.forEach((paramType, index) => {
                typecheckAgainstExpectedType(args[index], paramType, varEnv, funcEnv, typeEnv);
            });
        } catch {
            compatible = false;
        }

        if (compatible) {
            matches.push(constructor.paramTypes);
        }
    }

    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const actualArgTypes = args.map((arg) => typecheck(arg, varEnv, funcEnv, typeEnv));
        const exactMatches = matches.filter((candidate) => candidate.every((paramType, index) => typeEqual(paramType, actualArgTypes[index])));
        if (exactMatches.length === 1) {
            return exactMatches[0];
        }
        throw new TypeCheckError(`Ambiguous constructor call to ${className}`);
    }

    const actualArgTypes = args.map((arg) => typecheck(arg, varEnv, funcEnv, typeEnv));
    throw new TypeCheckError(`No constructor overload of ${className} matches argument types (${actualArgTypes.map(formatType).join(', ')})`);
}

function hasZeroArgConstructorOverload(constructors: readonly ConstructorOverloadCandidate[]): boolean {
    return constructors.some((constructor) => constructor.paramTypes.length === 0);
}

function typecheckAgainstExpectedType(ast: AstNode, expectedType: TypeValue, varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    return withActiveTypecheckNode(ast, (): TypeValue => {
        const concreteExpectedType = materializeExpectedType(expectedType);
        if (isMatchUnreachableCall(ast)) {
            if (ast.args.length !== 0) {
                throw new TypeCheckError("iw_match_unreachable expects exactly 0 arguments");
            }
            return concreteExpectedType;
        }
        if (ast instanceof IdentifierNode && !varEnv.has(ast.name)) {
            const overloadType = resolveOverloadByExpectedType(ast, ast.name, concreteExpectedType);
            if (overloadType) {
                return overloadType;
            }
        }

        if (ast instanceof NumberLiteralNode && concreteExpectedType instanceof PrimitiveTypeValue) {
            if (concreteExpectedType.name === ast.typeName) {
                return concreteExpectedType;
            }
        }

        if (ast instanceof SeqNode) {
            if (ast.expressions.length === 0) {
                throw new TypeCheckError("Seq requires at least one expression");
            }
            for (let index = 0; index < ast.expressions.length - 1; index++) {
                typecheck(ast.expressions[index], varEnv, funcEnv, typeEnv);
            }
            return typecheckAgainstExpectedType(ast.expressions[ast.expressions.length - 1], concreteExpectedType, varEnv, funcEnv, typeEnv);
        }

        if (ast instanceof ProgramNode) {
            if (ast.topLevelExpressions.length === 0) {
                throw new TypeCheckError("Program requires at least one top-level expression");
            }
            ast.topLevelExpressions.forEach((expression) => typecheck(expression, varEnv, funcEnv, typeEnv));
            const unitType = new PrimitiveTypeValue("unit");
            if (!isAssignable(unitType, concreteExpectedType)) {
                throw new TypeCheckError(`Type mismatch: expected ${formatType(concreteExpectedType)}, got ${formatType(unitType)}`);
            }
            return unitType;
        }

        if (ast instanceof IfNode) {
            const condType = typecheck(ast.condExpr, varEnv, funcEnv, typeEnv);
            const boolType = new PrimitiveTypeValue('bool');
            if (!typeEqual(condType, boolType)) {
                throw new TypeCheckError(`If condition must be bool, got ${formatType(condType)}`);
            }
            typecheckAgainstExpectedType(ast.trueBranchExpr, concreteExpectedType, varEnv, funcEnv, typeEnv);
            typecheckAgainstExpectedType(ast.falseBranchExpr, concreteExpectedType, varEnv, funcEnv, typeEnv);
            return concreteExpectedType;
        }

        if (ast instanceof CondNode) {
            const boolType = new PrimitiveTypeValue('bool');
            ast.clausesExprs.forEach((clause, index) => {
                const isElseClause = clause.cond instanceof IdentifierNode && clause.cond.name === 'else';
                if (isElseClause) {
                    if (index !== ast.clausesExprs.length - 1) {
                        throw new TypeCheckError("Cond else clause must be the last clause");
                    }
                } else {
                    const condType = typecheck(clause.cond, varEnv, funcEnv, typeEnv);
                    if (!typeEqual(condType, boolType)) {
                        throw new TypeCheckError(`Cond condition must be bool, got ${formatType(condType)}`);
                    }
                }
                typecheckAgainstExpectedType(clause.body, concreteExpectedType, varEnv, funcEnv, typeEnv);
            });
            return concreteExpectedType;
        }

        if (ast instanceof MatchNode) {
            const unionType = typecheck(ast.unionExpr, varEnv, funcEnv, typeEnv);
            if (!(unionType instanceof UnionTypeValue)) {
                throw new TypeCheckError(`Match expression must be union type, got ${formatType(unionType)}`);
            }

        const coveredTypes = new Set<string>();
        for (const branch of ast.branches) {
            const branchType = astToTypeValue(branch.bind.typeExp, typeEnv);
            const branchTypeName = formatType(branchType);
            if (!unionType.types.some((unionMember) => typeEqual(branchType, unionMember))) {
                throw new TypeCheckError(`Match branch type ${branchTypeName} is not a member of union type`);
            }
            if (coveredTypes.has(branchTypeName)) {
                throw new TypeCheckError(`Duplicate match branch for type ${branchTypeName}`);
            }
            coveredTypes.add(branchTypeName);

            const newVarEnv = varEnv.extend();
            newVarEnv.set(branch.bind.var.name, branchType);
            typecheckAgainstExpectedType(branch.body, concreteExpectedType, newVarEnv, funcEnv, typeEnv);
        }

        if (coveredTypes.size !== unionType.types.length) {
            throw new TypeCheckError("Match must cover all union type members");
        }
        return concreteExpectedType;
    }

        const actualType = typecheck(ast, varEnv, funcEnv, typeEnv);
        const concreteActualType = materializeExpectedType(actualType);
        if (!isAssignable(concreteActualType, concreteExpectedType)) {
            throw new TypeCheckError(`Type mismatch: expected ${formatType(concreteExpectedType)}, got ${formatType(concreteActualType)}`);
        }
        return concreteActualType;
    });
}

function getNamedFunctionType(referenceNode: AstNode, name: string, expectedType?: TypeValue): FunctionTypeValue | undefined {
    const existing = toplevelFunctionEnv.get(name);
    if (existing) {
        return existing;
    }

    const overloads = getVisibleResolvedFunctionOverloads(referenceNode, name);
    if (overloads.length === 1) {
        return overloads[0].functionType;
    }
    if (overloads.length > 1 && expectedType) {
        return resolveOverloadByExpectedType(referenceNode, name, expectedType);
    }
    return undefined;
}

function instantiateGenericFunction(node: GenericCallNode, typeEnv: GenericTypeEnv): FunctionTypeValue {
    if (!(node.callee instanceof IdentifierNode)) {
        throw new TypeCheckError("Generic function instantiation requires an identifier callee");
    }

    const functionName = node.callee.name;
    const resolvedGenericFunction = getVisibleResolvedGenericFunctionInfo(node, functionName, node.typeArgs.length);
    if (!resolvedGenericFunction) {
        throw new TypeCheckError(`Unknown generic function: ${functionName}`);
    }

    if (resolvedGenericFunction.typeParams.length !== node.typeArgs.length) {
        throw new TypeCheckError(`Generic function ${functionName} expects ${resolvedGenericFunction.typeParams.length} type arguments, got ${node.typeArgs.length}`);
    }

    const substitutions = new Map<string, TypeValue>();
    for (let i = 0; i < resolvedGenericFunction.typeParams.length; i++) {
        substitutions.set(resolvedGenericFunction.typeParams[i], astToTypeValue(node.typeArgs[i], typeEnv));
    }

    const concreteFunctionType = substituteTypeVariables(resolvedGenericFunction.functionType, substitutions);
    if (!(concreteFunctionType instanceof FunctionTypeValue)) {
        throw new TypeCheckError(`Generic function ${functionName} did not materialize to a callable function type`);
    }

    return concreteFunctionType;
}

function collectLetRecursiveFunctionTypes(bindings: readonly { bind: AstNode; value: AstNode }[], typeEnv: GenericTypeEnv): ReadonlyMap<string, FunctionTypeValue> {
    const recursiveFunctions = new Map<string, FunctionTypeValue>();
    for (const binding of bindings) {
        if (!(binding.bind instanceof TypeVarBindNode) || !(binding.value instanceof FnNode)) {
            continue;
        }
        const functionType = astToTypeValue(binding.bind.typeExp, typeEnv);
        if (functionType instanceof FunctionTypeValue) {
            recursiveFunctions.set(binding.bind.var.name, functionType);
        }
    }
    return recursiveFunctions;
}

function extendVarEnvWithRecursiveFunctions(baseEnv: VarEnv, recursiveFunctions: ReadonlyMap<string, FunctionTypeValue>): VarEnv {
    const extendedEnv = baseEnv.extend();
    for (const [name, functionType] of recursiveFunctions.entries()) {
        extendedEnv.set(name, functionType);
    }
    return extendedEnv;
}

function buildGeneratedVariadicTempName(): string {
    return `_uuid${randomUUID().replace(/-/g, "")}`;
}

function buildRightAssociatedCall(name: string, args: readonly AstNode[]): AstNode {
    if (args.length === 0) {
        throw new Error(`${name} requires at least one argument`);
    }
    if (args.length === 1) {
        return args[0];
    }

    let current: AstNode = new FunctionCallNode(new IdentifierNode(name), [args[args.length - 2], args[args.length - 1]]);
    for (let index = args.length - 3; index >= 0; index -= 1) {
        current = new FunctionCallNode(new IdentifierNode(name), [args[index], current]);
    }
    return current;
}

function expandVariadicComparisonCallAfterTypecheck(node: FunctionCallNode, varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): AstNode {
    if (!(node.callee instanceof IdentifierNode)) {
        return node;
    }
    if (!variadicComparisonBuiltinNames.has(node.callee.name) || node.args.length <= 2) {
        return node;
    }

    const builtinType = resolveVariadicComparisonBuiltinByArguments(node.callee.name, node.args, varEnv, funcEnv, typeEnv);
    if (builtinType === undefined) {
        throw new TypeCheckError(`internal error: expected variadic comparison builtin ${node.callee.name} to resolve after typechecking`);
    }

    const bindings: { bind: AstNode; value: AstNode }[] = node.args.map((arg) => ({
        bind: new TypeVarBindNode(new IdentifierNode(buildGeneratedVariadicTempName()), typeValueToTypeAst(builtinType.paramTypes[0])),
        value: arg
    }));

    const tempNames = bindings.map((binding) => {
        if (!(binding.bind instanceof TypeVarBindNode)) {
            throw new TypeCheckError("internal error: generated variadic comparison binding must be typed");
        }
        return binding.bind.var.name;
    });

    const pairwiseComparisons: AstNode[] = [];
    for (let index = 0; index < tempNames.length - 1; index += 1) {
        pairwiseComparisons.push(
            new FunctionCallNode(new IdentifierNode(node.callee.name), [
                new IdentifierNode(tempNames[index]),
                new IdentifierNode(tempNames[index + 1])
            ])
        );
    }

    return new LetNode(bindings, buildRightAssociatedCall("and", pairwiseComparisons));
}

function rewriteTypedVariadicComparisonsAfterTypecheck(ast: AstNode, varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): AstNode {
    if (ast instanceof ExportNode) {
        ast.inner = rewriteTypedVariadicComparisonsAfterTypecheck(ast.inner, varEnv, funcEnv, typeEnv);
        return ast;
    }
    if (ast instanceof DvarNode) {
        ast.value = rewriteTypedVariadicComparisonsAfterTypecheck(ast.value, varEnv, funcEnv, typeEnv);
        if (ast.bind instanceof TypeVarBindNode) {
            const declaredType = requireTypeAnnotation(ast.bind, typeEnv);
            const visibleGlobalInfo = getVisibleGlobalVarInfo(ast.bind.var, ast.bind.var.name);
            const isModuleGlobal = getCompilationUnitMetadata(ast) !== undefined
                && varEnv === toplevelVarEnv
                && visibleGlobalInfo !== undefined
                && visibleGlobalInfo.bind === ast.bind;
            if (!isModuleGlobal) {
                varEnv.set(ast.bind.var.name, declaredType);
            }
        }
        return ast;
    }
    if (ast instanceof SetNode) {
        ast.value = rewriteTypedVariadicComparisonsAfterTypecheck(ast.value, varEnv, funcEnv, typeEnv);
        return ast;
    }
    if (ast instanceof FnNode) {
        const newVarEnv = varEnv.extend();
        const newTypeEnv = new GenericTypeEnv(undefined, typeEnv);
        for (const param of ast.params) {
            newVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, newTypeEnv));
        }
        ast.body = rewriteTypedVariadicComparisonsAfterTypecheck(ast.body, newVarEnv, funcEnv, newTypeEnv);
        return ast;
    }
    if (ast instanceof DfunNode) {
        const newVarEnv = varEnv.extend();
        for (const param of ast.params) {
            newVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, typeEnv));
        }
        ast.body = rewriteTypedVariadicComparisonsAfterTypecheck(ast.body, newVarEnv, funcEnv, typeEnv);
        return ast;
    }
    if (ast instanceof GenericDfunNode) {
        const genericTypeEnv = new GenericTypeEnv(undefined, typeEnv);
        for (const typeParam of ast.genericName.genericTypeArgs) {
            genericTypeEnv.set(typeParam.name, new TypeParameterValue(typeParam.name));
        }
        const newVarEnv = varEnv.extend();
        for (const param of ast.params) {
            newVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, genericTypeEnv));
        }
        ast.body = rewriteTypedVariadicComparisonsAfterTypecheck(ast.body, newVarEnv, funcEnv, genericTypeEnv);
        return ast;
    }
    if (ast instanceof LetNode) {
        const newVarEnv = varEnv.extend();
        const newTypeEnv = new GenericTypeEnv(undefined, typeEnv);
        const recursiveFunctions = collectLetRecursiveFunctionTypes(ast.bindings, newTypeEnv);

        ast.bindings = ast.bindings.map((binding) => {
            if (!(binding.bind instanceof TypeVarBindNode)) {
                throw new TypeCheckError("let requires type bindings");
            }
            const bindingValueEnv = binding.value instanceof FnNode
                ? extendVarEnvWithRecursiveFunctions(newVarEnv, recursiveFunctions)
                : newVarEnv;
            const rewrittenValue = rewriteTypedVariadicComparisonsAfterTypecheck(binding.value, bindingValueEnv, funcEnv, newTypeEnv);
            newVarEnv.set(binding.bind.var.name, astToTypeValue(binding.bind.typeExp, newTypeEnv));
            return {
                bind: binding.bind,
                value: rewrittenValue
            };
        });
        ast.body = rewriteTypedVariadicComparisonsAfterTypecheck(ast.body, newVarEnv, funcEnv, newTypeEnv);
        return ast;
    }
    if (ast instanceof IfNode) {
        ast.condExpr = rewriteTypedVariadicComparisonsAfterTypecheck(ast.condExpr, varEnv, funcEnv, typeEnv);
        ast.trueBranchExpr = rewriteTypedVariadicComparisonsAfterTypecheck(ast.trueBranchExpr, varEnv, funcEnv, typeEnv);
        ast.falseBranchExpr = rewriteTypedVariadicComparisonsAfterTypecheck(ast.falseBranchExpr, varEnv, funcEnv, typeEnv);
        return ast;
    }
    if (ast instanceof WhileNode) {
        ast.condExpr = rewriteTypedVariadicComparisonsAfterTypecheck(ast.condExpr, varEnv, funcEnv, typeEnv);
        ast.bodyExpr = rewriteTypedVariadicComparisonsAfterTypecheck(ast.bodyExpr, varEnv, funcEnv, typeEnv);
        return ast;
    }
    if (ast instanceof CondNode) {
        ast.clausesExprs = ast.clausesExprs.map((clause) => ({
            cond: rewriteTypedVariadicComparisonsAfterTypecheck(clause.cond, varEnv, funcEnv, typeEnv),
            body: rewriteTypedVariadicComparisonsAfterTypecheck(clause.body, varEnv, funcEnv, typeEnv)
        }));
        return ast;
    }
    if (ast instanceof SeqNode) {
        ast.expressions = ast.expressions.map((expression) => rewriteTypedVariadicComparisonsAfterTypecheck(expression, varEnv, funcEnv, typeEnv));
        return ast;
    }
    if (ast instanceof MatchNode) {
        ast.unionExpr = rewriteTypedVariadicComparisonsAfterTypecheck(ast.unionExpr, varEnv, funcEnv, typeEnv);
        ast.branches = ast.branches.map((branch) => {
            const branchVarEnv = varEnv.extend();
            branchVarEnv.set(branch.bind.var.name, astToTypeValue(branch.bind.typeExp, typeEnv));
            return {
                bind: branch.bind,
                body: rewriteTypedVariadicComparisonsAfterTypecheck(branch.body, branchVarEnv, funcEnv, typeEnv)
            };
        });
        return ast;
    }
    if (ast instanceof FunctionCallNode) {
        ast.callee = rewriteTypedVariadicComparisonsAfterTypecheck(ast.callee, varEnv, funcEnv, typeEnv);
        ast.args = ast.args.map((arg) => rewriteTypedVariadicComparisonsAfterTypecheck(arg, varEnv, funcEnv, typeEnv));
        return expandVariadicComparisonCallAfterTypecheck(ast, varEnv, funcEnv, typeEnv);
    }
    if (ast instanceof ClassNode) {
        rewriteTypedVariadicComparisonsInClassDefinition(ast, varEnv, funcEnv, typeEnv);
        return ast;
    }
    if (ast instanceof GenericClassNode) {
        rewriteTypedVariadicComparisonsInGenericClassDefinition(ast, varEnv, funcEnv, typeEnv);
        return ast;
    }
    if (ast instanceof ProgramNode) {
        ast.topLevelExpressions = ast.topLevelExpressions.map((expression) => rewriteTypedVariadicComparisonsAfterTypecheck(expression, varEnv, funcEnv, typeEnv));
        return ast;
    }
    return ast;
}

function rewriteTypedVariadicComparisonsInClassDefinition(node: ClassNode, varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): void {
    const resolvedClassInfo = resolveVisibleClassInfoWithCurrentPackageFallback(node.name, node.name.name);
    const nodeMetadata = getCompilationUnitMetadata(node);
    const selfClassName = resolvedClassInfo?.name
        ?? (nodeMetadata !== undefined && !node.name.name.includes("@") ? `${nodeMetadata.packageName}@${node.name.name}` : node.name.name);
    const selfType = new ClassTypeValue(selfClassName);

    node.methodNodeList.forEach((method) => {
        const methodVarEnv = varEnv.extend();
        methodVarEnv.setImmutable("self", selfType);
        method.params.forEach((param) => methodVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, typeEnv)));
        method.body = rewriteTypedVariadicComparisonsAfterTypecheck(method.body, methodVarEnv, funcEnv, typeEnv);
    });

    node.constructorNodeList.forEach((ctor) => {
        const ctorVarEnv = varEnv.extend();
        ctorVarEnv.setImmutable("self", selfType);
        ctor.params.forEach((param) => ctorVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, typeEnv)));
        ctor.body = rewriteTypedVariadicComparisonsAfterTypecheck(ctor.body, ctorVarEnv, funcEnv, typeEnv);
    });
}

function rewriteTypedVariadicComparisonsInGenericClassDefinition(node: GenericClassNode, varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): void {
    const genericTypeEnv = new GenericTypeEnv(undefined, typeEnv);
    const selfTypeArgs: TypeValue[] = [];
    node.genericName.genericTypeArgs.forEach((typeParam) => {
        const typeValue = new TypeParameterValue(typeParam.name);
        genericTypeEnv.set(typeParam.name, typeValue);
        selfTypeArgs.push(typeValue);
    });
    const resolvedGenericClassInfo = resolveVisibleGenericClassInfoWithCurrentPackageFallback(node.genericName.name, node.genericName.name.name, node.genericName.genericTypeArgs.length);
    const nodeMetadata = getCompilationUnitMetadata(node);
    const selfGenericName = resolvedGenericClassInfo?.genericName
        ?? (nodeMetadata !== undefined && !node.genericName.name.name.includes("@") ? `${nodeMetadata.packageName}@${node.genericName.name.name}` : node.genericName.name.name);
    const selfType = new GenericClassInstanceTypeValue(selfGenericName, selfTypeArgs);

    node.methodNodeList.forEach((method) => {
        const methodVarEnv = varEnv.extend();
        methodVarEnv.setImmutable("self", selfType);
        method.params.forEach((param) => methodVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, genericTypeEnv)));
        method.body = rewriteTypedVariadicComparisonsAfterTypecheck(method.body, methodVarEnv, funcEnv, genericTypeEnv);
    });

    node.constructorNodeList.forEach((ctor) => {
        const ctorVarEnv = varEnv.extend();
        ctorVarEnv.setImmutable("self", selfType);
        ctor.params.forEach((param) => ctorVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, genericTypeEnv)));
        ctor.body = rewriteTypedVariadicComparisonsAfterTypecheck(ctor.body, ctorVarEnv, funcEnv, genericTypeEnv);
    });
}

/**
 * 主要的类型检查函数
 */
export function typecheck(ast: AstNode, varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    return withActiveTypecheckNode(ast, (): TypeValue => {
    switch (ast.kind) {
        case AstNodeType.IdentifierNode: {
            if (!(ast instanceof IdentifierNode)) {
                throw new TypeCheckError("internal error: expected IdentifierNode");
            }
            const node = ast;
            
            // 检查是否为布尔字面量
            if (node.name === 'true' || node.name === 'false') {
                return new PrimitiveTypeValue('bool');
            }
            if (node.name === 'unit') {
                return new PrimitiveTypeValue('unit');
            }
            
            // 检查变量
            const varType = varEnv.get(node.name);
            if (varType) {
                return varType;
            }

            const globalVarInfo = getVisibleGlobalVarInfo(node, node.name);
            if (globalVarInfo) {
                return requireTypeAnnotation(globalVarInfo.bind, typeEnv);
            }

            const namedFunctionType = getNamedFunctionType(node, node.name);
            if (namedFunctionType) {
                return namedFunctionType;
            }

            if (getVisibleResolvedFunctionOverloads(node, node.name).length > 1) {
                throw new TypeCheckError(`Ambiguous overloaded function value: ${node.name}`);
            }
            
            throw new TypeCheckError(`Undefined variable: ${node.name}`);
        }

        case AstNodeType.TextDatabaseReferenceNode: {
            if (!(ast instanceof TextDatabaseReferenceNode)) {
                throw new TypeCheckError("internal error: expected TextDatabaseReferenceNode");
            }
            if (currentStringDatabase === null) {
                throw new TypeCheckError(`Literal db is required to resolve ${ast.referenceName}`);
            }
            let resolvedReferenceName = ast.referenceName;
            let resolvedContent = currentStringDatabase.get(resolvedReferenceName);
            if (resolvedContent === undefined) {
                const visibleCanonicalNames = getVisibleDatabaseReferenceCanonicalNames(ast, ast.referenceName, `${ast.entryName}^${ast.typeName}`);
                if (visibleCanonicalNames.length === 1) {
                    resolvedReferenceName = visibleCanonicalNames[0];
                    resolvedContent = currentStringDatabase.get(resolvedReferenceName);
                }
            }
            if (resolvedContent === undefined) {
                throw new TypeCheckError(`Missing literal db entry: ${ast.referenceName}`);
            }
            ast.referenceName = resolvedReferenceName;
            ast.content = resolveTypedReferenceContent(ast, resolvedContent);
            return new PrimitiveTypeValue(ast.typeName);
        }

        case AstNodeType.NumberLiteralNode: {
            if (!(ast instanceof NumberLiteralNode)) {
                throw new TypeCheckError("internal error: expected NumberLiteralNode");
            }
            return new PrimitiveTypeValue(ast.typeName);
        }

        case AstNodeType.ExportNode: {
            if (!(ast instanceof ExportNode)) {
                throw new TypeCheckError("internal error: expected ExportNode");
            }
            return typecheck(ast.inner, varEnv, funcEnv, typeEnv);
        }

        case AstNodeType.PublicNode: {
            throw new TypeCheckError("public declarations must appear inside class bodies");
        }

        case AstNodeType.DvarNode: {
            if (!(ast instanceof DvarNode)) {
                throw new TypeCheckError("internal error: expected DvarNode");
            }
            const node = ast;
            if (!(node.bind instanceof TypeVarBindNode)) {
                throw new TypeCheckError("var requires type binding");
            }
            const bindNode = node.bind;
            const declaredType = requireTypeAnnotation(bindNode, typeEnv);
            try {
                typecheckAgainstExpectedType(node.value, declaredType, varEnv, funcEnv, typeEnv);
            } catch (error) {
                if (error instanceof TypeCheckError && error.message.includes("Type mismatch:")) {
                    const valueType = typecheck(node.value, varEnv, funcEnv, typeEnv);
                    throw new TypeCheckError(`Type mismatch in var: declared ${formatType(declaredType)}, got ${formatType(valueType)}`);
                }
                throw error;
            }

            const visibleGlobalInfo = getVisibleGlobalVarInfo(bindNode.var, bindNode.var.name);
            const isModuleGlobal = getCompilationUnitMetadata(node) !== undefined
                && varEnv === toplevelVarEnv
                && visibleGlobalInfo !== undefined
                && visibleGlobalInfo.bind === bindNode;
            if (isModuleGlobal) {
                validateTopLevelGlobalDefinition(bindNode.var.name, declaredType, node.value);
            } else {
                varEnv.set(bindNode.var.name, declaredType);
            }
            return declaredType;
        }

        case AstNodeType.SetNode: {
            if (!(ast instanceof SetNode)) {
                throw new TypeCheckError("internal error: expected SetNode");
            }
            const node = ast;
            const varType = varEnv.get(node.identifier.name);
            if (!varType) {
                const globalVarInfo = getVisibleGlobalVarInfo(node.identifier, node.identifier.name);
                if (globalVarInfo) {
                    if (!canWriteVisibleGlobal(node.identifier, globalVarInfo)) {
                        throw new TypeCheckError(`Cannot var_set imported global: ${node.identifier.name}`);
                    }
                    typecheckAgainstExpectedType(node.value, requireTypeAnnotation(globalVarInfo.bind, typeEnv), varEnv, funcEnv, typeEnv);
                    return new PrimitiveTypeValue("unit");
                }
                throw new TypeCheckError(`Undefined variable in var_set: ${node.identifier.name}`);
            }

            if (varEnv.isImmutable(node.identifier.name)) {
                throw new TypeCheckError(`Cannot var_set immutable binding: ${node.identifier.name}`);
            }
            
            try {
                typecheckAgainstExpectedType(node.value, varType, varEnv, funcEnv, typeEnv);
                return new PrimitiveTypeValue("unit");
            } catch (error) {
                if (error instanceof TypeCheckError && error.message.includes("Type mismatch:")) {
                    const valueType = typecheck(node.value, varEnv, funcEnv, typeEnv);
                    throw new TypeCheckError(`Type mismatch in var_set: expected ${formatType(varType)}, got ${formatType(valueType)}`);
                }
                throw error;
            }
        }

        case AstNodeType.FnNode: {
            if (!(ast instanceof FnNode)) {
                throw new TypeCheckError("internal error: expected FnNode");
            }
            const node = ast;
            const paramTypes: TypeValue[] = [];
            const newVarEnv = varEnv.extend();
            const newTypeEnv = new GenericTypeEnv(undefined, typeEnv);
            
            // 处理参数
            for (const param of node.params) {
                const paramType = requireTypeAnnotation(param, newTypeEnv);
                paramTypes.push(paramType);
                newVarEnv.setImmutable(param.var.name, paramType);
            }
            
            const returnType = astToTypeValue(node.returnType, newTypeEnv);
            typecheckAgainstExpectedType(node.body, returnType, newVarEnv, funcEnv, newTypeEnv);
            
            return new FunctionTypeValue(paramTypes, returnType);
        }

        case AstNodeType.DfunNode: {
            if (!(ast instanceof DfunNode)) {
                throw new TypeCheckError("internal error: expected DfunNode");
            }
            const node = ast;
            const paramTypes: TypeValue[] = [];
            
            // 处理参数
            for (const param of node.params) {
                const paramType = requireTypeAnnotation(param, typeEnv);
                paramTypes.push(paramType);
            }
            
            const returnType = astToTypeValue(node.returnType, typeEnv);
            const funcType = new FunctionTypeValue(paramTypes, returnType);
            
            // 检查函数体
            const newVarEnv = varEnv.extend();
            for (let i = 0; i < node.params.length; i++) {
                newVarEnv.setImmutable(node.params[i].var.name, paramTypes[i]);
            }
            typecheckAgainstExpectedType(node.body, returnType, newVarEnv, funcEnv, typeEnv);
            
            return funcType;
        }

        case AstNodeType.DeclaredDfunNode: {
            return new PrimitiveTypeValue('unit');
        }

        case AstNodeType.ImportNode: {
            return new PrimitiveTypeValue('unit');
        }

        case AstNodeType.LetNode: {
            if (!(ast instanceof LetNode)) {
                throw new TypeCheckError("internal error: expected LetNode");
            }
            const node = ast;
            const newVarEnv = varEnv.extend();
            const newTypeEnv = new GenericTypeEnv(undefined, typeEnv);
            const recursiveFunctions = collectLetRecursiveFunctionTypes(node.bindings, newTypeEnv);
            
            // let bindings are checked left-to-right. fn-valued bindings additionally
            // see the full local recursive function set, while ordinary bindings
            // remain strictly prefix-visible.
            for (const binding of node.bindings) {
                if (!(binding.bind instanceof TypeVarBindNode)) {
                    throw new TypeCheckError("let requires type bindings");
                }
                const bindNode = binding.bind;
                const bindingValueEnv = binding.value instanceof FnNode
                    ? extendVarEnvWithRecursiveFunctions(newVarEnv, recursiveFunctions)
                    : newVarEnv;
                const declaredType = astToTypeValue(bindNode.typeExp, newTypeEnv);
                typecheckAgainstExpectedType(binding.value, declaredType, bindingValueEnv, funcEnv, newTypeEnv);
                newVarEnv.set(bindNode.var.name, declaredType);
            }
            
            return typecheck(node.body, newVarEnv, funcEnv, newTypeEnv);
        }

        case AstNodeType.IfNode: {
            if (!(ast instanceof IfNode)) {
                throw new TypeCheckError("internal error: expected IfNode");
            }
            const node = ast;
            const condType = typecheck(node.condExpr, varEnv, funcEnv, typeEnv);
            const boolType = new PrimitiveTypeValue('bool');
            
            if (!typeEqual(condType, boolType)) {
                throw new TypeCheckError(`If condition must be bool, got ${formatType(condType)}`);
            }
            
            const trueType = typecheck(node.trueBranchExpr, varEnv, funcEnv, typeEnv);
            const falseType = typecheck(node.falseBranchExpr, varEnv, funcEnv, typeEnv);
            
            if (!typeEqual(trueType, falseType)) {
                throw new TypeCheckError(`If branches must have same type: true branch ${formatType(trueType)}, false branch ${formatType(falseType)}`);
            }
            
            return trueType;
        }

        case AstNodeType.WhileNode: {
            if (!(ast instanceof WhileNode)) {
                throw new TypeCheckError("internal error: expected WhileNode");
            }
            const condType = typecheck(ast.condExpr, varEnv, funcEnv, typeEnv);
            const boolType = new PrimitiveTypeValue('bool');
            if (!typeEqual(condType, boolType)) {
                throw new TypeCheckError(`While condition must be bool, got ${formatType(condType)}`);
            }
            typecheck(ast.bodyExpr, varEnv, funcEnv, typeEnv);
            return new PrimitiveTypeValue('unit');
        }

        case AstNodeType.CondNode: {
            if (!(ast instanceof CondNode)) {
                throw new TypeCheckError("internal error: expected CondNode");
            }
            const node = ast;
            const boolType = new PrimitiveTypeValue('bool');
            let resultType: TypeValue | undefined;
            
            for (const clause of node.clausesExprs) {
                const isElseClause = clause.cond instanceof IdentifierNode && clause.cond.name === 'else';
                if (isElseClause) {
                    if (clause !== node.clausesExprs[node.clausesExprs.length - 1]) {
                        throw new TypeCheckError("Cond else clause must be the last clause");
                    }
                } else {
                    const condType = typecheck(clause.cond, varEnv, funcEnv, typeEnv);
                    if (!typeEqual(condType, boolType)) {
                        throw new TypeCheckError(`Cond condition must be bool, got ${formatType(condType)}`);
                    }
                }
                
                const bodyType = typecheck(clause.body, varEnv, funcEnv, typeEnv);
                if (!resultType) {
                    resultType = bodyType;
                } else if (!typeEqual(resultType, bodyType)) {
                    throw new TypeCheckError(`All cond branches must have same type: expected ${formatType(resultType)}, got ${formatType(bodyType)}`);
                }
            }
            
            if (!resultType) {
                throw new TypeCheckError("Cond must have at least one clause");
            }

            const lastClause = node.clausesExprs[node.clausesExprs.length - 1];
            const hasElseClause = lastClause.cond instanceof IdentifierNode && lastClause.cond.name === 'else';
            if (!hasElseClause) {
                throw new TypeCheckError("Cond must end with an else clause");
            }
            
            return resultType;
        }

        case AstNodeType.SeqNode: {
            if (!(ast instanceof SeqNode)) {
                throw new TypeCheckError("internal error: expected SeqNode");
            }
            const node = ast;
            if (node.expressions.length === 0) {
                throw new TypeCheckError("Seq must have at least one expression");
            }
            
            let lastType: TypeValue | undefined;
            for (const expr of node.expressions) {
                lastType = typecheck(expr, varEnv, funcEnv, typeEnv);
            }
            
            return lastType!;
        }

        case AstNodeType.ProgramNode: {
            if (!(ast instanceof ProgramNode)) {
                throw new TypeCheckError("internal error: expected ProgramNode");
            }
            if (ast.topLevelExpressions.length === 0) {
                throw new TypeCheckError("Program must have at least one top-level expression");
            }

            for (const expr of ast.topLevelExpressions) {
                typecheck(expr, varEnv, funcEnv, typeEnv);
            }

            return new PrimitiveTypeValue("unit");
        }

        case AstNodeType.MatchNode: {
            if (!(ast instanceof MatchNode)) {
                throw new TypeCheckError("internal error: expected MatchNode");
            }
            const node = ast;
            const unionType = typecheck(node.unionExpr, varEnv, funcEnv, typeEnv);
            
            if (!(unionType instanceof UnionTypeValue)) {
                throw new TypeCheckError(`Match expression must be union type, got ${formatType(unionType)}`);
            }
            
            // 检查所有联合类型成员都被覆盖
            const coveredTypes = new Set<string>();
            let resultType: TypeValue | undefined;
            
            for (const branch of node.branches) {
                const branchType = astToTypeValue(branch.bind.typeExp, typeEnv);
                const branchTypeName = formatType(branchType);
                
                // 检查分支类型是否为联合类型成员
                let found = false;
                for (const unionMember of unionType.types) {
                    if (typeEqual(branchType, unionMember)) {
                        found = true;
                        break;
                    }
                }
                
                if (!found) {
                    throw new TypeCheckError(`Match branch type ${branchTypeName} is not a member of union type`);
                }
                
                if (coveredTypes.has(branchTypeName)) {
                    throw new TypeCheckError(`Duplicate match branch for type ${branchTypeName}`);
                }
                coveredTypes.add(branchTypeName);
                
                // 检查分支体
                const newVarEnv = varEnv.extend();
                newVarEnv.set(branch.bind.var.name, branchType);
                const bodyType = typecheck(branch.body, newVarEnv, funcEnv, typeEnv);
                
                if (!resultType) {
                    resultType = bodyType;
                } else if (!typeEqual(resultType, bodyType)) {
                    throw new TypeCheckError(`All match branches must have same type: expected ${formatType(resultType)}, got ${formatType(bodyType)}`);
                }
            }
            
            // 检查是否所有联合成员都被覆盖
            if (coveredTypes.size !== unionType.types.length) {
                throw new TypeCheckError("Match must cover all union type members");
            }
            
            return resultType!;
        }

        case AstNodeType.FunctionCallNode: {
            if (!(ast instanceof FunctionCallNode)) {
                throw new TypeCheckError("internal error: expected FunctionCallNode");
            }
            const node = ast;
            
            const firstElement = node.callee;//.elements[0];
            
            // 检查是否为内置函数调用
            if (firstElement instanceof IdentifierNode) {
                const funcName = firstElement.name;
                if (funcName === 'iw_match_unreachable') {
                    if (node.args.length !== 0) {
                        throw new TypeCheckError("iw_match_unreachable expects exactly 0 arguments");
                    }
                    return new PrimitiveTypeValue('unit');
                }
                const builtinType = resolveBuiltinCallByArguments(funcName, node.args, varEnv, funcEnv, typeEnv);
                if (builtinType) {
                    return builtinType.returnType;
                }
                const funcType = funcEnv.get(funcName);
                
                if (funcType) {
                    // 检查参数数量
                    const expectedArgCount = funcType.paramTypes.length;
                    const actualArgCount = node.args.length;
                    
                    if (expectedArgCount !== actualArgCount) {
                        throw new TypeCheckError(`Function ${funcName} expects ${expectedArgCount} arguments, got ${actualArgCount}`);
                    }
                    
                    // 检查参数类型
                    for (let i = 0; i < expectedArgCount; i++) {
                        const expectedType = funcType.paramTypes[i];
                        typecheckAgainstExpectedType(node.args[i], expectedType, varEnv, funcEnv, typeEnv);
                    }
                    
                    return funcType.returnType;
                }
                
                // 检查特殊关键字
                if (funcName === 'class_new') {
                    return typecheckNew(node.args, varEnv, funcEnv, typeEnv);
                }
                
                if (funcName === 'cm_get') {
                    return typecheckGetClassMember(node.args, varEnv, funcEnv, typeEnv);
                }
                
                if (funcName === 'cm_set') {
                    return typecheckSetClassMember(node.args, varEnv, funcEnv, typeEnv);
                }

                if (funcName === 'array_new') {
                    return typecheckArrayNew(node.args, varEnv, funcEnv, typeEnv);
                }
                if (funcName === 'array_get') {
                    return typecheckArrayGet(node.args, varEnv, funcEnv, typeEnv);
                }
                if (funcName === 'array_set') {
                    return typecheckArraySet(node.args, varEnv, funcEnv, typeEnv);
                }
                if (funcName === 'array_length') {
                    return typecheckArrayLength(node.args, varEnv, funcEnv, typeEnv);
                }
                if (getTextPrimitiveBuiltinFamilySpec(funcName)) {
                    return typecheckTextPrimitiveBuiltinCall(funcName, node.args, varEnv, funcEnv, typeEnv);
                }
                if (getComplexPrimitiveBuiltinFamilySpec(funcName)) {
                    return typecheckComplexPrimitiveBuiltinCall(funcName, node.args, varEnv, funcEnv, typeEnv);
                }

                const overloadType = resolveNamedCallByArguments(firstElement, funcName, node.args, varEnv, funcEnv, typeEnv);
                if (overloadType) {
                    return overloadType.returnType;
                }
                if (getVisibleResolvedFunctionOverloads(firstElement, funcName).length > 0) {
                    const argTypes = node.args.map((arg) => typecheck(arg, varEnv, funcEnv, typeEnv));
                    throw new TypeCheckError(`No overload of ${funcName} matches argument types (${argTypes.map(formatType).join(', ')})`);
                }
                if (isBuiltinCallName(funcName)) {
                    const argTypes = node.args.map((arg) => typecheck(arg, varEnv, funcEnv, typeEnv));
                    throw new TypeCheckError(`No overload of ${funcName} matches argument types (${argTypes.map(formatType).join(', ')})`);
                }
            }
            
            // 普通函数调用
            const calleeType = materializeExpectedType(typecheck(firstElement, varEnv, funcEnv, typeEnv));
            if (!(calleeType instanceof FunctionTypeValue)) {
                throw new TypeCheckError(`Cannot call non-function type: ${formatType(calleeType)}`);
            }
            
            const expectedArgCount = calleeType.paramTypes.length;
            const actualArgCount = node.args.length;
            
            if (expectedArgCount !== actualArgCount) {
                throw new TypeCheckError(`Function call expects ${expectedArgCount} arguments, got ${actualArgCount}`);
            }
            
            for (let i = 0; i < expectedArgCount; i++) {
                const expectedType = calleeType.paramTypes[i];
                typecheckAgainstExpectedType(node.args[i], expectedType, varEnv, funcEnv, typeEnv);
            }
            
            return calleeType.returnType;
        }

        case AstNodeType.GenericCallNode: {
            if (!(ast instanceof GenericCallNode)) {
                throw new TypeCheckError("internal error: expected GenericCallNode");
            }
            const node = ast;
            if (node.callee instanceof IdentifierNode && node.callee.name === 'class_new') {
                if (node.typeArgs.length === 0) {
                    throw new TypeCheckError("class_new requires a class name");
                }
                const [classNameNode, ...classTypeArgs] = node.typeArgs;
                const genericClassNode = classTypeArgs.length > 0
                    ? new GenericCallNode(classNameNode, classTypeArgs)
                    : classNameNode;
                return typecheckNew([genericClassNode], varEnv, funcEnv, typeEnv);
            }
            if (node.callee instanceof IdentifierNode && hasVisibleGenericClassInfo(node.callee, node.callee.name)) {
                throw new TypeCheckError(`Generic class ${node.callee.name} cannot appear in value position`);
            }
            return instantiateGenericFunction(node, typeEnv);
        }

        case AstNodeType.ClassNode: {
            if (!(ast instanceof ClassNode)) {
                throw new TypeCheckError("internal error: expected ClassNode");
            }
            const node = ast;
            typecheckClassDefinition(node, varEnv, funcEnv, typeEnv);
            return new ClassTypeValue(node.name.name);
        }

        case AstNodeType.GenericClassNode: {
            if (!(ast instanceof GenericClassNode)) {
                throw new TypeCheckError("internal error: expected GenericClassNode");
            }
            const node = ast;
            typecheckGenericClassDefinition(node, varEnv, funcEnv, typeEnv);
            return new ClassTypeValue(node.genericName.name.name);
        }

        case AstNodeType.GenericDfunNode: {
            if (!(ast instanceof GenericDfunNode)) {
                throw new TypeCheckError("internal error: expected GenericDfunNode");
            }
            const node = ast;
            const genericTypeEnv = new GenericTypeEnv(undefined, typeEnv);
            for (const typeParam of node.genericName.genericTypeArgs) {
                genericTypeEnv.set(typeParam.name, new TypeParameterValue(typeParam.name));
            }

            const paramTypes = node.params.map((param) => requireTypeAnnotation(param, genericTypeEnv));
            const returnType = astToTypeValue(node.returnType, genericTypeEnv);
            const funcType = new FunctionTypeValue(paramTypes, returnType);

            const newVarEnv = varEnv.extend();
            for (let i = 0; i < node.params.length; i++) {
                newVarEnv.setImmutable(node.params[i].var.name, paramTypes[i]);
            }

            typecheckAgainstExpectedType(node.body, returnType, newVarEnv, funcEnv, genericTypeEnv);

            return funcType;
        }

        default:
            throw new TypeCheckError(`Unhandled AST node type: ${ast.kind}`);
    }
    });
}

/**
 * 类型检查 class_new 表达式
 */
function typecheckNew(args: AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    if (args.length === 0) {
        throw new TypeCheckError("class_new requires class name");
    }
    
    const classNameNode = args[0];
    if (classNameNode instanceof IdentifierNode) {
        const className = classNameNode.name;
        const classInfo = getVisibleClassInfo(classNameNode, className);
        
        if (classInfo) {
            const constructorParamTypes = resolveConstructorOverloadByArguments(
                classInfo.name,
                classInfo.constructors.map((constructor) => ({
                    paramTypes: constructor.params.map((param) => astToTypeValue(param.typeExp, typeEnv))
                })),
                args.slice(1),
                varEnv,
                funcEnv,
                typeEnv
            );

            for (let i = 0; i < constructorParamTypes.length; i++) {
                typecheckAgainstExpectedType(args[i + 1], constructorParamTypes[i], varEnv, funcEnv, typeEnv);
            }
            
            return new ClassTypeValue(classInfo.name);
        }

        const monomorphizedClassInfo = monomorphizedClassTable.get(className);
        if (monomorphizedClassInfo) {
            const constructorParamTypes = resolveConstructorOverloadByArguments(
                className,
                monomorphizedClassInfo.constructorParamTypes.map((paramTypes) => ({ paramTypes })),
                args.slice(1),
                varEnv,
                funcEnv,
                typeEnv
            );

            for (let i = 0; i < constructorParamTypes.length; i++) {
                typecheckAgainstExpectedType(args[i + 1], constructorParamTypes[i], varEnv, funcEnv, typeEnv);
            }

            return new ClassTypeValue(className);
        }
    }
    
    // 处理泛型类实例化
    if (classNameNode instanceof AngleParenListNode) {
        const angleNode = classNameNode;
        if (angleNode.elements.length > 0 && angleNode.elements[0].kind === AstNodeType.IdentifierNode) {
            const firstElement = angleNode.elements[0];
            if (!(firstElement instanceof IdentifierNode)) {
                throw new TypeCheckError("Generic class instantiation requires an identifier name");
            }
            const genericClassName = firstElement.name;
            const typeArgs = angleNode.elements.slice(1).map((arg) => astToTypeValue(arg, typeEnv));
            const genericClassInfo = resolveVisibleGenericClassInfoWithCurrentPackageFallback(firstElement, genericClassName, typeArgs.length);
            
            if (genericClassInfo) {
                if (typeArgs.length !== genericClassInfo.typeParams.length) {
                    throw new TypeCheckError(`Generic class ${genericClassName} expects ${genericClassInfo.typeParams.length} type arguments, got ${typeArgs.length}`);
                }

                const substitutionEnv = new GenericTypeEnv(undefined, typeEnv);
                for (let i = 0; i < genericClassInfo.typeParams.length; i++) {
                    substitutionEnv.set(genericClassInfo.typeParams[i], typeArgs[i]);
                }

                const constructorParamTypes = resolveConstructorOverloadByArguments(
                    genericClassInfo.genericName,
                    genericClassInfo.constructors.map((constructor) => ({
                        paramTypes: constructor.params.map((param) => astToTypeValue(param.typeExp, substitutionEnv))
                    })),
                    args.slice(1),
                    varEnv,
                    funcEnv,
                    typeEnv
                );

                for (let i = 0; i < constructorParamTypes.length; i++) {
                    typecheckAgainstExpectedType(args[i + 1], constructorParamTypes[i], varEnv, funcEnv, typeEnv);
                }
                
                return new GenericClassInstanceTypeValue(genericClassInfo.genericName, typeArgs);
            }
        }
    }

    if (classNameNode instanceof GenericCallNode) {
        const genericCallNode = classNameNode;
        if (!(genericCallNode.callee instanceof IdentifierNode)) {
            throw new TypeCheckError("Generic class instantiation requires identifier callee");
        }

        const genericClassName = genericCallNode.callee.name;
        const typeArgs = genericCallNode.typeArgs.map((arg) => astToTypeValue(arg, typeEnv));
        const genericClassInfo = resolveVisibleGenericClassInfoWithCurrentPackageFallback(genericCallNode, genericClassName, typeArgs.length);
        if (!genericClassInfo) {
            throw new TypeCheckError(`Unknown generic class: ${genericClassName}`);
        }

        if (typeArgs.length !== genericClassInfo.typeParams.length) {
            throw new TypeCheckError(`Generic class ${genericClassName} expects ${genericClassInfo.typeParams.length} type arguments, got ${typeArgs.length}`);
        }

        const substitutionEnv = new GenericTypeEnv(undefined, typeEnv);
        for (let i = 0; i < genericClassInfo.typeParams.length; i++) {
            substitutionEnv.set(genericClassInfo.typeParams[i], typeArgs[i]);
        }

        const constructorParamTypes = resolveConstructorOverloadByArguments(
            genericClassInfo.genericName,
            genericClassInfo.constructors.map((constructor) => ({
                paramTypes: constructor.params.map((param) => astToTypeValue(param.typeExp, substitutionEnv))
            })),
            args.slice(1),
            varEnv,
            funcEnv,
            typeEnv
        );

        for (let i = 0; i < constructorParamTypes.length; i++) {
            typecheckAgainstExpectedType(args[i + 1], constructorParamTypes[i], varEnv, funcEnv, typeEnv);
        }

        return new GenericClassInstanceTypeValue(genericClassInfo.genericName, typeArgs);
    }
    
    throw new TypeCheckError(`Unknown class: ${formatAst(classNameNode)}`);
}

/**
 * 类型检查 cm_get 表达式
 */
function typecheckGetClassMember(args: AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    if (args.length !== 2) {
        throw new TypeCheckError("cm_get requires exactly 2 arguments: object and member name");
    }
    
    const objectType = typecheck(args[0], varEnv, funcEnv, typeEnv);
    const memberNode = args[1];
    
    if (!(memberNode instanceof IdentifierNode)) {
        throw new TypeCheckError("cm_get member name must be identifier");
    }
    
    const memberName = memberNode.name;
    
    if (objectType instanceof ClassTypeValue) {
        const classInfo = getClassInfo(objectType.className);
        if (classInfo) {
            for (const prop of classInfo.properties) {
                if (prop.bind.var.name === memberName) {
                    ensureReadableMemberVisibility(memberName, objectType, classInfo.isPropertyPublic(memberName));
                    return astToTypeValue(prop.bind.typeExp, typeEnv);
                }
            }

            for (const method of classInfo.methods) {
                if (method.methodName.name === memberName) {
                    ensureReadableMemberVisibility(memberName, objectType, classInfo.isMethodPublic(memberName));
                    const paramTypes = method.params.map((param: TypeVarBindNode) => astToTypeValue(param.typeExp, typeEnv));
                    const returnType = astToTypeValue(method.returnType, typeEnv);
                    return new FunctionTypeValue(paramTypes, returnType);
                }
            }

            throw new TypeCheckError(`Member ${memberName} not found in class ${objectType.className}`);
        }

        const monomorphizedClassInfo = monomorphizedClassTable.get(objectType.className);
        if (monomorphizedClassInfo) {
            const propertyType = monomorphizedClassInfo.propertyTypes.get(memberName);
            if (propertyType) {
                ensureReadableMemberVisibility(memberName, objectType, monomorphizedClassInfo.propertyVisibility.get(memberName) === true);
                return propertyType;
            }

            const methodType = monomorphizedClassInfo.methodTypes.get(memberName);
            if (methodType) {
                ensureReadableMemberVisibility(memberName, objectType, monomorphizedClassInfo.methodVisibility.get(memberName) === true);
                return methodType;
            }

            throw new TypeCheckError(`Member ${memberName} not found in class ${objectType.className}`);
        }

        throw new TypeCheckError(`Unknown class: ${objectType.className}`);
    }
    
    if (objectType instanceof GenericClassInstanceTypeValue) {
        const genericClassInfo = getGenericClassInfo(objectType.genericName, objectType.typeArgs.length);
        if (!genericClassInfo) {
            throw new TypeCheckError(`Unknown generic class: ${objectType.genericName}`);
        }
        
        // 创建类型替换环境
        const substitutionEnv = new GenericTypeEnv(undefined, typeEnv);
        for (let i = 0; i < genericClassInfo.typeParams.length; i++) {
            substitutionEnv.set(genericClassInfo.typeParams[i], objectType.typeArgs[i]);
        }
        
        // 查找属性
        for (const prop of genericClassInfo.properties) {
            if (prop.bind.var.name === memberName) {
                ensureReadableMemberVisibility(memberName, objectType, genericClassInfo.isPropertyPublic(memberName));
                return astToTypeValue(prop.bind.typeExp, substitutionEnv);
            }
        }
        
        // 查找方法
        for (const method of genericClassInfo.methods) {
            if (method.methodName.name === memberName) {
                ensureReadableMemberVisibility(memberName, objectType, genericClassInfo.isMethodPublic(memberName));
                const paramTypes = method.params.map((param: TypeVarBindNode) => astToTypeValue(param.typeExp, substitutionEnv));
                const returnType = astToTypeValue(method.returnType, substitutionEnv);
                return new FunctionTypeValue(paramTypes, returnType);
            }
        }
        
        throw new TypeCheckError(`Member ${memberName} not found in generic class ${objectType.genericName}`);
    }
    
    throw new TypeCheckError(`cm_get requires class instance, got ${formatType(objectType)}`);
}

/**
 * 类型检查 cm_set 表达式
 */
function typecheckSetClassMember(args: AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    if (args.length !== 3) {
        throw new TypeCheckError("cm_set requires exactly 3 arguments: object, member name, and value");
    }
    
    const objectType = typecheck(args[0], varEnv, funcEnv, typeEnv);
    const memberNode = args[1];
    
    if (!(memberNode instanceof IdentifierNode)) {
        throw new TypeCheckError("cm_set member name must be identifier");
    }
    
    const memberName = memberNode.name;
    
    if (objectType instanceof ClassTypeValue) {
        const classInfo = getClassInfo(objectType.className);
        if (classInfo) {
            for (const prop of classInfo.properties) {
                if (prop.bind.var.name === memberName) {
                    ensureWritablePropertyVisibility(memberName, objectType, classInfo.isPropertyPublic(memberName));
                    const expectedType = astToTypeValue(prop.bind.typeExp, typeEnv);
                    typecheckAgainstExpectedType(args[2], expectedType, varEnv, funcEnv, typeEnv);
                    return new PrimitiveTypeValue("unit");
                }
            }

            throw new TypeCheckError(`Property ${memberName} not found in class ${objectType.className}`);
        }

        const monomorphizedClassInfo = monomorphizedClassTable.get(objectType.className);
        if (monomorphizedClassInfo) {
            const expectedType = monomorphizedClassInfo.propertyTypes.get(memberName);
            if (expectedType) {
                ensureWritablePropertyVisibility(memberName, objectType, monomorphizedClassInfo.propertyVisibility.get(memberName) === true);
                typecheckAgainstExpectedType(args[2], expectedType, varEnv, funcEnv, typeEnv);
                return new PrimitiveTypeValue("unit");
            }

            throw new TypeCheckError(`Property ${memberName} not found in class ${objectType.className}`);
        }

        throw new TypeCheckError(`Unknown class: ${objectType.className}`);
    }
    
    if (objectType instanceof GenericClassInstanceTypeValue) {
        const genericClassInfo = getGenericClassInfo(objectType.genericName, objectType.typeArgs.length);
        if (!genericClassInfo) {
            throw new TypeCheckError(`Unknown generic class: ${objectType.genericName}`);
        }
        
        // 创建类型替换环境
        const substitutionEnv = new GenericTypeEnv(undefined, typeEnv);
        for (let i = 0; i < genericClassInfo.typeParams.length; i++) {
            substitutionEnv.set(genericClassInfo.typeParams[i], objectType.typeArgs[i]);
        }
        
        // 查找属性
        for (const prop of genericClassInfo.properties) {
            if (prop.bind.var.name === memberName) {
                ensureWritablePropertyVisibility(memberName, objectType, genericClassInfo.isPropertyPublic(memberName));
                const expectedType = astToTypeValue(prop.bind.typeExp, substitutionEnv);
                typecheckAgainstExpectedType(args[2], expectedType, varEnv, funcEnv, typeEnv);
                return new PrimitiveTypeValue("unit");
            }
        }
        
        throw new TypeCheckError(`Property ${memberName} not found in generic class ${objectType.genericName}`);
    }
    
    throw new TypeCheckError(`cm_set requires class instance, got ${formatType(objectType)}`);
}

function expectBuiltinGenericType(typeAst: AstNode, genericName: string, typeEnv: GenericTypeEnv): GenericClassInstanceTypeValue {
    const typeValue = astToTypeValue(typeAst, typeEnv);
    if (!(typeValue instanceof GenericClassInstanceTypeValue) || typeValue.genericName !== genericName || typeValue.typeArgs.length !== 1) {
        throw new TypeCheckError(`Expected type argument <${genericName} T>`);
    }
    return typeValue;
}

function expectBuiltinValueType(actualType: TypeValue, genericName: string, context: string): GenericClassInstanceTypeValue {
    if (!(actualType instanceof GenericClassInstanceTypeValue) || actualType.genericName !== genericName || actualType.typeArgs.length !== 1) {
        throw new TypeCheckError(`${context} requires value of type <${genericName} T>`);
    }
    return actualType;
}

function resolveGenericClassConstructorParamTypes(type: GenericClassInstanceTypeValue): TypeValue[][] | null {
    const genericClassInfo = getGenericClassInfo(type.genericName, type.typeArgs.length);
    if (genericClassInfo === undefined) {
        return null;
    }

    const substitutionEnv = new GenericTypeEnv();
    for (let index = 0; index < genericClassInfo.typeParams.length; index += 1) {
        substitutionEnv.set(genericClassInfo.typeParams[index], type.typeArgs[index]);
    }

    return genericClassInfo.constructors.map((constructor) => constructor.params.map((param) => astToTypeValue(param.typeExp, substitutionEnv)));
}

function validateArrayElementConstructorConstraint(elementType: TypeValue): void {
    if (elementType instanceof ClassTypeValue) {
        const classInfo = getClassInfo(elementType.className);
        if (classInfo) {
            if (!hasZeroArgConstructorOverload(classInfo.constructors.map((constructor) => ({
                paramTypes: constructor.params.map((param) => astToTypeValue(param.typeExp))
            })))) {
                throw new TypeCheckError(`array_new requires class ${elementType.className} to have a zero-arg constructor when used as an array element type`);
            }
            return;
        }

        const monomorphizedClassInfo = monomorphizedClassTable.get(elementType.className);
        if (monomorphizedClassInfo) {
            if (!hasZeroArgConstructorOverload(monomorphizedClassInfo.constructorParamTypes.map((paramTypes) => ({ paramTypes })))) {
                throw new TypeCheckError(`array_new requires class ${elementType.className} to have a zero-arg constructor when used as an array element type`);
            }
        }
        return;
    }

    if (elementType instanceof GenericClassInstanceTypeValue) {
        const constructorParamTypes = resolveGenericClassConstructorParamTypes(elementType);
        if (constructorParamTypes === null) {
            return;
        }
        if (!hasZeroArgConstructorOverload(constructorParamTypes.map((paramTypes) => ({ paramTypes })))) {
            throw new TypeCheckError(`array_new requires class <${elementType.genericName} ...> to have a zero-arg constructor when used as an array element type`);
        }
    }
}

function typeHasBuiltinZeroArgInitializer(type: TypeValue): boolean {
    if (type instanceof PrimitiveTypeValue) {
        return type.name === "s3"
            || type.name === "s4"
            || type.name === "s5"
            || type.name === "z5"
            || type.name === "z6"
            || type.name === "z7";
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return type.genericName === "array"
            && type.typeArgs.length === 1
            && typeSupportsZeroArgInitialization(type.typeArgs[0]);
    }
    return false;
}

function typeSupportsZeroArgInitialization(type: TypeValue): boolean {
    if (typeHasBuiltinZeroArgInitializer(type)) {
        return true;
    }
    if (type instanceof ClassTypeValue) {
        const classInfo = getClassInfo(type.className);
        if (classInfo !== undefined) {
            return hasZeroArgConstructorOverload(classInfo.constructors.map((constructor) => ({
                paramTypes: constructor.params.map((param) => astToTypeValue(param.typeExp))
            })));
        }
        const monomorphizedClassInfo = monomorphizedClassTable.get(type.className);
        return monomorphizedClassInfo !== undefined
            && hasZeroArgConstructorOverload(monomorphizedClassInfo.constructorParamTypes.map((paramTypes) => ({ paramTypes })));
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        const constructorParamTypes = resolveGenericClassConstructorParamTypes(type);
        return constructorParamTypes !== null
            && hasZeroArgConstructorOverload(constructorParamTypes.map((paramTypes) => ({ paramTypes })));
    }
    return false;
}

function validateZeroArgInitializationSupport(type: TypeValue, context: string): void {
    if (!typeSupportsZeroArgInitialization(type)) {
        throw new TypeCheckError(`${context} requires type ${formatType(type)} to support a zero-arg constructor or builtin default initializer`);
    }
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

function getTextPrimitiveBuiltinFamilySpec(funcName: string): TextPrimitiveBuiltinFamilySpec | undefined {
    for (const family of TEXT_PRIMITIVE_BUILTIN_FAMILIES) {
        if (
            funcName === `${family.stringTypeName}_new`
            || funcName === `${family.stringTypeName}_get`
            || funcName === `${family.stringTypeName}_set`
            || funcName === `${family.stringTypeName}_length`
        ) {
            return family;
        }
    }
    return undefined;
}

function getComplexPrimitiveBuiltinFamilySpec(funcName: string): ComplexPrimitiveBuiltinFamilySpec | undefined {
    for (const family of COMPLEX_PRIMITIVE_BUILTIN_FAMILIES) {
        if (
            funcName === `${family.complexTypeName}_new`
            || funcName === `${family.complexTypeName}_set`
            || funcName === `${family.complexTypeName}_real`
            || funcName === `${family.complexTypeName}_img`
        ) {
            return family;
        }
    }
    return undefined;
}

function typecheckTextPrimitiveBuiltinCall(funcName: string, args: readonly AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    const family = getTextPrimitiveBuiltinFamilySpec(funcName);
    if (!family) {
        throw new TypeCheckError(`Unknown text primitive builtin: ${funcName}`);
    }
    const stringType = new PrimitiveTypeValue(family.stringTypeName);
    const charType = new PrimitiveTypeValue(family.charTypeName);

    if (funcName === `${family.stringTypeName}_new`) {
        if (args.length === 0) {
            return stringType;
        }
        if (args.length === 1) {
            typecheckAgainstExpectedType(args[0], stringType, varEnv, funcEnv, typeEnv);
            return stringType;
        }
        if (args.length === 2) {
            typecheckAgainstExpectedType(args[0], new PrimitiveTypeValue("i5"), varEnv, funcEnv, typeEnv);
            typecheckAgainstExpectedType(args[1], charType, varEnv, funcEnv, typeEnv);
            return stringType;
        }
        throw new TypeCheckError(`${funcName} requires 0 arguments (), 1 argument (${family.stringTypeName}), or 2 arguments (i5, ${family.charTypeName})`);
    }

    if (funcName === `${family.stringTypeName}_get`) {
        if (args.length !== 2) {
            throw new TypeCheckError(`${funcName} requires exactly 2 arguments: ${family.stringTypeName} and i5 index`);
        }
        typecheckAgainstExpectedType(args[0], stringType, varEnv, funcEnv, typeEnv);
        typecheckAgainstExpectedType(args[1], new PrimitiveTypeValue("i5"), varEnv, funcEnv, typeEnv);
        return charType;
    }

    if (funcName === `${family.stringTypeName}_set`) {
        if (args.length !== 3) {
            throw new TypeCheckError(`${funcName} requires exactly 3 arguments: ${family.stringTypeName}, i5 index, and ${family.charTypeName}`);
        }
        typecheckAgainstExpectedType(args[0], stringType, varEnv, funcEnv, typeEnv);
        typecheckAgainstExpectedType(args[1], new PrimitiveTypeValue("i5"), varEnv, funcEnv, typeEnv);
        typecheckAgainstExpectedType(args[2], charType, varEnv, funcEnv, typeEnv);
        return new PrimitiveTypeValue("unit");
    }

    if (funcName === `${family.stringTypeName}_length`) {
        if (args.length !== 1) {
            throw new TypeCheckError(`${funcName} requires exactly 1 argument: ${family.stringTypeName}`);
        }
        typecheckAgainstExpectedType(args[0], stringType, varEnv, funcEnv, typeEnv);
        return new PrimitiveTypeValue("i5");
    }

    throw new TypeCheckError(`Unknown text primitive builtin: ${funcName}`);
}

function typecheckComplexPrimitiveBuiltinCall(funcName: string, args: readonly AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    const family = getComplexPrimitiveBuiltinFamilySpec(funcName);
    if (!family) {
        throw new TypeCheckError(`Unknown complex primitive builtin: ${funcName}`);
    }
    const complexType = new PrimitiveTypeValue(family.complexTypeName);
    const componentType = new PrimitiveTypeValue(family.componentTypeName);

    if (funcName === `${family.complexTypeName}_new`) {
        if (args.length === 0) {
            return complexType;
        }
        if (args.length === 1) {
            typecheckAgainstExpectedType(args[0], complexType, varEnv, funcEnv, typeEnv);
            return complexType;
        }
        throw new TypeCheckError(`${funcName} requires either 0 arguments () or 1 argument (${family.complexTypeName})`);
    }

    if (funcName === `${family.complexTypeName}_set`) {
        if (args.length === 2) {
            typecheckAgainstExpectedType(args[0], complexType, varEnv, funcEnv, typeEnv);
            typecheckAgainstExpectedType(args[1], complexType, varEnv, funcEnv, typeEnv);
            return new PrimitiveTypeValue("unit");
        }
        if (args.length === 3) {
            typecheckAgainstExpectedType(args[0], complexType, varEnv, funcEnv, typeEnv);
            typecheckAgainstExpectedType(args[1], componentType, varEnv, funcEnv, typeEnv);
            typecheckAgainstExpectedType(args[2], componentType, varEnv, funcEnv, typeEnv);
            return new PrimitiveTypeValue("unit");
        }
        throw new TypeCheckError(`${funcName} requires either 2 arguments (${family.complexTypeName}, ${family.complexTypeName}) or 3 arguments (${family.complexTypeName}, ${family.componentTypeName}, ${family.componentTypeName})`);
    }

    if (funcName === `${family.complexTypeName}_real` || funcName === `${family.complexTypeName}_img`) {
        if (args.length !== 1) {
            throw new TypeCheckError(`${funcName} requires exactly 1 argument: ${family.complexTypeName}`);
        }
        typecheckAgainstExpectedType(args[0], complexType, varEnv, funcEnv, typeEnv);
        return componentType;
    }

    throw new TypeCheckError(`Unknown complex primitive builtin: ${funcName}`);
}

function typecheckArrayNew(args: AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    if (args.length === 1) {
        const arrayType = expectBuiltinGenericType(args[0], "array", typeEnv);
        validateZeroArgInitializationSupport(arrayType.typeArgs[0], "array_new with zero runtime arguments");
        return arrayType;
    }
    if (args.length === 3) {
        const arrayType = expectBuiltinGenericType(args[0], "array", typeEnv);
        validateArrayElementConstructorConstraint(arrayType.typeArgs[0]);
        typecheckAgainstExpectedType(args[1], new PrimitiveTypeValue("i5"), varEnv, funcEnv, typeEnv);
        typecheckAgainstExpectedType(args[2], arrayType.typeArgs[0], varEnv, funcEnv, typeEnv);
        return arrayType;
    }
    throw new TypeCheckError("array_new requires either 1 argument (array type) or 3 arguments (array type, length, and initial value)");
}

function typecheckArrayGet(args: AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    if (args.length !== 2) {
        throw new TypeCheckError("array_get requires exactly 2 arguments: array and index");
    }
    const arrayType = expectBuiltinValueType(typecheck(args[0], varEnv, funcEnv, typeEnv), "array", "array_get");
    typecheckAgainstExpectedType(args[1], new PrimitiveTypeValue("i5"), varEnv, funcEnv, typeEnv);
    return arrayType.typeArgs[0];
}

function typecheckArraySet(args: AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    if (args.length !== 3) {
        throw new TypeCheckError("array_set requires exactly 3 arguments: array, index, and value");
    }
    const arrayType = expectBuiltinValueType(typecheck(args[0], varEnv, funcEnv, typeEnv), "array", "array_set");
    typecheckAgainstExpectedType(args[1], new PrimitiveTypeValue("i5"), varEnv, funcEnv, typeEnv);
    typecheckAgainstExpectedType(args[2], arrayType.typeArgs[0], varEnv, funcEnv, typeEnv);
    return new PrimitiveTypeValue("unit");
}

function typecheckArrayLength(args: AstNode[], varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): TypeValue {
    if (args.length !== 1) {
        throw new TypeCheckError("array_length requires exactly 1 argument");
    }
    expectBuiltinValueType(typecheck(args[0], varEnv, funcEnv, typeEnv), "array", "array_length");
    return new PrimitiveTypeValue("i5");
}

function intersectSets(sets: Set<string>[]): Set<string> {
    if (sets.length === 0) {
        return new Set<string>();
    }
    const result = new Set<string>(sets[0]);
    for (let i = 1; i < sets.length; i++) {
        for (const value of Array.from(result)) {
            if (!sets[i].has(value)) {
                result.delete(value);
            }
        }
    }
    return result;
}

interface MethodDirectConstructorEffects {
    readonly directFieldReads: Set<string>;
    readonly directSelfEscape: boolean;
    readonly directInternalMethodCalls: Set<string>;
}

interface MethodConstructorEffects {
    readonly fieldReads: Set<string>;
    escapesSelf: boolean;
}

interface ConstructorClassAnalysis {
    readonly propertyNameSet: ReadonlySet<string>;
    readonly methodNameSet: ReadonlySet<string>;
    readonly methodEffects: ReadonlyMap<string, MethodConstructorEffects>;
}

const METHOD_CONSTRUCTOR_EFFECT_FIXPOINT_BASE_LIMIT = 256;

function getSelfPropertyReadName(ast: AstNode, propertyNameSet: ReadonlySet<string>): string | null {
    if (!(ast instanceof FunctionCallNode)) {
        return null;
    }
    if (!(ast.callee instanceof IdentifierNode) || ast.callee.name !== "cm_get" || ast.args.length !== 2) {
        return null;
    }
    if (!(ast.args[0] instanceof IdentifierNode) || ast.args[0].name !== "self") {
        return null;
    }
    if (!(ast.args[1] instanceof IdentifierNode) || !propertyNameSet.has(ast.args[1].name)) {
        return null;
    }
    return ast.args[1].name;
}

function getSelfPropertyWriteName(ast: AstNode, propertyNameSet: ReadonlySet<string>): string | null {
    if (!(ast instanceof FunctionCallNode)) {
        return null;
    }
    if (!(ast.callee instanceof IdentifierNode) || ast.callee.name !== "cm_set" || ast.args.length !== 3) {
        return null;
    }
    if (!(ast.args[0] instanceof IdentifierNode) || ast.args[0].name !== "self") {
        return null;
    }
    if (!(ast.args[1] instanceof IdentifierNode) || !propertyNameSet.has(ast.args[1].name)) {
        return null;
    }
    return ast.args[1].name;
}

function getSelfMethodAccessName(ast: AstNode, methodNameSet: ReadonlySet<string>): string | null {
    if (!(ast instanceof FunctionCallNode)) {
        return null;
    }
    if (!(ast.callee instanceof IdentifierNode) || ast.callee.name !== "cm_get" || ast.args.length !== 2) {
        return null;
    }
    if (!(ast.args[0] instanceof IdentifierNode) || ast.args[0].name !== "self") {
        return null;
    }
    if (!(ast.args[1] instanceof IdentifierNode) || !methodNameSet.has(ast.args[1].name)) {
        return null;
    }
    return ast.args[1].name;
}

function getSelfMethodCallName(ast: AstNode, methodNameSet: ReadonlySet<string>): string | null {
    if (!(ast instanceof FunctionCallNode)) {
        return null;
    }
    return getSelfMethodAccessName(ast.callee, methodNameSet);
}

function formatNameList(names: readonly string[]): string {
    if (names.length === 1) {
        return names[0];
    }
    return names.join(", ");
}

function isNestedDefinitionNode(ast: AstNode): boolean {
    return ast instanceof DfunNode
        || ast instanceof DeclaredDfunNode
        || ast instanceof GenericDfunNode
        || ast instanceof ClassNode
        || ast instanceof GenericClassNode
        || ast instanceof ClassMethodNode
        || ast instanceof ClassConstructorNode;
}

function containsSelfReference(ast: AstNode): boolean {
    if (ast instanceof IdentifierNode) {
        return ast.name === "self";
    }
    if (ast instanceof FnNode) {
        return containsSelfReference(ast.body);
    }
    if (isNestedDefinitionNode(ast)) {
        return false;
    }
    if (ast instanceof SeqNode) {
        return ast.expressions.some((expr) => containsSelfReference(expr));
    }
    if (ast instanceof IfNode) {
        return containsSelfReference(ast.condExpr)
            || containsSelfReference(ast.trueBranchExpr)
            || containsSelfReference(ast.falseBranchExpr);
    }
    if (ast instanceof WhileNode) {
        return containsSelfReference(ast.condExpr) || containsSelfReference(ast.bodyExpr);
    }
    if (ast instanceof CondNode) {
        return ast.clausesExprs.some((clause) => containsSelfReference(clause.cond) || containsSelfReference(clause.body));
    }
    if (ast instanceof MatchNode) {
        return containsSelfReference(ast.unionExpr)
            || ast.branches.some((branch) => containsSelfReference(branch.body));
    }
    if (ast instanceof DvarNode) {
        return containsSelfReference(ast.value);
    }
    if (ast instanceof SetNode) {
        return containsSelfReference(ast.value);
    }
    if (ast instanceof LetNode) {
        return ast.bindings.some((binding) => containsSelfReference(binding.value))
            || containsSelfReference(ast.body);
    }
    if (ast instanceof FunctionCallNode) {
        return containsSelfReference(ast.callee)
            || ast.args.some((arg) => containsSelfReference(arg));
    }
    if (ast instanceof GenericCallNode) {
        return containsSelfReference(ast.callee);
    }
    return false;
}

function collectMethodConstructorEffects(
    ast: AstNode,
    propertyNameSet: ReadonlySet<string>,
    methodNameSet: ReadonlySet<string>,
    effects: { directFieldReads: Set<string>; directSelfEscape: boolean; directInternalMethodCalls: Set<string> },
): void {
    if (ast instanceof IdentifierNode) {
        if (ast.name === "self") {
            effects.directSelfEscape = true;
        }
        return;
    }

    if (ast instanceof FnNode) {
        if (containsSelfReference(ast.body)) {
            effects.directSelfEscape = true;
        }
        return;
    }

    if (isNestedDefinitionNode(ast)) {
        return;
    }

    if (ast instanceof SeqNode) {
        ast.expressions.forEach((expr) => collectMethodConstructorEffects(expr, propertyNameSet, methodNameSet, effects));
        return;
    }

    if (ast instanceof IfNode) {
        collectMethodConstructorEffects(ast.condExpr, propertyNameSet, methodNameSet, effects);
        collectMethodConstructorEffects(ast.trueBranchExpr, propertyNameSet, methodNameSet, effects);
        collectMethodConstructorEffects(ast.falseBranchExpr, propertyNameSet, methodNameSet, effects);
        return;
    }

    if (ast instanceof WhileNode) {
        collectMethodConstructorEffects(ast.condExpr, propertyNameSet, methodNameSet, effects);
        collectMethodConstructorEffects(ast.bodyExpr, propertyNameSet, methodNameSet, effects);
        return;
    }

    if (ast instanceof CondNode) {
        for (const clause of ast.clausesExprs) {
            collectMethodConstructorEffects(clause.cond, propertyNameSet, methodNameSet, effects);
            collectMethodConstructorEffects(clause.body, propertyNameSet, methodNameSet, effects);
        }
        return;
    }

    if (ast instanceof MatchNode) {
        collectMethodConstructorEffects(ast.unionExpr, propertyNameSet, methodNameSet, effects);
        for (const branch of ast.branches) {
            collectMethodConstructorEffects(branch.body, propertyNameSet, methodNameSet, effects);
        }
        return;
    }

    if (ast instanceof DvarNode) {
        collectMethodConstructorEffects(ast.value, propertyNameSet, methodNameSet, effects);
        return;
    }

    if (ast instanceof SetNode) {
        collectMethodConstructorEffects(ast.value, propertyNameSet, methodNameSet, effects);
        return;
    }

    if (ast instanceof LetNode) {
        for (const binding of ast.bindings) {
            collectMethodConstructorEffects(binding.value, propertyNameSet, methodNameSet, effects);
        }
        collectMethodConstructorEffects(ast.body, propertyNameSet, methodNameSet, effects);
        return;
    }

    if (ast instanceof FunctionCallNode) {
        const writeName = getSelfPropertyWriteName(ast, propertyNameSet);
        if (writeName !== null) {
            collectMethodConstructorEffects(ast.args[2], propertyNameSet, methodNameSet, effects);
            return;
        }

        const readName = getSelfPropertyReadName(ast, propertyNameSet);
        if (readName !== null) {
            effects.directFieldReads.add(readName);
            return;
        }

        const methodCallName = getSelfMethodCallName(ast, methodNameSet);
        if (methodCallName !== null) {
            effects.directInternalMethodCalls.add(methodCallName);
            ast.args.forEach((arg) => collectMethodConstructorEffects(arg, propertyNameSet, methodNameSet, effects));
            return;
        }

        const methodAccessName = getSelfMethodAccessName(ast, methodNameSet);
        if (methodAccessName !== null) {
            effects.directSelfEscape = true;
            return;
        }

        collectMethodConstructorEffects(ast.callee, propertyNameSet, methodNameSet, effects);
        ast.args.forEach((arg) => collectMethodConstructorEffects(arg, propertyNameSet, methodNameSet, effects));
        return;
    }

    if (ast instanceof GenericCallNode) {
        collectMethodConstructorEffects(ast.callee, propertyNameSet, methodNameSet, effects);
    }
}

function buildConstructorClassAnalysis(
    propertyNames: readonly string[],
    methods: readonly ClassMethodNode[],
    context: string,
): ConstructorClassAnalysis {
    const propertyNameSet = new Set<string>(propertyNames);
    const methodNameSet = new Set<string>(methods.map((method) => method.methodName.name));
    const directEffects = new Map<string, MethodDirectConstructorEffects>();
    const methodEffects = new Map<string, MethodConstructorEffects>();

    for (const method of methods) {
        const mutableDirectEffects = {
            directFieldReads: new Set<string>(),
            directSelfEscape: false,
            directInternalMethodCalls: new Set<string>(),
        };
        collectMethodConstructorEffects(method.body, propertyNameSet, methodNameSet, mutableDirectEffects);
        directEffects.set(method.methodName.name, mutableDirectEffects);
        methodEffects.set(method.methodName.name, {
            fieldReads: new Set<string>(mutableDirectEffects.directFieldReads),
            escapesSelf: mutableDirectEffects.directSelfEscape,
        });
    }

    const maxIterations = Math.max(
        METHOD_CONSTRUCTOR_EFFECT_FIXPOINT_BASE_LIMIT,
        methods.length * Math.max(1, propertyNames.length + methods.length + 1),
    );
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        let changed = false;
        for (const [methodName, direct] of directEffects.entries()) {
            const aggregate = methodEffects.get(methodName);
            if (aggregate === undefined) {
                continue;
            }
            for (const calleeName of direct.directInternalMethodCalls) {
                const calleeEffects = methodEffects.get(calleeName);
                if (calleeEffects === undefined) {
                    continue;
                }
                const previousReadCount = aggregate.fieldReads.size;
                for (const fieldName of calleeEffects.fieldReads) {
                    aggregate.fieldReads.add(fieldName);
                }
                if (aggregate.fieldReads.size !== previousReadCount) {
                    changed = true;
                }
                if (calleeEffects.escapesSelf && !aggregate.escapesSelf) {
                    aggregate.escapesSelf = true;
                    changed = true;
                }
            }
        }
        if (!changed) {
            return { propertyNameSet, methodNameSet, methodEffects };
        }
    }

    throw new TypeCheckError(`${context}: constructor method effect analysis did not converge after ${maxIterations} iterations`);
}

function analyzeConstructorExpression(
    ast: AstNode,
    analysis: ConstructorClassAnalysis,
    initializedProperties: Set<string>,
    context: string,
): Set<string> {
    if (ast instanceof IdentifierNode) {
        if (ast.name === "self") {
            throw new TypeCheckError(`${context}: constructor cannot let self escape before initialization is complete`);
        }
        return new Set<string>(initializedProperties);
    }

    if (ast instanceof FnNode) {
        if (containsSelfReference(ast.body)) {
            throw new TypeCheckError(`${context}: constructor cannot capture self in a function before initialization is complete`);
        }
        return new Set<string>(initializedProperties);
    }

    if (isNestedDefinitionNode(ast)) {
        return new Set<string>(initializedProperties);
    }

    const readName = getSelfPropertyReadName(ast, analysis.propertyNameSet);
    if (readName !== null && !initializedProperties.has(readName)) {
        throw new TypeCheckError(`${context}: reads property ${readName} before it is initialized`);
    }

    const methodAccess = getSelfMethodAccessName(ast, analysis.methodNameSet);
    if (methodAccess !== null) {
        throw new TypeCheckError(`${context}: constructor cannot let self escape through method ${methodAccess} before initialization is complete`);
    }

    if (ast instanceof SeqNode) {
        let current = new Set<string>(initializedProperties);
        for (const expr of ast.expressions) {
            current = analyzeConstructorExpression(expr, analysis, current, context);
        }
        return current;
    }

    if (ast instanceof IfNode) {
        const afterCond = analyzeConstructorExpression(ast.condExpr, analysis, initializedProperties, context);
        return intersectSets([
            analyzeConstructorExpression(ast.trueBranchExpr, analysis, new Set<string>(afterCond), context),
            analyzeConstructorExpression(ast.falseBranchExpr, analysis, new Set<string>(afterCond), context),
        ]);
    }

    if (ast instanceof WhileNode) {
        const afterCond = analyzeConstructorExpression(ast.condExpr, analysis, initializedProperties, context);
        analyzeConstructorExpression(ast.bodyExpr, analysis, new Set<string>(afterCond), context);
        return afterCond;
    }

    if (ast instanceof CondNode) {
        const branchResults: Set<string>[] = [];
        let hasElseClause = false;
        for (const clause of ast.clausesExprs) {
            const isElseClause = clause.cond instanceof IdentifierNode && clause.cond.name === "else";
            if (isElseClause) {
                hasElseClause = true;
                branchResults.push(analyzeConstructorExpression(clause.body, analysis, new Set<string>(initializedProperties), context));
                continue;
            }
            const afterCond = analyzeConstructorExpression(clause.cond, analysis, initializedProperties, context);
            branchResults.push(analyzeConstructorExpression(clause.body, analysis, new Set<string>(afterCond), context));
        }
        if (!hasElseClause) {
            branchResults.push(new Set<string>(initializedProperties));
        }
        return intersectSets(branchResults);
    }

    if (ast instanceof MatchNode) {
        const afterUnion = analyzeConstructorExpression(ast.unionExpr, analysis, initializedProperties, context);
        return intersectSets(ast.branches.map((branch) =>
            analyzeConstructorExpression(branch.body, analysis, new Set<string>(afterUnion), context)
        ));
    }

    if (ast instanceof DvarNode) {
        return analyzeConstructorExpression(ast.value, analysis, initializedProperties, context);
    }

    if (ast instanceof SetNode) {
        return analyzeConstructorExpression(ast.value, analysis, initializedProperties, context);
    }

    if (ast instanceof LetNode) {
        let current = new Set<string>(initializedProperties);
        for (const binding of ast.bindings) {
            current = analyzeConstructorExpression(binding.value, analysis, current, context);
        }
        return analyzeConstructorExpression(ast.body, analysis, current, context);
    }

    if (ast instanceof FunctionCallNode) {
        const writeName = getSelfPropertyWriteName(ast, analysis.propertyNameSet);
        if (writeName !== null) {
            const current = analyzeConstructorExpression(ast.args[2], analysis, initializedProperties, context);
            current.add(writeName);
            return current;
        }

        const propertyReadName = getSelfPropertyReadName(ast, analysis.propertyNameSet);
        if (propertyReadName !== null) {
            if (!initializedProperties.has(propertyReadName)) {
                throw new TypeCheckError(`${context}: reads property ${propertyReadName} before it is initialized`);
            }
            return new Set<string>(initializedProperties);
        }

        const methodCallName = getSelfMethodCallName(ast, analysis.methodNameSet);
        if (methodCallName !== null) {
            let current = new Set<string>(initializedProperties);
            for (const arg of ast.args) {
                current = analyzeConstructorExpression(arg, analysis, current, context);
            }
            const methodEffects = analysis.methodEffects.get(methodCallName);
            if (methodEffects !== undefined) {
                const missing = Array.from(methodEffects.fieldReads).filter((propertyName) => !current.has(propertyName));
                if (missing.length > 0) {
                    throw new TypeCheckError(`${context}: method ${methodCallName} may read properties ${formatNameList(missing)} before they are initialized`);
                }
                if (methodEffects.escapesSelf) {
                    throw new TypeCheckError(`${context}: method ${methodCallName} may let self escape before initialization is complete`);
                }
            }
            return current;
        }

        let current = analyzeConstructorExpression(ast.callee, analysis, initializedProperties, context);
        for (const arg of ast.args) {
            current = analyzeConstructorExpression(arg, analysis, current, context);
        }
        return current;
    }

    if (ast instanceof GenericCallNode) {
        return analyzeConstructorExpression(ast.callee, analysis, initializedProperties, context);
    }

    return new Set<string>(initializedProperties);
}

function ensureConstructorInitializesProperties(propertyNames: string[], methods: readonly ClassMethodNode[], body: AstNode, context: string): void {
    const analysis = buildConstructorClassAnalysis(propertyNames, methods, context);
    const initialized = analyzeConstructorExpression(body, analysis, new Set<string>(), context);
    const missing = propertyNames.filter((propertyName) => !initialized.has(propertyName));
    if (missing.length > 0) {
        throw new TypeCheckError(`${context}: constructor must initialize properties ${missing.join(', ')}`);
    }
}

function typecheckClassDefinition(node: ClassNode, varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): void {
    const resolvedClassInfo = resolveVisibleClassInfoWithCurrentPackageFallback(node.name, node.name.name);
    const nodeMetadata = getCompilationUnitMetadata(node);
    const selfClassName = resolvedClassInfo?.name
        ?? (nodeMetadata !== undefined && !node.name.name.includes("@") ? `${nodeMetadata.packageName}@${node.name.name}` : node.name.name);
    const selfType = new ClassTypeValue(selfClassName);

    for (const method of node.methodNodeList) {
        const methodVarEnv = varEnv.extend();
        methodVarEnv.setImmutable("self", selfType);
        for (const param of method.params) {
            methodVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, typeEnv));
        }
        const returnType = astToTypeValue(method.returnType, typeEnv);
        withMemberVisibilityAccessContext(selfType, () => {
            typecheckAgainstExpectedType(method.body, returnType, methodVarEnv, funcEnv, typeEnv);
        });
    }

    for (const ctor of node.constructorNodeList) {
        const ctorVarEnv = varEnv.extend();
        ctorVarEnv.setImmutable("self", selfType);
        for (const param of ctor.params) {
            ctorVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, typeEnv));
        }
        withMemberVisibilityAccessContext(selfType, () => {
            typecheck(ctor.body, ctorVarEnv, funcEnv, typeEnv);
        });
        ensureConstructorInitializesProperties(node.propertyNodeList.map((property) => property.bind.var.name), node.methodNodeList, ctor.body, `class ${node.name.name}`);
    }
}

function typecheckGenericClassDefinition(node: GenericClassNode, varEnv: VarEnv, funcEnv: FunctionEnv, typeEnv: GenericTypeEnv): void {
    const genericTypeEnv = new GenericTypeEnv(undefined, typeEnv);
    const selfTypeArgs: TypeValue[] = [];
    for (const typeParam of node.genericName.genericTypeArgs) {
        const typeValue = new TypeParameterValue(typeParam.name);
        genericTypeEnv.set(typeParam.name, typeValue);
        selfTypeArgs.push(typeValue);
    }
    const resolvedGenericClassInfo = resolveVisibleGenericClassInfoWithCurrentPackageFallback(node.genericName.name, node.genericName.name.name, node.genericName.genericTypeArgs.length);
    const nodeMetadata = getCompilationUnitMetadata(node);
    const selfGenericName = resolvedGenericClassInfo?.genericName
        ?? (nodeMetadata !== undefined && !node.genericName.name.name.includes("@") ? `${nodeMetadata.packageName}@${node.genericName.name.name}` : node.genericName.name.name);
    const selfType = new GenericClassInstanceTypeValue(selfGenericName, selfTypeArgs);

    for (const method of node.methodNodeList) {
        const methodVarEnv = varEnv.extend();
        methodVarEnv.setImmutable("self", selfType);
        for (const param of method.params) {
            methodVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, genericTypeEnv));
        }
        const returnType = astToTypeValue(method.returnType, genericTypeEnv);
        withMemberVisibilityAccessContext(selfType, () => {
            typecheckAgainstExpectedType(method.body, returnType, methodVarEnv, funcEnv, genericTypeEnv);
        });
    }

    for (const ctor of node.constructorNodeList) {
        const ctorVarEnv = varEnv.extend();
        ctorVarEnv.setImmutable("self", selfType);
        for (const param of ctor.params) {
            ctorVarEnv.setImmutable(param.var.name, requireTypeAnnotation(param, genericTypeEnv));
        }
        withMemberVisibilityAccessContext(selfType, () => {
            typecheck(ctor.body, ctorVarEnv, funcEnv, genericTypeEnv);
        });
        ensureConstructorInitializesProperties(node.propertyNodeList.map((property) => property.bind.var.name), node.methodNodeList, ctor.body, `generic class ${node.genericName.name.name}`);
    }
}

/**
 * 格式化类型为字符串
 */
function formatType(type: TypeValue): string {
    if (type instanceof PrimitiveTypeValue) {
        return type.name;
    }
    if (type instanceof ClassTypeValue) {
        return type.className;
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        const typeArgsStr = type.typeArgs.map(formatType).join(', ');
        return `${type.genericName}<${typeArgsStr}>`;
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        const typeArgsStr = type.typeArgs.map(formatType).join(', ');
        return `${type.genericName}<${typeArgsStr}>`;
    }
    if (type instanceof FunctionTypeValue) {
        const paramTypesStr = type.paramTypes.map(formatType).join(', ');
        return `(${paramTypesStr}) -> ${formatType(type.returnType)}`;
    }
    if (type instanceof UnionTypeValue) {
        const typesStr = type.types.map(formatType).join(' | ');
        return `union(${typesStr})`;
    }
    return 'unknown';
}

function validateTopLevelGlobalDefinition(name: string, declaredType: TypeValue, initializer: AstNode): void {
    if (!isAllowedTopLevelGlobalType(declaredType)) {
        throw new TypeCheckError(
            `top-level global '${name}' must have a primitive type or a union containing at least one primitive member, got ${formatType(declaredType)}`
        );
    }

    try {
        evaluateStaticPrimitiveInitializer(initializer);
    } catch (error) {
        if (error instanceof StaticPrimitiveEvalError) {
            throw new TypeCheckError(
                `top-level global '${name}' initializer must be a statically computable primitive payload: ${error.message}`
            );
        }
        throw error;
    }
}

/**
 * 格式化 AST 节点为字符串（用于错误信息）
 */
function formatAst(ast: AstNode): string {
    if (ast instanceof IdentifierNode) {
        return ast.name;
    }
    if (ast instanceof TextDatabaseReferenceNode) {
        return ast.referenceName;
    }
    if (ast instanceof NumberLiteralNode) {
        return ast.raw;
    }
    return `<${ast.kind}>`;
}

function isDefinitionNode(ast: AstNode): boolean {
    return ast instanceof ClassNode
        || ast instanceof GenericClassNode
        || ast instanceof DfunNode
        || ast instanceof DeclaredDfunNode
        || ast instanceof GenericDfunNode;
}

function isAllowedModuleTopLevelNode(ast: AstNode): boolean {
    return isDefinitionNode(ast)
        || ast instanceof ImportNode
        || ast instanceof DvarNode;
}

function canWriteVisibleGlobal(referenceNode: AstNode, globalInfo: { readonly packageName: string | null }): boolean {
    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return globalInfo.packageName === null;
    }
    return true;
}

function resolveVisibleGenericClassInfoWithCurrentPackageFallback(referenceNode: AstNode, name: string, arity: number): ReturnType<typeof getVisibleGenericClassInfo> {
    const visibleInfo = getVisibleGenericClassInfo(referenceNode, name, arity);
    if (visibleInfo !== undefined) {
        return visibleInfo;
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return getGenericClassInfo(name, arity);
    }

    if (name.includes("@")) {
        return getGenericClassInfo(name, arity);
    }

    return getGenericClassInfo(`${metadata.packageName}@${name}`, arity);
}

function resolveVisibleClassInfoWithCurrentPackageFallback(referenceNode: AstNode, name: string): ReturnType<typeof getVisibleClassInfo> {
    const visibleInfo = getVisibleClassInfo(referenceNode, name);
    if (visibleInfo !== undefined) {
        return visibleInfo;
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return getClassInfo(name);
    }

    if (name.includes("@")) {
        return getClassInfo(name);
    }

    return getClassInfo(`${metadata.packageName}@${name}`);
}

function isMainArgsType(type: TypeValue): boolean {
    return type instanceof GenericClassInstanceTypeValue
        && type.genericName === "array"
        && type.typeArgs.length === 1
        && typeEqual(type.typeArgs[0], new PrimitiveTypeValue("s3"));
}

function validateMainSignature(ast: AstNode, unitId: string): void {
    withActiveTypecheckNode(ast, (): void => {
        const node = unwrapExportNode(ast);

        if (node instanceof DeclaredDfunNode && node.name.name === "main") {
            throw new TypeCheckError(`unit ${unitId}: main must be a non-declare top-level function`);
        }

        if (node instanceof GenericDfunNode && node.genericName.name.name === "main") {
            throw new TypeCheckError(`unit ${unitId}: main must be a non-generic top-level function`);
        }

        if (!(node instanceof DfunNode) || node.name.name !== "main") {
            return;
        }

        if (node.params.length !== 1) {
            throw new TypeCheckError(`unit ${unitId}: main must take exactly one parameter`);
        }

        const [mainParam] = node.params;
        if (mainParam.var.name !== "args") {
            throw new TypeCheckError(`unit ${unitId}: main parameter must be named args`);
        }

        const mainParamType = astToTypeValue(mainParam.typeExp, new GenericTypeEnv());
        if (!isMainArgsType(mainParamType)) {
            throw new TypeCheckError(`unit ${unitId}: main parameter must have type <array s3>`);
        }

        const mainReturnType = astToTypeValue(node.returnType, new GenericTypeEnv());
        if (!typeEqual(mainReturnType, new PrimitiveTypeValue("i5"))) {
            throw new TypeCheckError(`unit ${unitId}: main must return i5`);
        }
    });
}

function validateTopLevelExportNode(node: ExportNode): void {
    if (node.inner instanceof ExportNode) {
        throw new TypeCheckError("export declarations must appear at top level");
    }
    if (!isExportableTopLevelAstNode(node.inner)) {
        throw new TypeCheckError("export may only wrap top-level definitions and top-level var");
    }
}

function validateModuleTopLevelStructure(program: ProgramNode): void {
    const mainCountByUnit = new Map<string, number>();

    for (const expr of program.topLevelExpressions) {
        withActiveTypecheckNode(expr, (): void => {
            const metadata = getCompilationUnitMetadata(expr);
            if (metadata === undefined) {
                return;
            }

            const topLevelNode = unwrapExportNode(expr);

            if (expr instanceof PublicNode || topLevelNode instanceof PublicNode) {
                throw new TypeCheckError("public declarations must appear inside class bodies");
            }

            if (expr instanceof ExportNode) {
                validateTopLevelExportNode(expr);
            } else if (!isAllowedModuleTopLevelNode(expr)) {
                throw new TypeCheckError(`unit ${metadata.unitId}: module mode only allows import, top-level definitions, and top-level var`);
            }

            validateMainSignature(topLevelNode, metadata.unitId);

            if (topLevelNode instanceof DfunNode && topLevelNode.name.name === "main") {
                mainCountByUnit.set(metadata.unitId, (mainCountByUnit.get(metadata.unitId) ?? 0) + 1);
            }
        });
    }

    for (const [unitId, count] of mainCountByUnit.entries()) {
        if (count > 1) {
            throw new TypeCheckError(`unit ${unitId}: multiple top-level main functions are not allowed`);
        }
    }
}

function validateNestedDefinitions(ast: AstNode): void {
    withActiveTypecheckNode(ast, (): void => {
        if (isDefinitionNode(ast)) {
            return;
        }
        if (ast instanceof PublicNode) {
            throw new TypeCheckError("public declarations must appear inside class bodies");
        }
        if (ast instanceof ExportNode) {
            throw new TypeCheckError("export declarations must appear at top level");
        }
        if (ast instanceof ImportNode) {
            throw new TypeCheckError("import declarations must appear at top level");
        }
        if (ast instanceof ProgramNode) {
            throw new TypeCheckError("program blocks may only appear at the root");
        }
        if (ast instanceof SeqNode) {
            ast.expressions.forEach((expr) => {
                if (isDefinitionNode(expr)) {
                    throw new TypeCheckError("class, function, and generic definitions must appear at top level");
                }
                validateNestedDefinitions(expr);
            });
            return;
        }
        if (ast instanceof LetNode) {
            ast.bindings.forEach((binding) => {
                validateNestedDefinitions(binding.bind);
                validateNestedDefinitions(binding.value);
            });
            validateNestedDefinitions(ast.body);
            return;
        }
        if (ast instanceof FnNode) {
            ast.params.forEach(validateNestedDefinitions);
            validateNestedDefinitions(ast.returnType);
            validateNestedDefinitions(ast.body);
            return;
        }
        if (ast instanceof IfNode) {
            validateNestedDefinitions(ast.condExpr);
            validateNestedDefinitions(ast.trueBranchExpr);
            validateNestedDefinitions(ast.falseBranchExpr);
            return;
        }
        if (ast instanceof WhileNode) {
            validateNestedDefinitions(ast.condExpr);
            validateNestedDefinitions(ast.bodyExpr);
            return;
        }
        if (ast instanceof CondNode) {
            ast.clausesExprs.forEach((clause) => {
                validateNestedDefinitions(clause.cond);
                validateNestedDefinitions(clause.body);
            });
            return;
        }
        if (ast instanceof DvarNode) {
            validateNestedDefinitions(ast.bind);
            validateNestedDefinitions(ast.value);
            return;
        }
        if (ast instanceof SetNode) {
            validateNestedDefinitions(ast.identifier);
            validateNestedDefinitions(ast.value);
            return;
        }
        if (ast instanceof MatchNode) {
            validateNestedDefinitions(ast.unionExpr);
            ast.branches.forEach((branch) => {
                validateNestedDefinitions(branch.bind);
                validateNestedDefinitions(branch.body);
            });
            return;
        }
        if (ast instanceof FunctionCallNode) {
            validateNestedDefinitions(ast.callee);
            ast.args.forEach(validateNestedDefinitions);
            return;
        }
        if (ast instanceof GenericCallNode) {
            validateNestedDefinitions(ast.callee);
            ast.typeArgs.forEach(validateNestedDefinitions);
            return;
        }
        if (ast instanceof ClassPropertyNode) {
            validateNestedDefinitions(ast.bind);
            return;
        }
        if (ast instanceof ClassMethodNode) {
            ast.params.forEach(validateNestedDefinitions);
            validateNestedDefinitions(ast.returnType);
            validateNestedDefinitions(ast.body);
            return;
        }
        if (ast instanceof ClassConstructorNode) {
            ast.params.forEach(validateNestedDefinitions);
            validateNestedDefinitions(ast.body);
            return;
        }
        if (ast instanceof TypeVarBindNode) {
            validateNestedDefinitions(ast.var);
            validateNestedDefinitions(ast.typeExp);
            return;
        }
    });
}

function validateClassBodyMember(member: ClassPropertyNode | ClassMethodNode | ClassConstructorNode | PublicNode): void {
    if (member instanceof PublicNode) {
        withActiveTypecheckNode(member, (): void => {
            if (member.inner instanceof PublicNode) {
                throw new TypeCheckError("public cannot wrap public");
            }
            if (member.inner instanceof ClassConstructorNode) {
                throw new TypeCheckError("constructors are always public and cannot be wrapped in public");
            }
            if (!(member.inner instanceof ClassPropertyNode) && !(member.inner instanceof ClassMethodNode)) {
                throw new TypeCheckError("public may only wrap class properties and methods");
            }
        });
        validateNestedDefinitions(member.inner);
        return;
    }

    validateNestedDefinitions(member);
}

function validateTopLevelNodeContents(ast: AstNode): void {
    if (ast instanceof DfunNode) {
        ast.params.forEach(validateNestedDefinitions);
        validateNestedDefinitions(ast.returnType);
        validateNestedDefinitions(ast.body);
        return;
    }
    if (ast instanceof DeclaredDfunNode) {
        ast.params.forEach(validateNestedDefinitions);
        validateNestedDefinitions(ast.returnType);
        return;
    }
    if (ast instanceof GenericDfunNode) {
        ast.params.forEach(validateNestedDefinitions);
        validateNestedDefinitions(ast.returnType);
        validateNestedDefinitions(ast.body);
        return;
    }
    if (ast instanceof ClassNode) {
        ast.memberNodeList.forEach(validateClassBodyMember);
        return;
    }
    if (ast instanceof GenericClassNode) {
        ast.memberNodeList.forEach(validateClassBodyMember);
        return;
    }
    validateNestedDefinitions(ast);
}

function validateTopLevelDefinitions(ast: AstNode): void {
    if (ast instanceof ProgramNode) {
        validateModuleTopLevelStructure(ast);
        ast.topLevelExpressions.forEach((expr) => {
            if (expr instanceof ImportNode) {
                return;
            }
            const topLevelNode = expr instanceof ExportNode ? expr.inner : expr;
            if (isDefinitionNode(topLevelNode) || topLevelNode instanceof DvarNode || topLevelNode instanceof SetNode || topLevelNode instanceof LetNode || topLevelNode instanceof FnNode || topLevelNode instanceof IfNode || topLevelNode instanceof WhileNode || topLevelNode instanceof CondNode || topLevelNode instanceof MatchNode || topLevelNode instanceof FunctionCallNode || topLevelNode instanceof GenericCallNode || topLevelNode instanceof SeqNode || topLevelNode instanceof IdentifierNode || topLevelNode instanceof NumberLiteralNode || topLevelNode instanceof TextDatabaseReferenceNode) {
                validateTopLevelNodeContents(topLevelNode);
                return;
            }
            validateNestedDefinitions(topLevelNode);
        });
        return;
    }

    if (ast instanceof SeqNode) {
        ast.expressions.forEach((expr) => {
            validateNestedDefinitions(expr);
        });
        return;
    }

    validateNestedDefinitions(ast);
}

/**
 * 执行完整的类型检查流程
 */
export function performTypeChecking(ast: AstNode, options?: TypeCheckingOptions): TypeValue {
    try {
        if (ast instanceof ProgramNode) {
            ensureProgramCompilationUnitMetadata(ast);
        }
        const normalizedAst = ast;
        validateTopLevelDefinitions(normalizedAst);
        resetDefinitionInfoTables();
        resetResolvedHeaderTables();
        resetPackageSymbolTable();
        resetGenericInstantiationTables();
        resetMonomorphizedTables();
        resetModuleGlobalInitPlan();
        resetPrecompiledLibraryState();
        toplevelVarEnv.clear();
        toplevelFunctionEnv.clear();
        currentStringDatabase = resolveStringDatabase(ast);

    // Keep the resolved literal-db available for the immediately following
    // lowering pipeline, which reuses typechecking state and may re-infer nodes
    // containing text-db literals before the next explicit typecheck call resets it.

        // 初始化内置函数
        initBuiltins();
        
        // Pass 1a: 先收集 imports，确保后续声明头部里的 imported package types 可见。
        collectImportsPass(normalizedAst);

        // Pass 1: 收集类/函数/全局信息并注册 package symbols
        collectClassInfoPass(normalizedAst);
        registerAnnotatedPackageStringDatabaseSymbols(ast);
        installPrecompiledLibraryTypecheckState(options?.precompiledLibraries ?? []);

        // Pass 1b: imports 只有在 package symbols 建好后才能验证存在性
        validateImportsPass();

        // Pass 2: 解析并规范化声明头部类型
        resolveDefinitionHeadersPass();

        // Pass 3: 检查 declaration-level 规则
        validateDeclarationsPass();

        // Pass 3a: 模组系统 canonical rename，后续阶段统一在包全名上工作
        canonicalizePackageNamesPass(normalizedAst);
        
        // Pass 4: 第一次类型检查，允许 user generic 定义与实例化
        const resultType = typecheck(normalizedAst, toplevelVarEnv, toplevelFunctionEnv, new GenericTypeEnv());

        // Pass 4a: 第一次 source typecheck 之后，将 variadic comparison
        // 重写成 single-eval typed let + binary comparison chain。
        rewriteTypedVariadicComparisonsAfterTypecheck(normalizedAst, toplevelVarEnv, toplevelFunctionEnv, new GenericTypeEnv());

        // Pass 4b: 收束 import 使用情况
        validateUnusedImportsPass();

        // Pass 4c: 收束 module global initializer 依赖图
        validateAndBuildModuleGlobalInitPlan();

        // Pass 5: 以 AST 固定点展开 user generic，生成 concrete program 与 artifacts
        materializeMonomorphizedDefinitionsPass(normalizedAst, {
            maxExpansionRounds: options?.monomorphizationMaxRounds
        });

        // Pass 6: 在真实可达实例集上重新做有限类型检查
        validateFiniteTypeTerminationPass();

        // Pass 7: 第二次类型检查，禁止 user generic 路径，只检查 concrete program
        performConcreteTypeChecking(getMonomorphizedConcreteProgram());

        for (const fn of monomorphizedFunctionTable.values()) {
            toplevelFunctionEnv.set(fn.concreteName, fn.functionType);
        }

        return resultType;
    } catch (error) {
        throw wrapErrorAsDiagnostic(error, "typecheck", "TYPECHECK_PIPELINE_ERROR", {
            ast: getActiveTypecheckNode() ?? ast,
        });
    }
}

export { astToTypeValue };
export {
    getMonomorphizedArtifacts,
    getMonomorphizedProgramNodes,
    formatMonomorphizedAst,
    getMonomorphizedClassInfo,
    getMonomorphizedClassName,
    getMonomorphizedFunctionInfo,
    getMonomorphizedFunctionName,
    materializeMonomorphizedDefinitionsPass,
    monomorphizedClassTable,
    monomorphizedFunctionTable,
    resetMonomorphizedTables
} from "./Typecheck-Pass-8-Monomorphize";
export type {
    MonomorphizedArtifacts,
    MonomorphizedClassInfo,
    MonomorphizedFunctionInfo
} from "./Typecheck-Pass-8-Monomorphize";
