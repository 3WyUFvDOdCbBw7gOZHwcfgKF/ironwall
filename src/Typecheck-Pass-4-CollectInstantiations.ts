import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    ClassNode,
    ClassPropertyNode,
    CondNode,
    DfunNode,
    DvarNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    GenericClassNode,
    GenericDfunNode,
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
import { getVisibleGenericClassInfo, getVisibleGenericFunctionInfo } from "./Typecheck-Definitions";
import { FunctionTypeValue, GenericClassInstanceTypeValue, GenericFunctionInstanceTypeValue, GenericTypeEnv, TypeParameterValue, TypeValue, UnionTypeValue } from "./TypeSystem";
import { astToTypeValue } from "./Typecheck-TypeAst";

export const genericClassInstanceTable: Map<string, GenericClassInstanceTypeValue> = new Map();
export const genericFunctionInstanceTable: Map<string, GenericFunctionInstanceTypeValue> = new Map();

export function resetGenericInstantiationTables(): void {
    genericClassInstanceTable.clear();
    genericFunctionInstanceTable.clear();
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

function recordGenericCall(node: GenericCallNode, typeEnv: GenericTypeEnv, collectExplicit: boolean): void {
    if (!collectExplicit) {
        return;
    }
    if (!(node.callee instanceof IdentifierNode)) {
        return;
    }
    const genericName = node.callee.name;
    if (genericName === "class_new") {
        const [classNameNode, ...classTypeArgs] = node.typeArgs;
        if (!(classNameNode instanceof IdentifierNode)) {
            return;
        }
        const genericClassInfo = getVisibleGenericClassInfo(classNameNode, classNameNode.name, classTypeArgs.length);
        if (!genericClassInfo) {
            return;
        }
        const typeArgs = classTypeArgs.map((typeArg) => astToTypeValue(typeArg, typeEnv));
        if (!typeArgs.every(isConcreteType)) {
            return;
        }
        const instance = new GenericClassInstanceTypeValue(genericClassInfo.genericName, typeArgs);
        genericClassInstanceTable.set(instance.hash(), instance);
        return;
    }
    const typeArgs = node.typeArgs.map((typeArg) => astToTypeValue(typeArg, typeEnv));
    if (!typeArgs.every(isConcreteType)) {
        return;
    }
    const genericClassInfo = getVisibleGenericClassInfo(node, genericName, typeArgs.length);
    if (genericClassInfo) {
        const instance = new GenericClassInstanceTypeValue(genericClassInfo.genericName, typeArgs);
        genericClassInstanceTable.set(instance.hash(), instance);
    }
    const genericFunctionInfo = getVisibleGenericFunctionInfo(node, genericName, typeArgs.length);
    if (genericFunctionInfo) {
        const instance = new GenericFunctionInstanceTypeValue(genericFunctionInfo.genericName, typeArgs);
        genericFunctionInstanceTable.set(instance.hash(), instance);
    }
}

function extendTypeEnv(typeEnv: GenericTypeEnv, typeParams: readonly string[]): GenericTypeEnv {
    const nextEnv = typeEnv.extend();
    for (const typeParam of typeParams) {
        nextEnv.set(typeParam, new TypeParameterValue(typeParam));
    }
    return nextEnv;
}

export function collectGenericInstantiationsPass(node: AstNode, typeEnv: GenericTypeEnv = new GenericTypeEnv(), collectExplicit = true): void {
    if (node instanceof IdentifierNode || node instanceof TextDatabaseReferenceNode || node instanceof NumberLiteralNode || node instanceof GenericNameNode) {
        return;
    }
    if (node instanceof GenericCallNode) {
        recordGenericCall(node, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.callee, typeEnv, collectExplicit);
        node.typeArgs.forEach((typeArg) => collectGenericInstantiationsPass(typeArg, typeEnv, collectExplicit));
        return;
    }
    if (node instanceof ListNode) {
        node.elements.forEach((element) => collectGenericInstantiationsPass(element, typeEnv, collectExplicit));
        return;
    }
    if (node instanceof FnNode) {
        node.params.forEach((param) => collectGenericInstantiationsPass(param, typeEnv, collectExplicit));
        collectGenericInstantiationsPass(node.returnType, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.body, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof LetNode) {
        node.bindings.forEach((binding) => {
            collectGenericInstantiationsPass(binding.bind, typeEnv, collectExplicit);
            collectGenericInstantiationsPass(binding.value, typeEnv, collectExplicit);
        });
        collectGenericInstantiationsPass(node.body, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof IfNode) {
        collectGenericInstantiationsPass(node.condExpr, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.trueBranchExpr, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.falseBranchExpr, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof WhileNode) {
        collectGenericInstantiationsPass(node.condExpr, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.bodyExpr, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof CondNode) {
        node.clausesExprs.forEach((clause) => {
            collectGenericInstantiationsPass(clause.cond, typeEnv, collectExplicit);
            collectGenericInstantiationsPass(clause.body, typeEnv, collectExplicit);
        });
        return;
    }
    if (node instanceof DvarNode) {
        collectGenericInstantiationsPass(node.bind, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.value, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof DfunNode) {
        node.params.forEach((param) => collectGenericInstantiationsPass(param, typeEnv, collectExplicit));
        collectGenericInstantiationsPass(node.returnType, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.body, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof ProgramNode) {
        node.topLevelExpressions.forEach((expression) => collectGenericInstantiationsPass(expression, typeEnv, collectExplicit));
        return;
    }
    if (node instanceof SeqNode) {
        node.expressions.forEach((expression) => collectGenericInstantiationsPass(expression, typeEnv, collectExplicit));
        return;
    }
    if (node instanceof SetNode) {
        collectGenericInstantiationsPass(node.identifier, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.value, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof TypeVarBindNode) {
        collectGenericInstantiationsPass(node.var, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.typeExp, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof TypeToFromNode) {
        collectGenericInstantiationsPass(node.returnType, typeEnv, collectExplicit);
        node.paramTypes.forEach((paramType) => collectGenericInstantiationsPass(paramType, typeEnv, collectExplicit));
        return;
    }
    if (node instanceof TypeUnionNode) {
        node.types.forEach((typeNode) => collectGenericInstantiationsPass(typeNode, typeEnv, collectExplicit));
        return;
    }
    if (node instanceof ClassNode) {
        node.constructorNodeList.forEach((ctor) => collectGenericInstantiationsPass(ctor, typeEnv, collectExplicit));
        node.methodNodeList.forEach((method) => collectGenericInstantiationsPass(method, typeEnv, collectExplicit));
        node.propertyNodeList.forEach((property) => collectGenericInstantiationsPass(property, typeEnv, collectExplicit));
        return;
    }
    if (node instanceof ClassPropertyNode) {
        collectGenericInstantiationsPass(node.bind, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof ClassMethodNode) {
        node.params.forEach((param) => collectGenericInstantiationsPass(param, typeEnv, collectExplicit));
        collectGenericInstantiationsPass(node.returnType, typeEnv, collectExplicit);
        collectGenericInstantiationsPass(node.body, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof ClassConstructorNode) {
        node.params.forEach((param) => collectGenericInstantiationsPass(param, typeEnv, collectExplicit));
        collectGenericInstantiationsPass(node.body, typeEnv, collectExplicit);
        return;
    }
    if (node instanceof GenericClassNode) {
        const genericEnv = extendTypeEnv(typeEnv, node.genericName.genericTypeArgs.map((arg) => arg.name));
        node.constructorNodeList.forEach((ctor) => collectGenericInstantiationsPass(ctor, genericEnv, false));
        node.methodNodeList.forEach((method) => collectGenericInstantiationsPass(method, genericEnv, false));
        node.propertyNodeList.forEach((property) => collectGenericInstantiationsPass(property, genericEnv, false));
        return;
    }
    if (node instanceof GenericDfunNode) {
        const genericEnv = extendTypeEnv(typeEnv, node.genericName.genericTypeArgs.map((arg) => arg.name));
        node.params.forEach((param) => collectGenericInstantiationsPass(param, genericEnv, false));
        collectGenericInstantiationsPass(node.returnType, genericEnv, false);
        collectGenericInstantiationsPass(node.body, genericEnv, false);
        return;
    }
    if (node instanceof FunctionCallNode) {
        collectGenericInstantiationsPass(node.callee, typeEnv, collectExplicit);
        node.args.forEach((arg) => collectGenericInstantiationsPass(arg, typeEnv, collectExplicit));
        return;
    }
    if (node instanceof MatchNode) {
        collectGenericInstantiationsPass(node.unionExpr, typeEnv, collectExplicit);
        node.branches.forEach((branch) => {
            collectGenericInstantiationsPass(branch.bind, typeEnv, collectExplicit);
            collectGenericInstantiationsPass(branch.body, typeEnv, collectExplicit);
        });
    }
}
