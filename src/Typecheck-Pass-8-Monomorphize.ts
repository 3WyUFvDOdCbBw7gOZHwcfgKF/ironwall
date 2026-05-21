import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    ClassNode,
    ClassPropertyNode,
    CondNode,
    DeclaredDfunNode,
    DfunNode,
    DvarNode,
    ExportNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    GenericClassNode,
    GenericDfunNode,
    GenericNameNode,
    IdentifierNode,
    IfNode,
    ImportNode,
    LetNode,
    ListNode,
    MatchNode,
    NumberLiteralNode,
    ProgramNode,
    SeqNode,
    SetNode,
    TextDatabaseReferenceNode,
    TypeToFromNode,
    TypeUnionNode,
    TypeVarBindNode,
    WhileNode,
    unwrapExportNode
} from "./AstNode";
import { annotateCanonicalTagsForCodeRoots, getAstCanonicalTag } from "./AstCanonicalTag";
import {
    annotateAstWithCompilationUnitMetadata,
    copyCompilationUnitMetadata,
    parseCompilationUnitId,
    type CompilationUnitMetadata
} from "./ModuleMetadata";
import { getGenericClassInfo, getGenericFunctionInfo, getVisibleGenericClassInfo, getVisibleGenericFunctionInfo } from "./Typecheck-Definitions";
import { getResolvedGenericClassInfo, getResolvedGenericFunctionInfo } from "./Typecheck-Pass-2-ResolveHeaders";
import { genericClassInstanceTable, genericFunctionInstanceTable } from "./Typecheck-Pass-4-CollectInstantiations";
import {
    ClassTypeValue,
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    GenericFunctionInstanceTypeValue,
    PrimitiveTypeValue,
    TypeParameterValue,
    TypeValue,
    UnionTypeValue,
    builtinGenericTypeNames,
    hashText,
    printTypeValue
} from "./TypeSystem";
import { astToTypeValue } from "./Typecheck-TypeAst";
import {
    isPrecompiledGenericClassName,
    isPrecompiledGenericFunctionName,
    lookupPrecompiledClassMonomorph,
    lookupPrecompiledFunctionMonomorph
} from "./PrecompiledLib";

const MONOMORPHIZED_CLASS_PREFIX = "__iw_mono_class";
const MONOMORPHIZED_FUNCTION_PREFIX = "__iw_mono_fn";
const DEFAULT_MONOMORPHIZATION_MAX_ROUNDS = 5;

export interface MonomorphizedClassInfo {
    readonly concreteName: string;
    readonly instanceHash: string;
    readonly sourceGenericName: string;
    readonly typeArgs: readonly TypeValue[];
    readonly classNode: ClassNode;
    readonly propertyTypes: ReadonlyMap<string, TypeValue>;
    readonly methodTypes: ReadonlyMap<string, FunctionTypeValue>;
    readonly constructorParamTypes: readonly (readonly TypeValue[])[];
}

export interface MonomorphizedFunctionInfo {
    readonly concreteName: string;
    readonly instanceHash: string;
    readonly sourceGenericName: string;
    readonly typeArgs: readonly TypeValue[];
    readonly functionNode: DfunNode;
    readonly functionType: FunctionTypeValue;
}

export interface MonomorphizedArtifacts {
    readonly classes: ReadonlyMap<string, MonomorphizedClassInfo>;
    readonly functions: ReadonlyMap<string, MonomorphizedFunctionInfo>;
}

export interface MonomorphizationMaterializeOptions {
    readonly maxExpansionRounds?: number;
}

interface GenericOccurrence {
    readonly tag: string;
    readonly kind: "class" | "function";
    readonly instance: GenericClassInstanceTypeValue | GenericFunctionInstanceTypeValue;
}

class GeneratedClassSeed {
    public readonly instance: GenericClassInstanceTypeValue;
    public classNode: ClassNode;

    constructor(instance: GenericClassInstanceTypeValue, classNode: ClassNode) {
        this.instance = instance;
        this.classNode = classNode;
    }
}

class GeneratedFunctionSeed {
    public readonly instance: GenericFunctionInstanceTypeValue;
    public functionNode: DfunNode;

    constructor(instance: GenericFunctionInstanceTypeValue, functionNode: DfunNode) {
        this.instance = instance;
        this.functionNode = functionNode;
    }
}

type NormalizedTypeResolution =
    | { readonly kind: "resolved"; readonly type: TypeValue }
    | { readonly kind: "pending" }
    | { readonly kind: "missing"; readonly instance: GenericClassInstanceTypeValue };

type PrecompiledInstanceResolution =
    | { readonly kind: "resolved"; readonly concreteName: string; readonly instanceHash: string }
    | { readonly kind: "pending" }
    | { readonly kind: "missing"; readonly instance: GenericClassInstanceTypeValue | GenericFunctionInstanceTypeValue };

export const monomorphizedClassTable: Map<string, MonomorphizedClassInfo> = new Map<string, MonomorphizedClassInfo>();
export const monomorphizedFunctionTable: Map<string, MonomorphizedFunctionInfo> = new Map<string, MonomorphizedFunctionInfo>();

let monomorphizedConcreteProgram: ProgramNode | null = null;

function instanceSuffix(instanceHash: string): string {
    const suffix = instanceHash.split(":")[1];
    return suffix !== undefined && suffix.length > 0 ? suffix : hashText(instanceHash);
}

function buildCompilationUnitMetadataFromSourceInfo(source: { unitId: string | null; packageName: string | null; filePath: string | null }): CompilationUnitMetadata | undefined {
    if (source.unitId === null || source.packageName === null) {
        return undefined;
    }
    const parsedMetadata = parseCompilationUnitId(source.unitId);
    if (parsedMetadata === null) {
        return undefined;
    }
    return {
        ...parsedMetadata,
        filePath: source.filePath
    };
}

function cloneTypeVarBindNode(node: TypeVarBindNode): TypeVarBindNode {
    return new TypeVarBindNode(new IdentifierNode(node.var.name), cloneAstNode(node.typeExp));
}

function cloneClassPropertyNode(node: ClassPropertyNode): ClassPropertyNode {
    return new ClassPropertyNode(cloneTypeVarBindNode(node.bind));
}

function cloneClassMethodNode(node: ClassMethodNode): ClassMethodNode {
    return new ClassMethodNode(
        new IdentifierNode(node.methodName.name),
        node.params.map((param) => cloneTypeVarBindNode(param)),
        cloneAstNode(node.returnType),
        cloneAstNode(node.body)
    );
}

function cloneClassConstructorNode(node: ClassConstructorNode): ClassConstructorNode {
    return new ClassConstructorNode(node.params.map((param) => cloneTypeVarBindNode(param)), cloneAstNode(node.body));
}

function cloneAstNode(node: AstNode): AstNode {
    if (node instanceof IdentifierNode) {
        return new IdentifierNode(node.name);
    }
    if (node instanceof TextDatabaseReferenceNode) {
        return new TextDatabaseReferenceNode(node.typeName, node.entryName, node.referenceName, node.content);
    }
    if (node instanceof NumberLiteralNode) {
        return new NumberLiteralNode(node.typeName, node.value, node.raw);
    }
    if (node instanceof ExportNode) {
        return new ExportNode(cloneAstNode(node.inner));
    }
    if (node instanceof GenericNameNode) {
        return new GenericNameNode(
            new IdentifierNode(node.name.name),
            node.genericTypeArgs.map((typeArg) => new IdentifierNode(typeArg.name))
        );
    }
    if (node instanceof GenericCallNode) {
        return new GenericCallNode(cloneAstNode(node.callee), node.typeArgs.map((typeArg) => cloneAstNode(typeArg)));
    }
    if (node instanceof ListNode) {
        return new ListNode(node.elements.map((element) => cloneAstNode(element)));
    }
    if (node instanceof FnNode) {
        return new FnNode(
            node.params.map((param) => cloneTypeVarBindNode(param)),
            cloneAstNode(node.returnType),
            cloneAstNode(node.body)
        );
    }
    if (node instanceof LetNode) {
        return new LetNode(
            node.bindings.map((binding) => ({
                bind: cloneAstNode(binding.bind),
                value: cloneAstNode(binding.value)
            })),
            cloneAstNode(node.body)
        );
    }
    if (node instanceof IfNode) {
        return new IfNode(cloneAstNode(node.condExpr), cloneAstNode(node.trueBranchExpr), cloneAstNode(node.falseBranchExpr));
    }
    if (node instanceof WhileNode) {
        return new WhileNode(cloneAstNode(node.condExpr), cloneAstNode(node.bodyExpr));
    }
    if (node instanceof CondNode) {
        return new CondNode(node.clausesExprs.map((clause) => ({ cond: cloneAstNode(clause.cond), body: cloneAstNode(clause.body) })));
    }
    if (node instanceof DvarNode) {
        return new DvarNode(cloneAstNode(node.bind), cloneAstNode(node.value));
    }
    if (node instanceof DfunNode) {
        return new DfunNode(
            new IdentifierNode(node.name.name),
            node.params.map((param) => cloneTypeVarBindNode(param)),
            cloneAstNode(node.returnType),
            cloneAstNode(node.body)
        );
    }
    if (node instanceof DeclaredDfunNode) {
        return new DeclaredDfunNode(
            new IdentifierNode(node.name.name),
            node.params.map((param) => cloneTypeVarBindNode(param)),
            cloneAstNode(node.returnType)
        );
    }
    if (node instanceof ProgramNode) {
        return new ProgramNode(node.topLevelExpressions.map((expression) => cloneAstNode(expression)), node.unitId);
    }
    if (node instanceof SeqNode) {
        return new SeqNode(node.expressions.map((expression) => cloneAstNode(expression)));
    }
    if (node instanceof SetNode) {
        return new SetNode(new IdentifierNode(node.identifier.name), cloneAstNode(node.value));
    }
    if (node instanceof TypeVarBindNode) {
        return cloneTypeVarBindNode(node);
    }
    if (node instanceof TypeToFromNode) {
        return new TypeToFromNode(cloneAstNode(node.returnType), node.paramTypes.map((paramType) => cloneAstNode(paramType)));
    }
    if (node instanceof TypeUnionNode) {
        return new TypeUnionNode(node.types.map((typeNode) => cloneAstNode(typeNode)));
    }
    if (node instanceof ClassPropertyNode) {
        return cloneClassPropertyNode(node);
    }
    if (node instanceof ClassMethodNode) {
        return cloneClassMethodNode(node);
    }
    if (node instanceof ClassConstructorNode) {
        return cloneClassConstructorNode(node);
    }
    if (node instanceof ClassNode) {
        return new ClassNode(
            new IdentifierNode(node.name.name),
            node.constructorNodeList.map((ctor) => cloneClassConstructorNode(ctor)),
            node.methodNodeList.map((method) => cloneClassMethodNode(method)),
            node.propertyNodeList.map((property) => cloneClassPropertyNode(property))
        );
    }
    if (node instanceof FunctionCallNode) {
        return new FunctionCallNode(cloneAstNode(node.callee), node.args.map((arg) => cloneAstNode(arg)));
    }
    if (node instanceof MatchNode) {
        return new MatchNode(cloneAstNode(node.unionExpr), node.branches.map((branch) => ({ bind: cloneTypeVarBindNode(branch.bind), body: cloneAstNode(branch.body) })));
    }
    if (node instanceof ImportNode) {
        return new ImportNode(new IdentifierNode(node.packagePath.name));
    }
    return node;
}

function ensurePositiveMaxRounds(maxExpansionRounds: number): void {
    if (!Number.isInteger(maxExpansionRounds) || maxExpansionRounds < 1) {
        throw new Error("monomorphization maxExpansionRounds must be a positive integer");
    }
}

function typeValueToTemplateTypeAst(type: TypeValue): AstNode {
    if (type instanceof PrimitiveTypeValue) {
        return new IdentifierNode(type.name);
    }
    if (type instanceof ClassTypeValue) {
        return new IdentifierNode(type.className);
    }
    if (type instanceof TypeParameterValue) {
        return new IdentifierNode(type.name);
    }
    if (type instanceof FunctionTypeValue) {
        return new TypeToFromNode(
            typeValueToTemplateTypeAst(type.returnType),
            type.paramTypes.map((paramType) => typeValueToTemplateTypeAst(paramType))
        );
    }
    if (type instanceof UnionTypeValue) {
        return new TypeUnionNode(type.types.map((member) => typeValueToTemplateTypeAst(member)));
    }
    return new GenericCallNode(
        new IdentifierNode(type.genericName),
        type.typeArgs.map((typeArg) => typeValueToTemplateTypeAst(typeArg))
    );
}

function buildSubstitutionMap(typeParams: readonly string[], typeArgs: readonly TypeValue[]): Map<string, TypeValue> {
    const substitutions = new Map<string, TypeValue>();
    for (let index = 0; index < typeParams.length; index += 1) {
        substitutions.set(typeParams[index], typeArgs[index]);
    }
    return substitutions;
}

function substituteTypeAstTemplate(node: AstNode, substitutions: ReadonlyMap<string, TypeValue>): AstNode {
    if (node instanceof IdentifierNode) {
        const substitutedType = substitutions.get(node.name);
        if (substitutedType !== undefined) {
            return typeValueToTemplateTypeAst(substitutedType);
        }
        return new IdentifierNode(node.name);
    }
    if (node instanceof GenericCallNode) {
        return new GenericCallNode(
            node.callee instanceof IdentifierNode ? new IdentifierNode(node.callee.name) : substituteTypeAstTemplate(node.callee, substitutions),
            node.typeArgs.map((typeArg) => substituteTypeAstTemplate(typeArg, substitutions))
        );
    }
    if (node instanceof TypeToFromNode) {
        return new TypeToFromNode(
            substituteTypeAstTemplate(node.returnType, substitutions),
            node.paramTypes.map((paramType) => substituteTypeAstTemplate(paramType, substitutions))
        );
    }
    if (node instanceof TypeUnionNode) {
        return new TypeUnionNode(node.types.map((typeNode) => substituteTypeAstTemplate(typeNode, substitutions)));
    }
    return cloneAstNode(node);
}

function substituteBindNodeTemplate(node: TypeVarBindNode, substitutions: ReadonlyMap<string, TypeValue>): TypeVarBindNode {
    return new TypeVarBindNode(new IdentifierNode(node.var.name), substituteTypeAstTemplate(node.typeExp, substitutions));
}

function substituteClassPropertyTemplate(node: ClassPropertyNode, substitutions: ReadonlyMap<string, TypeValue>): ClassPropertyNode {
    return new ClassPropertyNode(substituteBindNodeTemplate(node.bind, substitutions));
}

function substituteClassMethodTemplate(node: ClassMethodNode, substitutions: ReadonlyMap<string, TypeValue>): ClassMethodNode {
    return new ClassMethodNode(
        new IdentifierNode(node.methodName.name),
        node.params.map((param) => substituteBindNodeTemplate(param, substitutions)),
        substituteTypeAstTemplate(node.returnType, substitutions),
        substituteValueAstTemplate(node.body, substitutions)
    );
}

function substituteClassConstructorTemplate(node: ClassConstructorNode, substitutions: ReadonlyMap<string, TypeValue>): ClassConstructorNode {
    return new ClassConstructorNode(
        node.params.map((param) => substituteBindNodeTemplate(param, substitutions)),
        substituteValueAstTemplate(node.body, substitutions)
    );
}

function substituteFunctionCallTemplate(node: FunctionCallNode, substitutions: ReadonlyMap<string, TypeValue>): FunctionCallNode {
    const rewrittenCallee = substituteValueAstTemplate(node.callee, substitutions);
    if (node.callee instanceof IdentifierNode && node.callee.name === "class_new" && node.args.length > 0) {
        return new FunctionCallNode(rewrittenCallee, [
            substituteTypeAstTemplate(node.args[0], substitutions),
            ...node.args.slice(1).map((arg) => substituteValueAstTemplate(arg, substitutions))
        ]);
    }
    if (node.callee instanceof IdentifierNode && node.callee.name === "array_new" && node.args.length > 0) {
        return new FunctionCallNode(rewrittenCallee, [
            substituteTypeAstTemplate(node.args[0], substitutions),
            ...node.args.slice(1).map((arg) => substituteValueAstTemplate(arg, substitutions))
        ]);
    }
    if (node.callee instanceof IdentifierNode && node.callee.name === "cm_get" && node.args.length >= 2 && node.args[1] instanceof IdentifierNode) {
        return new FunctionCallNode(rewrittenCallee, [
            substituteValueAstTemplate(node.args[0], substitutions),
            new IdentifierNode(node.args[1].name),
            ...node.args.slice(2).map((arg) => substituteValueAstTemplate(arg, substitutions))
        ]);
    }
    if (node.callee instanceof IdentifierNode && node.callee.name === "cm_set" && node.args.length >= 3 && node.args[1] instanceof IdentifierNode) {
        return new FunctionCallNode(rewrittenCallee, [
            substituteValueAstTemplate(node.args[0], substitutions),
            new IdentifierNode(node.args[1].name),
            substituteValueAstTemplate(node.args[2], substitutions),
            ...node.args.slice(3).map((arg) => substituteValueAstTemplate(arg, substitutions))
        ]);
    }
    return new FunctionCallNode(rewrittenCallee, node.args.map((arg) => substituteValueAstTemplate(arg, substitutions)));
}

function substituteValueAstTemplate(node: AstNode, substitutions: ReadonlyMap<string, TypeValue>): AstNode {
    if (node instanceof IdentifierNode || node instanceof TextDatabaseReferenceNode || node instanceof NumberLiteralNode) {
        return cloneAstNode(node);
    }
    if (node instanceof ExportNode) {
        return new ExportNode(substituteValueAstTemplate(node.inner, substitutions));
    }
    if (node instanceof GenericNameNode) {
        return cloneAstNode(node);
    }
    if (node instanceof GenericCallNode) {
        return new GenericCallNode(
            node.callee instanceof IdentifierNode ? new IdentifierNode(node.callee.name) : substituteValueAstTemplate(node.callee, substitutions),
            node.typeArgs.map((typeArg) => substituteTypeAstTemplate(typeArg, substitutions))
        );
    }
    if (node instanceof ListNode) {
        return new ListNode(node.elements.map((element) => substituteValueAstTemplate(element, substitutions)));
    }
    if (node instanceof FnNode) {
        return new FnNode(
            node.params.map((param) => substituteBindNodeTemplate(param, substitutions)),
            substituteTypeAstTemplate(node.returnType, substitutions),
            substituteValueAstTemplate(node.body, substitutions)
        );
    }
    if (node instanceof LetNode) {
        return new LetNode(
            node.bindings.map((binding) => ({
                bind: binding.bind instanceof TypeVarBindNode
                    ? substituteBindNodeTemplate(binding.bind, substitutions)
                    : substituteValueAstTemplate(binding.bind, substitutions),
                value: substituteValueAstTemplate(binding.value, substitutions)
            })),
            substituteValueAstTemplate(node.body, substitutions)
        );
    }
    if (node instanceof IfNode) {
        return new IfNode(
            substituteValueAstTemplate(node.condExpr, substitutions),
            substituteValueAstTemplate(node.trueBranchExpr, substitutions),
            substituteValueAstTemplate(node.falseBranchExpr, substitutions)
        );
    }
    if (node instanceof WhileNode) {
        return new WhileNode(
            substituteValueAstTemplate(node.condExpr, substitutions),
            substituteValueAstTemplate(node.bodyExpr, substitutions)
        );
    }
    if (node instanceof CondNode) {
        return new CondNode(node.clausesExprs.map((clause) => ({
            cond: substituteValueAstTemplate(clause.cond, substitutions),
            body: substituteValueAstTemplate(clause.body, substitutions)
        })));
    }
    if (node instanceof DvarNode) {
        return new DvarNode(
            node.bind instanceof TypeVarBindNode ? substituteBindNodeTemplate(node.bind, substitutions) : substituteValueAstTemplate(node.bind, substitutions),
            substituteValueAstTemplate(node.value, substitutions)
        );
    }
    if (node instanceof DfunNode) {
        return new DfunNode(
            new IdentifierNode(node.name.name),
            node.params.map((param) => substituteBindNodeTemplate(param, substitutions)),
            substituteTypeAstTemplate(node.returnType, substitutions),
            substituteValueAstTemplate(node.body, substitutions)
        );
    }
    if (node instanceof DeclaredDfunNode) {
        return new DeclaredDfunNode(
            new IdentifierNode(node.name.name),
            node.params.map((param) => substituteBindNodeTemplate(param, substitutions)),
            substituteTypeAstTemplate(node.returnType, substitutions)
        );
    }
    if (node instanceof ProgramNode) {
        return new ProgramNode(node.topLevelExpressions.map((expression) => substituteValueAstTemplate(expression, substitutions)), node.unitId);
    }
    if (node instanceof SeqNode) {
        return new SeqNode(node.expressions.map((expression) => substituteValueAstTemplate(expression, substitutions)));
    }
    if (node instanceof SetNode) {
        return new SetNode(new IdentifierNode(node.identifier.name), substituteValueAstTemplate(node.value, substitutions));
    }
    if (node instanceof TypeVarBindNode || node instanceof TypeToFromNode || node instanceof TypeUnionNode) {
        return substituteTypeAstTemplate(node, substitutions);
    }
    if (node instanceof ClassPropertyNode) {
        return substituteClassPropertyTemplate(node, substitutions);
    }
    if (node instanceof ClassMethodNode) {
        return substituteClassMethodTemplate(node, substitutions);
    }
    if (node instanceof ClassConstructorNode) {
        return substituteClassConstructorTemplate(node, substitutions);
    }
    if (node instanceof ClassNode) {
        return new ClassNode(
            new IdentifierNode(node.name.name),
            node.constructorNodeList.map((ctor) => substituteClassConstructorTemplate(ctor, substitutions)),
            node.methodNodeList.map((method) => substituteClassMethodTemplate(method, substitutions)),
            node.propertyNodeList.map((property) => substituteClassPropertyTemplate(property, substitutions))
        );
    }
    if (node instanceof FunctionCallNode) {
        return substituteFunctionCallTemplate(node, substitutions);
    }
    if (node instanceof MatchNode) {
        return new MatchNode(
            substituteValueAstTemplate(node.unionExpr, substitutions),
            node.branches.map((branch) => ({
                bind: substituteBindNodeTemplate(branch.bind, substitutions),
                body: substituteValueAstTemplate(branch.body, substitutions)
            }))
        );
    }
    return cloneAstNode(node);
}

function collectInitialConcreteCodeRoots(programAst: AstNode): AstNode[] {
    if (programAst instanceof ProgramNode) {
        const codeRoots: AstNode[] = [];
        for (const expression of programAst.topLevelExpressions) {
            const codeRoot = unwrapExportNode(expression);
            if (codeRoot instanceof ImportNode || codeRoot instanceof GenericClassNode || codeRoot instanceof GenericDfunNode) {
                continue;
            }
            const clonedRoot = cloneAstNode(codeRoot);
            copyCompilationUnitMetadata(codeRoot, clonedRoot);
            codeRoots.push(clonedRoot);
        }
        return codeRoots;
    }
    const codeRoot = unwrapExportNode(programAst);
    if (codeRoot instanceof ImportNode || codeRoot instanceof GenericClassNode || codeRoot instanceof GenericDfunNode) {
        return [];
    }
    const clonedRoot = cloneAstNode(codeRoot);
    copyCompilationUnitMetadata(codeRoot, clonedRoot);
    return [clonedRoot];
}

function collectKnownConcreteClassNames(codeRoots: readonly AstNode[]): Set<string> {
    const classNames = new Set<string>();
    for (const codeRoot of codeRoots) {
        const classNode = unwrapExportNode(codeRoot);
        if (classNode instanceof ClassNode) {
            classNames.add(classNode.name.name);
        }
    }
    return classNames;
}

function isEndType(type: TypeValue, concreteClassNames: ReadonlySet<string>): boolean {
    if (type instanceof PrimitiveTypeValue) {
        return true;
    }
    if (type instanceof ClassTypeValue) {
        return concreteClassNames.has(type.className);
    }
    if (type instanceof FunctionTypeValue) {
        return type.paramTypes.every((paramType) => isEndType(paramType, concreteClassNames))
            && isEndType(type.returnType, concreteClassNames);
    }
    if (type instanceof UnionTypeValue) {
        return type.types.every((member) => isEndType(member, concreteClassNames));
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        if (!builtinGenericTypeNames.has(type.genericName)) {
            return false;
        }
        return type.typeArgs.every((typeArg) => isEndType(typeArg, concreteClassNames));
    }
    return false;
}

function normalizeTypeForPrecompiledLookup(type: TypeValue, availableClassNameMap: ReadonlyMap<string, string>): NormalizedTypeResolution {
    if (type instanceof PrimitiveTypeValue || type instanceof ClassTypeValue || type instanceof TypeParameterValue) {
        return {
            kind: "resolved",
            type
        };
    }
    if (type instanceof FunctionTypeValue) {
        const normalizedParamTypes: TypeValue[] = [];
        for (const paramType of type.paramTypes) {
            const result = normalizeTypeForPrecompiledLookup(paramType, availableClassNameMap);
            if (result.kind !== "resolved") {
                return result;
            }
            normalizedParamTypes.push(result.type);
        }
        const normalizedReturnType = normalizeTypeForPrecompiledLookup(type.returnType, availableClassNameMap);
        if (normalizedReturnType.kind !== "resolved") {
            return normalizedReturnType;
        }
        return {
            kind: "resolved",
            type: new FunctionTypeValue(normalizedParamTypes, normalizedReturnType.type)
        };
    }
    if (type instanceof UnionTypeValue) {
        const normalizedMembers: TypeValue[] = [];
        for (const member of type.types) {
            const result = normalizeTypeForPrecompiledLookup(member, availableClassNameMap);
            if (result.kind !== "resolved") {
                return result;
            }
            normalizedMembers.push(result.type);
        }
        return {
            kind: "resolved",
            type: new UnionTypeValue(normalizedMembers)
        };
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return {
            kind: "pending"
        };
    }

    const directKnownConcreteName = availableClassNameMap.get(type.hash());
    if (directKnownConcreteName !== undefined) {
        return {
            kind: "resolved",
            type: new ClassTypeValue(directKnownConcreteName)
        };
    }

    const normalizedTypeArgs: TypeValue[] = [];
    for (const typeArg of type.typeArgs) {
        const result = normalizeTypeForPrecompiledLookup(typeArg, availableClassNameMap);
        if (result.kind !== "resolved") {
            return result;
        }
        normalizedTypeArgs.push(result.type);
    }

    if (builtinGenericTypeNames.has(type.genericName)) {
        return {
            kind: "resolved",
            type: new GenericClassInstanceTypeValue(type.genericName, normalizedTypeArgs)
        };
    }

    const normalizedInstance = new GenericClassInstanceTypeValue(type.genericName, normalizedTypeArgs);
    const normalizedKnownConcreteName = availableClassNameMap.get(normalizedInstance.hash());
    if (normalizedKnownConcreteName !== undefined) {
        return {
            kind: "resolved",
            type: new ClassTypeValue(normalizedKnownConcreteName)
        };
    }

    if (!isPrecompiledGenericClassName(type.genericName)) {
        return {
            kind: "pending"
        };
    }

    const lookup = lookupPrecompiledClassMonomorph(normalizedInstance.hash());
    if (lookup === undefined) {
        return {
            kind: "missing",
            instance: normalizedInstance
        };
    }

    return {
        kind: "resolved",
        type: new ClassTypeValue(lookup.concreteName)
    };
}

function resolvePrecompiledClassOccurrence(
    instance: GenericClassInstanceTypeValue,
    availableClassNameMap: ReadonlyMap<string, string>
): PrecompiledInstanceResolution {
    const directKnownConcreteName = availableClassNameMap.get(instance.hash());
    if (directKnownConcreteName !== undefined) {
        return {
            kind: "resolved",
            concreteName: directKnownConcreteName,
            instanceHash: instance.hash()
        };
    }

    const normalizedTypeArgs: TypeValue[] = [];
    for (const typeArg of instance.typeArgs) {
        const result = normalizeTypeForPrecompiledLookup(typeArg, availableClassNameMap);
        if (result.kind === "pending") {
            return result;
        }
        if (result.kind === "missing") {
            return result;
        }
        normalizedTypeArgs.push(result.type);
    }

    const normalizedInstance = new GenericClassInstanceTypeValue(instance.genericName, normalizedTypeArgs);
    const normalizedKnownConcreteName = availableClassNameMap.get(normalizedInstance.hash());
    if (normalizedKnownConcreteName !== undefined) {
        return {
            kind: "resolved",
            concreteName: normalizedKnownConcreteName,
            instanceHash: normalizedInstance.hash()
        };
    }

    if (!isPrecompiledGenericClassName(instance.genericName)) {
        return {
            kind: "pending"
        };
    }

    const lookup = lookupPrecompiledClassMonomorph(normalizedInstance.hash());
    if (lookup === undefined) {
        return {
            kind: "missing",
            instance: normalizedInstance
        };
    }

    return {
        kind: "resolved",
        concreteName: lookup.concreteName,
        instanceHash: normalizedInstance.hash()
    };
}

function resolvePrecompiledFunctionOccurrence(
    instance: GenericFunctionInstanceTypeValue,
    availableClassNameMap: ReadonlyMap<string, string>,
    availableFunctionNameMap: ReadonlyMap<string, string>
): PrecompiledInstanceResolution {
    const directKnownConcreteName = availableFunctionNameMap.get(instance.hash());
    if (directKnownConcreteName !== undefined) {
        return {
            kind: "resolved",
            concreteName: directKnownConcreteName,
            instanceHash: instance.hash()
        };
    }

    const normalizedTypeArgs: TypeValue[] = [];
    for (const typeArg of instance.typeArgs) {
        const result = normalizeTypeForPrecompiledLookup(typeArg, availableClassNameMap);
        if (result.kind === "pending") {
            return result;
        }
        if (result.kind === "missing") {
            return result;
        }
        normalizedTypeArgs.push(result.type);
    }

    const normalizedInstance = new GenericFunctionInstanceTypeValue(instance.genericName, normalizedTypeArgs);
    const normalizedKnownConcreteName = availableFunctionNameMap.get(normalizedInstance.hash());
    if (normalizedKnownConcreteName !== undefined) {
        return {
            kind: "resolved",
            concreteName: normalizedKnownConcreteName,
            instanceHash: normalizedInstance.hash()
        };
    }

    if (!isPrecompiledGenericFunctionName(instance.genericName)) {
        return {
            kind: "pending"
        };
    }

    const lookup = lookupPrecompiledFunctionMonomorph(normalizedInstance.hash());
    if (lookup === undefined) {
        return {
            kind: "missing",
            instance: normalizedInstance
        };
    }

    return {
        kind: "resolved",
        concreteName: lookup.concreteName,
        instanceHash: normalizedInstance.hash()
    };
}

function collectOccurrence(sink: GenericOccurrence[], tag: string, kind: "class" | "function", instance: GenericClassInstanceTypeValue | GenericFunctionInstanceTypeValue): void {
    sink.push({ tag, kind, instance });
}

function resolveGenericClassInfoForMonomorphization(referenceNode: AstNode, name: string, arity: number): ReturnType<typeof getVisibleGenericClassInfo> {
    return getVisibleGenericClassInfo(referenceNode, name, arity) ?? getGenericClassInfo(name, arity);
}

function resolveGenericFunctionInfoForMonomorphization(referenceNode: AstNode, name: string, arity: number): ReturnType<typeof getVisibleGenericFunctionInfo> {
    return getVisibleGenericFunctionInfo(referenceNode, name, arity) ?? getGenericFunctionInfo(name, arity);
}

function collectGenericOccurrencesFromTypeAst(node: AstNode, sink: GenericOccurrence[]): void {
    if (node instanceof GenericCallNode) {
        for (const typeArg of node.typeArgs) {
            collectGenericOccurrencesFromTypeAst(typeArg, sink);
        }
        if (node.callee instanceof IdentifierNode && !builtinGenericTypeNames.has(node.callee.name)) {
            const genericClassInfo = resolveGenericClassInfoForMonomorphization(node, node.callee.name, node.typeArgs.length);
            if (genericClassInfo !== undefined) {
                collectOccurrence(
                    sink,
                    getAstCanonicalTag(node),
                    "class",
                    new GenericClassInstanceTypeValue(genericClassInfo.genericName, node.typeArgs.map((typeArg) => astToTypeValue(typeArg)))
                );
            }
        }
        return;
    }
    if (node instanceof TypeToFromNode) {
        collectGenericOccurrencesFromTypeAst(node.returnType, sink);
        for (const paramType of node.paramTypes) {
            collectGenericOccurrencesFromTypeAst(paramType, sink);
        }
        return;
    }
    if (node instanceof TypeUnionNode) {
        for (const typeNode of node.types) {
            collectGenericOccurrencesFromTypeAst(typeNode, sink);
        }
    }
}

function collectGenericOccurrencesFromValueAst(node: AstNode, sink: GenericOccurrence[]): void {
    if (node instanceof ExportNode) {
        collectGenericOccurrencesFromValueAst(node.inner, sink);
        return;
    }
    if (node instanceof IdentifierNode || node instanceof NumberLiteralNode || node instanceof TextDatabaseReferenceNode || node instanceof ImportNode) {
        return;
    }
    if (node instanceof GenericCallNode) {
        for (const typeArg of node.typeArgs) {
            collectGenericOccurrencesFromTypeAst(typeArg, sink);
        }
        if (node.callee instanceof IdentifierNode) {
            if (node.callee.name === "class_new") {
                const classNameNode = node.typeArgs[0];
                const classTypeArgs = node.typeArgs.slice(1);
                if (classNameNode instanceof IdentifierNode && classTypeArgs.length > 0) {
                    const genericClassInfo = resolveGenericClassInfoForMonomorphization(classNameNode, classNameNode.name, classTypeArgs.length);
                    if (genericClassInfo !== undefined) {
                        collectOccurrence(
                            sink,
                            getAstCanonicalTag(node),
                            "class",
                            new GenericClassInstanceTypeValue(genericClassInfo.genericName, classTypeArgs.map((typeArg) => astToTypeValue(typeArg)))
                        );
                    }
                }
                return;
            }
            const genericFunctionInfo = resolveGenericFunctionInfoForMonomorphization(node, node.callee.name, node.typeArgs.length);
            if (genericFunctionInfo !== undefined) {
                collectOccurrence(
                    sink,
                    getAstCanonicalTag(node),
                    "function",
                    new GenericFunctionInstanceTypeValue(genericFunctionInfo.genericName, node.typeArgs.map((typeArg) => astToTypeValue(typeArg)))
                );
                return;
            }
            if (!builtinGenericTypeNames.has(node.callee.name)) {
                const genericClassInfo = resolveGenericClassInfoForMonomorphization(node, node.callee.name, node.typeArgs.length);
                if (genericClassInfo !== undefined) {
                    collectOccurrence(
                        sink,
                        getAstCanonicalTag(node),
                        "class",
                        new GenericClassInstanceTypeValue(genericClassInfo.genericName, node.typeArgs.map((typeArg) => astToTypeValue(typeArg)))
                    );
                }
            }
        }
        return;
    }
    if (node instanceof FnNode) {
        for (const param of node.params) {
            collectGenericOccurrencesFromTypeAst(param.typeExp, sink);
        }
        collectGenericOccurrencesFromTypeAst(node.returnType, sink);
        collectGenericOccurrencesFromValueAst(node.body, sink);
        return;
    }
    if (node instanceof LetNode) {
        for (const binding of node.bindings) {
            if (binding.bind instanceof TypeVarBindNode) {
                collectGenericOccurrencesFromTypeAst(binding.bind.typeExp, sink);
            }
            collectGenericOccurrencesFromValueAst(binding.value, sink);
        }
        collectGenericOccurrencesFromValueAst(node.body, sink);
        return;
    }
    if (node instanceof IfNode) {
        collectGenericOccurrencesFromValueAst(node.condExpr, sink);
        collectGenericOccurrencesFromValueAst(node.trueBranchExpr, sink);
        collectGenericOccurrencesFromValueAst(node.falseBranchExpr, sink);
        return;
    }
    if (node instanceof WhileNode) {
        collectGenericOccurrencesFromValueAst(node.condExpr, sink);
        collectGenericOccurrencesFromValueAst(node.bodyExpr, sink);
        return;
    }
    if (node instanceof CondNode) {
        for (const clause of node.clausesExprs) {
            collectGenericOccurrencesFromValueAst(clause.cond, sink);
            collectGenericOccurrencesFromValueAst(clause.body, sink);
        }
        return;
    }
    if (node instanceof DvarNode) {
        if (node.bind instanceof TypeVarBindNode) {
            collectGenericOccurrencesFromTypeAst(node.bind.typeExp, sink);
        }
        collectGenericOccurrencesFromValueAst(node.value, sink);
        return;
    }
    if (node instanceof DfunNode) {
        for (const param of node.params) {
            collectGenericOccurrencesFromTypeAst(param.typeExp, sink);
        }
        collectGenericOccurrencesFromTypeAst(node.returnType, sink);
        collectGenericOccurrencesFromValueAst(node.body, sink);
        return;
    }
    if (node instanceof DeclaredDfunNode) {
        for (const param of node.params) {
            collectGenericOccurrencesFromTypeAst(param.typeExp, sink);
        }
        collectGenericOccurrencesFromTypeAst(node.returnType, sink);
        return;
    }
    if (node instanceof ProgramNode) {
        for (const expression of node.topLevelExpressions) {
            collectGenericOccurrencesFromValueAst(expression, sink);
        }
        return;
    }
    if (node instanceof SeqNode) {
        for (const expression of node.expressions) {
            collectGenericOccurrencesFromValueAst(expression, sink);
        }
        return;
    }
    if (node instanceof SetNode) {
        collectGenericOccurrencesFromValueAst(node.value, sink);
        return;
    }
    if (node instanceof TypeVarBindNode || node instanceof TypeToFromNode || node instanceof TypeUnionNode) {
        collectGenericOccurrencesFromTypeAst(node, sink);
        return;
    }
    if (node instanceof ClassNode) {
        for (const property of node.propertyNodeList) {
            collectGenericOccurrencesFromValueAst(property, sink);
        }
        for (const method of node.methodNodeList) {
            collectGenericOccurrencesFromValueAst(method, sink);
        }
        for (const ctor of node.constructorNodeList) {
            collectGenericOccurrencesFromValueAst(ctor, sink);
        }
        return;
    }
    if (node instanceof ClassPropertyNode) {
        collectGenericOccurrencesFromTypeAst(node.bind.typeExp, sink);
        return;
    }
    if (node instanceof ClassMethodNode) {
        for (const param of node.params) {
            collectGenericOccurrencesFromTypeAst(param.typeExp, sink);
        }
        collectGenericOccurrencesFromTypeAst(node.returnType, sink);
        collectGenericOccurrencesFromValueAst(node.body, sink);
        return;
    }
    if (node instanceof ClassConstructorNode) {
        for (const param of node.params) {
            collectGenericOccurrencesFromTypeAst(param.typeExp, sink);
        }
        collectGenericOccurrencesFromValueAst(node.body, sink);
        return;
    }
    if (node instanceof FunctionCallNode) {
        collectGenericOccurrencesFromValueAst(node.callee, sink);
        if (node.callee instanceof IdentifierNode && node.callee.name === "class_new" && node.args.length > 0) {
            collectGenericOccurrencesFromTypeAst(node.args[0], sink);
            for (let index = 1; index < node.args.length; index += 1) {
                collectGenericOccurrencesFromValueAst(node.args[index], sink);
            }
            return;
        }
        if (node.callee instanceof IdentifierNode && node.callee.name === "array_new" && node.args.length > 0) {
            collectGenericOccurrencesFromTypeAst(node.args[0], sink);
            for (let index = 1; index < node.args.length; index += 1) {
                collectGenericOccurrencesFromValueAst(node.args[index], sink);
            }
            return;
        }
        if (node.callee instanceof IdentifierNode && node.callee.name === "cm_get" && node.args.length >= 2) {
            collectGenericOccurrencesFromValueAst(node.args[0], sink);
            return;
        }
        if (node.callee instanceof IdentifierNode && node.callee.name === "cm_set" && node.args.length >= 3) {
            collectGenericOccurrencesFromValueAst(node.args[0], sink);
            collectGenericOccurrencesFromValueAst(node.args[2], sink);
            return;
        }
        for (const arg of node.args) {
            collectGenericOccurrencesFromValueAst(arg, sink);
        }
        return;
    }
    if (node instanceof MatchNode) {
        collectGenericOccurrencesFromValueAst(node.unionExpr, sink);
        for (const branch of node.branches) {
            collectGenericOccurrencesFromTypeAst(branch.bind.typeExp, sink);
            collectGenericOccurrencesFromValueAst(branch.body, sink);
        }
        return;
    }
    if (node instanceof ListNode) {
        for (const element of node.elements) {
            collectGenericOccurrencesFromValueAst(element, sink);
        }
    }
}

function collectGenericOccurrencesFromCodeRoots(codeRoots: readonly AstNode[]): GenericOccurrence[] {
    annotateCanonicalTagsForCodeRoots(codeRoots);
    const occurrences: GenericOccurrence[] = [];
    for (const codeRoot of codeRoots) {
        collectGenericOccurrencesFromValueAst(codeRoot, occurrences);
    }
    return occurrences;
}

function rewriteTypeVarBindWithMappings(node: TypeVarBindNode, classNameMap: ReadonlyMap<string, string>, functionNameMap: ReadonlyMap<string, string>): TypeVarBindNode {
    return new TypeVarBindNode(new IdentifierNode(node.var.name), rewriteTypeAstWithMappings(node.typeExp, classNameMap, functionNameMap));
}

function rewriteClassPropertyWithMappings(node: ClassPropertyNode, classNameMap: ReadonlyMap<string, string>, functionNameMap: ReadonlyMap<string, string>): ClassPropertyNode {
    return new ClassPropertyNode(rewriteTypeVarBindWithMappings(node.bind, classNameMap, functionNameMap));
}

function rewriteClassMethodWithMappings(node: ClassMethodNode, classNameMap: ReadonlyMap<string, string>, functionNameMap: ReadonlyMap<string, string>): ClassMethodNode {
    return new ClassMethodNode(
        new IdentifierNode(node.methodName.name),
        node.params.map((param) => rewriteTypeVarBindWithMappings(param, classNameMap, functionNameMap)),
        rewriteTypeAstWithMappings(node.returnType, classNameMap, functionNameMap),
        rewriteValueAstWithMappings(node.body, classNameMap, functionNameMap)
    );
}

function rewriteClassConstructorWithMappings(node: ClassConstructorNode, classNameMap: ReadonlyMap<string, string>, functionNameMap: ReadonlyMap<string, string>): ClassConstructorNode {
    return new ClassConstructorNode(
        node.params.map((param) => rewriteTypeVarBindWithMappings(param, classNameMap, functionNameMap)),
        rewriteValueAstWithMappings(node.body, classNameMap, functionNameMap)
    );
}

function rewriteTypeAstWithMappings(node: AstNode, classNameMap: ReadonlyMap<string, string>, functionNameMap: ReadonlyMap<string, string>): AstNode {
    if (node instanceof IdentifierNode) {
        return new IdentifierNode(node.name);
    }
    if (node instanceof TypeToFromNode) {
        return new TypeToFromNode(
            rewriteTypeAstWithMappings(node.returnType, classNameMap, functionNameMap),
            node.paramTypes.map((paramType) => rewriteTypeAstWithMappings(paramType, classNameMap, functionNameMap))
        );
    }
    if (node instanceof TypeUnionNode) {
        return new TypeUnionNode(node.types.map((typeNode) => rewriteTypeAstWithMappings(typeNode, classNameMap, functionNameMap)));
    }
    if (node instanceof GenericCallNode) {
        const rewrittenTypeArgs = node.typeArgs.map((typeArg) => rewriteTypeAstWithMappings(typeArg, classNameMap, functionNameMap));
        if (node.callee instanceof IdentifierNode) {
            if (!builtinGenericTypeNames.has(node.callee.name)) {
                const genericClassInfo = resolveGenericClassInfoForMonomorphization(node, node.callee.name, rewrittenTypeArgs.length);
                if (genericClassInfo !== undefined) {
                    const instance = new GenericClassInstanceTypeValue(genericClassInfo.genericName, rewrittenTypeArgs.map((typeArg) => astToTypeValue(typeArg)));
                    const concreteName = classNameMap.get(instance.hash());
                    if (concreteName !== undefined) {
                        return new IdentifierNode(concreteName);
                    }
                }
            }
            return new GenericCallNode(new IdentifierNode(node.callee.name), rewrittenTypeArgs);
        }
        return new GenericCallNode(rewriteValueAstWithMappings(node.callee, classNameMap, functionNameMap), rewrittenTypeArgs);
    }
    return cloneAstNode(node);
}

function rewriteFunctionCallWithMappings(node: FunctionCallNode, classNameMap: ReadonlyMap<string, string>, functionNameMap: ReadonlyMap<string, string>): FunctionCallNode {
    const rewrittenCallee = rewriteValueAstWithMappings(node.callee, classNameMap, functionNameMap);
    if (node.callee instanceof IdentifierNode && node.callee.name === "class_new" && node.args.length > 0) {
        return new FunctionCallNode(rewrittenCallee, [
            rewriteTypeAstWithMappings(node.args[0], classNameMap, functionNameMap),
            ...node.args.slice(1).map((arg) => rewriteValueAstWithMappings(arg, classNameMap, functionNameMap))
        ]);
    }
    if (node.callee instanceof IdentifierNode && node.callee.name === "array_new" && node.args.length > 0) {
        return new FunctionCallNode(rewrittenCallee, [
            rewriteTypeAstWithMappings(node.args[0], classNameMap, functionNameMap),
            ...node.args.slice(1).map((arg) => rewriteValueAstWithMappings(arg, classNameMap, functionNameMap))
        ]);
    }
    if (node.callee instanceof IdentifierNode && node.callee.name === "cm_get" && node.args.length >= 2 && node.args[1] instanceof IdentifierNode) {
        return new FunctionCallNode(rewrittenCallee, [
            rewriteValueAstWithMappings(node.args[0], classNameMap, functionNameMap),
            new IdentifierNode(node.args[1].name),
            ...node.args.slice(2).map((arg) => rewriteValueAstWithMappings(arg, classNameMap, functionNameMap))
        ]);
    }
    if (node.callee instanceof IdentifierNode && node.callee.name === "cm_set" && node.args.length >= 3 && node.args[1] instanceof IdentifierNode) {
        return new FunctionCallNode(rewrittenCallee, [
            rewriteValueAstWithMappings(node.args[0], classNameMap, functionNameMap),
            new IdentifierNode(node.args[1].name),
            rewriteValueAstWithMappings(node.args[2], classNameMap, functionNameMap),
            ...node.args.slice(3).map((arg) => rewriteValueAstWithMappings(arg, classNameMap, functionNameMap))
        ]);
    }
    return new FunctionCallNode(rewrittenCallee, node.args.map((arg) => rewriteValueAstWithMappings(arg, classNameMap, functionNameMap)));
}

function rewriteGenericCallWithMappings(node: GenericCallNode, classNameMap: ReadonlyMap<string, string>, functionNameMap: ReadonlyMap<string, string>): AstNode {
    if (!(node.callee instanceof IdentifierNode)) {
        return new GenericCallNode(
            rewriteValueAstWithMappings(node.callee, classNameMap, functionNameMap),
            node.typeArgs.map((typeArg) => rewriteTypeAstWithMappings(typeArg, classNameMap, functionNameMap))
        );
    }
    if (node.callee.name === "class_new") {
        const rewrittenClassNameNode = node.typeArgs.length > 0
            ? rewriteTypeAstWithMappings(node.typeArgs[0], classNameMap, functionNameMap)
            : new IdentifierNode("unit");
        const rewrittenClassTypeArgs = node.typeArgs.slice(1).map((typeArg) => rewriteTypeAstWithMappings(typeArg, classNameMap, functionNameMap));
        if (node.typeArgs.length > 0 && node.typeArgs[0] instanceof IdentifierNode && rewrittenClassTypeArgs.length > 0) {
            const genericClassInfo = resolveGenericClassInfoForMonomorphization(node.typeArgs[0], node.typeArgs[0].name, rewrittenClassTypeArgs.length);
            if (genericClassInfo !== undefined) {
                const instance = new GenericClassInstanceTypeValue(genericClassInfo.genericName, rewrittenClassTypeArgs.map((typeArg) => astToTypeValue(typeArg)));
                const concreteName = classNameMap.get(instance.hash());
                if (concreteName !== undefined) {
                    return new GenericCallNode(new IdentifierNode("class_new"), [new IdentifierNode(concreteName)]);
                }
            }
        }
        return new GenericCallNode(new IdentifierNode("class_new"), [rewrittenClassNameNode, ...rewrittenClassTypeArgs]);
    }
    const rewrittenTypeArgs = node.typeArgs.map((typeArg) => rewriteTypeAstWithMappings(typeArg, classNameMap, functionNameMap));
    const genericFunctionInfo = resolveGenericFunctionInfoForMonomorphization(node, node.callee.name, rewrittenTypeArgs.length);
    if (genericFunctionInfo !== undefined) {
        const instance = new GenericFunctionInstanceTypeValue(genericFunctionInfo.genericName, rewrittenTypeArgs.map((typeArg) => astToTypeValue(typeArg)));
        const concreteName = functionNameMap.get(instance.hash());
        if (concreteName !== undefined) {
            return new IdentifierNode(concreteName);
        }
        return new GenericCallNode(new IdentifierNode(node.callee.name), rewrittenTypeArgs);
    }
    if (!builtinGenericTypeNames.has(node.callee.name)) {
        const genericClassInfo = resolveGenericClassInfoForMonomorphization(node, node.callee.name, rewrittenTypeArgs.length);
        if (genericClassInfo !== undefined) {
            const instance = new GenericClassInstanceTypeValue(genericClassInfo.genericName, rewrittenTypeArgs.map((typeArg) => astToTypeValue(typeArg)));
            const concreteName = classNameMap.get(instance.hash());
            if (concreteName !== undefined) {
                return new IdentifierNode(concreteName);
            }
        }
    }
    return new GenericCallNode(new IdentifierNode(node.callee.name), rewrittenTypeArgs);
}

function rewriteValueAstWithMappings(node: AstNode, classNameMap: ReadonlyMap<string, string>, functionNameMap: ReadonlyMap<string, string>): AstNode {
    if (node instanceof ExportNode) {
        return new ExportNode(rewriteValueAstWithMappings(node.inner, classNameMap, functionNameMap));
    }
    if (node instanceof IdentifierNode || node instanceof TextDatabaseReferenceNode || node instanceof NumberLiteralNode || node instanceof ImportNode) {
        return cloneAstNode(node);
    }
    if (node instanceof GenericNameNode) {
        return cloneAstNode(node);
    }
    if (node instanceof GenericCallNode) {
        return rewriteGenericCallWithMappings(node, classNameMap, functionNameMap);
    }
    if (node instanceof ListNode) {
        return new ListNode(node.elements.map((element) => rewriteValueAstWithMappings(element, classNameMap, functionNameMap)));
    }
    if (node instanceof FnNode) {
        return new FnNode(
            node.params.map((param) => rewriteTypeVarBindWithMappings(param, classNameMap, functionNameMap)),
            rewriteTypeAstWithMappings(node.returnType, classNameMap, functionNameMap),
            rewriteValueAstWithMappings(node.body, classNameMap, functionNameMap)
        );
    }
    if (node instanceof LetNode) {
        return new LetNode(
            node.bindings.map((binding) => ({
                bind: binding.bind instanceof TypeVarBindNode
                    ? rewriteTypeVarBindWithMappings(binding.bind, classNameMap, functionNameMap)
                    : rewriteValueAstWithMappings(binding.bind, classNameMap, functionNameMap),
                value: rewriteValueAstWithMappings(binding.value, classNameMap, functionNameMap)
            })),
            rewriteValueAstWithMappings(node.body, classNameMap, functionNameMap)
        );
    }
    if (node instanceof IfNode) {
        return new IfNode(
            rewriteValueAstWithMappings(node.condExpr, classNameMap, functionNameMap),
            rewriteValueAstWithMappings(node.trueBranchExpr, classNameMap, functionNameMap),
            rewriteValueAstWithMappings(node.falseBranchExpr, classNameMap, functionNameMap)
        );
    }
    if (node instanceof WhileNode) {
        return new WhileNode(
            rewriteValueAstWithMappings(node.condExpr, classNameMap, functionNameMap),
            rewriteValueAstWithMappings(node.bodyExpr, classNameMap, functionNameMap)
        );
    }
    if (node instanceof CondNode) {
        return new CondNode(node.clausesExprs.map((clause) => ({
            cond: rewriteValueAstWithMappings(clause.cond, classNameMap, functionNameMap),
            body: rewriteValueAstWithMappings(clause.body, classNameMap, functionNameMap)
        })));
    }
    if (node instanceof DvarNode) {
        return new DvarNode(
            node.bind instanceof TypeVarBindNode
                ? rewriteTypeVarBindWithMappings(node.bind, classNameMap, functionNameMap)
                : rewriteValueAstWithMappings(node.bind, classNameMap, functionNameMap),
            rewriteValueAstWithMappings(node.value, classNameMap, functionNameMap)
        );
    }
    if (node instanceof DfunNode) {
        return new DfunNode(
            new IdentifierNode(node.name.name),
            node.params.map((param) => rewriteTypeVarBindWithMappings(param, classNameMap, functionNameMap)),
            rewriteTypeAstWithMappings(node.returnType, classNameMap, functionNameMap),
            rewriteValueAstWithMappings(node.body, classNameMap, functionNameMap)
        );
    }
    if (node instanceof DeclaredDfunNode) {
        return new DeclaredDfunNode(
            new IdentifierNode(node.name.name),
            node.params.map((param) => rewriteTypeVarBindWithMappings(param, classNameMap, functionNameMap)),
            rewriteTypeAstWithMappings(node.returnType, classNameMap, functionNameMap)
        );
    }
    if (node instanceof ProgramNode) {
        return new ProgramNode(node.topLevelExpressions.map((expression) => rewriteValueAstWithMappings(expression, classNameMap, functionNameMap)), node.unitId);
    }
    if (node instanceof SeqNode) {
        return new SeqNode(node.expressions.map((expression) => rewriteValueAstWithMappings(expression, classNameMap, functionNameMap)));
    }
    if (node instanceof SetNode) {
        return new SetNode(new IdentifierNode(node.identifier.name), rewriteValueAstWithMappings(node.value, classNameMap, functionNameMap));
    }
    if (node instanceof TypeVarBindNode || node instanceof TypeToFromNode || node instanceof TypeUnionNode) {
        return rewriteTypeAstWithMappings(node, classNameMap, functionNameMap);
    }
    if (node instanceof ClassPropertyNode) {
        return rewriteClassPropertyWithMappings(node, classNameMap, functionNameMap);
    }
    if (node instanceof ClassMethodNode) {
        return rewriteClassMethodWithMappings(node, classNameMap, functionNameMap);
    }
    if (node instanceof ClassConstructorNode) {
        return rewriteClassConstructorWithMappings(node, classNameMap, functionNameMap);
    }
    if (node instanceof ClassNode) {
        return new ClassNode(
            new IdentifierNode(node.name.name),
            node.constructorNodeList.map((ctor) => rewriteClassConstructorWithMappings(ctor, classNameMap, functionNameMap)),
            node.methodNodeList.map((method) => rewriteClassMethodWithMappings(method, classNameMap, functionNameMap)),
            node.propertyNodeList.map((property) => rewriteClassPropertyWithMappings(property, classNameMap, functionNameMap))
        );
    }
    if (node instanceof FunctionCallNode) {
        return rewriteFunctionCallWithMappings(node, classNameMap, functionNameMap);
    }
    if (node instanceof MatchNode) {
        return new MatchNode(
            rewriteValueAstWithMappings(node.unionExpr, classNameMap, functionNameMap),
            node.branches.map((branch) => ({
                bind: rewriteTypeVarBindWithMappings(branch.bind, classNameMap, functionNameMap),
                body: rewriteValueAstWithMappings(branch.body, classNameMap, functionNameMap)
            }))
        );
    }
    return cloneAstNode(node);
}

function buildClassNameMap(classSeeds: readonly GeneratedClassSeed[]): Map<string, string> {
    const classNameMap = new Map<string, string>();
    for (const seed of classSeeds) {
        classNameMap.set(seed.instance.hash(), seed.classNode.name.name);
    }
    return classNameMap;
}

function buildFunctionNameMap(functionSeeds: readonly GeneratedFunctionSeed[]): Map<string, string> {
    const functionNameMap = new Map<string, string>();
    for (const seed of functionSeeds) {
        functionNameMap.set(seed.instance.hash(), seed.functionNode.name.name);
    }
    return functionNameMap;
}

function getOrderedClassSeeds(classSeedTable: ReadonlyMap<string, GeneratedClassSeed>): GeneratedClassSeed[] {
    return Array.from(classSeedTable.values()).sort((left, right) => left.instance.hash().localeCompare(right.instance.hash()));
}

function getOrderedFunctionSeeds(functionSeedTable: ReadonlyMap<string, GeneratedFunctionSeed>): GeneratedFunctionSeed[] {
    return Array.from(functionSeedTable.values()).sort((left, right) => left.instance.hash().localeCompare(right.instance.hash()));
}

function rewriteAllCodeRoots(
    baseCodeRoots: readonly AstNode[],
    classSeedTable: ReadonlyMap<string, GeneratedClassSeed>,
    functionSeedTable: ReadonlyMap<string, GeneratedFunctionSeed>,
    extraClassNameMap: ReadonlyMap<string, string> = new Map(),
    extraFunctionNameMap: ReadonlyMap<string, string> = new Map()
): {
    readonly rewrittenBaseCodeRoots: AstNode[];
    readonly rewrittenClassSeeds: ClassNode[];
    readonly rewrittenFunctionSeeds: DfunNode[];
} {
    const orderedClassSeeds = getOrderedClassSeeds(classSeedTable);
    const orderedFunctionSeeds = getOrderedFunctionSeeds(functionSeedTable);
    const classNameMap = buildClassNameMap(orderedClassSeeds);
    const functionNameMap = buildFunctionNameMap(orderedFunctionSeeds);
    extraClassNameMap.forEach((concreteName, instanceHash) => classNameMap.set(instanceHash, concreteName));
    extraFunctionNameMap.forEach((concreteName, instanceHash) => functionNameMap.set(instanceHash, concreteName));

    return {
        rewrittenBaseCodeRoots: baseCodeRoots.map((codeRoot) => {
            const rewrittenRoot = rewriteValueAstWithMappings(codeRoot, classNameMap, functionNameMap);
            copyCompilationUnitMetadata(codeRoot, rewrittenRoot);
            return rewrittenRoot;
        }),
        rewrittenClassSeeds: orderedClassSeeds.map((seed) => {
            const rewrittenSeed = rewriteValueAstWithMappings(seed.classNode, classNameMap, functionNameMap);
            copyCompilationUnitMetadata(seed.classNode, rewrittenSeed);
            return rewrittenSeed;
        }).filter((node): node is ClassNode => node instanceof ClassNode),
        rewrittenFunctionSeeds: orderedFunctionSeeds.map((seed) => {
            const rewrittenSeed = rewriteValueAstWithMappings(seed.functionNode, classNameMap, functionNameMap);
            copyCompilationUnitMetadata(seed.functionNode, rewrittenSeed);
            return rewrittenSeed;
        }).filter((node): node is DfunNode => node instanceof DfunNode)
    };
}

function materializeGenericClassSeed(instance: GenericClassInstanceTypeValue): GeneratedClassSeed {
    const resolvedGenericClass = getResolvedGenericClassInfo(instance.genericName, instance.typeArgs.length);
    if (resolvedGenericClass === undefined) {
        throw new Error(`unknown generic class during monomorphization: ${instance.genericName}`);
    }
    const substitutions = buildSubstitutionMap(resolvedGenericClass.typeParams, instance.typeArgs);
    const concreteName = getMonomorphizedClassName(instance);
    const classNode = new ClassNode(
        new IdentifierNode(concreteName),
        resolvedGenericClass.source.constructors.map((ctor) => substituteClassConstructorTemplate(ctor, substitutions)),
        resolvedGenericClass.source.methods.map((method) => substituteClassMethodTemplate(method, substitutions)),
        resolvedGenericClass.source.properties.map((property) => substituteClassPropertyTemplate(property, substitutions))
    );
    const metadata = buildCompilationUnitMetadataFromSourceInfo(resolvedGenericClass.source);
    if (metadata !== undefined) {
        annotateAstWithCompilationUnitMetadata(classNode, metadata);
    }
    return new GeneratedClassSeed(
        instance,
        classNode
    );
}

function materializeGenericFunctionSeed(instance: GenericFunctionInstanceTypeValue): GeneratedFunctionSeed {
    const resolvedGenericFunction = getResolvedGenericFunctionInfo(instance.genericName, instance.typeArgs.length);
    if (resolvedGenericFunction === undefined) {
        throw new Error(`unknown generic function during monomorphization: ${instance.genericName}`);
    }
    const substitutions = buildSubstitutionMap(resolvedGenericFunction.typeParams, instance.typeArgs);
    const functionNode = new DfunNode(
        new IdentifierNode(getMonomorphizedFunctionName(instance)),
        resolvedGenericFunction.source.paramTypes.map((param) => substituteBindNodeTemplate(param, substitutions)),
        substituteTypeAstTemplate(resolvedGenericFunction.source.returnType, substitutions),
        substituteValueAstTemplate(resolvedGenericFunction.source.body, substitutions)
    );
    const metadata = buildCompilationUnitMetadataFromSourceInfo(resolvedGenericFunction.source);
    if (metadata !== undefined) {
        annotateAstWithCompilationUnitMetadata(functionNode, metadata);
    }
    return new GeneratedFunctionSeed(
        instance,
        functionNode
    );
}

function buildFinalClassInfo(seed: GeneratedClassSeed): MonomorphizedClassInfo {
    const propertyTypes = new Map<string, TypeValue>();
    for (const property of seed.classNode.propertyNodeList) {
        propertyTypes.set(property.bind.var.name, astToTypeValue(property.bind.typeExp));
    }
    const methodTypes = new Map<string, FunctionTypeValue>();
    for (const method of seed.classNode.methodNodeList) {
        methodTypes.set(
            method.methodName.name,
            new FunctionTypeValue(
                method.params.map((param) => astToTypeValue(param.typeExp)),
                astToTypeValue(method.returnType)
            )
        );
    }
    const constructorParamTypes = seed.classNode.constructorNodeList.map((ctor) => ctor.params.map((param) => astToTypeValue(param.typeExp)));
    return {
        concreteName: seed.classNode.name.name,
        instanceHash: seed.instance.hash(),
        sourceGenericName: seed.instance.genericName,
        typeArgs: [...seed.instance.typeArgs],
        classNode: seed.classNode,
        propertyTypes,
        methodTypes,
        constructorParamTypes
    };
}

function buildFinalFunctionInfo(seed: GeneratedFunctionSeed): MonomorphizedFunctionInfo {
    return {
        concreteName: seed.functionNode.name.name,
        instanceHash: seed.instance.hash(),
        sourceGenericName: seed.instance.genericName,
        typeArgs: [...seed.instance.typeArgs],
        functionNode: seed.functionNode,
        functionType: new FunctionTypeValue(
            seed.functionNode.params.map((param) => astToTypeValue(param.typeExp)),
            astToTypeValue(seed.functionNode.returnType)
        )
    };
}

function buildConcreteProgram(originalAst: AstNode, baseCodeRoots: readonly AstNode[], classSeedTable: ReadonlyMap<string, GeneratedClassSeed>, functionSeedTable: ReadonlyMap<string, GeneratedFunctionSeed>): ProgramNode {
    const unitId = originalAst instanceof ProgramNode ? originalAst.unitId : null;
    return new ProgramNode(
        [
            ...baseCodeRoots,
            ...getOrderedClassSeeds(classSeedTable).map((seed) => seed.classNode),
            ...getOrderedFunctionSeeds(functionSeedTable).map((seed) => seed.functionNode)
        ],
        unitId
    );
}

function rebuildInstanceTables(classSeedTable: ReadonlyMap<string, GeneratedClassSeed>, functionSeedTable: ReadonlyMap<string, GeneratedFunctionSeed>): void {
    genericClassInstanceTable.clear();
    genericFunctionInstanceTable.clear();
    for (const seed of classSeedTable.values()) {
        genericClassInstanceTable.set(seed.instance.hash(), seed.instance);
    }
    for (const seed of functionSeedTable.values()) {
        genericFunctionInstanceTable.set(seed.instance.hash(), seed.instance);
    }
}

function synchronizeSeedNodes(classSeedTable: ReadonlyMap<string, GeneratedClassSeed>, rewrittenClassSeeds: readonly ClassNode[], functionSeedTable: ReadonlyMap<string, GeneratedFunctionSeed>, rewrittenFunctionSeeds: readonly DfunNode[]): void {
    const orderedClassSeeds = getOrderedClassSeeds(classSeedTable);
    for (let index = 0; index < orderedClassSeeds.length; index += 1) {
        orderedClassSeeds[index].classNode = rewrittenClassSeeds[index];
    }
    const orderedFunctionSeeds = getOrderedFunctionSeeds(functionSeedTable);
    for (let index = 0; index < orderedFunctionSeeds.length; index += 1) {
        orderedFunctionSeeds[index].functionNode = rewrittenFunctionSeeds[index];
    }
}

function chooseRepresentativePendingOccurrence(occurrences: readonly GenericOccurrence[], concreteClassNames: ReadonlySet<string>): GenericOccurrence | null {
    for (const occurrence of occurrences) {
        if (occurrence.instance.typeArgs.every((typeArg) => isEndType(typeArg, concreteClassNames))) {
            return occurrence;
        }
    }
    return occurrences.length > 0 ? occurrences[0] : null;
}

export function resetMonomorphizedTables(): void {
    monomorphizedClassTable.clear();
    monomorphizedFunctionTable.clear();
    monomorphizedConcreteProgram = null;
}

export function getMonomorphizedClassName(instance: GenericClassInstanceTypeValue): string {
    const precompiledLookup = lookupPrecompiledClassMonomorph(instance.hash());
    if (precompiledLookup !== undefined) {
        return precompiledLookup.concreteName;
    }
    return `${MONOMORPHIZED_CLASS_PREFIX}_${instance.genericName}_${instanceSuffix(instance.hash())}`;
}

export function getMonomorphizedFunctionName(instance: GenericFunctionInstanceTypeValue): string {
    const precompiledLookup = lookupPrecompiledFunctionMonomorph(instance.hash());
    if (precompiledLookup !== undefined) {
        return precompiledLookup.concreteName;
    }
    return `${MONOMORPHIZED_FUNCTION_PREFIX}_${instance.genericName}_${instanceSuffix(instance.hash())}`;
}

export function getMonomorphizedClassInfo(instance: GenericClassInstanceTypeValue): MonomorphizedClassInfo | undefined {
    return monomorphizedClassTable.get(getMonomorphizedClassName(instance));
}

export function getMonomorphizedFunctionInfo(instance: GenericFunctionInstanceTypeValue): MonomorphizedFunctionInfo | undefined {
    return monomorphizedFunctionTable.get(getMonomorphizedFunctionName(instance));
}

export function getMonomorphizedArtifacts(): MonomorphizedArtifacts {
    return {
        classes: monomorphizedClassTable,
        functions: monomorphizedFunctionTable
    };
}

export function getMonomorphizedConcreteProgram(): ProgramNode {
    if (monomorphizedConcreteProgram === null) {
        throw new Error("Monomorphized concrete program is not available before monomorphization runs");
    }
    return monomorphizedConcreteProgram;
}

export function getMonomorphizedProgramNodes(): AstNode[] {
    const classNodes = Array.from(monomorphizedClassTable.values())
        .sort((left, right) => left.concreteName.localeCompare(right.concreteName))
        .map((info) => info.classNode);
    const functionNodes = Array.from(monomorphizedFunctionTable.values())
        .sort((left, right) => left.concreteName.localeCompare(right.concreteName))
        .map((info) => info.functionNode);
    return [...classNodes, ...functionNodes];
}

export function formatMonomorphizedAst(node: AstNode): string {
    if (node instanceof ExportNode) {
        return `(export ${formatMonomorphizedAst(node.inner)})`;
    }
    if (node instanceof IdentifierNode) {
        return node.name;
    }
    if (node instanceof TextDatabaseReferenceNode) {
        return node.referenceName;
    }
    if (node instanceof NumberLiteralNode) {
        return node.raw;
    }
    if (node instanceof TypeVarBindNode) {
        return `[${formatMonomorphizedAst(node.var)} ${formatMonomorphizedAst(node.typeExp)}]`;
    }
    if (node instanceof TypeToFromNode) {
        return `<to ${formatMonomorphizedAst(node.returnType)} from ${node.paramTypes.map((paramType) => formatMonomorphizedAst(paramType)).join(" ")}>`;
    }
    if (node instanceof TypeUnionNode) {
        return `<union ${node.types.map((typeNode) => formatMonomorphizedAst(typeNode)).join(" ")}>`;
    }
    if (node instanceof GenericCallNode) {
        return `<${formatMonomorphizedAst(node.callee)} ${node.typeArgs.map((typeArg) => formatMonomorphizedAst(typeArg)).join(" ")}>`;
    }
    if (node instanceof FnNode) {
        return `(fn (${node.params.map((param) => formatMonomorphizedAst(param)).join(" ")}) to ${formatMonomorphizedAst(node.returnType)} in ${formatMonomorphizedAst(node.body)})`;
    }
    if (node instanceof LetNode) {
        return `(let (${node.bindings.map((binding) => `(${formatMonomorphizedAst(binding.bind)} ${formatMonomorphizedAst(binding.value)})`).join(" ")}) in ${formatMonomorphizedAst(node.body)})`;
    }
    if (node instanceof IfNode) {
        return `(if ${formatMonomorphizedAst(node.condExpr)} then ${formatMonomorphizedAst(node.trueBranchExpr)} else ${formatMonomorphizedAst(node.falseBranchExpr)})`;
    }
    if (node instanceof WhileNode) {
        return `(while ${formatMonomorphizedAst(node.condExpr)} in ${formatMonomorphizedAst(node.bodyExpr)})`;
    }
    if (node instanceof CondNode) {
        return `(cond ${node.clausesExprs.map((clause) => `(${formatMonomorphizedAst(clause.cond)} ${formatMonomorphizedAst(clause.body)})`).join(" ")})`;
    }
    if (node instanceof DvarNode) {
        return `(var ${formatMonomorphizedAst(node.bind)} ${formatMonomorphizedAst(node.value)})`;
    }
    if (node instanceof DfunNode) {
        return `(function ${formatMonomorphizedAst(node.name)} (${node.params.map((param) => formatMonomorphizedAst(param)).join(" ")}) to ${formatMonomorphizedAst(node.returnType)} in ${formatMonomorphizedAst(node.body)})`;
    }
    if (node instanceof DeclaredDfunNode) {
        return `(declare (dfun ${formatMonomorphizedAst(node.name)} (${node.params.map((param) => formatMonomorphizedAst(param)).join(" ")}) to ${formatMonomorphizedAst(node.returnType)}))`;
    }
    if (node instanceof ProgramNode) {
        const parts: string[] = ["program"];
        if (node.unitId !== null) {
            parts.push(node.unitId.name);
        }
        parts.push(...node.topLevelExpressions.map((expression) => formatMonomorphizedAst(expression)));
        return `{${parts.join(" ")}}`;
    }
    if (node instanceof SeqNode) {
        return `{${node.expressions.map((expression) => formatMonomorphizedAst(expression)).join(" ")}}`;
    }
    if (node instanceof SetNode) {
        return `(var_set ${formatMonomorphizedAst(node.identifier)} ${formatMonomorphizedAst(node.value)})`;
    }
    if (node instanceof ClassPropertyNode) {
        return `(property ${formatMonomorphizedAst(node.bind)})`;
    }
    if (node instanceof ClassMethodNode) {
        return `(method ${formatMonomorphizedAst(node.methodName)} (${node.params.map((param) => formatMonomorphizedAst(param)).join(" ")}) to ${formatMonomorphizedAst(node.returnType)} in ${formatMonomorphizedAst(node.body)})`;
    }
    if (node instanceof ClassConstructorNode) {
        return `(constructor (${node.params.map((param) => formatMonomorphizedAst(param)).join(" ")}) in ${formatMonomorphizedAst(node.body)})`;
    }
    if (node instanceof ClassNode) {
        return `(class ${formatMonomorphizedAst(node.name)} ${[
            ...node.propertyNodeList.map((property) => formatMonomorphizedAst(property)),
            ...node.methodNodeList.map((method) => formatMonomorphizedAst(method)),
            ...node.constructorNodeList.map((ctor) => formatMonomorphizedAst(ctor))
        ].join(" ")})`;
    }
    if (node instanceof FunctionCallNode) {
        return `(${formatMonomorphizedAst(node.callee)} ${node.args.map((arg) => formatMonomorphizedAst(arg)).join(" ")})`;
    }
    if (node instanceof MatchNode) {
        return `(match ${formatMonomorphizedAst(node.unionExpr)} ${node.branches.map((branch) => `(${formatMonomorphizedAst(branch.bind)} ${formatMonomorphizedAst(branch.body)})`).join(" ")})`;
    }
    if (node instanceof ListNode) {
        return `(${node.elements.map((element) => formatMonomorphizedAst(element)).join(" ")})`;
    }
    if (node instanceof ImportNode) {
        return `(import ${formatMonomorphizedAst(node.packagePath)})`;
    }
    throw new Error(`Unsupported monomorphized AST node kind: ${node.kind}`);
}

export function materializeMonomorphizedDefinitionsPass(programAst: AstNode, options?: MonomorphizationMaterializeOptions): MonomorphizedArtifacts {
    resetMonomorphizedTables();

    const maxExpansionRounds = options?.maxExpansionRounds ?? DEFAULT_MONOMORPHIZATION_MAX_ROUNDS;
    ensurePositiveMaxRounds(maxExpansionRounds);

    let baseCodeRoots = collectInitialConcreteCodeRoots(programAst);
    const concreteClassNames = collectKnownConcreteClassNames(baseCodeRoots);
    const classSeedTable = new Map<string, GeneratedClassSeed>();
    const functionSeedTable = new Map<string, GeneratedFunctionSeed>();
    const precompiledResolvedClassMap = new Map<string, string>();
    const precompiledResolvedFunctionMap = new Map<string, string>();

    for (let round = 1; round <= maxExpansionRounds; round += 1) {
        const codeRoots = [
            ...baseCodeRoots,
            ...getOrderedClassSeeds(classSeedTable).map((seed) => seed.classNode),
            ...getOrderedFunctionSeeds(functionSeedTable).map((seed) => seed.functionNode)
        ];
        const occurrences = collectGenericOccurrencesFromCodeRoots(codeRoots)
            .sort((left, right) => left.instance.hash().localeCompare(right.instance.hash()) || left.tag.localeCompare(right.tag));
        if (occurrences.length === 0) {
            break;
        }

        let createdNewSeed = false;
        const availableClassNameMap = buildClassNameMap(getOrderedClassSeeds(classSeedTable));
        const availableFunctionNameMap = buildFunctionNameMap(getOrderedFunctionSeeds(functionSeedTable));
        precompiledResolvedClassMap.forEach((concreteName, instanceHash) => availableClassNameMap.set(instanceHash, concreteName));
        precompiledResolvedFunctionMap.forEach((concreteName, instanceHash) => availableFunctionNameMap.set(instanceHash, concreteName));

        for (const occurrence of occurrences) {
            if (occurrence.kind === "class" && occurrence.instance instanceof GenericClassInstanceTypeValue && isPrecompiledGenericClassName(occurrence.instance.genericName)) {
                const resolution = resolvePrecompiledClassOccurrence(occurrence.instance, availableClassNameMap);
                if (resolution.kind === "missing") {
                    throw new Error(`precompiled lib is missing monomorphized class for ${printTypeValue(resolution.instance)}`);
                }
                if (resolution.kind === "resolved") {
                    if (!precompiledResolvedClassMap.has(occurrence.instance.hash())) {
                        precompiledResolvedClassMap.set(occurrence.instance.hash(), resolution.concreteName);
                        precompiledResolvedClassMap.set(resolution.instanceHash, resolution.concreteName);
                        availableClassNameMap.set(occurrence.instance.hash(), resolution.concreteName);
                        availableClassNameMap.set(resolution.instanceHash, resolution.concreteName);
                        concreteClassNames.add(resolution.concreteName);
                        createdNewSeed = true;
                    }
                    continue;
                }
            }
            if (occurrence.kind === "function" && occurrence.instance instanceof GenericFunctionInstanceTypeValue && isPrecompiledGenericFunctionName(occurrence.instance.genericName)) {
                const resolution = resolvePrecompiledFunctionOccurrence(occurrence.instance, availableClassNameMap, availableFunctionNameMap);
                if (resolution.kind === "missing") {
                    throw new Error(`precompiled lib is missing monomorphized function for ${printTypeValue(resolution.instance)}`);
                }
                if (resolution.kind === "resolved") {
                    if (!precompiledResolvedFunctionMap.has(occurrence.instance.hash())) {
                        precompiledResolvedFunctionMap.set(occurrence.instance.hash(), resolution.concreteName);
                        precompiledResolvedFunctionMap.set(resolution.instanceHash, resolution.concreteName);
                        availableFunctionNameMap.set(occurrence.instance.hash(), resolution.concreteName);
                        availableFunctionNameMap.set(resolution.instanceHash, resolution.concreteName);
                        createdNewSeed = true;
                    }
                    continue;
                }
            }

            if (!occurrence.instance.typeArgs.every((typeArg) => isEndType(typeArg, concreteClassNames))) {
                continue;
            }
            if (occurrence.kind === "class" && occurrence.instance instanceof GenericClassInstanceTypeValue) {
                if (classSeedTable.has(occurrence.instance.hash())) {
                    continue;
                }
                const classSeed = materializeGenericClassSeed(occurrence.instance);
                classSeedTable.set(occurrence.instance.hash(), classSeed);
                concreteClassNames.add(classSeed.classNode.name.name);
                availableClassNameMap.set(occurrence.instance.hash(), classSeed.classNode.name.name);
                createdNewSeed = true;
                continue;
            }
            if (occurrence.kind === "function" && occurrence.instance instanceof GenericFunctionInstanceTypeValue) {
                if (functionSeedTable.has(occurrence.instance.hash())) {
                    continue;
                }
                const functionSeed = materializeGenericFunctionSeed(occurrence.instance);
                functionSeedTable.set(occurrence.instance.hash(), functionSeed);
                availableFunctionNameMap.set(occurrence.instance.hash(), functionSeed.functionNode.name.name);
                createdNewSeed = true;
            }
        }

        const rewriteResult = rewriteAllCodeRoots(baseCodeRoots, classSeedTable, functionSeedTable, precompiledResolvedClassMap, precompiledResolvedFunctionMap);
        baseCodeRoots = rewriteResult.rewrittenBaseCodeRoots;
        synchronizeSeedNodes(classSeedTable, rewriteResult.rewrittenClassSeeds, functionSeedTable, rewriteResult.rewrittenFunctionSeeds);

        const rewrittenCodeRoots = [
            ...baseCodeRoots,
            ...getOrderedClassSeeds(classSeedTable).map((seed) => seed.classNode),
            ...getOrderedFunctionSeeds(functionSeedTable).map((seed) => seed.functionNode)
        ];
        const remainingOccurrences = collectGenericOccurrencesFromCodeRoots(rewrittenCodeRoots);
        if (remainingOccurrences.length === 0) {
            break;
        }
        if (round === maxExpansionRounds || !createdNewSeed) {
            const sampleOccurrence = chooseRepresentativePendingOccurrence(remainingOccurrences, concreteClassNames);
            if (sampleOccurrence === null) {
                throw new Error(`generic monomorphization may not terminate: expansion exceeded ${maxExpansionRounds} rounds`);
            }
            throw new Error(
                `generic monomorphization may not terminate: expansion exceeded ${maxExpansionRounds} rounds near ${sampleOccurrence.tag} while expanding ${printTypeValue(sampleOccurrence.instance)}`
            );
        }
    }

    rebuildInstanceTables(classSeedTable, functionSeedTable);

    for (const seed of getOrderedClassSeeds(classSeedTable)) {
        const info = buildFinalClassInfo(seed);
        monomorphizedClassTable.set(info.concreteName, info);
    }
    for (const seed of getOrderedFunctionSeeds(functionSeedTable)) {
        const info = buildFinalFunctionInfo(seed);
        monomorphizedFunctionTable.set(info.concreteName, info);
    }

    monomorphizedConcreteProgram = buildConcreteProgram(programAst, baseCodeRoots, classSeedTable, functionSeedTable);
    return getMonomorphizedArtifacts();
}
