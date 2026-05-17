import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    ClassNode,
    ClassPropertyNode,
    DeclaredDfunNode,
    DfunNode,
    DvarNode,
    GenericClassNode,
    GenericDfunNode,
    IdentifierNode,
    ImportNode,
    ProgramNode,
    SeqNode,
    SetNode,
    TypeVarBindNode
} from "./AstNode";
import { ensureProgramCompilationUnitMetadata, getCompilationUnitMetadata } from "./ModuleMetadata";
import {
    ClassTypeValue,
    FunctionTypeValue,
    UnionTypeValue,
    getGenericClassInfo,
    getGenericFunctionInfo,
    getClassTypeId,
    getRuntimeTypeId,
    getUnionTypeId,
    substituteTypeVariables,
    type TypeValue
} from "./Typecheck-Core";
import { hashText } from "./Typecheck-Core";
import { getResolvedFunctionOverloads } from "./Typecheck-Pass-2-ResolveHeaders";
import { computeReachableModuleGlobals, getModuleGlobalInitPlan } from "./ModuleGlobalInit";
import type {
    MonomorphizedArtifacts,
    MonomorphizedClassInfo,
    MonomorphizedFunctionInfo
} from "./Typecheck-Pipeline";
import { astToTypeValue } from "./Typecheck-Pipeline";
import {
    deserializeSerializedTypeValue,
    serializedTypeValueToAst,
    type PrecompiledLibrarySnapshotSource,
    type SerializedBinding,
    type SerializedConstructorSignature,
    type SerializedMethodSignature,
} from "./PrecompiledLib";
import { relative } from "path";
import { parseExportedIwFunctionName } from "./DeclaredCFunctionName";
import type {
    LoweringGlobalDefinition,
    LoweringSnapshotClassDefinition,
    LoweringSnapshotDeclaredFunction,
    LoweringExportedIwFunction,
    LoweringSnapshotFunctionDefinition,
    LoweringSnapshotProgram,
    LoweringUnionMetadata
} from "./Lowering-Frontend-Shared";

const LOWERED_METHOD_PREFIX = "__iw_lowered_method";
const LOWERED_CONSTRUCTOR_PREFIX = "__iw_lowered_ctor";

export interface LoweringSnapshotOptions {
    readonly disableBaseLibAutoLoad?: boolean;
    readonly entryUnitId?: string;
    readonly requireEntryPoint?: boolean;
    readonly precompiledLibraries?: readonly PrecompiledLibrarySnapshotSource[];
}

function buildMethodSymbol(className: string, methodName: string): string {
    return `${LOWERED_METHOD_PREFIX}_${className}_${methodName}`;
}

function buildConstructorSymbol(className: string, overloadIndex: number): string {
    return `${LOWERED_CONSTRUCTOR_PREFIX}_${className}_${overloadIndex}`;
}

function flattenTopLevelNodes(ast: AstNode): AstNode[] {
    if (ast instanceof ProgramNode) {
        return [...ast.topLevelExpressions];
    }
    if (ast instanceof SeqNode) {
        const flattened: AstNode[] = [];
        for (const expression of ast.expressions) {
            flattened.push(...flattenTopLevelNodes(expression));
        }
        return flattened;
    }

    return [ast];
}

function collectOwnedUnitIds(topLevelNodes: readonly AstNode[]): ReadonlySet<string> {
    const unitIds = new Set<string>();
    for (const node of topLevelNodes) {
        const metadata = getCompilationUnitMetadata(node);
        if (metadata !== undefined) {
            unitIds.add(metadata.unitId);
        }
    }
    return unitIds;
}

function isDefinitionNode(node: AstNode): boolean {
    return node instanceof ClassNode
        || node instanceof GenericClassNode
        || node instanceof DfunNode
        || node instanceof DeclaredDfunNode
        || node instanceof GenericDfunNode;
}

function isNonExecutableTopLevelNode(node: AstNode): boolean {
    return isDefinitionNode(node) || node instanceof ImportNode;
}

function isMonomorphizedDefinitionName(name: string): boolean {
    return name.startsWith("__iw_mono_") || name.includes("@__iw_mono_");
}

function buildConcreteClassFromMonomorphized(info: MonomorphizedClassInfo): LoweringSnapshotClassDefinition {
    return {
        concreteName: info.concreteName,
        runtimeTypeTagId: getClassTypeId(info.concreteName),
        classNode: info.classNode,
        propertyTypes: info.propertyTypes,
        methodTypes: info.methodTypes,
        constructorParamTypes: info.constructorParamTypes,
        sourceName: info.sourceGenericName,
        instanceHash: info.instanceHash,
        unitId: getMonomorphizedClassOwnerUnitId(info)
    };
}

function buildConcreteFunctionFromMonomorphized(info: MonomorphizedFunctionInfo): LoweringSnapshotFunctionDefinition {
    return {
        concreteName: info.concreteName,
        functionNode: info.functionNode,
        functionType: info.functionType,
        sourceName: info.sourceGenericName,
        instanceHash: info.instanceHash,
        unitId: getMonomorphizedFunctionOwnerUnitId(info)
    };
}

function getMonomorphizedClassOwnerUnitId(info: MonomorphizedClassInfo): string | null {
    return getGenericClassInfo(info.sourceGenericName)?.unitId ?? getCompilationUnitMetadata(info.classNode)?.unitId ?? null;
}

function getMonomorphizedFunctionOwnerUnitId(info: MonomorphizedFunctionInfo): string | null {
    return getGenericFunctionInfo(info.sourceGenericName)?.unitId ?? getCompilationUnitMetadata(info.functionNode)?.unitId ?? null;
}

function buildConcreteClassFromSource(node: ClassNode): LoweringSnapshotClassDefinition {
    const canonicalName = getCanonicalSourceName(node, node.name.name);
    const metadata = getCompilationUnitMetadata(node);
    const propertyTypes = new Map<string, TypeValue>(
        node.propertyNodeList.map((property) => [property.bind.var.name, astToTypeValue(property.bind.typeExp)])
    );
    const methodTypes = new Map<string, FunctionTypeValue>(
        node.methodNodeList.map((method) => [
            method.methodName.name,
            new FunctionTypeValue(
                method.params.map((param) => astToTypeValue(param.typeExp)),
                astToTypeValue(method.returnType)
            )
        ])
    );
    return {
        concreteName: canonicalName,
        runtimeTypeTagId: getClassTypeId(canonicalName),
        classNode: node,
        propertyTypes,
        methodTypes,
        constructorParamTypes: node.constructorNodeList.map((ctor) => ctor.params.map((param) => astToTypeValue(param.typeExp))),
        sourceName: canonicalName,
        unitId: metadata?.unitId ?? null
    };
}

function collectUnionMetadataFromType(type: TypeValue, sink: Map<string, LoweringUnionMetadata>): void {
    if (type instanceof UnionTypeValue) {
        const unionTypeTagId = getUnionTypeId(type);
        sink.set(unionTypeTagId, {
            unionTypeTagId,
            members: type.types.map((member) => ({ runtimeTypeTagId: getRuntimeTypeId(member) }))
        });
        for (const member of type.types) {
            collectUnionMetadataFromType(member, sink);
        }
        return;
    }

    if (type instanceof FunctionTypeValue) {
        for (const paramType of type.paramTypes) {
            collectUnionMetadataFromType(paramType, sink);
        }
        collectUnionMetadataFromType(type.returnType, sink);
        return;
    }

    if ("typeArgs" in type && Array.isArray(type.typeArgs)) {
        for (const typeArg of type.typeArgs) {
            collectUnionMetadataFromType(typeArg, sink);
        }
    }
}

function collectReferencedUnionMetadata(
    classes: readonly LoweringSnapshotClassDefinition[],
    functions: readonly LoweringSnapshotFunctionDefinition[],
    declaredFunctions: readonly LoweringSnapshotDeclaredFunction[]
): readonly LoweringUnionMetadata[] {
    const unionMetadata = new Map<string, LoweringUnionMetadata>();

    for (const classDef of classes) {
        for (const propertyType of classDef.propertyTypes.values()) {
            collectUnionMetadataFromType(propertyType, unionMetadata);
        }
        for (const methodType of classDef.methodTypes.values()) {
            collectUnionMetadataFromType(methodType, unionMetadata);
        }
        for (const constructorParamTypes of classDef.constructorParamTypes) {
            for (const constructorParamType of constructorParamTypes) {
                collectUnionMetadataFromType(constructorParamType, unionMetadata);
            }
        }
    }

    for (const fn of functions) {
        collectUnionMetadataFromType(fn.functionType, unionMetadata);
    }

    for (const fn of declaredFunctions) {
        collectUnionMetadataFromType(fn.functionType, unionMetadata);
    }

    return Array.from(unionMetadata.values()).sort((left, right) => left.unionTypeTagId.localeCompare(right.unionTypeTagId));
}

function buildConcreteFunctionFromSource(node: DfunNode): LoweringSnapshotFunctionDefinition {
    const canonicalName = getCanonicalSourceName(node, node.name.name);
    const metadata = getCompilationUnitMetadata(node);
    const functionType = new FunctionTypeValue(
        node.params.map((param) => astToTypeValue(param.typeExp)),
        astToTypeValue(node.returnType)
    );
    const overloads = getResolvedFunctionOverloads(canonicalName);
    const concreteName = overloads.length <= 1
        ? canonicalName
        : `__iw_overload_${node.name.name}_${hashText(functionType.hash())}`;
    return {
        concreteName,
        functionNode: node,
        functionType,
        sourceName: canonicalName,
        unitId: metadata?.unitId ?? null
    };
}

function buildDeclaredFunctionFromSource(node: DeclaredDfunNode): LoweringSnapshotDeclaredFunction {
    const canonicalName = getCanonicalSourceName(node, node.name.name);
    const metadata = getCompilationUnitMetadata(node);
    return {
        symbol: getExportedSourceName(node, node.name.name),
        paramNames: node.params.map((param) => param.var.name),
        functionType: new FunctionTypeValue(
            node.params.map((param) => astToTypeValue(param.typeExp)),
            astToTypeValue(node.returnType)
        ),
        sourceName: canonicalName,
        callingConvention: "c_ffi",
        unitId: metadata?.unitId ?? null
    };
}

function getCanonicalSourceName(node: AstNode, exportedName: string): string {
    const metadata = getCompilationUnitMetadata(node);
    if (metadata === undefined) {
        return exportedName;
    }
    if (exportedName === metadata.unitId || exportedName.includes("@") || exportedName.startsWith("__iw_mono_")) {
        return exportedName;
    }
    if (exportedName === "main") {
        return metadata.unitId;
    }
    return `${metadata.packageName}@${exportedName}`;
}

function getExportedSourceName(node: AstNode, resolvedName: string): string {
    const metadata = getCompilationUnitMetadata(node);
    if (metadata === undefined) {
        return resolvedName;
    }
    if (resolvedName === metadata.unitId) {
        return "main";
    }
    const packagePrefix = `${metadata.packageName}@`;
    if (resolvedName.startsWith(packagePrefix)) {
        return resolvedName.slice(packagePrefix.length);
    }
    return resolvedName;
}

function ensureUniqueNames<T extends { readonly concreteName: string }>(items: readonly T[], label: string): void {
    const seen = new Set<string>();
    for (const item of items) {
        if (seen.has(item.concreteName)) {
            throw new Error(`Pass 0 snapshot validation failed: duplicate ${label} '${item.concreteName}'`);
        }
        seen.add(item.concreteName);
    }
}

function formatDiagnosticPath(filePath: string | null): string {
    if (filePath === null) {
        return "<unknown file>";
    }
    const relativePath = relative(process.cwd(), filePath);
    return relativePath.length === 0 ? filePath : relativePath;
}

function collectKnownUnits(functions: readonly { readonly functionNode: DfunNode }[]): Map<string, string | null> {
    const knownUnits = new Map<string, string | null>();
    for (const { functionNode } of functions) {
        const metadata = getCompilationUnitMetadata(functionNode);
        if (metadata === undefined) {
            continue;
        }
        if (!knownUnits.has(metadata.unitId)) {
            knownUnits.set(metadata.unitId, metadata.filePath);
        }
    }
    return knownUnits;
}

function formatUnitDiagnostic(unitId: string, filePath: string | null): string {
    return `${unitId} (${formatDiagnosticPath(filePath)})`;
}

function selectEntryFunction(
    functions: readonly { readonly functionNode: DfunNode }[],
    options?: LoweringSnapshotOptions
): DfunNode | null {
    function isTopLevelMainFunction(functionNode: DfunNode): boolean {
        if (functionNode.name.name === "main") {
            return true;
        }
        const metadata = getCompilationUnitMetadata(functionNode);
        return metadata !== undefined && functionNode.name.name === metadata.unitId;
    }
    const mainFunctions = functions.filter((fn) => isTopLevelMainFunction(fn.functionNode));
    const knownUnits = collectKnownUnits(functions);
    if (mainFunctions.length === 0) {
        return null;
    }

    if (options?.entryUnitId !== undefined) {
        const matchedEntry = mainFunctions.find((fn) => getCompilationUnitMetadata(fn.functionNode)?.unitId === options.entryUnitId);
        if (matchedEntry === undefined) {
            const knownUnitPath = knownUnits.get(options.entryUnitId);
            const availableEntries = mainFunctions
                .map((fn) => getCompilationUnitMetadata(fn.functionNode))
                .filter((metadata): metadata is NonNullable<typeof metadata> => metadata !== undefined)
                .map((metadata) => formatUnitDiagnostic(metadata.unitId, metadata.filePath))
                .sort()
                .join(", ");
            if (knownUnitPath !== undefined) {
                throw new Error(`Entry unit '${options.entryUnitId}' does not define a top-level main function (unit file: ${formatDiagnosticPath(knownUnitPath)}). Available entry units: ${availableEntries}`);
            }
            const knownUnitsLabel = Array.from(knownUnits.entries())
                .map(([unitId, filePath]) => formatUnitDiagnostic(unitId, filePath))
                .sort()
                .join(", ");
            throw new Error(`Entry unit '${options.entryUnitId}' does not define a top-level main function because no compilation unit with that id was found. Known units: ${knownUnitsLabel}. Available entry units: ${availableEntries}`);
        }
        return matchedEntry.functionNode;
    }

    if (mainFunctions.length === 1) {
        return mainFunctions[0].functionNode;
    }

    const unitIds = mainFunctions
        .map((fn) => getCompilationUnitMetadata(fn.functionNode))
        .filter((metadata): metadata is NonNullable<typeof metadata> => metadata !== undefined)
        .map((metadata) => formatUnitDiagnostic(metadata.unitId, metadata.filePath))
        .sort();
    throw new Error(`Multiple entry units define main: ${unitIds.join(", ")}. Use --entry <unit-id>.`);
}

function instantiateSerializedType(type: import("./PrecompiledLib").SerializedTypeValue, substitutions: ReadonlyMap<string, TypeValue>): TypeValue {
    return substituteTypeVariables(deserializeSerializedTypeValue(type), new Map(substitutions));
}

function instantiateBinding(binding: SerializedBinding, substitutions: ReadonlyMap<string, TypeValue>): TypeVarBindNode {
    return new TypeVarBindNode(new IdentifierNode(binding.name), serializedTypeValueToAst(instantiateSerializedType(binding.type, substitutions)));
}

function buildPropertyNode(binding: SerializedBinding, substitutions: ReadonlyMap<string, TypeValue>): ClassPropertyNode {
    return new ClassPropertyNode(instantiateBinding(binding, substitutions));
}

function buildMethodNode(signature: SerializedMethodSignature, substitutions: ReadonlyMap<string, TypeValue>): ClassMethodNode {
    return new ClassMethodNode(
        new IdentifierNode(signature.name),
        signature.params.map((param) => instantiateBinding(param, substitutions)),
        serializedTypeValueToAst(instantiateSerializedType(signature.returnType, substitutions)),
        new IdentifierNode("unit")
    );
}

function buildConstructorNode(signature: SerializedConstructorSignature, substitutions: ReadonlyMap<string, TypeValue>): ClassConstructorNode {
    return new ClassConstructorNode(
        signature.params.map((param) => instantiateBinding(param, substitutions)),
        new IdentifierNode("unit")
    );
}

function buildTypeSubstitution(typeParams: readonly string[], typeArgs: readonly import("./PrecompiledLib").SerializedTypeValue[]): ReadonlyMap<string, TypeValue> {
    const substitutions = new Map<string, TypeValue>();
    typeParams.forEach((typeParam, index) => {
        const typeArg = typeArgs[index];
        if (typeArg !== undefined) {
            substitutions.set(typeParam, deserializeSerializedTypeValue(typeArg));
        }
    });
    return substitutions;
}

function buildExternalClassDefinition(
    concreteName: string,
    sourceName: string,
    unitId: string | null,
    properties: readonly SerializedBinding[],
    methods: readonly SerializedMethodSignature[],
    constructors: readonly SerializedConstructorSignature[],
    substitutions: ReadonlyMap<string, TypeValue>,
    instanceHash?: string
): LoweringSnapshotClassDefinition {
    const propertyTypes = new Map<string, TypeValue>();
    const methodTypes = new Map<string, FunctionTypeValue>();
    const propertyNodes = properties.map((property) => {
        const type = instantiateSerializedType(property.type, substitutions);
        propertyTypes.set(property.name, type);
        return buildPropertyNode(property, substitutions);
    });
    const methodNodes = methods.map((method) => {
        const methodType = new FunctionTypeValue(
            method.params.map((param) => instantiateSerializedType(param.type, substitutions)),
            instantiateSerializedType(method.returnType, substitutions)
        );
        methodTypes.set(method.name, methodType);
        return buildMethodNode(method, substitutions);
    });
    const constructorNodes = constructors.map((ctor) => buildConstructorNode(ctor, substitutions));
    return {
        concreteName,
        runtimeTypeTagId: getClassTypeId(concreteName),
        classNode: new ClassNode(new IdentifierNode(concreteName), constructorNodes, methodNodes, propertyNodes),
        propertyTypes,
        methodTypes,
        constructorParamTypes: constructors.map((ctor) => ctor.params.map((param) => instantiateSerializedType(param.type, substitutions))),
        isExternal: true,
        sourceName,
        instanceHash,
        unitId
    };
}

function buildDeclaredFunction(
    symbol: string,
    sourceName: string,
    callingConvention: "c_ffi" | "iw_external",
    unitId: string | null,
    params: readonly SerializedBinding[],
    returnType: import("./PrecompiledLib").SerializedTypeValue,
    substitutions: ReadonlyMap<string, TypeValue>
): LoweringSnapshotDeclaredFunction {
    return {
        symbol,
        paramNames: params.map((param) => param.name),
        functionType: new FunctionTypeValue(
            params.map((param) => instantiateSerializedType(param.type, substitutions)),
            instantiateSerializedType(returnType, substitutions)
        ),
        sourceName,
        callingConvention,
        unitId
    };
}

function buildExternalClassDeclaredFunctions(
    className: string,
    unitId: string | null,
    methods: readonly SerializedMethodSignature[],
    constructors: readonly SerializedConstructorSignature[],
    substitutions: ReadonlyMap<string, TypeValue>
): readonly LoweringSnapshotDeclaredFunction[] {
    const selfType = new ClassTypeValue(className);
    const result: LoweringSnapshotDeclaredFunction[] = [];
    methods.forEach((method) => {
        result.push({
            symbol: buildMethodSymbol(className, method.name),
            paramNames: ["self", ...method.params.map((param) => param.name)],
            functionType: new FunctionTypeValue(
                [selfType, ...method.params.map((param) => instantiateSerializedType(param.type, substitutions))],
                instantiateSerializedType(method.returnType, substitutions)
            ),
            sourceName: buildMethodSymbol(className, method.name),
            callingConvention: "iw_external",
            unitId
        });
    });
    constructors.forEach((ctor, index) => {
        result.push({
            symbol: buildConstructorSymbol(className, index),
            paramNames: ["self", ...ctor.params.map((param) => param.name)],
            functionType: new FunctionTypeValue(
                [selfType, ...ctor.params.map((param) => instantiateSerializedType(param.type, substitutions))],
                selfType
            ),
            sourceName: buildConstructorSymbol(className, index),
            callingConvention: "iw_external",
            unitId
        });
    });
    return result;
}

function shouldIncludeExternalUnit(unitId: string | null, ownedUnitIds: ReadonlySet<string>): boolean {
    return unitId === null || !ownedUnitIds.has(unitId);
}

function buildExternalClassDefinitions(
    libraries: readonly PrecompiledLibrarySnapshotSource[],
    ownedUnitIds: ReadonlySet<string>
): readonly LoweringSnapshotClassDefinition[] {
    const classes = new Map<string, LoweringSnapshotClassDefinition>();
    for (const library of libraries) {
        const genericClassSignatures = new Map(library.manifest.genericClassSignatures.map((signature) => [signature.fullName, signature] as const));

        for (const signature of library.manifest.classSignatures) {
            if (!shouldIncludeExternalUnit(signature.unitId, ownedUnitIds)) {
                continue;
            }
            if (!classes.has(signature.canonicalName)) {
                classes.set(
                    signature.canonicalName,
                    buildExternalClassDefinition(
                        signature.canonicalName,
                        signature.canonicalName,
                        signature.unitId,
                        signature.properties,
                        signature.methods,
                        signature.constructors,
                        new Map()
                    )
                );
            }
        }

        for (const record of library.manifest.monomorphizedClasses) {
            if (!shouldIncludeExternalUnit(record.unitId, ownedUnitIds)) {
                continue;
            }
            const genericSignature = genericClassSignatures.get(record.sourceGenericName);
            if (genericSignature === undefined) {
                throw new Error(`precompiled lib is missing generic class signature for '${record.sourceGenericName}'`);
            }
            if (classes.has(record.concreteName)) {
                continue;
            }
            classes.set(
                record.concreteName,
                buildExternalClassDefinition(
                    record.concreteName,
                    record.sourceGenericName,
                    record.unitId,
                    genericSignature.properties,
                    genericSignature.methods,
                    genericSignature.constructors,
                    buildTypeSubstitution(genericSignature.typeParams, record.typeArgs),
                    record.instanceHash
                )
            );
        }
    }
    return Array.from(classes.values()).sort((left, right) => left.concreteName.localeCompare(right.concreteName));
}

function buildExternalDeclaredFunctions(
    libraries: readonly PrecompiledLibrarySnapshotSource[],
    ownedUnitIds: ReadonlySet<string>
): readonly LoweringSnapshotDeclaredFunction[] {
    const functions = new Map<string, LoweringSnapshotDeclaredFunction>();
    for (const library of libraries) {
        const genericClassSignatures = new Map(library.manifest.genericClassSignatures.map((signature) => [signature.fullName, signature] as const));
        const genericFunctionSignatures = new Map(library.manifest.genericFunctionSignatures.map((signature) => [signature.fullName, signature] as const));

        for (const signature of library.manifest.functionSignatures) {
            if (!shouldIncludeExternalUnit(signature.unitId, ownedUnitIds) || functions.has(signature.concreteSymbol)) {
                continue;
            }
            functions.set(
                signature.concreteSymbol,
                buildDeclaredFunction(
                    signature.concreteSymbol,
                    signature.canonicalName,
                    signature.isDeclared ? "c_ffi" : "iw_external",
                    signature.unitId,
                    signature.params,
                    signature.returnType,
                    new Map()
                )
            );
        }

        for (const signature of library.manifest.classSignatures) {
            if (!shouldIncludeExternalUnit(signature.unitId, ownedUnitIds)) {
                continue;
            }
            for (const declared of buildExternalClassDeclaredFunctions(signature.canonicalName, signature.unitId, signature.methods, signature.constructors, new Map())) {
                if (!functions.has(declared.symbol)) {
                    functions.set(declared.symbol, declared);
                }
            }
        }

        for (const record of library.manifest.monomorphizedFunctions) {
            if (!shouldIncludeExternalUnit(record.unitId, ownedUnitIds) || functions.has(record.concreteName)) {
                continue;
            }
            const genericSignature = genericFunctionSignatures.get(record.sourceGenericName);
            if (genericSignature === undefined) {
                throw new Error(`precompiled lib is missing generic function signature for '${record.sourceGenericName}'`);
            }
            functions.set(
                record.concreteName,
                buildDeclaredFunction(
                    record.concreteName,
                    record.concreteName,
                    "iw_external",
                    record.unitId,
                    genericSignature.params,
                    genericSignature.returnType,
                    buildTypeSubstitution(genericSignature.typeParams, record.typeArgs)
                )
            );
        }

        for (const record of library.manifest.monomorphizedClasses) {
            if (!shouldIncludeExternalUnit(record.unitId, ownedUnitIds)) {
                continue;
            }
            const genericSignature = genericClassSignatures.get(record.sourceGenericName);
            if (genericSignature === undefined) {
                throw new Error(`precompiled lib is missing generic class signature for '${record.sourceGenericName}'`);
            }
            const substitutions = buildTypeSubstitution(genericSignature.typeParams, record.typeArgs);
            for (const declared of buildExternalClassDeclaredFunctions(record.concreteName, record.unitId, genericSignature.methods, genericSignature.constructors, substitutions)) {
                if (!functions.has(declared.symbol)) {
                    functions.set(declared.symbol, declared);
                }
            }
        }
    }
    return Array.from(functions.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function buildExternalGlobals(
    libraries: readonly PrecompiledLibrarySnapshotSource[],
    ownedUnitIds: ReadonlySet<string>
): readonly LoweringGlobalDefinition[] {
    const globals = new Map<string, LoweringGlobalDefinition>();
    for (const library of libraries) {
        for (const signature of library.manifest.globalSignatures) {
            if (!shouldIncludeExternalUnit(signature.unitId, ownedUnitIds) || globals.has(signature.symbolName)) {
                continue;
            }
            globals.set(signature.symbolName, {
                symbol: signature.symbolName,
                type: deserializeSerializedTypeValue(signature.type),
                isExternal: true,
                unitId: signature.unitId
            });
        }
    }
    return Array.from(globals.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export function validateLoweringSnapshotProgram(program: LoweringSnapshotProgram): void {
    if (program.kind !== "lowering_snapshot_program") {
        throw new Error("Pass 0 snapshot validation failed: unexpected program kind");
    }

    ensureUniqueNames(program.concreteClasses, "concrete class");
    ensureUniqueNames(program.concreteFunctions, "concrete function");
    ensureUniqueNames(program.declaredFunctions.map((declared) => ({ concreteName: declared.symbol })), "declared function");
    for (const statement of program.topLevelStatements) {
        if (isNonExecutableTopLevelNode(statement)) {
            throw new Error("Pass 0 snapshot validation failed: top-level executable statements must not contain definitions");
        }
    }
}

function collectExportedIwFunctions(functions: readonly LoweringSnapshotFunctionDefinition[]): readonly LoweringExportedIwFunction[] {
    return functions
        .flatMap((fn): readonly LoweringExportedIwFunction[] => {
            const exportedName = getExportedSourceName(fn.functionNode, fn.functionNode.name.name);
            const parsed = parseExportedIwFunctionName(exportedName);
            if (parsed === null) {
                return [];
            }
            return [{
                concreteSymbol: fn.concreteName,
                exportSymbol: parsed.fullName,
                paramTypes: fn.functionType.paramTypes,
                resultType: fn.functionType.returnType
            }];
        })
        .sort((left, right) => left.exportSymbol.localeCompare(right.exportSymbol));
}

export function createLoweringSnapshotProgram(ast: AstNode, artifacts: MonomorphizedArtifacts, options?: LoweringSnapshotOptions): LoweringSnapshotProgram {
    if (ast instanceof ProgramNode) {
        ensureProgramCompilationUnitMetadata(ast);
    }
    const normalizedAst = ast;
    const topLevelNodes = flattenTopLevelNodes(normalizedAst);
    const ownedUnitIds = collectOwnedUnitIds(topLevelNodes);
    const precompiledLibraries = options?.precompiledLibraries ?? [];
    const globalInitPlan = getModuleGlobalInitPlan();
    const sourceFunctionNodes = topLevelNodes.filter((node): node is DfunNode => node instanceof DfunNode && !isMonomorphizedDefinitionName(node.name.name));
    const explicitTopLevelStatements = topLevelNodes.filter((node) => {
        if (isNonExecutableTopLevelNode(node)) {
            return false;
        }
        if (node instanceof DvarNode && getCompilationUnitMetadata(node) !== undefined) {
            return false;
        }
        return getCompilationUnitMetadata(node) !== undefined;
    });
    const selectedEntryFunctionNode = selectEntryFunction(sourceFunctionNodes.map((functionNode) => ({ functionNode })), options);
    const selectedEntrySourceName = selectedEntryFunctionNode === null ? null : getCanonicalSourceName(selectedEntryFunctionNode, selectedEntryFunctionNode.name.name);
    const globalRootDefinitions = new Set<string>(sourceFunctionNodes.map((functionNode) => getCanonicalSourceName(functionNode, functionNode.name.name)));
    if (selectedEntrySourceName !== null) {
        globalRootDefinitions.add(selectedEntrySourceName);
    }
    const reachableGlobalSymbols = (globalRootDefinitions.size === 0
        ? globalInitPlan.initializationOrder
        : computeReachableModuleGlobals(Array.from(globalRootDefinitions.values())))
        .filter((symbol) => {
            const globalDef = globalInitPlan.globals.find((candidate) => candidate.symbol === symbol);
            return globalDef === undefined || globalDef.unitId === null || ownedUnitIds.has(globalDef.unitId);
        });
    const reachableGlobalSet = new Set(reachableGlobalSymbols);
    const internalGlobalDefs = globalInitPlan.globals.filter((globalDef) => {
        if (globalDef.unitId !== null && !ownedUnitIds.has(globalDef.unitId)) {
            return false;
        }
        return reachableGlobalSet.size === 0 || reachableGlobalSet.has(globalDef.symbol);
    });
    const internalGlobalDefsBySymbol = new Map(internalGlobalDefs.map((globalDef) => [globalDef.symbol, globalDef] as const));
    const orderedInternalGlobals = reachableGlobalSymbols
        .map((symbol) => internalGlobalDefsBySymbol.get(symbol))
        .filter((globalDef): globalDef is NonNullable<typeof globalDef> => globalDef !== undefined);
    const globalInitializersBySymbol = new Map(
        orderedInternalGlobals.map((globalDef) => [globalDef.symbol, new SetNode(new IdentifierNode(globalDef.symbol), globalDef.initializer)] as const)
    );
    const orderedGlobalInitializerStatements = orderedInternalGlobals
        .map((globalDef) => {
            const statement = globalInitializersBySymbol.get(globalDef.symbol);
            if (statement === undefined) {
                throw new Error(`Pass 0 snapshot failed: missing global initializer for '${globalDef.symbol}'`);
            }
            return statement;
        });
    if (options?.requireEntryPoint && selectedEntryFunctionNode === null && explicitTopLevelStatements.length === 0) {
        throw new Error("No entry point found. Define a top-level main function.");
    }
    const globals: LoweringGlobalDefinition[] = [
        ...internalGlobalDefs.map((globalDef) => ({
            symbol: globalDef.symbol,
            type: astToTypeValue(globalDef.bind.typeExp),
            isExternal: false,
            unitId: globalDef.unitId
        })),
        ...buildExternalGlobals(precompiledLibraries, ownedUnitIds)
    ];
    const sourceClasses = topLevelNodes
        .filter((node): node is ClassNode => node instanceof ClassNode && !isMonomorphizedDefinitionName(node.name.name))
        .map((node) => buildConcreteClassFromSource(node));
    const sourceFunctions = sourceFunctionNodes.map((node) => buildConcreteFunctionFromSource(node));
    const declaredFunctions = [
        ...topLevelNodes
            .filter((node): node is DeclaredDfunNode => node instanceof DeclaredDfunNode)
            .map((node) => buildDeclaredFunctionFromSource(node)),
        ...buildExternalDeclaredFunctions(precompiledLibraries, ownedUnitIds)
    ];
    const monomorphizedClasses = Array.from(artifacts.classes.values())
        .filter((info) => {
            const unitId = getMonomorphizedClassOwnerUnitId(info);
            return unitId === null || ownedUnitIds.has(unitId);
        })
        .sort((left, right) => left.concreteName.localeCompare(right.concreteName))
        .map((info) => buildConcreteClassFromMonomorphized(info));
    const monomorphizedFunctions = Array.from(artifacts.functions.values())
        .filter((info) => {
            const unitId = getMonomorphizedFunctionOwnerUnitId(info);
            return unitId === null || ownedUnitIds.has(unitId);
        })
        .sort((left, right) => left.concreteName.localeCompare(right.concreteName))
        .map((info) => buildConcreteFunctionFromMonomorphized(info));
    const externalClasses = buildExternalClassDefinitions(precompiledLibraries, ownedUnitIds);
    const concreteClasses = [...sourceClasses, ...monomorphizedClasses, ...externalClasses];
    const concreteFunctions = [...sourceFunctions, ...monomorphizedFunctions];
    const selectedEntryFunction = selectedEntryFunctionNode === null
        ? null
        : sourceFunctions.find((fn) => fn.functionNode === selectedEntryFunctionNode) ?? null;
    const entryParams = selectedEntryFunctionNode === null
        ? []
        : selectedEntryFunctionNode.params.map((param) => ({
            name: param.var.name,
            typeExp: param.typeExp
        }));
    const topLevelStatements = [...orderedGlobalInitializerStatements, ...explicitTopLevelStatements];
    const referencedUnionMetadata = collectReferencedUnionMetadata(concreteClasses, concreteFunctions, declaredFunctions);
    const exportedIwFunctions = collectExportedIwFunctions(sourceFunctions);
    const program: LoweringSnapshotProgram = {
        kind: "lowering_snapshot_program",
        topLevelStatements,
        globals,
        concreteClasses,
        concreteFunctions,
        declaredFunctions,
        metadata: {
            sourceTopLevelNodeCount: topLevelNodes.length,
            executableStatementCount: topLevelStatements.length,
            concreteClassCount: sourceClasses.length + monomorphizedClasses.length,
            concreteFunctionCount: sourceFunctions.length + monomorphizedFunctions.length,
            monomorphizedClassCount: monomorphizedClasses.length,
            monomorphizedFunctionCount: monomorphizedFunctions.length,
            concreteClassTypeTagIds: concreteClasses.map((classDef) => classDef.runtimeTypeTagId).sort((left, right) => left.localeCompare(right)),
            referencedUnionTypeTagIds: referencedUnionMetadata.map((metadata) => metadata.unionTypeTagId),
            referencedUnionMetadata,
            exportedIwFunctions,
            entryConcreteFunctionSymbol: selectedEntryFunction?.concreteName ?? null,
            entryParams
        }
    };

    validateLoweringSnapshotProgram(program);
    return program;
}
