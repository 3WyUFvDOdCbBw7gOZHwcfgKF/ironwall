import { getResolvedGenericClassInfo, resolvedClassTable } from "./Typecheck-Pass-2-ResolveHeaders";
import { genericClassInstanceTable } from "./Typecheck-Pass-4-CollectInstantiations";
import { monomorphizedClassTable } from "./Typecheck-Pass-8-Monomorphize";
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
    printTypeValue,
    substituteTypeVariables
} from "./TypeSystem";

function collectUnionTypes(type: TypeValue, unionTypes: Map<string, UnionTypeValue>, visited: Set<string>): void {
    const hash = type.hash();
    if (visited.has(hash)) {
        return;
    }
    visited.add(hash);

    if (type instanceof UnionTypeValue) {
        unionTypes.set(type.hash(), type);
        type.types.forEach((member) => collectUnionTypes(member, unionTypes, visited));
        return;
    }

    if (type instanceof GenericClassInstanceTypeValue || type instanceof GenericFunctionInstanceTypeValue) {
        type.typeArgs.forEach((typeArg) => collectUnionTypes(typeArg, unionTypes, visited));
        return;
    }

    if (type instanceof FunctionTypeValue) {
        type.paramTypes.forEach((paramType) => collectUnionTypes(paramType, unionTypes, visited));
        collectUnionTypes(type.returnType, unionTypes, visited);
    }
}

function getInstantiatedPropertyTypes(instance: GenericClassInstanceTypeValue): Map<string, TypeValue> {
    const genericInfo = getResolvedGenericClassInfo(instance.genericName, instance.typeArgs.length);
    if (!genericInfo) {
        throw new Error(`unknown generic class instantiation '${instance.hash()}'`);
    }
    if (genericInfo.typeParams.length !== instance.typeArgs.length) {
        throw new Error(`generic class ${instance.genericName} expects ${genericInfo.typeParams.length} type arguments, got ${instance.typeArgs.length}`);
    }

    const substitutions = new Map<string, TypeValue>();
    for (let i = 0; i < genericInfo.typeParams.length; i++) {
        substitutions.set(genericInfo.typeParams[i], instance.typeArgs[i]);
    }

    return new Map(
        Array.from(genericInfo.properties.entries()).map(([name, propertyType]) => [
            name,
            substituteTypeVariables(propertyType, substitutions)
        ])
    );
}

function isFiniteType(
    type: TypeValue,
    finiteClasses: ReadonlySet<string>,
    finiteGenericInstances: ReadonlySet<string>,
    finiteUnions: ReadonlySet<string>
): boolean {
    if (type instanceof PrimitiveTypeValue) {
        return true;
    }
    if (type instanceof FunctionTypeValue || type instanceof GenericFunctionInstanceTypeValue) {
        return true;
    }
    if (type instanceof TypeParameterValue) {
        return false;
    }
    if (type instanceof ClassTypeValue) {
        return finiteClasses.has(type.className);
    }
    if (type instanceof UnionTypeValue) {
        return finiteUnions.has(type.hash());
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        if (builtinGenericTypeNames.has(type.genericName)) {
            return type.typeArgs.every((typeArg) => isFiniteType(typeArg, finiteClasses, finiteGenericInstances, finiteUnions));
        }
        return finiteGenericInstances.has(type.hash());
    }
    return false;
}

export function validateFiniteTypeTerminationPass(): void {
    const reachableGenericInstances = Array.from(genericClassInstanceTable.values());
    const genericInstanceProperties = new Map<string, Map<string, TypeValue>>();
    for (const instance of reachableGenericInstances) {
        if (builtinGenericTypeNames.has(instance.genericName)) {
            continue;
        }
        genericInstanceProperties.set(instance.hash(), getInstantiatedPropertyTypes(instance));
    }

    const concreteClassProperties = new Map<string, readonly TypeValue[]>();
    for (const classInfo of resolvedClassTable.values()) {
        concreteClassProperties.set(classInfo.name, Array.from(classInfo.properties.values()));
    }
    for (const classInfo of monomorphizedClassTable.values()) {
        concreteClassProperties.set(classInfo.concreteName, Array.from(classInfo.propertyTypes.values()));
    }

    const unionTypes = new Map<string, UnionTypeValue>();
    const visited = new Set<string>();
    for (const propertyTypes of concreteClassProperties.values()) {
        for (const propertyType of propertyTypes) {
            collectUnionTypes(propertyType, unionTypes, visited);
        }
    }
    for (const propertyMap of genericInstanceProperties.values()) {
        for (const propertyType of propertyMap.values()) {
            collectUnionTypes(propertyType, unionTypes, visited);
        }
    }

    const finiteClasses = new Set<string>();
    const finiteGenericInstances = new Set<string>();
    const finiteUnions = new Set<string>();

    let changed = true;
    while (changed) {
        changed = false;

        for (const unionType of unionTypes.values()) {
            if (finiteUnions.has(unionType.hash())) {
                continue;
            }
            if (unionType.types.some((memberType) => isFiniteType(memberType, finiteClasses, finiteGenericInstances, finiteUnions))) {
                finiteUnions.add(unionType.hash());
                changed = true;
            }
        }

        for (const [className, propertyTypes] of concreteClassProperties.entries()) {
            if (finiteClasses.has(className)) {
                continue;
            }
            if (propertyTypes.every((propertyType) => isFiniteType(propertyType, finiteClasses, finiteGenericInstances, finiteUnions))) {
                finiteClasses.add(className);
                changed = true;
            }
        }

        for (const [instanceHash, propertyMap] of genericInstanceProperties.entries()) {
            if (finiteGenericInstances.has(instanceHash)) {
                continue;
            }
            const propertyTypes = Array.from(propertyMap.values());
            if (propertyTypes.every((propertyType) => isFiniteType(propertyType, finiteClasses, finiteGenericInstances, finiteUnions))) {
                finiteGenericInstances.add(instanceHash);
                changed = true;
            }
        }
    }

    for (const [className, propertyTypes] of concreteClassProperties.entries()) {
        if (finiteClasses.has(className)) {
            continue;
        }
        const resolvedClassInfo = resolvedClassTable.get(className);
        const monomorphizedClassInfo = monomorphizedClassTable.get(className);
        const namedProperties = resolvedClassInfo !== undefined
            ? resolvedClassInfo.properties.entries()
            : monomorphizedClassInfo?.propertyTypes.entries();
        if (namedProperties !== undefined) {
            for (const [propertyName, propertyType] of namedProperties) {
                if (!isFiniteType(propertyType, finiteClasses, finiteGenericInstances, finiteUnions)) {
                    throw new Error(`class ${className}: property '${propertyName}' has infinite expansion risk through type ${printTypeValue(propertyType)}`);
                }
            }
        } else {
            for (const propertyType of propertyTypes) {
                if (!isFiniteType(propertyType, finiteClasses, finiteGenericInstances, finiteUnions)) {
                    throw new Error(`class ${className} has infinite expansion risk through type ${printTypeValue(propertyType)}`);
                }
            }
        }
        throw new Error(`class ${className} has infinite expansion risk`);
    }

    for (const instance of reachableGenericInstances) {
        if (builtinGenericTypeNames.has(instance.genericName) || finiteGenericInstances.has(instance.hash())) {
            continue;
        }
        const propertyMap = genericInstanceProperties.get(instance.hash());
        if (!propertyMap) {
            continue;
        }
        for (const [propertyName, propertyType] of propertyMap.entries()) {
            if (!isFiniteType(propertyType, finiteClasses, finiteGenericInstances, finiteUnions)) {
                throw new Error(`generic class instance ${printTypeValue(instance)}: property '${propertyName}' has infinite expansion risk through type ${printTypeValue(propertyType)}`);
            }
        }
        throw new Error(`generic class instance ${printTypeValue(instance)} has infinite expansion risk`);
    }
}