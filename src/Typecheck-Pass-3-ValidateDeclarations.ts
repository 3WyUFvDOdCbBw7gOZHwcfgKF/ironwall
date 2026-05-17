import {
    getAllClassInfos,
    type FunctionInfo,
    getAllFunctionInfos,
    getAllGenericClassInfos,
    getAllGenericFunctionInfos,
    getAllGlobalVarInfos,
    getFunctionOverloadEntries
} from "./Typecheck-Definitions";
import {
    parseExportedIwFunctionName,
    validateDeclaredCFunctionName,
    validateExportedIwFunctionName
} from "./DeclaredCFunctionName";
import {
    getResolvedClassInfo,
    getResolvedFunctionOverloads,
    getResolvedGenericClassInfo
} from "./Typecheck-Pass-2-ResolveHeaders";
import { getPackageSymbolEntries, type PackageSymbolRecord } from "./Typecheck-Modules";
import { astToTypeValue } from "./Typecheck-TypeAst";
import {
    GenericClassInstanceTypeValue,
    GenericTypeEnv,
    PrimitiveTypeValue,
    builtinGenericTypeNames,
    typeEqual,
    type TypeValue
} from "./TypeSystem";

const builtinReservedTopLevelNames: ReadonlySet<string> = new Set([
    "add",
    "sub",
    "mul",
    "div",
    "mod",
    "le",
    "lt",
    "ge",
    "gt",
    "eq",
    "neq",
    "not",
    "and",
    "or",
    "xor",
    "bwand",
    "bwor",
    "bwxor",
    "ls",
    "rs",
    "class_new",
    "cm_get",
    "cm_set",
    "array_new",
    "array_get",
    "array_set",
    "array_length",
    "s3_new",
    "s3_get",
    "s3_set",
    "s3_length",
    "s4_new",
    "s4_get",
    "s4_set",
    "s4_length",
    "s5_new",
    "s5_get",
    "s5_set",
    "s5_length",
    "z5_new",
    "z5_set",
    "z5_real",
    "z5_img",
    "z6_new",
    "z6_set",
    "z6_real",
    "z6_img",
    "z7_new",
    "z7_set",
    "z7_real",
    "z7_img",
    ...builtinGenericTypeNames
]);

let cachedReservedNames: ReadonlySet<string> | null = null;
const BUILTIN_STD_PACKAGE_NAME = "std";

function shouldEnforceReservedNames(packageName: string | null): boolean {
    return packageName !== null
        && packageName !== BUILTIN_STD_PACKAGE_NAME
        && !packageName.startsWith(`${BUILTIN_STD_PACKAGE_NAME}~`);
}

function ensureUnique(names: string[], context: string): void {
    const seen = new Set<string>();
    for (const name of names) {
        if (seen.has(name)) {
            throw new Error(`${context}: duplicate name '${name}'`);
        }
        seen.add(name);
    }
}

function hasSameParamList(left: readonly TypeValue[], right: readonly TypeValue[]): boolean {
    return left.length === right.length
        && left.every((type, index) => typeEqual(type, right[index]));
}

function ensureUniqueConstructorOverloads(context: string, constructors: readonly { readonly paramTypes: readonly TypeValue[] }[]): void {
    for (let i = 0; i < constructors.length; i++) {
        for (let j = i + 1; j < constructors.length; j++) {
            if (hasSameParamList(constructors[i].paramTypes, constructors[j].paramTypes)) {
                throw new Error(`${context}: duplicate constructor with the same parameter list`);
            }
        }
    }
}

function getReservedNames(): ReadonlySet<string> {
    if (cachedReservedNames !== null) {
        return cachedReservedNames;
    }

    cachedReservedNames = new Set<string>([
        "self",
        ...builtinReservedTopLevelNames,
    ]);
    return cachedReservedNames;
}

function ensureNotReserved(exportedName: string, context: string): void {
    if (getReservedNames().has(exportedName)) {
        throw new Error(`${context}: exported name '${exportedName}' is reserved`);
    }
}

function formatDiagnosticPath(filePath: string | null): string {
    if (filePath === null) {
        return "<unknown file>";
    }
    return filePath;
}

function formatPackageSymbolRecord(record: PackageSymbolRecord): string {
    const unitLabel = record.unitId ?? "<legacy>";
    return `${record.kind} '${record.canonicalName}' in unit ${unitLabel} (${formatDiagnosticPath(record.filePath)})`;
}

function formatPackageSymbolRecords(records: readonly PackageSymbolRecord[]): string {
    return records.map((record) => formatPackageSymbolRecord(record)).join(", ");
}

function isPrimitiveTypeNamed(type: TypeValue, expectedName: string): boolean {
    return type instanceof PrimitiveTypeValue && type.name === expectedName;
}

function isBuiltinArrayOfPrimitive(type: TypeValue, elementTypeName: string): boolean {
    return type instanceof GenericClassInstanceTypeValue
        && type.genericName === "array"
        && type.typeArgs.length === 1
        && isPrimitiveTypeNamed(type.typeArgs[0], elementTypeName);
}

function isSupportedExportedIwType(type: TypeValue): boolean {
    return isPrimitiveTypeNamed(type, "i5")
        || isPrimitiveTypeNamed(type, "s3")
        || isBuiltinArrayOfPrimitive(type, "i5")
        || isBuiltinArrayOfPrimitive(type, "s3");
}

function validateExportedIwFunctionSignature(info: FunctionInfo): void {
    info.paramTypeValues = info.paramTypes.map((param) => astToTypeValue(param.typeExp, new GenericTypeEnv()));
    info.paramTypeValues.forEach((paramType, index) => {
        if (!isSupportedExportedIwType(paramType)) {
            throw new Error(`function ${info.name}: exported iwlang parameter '${info.paramTypes[index]?.var.name ?? index}' must use one of i5, s3, <array i5>, or <array s3>`);
        }
    });

    const returnType = astToTypeValue(info.returnType, new GenericTypeEnv());
    if (!isSupportedExportedIwType(returnType)) {
        throw new Error(`function ${info.name}: exported iwlang return type must use one of i5, s3, <array i5>, or <array s3>`);
    }
}

function ensureUniqueExternalFunctionUuid(
    seenUuids: Map<string, string>,
    uuid: string,
    owner: string
): void {
    const previousOwner = seenUuids.get(uuid);
    if (previousOwner !== undefined) {
        throw new Error(`external function UUID '${uuid}' is reused by ${owner}; first used by ${previousOwner}`);
    }
    seenUuids.set(uuid, owner);
}

export function validateDeclarationsPass(): void {
    const externalFunctionUuids = new Map<string, string>();

    for (const info of getAllFunctionInfos()) {
        if (info.isDeclared) {
            const parsed = validateDeclaredCFunctionName(info.exportedName);
            ensureUniqueExternalFunctionUuid(
                externalFunctionUuids,
                parsed.uuid,
                `declared C function ${info.name}`
            );
            continue;
        }

        if (parseExportedIwFunctionName(info.exportedName) !== null) {
            const parsed = validateExportedIwFunctionName(info.exportedName);
            ensureUniqueExternalFunctionUuid(
                externalFunctionUuids,
                parsed.uuid,
                `exported iwlang function ${info.name}`
            );
            validateExportedIwFunctionSignature(info);
        }
    }

    for (const entry of getPackageSymbolEntries()) {
        const nonFunctionRecords = entry.records.filter((record) => record.kind !== "function");
        const functionRecords = entry.records.filter((record) => record.kind === "function");

        const nonFunctionGroups = new Map<string, PackageSymbolRecord[]>();
        for (const record of nonFunctionRecords) {
            const group = nonFunctionGroups.get(record.kind) ?? [];
            group.push(record);
            nonFunctionGroups.set(record.kind, group);
        }
        for (const [kind, group] of nonFunctionGroups.entries()) {
            if (kind === "generic_class" || kind === "generic_function") {
                const arityGroups = new Map<number, PackageSymbolRecord[]>();
                for (const record of group) {
                    const arity = record.genericArity ?? -1;
                    const arityGroup = arityGroups.get(arity) ?? [];
                    arityGroup.push(record);
                    arityGroups.set(arity, arityGroup);
                }
                for (const arityGroup of arityGroups.values()) {
                    if (arityGroup.length <= 1) {
                        continue;
                    }
                    const packageLabel = arityGroup[0]?.packageName ?? "<legacy>";
                    throw new Error(`package ${packageLabel}: duplicate exported symbol '${entry.exportedName}': ${formatPackageSymbolRecords(arityGroup)}`);
                }
                continue;
            }
            if (group.length <= 1) {
                continue;
            }
            const packageLabel = group[0]?.packageName ?? "<legacy>";
            throw new Error(`package ${packageLabel}: duplicate exported symbol '${entry.exportedName}': ${formatPackageSymbolRecords(group)}`);
        }

        const nonFunctionKinds = new Set(nonFunctionRecords.map((record) => record.kind));
        if (nonFunctionKinds.size > 1) {
            const packageLabel = entry.records[0]?.packageName ?? "<legacy>";
            throw new Error(`package ${packageLabel}: exported symbol '${entry.exportedName}' conflicts across definition kinds: ${formatPackageSymbolRecords(entry.records)}`);
        }
        if (nonFunctionRecords.length > 0 && functionRecords.length > 0) {
            const packageLabel = entry.records[0]?.packageName ?? "<legacy>";
            throw new Error(`package ${packageLabel}: exported symbol '${entry.exportedName}' conflicts across definition kinds: ${formatPackageSymbolRecords(entry.records)}`);
        }
        if (nonFunctionRecords.some((record) => record.kind === "generic_function") && functionRecords.length > 0) {
            const packageLabel = entry.records[0]?.packageName ?? "<legacy>";
            throw new Error(`package ${packageLabel}: generic function '${entry.exportedName}' conflicts with ordinary function overloads: ${formatPackageSymbolRecords(entry.records)}`);
        }
    }

    for (const info of getAllClassInfos()) {
        if (shouldEnforceReservedNames(info.packageName)) {
            ensureNotReserved(info.exportedName, `class ${info.name}`);
        }
        if (info.constructors.length === 0) {
            throw new Error(`class ${info.name}: at least one constructor is required`);
        }
        const resolvedInfo = getResolvedClassInfo(info.name);
        if (resolvedInfo === undefined) {
            throw new Error(`class ${info.name}: resolved header info is missing during declaration validation`);
        }
        ensureUniqueConstructorOverloads(`class ${info.name}`, resolvedInfo.constructors);
        const propertyNames = info.properties.map((property) => property.bind.var.name);
        const methodNames = info.methods.map((method) => method.methodName.name);
        ensureUnique(propertyNames, `class ${info.name} properties`);
        ensureUnique(methodNames, `class ${info.name} methods`);
        propertyNames.forEach((name) => ensureNotReserved(name, `class ${info.name} property`));
        methodNames.forEach((name) => ensureNotReserved(name, `class ${info.name} method`));
        for (const propertyName of propertyNames) {
            if (info.methodMap.has(propertyName)) {
                throw new Error(`class ${info.name}: property '${propertyName}' conflicts with a method of the same name`);
            }
        }
    }

    for (const info of getAllGenericClassInfos()) {
        if (shouldEnforceReservedNames(info.packageName)) {
            ensureNotReserved(info.exportedName, `generic class ${info.genericName}`);
        }
        ensureUnique(info.typeParams, `generic class ${info.genericName} type parameters`);
        if (info.constructors.length === 0) {
            throw new Error(`generic class ${info.genericName}: at least one constructor is required`);
        }
        const resolvedInfo = getResolvedGenericClassInfo(info.genericName, info.typeParams.length);
        if (resolvedInfo === undefined) {
            throw new Error(`generic class ${info.genericName}: resolved header info is missing during declaration validation`);
        }
        ensureUniqueConstructorOverloads(`generic class ${info.genericName}`, resolvedInfo.constructors);
        const propertyNames = info.properties.map((property) => property.bind.var.name);
        const methodNames = info.methods.map((method) => method.methodName.name);
        ensureUnique(propertyNames, `generic class ${info.genericName} properties`);
        ensureUnique(methodNames, `generic class ${info.genericName} methods`);
        for (const propertyName of propertyNames) {
            if (info.methodMap.has(propertyName)) {
                throw new Error(`generic class ${info.genericName}: property '${propertyName}' conflicts with a method of the same name`);
            }
        }
    }

    for (const [name, overloads] of getFunctionOverloadEntries()) {
        if (overloads.some((overload) => shouldEnforceReservedNames(overload.packageName))) {
            ensureNotReserved(overloads[0]?.exportedName ?? name, `function ${name}`);
        }
        const declaredOverloads = overloads.filter((overload) => overload.isDeclared);
        const exportedIwOverloads = overloads.filter((overload) => parseExportedIwFunctionName(overload.exportedName) !== null);
        if (declaredOverloads.length > 1) {
            throw new Error(`function ${name}: declared extern overloads are not supported`);
        }
        if (declaredOverloads.length === 1 && overloads.length > 1) {
            throw new Error(`function ${name}: declared extern cannot share a name with non-declared overloads`);
        }
        if (exportedIwOverloads.length > 1) {
            throw new Error(`function ${name}: exported iwlang overloads are not supported`);
        }
        if (exportedIwOverloads.length === 1 && overloads.length > 1) {
            throw new Error(`function ${name}: exported iwlang function cannot share a name with other overloads`);
        }
        const resolvedOverloads = getResolvedFunctionOverloads(name);
        for (let i = 0; i < resolvedOverloads.length; i++) {
            for (let j = i + 1; j < resolvedOverloads.length; j++) {
                const left = resolvedOverloads[i].functionType;
                const right = resolvedOverloads[j].functionType;
                const sameParamList = left.paramTypes.length === right.paramTypes.length
                    && left.paramTypes.every((type, index) => typeEqual(type, right.paramTypes[index]));
                if (sameParamList) {
                    throw new Error(`function ${name}: duplicate overload with the same parameter list`);
                }
            }
        }
        overloads.forEach((overload) => ensureUnique(overload.paramTypes.map((param) => param.var.name), `function ${name} parameters`));
    }

    for (const info of getAllGenericFunctionInfos()) {
        if (parseExportedIwFunctionName(info.exportedName) !== null) {
            throw new Error(`generic function ${info.genericName}: exported iwlang naming is only supported on ordinary top-level functions`);
        }
        if (shouldEnforceReservedNames(info.packageName)) {
            ensureNotReserved(info.exportedName, `generic function ${info.genericName}`);
        }
        ensureUnique(info.typeParams, `generic function ${info.genericName} type parameters`);
        ensureUnique(info.paramTypes.map((param) => param.var.name), `generic function ${info.genericName} parameters`);
    }

    for (const info of getAllGlobalVarInfos()) {
        if (shouldEnforceReservedNames(info.packageName)) {
            ensureNotReserved(info.exportedName, `global ${info.name}`);
        }
    }
}
