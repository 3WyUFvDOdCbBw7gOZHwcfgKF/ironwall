import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    ClassPropertyNode,
    GenericClassNode,
    GenericDfunNode,
    GenericCallNode,
    IdentifierNode,
    ProgramNode,
    TypeToFromNode,
    TypeUnionNode,
    TypeVarBindNode,
} from "./AstNode";
import { getCompilationUnitMetadata } from "./ModuleMetadata";
import {
    ClassInfo,
    FunctionInfo,
    GenericClassInfo,
    GenericFunctionInfo,
    GlobalVarInfo,
    getAllClassInfos,
    getAllFunctionInfos,
    getAllGenericClassInfos,
    getAllGenericFunctionInfos,
    getAllGlobalVarInfos,
    getGenericClassInfo,
    getGenericFunctionInfo,
    printTypeValue,
    substituteTypeVariables
} from "./Typecheck-Core";
import { registerClassInfo, registerFunctionInfo, registerGenericClassInfo, registerGenericFunctionInfo, registerGlobalVarInfo } from "./Typecheck-Definitions";
import { registerPackageSymbol } from "./Typecheck-Modules";
import { getResolvedFunctionOverloads } from "./Typecheck-Pass-2-ResolveHeaders";
import { astToTypeValue } from "./Typecheck-TypeAst";
import {
    MonomorphizedClassInfo,
    MonomorphizedFunctionInfo
} from "./Typecheck-Pass-8-Monomorphize";
import {
    ClassTypeValue,
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    GenericFunctionInstanceTypeValue,
    GenericTypeEnv,
    PrimitiveTypeValue,
    TypeParameterValue,
    UnionTypeValue,
    hashText,
    type TypeValue
} from "./TypeSystem";
import { defaultBuildTarget, type BuildTarget } from "./Target";

const PRECOMPILED_LIB_MANIFEST_FILE = "manifest.json";
const PRECOMPILED_LIB_ASSEMBLY_ROOT = "asm";
const PRECOMPILED_LIB_SUPPORT_ROOT = "support";
const PRECOMPILED_SYNTHETIC_UNIT_PREFIX = "iw_precompiled_";

interface SerializedPrimitiveTypeValue {
    readonly kind: "primitive";
    readonly name: string;
}

interface SerializedClassTypeValue {
    readonly kind: "class";
    readonly className: string;
}

interface SerializedTypeParameterValue {
    readonly kind: "type_parameter";
    readonly name: string;
}

interface SerializedFunctionTypeValue {
    readonly kind: "function";
    readonly paramTypes: readonly SerializedTypeValue[];
    readonly returnType: SerializedTypeValue;
}

interface SerializedUnionTypeValue {
    readonly kind: "union";
    readonly members: readonly SerializedTypeValue[];
}

interface SerializedGenericClassInstanceTypeValue {
    readonly kind: "generic_class";
    readonly genericName: string;
    readonly typeArgs: readonly SerializedTypeValue[];
}

interface SerializedGenericFunctionInstanceTypeValue {
    readonly kind: "generic_function";
    readonly genericName: string;
    readonly typeArgs: readonly SerializedTypeValue[];
}

export type SerializedTypeValue =
    | SerializedPrimitiveTypeValue
    | SerializedClassTypeValue
    | SerializedTypeParameterValue
    | SerializedFunctionTypeValue
    | SerializedUnionTypeValue
    | SerializedGenericClassInstanceTypeValue
    | SerializedGenericFunctionInstanceTypeValue;

export interface SerializedBinding {
    readonly name: string;
    readonly type: SerializedTypeValue;
}

export interface SerializedConstructorSignature {
    readonly params: readonly SerializedBinding[];
}

export interface SerializedMethodSignature {
    readonly name: string;
    readonly params: readonly SerializedBinding[];
    readonly returnType: SerializedTypeValue;
}

export interface SerializedClassSignature {
    readonly canonicalName: string;
    readonly exportedName: string;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly properties: readonly SerializedBinding[];
    readonly methods: readonly SerializedMethodSignature[];
    readonly constructors: readonly SerializedConstructorSignature[];
}

export interface SerializedFunctionSignature {
    readonly canonicalName: string;
    readonly concreteSymbol: string;
    readonly exportedName: string;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly params: readonly SerializedBinding[];
    readonly returnType: SerializedTypeValue;
    readonly isDeclared: boolean;
}

export interface SerializedGlobalSignature {
    readonly canonicalName: string;
    readonly symbolName: string;
    readonly exportedName: string;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly type: SerializedTypeValue;
}

export interface SerializedGenericClassSignature {
    readonly canonicalName: string;
    readonly fullName: string;
    readonly exportedName: string;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly typeParams: readonly string[];
    readonly properties: readonly SerializedBinding[];
    readonly methods: readonly SerializedMethodSignature[];
    readonly constructors: readonly SerializedConstructorSignature[];
}

export interface SerializedGenericFunctionSignature {
    readonly canonicalName: string;
    readonly fullName: string;
    readonly exportedName: string;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly typeParams: readonly string[];
    readonly params: readonly SerializedBinding[];
    readonly returnType: SerializedTypeValue;
}

export interface SerializedMonomorphizedClassRecord {
    readonly instanceHash: string;
    readonly sourceGenericName: string;
    readonly concreteName: string;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly typeArgs: readonly SerializedTypeValue[];
}

export interface SerializedMonomorphizedFunctionRecord {
    readonly instanceHash: string;
    readonly sourceGenericName: string;
    readonly concreteName: string;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly typeArgs: readonly SerializedTypeValue[];
}

export interface PrecompiledLibraryUnitManifestEntry {
    readonly unitId: string;
    readonly assemblyPath: string;
    readonly supportPath: string;
    readonly metadataTableExportSymbol: string;
    readonly globalTableExportSymbol: string;
    readonly runtimeInitExportSymbol: string;
    readonly buildInfo?: PrecompiledUnitBuildInfo;
}

export interface PrecompiledUnitHashedFileRecord {
    readonly filePath: string;
    readonly sha256: string;
}

export interface PrecompiledUnitInputSignature {
    readonly target: BuildTarget;
    readonly frontendProfile: string;
    readonly backendProfile: string;
    readonly compilerSha256: string;
    readonly externalFrontendCommand: string | null;
    readonly externalFrontendCommandSha256: string | null;
    readonly sourceFiles: readonly PrecompiledUnitHashedFileRecord[];
    readonly dependencyFiles: readonly PrecompiledUnitHashedFileRecord[];
}

export interface PrecompiledUnitBuildInfo extends PrecompiledUnitInputSignature {
    readonly outputFiles: readonly PrecompiledUnitHashedFileRecord[];
}

export interface PrecompiledLibraryManifest {
    readonly format: "iw-precompiled-lib";
    readonly version: 2;
    readonly target: BuildTarget;
    readonly compiledUnits: readonly PrecompiledLibraryUnitManifestEntry[];
    readonly classSignatures: readonly SerializedClassSignature[];
    readonly functionSignatures: readonly SerializedFunctionSignature[];
    readonly globalSignatures: readonly SerializedGlobalSignature[];
    readonly genericClassSignatures: readonly SerializedGenericClassSignature[];
    readonly genericFunctionSignatures: readonly SerializedGenericFunctionSignature[];
    readonly monomorphizedClasses: readonly SerializedMonomorphizedClassRecord[];
    readonly monomorphizedFunctions: readonly SerializedMonomorphizedFunctionRecord[];
}

export interface LoadedPrecompiledLibraryUnit {
    readonly unitId: string;
    readonly assemblyPath: string;
    readonly supportPath: string;
    readonly metadataTableExportSymbol: string;
    readonly globalTableExportSymbol: string;
    readonly runtimeInitExportSymbol: string;
}

export interface LoadedPrecompiledLibrary {
    readonly archivePath: string;
    readonly extractDir: string;
    readonly compiledUnits: readonly LoadedPrecompiledLibraryUnit[];
    readonly manifest: PrecompiledLibraryManifest;
}

export interface PrecompiledLibrarySnapshotSource {
    readonly archivePath: string;
    readonly manifest: PrecompiledLibraryManifest;
}

export interface PrecompiledLibraryCompiledUnitArtifact {
    readonly unitId: string;
    readonly assemblyText: string;
    readonly supportText: string;
    readonly metadataTableExportSymbol: string;
    readonly globalTableExportSymbol: string;
    readonly runtimeInitExportSymbol: string;
    readonly buildInfo?: PrecompiledUnitBuildInfo;
}

export interface PrecompiledLibraryPackagingPlan {
    readonly manifest: PrecompiledLibraryManifest;
    readonly compilationUnits: ReadonlyMap<string, ProgramNode>;
}

interface PrecompiledMonomorphLookupRecord {
    readonly concreteName: string;
    readonly archivePath: string;
}

export interface InstalledPrecompiledConcreteClassDefinition {
    readonly concreteName: string;
    readonly aliases: readonly string[];
    readonly propertyTypes: ReadonlyMap<string, TypeValue>;
    readonly methodTypes: ReadonlyMap<string, FunctionTypeValue>;
    readonly constructorParamTypes: readonly (readonly TypeValue[])[];
}

export interface InstalledPrecompiledConcreteFunctionDefinition {
    readonly concreteName: string;
    readonly aliases: readonly string[];
    readonly functionType: FunctionTypeValue;
}

export interface InstalledPrecompiledConcreteGlobalDefinition {
    readonly canonicalName: string;
    readonly aliases: readonly string[];
    readonly type: TypeValue;
}

export interface InstalledPrecompiledConcreteDefinitions {
    readonly classes: readonly InstalledPrecompiledConcreteClassDefinition[];
    readonly functions: readonly InstalledPrecompiledConcreteFunctionDefinition[];
    readonly globals: readonly InstalledPrecompiledConcreteGlobalDefinition[];
}

const precompiledGenericClassNames = new Set<string>();
const precompiledGenericFunctionNames = new Set<string>();
const precompiledClassLookupByInstanceHash = new Map<string, PrecompiledMonomorphLookupRecord>();
const precompiledFunctionLookupByInstanceHash = new Map<string, PrecompiledMonomorphLookupRecord>();
const installedPrecompiledLibraries: LoadedPrecompiledLibrary[] = [];

function buildSyntheticUnitId(packageName: string): string {
    return `${packageName}@${PRECOMPILED_SYNTHETIC_UNIT_PREFIX}${hashText(packageName).slice(0, 8)}`;
}

function serializeTypeValue(type: TypeValue): SerializedTypeValue {
    if (type instanceof PrimitiveTypeValue) {
        return {
            kind: "primitive",
            name: type.name
        };
    }
    if (type instanceof FunctionTypeValue) {
        return {
            kind: "function",
            paramTypes: type.paramTypes.map((paramType) => serializeTypeValue(paramType)),
            returnType: serializeTypeValue(type.returnType)
        };
    }
    if (type instanceof UnionTypeValue) {
        return {
            kind: "union",
            members: type.types.map((member) => serializeTypeValue(member))
        };
    }
    if (type instanceof TypeParameterValue) {
        return {
            kind: "type_parameter",
            name: type.name
        };
    }
    if (type instanceof ClassTypeValue) {
        return {
            kind: "class",
            className: type.className
        };
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return {
            kind: "generic_class",
            genericName: type.genericName,
            typeArgs: type.typeArgs.map((typeArg) => serializeTypeValue(typeArg))
        };
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return {
            kind: "generic_function",
            genericName: type.genericName,
            typeArgs: type.typeArgs.map((typeArg) => serializeTypeValue(typeArg))
        };
    }
    return {
        kind: "class",
        className: "<unknown>"
    };
}

export function deserializeSerializedTypeValue(serialized: SerializedTypeValue): TypeValue {
    switch (serialized.kind) {
        case "primitive":
            return new PrimitiveTypeValue(serialized.name);
        case "class":
            return new ClassTypeValue(serialized.className);
        case "type_parameter":
            return new TypeParameterValue(serialized.name);
        case "function":
            return new FunctionTypeValue(
                serialized.paramTypes.map((paramType) => deserializeSerializedTypeValue(paramType)),
                deserializeSerializedTypeValue(serialized.returnType)
            );
        case "union":
            return new UnionTypeValue(serialized.members.map((member) => deserializeSerializedTypeValue(member)));
        case "generic_class":
            return new GenericClassInstanceTypeValue(
                serialized.genericName,
                serialized.typeArgs.map((typeArg) => deserializeSerializedTypeValue(typeArg))
            );
        case "generic_function":
            return new GenericFunctionInstanceTypeValue(
                serialized.genericName,
                serialized.typeArgs.map((typeArg) => deserializeSerializedTypeValue(typeArg))
            );
    }
}

export function serializedTypeValueToAst(type: TypeValue): AstNode {
    if (type instanceof PrimitiveTypeValue) {
        return new IdentifierNode(type.name);
    }
    if (type instanceof TypeParameterValue) {
        return new IdentifierNode(type.name);
    }
    if (type instanceof ClassTypeValue) {
        return new IdentifierNode(type.className);
    }
    if (type instanceof FunctionTypeValue) {
        return new TypeToFromNode(
            serializedTypeValueToAst(type.returnType),
            type.paramTypes.map((paramType) => serializedTypeValueToAst(paramType))
        );
    }
    if (type instanceof UnionTypeValue) {
        return new TypeUnionNode(type.types.map((member) => serializedTypeValueToAst(member)));
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return new GenericCallNode(
            new IdentifierNode(type.genericName),
            type.typeArgs.map((typeArg) => serializedTypeValueToAst(typeArg))
        );
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return new GenericCallNode(
            new IdentifierNode(type.genericName),
            type.typeArgs.map((typeArg) => serializedTypeValueToAst(typeArg))
        );
    }
    return new IdentifierNode("<unknown>");
}

function buildAliasList(names: readonly string[]): readonly string[] {
    const aliases: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
        if (name.length === 0 || seen.has(name)) {
            continue;
        }
        seen.add(name);
        aliases.push(name);
    }
    return aliases;
}

function buildTypeSubstitutionMap(typeParams: readonly string[], typeArgs: readonly SerializedTypeValue[]): Map<string, TypeValue> {
    const substitutions = new Map<string, TypeValue>();
    for (let index = 0; index < typeParams.length; index += 1) {
        const typeArg = typeArgs[index];
        if (typeArg === undefined) {
            continue;
        }
        substitutions.set(typeParams[index], deserializeSerializedTypeValue(typeArg));
    }
    return substitutions;
}

function buildInstalledConcreteClassLookup(libraries: readonly LoadedPrecompiledLibrary[]): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const library of libraries) {
        for (const record of library.manifest.monomorphizedClasses) {
            lookup.set(record.instanceHash, record.concreteName);
        }
    }
    return lookup;
}

function resolveConcreteTypeValue(type: TypeValue, classLookupByInstanceHash: ReadonlyMap<string, string>): TypeValue {
    if (type instanceof PrimitiveTypeValue || type instanceof ClassTypeValue) {
        return type;
    }
    if (type instanceof TypeParameterValue) {
        throw new Error(`precompiled lib concrete signature still contains type parameter '${type.name}'`);
    }
    if (type instanceof FunctionTypeValue) {
        const paramTypes: TypeValue[] = [];
        for (const paramType of type.paramTypes) {
            paramTypes.push(resolveConcreteTypeValue(paramType, classLookupByInstanceHash));
        }
        const returnType = resolveConcreteTypeValue(type.returnType, classLookupByInstanceHash);
        return new FunctionTypeValue(paramTypes, returnType);
    }
    if (type instanceof UnionTypeValue) {
        const members: TypeValue[] = [];
        for (const member of type.types) {
            members.push(resolveConcreteTypeValue(member, classLookupByInstanceHash));
        }
        return new UnionTypeValue(members);
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        throw new Error(`precompiled lib concrete signature cannot contain generic function type '${printTypeValue(type)}'`);
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        const normalizedTypeArgs: TypeValue[] = [];
        for (const typeArg of type.typeArgs) {
            normalizedTypeArgs.push(resolveConcreteTypeValue(typeArg, classLookupByInstanceHash));
        }
        if (type.genericName === "array") {
            return new GenericClassInstanceTypeValue(type.genericName, normalizedTypeArgs);
        }
        const normalizedInstance = new GenericClassInstanceTypeValue(type.genericName, normalizedTypeArgs);
        const concreteName = classLookupByInstanceHash.get(normalizedInstance.hash());
        if (concreteName === undefined) {
            throw new Error(`precompiled lib is missing monomorphized concrete class for '${printTypeValue(normalizedInstance)}'`);
        }
        return new ClassTypeValue(concreteName);
    }
    throw new Error(`Unsupported precompiled concrete type '${printTypeValue(type)}'`);
}

function instantiateConcreteSerializedType(
    serialized: SerializedTypeValue,
    substitutions: ReadonlyMap<string, TypeValue>,
    classLookupByInstanceHash: ReadonlyMap<string, string>
): TypeValue {
    const substituted = substituteTypeVariables(deserializeSerializedTypeValue(serialized), new Map(substitutions));
    return resolveConcreteTypeValue(substituted, classLookupByInstanceHash);
}

function buildConcreteFunctionType(
    params: readonly SerializedBinding[],
    returnType: SerializedTypeValue,
    substitutions: ReadonlyMap<string, TypeValue>,
    classLookupByInstanceHash: ReadonlyMap<string, string>
): FunctionTypeValue {
    const paramTypes: TypeValue[] = [];
    for (const param of params) {
        paramTypes.push(instantiateConcreteSerializedType(param.type, substitutions, classLookupByInstanceHash));
    }
    const concreteReturnType = instantiateConcreteSerializedType(returnType, substitutions, classLookupByInstanceHash);
    return new FunctionTypeValue(paramTypes, concreteReturnType);
}

function buildInstalledConcreteClassDefinitions(
    libraries: readonly LoadedPrecompiledLibrary[],
    classLookupByInstanceHash: ReadonlyMap<string, string>
): readonly InstalledPrecompiledConcreteClassDefinition[] {
    const definitions = new Map<string, InstalledPrecompiledConcreteClassDefinition>();
    const genericClassSignatures = new Map<string, SerializedGenericClassSignature>();

    for (const library of libraries) {
        for (const signature of library.manifest.genericClassSignatures) {
            if (!genericClassSignatures.has(signature.fullName)) {
                genericClassSignatures.set(signature.fullName, signature);
            }
        }
    }

    for (const library of libraries) {
        for (const signature of library.manifest.classSignatures) {
            if (definitions.has(signature.canonicalName)) {
                continue;
            }
            const propertyTypes = new Map<string, TypeValue>();
            for (const property of signature.properties) {
                propertyTypes.set(property.name, instantiateConcreteSerializedType(property.type, new Map<string, TypeValue>(), classLookupByInstanceHash));
            }
            const methodTypes = new Map<string, FunctionTypeValue>();
            for (const method of signature.methods) {
                methodTypes.set(method.name, buildConcreteFunctionType(method.params, method.returnType, new Map<string, TypeValue>(), classLookupByInstanceHash));
            }
            const constructorParamTypes: TypeValue[][] = [];
            for (const ctor of signature.constructors) {
                const paramTypes: TypeValue[] = [];
                for (const param of ctor.params) {
                    paramTypes.push(instantiateConcreteSerializedType(param.type, new Map<string, TypeValue>(), classLookupByInstanceHash));
                }
                constructorParamTypes.push(paramTypes);
            }
            definitions.set(signature.canonicalName, {
                concreteName: signature.canonicalName,
                aliases: buildAliasList([signature.canonicalName, signature.exportedName]),
                propertyTypes,
                methodTypes,
                constructorParamTypes
            });
        }

        for (const record of library.manifest.monomorphizedClasses) {
            if (definitions.has(record.concreteName)) {
                continue;
            }
            const genericSignature = genericClassSignatures.get(record.sourceGenericName);
            if (genericSignature === undefined) {
                throw new Error(`precompiled lib is missing generic class signature for '${record.sourceGenericName}'`);
            }
            const substitutions = buildTypeSubstitutionMap(genericSignature.typeParams, record.typeArgs);
            const propertyTypes = new Map<string, TypeValue>();
            for (const property of genericSignature.properties) {
                propertyTypes.set(property.name, instantiateConcreteSerializedType(property.type, substitutions, classLookupByInstanceHash));
            }
            const methodTypes = new Map<string, FunctionTypeValue>();
            for (const method of genericSignature.methods) {
                methodTypes.set(method.name, buildConcreteFunctionType(method.params, method.returnType, substitutions, classLookupByInstanceHash));
            }
            const constructorParamTypes: TypeValue[][] = [];
            for (const ctor of genericSignature.constructors) {
                const paramTypes: TypeValue[] = [];
                for (const param of ctor.params) {
                    paramTypes.push(instantiateConcreteSerializedType(param.type, substitutions, classLookupByInstanceHash));
                }
                constructorParamTypes.push(paramTypes);
            }
            definitions.set(record.concreteName, {
                concreteName: record.concreteName,
                aliases: buildAliasList([record.concreteName]),
                propertyTypes,
                methodTypes,
                constructorParamTypes
            });
        }
    }

    return Array.from(definitions.values()).sort((left, right) => left.concreteName.localeCompare(right.concreteName));
}

function buildInstalledConcreteFunctionDefinitions(
    libraries: readonly LoadedPrecompiledLibrary[],
    classLookupByInstanceHash: ReadonlyMap<string, string>
): readonly InstalledPrecompiledConcreteFunctionDefinition[] {
    const definitions = new Map<string, InstalledPrecompiledConcreteFunctionDefinition>();
    const genericFunctionSignatures = new Map<string, SerializedGenericFunctionSignature>();

    for (const library of libraries) {
        for (const signature of library.manifest.genericFunctionSignatures) {
            if (!genericFunctionSignatures.has(signature.fullName)) {
                genericFunctionSignatures.set(signature.fullName, signature);
            }
        }
    }

    for (const library of libraries) {
        for (const signature of library.manifest.functionSignatures) {
            if (definitions.has(signature.concreteSymbol)) {
                continue;
            }
            definitions.set(signature.concreteSymbol, {
                concreteName: signature.concreteSymbol,
                aliases: buildAliasList([signature.concreteSymbol, signature.canonicalName, signature.exportedName]),
                functionType: buildConcreteFunctionType(signature.params, signature.returnType, new Map<string, TypeValue>(), classLookupByInstanceHash)
            });
        }

        for (const record of library.manifest.monomorphizedFunctions) {
            if (definitions.has(record.concreteName)) {
                continue;
            }
            const genericSignature = genericFunctionSignatures.get(record.sourceGenericName);
            if (genericSignature === undefined) {
                throw new Error(`precompiled lib is missing generic function signature for '${record.sourceGenericName}'`);
            }
            const substitutions = buildTypeSubstitutionMap(genericSignature.typeParams, record.typeArgs);
            definitions.set(record.concreteName, {
                concreteName: record.concreteName,
                aliases: buildAliasList([record.concreteName]),
                functionType: buildConcreteFunctionType(genericSignature.params, genericSignature.returnType, substitutions, classLookupByInstanceHash)
            });
        }
    }

    return Array.from(definitions.values()).sort((left, right) => left.concreteName.localeCompare(right.concreteName));
}

function buildInstalledConcreteGlobalDefinitions(
    libraries: readonly LoadedPrecompiledLibrary[],
    classLookupByInstanceHash: ReadonlyMap<string, string>
): readonly InstalledPrecompiledConcreteGlobalDefinition[] {
    const definitions = new Map<string, InstalledPrecompiledConcreteGlobalDefinition>();
    for (const library of libraries) {
        for (const signature of library.manifest.globalSignatures) {
            if (definitions.has(signature.canonicalName)) {
                continue;
            }
            definitions.set(signature.canonicalName, {
                canonicalName: signature.canonicalName,
                aliases: buildAliasList([signature.symbolName, signature.canonicalName, signature.exportedName]),
                type: instantiateConcreteSerializedType(signature.type, new Map<string, TypeValue>(), classLookupByInstanceHash)
            });
        }
    }
    return Array.from(definitions.values()).sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
}

export function getInstalledPrecompiledConcreteDefinitions(): InstalledPrecompiledConcreteDefinitions {
    const classLookupByInstanceHash = buildInstalledConcreteClassLookup(installedPrecompiledLibraries);
    return {
        classes: buildInstalledConcreteClassDefinitions(installedPrecompiledLibraries, classLookupByInstanceHash),
        functions: buildInstalledConcreteFunctionDefinitions(installedPrecompiledLibraries, classLookupByInstanceHash),
        globals: buildInstalledConcreteGlobalDefinitions(installedPrecompiledLibraries, classLookupByInstanceHash)
    };
}

function buildTypeEnv(typeParams: readonly string[]): GenericTypeEnv {
    const env = new GenericTypeEnv();
    for (const typeParam of typeParams) {
        env.set(typeParam, new TypeParameterValue(typeParam));
    }
    return env;
}

function serializeTypeAst(typeAst: AstNode, typeParams: readonly string[] = []): SerializedTypeValue {
    return serializeTypeValue(astToTypeValue(typeAst, buildTypeEnv(typeParams)));
}

function serializeBindingFromTypeAst(bind: TypeVarBindNode, typeParams: readonly string[] = []): SerializedBinding {
    return {
        name: bind.var.name,
        type: serializeTypeAst(bind.typeExp, typeParams)
    };
}

function serializeMethodSignature(method: ClassMethodNode, typeParams: readonly string[] = []): SerializedMethodSignature {
    return {
        name: method.methodName.name,
        params: method.params.map((param) => ({
            name: param.var.name,
            type: serializeTypeAst(param.typeExp, typeParams)
        })),
        returnType: serializeTypeAst(method.returnType, typeParams)
    };
}

function serializeConstructorSignature(ctor: ClassConstructorNode, typeParams: readonly string[] = []): SerializedConstructorSignature {
    return {
        params: ctor.params.map((param) => serializeBindingFromTypeAst(param, typeParams))
    };
}

function serializeClassSignature(info: ClassInfo): SerializedClassSignature {
    return {
        canonicalName: info.name,
        exportedName: info.exportedName,
        packageName: info.packageName,
        unitId: info.unitId,
        properties: info.properties.map((property) => serializeBindingFromTypeAst(property.bind)),
        methods: info.methods.map((method) => serializeMethodSignature(method)),
        constructors: info.constructors.map((ctor) => serializeConstructorSignature(ctor))
    };
}

function buildConcreteFunctionSymbol(info: FunctionInfo): string {
    if (info.isDeclared) {
        return info.exportedName;
    }
    const functionType = new FunctionTypeValue(
        info.paramTypes.map((param) => astToTypeValue(param.typeExp)),
        astToTypeValue(info.returnType)
    );
    const overloads = getResolvedFunctionOverloads(info.name);
    return overloads.length <= 1
        ? info.name
        : `__iw_overload_${info.exportedName}_${hashText(functionType.hash())}`;
}

function serializeFunctionSignature(info: FunctionInfo): SerializedFunctionSignature {
    return {
        canonicalName: info.name,
        concreteSymbol: buildConcreteFunctionSymbol(info),
        exportedName: info.exportedName,
        packageName: info.packageName,
        unitId: info.unitId,
        params: info.paramTypes.map((param) => serializeBindingFromTypeAst(param)),
        returnType: serializeTypeValue(astToTypeValue(info.returnType)),
        isDeclared: info.isDeclared
    };
}

function serializeGlobalSignature(info: GlobalVarInfo): SerializedGlobalSignature {
    return {
        canonicalName: info.name,
        symbolName: info.name,
        exportedName: info.exportedName,
        packageName: info.packageName,
        unitId: info.unitId,
        type: serializeBindingFromTypeAst(info.bind).type
    };
}

function serializeGenericClassSignature(info: GenericClassInfo): SerializedGenericClassSignature {
    return {
        canonicalName: info.name,
        fullName: info.genericName,
        exportedName: info.exportedName,
        packageName: info.packageName,
        unitId: info.unitId,
        typeParams: [...info.typeParams],
        properties: info.properties.map((property) => serializeBindingFromTypeAst(property.bind, info.typeParams)),
        methods: info.methods.map((method) => serializeMethodSignature(method, info.typeParams)),
        constructors: info.constructors.map((ctor) => serializeConstructorSignature(ctor, info.typeParams))
    };
}

function serializeGenericFunctionSignature(info: GenericFunctionInfo): SerializedGenericFunctionSignature {
    return {
        canonicalName: info.name,
        fullName: info.genericName,
        exportedName: info.exportedName,
        packageName: info.packageName,
        unitId: info.unitId,
        typeParams: [...info.typeParams],
        params: info.paramTypes.map((param) => serializeBindingFromTypeAst(param, info.typeParams)),
        returnType: serializeTypeAst(info.returnType, info.typeParams)
    };
}

function serializeMonomorphizedClassRecord(info: MonomorphizedClassInfo): SerializedMonomorphizedClassRecord {
    const separatorIndex = info.sourceGenericName.lastIndexOf("@");
    return {
        instanceHash: info.instanceHash,
        sourceGenericName: info.sourceGenericName,
        concreteName: info.concreteName,
        packageName: separatorIndex > 0 ? info.sourceGenericName.slice(0, separatorIndex) : null,
        unitId: getGenericClassInfo(info.sourceGenericName)?.unitId ?? getCompilationUnitMetadata(info.classNode)?.unitId ?? null,
        typeArgs: info.typeArgs.map((typeArg) => serializeTypeValue(typeArg))
    };
}

function serializeMonomorphizedFunctionRecord(info: MonomorphizedFunctionInfo): SerializedMonomorphizedFunctionRecord {
    const separatorIndex = info.sourceGenericName.lastIndexOf("@");
    return {
        instanceHash: info.instanceHash,
        sourceGenericName: info.sourceGenericName,
        concreteName: info.concreteName,
        packageName: separatorIndex > 0 ? info.sourceGenericName.slice(0, separatorIndex) : null,
        unitId: getGenericFunctionInfo(info.sourceGenericName)?.unitId ?? getCompilationUnitMetadata(info.functionNode)?.unitId ?? null,
        typeArgs: info.typeArgs.map((typeArg) => serializeTypeValue(typeArg))
    };
}

function isPathOwnedByInputPath(inputPath: string, filePath: string | null): boolean {
    if (filePath === null) {
        return false;
    }
    const resolvedInputPath = resolve(inputPath);
    if (statSync(resolvedInputPath).isFile()) {
        return resolve(filePath) === resolvedInputPath;
    }
    const rel = relative(resolvedInputPath, resolve(filePath));
    return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function collectIncludedPackageNames(programAst: ProgramNode, inputPath: string): ReadonlySet<string> {
    const packageNames = new Set<string>();
    for (const expression of programAst.topLevelExpressions) {
        const metadata = getCompilationUnitMetadata(expression);
        if (metadata === undefined || !isPathOwnedByInputPath(inputPath, metadata.filePath)) {
            continue;
        }
        packageNames.add(metadata.packageName);
    }
    return packageNames;
}

function symbolSafeSuffix(text: string): string {
    return text.replace(/[^A-Za-z0-9_]/g, "_");
}

function buildUnitAssemblyPath(unitId: string): string {
    return `${PRECOMPILED_LIB_ASSEMBLY_ROOT}/${unitId}.s`;
}

function buildUnitSupportPath(unitId: string): string {
    return `${PRECOMPILED_LIB_SUPPORT_ROOT}/${unitId}.c`;
}

export function buildPrecompiledMetadataTableExportSymbol(unitId: string): string {
    return `iw_gc_export_metadata_table_${symbolSafeSuffix(unitId)}_${hashText(unitId).slice(0, 12)}`;
}

export function buildPrecompiledGlobalTableExportSymbol(unitId: string): string {
    return `iw_gc_export_global_table_${symbolSafeSuffix(unitId)}_${hashText(unitId).slice(0, 12)}`;
}

export function buildPrecompiledRuntimeInitExportSymbol(unitId: string): string {
    return `iw_precompiled_unit_init_${symbolSafeSuffix(unitId)}_${hashText(unitId).slice(0, 12)}`;
}

function buildManifest(
    target: BuildTarget,
    includedPackageNames: ReadonlySet<string>,
    compiledUnits: readonly PrecompiledLibraryUnitManifestEntry[]
): PrecompiledLibraryManifest {
    return {
        format: "iw-precompiled-lib",
        version: 2,
        target,
        compiledUnits,
        classSignatures: Array.from(getAllClassInfos())
            .filter((info) => info.packageName !== null && includedPackageNames.has(info.packageName))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((info) => serializeClassSignature(info)),
        functionSignatures: Array.from(getAllFunctionInfos())
            .filter((info) => info.packageName !== null && includedPackageNames.has(info.packageName))
            .sort((left, right) => left.name.localeCompare(right.name) || left.paramTypes.length - right.paramTypes.length)
            .map((info) => serializeFunctionSignature(info)),
        globalSignatures: Array.from(getAllGlobalVarInfos())
            .filter((info) => info.packageName !== null && includedPackageNames.has(info.packageName))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((info) => serializeGlobalSignature(info)),
        genericClassSignatures: Array.from(getAllGenericClassInfos())
            .filter((info) => info.packageName !== null && includedPackageNames.has(info.packageName))
            .sort((left, right) => left.genericName.localeCompare(right.genericName) || left.typeParams.length - right.typeParams.length)
            .map((info) => serializeGenericClassSignature(info)),
        genericFunctionSignatures: Array.from(getAllGenericFunctionInfos())
            .filter((info) => info.packageName !== null && includedPackageNames.has(info.packageName))
            .sort((left, right) => left.genericName.localeCompare(right.genericName) || left.typeParams.length - right.typeParams.length)
            .map((info) => serializeGenericFunctionSignature(info)),
        monomorphizedClasses: [],
        monomorphizedFunctions: []
    };
}

function buildStrippedProgramUnit(expressions: readonly AstNode[], unitId: string): ProgramNode {
    return new ProgramNode([...expressions], new IdentifierNode(unitId));
}

function buildConcreteProgramUnits(programAst: ProgramNode, inputPath: string): Map<string, ProgramNode> {
    const units = new Map<string, AstNode[]>();
    for (const expression of programAst.topLevelExpressions) {
        const metadata = getCompilationUnitMetadata(expression);
        if (metadata === undefined || !isPathOwnedByInputPath(inputPath, metadata.filePath)) {
            continue;
        }
        const existing = units.get(metadata.unitId) ?? [];
        if (expression instanceof GenericClassNode || expression instanceof GenericDfunNode) {
            units.set(metadata.unitId, existing);
            continue;
        }
        existing.push(expression);
        units.set(metadata.unitId, existing);
    }

    return new Map(
        Array.from(units.entries()).map(([unitId, expressions]) => [unitId, buildStrippedProgramUnit(expressions, unitId)] as const)
    );
}

function extractPackageName(canonicalName: string): string | null {
    const separatorIndex = canonicalName.lastIndexOf("@");
    if (separatorIndex <= 0) {
        return null;
    }
    return canonicalName.slice(0, separatorIndex);
}

function appendUnitExpression(unitMap: Map<string, AstNode[]>, unitId: string, expression: AstNode): void {
    const existing = unitMap.get(unitId) ?? [];
    existing.push(expression);
    unitMap.set(unitId, existing);
}

function appendMonomorphizedDefinitionsToUnits(
    units: Map<string, ProgramNode>,
    classes: readonly MonomorphizedClassInfo[],
    functions: readonly MonomorphizedFunctionInfo[]
): void {
    const groupedByUnit = new Map<string, AstNode[]>();
    for (const info of classes) {
        const packageName = extractPackageName(info.sourceGenericName);
        const unitId = getGenericClassInfo(info.sourceGenericName)?.unitId
            ?? getCompilationUnitMetadata(info.classNode)?.unitId
            ?? (packageName === null ? null : buildSyntheticUnitId(packageName));
        if (unitId !== null) {
            appendUnitExpression(groupedByUnit, unitId, info.classNode);
        }
    }
    for (const info of functions) {
        const packageName = extractPackageName(info.sourceGenericName);
        const unitId = getGenericFunctionInfo(info.sourceGenericName)?.unitId
            ?? getCompilationUnitMetadata(info.functionNode)?.unitId
            ?? (packageName === null ? null : buildSyntheticUnitId(packageName));
        if (unitId !== null) {
            appendUnitExpression(groupedByUnit, unitId, info.functionNode);
        }
    }

    for (const [unitId, expressions] of groupedByUnit.entries()) {
        const existing = units.get(unitId);
        if (existing === undefined) {
            units.set(unitId, new ProgramNode(expressions, new IdentifierNode(unitId)));
            continue;
        }
        units.set(unitId, new ProgramNode([...existing.topLevelExpressions, ...expressions], new IdentifierNode(unitId)));
    }
}

export function buildPrecompiledLibraryPackagingPlan(
    inputPath: string,
    programAst: ProgramNode,
    monomorphizedClasses: readonly MonomorphizedClassInfo[],
    monomorphizedFunctions: readonly MonomorphizedFunctionInfo[],
    target: BuildTarget = defaultBuildTarget
): PrecompiledLibraryPackagingPlan {
    const includedPackageNames = collectIncludedPackageNames(programAst, inputPath);
    const filteredMonomorphizedClasses = monomorphizedClasses.filter((info) => {
        const packageName = extractPackageName(info.sourceGenericName);
        return packageName !== null && includedPackageNames.has(packageName);
    });
    const filteredMonomorphizedFunctions = monomorphizedFunctions.filter((info) => {
        const packageName = extractPackageName(info.sourceGenericName);
        return packageName !== null && includedPackageNames.has(packageName);
    });
    const compilationUnits = buildConcreteProgramUnits(programAst, inputPath);
    appendMonomorphizedDefinitionsToUnits(compilationUnits, filteredMonomorphizedClasses, filteredMonomorphizedFunctions);
    const compiledUnits = Array.from(compilationUnits.keys())
        .sort((left, right) => left.localeCompare(right))
        .map((unitId) => ({
            unitId,
            assemblyPath: buildUnitAssemblyPath(unitId),
            supportPath: buildUnitSupportPath(unitId),
            metadataTableExportSymbol: buildPrecompiledMetadataTableExportSymbol(unitId),
            globalTableExportSymbol: buildPrecompiledGlobalTableExportSymbol(unitId),
            runtimeInitExportSymbol: buildPrecompiledRuntimeInitExportSymbol(unitId)
        }));
    return {
        manifest: {
            ...buildManifest(target, includedPackageNames, compiledUnits),
            monomorphizedClasses: filteredMonomorphizedClasses.map((info) => serializeMonomorphizedClassRecord(info)),
            monomorphizedFunctions: filteredMonomorphizedFunctions.map((info) => serializeMonomorphizedFunctionRecord(info))
        },
        compilationUnits
    };
}

export function createPrecompiledLibraryArchive(
    archivePath: string,
    manifest: PrecompiledLibraryManifest,
    compiledUnits: readonly PrecompiledLibraryCompiledUnitArtifact[]
): void {
    const stagingDir = mkdtempSync(join(tmpdir(), "ironwall-pack-lib-"));
    try {
        const buildInfoByUnitId = new Map(compiledUnits.map((artifact) => [artifact.unitId, artifact.buildInfo] as const));
        for (const artifact of compiledUnits) {
            const manifestUnit = manifest.compiledUnits.find((entry) => entry.unitId === artifact.unitId);
            if (manifestUnit === undefined) {
                throw new Error(`Missing manifest entry for compiled unit '${artifact.unitId}'`);
            }
            const assemblyPath = join(stagingDir, manifestUnit.assemblyPath);
            const supportPath = join(stagingDir, manifestUnit.supportPath);
            mkdirSync(resolve(assemblyPath, ".."), { recursive: true });
            mkdirSync(resolve(supportPath, ".."), { recursive: true });
            writeFileSync(assemblyPath, artifact.assemblyText, "utf8");
            writeFileSync(supportPath, artifact.supportText, "utf8");
        }
        const archiveManifest: PrecompiledLibraryManifest = {
            ...manifest,
            compiledUnits: manifest.compiledUnits.map((entry) => ({
                ...entry,
                buildInfo: buildInfoByUnitId.get(entry.unitId) ?? entry.buildInfo
            }))
        };
        writeFileSync(join(stagingDir, PRECOMPILED_LIB_MANIFEST_FILE), `${JSON.stringify(archiveManifest, null, 2)}\n`, "utf8");

        mkdirSync(resolve(archivePath, ".."), { recursive: true });
        execFileSync("tar", ["-czf", resolve(archivePath), "-C", stagingDir, "."], { stdio: "pipe" });
    } finally {
        rmSync(stagingDir, { recursive: true, force: true });
    }
}

export function loadPrecompiledLibraryArchives(archivePaths: readonly string[]): LoadedPrecompiledLibrary[] {
    return archivePaths.map((archivePath) => {
        const extractDir = mkdtempSync(join(tmpdir(), "ironwall-precompiled-lib-"));
        execFileSync("tar", ["-xzf", resolve(archivePath), "-C", extractDir], { stdio: "pipe" });
        const manifestPath = join(extractDir, PRECOMPILED_LIB_MANIFEST_FILE);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PrecompiledLibraryManifest;
        if (manifest.format !== "iw-precompiled-lib" || manifest.version !== 2) {
            throw new Error(`Unsupported precompiled library format in '${archivePath}'`);
        }
        return {
            archivePath: resolve(archivePath),
            extractDir,
            compiledUnits: manifest.compiledUnits.map((entry) => ({
                unitId: entry.unitId,
                assemblyPath: join(extractDir, entry.assemblyPath),
                supportPath: join(extractDir, entry.supportPath),
                metadataTableExportSymbol: entry.metadataTableExportSymbol,
                globalTableExportSymbol: entry.globalTableExportSymbol,
                runtimeInitExportSymbol: entry.runtimeInitExportSymbol
            })),
            manifest
        };
    });
}

export function disposeLoadedPrecompiledLibraries(libraries: readonly LoadedPrecompiledLibrary[]): void {
    for (const library of libraries) {
        rmSync(library.extractDir, { recursive: true, force: true });
    }
}

function buildBinding(binding: SerializedBinding): TypeVarBindNode {
    return new TypeVarBindNode(new IdentifierNode(binding.name), serializedTypeValueToAst(deserializeSerializedTypeValue(binding.type)));
}

function buildDummyMethod(signature: SerializedMethodSignature): ClassMethodNode {
    return new ClassMethodNode(
        new IdentifierNode(signature.name),
        signature.params.map((param) => buildBinding(param)),
        serializedTypeValueToAst(deserializeSerializedTypeValue(signature.returnType)),
        new IdentifierNode("unit")
    );
}

function buildDummyConstructor(signature: SerializedConstructorSignature): ClassConstructorNode {
    return new ClassConstructorNode(
        signature.params.map((param) => buildBinding(param)),
        new IdentifierNode("unit")
    );
}

function buildDummyProperty(binding: SerializedBinding): ClassPropertyNode {
    return new ClassPropertyNode(buildBinding(binding));
}

export function resetPrecompiledLibraryState(): void {
    precompiledGenericClassNames.clear();
    precompiledGenericFunctionNames.clear();
    precompiledClassLookupByInstanceHash.clear();
    precompiledFunctionLookupByInstanceHash.clear();
    installedPrecompiledLibraries.length = 0;
}

export function installPrecompiledLibraryTypecheckState(libraries: readonly LoadedPrecompiledLibrary[]): void {
    resetPrecompiledLibraryState();
    for (const library of libraries) {
        installedPrecompiledLibraries.push(library);
    }
    for (const library of libraries) {
        for (const signature of library.manifest.classSignatures) {
            registerClassInfo(new ClassInfo(
                signature.canonicalName,
                signature.constructors.map((ctor) => buildDummyConstructor(ctor)),
                signature.methods.map((method) => buildDummyMethod(method)),
                signature.properties.map((property) => buildDummyProperty(property)),
                signature.packageName,
                signature.unitId,
                signature.exportedName,
                library.archivePath
            ));
            registerPackageSymbol({
                kind: "class",
                exportedName: signature.exportedName,
                canonicalName: signature.canonicalName,
                packageName: signature.packageName,
                unitId: signature.unitId,
                filePath: library.archivePath
            });
        }

        for (const signature of library.manifest.functionSignatures) {
            registerFunctionInfo(new FunctionInfo(
                signature.canonicalName,
                signature.params.map((param) => buildBinding(param)),
                serializedTypeValueToAst(deserializeSerializedTypeValue(signature.returnType)),
                signature.isDeclared,
                signature.packageName,
                signature.unitId,
                signature.exportedName,
                null,
                library.archivePath
            ));
            registerPackageSymbol({
                kind: "function",
                exportedName: signature.exportedName,
                canonicalName: signature.canonicalName,
                packageName: signature.packageName,
                unitId: signature.unitId,
                filePath: library.archivePath
            });
        }

        for (const signature of library.manifest.globalSignatures) {
            registerGlobalVarInfo(new GlobalVarInfo(
                signature.canonicalName,
                buildBinding({
                    name: signature.exportedName,
                    type: signature.type
                }),
                new IdentifierNode("unit"),
                signature.packageName,
                signature.unitId,
                signature.exportedName,
                library.archivePath
            ));
            registerPackageSymbol({
                kind: "global",
                exportedName: signature.exportedName,
                canonicalName: signature.canonicalName,
                packageName: signature.packageName,
                unitId: signature.unitId,
                filePath: library.archivePath
            });
        }

        for (const signature of library.manifest.genericClassSignatures) {
            registerGenericClassInfo(new GenericClassInfo(
                signature.canonicalName,
                signature.fullName,
                [...signature.typeParams],
                signature.constructors.map((ctor) => buildDummyConstructor(ctor)),
                signature.methods.map((method) => buildDummyMethod(method)),
                signature.properties.map((property) => buildDummyProperty(property)),
                signature.packageName,
                signature.unitId,
                signature.exportedName,
                library.archivePath
            ));
            registerPackageSymbol({
                kind: "generic_class",
                exportedName: signature.exportedName,
                canonicalName: signature.canonicalName,
                genericArity: signature.typeParams.length,
                packageName: signature.packageName,
                unitId: signature.unitId,
                filePath: library.archivePath
            });
            precompiledGenericClassNames.add(signature.fullName);
        }

        for (const signature of library.manifest.genericFunctionSignatures) {
            registerGenericFunctionInfo(new GenericFunctionInfo(
                signature.canonicalName,
                signature.fullName,
                [...signature.typeParams],
                signature.params.map((param) => buildBinding(param)),
                serializedTypeValueToAst(deserializeSerializedTypeValue(signature.returnType)),
                new IdentifierNode("unit"),
                signature.packageName,
                signature.unitId,
                signature.exportedName,
                library.archivePath
            ));
            registerPackageSymbol({
                kind: "generic_function",
                exportedName: signature.exportedName,
                canonicalName: signature.canonicalName,
                genericArity: signature.typeParams.length,
                packageName: signature.packageName,
                unitId: signature.unitId,
                filePath: library.archivePath
            });
            precompiledGenericFunctionNames.add(signature.fullName);
        }

        for (const record of library.manifest.monomorphizedClasses) {
            precompiledClassLookupByInstanceHash.set(record.instanceHash, {
                concreteName: record.concreteName,
                archivePath: library.archivePath
            });
        }
        for (const record of library.manifest.monomorphizedFunctions) {
            precompiledFunctionLookupByInstanceHash.set(record.instanceHash, {
                concreteName: record.concreteName,
                archivePath: library.archivePath
            });
        }
    }
}

export function isPrecompiledGenericClassName(name: string): boolean {
    return precompiledGenericClassNames.has(name);
}

export function isPrecompiledGenericFunctionName(name: string): boolean {
    return precompiledGenericFunctionNames.has(name);
}

export function lookupPrecompiledClassMonomorph(instanceHash: string): PrecompiledMonomorphLookupRecord | undefined {
    return precompiledClassLookupByInstanceHash.get(instanceHash);
}

export function lookupPrecompiledFunctionMonomorph(instanceHash: string): PrecompiledMonomorphLookupRecord | undefined {
    return precompiledFunctionLookupByInstanceHash.get(instanceHash);
}
