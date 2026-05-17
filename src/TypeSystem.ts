import { AstNode, IdentifierNode, TextDatabaseReferenceNode, TypeToFromNode, TypeUnionNode, GenericCallNode } from "./AstNode";

const CLASS_ID_PREFIX = "C";
const PRIMITIVE_ID_PREFIX = "P";
const FUNCTION_ID_PREFIX = "F";
const GENERIC_CLASS_ID_PREFIX = "G";
const GENERIC_FUNCTION_ID_PREFIX = "H";
const UNION_ID_PREFIX = "U";
const runtimeTypeIdBySignature: Map<string, string> = new Map();
const runtimeTypeSignatureById: Map<string, string> = new Map();
const runtimeTypeSignatureByNumericHash: Map<string, string> = new Map();

export function hashText(input: string): string {
    let hash = 14695981039346656037n;
    const prime = 1099511628211n;
    for (let i = 0; i < input.length; i++) {
        hash ^= BigInt(input.charCodeAt(i));
        hash = (hash * prime) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, "0");
}

function registerRuntimeTypeId(prefix: string, signature: string): string {
    const qualifiedSignature = `${prefix}:${signature}`;
    const existing = runtimeTypeIdBySignature.get(qualifiedSignature);
    if (existing) {
        return existing;
    }

    let collisionIndex = 0;
    let candidateSignature = signature;
    let numericHash = hashText(`${prefix}<${candidateSignature}>`);
    let runtimeTypeId = `${prefix}${numericHash}`;
    while (
        (runtimeTypeSignatureById.has(runtimeTypeId) && runtimeTypeSignatureById.get(runtimeTypeId) !== qualifiedSignature)
        || (runtimeTypeSignatureByNumericHash.has(numericHash) && runtimeTypeSignatureByNumericHash.get(numericHash) !== qualifiedSignature)
    ) {
        collisionIndex += 1;
        candidateSignature = `${signature}#${collisionIndex}`;
        numericHash = hashText(`${prefix}<${candidateSignature}>`);
        runtimeTypeId = `${prefix}${numericHash}`;
    }

    runtimeTypeIdBySignature.set(qualifiedSignature, runtimeTypeId);
    runtimeTypeSignatureById.set(runtimeTypeId, qualifiedSignature);
    runtimeTypeSignatureByNumericHash.set(numericHash, qualifiedSignature);
    return runtimeTypeId;
}

function buildClassTypeIdSignature(className: string): string {
    return `Class<${className}>`;
}

function instanceSuffix(instanceHash: string): string {
    const suffix = instanceHash.split(":")[1];
    return suffix && suffix.length > 0 ? suffix : hashText(instanceHash);
}

function getRuntimeConcreteClassName(type: GenericClassInstanceTypeValue): string {
    return `__iw_mono_class_${type.genericName}_${instanceSuffix(type.hash())}`;
}

function runtimeCanonicalTypeSignature(type: TypeValue): string {
    if (type instanceof PrimitiveTypeValue) {
        return `Primitive<${type.name}>`;
    }
    if (type instanceof ClassTypeValue) {
        return buildClassTypeIdSignature(type.className);
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        if (builtinGenericTypeNames.has(type.genericName)) {
            return `GenericClass<${type.genericName}:${type.typeArgs.map((typeArg) => runtimeCanonicalTypeSignature(typeArg)).join(",")}>`;
        }
        return buildClassTypeIdSignature(getRuntimeConcreteClassName(type));
    }
    if (type instanceof FunctionTypeValue) {
        return `Function<(${type.paramTypes.map((paramType) => runtimeCanonicalTypeSignature(paramType)).join(",")})->${runtimeCanonicalTypeSignature(type.returnType)}>`;
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return `GenericFunction<${type.genericName}:${type.typeArgs.map((typeArg) => runtimeCanonicalTypeSignature(typeArg)).join(",")}>`;
    }
    if (type instanceof UnionTypeValue) {
        return `Union<${type.types.map((member) => runtimeCanonicalTypeSignature(member)).join("|")}>`;
    }
    return `TypeParam<${type.name}>`;
}

function registerUnionId(signature: string): string {
    return registerRuntimeTypeId(UNION_ID_PREFIX, `Union<${signature}>`);
}

export function getClassTypeId(classType: ClassTypeValue | string): string {
    const className = typeof classType === "string" ? classType : classType.className;
    return registerRuntimeTypeId(CLASS_ID_PREFIX, buildClassTypeIdSignature(className));
}

export function getRuntimeTypeId(type: TypeValue): string {
    if (type instanceof PrimitiveTypeValue) {
        return registerRuntimeTypeId(PRIMITIVE_ID_PREFIX, `Primitive<${type.name}>`);
    }
    if (type instanceof ClassTypeValue) {
        return getClassTypeId(type);
    }
    if (type instanceof FunctionTypeValue) {
        return registerRuntimeTypeId(FUNCTION_ID_PREFIX, `Function<${type.hash()}>`);
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        if (builtinGenericTypeNames.has(type.genericName)) {
            return registerRuntimeTypeId(GENERIC_CLASS_ID_PREFIX, runtimeCanonicalTypeSignature(type));
        }
        return getClassTypeId(getRuntimeConcreteClassName(type));
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return registerRuntimeTypeId(GENERIC_FUNCTION_ID_PREFIX, `GenericFunction<${type.hash()}>`);
    }
    if (type instanceof UnionTypeValue) {
        return getUnionTypeId(type);
    }
    throw new Error(`Type parameter '${type.name}' does not have a concrete runtime type id`);
}

export function buildTypeHash(tag: string, parts: readonly string[]): string {
    return `${tag}:${hashText(`${tag}<${parts.join("|")}>`)}`;
}

export class PrimitiveTypeValue {
    public readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    hash(): string {
        return buildTypeHash("Primitive", [this.name]);
    }
}

export class TypeParameterValue {
    public readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    hash(): string {
        return buildTypeHash("TypeParam", [this.name]);
    }
}

export class FunctionTypeValue {
    public readonly paramTypes: TypeValue[];
    public readonly returnType: TypeValue;

    constructor(paramTypes: TypeValue[], returnType: TypeValue) {
        this.paramTypes = paramTypes;
        this.returnType = returnType;
    }

    hash(): string {
        return buildTypeHash("Function", [...this.paramTypes.map((type) => type.hash()), this.returnType.hash()]);
    }
}

export class ClassTypeValue {
    public readonly className: string;

    constructor(className: string) {
        this.className = className;
    }

    hash(): string {
        return buildTypeHash("Class", [this.className]);
    }
}

export class GenericClassInstanceTypeValue {
    public readonly genericName: string;
    public readonly typeArgs: TypeValue[];

    constructor(genericName: string, typeArgs: TypeValue[]) {
        this.genericName = genericName;
        this.typeArgs = typeArgs;
    }

    hash(): string {
        return buildTypeHash("GenericClass", [this.genericName, ...this.typeArgs.map((type) => type.hash())]);
    }
}

export class GenericFunctionInstanceTypeValue {
    public readonly genericName: string;
    public readonly typeArgs: TypeValue[];

    constructor(genericName: string, typeArgs: TypeValue[]) {
        this.genericName = genericName;
        this.typeArgs = typeArgs;
    }

    hash(): string {
        return buildTypeHash("GenericFunction", [this.genericName, ...this.typeArgs.map((type) => type.hash())]);
    }
}

export class UnionTypeValue {
    public readonly types: TypeValue[];
    public readonly canonicalSignature: string;
    public readonly canonicalId: string;

    constructor(types: TypeValue[]) {
        this.types = normalizeUnionMembers(types);
        this.canonicalSignature = buildUnionCanonicalSignature(this.types);
        this.canonicalId = registerUnionId(this.canonicalSignature);
    }

    hash(): string {
        return buildTypeHash("Union", [this.canonicalId]);
    }
}

export function buildUnionCanonicalSignature(types: readonly TypeValue[]): string {
    return types.map((type) => runtimeCanonicalTypeSignature(type)).join("|");
}

export function getUnionTypeId(unionType: UnionTypeValue): string {
    return unionType.canonicalId;
}

export type TypeValue =
    | PrimitiveTypeValue
    | TypeParameterValue
    | FunctionTypeValue
    | ClassTypeValue
    | GenericClassInstanceTypeValue
    | GenericFunctionInstanceTypeValue
    | UnionTypeValue;

export const primitiveTypeNames: ReadonlySet<string> = new Set([
    "i5", "i6", "i7",
    "u5", "u6", "u7",
    "f5", "f6", "f7",
    "z5", "z6", "z7",
    "c3", "c4", "c5",
    "s3", "s4", "s5",
    "bool", "unit"
]);

export const builtinGenericTypeNames: ReadonlySet<string> = new Set(["array"]);

export class GenericTypeEnv {
    private readonly env: Map<string, TypeValue>;
    public readonly parent?: GenericTypeEnv;

    constructor(initEnv?: Map<string, TypeValue>, parent?: GenericTypeEnv) {
        this.env = initEnv ? new Map(initEnv) : new Map();
        this.parent = parent;
    }

    get(name: string): TypeValue | undefined {
        if (this.env.has(name)) {
            return this.env.get(name);
        }
        return this.parent?.get(name);
    }

    set(name: string, value: TypeValue): void {
        this.env.set(name, value);
    }

    has(name: string): boolean {
        return this.env.has(name) || this.parent?.has(name) === true;
    }

    extend(): GenericTypeEnv {
        return new GenericTypeEnv(undefined, this);
    }

    clone(): GenericTypeEnv {
        return new GenericTypeEnv(this.env, this.parent);
    }
}

export function normalizeTypeValue(type: TypeValue): TypeValue {
    if (type instanceof UnionTypeValue) {
        return new UnionTypeValue(type.types);
    }
    if (type instanceof FunctionTypeValue) {
        return new FunctionTypeValue(type.paramTypes.map(normalizeTypeValue), normalizeTypeValue(type.returnType));
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return new GenericClassInstanceTypeValue(type.genericName, type.typeArgs.map(normalizeTypeValue));
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return new GenericFunctionInstanceTypeValue(type.genericName, type.typeArgs.map(normalizeTypeValue));
    }
    return type;
}

function typeCanonicalKey(type: TypeValue): string {
    if (type instanceof PrimitiveTypeValue) {
        return `Primitive:${type.name}`;
    }
    if (type instanceof TypeParameterValue) {
        return `TypeParam:${type.name}`;
    }
    if (type instanceof ClassTypeValue) {
        return `Class:${type.className}`;
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return `GenericClass:${type.genericName}<${type.typeArgs.map(typeCanonicalKey).join(",")}>`;
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return `GenericFunction:${type.genericName}<${type.typeArgs.map(typeCanonicalKey).join(",")}>`;
    }
    if (type instanceof FunctionTypeValue) {
        return `Function:(${type.paramTypes.map(typeCanonicalKey).join(",")})->${typeCanonicalKey(type.returnType)}`;
    }
    return `Union:${type.types.map(typeCanonicalKey).join("|")}`;
}

export function normalizeUnionMembers(types: TypeValue[]): TypeValue[] {
    const seen: Map<string, TypeValue> = new Map();
    for (const type of types.map(normalizeTypeValue)) {
        const existing = seen.get(type.hash());
        if (existing !== undefined) {
            throw new Error(`Duplicate union member type: ${printTypeValue(type)}`);
        }
        seen.set(type.hash(), type);
    }
    return Array.from(seen.values()).sort((left, right) => typeCanonicalKey(left).localeCompare(typeCanonicalKey(right)));
}

export function typeEqual(left: TypeValue, right: TypeValue): boolean {
    const normalizedLeft = normalizeTypeValue(left);
    const normalizedRight = normalizeTypeValue(right);

    if (normalizedLeft.constructor !== normalizedRight.constructor) {
        return false;
    }

    if (normalizedLeft instanceof PrimitiveTypeValue && normalizedRight instanceof PrimitiveTypeValue) {
        return normalizedLeft.name === normalizedRight.name;
    }
    if (normalizedLeft instanceof TypeParameterValue && normalizedRight instanceof TypeParameterValue) {
        return normalizedLeft.name === normalizedRight.name;
    }
    if (normalizedLeft instanceof ClassTypeValue && normalizedRight instanceof ClassTypeValue) {
        return normalizedLeft.className === normalizedRight.className;
    }
    if (normalizedLeft instanceof GenericClassInstanceTypeValue && normalizedRight instanceof GenericClassInstanceTypeValue) {
        return normalizedLeft.genericName === normalizedRight.genericName
            && normalizedLeft.typeArgs.length === normalizedRight.typeArgs.length
            && normalizedLeft.typeArgs.every((type, index) => typeEqual(type, normalizedRight.typeArgs[index]));
    }
    if (normalizedLeft instanceof GenericFunctionInstanceTypeValue && normalizedRight instanceof GenericFunctionInstanceTypeValue) {
        return normalizedLeft.genericName === normalizedRight.genericName
            && normalizedLeft.typeArgs.length === normalizedRight.typeArgs.length
            && normalizedLeft.typeArgs.every((type, index) => typeEqual(type, normalizedRight.typeArgs[index]));
    }
    if (normalizedLeft instanceof FunctionTypeValue && normalizedRight instanceof FunctionTypeValue) {
        return normalizedLeft.paramTypes.length === normalizedRight.paramTypes.length
            && normalizedLeft.paramTypes.every((type, index) => typeEqual(type, normalizedRight.paramTypes[index]))
            && typeEqual(normalizedLeft.returnType, normalizedRight.returnType);
    }
    if (normalizedLeft instanceof UnionTypeValue && normalizedRight instanceof UnionTypeValue) {
        return normalizedLeft.types.length === normalizedRight.types.length
            && normalizedLeft.types.every((type, index) => typeEqual(type, normalizedRight.types[index]));
    }
    return false;
}

export function isAssignable(actual: TypeValue, expected: TypeValue): boolean {
    if (typeEqual(actual, expected)) {
        return true;
    }
    if (expected instanceof UnionTypeValue) {
        return expected.types.some((member) => typeEqual(actual, member));
    }
    return false;
}

export function substituteTypeVariables(type: TypeValue, substitutions: Map<string, TypeValue>): TypeValue {
    if (type instanceof TypeParameterValue) {
        return substitutions.get(type.name) ?? type;
    }
    if (type instanceof FunctionTypeValue) {
        return new FunctionTypeValue(
            type.paramTypes.map((paramType) => substituteTypeVariables(paramType, substitutions)),
            substituteTypeVariables(type.returnType, substitutions)
        );
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return new GenericClassInstanceTypeValue(
            type.genericName,
            type.typeArgs.map((typeArg) => substituteTypeVariables(typeArg, substitutions))
        );
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return new GenericFunctionInstanceTypeValue(
            type.genericName,
            type.typeArgs.map((typeArg) => substituteTypeVariables(typeArg, substitutions))
        );
    }
    if (type instanceof UnionTypeValue) {
        return new UnionTypeValue(type.types.map((member) => substituteTypeVariables(member, substitutions)));
    }
    return type;
}

export function printTypeValue(type: TypeValue): string {
    if (type instanceof PrimitiveTypeValue) {
        return type.name;
    }
    if (type instanceof TypeParameterValue) {
        return type.name;
    }
    if (type instanceof ClassTypeValue) {
        return type.className;
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return `<${type.genericName} ${type.typeArgs.map(printTypeValue).join(" ")}>`;
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return `<${type.genericName} ${type.typeArgs.map(printTypeValue).join(" ")}>`;
    }
    if (type instanceof FunctionTypeValue) {
        return `<to ${printTypeValue(type.returnType)} from ${type.paramTypes.map(printTypeValue).join(" ")}>`;
    }
    return `<union ${type.types.map(printTypeValue).join(" ")}>`;
}

export function formatAstNode(ast: AstNode): string {
    if (ast instanceof IdentifierNode) {
        return ast.name;
    }
    if (ast instanceof TextDatabaseReferenceNode) {
        return ast.referenceName;
    }
    if (ast instanceof GenericCallNode) {
        return `<${formatAstNode(ast.callee)} ${ast.typeArgs.map(formatAstNode).join(" ")}>`;
    }
    if (ast instanceof TypeToFromNode) {
        return `<to ${formatAstNode(ast.returnType)} from ${ast.paramTypes.map(formatAstNode).join(" ")}>`;
    }
    if (ast instanceof TypeUnionNode) {
        return `<union ${ast.types.map(formatAstNode).join(" ")}>`;
    }
    return `<AstNode:${ast.kind}>`;
}
