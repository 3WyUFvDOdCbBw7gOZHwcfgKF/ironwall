import { getVisibleGenericClassInfo, getVisibleGenericFunctionInfo, hasGenericClassInfo, hasGenericFunctionInfo } from "./Typecheck-Definitions";
import { getResolvedGenericClassInfo, getResolvedGenericFunctionInfo, resolvedGenericClassTable, resolvedGenericFunctionTable } from "./Typecheck-Pass-2-ResolveHeaders";
import { genericClassInstanceTable, genericFunctionInstanceTable } from "./Typecheck-Pass-4-CollectInstantiations";
import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    ClassPropertyNode,
    CondNode,
    DfunNode,
    DvarNode,
    ExportNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    GenericNameNode,
    IdentifierNode,
    IfNode,
    WhileNode,
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
    TypeVarBindNode
} from "./AstNode";
import {
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    GenericFunctionInstanceTypeValue,
    GenericTypeEnv,
    TypeParameterValue,
    TypeValue,
    UnionTypeValue,
    substituteTypeVariables
} from "./TypeSystem";
import { astToTypeValue } from "./Typecheck-TypeAst";

export const DEFAULT_MONOMORPHIZATION_MAX_ROUNDS = 5;

export interface MonomorphizationOptions {
    readonly maxExpansionRounds?: number;
}

interface GenericDependencyEdge {
    readonly targetKind: "class" | "function";
    readonly targetName: string;
    readonly typeArgTemplates: TypeValue[];
}

function genericOverloadKey(name: string, arity: number): string {
    return `${name}#arity${arity}`;
}

function isConcreteType(type: TypeValue): boolean {
    if (type instanceof TypeParameterValue) {
        return false;
    }
    if (type instanceof FunctionTypeValue) {
        return type.paramTypes.every(isConcreteType) && isConcreteType(type.returnType);
    }
    if (type instanceof UnionTypeValue) {
        return type.types.every(isConcreteType);
    }
    if (type instanceof GenericClassInstanceTypeValue || type instanceof GenericFunctionInstanceTypeValue) {
        return type.typeArgs.every(isConcreteType);
    }
    return true;
}

function ensureConcreteTypeArgs(typeArgs: readonly TypeValue[], context: string): void {
    for (const typeArg of typeArgs) {
        if (!isConcreteType(typeArg)) {
            throw new Error(`${context}: type arguments must be statically known`);
        }
    }
}

function makeTypeParamEnv(typeParams: readonly string[]): GenericTypeEnv {
    const env = new GenericTypeEnv();
    for (const typeParam of typeParams) {
        env.set(typeParam, new TypeParameterValue(typeParam));
    }
    return env;
}

function addDependencyEdge(
    edges: GenericDependencyEdge[],
    seen: Set<string>,
    targetKind: "class" | "function",
    targetName: string,
    typeArgTemplates: TypeValue[]
): void {
    const key = `${targetKind}:${targetName}<${typeArgTemplates.map((typeArg) => typeArg.hash()).join(",")}>`;
    if (seen.has(key)) {
        return;
    }
    seen.add(key);
    edges.push({ targetKind, targetName, typeArgTemplates });
}

function collectDependencyEdgesFromAst(
    node: AstNode,
    typeEnv: GenericTypeEnv,
    edges: GenericDependencyEdge[],
    seen: Set<string>
): void {
    if (node instanceof IdentifierNode || node instanceof TextDatabaseReferenceNode || node instanceof NumberLiteralNode || node instanceof GenericNameNode) {
        return;
    }
    if (node instanceof ExportNode) {
        collectDependencyEdgesFromAst(node.inner, typeEnv, edges, seen);
        return;
    }
    if (node instanceof GenericCallNode) {
        if (node.callee instanceof IdentifierNode) {
            const targetName = node.callee.name;
            if (targetName === "class_new") {
                const [classNameNode, ...constructorTypeArgs] = node.typeArgs;
                if (classNameNode instanceof IdentifierNode) {
                    const genericClassInfo = getVisibleGenericClassInfo(classNameNode, classNameNode.name, constructorTypeArgs.length);
                    if (genericClassInfo) {
                    addDependencyEdge(
                        edges,
                        seen,
                        "class",
                        genericClassInfo.genericName,
                        constructorTypeArgs.map((typeArg) => astToTypeValue(typeArg, typeEnv))
                    );
                    }
                }
                node.typeArgs.forEach((typeArg) => collectDependencyEdgesFromAst(typeArg, typeEnv, edges, seen));
                return;
            }
            const typeArgTemplates = node.typeArgs.map((typeArg) => astToTypeValue(typeArg, typeEnv));
            const genericClassInfo = getVisibleGenericClassInfo(node, targetName, typeArgTemplates.length);
            if (genericClassInfo) {
                addDependencyEdge(edges, seen, "class", genericClassInfo.genericName, typeArgTemplates);
            }
            const genericFunctionInfo = getVisibleGenericFunctionInfo(node, targetName, typeArgTemplates.length);
            if (genericFunctionInfo) {
                addDependencyEdge(edges, seen, "function", genericFunctionInfo.genericName, typeArgTemplates);
            }
        }
        collectDependencyEdgesFromAst(node.callee, typeEnv, edges, seen);
        node.typeArgs.forEach((typeArg) => collectDependencyEdgesFromAst(typeArg, typeEnv, edges, seen));
        return;
    }
    if (node instanceof ListNode) {
        node.elements.forEach((element) => collectDependencyEdgesFromAst(element, typeEnv, edges, seen));
        return;
    }
    if (node instanceof FnNode) {
        node.params.forEach((param) => collectDependencyEdgesFromAst(param, typeEnv, edges, seen));
        collectDependencyEdgesFromAst(node.returnType, typeEnv, edges, seen);
        collectDependencyEdgesFromAst(node.body, typeEnv, edges, seen);
        return;
    }
    if (node instanceof LetNode) {
        node.bindings.forEach((binding) => {
            collectDependencyEdgesFromAst(binding.bind, typeEnv, edges, seen);
            collectDependencyEdgesFromAst(binding.value, typeEnv, edges, seen);
        });
        collectDependencyEdgesFromAst(node.body, typeEnv, edges, seen);
        return;
    }
    if (node instanceof IfNode) {
        collectDependencyEdgesFromAst(node.condExpr, typeEnv, edges, seen);
        collectDependencyEdgesFromAst(node.trueBranchExpr, typeEnv, edges, seen);
        collectDependencyEdgesFromAst(node.falseBranchExpr, typeEnv, edges, seen);
        return;
    }
    if (node instanceof WhileNode) {
        collectDependencyEdgesFromAst(node.condExpr, typeEnv, edges, seen);
        collectDependencyEdgesFromAst(node.bodyExpr, typeEnv, edges, seen);
        return;
    }
    if (node instanceof CondNode) {
        node.clausesExprs.forEach((clause) => {
            collectDependencyEdgesFromAst(clause.cond, typeEnv, edges, seen);
            collectDependencyEdgesFromAst(clause.body, typeEnv, edges, seen);
        });
        return;
    }
    if (node instanceof DvarNode) {
        collectDependencyEdgesFromAst(node.bind, typeEnv, edges, seen);
        collectDependencyEdgesFromAst(node.value, typeEnv, edges, seen);
        return;
    }
    if (node instanceof DfunNode) {
        node.params.forEach((param) => collectDependencyEdgesFromAst(param, typeEnv, edges, seen));
        collectDependencyEdgesFromAst(node.returnType, typeEnv, edges, seen);
        collectDependencyEdgesFromAst(node.body, typeEnv, edges, seen);
        return;
    }
    if (node instanceof ProgramNode) {
        node.topLevelExpressions.forEach((expression) => collectDependencyEdgesFromAst(expression, typeEnv, edges, seen));
        return;
    }
    if (node instanceof SeqNode) {
        node.expressions.forEach((expression) => collectDependencyEdgesFromAst(expression, typeEnv, edges, seen));
        return;
    }
    if (node instanceof SetNode) {
        collectDependencyEdgesFromAst(node.identifier, typeEnv, edges, seen);
        collectDependencyEdgesFromAst(node.value, typeEnv, edges, seen);
        return;
    }
    if (node instanceof TypeVarBindNode) {
        collectDependencyEdgesFromAst(node.typeExp, typeEnv, edges, seen);
        return;
    }
    if (node instanceof TypeToFromNode) {
        collectDependencyEdgesFromAst(node.returnType, typeEnv, edges, seen);
        node.paramTypes.forEach((paramType) => collectDependencyEdgesFromAst(paramType, typeEnv, edges, seen));
        return;
    }
    if (node instanceof TypeUnionNode) {
        node.types.forEach((typeNode) => collectDependencyEdgesFromAst(typeNode, typeEnv, edges, seen));
        return;
    }
    if (node instanceof ClassPropertyNode) {
        collectDependencyEdgesFromAst(node.bind, typeEnv, edges, seen);
        return;
    }
    if (node instanceof ClassMethodNode) {
        node.params.forEach((param) => collectDependencyEdgesFromAst(param, typeEnv, edges, seen));
        collectDependencyEdgesFromAst(node.returnType, typeEnv, edges, seen);
        collectDependencyEdgesFromAst(node.body, typeEnv, edges, seen);
        return;
    }
    if (node instanceof ClassConstructorNode) {
        node.params.forEach((param) => collectDependencyEdgesFromAst(param, typeEnv, edges, seen));
        collectDependencyEdgesFromAst(node.body, typeEnv, edges, seen);
        return;
    }
    if (node instanceof FunctionCallNode) {
        collectDependencyEdgesFromAst(node.callee, typeEnv, edges, seen);
        node.args.forEach((arg) => collectDependencyEdgesFromAst(arg, typeEnv, edges, seen));
        return;
    }
    if (node instanceof MatchNode) {
        collectDependencyEdgesFromAst(node.unionExpr, typeEnv, edges, seen);
        node.branches.forEach((branch) => {
            collectDependencyEdgesFromAst(branch.bind, typeEnv, edges, seen);
            collectDependencyEdgesFromAst(branch.body, typeEnv, edges, seen);
        });
    }
}

function buildGenericDependencyGraph(): {
    classEdges: Map<string, GenericDependencyEdge[]>;
    functionEdges: Map<string, GenericDependencyEdge[]>;
} {
    const classEdges = new Map<string, GenericDependencyEdge[]>();
    const functionEdges = new Map<string, GenericDependencyEdge[]>();

    for (const [, info] of resolvedGenericClassTable.entries()) {
        const edges: GenericDependencyEdge[] = [];
        const seen = new Set<string>();
        const env = makeTypeParamEnv(info.typeParams);
        info.source.properties.forEach((property) => collectDependencyEdgesFromAst(property, env, edges, seen));
        info.source.methods.forEach((method) => collectDependencyEdgesFromAst(method, env, edges, seen));
        info.source.constructors.forEach((ctor) => collectDependencyEdgesFromAst(ctor, env, edges, seen));
        classEdges.set(genericOverloadKey(info.source.genericName, info.typeParams.length), edges);
    }

    for (const [, info] of resolvedGenericFunctionTable.entries()) {
        const edges: GenericDependencyEdge[] = [];
        const seen = new Set<string>();
        const env = makeTypeParamEnv(info.typeParams);
        collectDependencyEdgesFromAst(info.source.body, env, edges, seen);
        info.source.paramTypes.forEach((param) => collectDependencyEdgesFromAst(param, env, edges, seen));
        collectDependencyEdgesFromAst(info.source.returnType, env, edges, seen);
        functionEdges.set(genericOverloadKey(info.source.genericName, info.typeParams.length), edges);
    }

    return { classEdges, functionEdges };
}

function expandGenericDependencies(maxExpansionRounds: number): void {
    const { classEdges, functionEdges } = buildGenericDependencyGraph();

    const seenClassInstances = new Map<string, GenericClassInstanceTypeValue>(genericClassInstanceTable);
    const seenFunctionInstances = new Map<string, GenericFunctionInstanceTypeValue>(genericFunctionInstanceTable);

    let classFrontier = Array.from(seenClassInstances.values());
    let functionFrontier = Array.from(seenFunctionInstances.values());

    for (let round = 1; round <= maxExpansionRounds; round++) {
        const nextClassInstances = new Map<string, GenericClassInstanceTypeValue>();
        const nextFunctionInstances = new Map<string, GenericFunctionInstanceTypeValue>();

        for (const instance of classFrontier) {
            const sourceInfo = getResolvedGenericClassInfo(instance.genericName, instance.typeArgs.length);
            if (!sourceInfo) {
                continue;
            }
            const substitutions = new Map<string, TypeValue>();
            sourceInfo.typeParams.forEach((typeParam, index) => substitutions.set(typeParam, instance.typeArgs[index]));
            for (const edge of classEdges.get(genericOverloadKey(instance.genericName, instance.typeArgs.length)) ?? []) {
                const appliedTypeArgs = edge.typeArgTemplates.map((template) => substituteTypeVariables(template, substitutions));
                if (edge.targetKind === "class") {
                    const nextInstance = new GenericClassInstanceTypeValue(edge.targetName, appliedTypeArgs);
                    if (!seenClassInstances.has(nextInstance.hash())) {
                        nextClassInstances.set(nextInstance.hash(), nextInstance);
                    }
                } else {
                    const nextInstance = new GenericFunctionInstanceTypeValue(edge.targetName, appliedTypeArgs);
                    if (!seenFunctionInstances.has(nextInstance.hash())) {
                        nextFunctionInstances.set(nextInstance.hash(), nextInstance);
                    }
                }
            }
        }

        for (const instance of functionFrontier) {
            const sourceInfo = getResolvedGenericFunctionInfo(instance.genericName, instance.typeArgs.length);
            if (!sourceInfo) {
                continue;
            }
            const substitutions = new Map<string, TypeValue>();
            sourceInfo.typeParams.forEach((typeParam, index) => substitutions.set(typeParam, instance.typeArgs[index]));
            for (const edge of functionEdges.get(genericOverloadKey(instance.genericName, instance.typeArgs.length)) ?? []) {
                const appliedTypeArgs = edge.typeArgTemplates.map((template) => substituteTypeVariables(template, substitutions));
                if (edge.targetKind === "class") {
                    const nextInstance = new GenericClassInstanceTypeValue(edge.targetName, appliedTypeArgs);
                    if (!seenClassInstances.has(nextInstance.hash())) {
                        nextClassInstances.set(nextInstance.hash(), nextInstance);
                    }
                } else {
                    const nextInstance = new GenericFunctionInstanceTypeValue(edge.targetName, appliedTypeArgs);
                    if (!seenFunctionInstances.has(nextInstance.hash())) {
                        nextFunctionInstances.set(nextInstance.hash(), nextInstance);
                    }
                }
            }
        }

        if (nextClassInstances.size === 0 && nextFunctionInstances.size === 0) {
            break;
        }

        if (round === maxExpansionRounds) {
            const sampleInstance = nextClassInstances.values().next().value ?? nextFunctionInstances.values().next().value;
            if (!sampleInstance) {
                throw new Error(`generic monomorphization may not terminate: expansion exceeded ${maxExpansionRounds} rounds`);
            }
            throw new Error(`generic monomorphization may not terminate: expansion exceeded ${maxExpansionRounds} rounds while generating ${sampleInstance.hash()}`);
        }

        nextClassInstances.forEach((instance, hash) => seenClassInstances.set(hash, instance));
        nextFunctionInstances.forEach((instance, hash) => seenFunctionInstances.set(hash, instance));
        classFrontier = Array.from(nextClassInstances.values());
        functionFrontier = Array.from(nextFunctionInstances.values());
    }

    genericClassInstanceTable.clear();
    genericFunctionInstanceTable.clear();
    seenClassInstances.forEach((instance, hash) => genericClassInstanceTable.set(hash, instance));
    seenFunctionInstances.forEach((instance, hash) => genericFunctionInstanceTable.set(hash, instance));
}

export function validateMonomorphizationPass(options?: MonomorphizationOptions): void {
    const maxExpansionRounds = options?.maxExpansionRounds ?? DEFAULT_MONOMORPHIZATION_MAX_ROUNDS;
    if (!Number.isInteger(maxExpansionRounds) || maxExpansionRounds < 1) {
        throw new Error("monomorphization maxExpansionRounds must be a positive integer");
    }

    for (const [name, instance] of genericClassInstanceTable.entries()) {
        if (!hasGenericClassInfo(instance.genericName)) {
            throw new Error(`unknown generic class instantiation '${name}'`);
        }
        ensureConcreteTypeArgs(instance.typeArgs, `generic class ${instance.genericName}`);
    }
    for (const [name, instance] of genericFunctionInstanceTable.entries()) {
        if (!hasGenericFunctionInfo(instance.genericName)) {
            throw new Error(`unknown generic function instantiation '${name}'`);
        }
        ensureConcreteTypeArgs(instance.typeArgs, `generic function ${instance.genericName}`);
    }

    expandGenericDependencies(maxExpansionRounds);
}
