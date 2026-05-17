import { AstNode, ClassMethodNode, ClassPropertyNode, GenericCallNode, IdentifierNode, TypeToFromNode, TypeUnionNode, TypeVarBindNode } from "./AstNode";
import { getCompilationUnitMetadata } from "./ModuleMetadata";
import { getGenericClassInfo, getVisibleClassInfo, getVisibleGenericClassInfo, getVisibleGenericFunctionInfo } from "./Typecheck-Definitions";
import {
    ClassTypeValue,
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    GenericFunctionInstanceTypeValue,
    GenericTypeEnv,
    PrimitiveTypeValue,
    TypeParameterValue,
    TypeValue,
    UnionTypeValue,
    builtinGenericTypeNames,
    primitiveTypeNames
} from "./TypeSystem";

const MONOMORPHIZED_CLASS_PREFIX = "__iw_mono_class_";

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

export function astToTypeValue(astNode: AstNode, typeEnv?: GenericTypeEnv): TypeValue {
    if (astNode instanceof IdentifierNode) {
        if (primitiveTypeNames.has(astNode.name)) {
            return new PrimitiveTypeValue(astNode.name);
        }
        if (typeEnv?.has(astNode.name)) {
            return typeEnv.get(astNode.name)!;
        }
        const classInfo = getVisibleClassInfo(astNode, astNode.name);
        if (classInfo) {
            return new ClassTypeValue(classInfo.name);
        }
        if (astNode.name.startsWith(MONOMORPHIZED_CLASS_PREFIX)) {
            return new ClassTypeValue(astNode.name);
        }
        throw new Error(`Unknown type identifier: ${astNode.name}`);
    }

    if (astNode instanceof TypeToFromNode) {
        return new FunctionTypeValue(
            astNode.paramTypes.map((parameterNode) => astToTypeValue(parameterNode, typeEnv)),
            astToTypeValue(astNode.returnType, typeEnv)
        );
    }

    if (astNode instanceof TypeUnionNode) {
        return new UnionTypeValue(astNode.types.map((typeNode) => astToTypeValue(typeNode, typeEnv)));
    }

    if (astNode instanceof GenericCallNode) {
        if (!(astNode.callee instanceof IdentifierNode)) {
            throw new Error("GenericCallNode: callee must be an IdentifierNode");
        }
        const name = astNode.callee.name;
        const typeArguments = astNode.typeArgs.map((argumentNode) => astToTypeValue(argumentNode, typeEnv));
        const genericClassInfo = resolveVisibleGenericClassInfoWithCurrentPackageFallback(astNode, name, typeArguments.length);
        if (genericClassInfo || builtinGenericTypeNames.has(name)) {
            return new GenericClassInstanceTypeValue(genericClassInfo?.genericName ?? name, typeArguments);
        }
        const genericFunctionInfo = getVisibleGenericFunctionInfo(astNode, name, typeArguments.length);
        if (genericFunctionInfo) {
            return new GenericFunctionInstanceTypeValue(genericFunctionInfo.genericName, typeArguments);
        }
        if (typeEnv?.has(name)) {
            return new TypeParameterValue(name);
        }
        throw new Error(`Unknown generic identifier: ${name}`);
    }

    throw new Error(`Invalid or unsupported type expression: kind='${astNode.kind}'`);
}

export function typeValueToTypeAst(type: TypeValue): AstNode {
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
            typeValueToTypeAst(type.returnType),
            type.paramTypes.map((paramType) => typeValueToTypeAst(paramType))
        );
    }
    if (type instanceof UnionTypeValue) {
        return new TypeUnionNode(type.types.map((typeNode) => typeValueToTypeAst(typeNode)));
    }
    return new GenericCallNode(
        new IdentifierNode(type.genericName),
        type.typeArgs.map((typeArg) => typeValueToTypeAst(typeArg))
    );
}

export function isValidRightHandType(type: TypeValue): boolean {
    return type instanceof PrimitiveTypeValue
        || type instanceof ClassTypeValue
        || type instanceof GenericClassInstanceTypeValue
        || type instanceof GenericFunctionInstanceTypeValue
        || type instanceof UnionTypeValue
        || type instanceof FunctionTypeValue
        || type instanceof TypeParameterValue;
}

export function classMethodNodeToTypeValue(method: ClassMethodNode, typeEnv?: GenericTypeEnv): FunctionTypeValue {
    const paramTypeValues: TypeValue[] = method.params.map((bind: TypeVarBindNode) => astToTypeValue(bind.typeExp, typeEnv));
    const returnTypeValue: TypeValue = astToTypeValue(method.returnType, typeEnv);
    return new FunctionTypeValue(paramTypeValues, returnTypeValue);
}

export function classPropertyNodeToTypeValue(property: ClassPropertyNode, typeEnv?: GenericTypeEnv): TypeValue {
    return astToTypeValue(property.bind.typeExp, typeEnv);
}

export {
    ClassTypeValue,
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    GenericFunctionInstanceTypeValue,
    GenericTypeEnv,
    PrimitiveTypeValue,
    TypeParameterValue,
    UnionTypeValue
};
