import { AstNode, ClassConstructorNode, ClassMethodNode, ClassPropertyNode, TypeVarBindNode } from "./AstNode";
import { TypeValue } from "./TypeSystem";
import { getCompilationUnitMetadata } from "./ModuleMetadata";
import { getVisibleGenericPackageSymbolCanonicalNames } from "./Typecheck-Modules";
import { getVisiblePackageSymbolCanonicalNames, type PackageSymbolKind } from "./Typecheck-Modules";

type LookupState<T> = {
    canonicalTable: Map<string, T>;
    shortLookupTable: Map<string, T>;
    ambiguousShortNames: Set<string>;
};

interface NamedDefinitionInfo {
    readonly name: string;
    readonly exportedName: string;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly filePath: string | null;
}

function registerLookup<T extends { name: string; exportedName: string }>(state: LookupState<T>, info: T): void {
    if (!state.canonicalTable.has(info.name)) {
        state.canonicalTable.set(info.name, info);
    }

    if (info.name === info.exportedName) {
        if (!state.shortLookupTable.has(info.exportedName)) {
            state.shortLookupTable.set(info.exportedName, info);
        }
        return;
    }

    if (state.ambiguousShortNames.has(info.exportedName)) {
        return;
    }

    const existing = state.shortLookupTable.get(info.exportedName);
    if (existing === undefined) {
        state.shortLookupTable.set(info.exportedName, info);
        return;
    }

    if (existing.name !== info.name) {
        state.shortLookupTable.delete(info.exportedName);
        state.ambiguousShortNames.add(info.exportedName);
    }
}

function resetLookupState<T>(state: LookupState<T>): void {
    state.canonicalTable.clear();
    state.shortLookupTable.clear();
    state.ambiguousShortNames.clear();
}

function lookupByName<T>(state: LookupState<T>, name: string): T | undefined {
    return state.canonicalTable.get(name) ?? state.shortLookupTable.get(name);
}

function lookupCanonicalOrLegacyByName<T extends NamedDefinitionInfo>(state: LookupState<T>, name: string): T | undefined {
    const canonical = state.canonicalTable.get(name);
    if (canonical !== undefined) {
        return canonical;
    }

    const short = state.shortLookupTable.get(name);
    if (short?.packageName === null) {
        return short;
    }

    return undefined;
}

function hasLookupName<T>(state: LookupState<T>, name: string): boolean {
    return lookupByName(state, name) !== undefined;
}

function allLookupValues<T>(state: LookupState<T>): IterableIterator<T> {
    return state.canonicalTable.values();
}

function lookupEntries<T>(state: LookupState<T>): IterableIterator<[string, T]> {
    return state.canonicalTable.entries();
}

function getUnitLocalMainCanonicalName(referenceNode: AstNode): string | undefined {
    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return undefined;
    }

    for (const [canonicalName, info] of functionOverloadTable.entries()) {
        if (info.length === 0) {
            continue;
        }
        const first = info[0];
        if (first.unitId === metadata.unitId && first.exportedName === "main") {
            return canonicalName;
        }
    }

    return undefined;
}

function resolveVisibleCanonicalNames(referenceNode: AstNode, name: string, kinds: readonly PackageSymbolKind[]): string[] {
    if (name === "main") {
        const localMain = getUnitLocalMainCanonicalName(referenceNode);
        if (localMain !== undefined) {
            return [localMain];
        }
    }
    return getVisiblePackageSymbolCanonicalNames(referenceNode, name, kinds);
}

function getCurrentPackageCanonicalName(referenceNode: AstNode, name: string): string | undefined {
    const metadata = getCompilationUnitMetadata(referenceNode);
    if (metadata === undefined) {
        return undefined;
    }
    if (name.includes("@")) {
        return name.startsWith(`${metadata.packageName}@`) ? name : undefined;
    }
    return `${metadata.packageName}@${name}`;
}

function buildVisibilityMap(names: readonly string[], publicNames: Iterable<string>): Map<string, boolean> {
    const publicNameSet = new Set(publicNames);
    return new Map(names.map((name) => [name, publicNameSet.has(name)]));
}

function hasLegacyStdPublicVisibility(packageName: string | null): boolean {
    return packageName !== null && packageName.startsWith("std~");
}

export class ClassInfo {
    public readonly name: string;
    public readonly exportedName: string;
    public readonly packageName: string | null;
    public readonly unitId: string | null;
    public readonly filePath: string | null;
    public readonly constructors: ClassConstructorNode[];
    public readonly methods: ClassMethodNode[];
    public readonly properties: ClassPropertyNode[];
    public readonly methodMap: Map<string, ClassMethodNode>;
    public readonly propertyMap: Map<string, ClassPropertyNode>;
    public readonly methodVisibility: Map<string, boolean>;
    public readonly propertyVisibility: Map<string, boolean>;

    constructor(
        name: string,
        constructors: ClassConstructorNode[],
        methods: ClassMethodNode[],
        properties: ClassPropertyNode[],
        packageName: string | null = null,
        unitId: string | null = null,
        exportedName?: string,
        filePath: string | null = null,
        publicPropertyNames: Iterable<string> = [],
        publicMethodNames: Iterable<string> = []
    ) {
        this.name = name;
        this.exportedName = exportedName ?? name;
        this.packageName = packageName;
        this.unitId = unitId;
        this.filePath = filePath;
        this.constructors = constructors;
        this.methods = methods;
        this.properties = properties;
        this.methodMap = new Map(methods.map((method) => [method.methodName.name, method]));
        this.propertyMap = new Map(properties.map((property) => [property.bind.var.name, property]));
        this.methodVisibility = buildVisibilityMap(methods.map((method) => method.methodName.name), publicMethodNames);
        this.propertyVisibility = buildVisibilityMap(properties.map((property) => property.bind.var.name), publicPropertyNames);
    }

    isMethodPublic(name: string): boolean {
        return this.methodVisibility.get(name) === true || hasLegacyStdPublicVisibility(this.packageName);
    }

    isPropertyPublic(name: string): boolean {
        return this.propertyVisibility.get(name) === true || hasLegacyStdPublicVisibility(this.packageName);
    }
}

export class GenericClassInfo {
    public readonly name: string;
    public readonly genericName: string;
    public readonly exportedName: string;
    public readonly packageName: string | null;
    public readonly unitId: string | null;
    public readonly filePath: string | null;
    public readonly typeParams: string[];
    public readonly constructors: ClassConstructorNode[];
    public readonly methods: ClassMethodNode[];
    public readonly properties: ClassPropertyNode[];
    public readonly methodMap: Map<string, ClassMethodNode>;
    public readonly propertyMap: Map<string, ClassPropertyNode>;
    public readonly methodVisibility: Map<string, boolean>;
    public readonly propertyVisibility: Map<string, boolean>;

    constructor(
        name: string,
        genericName: string,
        typeParams: string[],
        constructors: ClassConstructorNode[],
        methods: ClassMethodNode[],
        properties: ClassPropertyNode[],
        packageName: string | null = null,
        unitId: string | null = null,
        exportedName?: string,
        filePath: string | null = null,
        publicPropertyNames: Iterable<string> = [],
        publicMethodNames: Iterable<string> = []
    ) {
        this.name = name;
        this.genericName = genericName;
        this.exportedName = exportedName ?? genericName;
        this.packageName = packageName;
        this.unitId = unitId;
        this.filePath = filePath;
        this.typeParams = typeParams;
        this.constructors = constructors;
        this.methods = methods;
        this.properties = properties;
        this.methodMap = new Map(methods.map((method) => [method.methodName.name, method]));
        this.propertyMap = new Map(properties.map((property) => [property.bind.var.name, property]));
        this.methodVisibility = buildVisibilityMap(methods.map((method) => method.methodName.name), publicMethodNames);
        this.propertyVisibility = buildVisibilityMap(properties.map((property) => property.bind.var.name), publicPropertyNames);
    }

    isMethodPublic(name: string): boolean {
        return this.methodVisibility.get(name) === true || hasLegacyStdPublicVisibility(this.packageName);
    }

    isPropertyPublic(name: string): boolean {
        return this.propertyVisibility.get(name) === true || hasLegacyStdPublicVisibility(this.packageName);
    }
}

export class FunctionInfo {
    public readonly name: string;
    public readonly exportedName: string;
    public readonly isExported: boolean;
    public readonly packageName: string | null;
    public readonly unitId: string | null;
    public readonly filePath: string | null;
    public readonly paramTypes: TypeVarBindNode[];
    public readonly returnType: AstNode;
    public readonly isDeclared: boolean;
    public readonly body: AstNode | null;
    public paramVars: string[];
    public paramTypeValues: TypeValue[];

    constructor(name: string, paramTypes: TypeVarBindNode[], returnType: AstNode, isDeclared = false, packageName: string | null = null, unitId: string | null = null, exportedName?: string, body: AstNode | null = null, filePath: string | null = null, isExported = true) {
        this.name = name;
        this.exportedName = exportedName ?? name;
        this.isExported = isExported;
        this.packageName = packageName;
        this.unitId = unitId;
        this.filePath = filePath;
        this.paramTypes = paramTypes;
        this.returnType = returnType;
        this.isDeclared = isDeclared;
        this.body = body;
        this.paramVars = paramTypes.map((bind) => bind.var.name);
        this.paramTypeValues = [];
    }
}

export class GenericFunctionInfo {
    public readonly name: string;
    public readonly genericName: string;
    public readonly exportedName: string;
    public readonly packageName: string | null;
    public readonly unitId: string | null;
    public readonly filePath: string | null;
    public readonly typeParams: string[];
    public readonly paramTypes: TypeVarBindNode[];
    public readonly returnType: AstNode;
    public readonly body: AstNode;

    constructor(name: string, genericName: string, typeParams: string[], paramTypes: TypeVarBindNode[], returnType: AstNode, body: AstNode, packageName: string | null = null, unitId: string | null = null, exportedName?: string, filePath: string | null = null) {
        this.name = name;
        this.genericName = genericName;
        this.exportedName = exportedName ?? genericName;
        this.packageName = packageName;
        this.unitId = unitId;
        this.filePath = filePath;
        this.typeParams = typeParams;
        this.paramTypes = paramTypes;
        this.returnType = returnType;
        this.body = body;
    }
}

export class GlobalVarInfo {
    public readonly name: string;
    public readonly exportedName: string;
    public readonly packageName: string | null;
    public readonly unitId: string | null;
    public readonly filePath: string | null;
    public readonly bind: TypeVarBindNode;
    public readonly initializer: AstNode;

    constructor(name: string, bind: TypeVarBindNode, initializer: AstNode, packageName: string | null = null, unitId: string | null = null, exportedName?: string, filePath: string | null = null) {
        this.name = name;
        this.exportedName = exportedName ?? name;
        this.packageName = packageName;
        this.unitId = unitId;
        this.filePath = filePath;
        this.bind = bind;
        this.initializer = initializer;
    }
}

export const classTable: Map<string, ClassInfo> = new Map();
export const genericClassTable: Map<string, GenericClassInfo> = new Map();
export const functionTable: Map<string, FunctionInfo> = new Map();
export const functionOverloadTable: Map<string, FunctionInfo[]> = new Map();
export const genericFunctionTable: Map<string, GenericFunctionInfo> = new Map();
export const globalVarTable: Map<string, GlobalVarInfo> = new Map();

const classLookupState: LookupState<ClassInfo> = {
    canonicalTable: classTable,
    shortLookupTable: new Map(),
    ambiguousShortNames: new Set()
};

const genericClassLookupState: LookupState<GenericClassInfo> = {
    canonicalTable: genericClassTable,
    shortLookupTable: new Map(),
    ambiguousShortNames: new Set()
};

const functionLookupState: LookupState<FunctionInfo> = {
    canonicalTable: functionTable,
    shortLookupTable: new Map(),
    ambiguousShortNames: new Set()
};

const genericFunctionLookupState: LookupState<GenericFunctionInfo> = {
    canonicalTable: genericFunctionTable,
    shortLookupTable: new Map(),
    ambiguousShortNames: new Set()
};

const globalVarLookupState: LookupState<GlobalVarInfo> = {
    canonicalTable: globalVarTable,
    shortLookupTable: new Map(),
    ambiguousShortNames: new Set()
};

const functionOverloadLookupTable: Map<string, FunctionInfo[]> = new Map();
const ambiguousFunctionOverloadNames: Set<string> = new Set();
const genericClassOverloadTable: Map<string, Map<number, GenericClassInfo>> = new Map();
const genericFunctionOverloadTable: Map<string, Map<number, GenericFunctionInfo>> = new Map();
const genericClassOverloadLookupTable: Map<string, Map<number, GenericClassInfo>> = new Map();
const genericFunctionOverloadLookupTable: Map<string, Map<number, GenericFunctionInfo>> = new Map();
const ambiguousGenericClassOverloadNames: Set<string> = new Set();
const ambiguousGenericFunctionOverloadNames: Set<string> = new Set();

function registerGenericOverloadLookup<T extends NamedDefinitionInfo & { genericName: string; typeParams: string[] }>(
    overloadTable: Map<string, Map<number, T>>,
    shortLookupTable: Map<string, Map<number, T>>,
    ambiguousNames: Set<string>,
    info: T
): void {
    const overloads = overloadTable.get(info.genericName) ?? new Map<number, T>();
    overloads.set(info.typeParams.length, info);
    overloadTable.set(info.genericName, overloads);

    if (ambiguousNames.has(info.exportedName)) {
        return;
    }

    const existing = shortLookupTable.get(info.exportedName);
    if (existing === undefined) {
        shortLookupTable.set(info.exportedName, overloads);
        return;
    }
    if (existing !== overloads) {
        shortLookupTable.delete(info.exportedName);
        ambiguousNames.add(info.exportedName);
    }
}

function lookupGenericOverload<T>(overloadTable: Map<string, Map<number, T>>, shortLookupTable: Map<string, Map<number, T>>, name: string, arity?: number): T | undefined {
    const overloads = overloadTable.get(name) ?? shortLookupTable.get(name);
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

function hasGenericOverload<T>(overloadTable: Map<string, Map<number, T>>, shortLookupTable: Map<string, Map<number, T>>, name: string, arity?: number): boolean {
    const overloads = overloadTable.get(name) ?? shortLookupTable.get(name);
    if (overloads === undefined) {
        return false;
    }
    if (arity !== undefined) {
        return overloads.has(arity);
    }
    return overloads.size > 0;
}

function lookupVisibleGenericInfos<T extends NamedDefinitionInfo>(
    referenceNode: AstNode,
    name: string,
    kind: "generic_class" | "generic_function",
    table: Map<string, T>,
    overloadTable: Map<string, Map<number, T>>,
    overloadLookupTable: Map<string, Map<number, T>>,
    arity?: number
): T[] {
    const visibleCanonicalNames = getVisibleGenericPackageSymbolCanonicalNames(referenceNode, name, kind, arity);
    if (visibleCanonicalNames.length > 0) {
        return visibleCanonicalNames
            .map((canonicalName) => table.get(canonicalName))
            .filter((info): info is T => info !== undefined);
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (name.includes("@") && metadata === undefined) {
        const canonicalOverloads = overloadTable.get(name);
        if (canonicalOverloads !== undefined) {
            if (arity !== undefined) {
                const info = canonicalOverloads.get(arity);
                return info === undefined ? [] : [info];
            }
            return Array.from(canonicalOverloads.values());
        }
    }

    const currentPackageCanonicalName = getCurrentPackageCanonicalName(referenceNode, name);
    if (currentPackageCanonicalName !== undefined) {
        const currentPackageOverloads = overloadTable.get(currentPackageCanonicalName);
        if (currentPackageOverloads !== undefined) {
            if (arity !== undefined) {
                const info = currentPackageOverloads.get(arity);
                return info === undefined ? [] : [info];
            }
            return Array.from(currentPackageOverloads.values());
        }
    }

    if (name.includes("@")) {
        return [];
    }

    const canonical = overloadTable.get(name);
    if (canonical !== undefined) {
        if (arity !== undefined) {
            const info = canonical.get(arity);
            return info === undefined ? [] : [info];
        }
        return Array.from(canonical.values());
    }

    const short = overloadLookupTable.get(name);
    if (short !== undefined && Array.from(short.values()).every((info) => info.packageName === null)) {
        if (arity !== undefined) {
            const info = short.get(arity);
            return info === undefined ? [] : [info];
        }
        return Array.from(short.values());
    }

    return [];
}

export function registerClassInfo(info: ClassInfo): void {
    registerLookup(classLookupState, info);
}

export function registerGenericClassInfo(info: GenericClassInfo): void {
    registerLookup(genericClassLookupState, info);
    registerGenericOverloadLookup(genericClassOverloadTable, genericClassOverloadLookupTable, ambiguousGenericClassOverloadNames, info);
}

export function registerFunctionInfo(info: FunctionInfo): void {
    registerLookup(functionLookupState, info);
    const overloads = functionOverloadTable.get(info.name) ?? [];
    overloads.push(info);
    functionOverloadTable.set(info.name, overloads);

    if (info.name === info.exportedName) {
        functionOverloadLookupTable.set(info.exportedName, overloads);
        return;
    }

    if (ambiguousFunctionOverloadNames.has(info.exportedName)) {
        return;
    }

    const existing = functionOverloadLookupTable.get(info.exportedName);
    if (existing === undefined) {
        functionOverloadLookupTable.set(info.exportedName, overloads);
        return;
    }
    if (existing !== overloads) {
        functionOverloadLookupTable.delete(info.exportedName);
        ambiguousFunctionOverloadNames.add(info.exportedName);
    }
}

export function registerGenericFunctionInfo(info: GenericFunctionInfo): void {
    registerLookup(genericFunctionLookupState, info);
    registerGenericOverloadLookup(genericFunctionOverloadTable, genericFunctionOverloadLookupTable, ambiguousGenericFunctionOverloadNames, info);
}

export function registerGlobalVarInfo(info: GlobalVarInfo): void {
    registerLookup(globalVarLookupState, info);
}

export function hasClassInfo(name: string): boolean {
    return hasLookupName(classLookupState, name);
}

export function getClassInfo(name: string): ClassInfo | undefined {
    return lookupByName(classLookupState, name);
}

export function getVisibleClassInfo(referenceNode: AstNode, name: string): ClassInfo | undefined {
    const visibleCanonicalNames = resolveVisibleCanonicalNames(referenceNode, name, ["class"]);
    if (visibleCanonicalNames.length > 0) {
        return classTable.get(visibleCanonicalNames[0]);
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (name.includes("@") && metadata === undefined) {
        const info = classTable.get(name);
        if (info !== undefined) {
            return info;
        }
    }

    const currentPackageCanonicalName = getCurrentPackageCanonicalName(referenceNode, name);
    if (currentPackageCanonicalName !== undefined) {
        const info = classTable.get(currentPackageCanonicalName);
        if (info !== undefined) {
            return info;
        }
    }

    if (name.includes("@")) {
        return undefined;
    }
    return lookupCanonicalOrLegacyByName(classLookupState, name);
}

export function getAllClassInfos(): IterableIterator<ClassInfo> {
    return allLookupValues(classLookupState);
}

export function getClassInfoEntries(): IterableIterator<[string, ClassInfo]> {
    return lookupEntries(classLookupState);
}

export function hasGenericClassInfo(name: string, arity?: number): boolean {
    return hasGenericOverload(genericClassOverloadTable, genericClassOverloadLookupTable, name, arity);
}

export function getGenericClassInfo(name: string, arity?: number): GenericClassInfo | undefined {
    return lookupGenericOverload(genericClassOverloadTable, genericClassOverloadLookupTable, name, arity);
}

export function getVisibleGenericClassInfo(referenceNode: AstNode, name: string, arity?: number): GenericClassInfo | undefined {
    const infos = lookupVisibleGenericInfos(referenceNode, name, "generic_class", genericClassTable, genericClassOverloadTable, genericClassOverloadLookupTable, arity);
    if (infos.length !== 1) {
        return undefined;
    }
    return infos[0];
}

export function hasVisibleGenericClassInfo(referenceNode: AstNode, name: string): boolean {
    return lookupVisibleGenericInfos(referenceNode, name, "generic_class", genericClassTable, genericClassOverloadTable, genericClassOverloadLookupTable).length > 0;
}

export function getAllGenericClassInfos(): IterableIterator<GenericClassInfo> {
    return allLookupValues(genericClassLookupState);
}

export function getGenericClassInfoEntries(): IterableIterator<[string, GenericClassInfo]> {
    return lookupEntries(genericClassLookupState);
}

export function hasFunctionInfo(name: string): boolean {
    return hasLookupName(functionLookupState, name);
}

export function getFunctionInfo(name: string): FunctionInfo | undefined {
    return lookupByName(functionLookupState, name);
}

export function getAllFunctionInfos(): IterableIterator<FunctionInfo> {
    return allLookupValues(functionLookupState);
}

export function getFunctionOverloads(name: string): FunctionInfo[] {
    return functionOverloadTable.get(name) ?? functionOverloadLookupTable.get(name) ?? [];
}

export function getVisibleFunctionOverloads(referenceNode: AstNode, name: string): FunctionInfo[] {
    const visibleCanonicalNames = resolveVisibleCanonicalNames(referenceNode, name, ["function"]);
    if (visibleCanonicalNames.length > 0) {
        const overloads = functionOverloadTable.get(visibleCanonicalNames[0]) ?? [];
        const metadata = getCompilationUnitMetadata(referenceNode);
        const samePackage = metadata !== undefined && overloads.some((info) => info.packageName === metadata.packageName);
        return samePackage ? overloads : overloads.filter((info) => info.isExported);
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (name.includes("@") && metadata === undefined) {
        const overloads = functionOverloadTable.get(name);
        if (overloads !== undefined) {
            return overloads;
        }
    }

    const currentPackageCanonicalName = getCurrentPackageCanonicalName(referenceNode, name);
    if (currentPackageCanonicalName !== undefined) {
        const overloads = functionOverloadTable.get(currentPackageCanonicalName);
        if (overloads !== undefined) {
            return overloads;
        }
    }

    if (name.includes("@")) {
        return [];
    }

    const canonical = functionOverloadTable.get(name);
    if (canonical !== undefined) {
        return canonical;
    }

    const short = functionOverloadLookupTable.get(name);
    if (short !== undefined && short.every((info) => info.packageName === null)) {
        return short;
    }

    return [];
}

export function getFunctionOverloadEntries(): IterableIterator<[string, FunctionInfo[]]> {
    return functionOverloadTable.entries();
}

export function hasGenericFunctionInfo(name: string, arity?: number): boolean {
    return hasGenericOverload(genericFunctionOverloadTable, genericFunctionOverloadLookupTable, name, arity);
}

export function getGenericFunctionInfo(name: string, arity?: number): GenericFunctionInfo | undefined {
    return lookupGenericOverload(genericFunctionOverloadTable, genericFunctionOverloadLookupTable, name, arity);
}

export function getVisibleGenericFunctionInfo(referenceNode: AstNode, name: string, arity?: number): GenericFunctionInfo | undefined {
    const infos = lookupVisibleGenericInfos(referenceNode, name, "generic_function", genericFunctionTable, genericFunctionOverloadTable, genericFunctionOverloadLookupTable, arity);
    if (infos.length !== 1) {
        return undefined;
    }
    return infos[0];
}

export function hasVisibleGenericFunctionInfo(referenceNode: AstNode, name: string): boolean {
    return lookupVisibleGenericInfos(referenceNode, name, "generic_function", genericFunctionTable, genericFunctionOverloadTable, genericFunctionOverloadLookupTable).length > 0;
}

export function hasGlobalVarInfo(name: string): boolean {
    return hasLookupName(globalVarLookupState, name);
}

export function getGlobalVarInfo(name: string): GlobalVarInfo | undefined {
    return lookupByName(globalVarLookupState, name);
}

export function getAllGlobalVarInfos(): IterableIterator<GlobalVarInfo> {
    return allLookupValues(globalVarLookupState);
}

export function getGlobalVarInfoEntries(): IterableIterator<[string, GlobalVarInfo]> {
    return lookupEntries(globalVarLookupState);
}

export function getVisibleGlobalVarInfo(referenceNode: AstNode, name: string): GlobalVarInfo | undefined {
    const visibleCanonicalNames = resolveVisibleCanonicalNames(referenceNode, name, ["global"]);
    if (visibleCanonicalNames.length > 0) {
        return globalVarTable.get(visibleCanonicalNames[0]);
    }

    const metadata = getCompilationUnitMetadata(referenceNode);
    if (name.includes("@") && metadata === undefined) {
        const info = globalVarTable.get(name);
        if (info !== undefined) {
            return info;
        }
    }

    const currentPackageCanonicalName = getCurrentPackageCanonicalName(referenceNode, name);
    if (currentPackageCanonicalName !== undefined) {
        const info = globalVarTable.get(currentPackageCanonicalName);
        if (info !== undefined) {
            return info;
        }
    }

    if (name.includes("@")) {
        return undefined;
    }
    return lookupCanonicalOrLegacyByName(globalVarLookupState, name);
}

export function getAllGenericFunctionInfos(): IterableIterator<GenericFunctionInfo> {
    return allLookupValues(genericFunctionLookupState);
}

export function getGenericFunctionInfoEntries(): IterableIterator<[string, GenericFunctionInfo]> {
    return lookupEntries(genericFunctionLookupState);
}

export function resetClassInfoTables(): void {
    resetLookupState(classLookupState);
    resetLookupState(genericClassLookupState);
}

export function resetDefinitionInfoTables(): void {
    resetClassInfoTables();
    resetLookupState(functionLookupState);
    functionOverloadTable.clear();
    functionOverloadLookupTable.clear();
    ambiguousFunctionOverloadNames.clear();
    resetLookupState(genericFunctionLookupState);
    genericClassOverloadTable.clear();
    genericFunctionOverloadTable.clear();
    genericClassOverloadLookupTable.clear();
    genericFunctionOverloadLookupTable.clear();
    ambiguousGenericClassOverloadNames.clear();
    ambiguousGenericFunctionOverloadNames.clear();
    resetLookupState(globalVarLookupState);
}
