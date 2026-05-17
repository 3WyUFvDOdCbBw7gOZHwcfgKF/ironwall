import { AstNode } from "./AstNode";
import {
    getVisibleFunctionOverloads,
    getVisibleGenericFunctionInfo,
    ClassInfo,
    FunctionInfo,
    GenericClassInfo,
    GenericFunctionInfo,
    getClassInfoEntries,
    getFunctionOverloadEntries,
    getGenericClassInfoEntries,
    getGenericFunctionInfoEntries
} from "./Typecheck-Definitions";
import { FunctionTypeValue, GenericTypeEnv, TypeParameterValue, TypeValue } from "./TypeSystem";
import { astToTypeValue } from "./Typecheck-TypeAst";

export interface ResolvedConstructorInfo {
    readonly paramTypes: TypeValue[];
}

export interface ResolvedMethodInfo {
    readonly name: string;
    readonly type: FunctionTypeValue;
}

export interface ResolvedClassInfo {
    readonly name: string;
    readonly properties: Map<string, TypeValue>;
    readonly methods: Map<string, ResolvedMethodInfo>;
    readonly constructors: ResolvedConstructorInfo[];
    readonly source: ClassInfo;
}

export interface ResolvedGenericClassInfo {
    readonly name: string;
    readonly typeParams: string[];
    readonly properties: Map<string, TypeValue>;
    readonly methods: Map<string, ResolvedMethodInfo>;
    readonly constructors: ResolvedConstructorInfo[];
    readonly source: GenericClassInfo;
}

export interface ResolvedFunctionOverload {
    readonly name: string;
    readonly functionType: FunctionTypeValue;
    readonly source: FunctionInfo;
}

export interface ResolvedGenericFunctionInfo {
    readonly name: string;
    readonly typeParams: string[];
    readonly functionType: FunctionTypeValue;
    readonly source: GenericFunctionInfo;
}

export const resolvedClassTable: Map<string, ResolvedClassInfo> = new Map();
export const resolvedGenericClassTable: Map<string, ResolvedGenericClassInfo> = new Map();
export const resolvedFunctionOverloads: Map<string, ResolvedFunctionOverload[]> = new Map();
export const resolvedGenericFunctionTable: Map<string, ResolvedGenericFunctionInfo> = new Map();
const resolvedGenericClassOverloadTable: Map<string, Map<number, ResolvedGenericClassInfo>> = new Map();
const resolvedGenericFunctionOverloadTable: Map<string, Map<number, ResolvedGenericFunctionInfo>> = new Map();

const resolvedClassLookupTable: Map<string, ResolvedClassInfo> = new Map();
const ambiguousResolvedClassNames: Set<string> = new Set();
const resolvedGenericClassLookupTable: Map<string, ResolvedGenericClassInfo> = new Map();
const ambiguousResolvedGenericClassNames: Set<string> = new Set();
const resolvedFunctionOverloadLookupTable: Map<string, ResolvedFunctionOverload[]> = new Map();
const ambiguousResolvedFunctionNames: Set<string> = new Set();
const resolvedGenericFunctionLookupTable: Map<string, ResolvedGenericFunctionInfo> = new Map();
const ambiguousResolvedGenericFunctionNames: Set<string> = new Set();
const resolvedGenericClassOverloadLookupTable: Map<string, Map<number, ResolvedGenericClassInfo>> = new Map();
const resolvedGenericFunctionOverloadLookupTable: Map<string, Map<number, ResolvedGenericFunctionInfo>> = new Map();
const ambiguousResolvedGenericClassOverloadNames: Set<string> = new Set();
const ambiguousResolvedGenericFunctionOverloadNames: Set<string> = new Set();

export function resetResolvedHeaderTables(): void {
    resolvedClassTable.clear();
    resolvedGenericClassTable.clear();
    resolvedFunctionOverloads.clear();
    resolvedGenericFunctionTable.clear();
    resolvedGenericClassOverloadTable.clear();
    resolvedGenericFunctionOverloadTable.clear();
    resolvedClassLookupTable.clear();
    ambiguousResolvedClassNames.clear();
    resolvedGenericClassLookupTable.clear();
    ambiguousResolvedGenericClassNames.clear();
    resolvedFunctionOverloadLookupTable.clear();
    ambiguousResolvedFunctionNames.clear();
    resolvedGenericFunctionLookupTable.clear();
    ambiguousResolvedGenericFunctionNames.clear();
    resolvedGenericClassOverloadLookupTable.clear();
    resolvedGenericFunctionOverloadLookupTable.clear();
    ambiguousResolvedGenericClassOverloadNames.clear();
    ambiguousResolvedGenericFunctionOverloadNames.clear();
}

function registerResolvedGenericOverloadLookup<T extends { name: string; source: { genericName: string; exportedName: string; typeParams: string[] } }>(
    canonicalTable: Map<string, Map<number, T>>,
    shortLookupTable: Map<string, Map<number, T>>,
    ambiguousNames: Set<string>,
    resolvedInfo: T
): void {
    const overloads = canonicalTable.get(resolvedInfo.source.genericName) ?? new Map<number, T>();
    overloads.set(resolvedInfo.source.typeParams.length, resolvedInfo);
    canonicalTable.set(resolvedInfo.source.genericName, overloads);

    if (ambiguousNames.has(resolvedInfo.source.exportedName)) {
        return;
    }

    const existing = shortLookupTable.get(resolvedInfo.source.exportedName);
    if (existing === undefined) {
        shortLookupTable.set(resolvedInfo.source.exportedName, overloads);
        return;
    }
    if (existing !== overloads) {
        shortLookupTable.delete(resolvedInfo.source.exportedName);
        ambiguousNames.add(resolvedInfo.source.exportedName);
    }
}

function registerResolvedLookup<T>(canonicalName: string, exportedName: string, value: T, canonicalTable: Map<string, T>, shortLookupTable: Map<string, T>, ambiguousNames: Set<string>): void {
    canonicalTable.set(canonicalName, value);
    if (canonicalName === exportedName) {
        shortLookupTable.set(exportedName, value);
        return;
    }
    if (ambiguousNames.has(exportedName)) {
        return;
    }
    const existing = shortLookupTable.get(exportedName);
    if (existing === undefined) {
        shortLookupTable.set(exportedName, value);
        return;
    }
    if (existing !== value) {
        shortLookupTable.delete(exportedName);
        ambiguousNames.add(exportedName);
    }
}

function registerResolvedOverloadLookup(canonicalName: string, exportedName: string, overloads: ResolvedFunctionOverload[]): void {
    resolvedFunctionOverloads.set(canonicalName, overloads);
    if (canonicalName === exportedName) {
        resolvedFunctionOverloadLookupTable.set(exportedName, overloads);
        return;
    }
    if (ambiguousResolvedFunctionNames.has(exportedName)) {
        return;
    }
    const existing = resolvedFunctionOverloadLookupTable.get(exportedName);
    if (existing === undefined) {
        resolvedFunctionOverloadLookupTable.set(exportedName, overloads);
        return;
    }
    if (existing !== overloads) {
        resolvedFunctionOverloadLookupTable.delete(exportedName);
        ambiguousResolvedFunctionNames.add(exportedName);
    }
}

export function getResolvedClassInfo(name: string): ResolvedClassInfo | undefined {
    return resolvedClassTable.get(name) ?? resolvedClassLookupTable.get(name);
}

export function getResolvedGenericClassInfo(name: string, arity?: number): ResolvedGenericClassInfo | undefined {
    const overloads = resolvedGenericClassOverloadTable.get(name) ?? resolvedGenericClassOverloadLookupTable.get(name);
    if (overloads === undefined) {
        return undefined;
    }
    if (arity !== undefined) {
        return overloads.get(arity);
    }
    if (overloads.size !== 1) {
        return undefined;
    }
    return Array.from(overloads.values())[0];
}

export function getResolvedFunctionOverloads(name: string): ResolvedFunctionOverload[] {
    return resolvedFunctionOverloads.get(name) ?? resolvedFunctionOverloadLookupTable.get(name) ?? [];
}

export function getVisibleResolvedFunctionOverloads(referenceNode: AstNode, name: string): ResolvedFunctionOverload[] {
    const visibleSourceOverloads = getVisibleFunctionOverloads(referenceNode, name);
    if (visibleSourceOverloads.length > 0) {
        return resolvedFunctionOverloads.get(visibleSourceOverloads[0].name) ?? [];
    }
    if (name.includes("@")) {
        return [];
    }

    const canonical = resolvedFunctionOverloads.get(name);
    if (canonical !== undefined) {
        return canonical;
    }

    const short = resolvedFunctionOverloadLookupTable.get(name);
    if (short !== undefined && short.every((entry) => entry.source.packageName === null)) {
        return short;
    }

    return [];
}

export function getResolvedGenericFunctionInfo(name: string, arity?: number): ResolvedGenericFunctionInfo | undefined {
    const overloads = resolvedGenericFunctionOverloadTable.get(name) ?? resolvedGenericFunctionOverloadLookupTable.get(name);
    if (overloads === undefined) {
        return undefined;
    }
    if (arity !== undefined) {
        return overloads.get(arity);
    }
    if (overloads.size !== 1) {
        return undefined;
    }
    return Array.from(overloads.values())[0];
}

export function getVisibleResolvedGenericFunctionInfo(referenceNode: AstNode, name: string, arity?: number): ResolvedGenericFunctionInfo | undefined {
    const visibleSourceInfo = getVisibleGenericFunctionInfo(referenceNode, name, arity);
    if (visibleSourceInfo !== undefined) {
        return getResolvedGenericFunctionInfo(visibleSourceInfo.genericName, visibleSourceInfo.typeParams.length);
    }
    if (name.includes("@")) {
        return undefined;
    }

    const canonical = getResolvedGenericFunctionInfo(name, arity);
    if (canonical !== undefined) {
        return canonical;
    }

    const short = resolvedGenericFunctionOverloadLookupTable.get(name);
    if (short !== undefined && Array.from(short.values()).every((entry) => entry.source.packageName === null)) {
        if (arity !== undefined) {
            return short.get(arity);
        }
        if (short.size === 1) {
            return Array.from(short.values())[0];
        }
    }

    return undefined;
}

function makeTypeParamEnv(typeParams: string[]): GenericTypeEnv {
    const env = new GenericTypeEnv();
    for (const typeParam of typeParams) {
        env.set(typeParam, new TypeParameterValue(typeParam));
    }
    return env;
}

function resolveClassInfo(info: ClassInfo): ResolvedClassInfo {
    const properties = new Map(info.properties.map((property) => [property.bind.var.name, astToTypeValue(property.bind.typeExp)]));
    const methods = new Map(info.methods.map((method) => [
        method.methodName.name,
        {
            name: method.methodName.name,
            type: new FunctionTypeValue(
                method.params.map((param) => astToTypeValue(param.typeExp)),
                astToTypeValue(method.returnType)
            )
        }
    ]));
    const constructors = info.constructors.map((ctor) => ({
        paramTypes: ctor.params.map((param) => astToTypeValue(param.typeExp))
    }));
    return { name: info.name, properties, methods, constructors, source: info };
}

function resolveGenericClassInfo(info: GenericClassInfo): ResolvedGenericClassInfo {
    const env = makeTypeParamEnv(info.typeParams);
    const properties = new Map(info.properties.map((property) => [property.bind.var.name, astToTypeValue(property.bind.typeExp, env)]));
    const methods = new Map(info.methods.map((method) => [
        method.methodName.name,
        {
            name: method.methodName.name,
            type: new FunctionTypeValue(
                method.params.map((param) => astToTypeValue(param.typeExp, env)),
                astToTypeValue(method.returnType, env)
            )
        }
    ]));
    const constructors = info.constructors.map((ctor) => ({
        paramTypes: ctor.params.map((param) => astToTypeValue(param.typeExp, env))
    }));
    return { name: info.genericName, typeParams: info.typeParams, properties, methods, constructors, source: info };
}

function resolveFunctionInfo(info: FunctionInfo): ResolvedFunctionOverload {
    return {
        name: info.name,
        functionType: new FunctionTypeValue(
            info.paramTypes.map((param) => astToTypeValue(param.typeExp)),
            astToTypeValue(info.returnType)
        ),
        source: info
    };
}

function resolveGenericFunctionInfo(info: GenericFunctionInfo): ResolvedGenericFunctionInfo {
    const env = makeTypeParamEnv(info.typeParams);
    return {
        name: info.genericName,
        typeParams: info.typeParams,
        functionType: new FunctionTypeValue(
            info.paramTypes.map((param) => astToTypeValue(param.typeExp, env)),
            astToTypeValue(info.returnType, env)
        ),
        source: info
    };
}

export function resolveDefinitionHeadersPass(): void {
    resetResolvedHeaderTables();

    for (const [name, info] of getClassInfoEntries()) {
        registerResolvedLookup(name, info.exportedName, resolveClassInfo(info), resolvedClassTable, resolvedClassLookupTable, ambiguousResolvedClassNames);
    }
    for (const [name, info] of getGenericClassInfoEntries()) {
        const resolvedInfo = resolveGenericClassInfo(info);
        registerResolvedLookup(name, info.exportedName, resolvedInfo, resolvedGenericClassTable, resolvedGenericClassLookupTable, ambiguousResolvedGenericClassNames);
        registerResolvedGenericOverloadLookup(resolvedGenericClassOverloadTable, resolvedGenericClassOverloadLookupTable, ambiguousResolvedGenericClassOverloadNames, resolvedInfo);
    }
    for (const [name, overloads] of getFunctionOverloadEntries()) {
        const exportedName = overloads[0]?.exportedName ?? name;
        registerResolvedOverloadLookup(name, exportedName, overloads.map(resolveFunctionInfo));
    }
    for (const [name, info] of getGenericFunctionInfoEntries()) {
        const resolvedInfo = resolveGenericFunctionInfo(info);
        registerResolvedLookup(name, info.exportedName, resolvedInfo, resolvedGenericFunctionTable, resolvedGenericFunctionLookupTable, ambiguousResolvedGenericFunctionNames);
        registerResolvedGenericOverloadLookup(resolvedGenericFunctionOverloadTable, resolvedGenericFunctionOverloadLookupTable, ambiguousResolvedGenericFunctionOverloadNames, resolvedInfo);
    }
}
