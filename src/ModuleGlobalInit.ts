import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    CondNode,
    DfunNode,
    DvarNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    GenericDfunNode,
    IdentifierNode,
    IfNode,
    ImportNode,
    LetNode,
    ListNode,
    MatchNode,
    ProgramNode,
    SeqNode,
    SetNode,
    SquareParenListNode,
    CurlyParenListNode,
    RoundParenListNode,
    TextDatabaseReferenceNode,
    TypeToFromNode,
    TypeUnionNode,
    TypeVarBindNode,
    WhileNode
} from "./AstNode";
import {
    FunctionInfo,
    GenericFunctionInfo,
    GlobalVarInfo,
    getAllFunctionInfos,
    getAllGenericFunctionInfos,
    getAllGlobalVarInfos,
    getVisibleFunctionOverloads,
    getVisibleGenericFunctionInfo,
    getVisibleGlobalVarInfo
} from "./Typecheck-Core";
import { relative } from "path";

export interface ModuleGlobalInitDefinition {
    readonly symbol: string;
    readonly exportedName: string;
    readonly packageName: string;
    readonly unitId: string;
    readonly filePath: string | null;
    readonly bind: TypeVarBindNode;
    readonly initializer: AstNode;
    readonly dependsOn: readonly string[];
}

export interface ModuleGlobalInitPlan {
    readonly globals: readonly ModuleGlobalInitDefinition[];
    readonly initializationOrder: readonly string[];
    readonly definitionReads: ReadonlyMap<string, readonly string[]>;
    readonly definitionCallees: ReadonlyMap<string, readonly string[]>;
}

interface DefinitionSummary {
    readonly reads: Set<string>;
    readonly callees: Set<string>;
    readonly hasForbiddenEffect: boolean;
    readonly forbiddenReason: string | null;
}

interface ModuleDefinitionState {
    readonly name: string;
    readonly kind: "function" | "generic_function" | "global_init";
    readonly directReads: Set<string>;
    readonly callees: Set<string>;
    hasForbiddenEffect: boolean;
    forbiddenReason: string | null;
    readonly sourceLabel: string;
}

interface AnalysisScope {
    readonly locals: ReadonlySet<string>;
}

const PURE_BUILTIN_CALL_NAMES: ReadonlySet<string> = new Set([
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
    "iw_i5_to_f5",
    "iw_sin_f5",
    "iw_cos_f5",
    "iw_sqrt_f5",
    "iw_atan2_f5"
]);

function isPureBuiltinCallName(name: string): boolean {
    if (PURE_BUILTIN_CALL_NAMES.has(name)) {
        return true;
    }
    if (/^(val_to|bin_to)_[a-z0-9]+$/i.test(name)) {
        return true;
    }
    if (name.includes("iw_ty_to_") || name.includes("iw_bin_to_")) {
        return true;
    }
    if (name.includes("iw_round_") || name.includes("iw_floor_") || name.includes("iw_ceil_") || name.includes("iw_trunc_")) {
        return true;
    }
    if (name.includes("iw_sin_") || name.includes("iw_cos_") || name.includes("iw_sqrt_") || name.includes("iw_atan2_")) {
        return true;
    }
    return false;
}

let currentModuleGlobalInitPlan: ModuleGlobalInitPlan = {
    globals: [],
    initializationOrder: [],
    definitionReads: new Map(),
    definitionCallees: new Map()
};

function cloneScope(scope: AnalysisScope, ...newLocalNames: string[]): AnalysisScope {
    return {
        locals: new Set([...scope.locals, ...newLocalNames])
    };
}

function formatDiagnosticPath(filePath: string | null): string {
    if (filePath === null) {
        return "<unknown file>";
    }
    const relativePath = relative(process.cwd(), filePath);
    return relativePath.length === 0 ? filePath : relativePath;
}

function formatDefinitionLocation(unitId: string | null, filePath: string | null): string {
    const unitLabel = unitId ?? "<legacy>";
    return `unit ${unitLabel}, file ${formatDiagnosticPath(filePath)}`;
}

function describeGlobal(globalInfo: GlobalVarInfo): string {
    return `global '${globalInfo.name}' (${formatDefinitionLocation(globalInfo.unitId, globalInfo.filePath)})`;
}

function describeFunction(info: FunctionInfo | GenericFunctionInfo): string {
    return `function '${info.name}' (${formatDefinitionLocation(info.unitId, info.filePath)})`;
}

function registerForbiddenEffect(state: ModuleDefinitionState, reason: string): void {
    if (!state.hasForbiddenEffect) {
        state.hasForbiddenEffect = true;
        state.forbiddenReason = reason;
    }
}

function analyzeDirectCall(callee: AstNode, state: ModuleDefinitionState, scope: AnalysisScope): void {
    if (callee instanceof IdentifierNode && !scope.locals.has(callee.name)) {
        const overloads = getVisibleFunctionOverloads(callee, callee.name);
        if (overloads.length > 0) {
            if (overloads.some((info) => info.isDeclared)) {
                if (isPureBuiltinCallName(callee.name)) {
                    return;
                }
                registerForbiddenEffect(state, `${state.sourceLabel} may call declared function '${callee.name}' during global initialization`);
                return;
            }
            overloads.forEach((info) => state.callees.add(info.name));
            return;
        }

        if (isPureBuiltinCallName(callee.name)) {
            return;
        }

        if (callee.name.startsWith("iw_")) {
            registerForbiddenEffect(state, `${state.sourceLabel} may call impure builtin '${callee.name}' during global initialization`);
        }
        return;
    }

    if (callee instanceof GenericCallNode && callee.callee instanceof IdentifierNode && !scope.locals.has(callee.callee.name)) {
        const genericInfo = getVisibleGenericFunctionInfo(callee.callee, callee.callee.name, callee.typeArgs.length);
        if (genericInfo !== undefined) {
            state.callees.add(genericInfo.name);
            return;
        }

        if (isPureBuiltinCallName(callee.callee.name)) {
            return;
        }

        if (callee.callee.name.startsWith("iw_")) {
            registerForbiddenEffect(state, `${state.sourceLabel} may call impure builtin '${callee.callee.name}' during global initialization`);
        }
    }
}

function analyzeAst(node: AstNode, state: ModuleDefinitionState, scope: AnalysisScope): void {
    if (node instanceof IdentifierNode) {
        if (scope.locals.has(node.name)) {
            return;
        }
        const globalInfo = getVisibleGlobalVarInfo(node, node.name);
        if (globalInfo !== undefined) {
            state.directReads.add(globalInfo.name);
        }
        return;
    }

    if (node instanceof FunctionCallNode) {
        analyzeDirectCall(node.callee, state, scope);
        analyzeAst(node.callee, state, scope);
        node.args.forEach((arg) => analyzeAst(arg, state, scope));
        return;
    }

    if (node instanceof GenericCallNode) {
        analyzeAst(node.callee, state, scope);
        node.typeArgs.forEach((arg) => analyzeAst(arg, state, scope));
        return;
    }

    if (node instanceof SetNode) {
        if (!scope.locals.has(node.identifier.name)) {
            const globalInfo = getVisibleGlobalVarInfo(node.identifier, node.identifier.name);
            if (globalInfo !== undefined) {
                registerForbiddenEffect(state, `${state.sourceLabel} may assign to ${describeGlobal(globalInfo)} during global initialization`);
            }
        }
        analyzeAst(node.value, state, scope);
        return;
    }

    if (node instanceof DvarNode) {
        if (!(node.bind instanceof TypeVarBindNode)) {
            throw new Error("module global init analysis expected dvar to use TypeVarBindNode");
        }
        analyzeAst(node.value, state, scope);
        return;
    }

    if (node instanceof LetNode) {
        let currentScope = scope;
        for (const binding of node.bindings) {
            analyzeAst(binding.value, state, currentScope);
            if (binding.bind instanceof TypeVarBindNode) {
                currentScope = cloneScope(currentScope, binding.bind.var.name);
                analyzeAst(binding.bind.typeExp, state, currentScope);
            } else {
                analyzeAst(binding.bind, state, currentScope);
            }
        }
        analyzeAst(node.body, state, currentScope);
        return;
    }

    if (node instanceof FnNode) {
        const fnScope = cloneScope(scope, ...node.params.map((param) => param.var.name));
        node.params.forEach((param) => analyzeAst(param.typeExp, state, fnScope));
        analyzeAst(node.returnType, state, fnScope);
        analyzeAst(node.body, state, fnScope);
        return;
    }

    if (node instanceof DfunNode || node instanceof GenericDfunNode) {
        return;
    }

    if (node instanceof IfNode) {
        analyzeAst(node.condExpr, state, scope);
        analyzeAst(node.trueBranchExpr, state, scope);
        analyzeAst(node.falseBranchExpr, state, scope);
        return;
    }

    if (node instanceof WhileNode) {
        analyzeAst(node.condExpr, state, scope);
        analyzeAst(node.bodyExpr, state, scope);
        return;
    }

    if (node instanceof CondNode) {
        node.clausesExprs.forEach((clause) => {
            analyzeAst(clause.cond, state, scope);
            analyzeAst(clause.body, state, scope);
        });
        return;
    }

    if (node instanceof MatchNode) {
        analyzeAst(node.unionExpr, state, scope);
        node.branches.forEach((branch) => {
            analyzeAst(branch.bind.typeExp, state, scope);
            analyzeAst(branch.body, state, cloneScope(scope, branch.bind.var.name));
        });
        return;
    }

    if (node instanceof SeqNode) {
        node.expressions.forEach((expr) => analyzeAst(expr, state, scope));
        return;
    }

    if (node instanceof ListNode || node instanceof SquareParenListNode || node instanceof CurlyParenListNode || node instanceof RoundParenListNode) {
        node.elements.forEach((element) => analyzeAst(element, state, scope));
        return;
    }

    if (node instanceof ProgramNode) {
        node.topLevelExpressions.forEach((expr) => analyzeAst(expr, state, scope));
        return;
    }

    if (node instanceof TypeVarBindNode) {
        analyzeAst(node.typeExp, state, scope);
        return;
    }

    if (node instanceof TypeToFromNode) {
        node.paramTypes.forEach((paramType) => analyzeAst(paramType, state, scope));
        analyzeAst(node.returnType, state, scope);
        return;
    }

    if (node instanceof TypeUnionNode) {
        node.types.forEach((member) => analyzeAst(member, state, scope));
        return;
    }

    if (node instanceof ClassConstructorNode) {
        const ctorScope = cloneScope(scope, ...node.params.map((param) => param.var.name));
        node.params.forEach((param) => analyzeAst(param.typeExp, state, ctorScope));
        analyzeAst(node.body, state, ctorScope);
        return;
    }

    if (node instanceof ClassMethodNode) {
        const methodScope = cloneScope(scope, ...node.params.map((param) => param.var.name));
        node.params.forEach((param) => analyzeAst(param.typeExp, state, methodScope));
        analyzeAst(node.returnType, state, methodScope);
        analyzeAst(node.body, state, methodScope);
        return;
    }

    if (node instanceof ImportNode || node instanceof TextDatabaseReferenceNode) {
        return;
    }
}

function summarizeFunction(info: FunctionInfo): DefinitionSummary {
    const state: ModuleDefinitionState = {
        name: info.name,
        kind: "function",
        directReads: new Set<string>(),
        callees: new Set<string>(),
        hasForbiddenEffect: false,
        forbiddenReason: null,
        sourceLabel: describeFunction(info)
    };
    if (info.body !== null) {
        analyzeAst(info.body, state, { locals: new Set(info.paramVars) });
    }
    return {
        reads: state.directReads,
        callees: state.callees,
        hasForbiddenEffect: state.hasForbiddenEffect,
        forbiddenReason: state.forbiddenReason
    };
}

function summarizeGenericFunction(info: GenericFunctionInfo): DefinitionSummary {
    const state: ModuleDefinitionState = {
        name: info.name,
        kind: "generic_function",
        directReads: new Set<string>(),
        callees: new Set<string>(),
        hasForbiddenEffect: false,
        forbiddenReason: null,
        sourceLabel: describeFunction(info)
    };
    analyzeAst(info.body, state, { locals: new Set(info.paramTypes.map((param) => param.var.name)) });
    return {
        reads: state.directReads,
        callees: state.callees,
        hasForbiddenEffect: state.hasForbiddenEffect,
        forbiddenReason: state.forbiddenReason
    };
}

function summarizeGlobal(info: GlobalVarInfo): DefinitionSummary {
    const state: ModuleDefinitionState = {
        name: info.name,
        kind: "global_init",
        directReads: new Set<string>(),
        callees: new Set<string>(),
        hasForbiddenEffect: false,
        forbiddenReason: null,
        sourceLabel: describeGlobal(info)
    };
    analyzeAst(info.initializer, state, { locals: new Set() });
    return {
        reads: state.directReads,
        callees: state.callees,
        hasForbiddenEffect: state.hasForbiddenEffect,
        forbiddenReason: state.forbiddenReason
    };
}

function sortNames(values: Iterable<string>): string[] {
    return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function formatGlobalCycleNode(globalDef: ModuleGlobalInitDefinition | undefined, symbol: string): string {
    if (globalDef === undefined) {
        return symbol;
    }
    return `${symbol} [${formatDefinitionLocation(globalDef.unitId, globalDef.filePath)}]`;
}

function topoSortGlobals(globalDefs: readonly ModuleGlobalInitDefinition[], depsByGlobal: ReadonlyMap<string, ReadonlySet<string>>): string[] {
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    const globalBySymbol = new Map(globalDefs.map((globalDef) => [globalDef.symbol, globalDef] as const));

    const visit = (name: string): void => {
        if (visited.has(name)) {
            return;
        }
        if (visiting.has(name)) {
            const cycleStart = stack.indexOf(name);
            const cycle = [...stack.slice(cycleStart), name];
            throw new Error(`module global initialization cycle detected: ${cycle.map((symbol) => formatGlobalCycleNode(globalBySymbol.get(symbol), symbol)).join(" -> ")}`);
        }

        visiting.add(name);
        stack.push(name);
        const deps = sortNames(depsByGlobal.get(name) ?? []);
        for (const dep of deps) {
            visit(dep);
        }
        stack.pop();
        visiting.delete(name);
        visited.add(name);
        ordered.push(name);
    };

    sortNames(globalDefs.map((globalDef) => globalDef.symbol)).forEach((name) => visit(name));
    return ordered;
}

export function resetModuleGlobalInitPlan(): void {
    currentModuleGlobalInitPlan = {
        globals: [],
        initializationOrder: [],
        definitionReads: new Map(),
        definitionCallees: new Map()
    };
}

export function getModuleGlobalInitPlan(): ModuleGlobalInitPlan {
    return currentModuleGlobalInitPlan;
}

export function computeReachableModuleGlobals(rootDefinitions: readonly string[]): readonly string[] {
    const reachableGlobals = new Set<string>();
    const visitedDefinitions = new Set<string>();
    const worklist = [...rootDefinitions];
    const knownGlobals = new Set(currentModuleGlobalInitPlan.globals.map((globalDef) => globalDef.symbol));

    while (worklist.length > 0) {
        const definitionName = worklist.pop();
        if (definitionName === undefined || visitedDefinitions.has(definitionName)) {
            continue;
        }
        visitedDefinitions.add(definitionName);

        const reads = currentModuleGlobalInitPlan.definitionReads.get(definitionName) ?? [];
        for (const readName of reads) {
            if (!knownGlobals.has(readName)) {
                continue;
            }
            reachableGlobals.add(readName);
            worklist.push(readName);
        }

        const callees = currentModuleGlobalInitPlan.definitionCallees.get(definitionName) ?? [];
        callees.forEach((calleeName) => worklist.push(calleeName));
    }

    return currentModuleGlobalInitPlan.initializationOrder.filter((symbol) => reachableGlobals.has(symbol));
}

export function validateAndBuildModuleGlobalInitPlan(): ModuleGlobalInitPlan {
    const moduleGlobals = Array.from(getAllGlobalVarInfos())
        .filter((info): info is GlobalVarInfo & { packageName: string; unitId: string } => info.packageName !== null && info.unitId !== null)
        .map<ModuleGlobalInitDefinition>((info) => ({
            symbol: info.name,
            exportedName: info.exportedName,
            packageName: info.packageName,
            unitId: info.unitId,
            filePath: info.filePath,
            bind: info.bind,
            initializer: info.initializer,
            dependsOn: []
        }))
        .sort((left, right) => left.symbol.localeCompare(right.symbol));

    if (moduleGlobals.length === 0) {
        resetModuleGlobalInitPlan();
        return currentModuleGlobalInitPlan;
    }

    const allGlobalInfos = Array.from(getAllGlobalVarInfos());
    const registeredGlobalsByName = new Map(allGlobalInfos.map((info) => [info.name, info] as const));
    const definitions = new Map<string, ModuleDefinitionState>();
    for (const fn of getAllFunctionInfos()) {
        const summary = summarizeFunction(fn);
        definitions.set(fn.name, {
            name: fn.name,
            kind: "function",
            directReads: new Set(summary.reads),
            callees: new Set(summary.callees),
            hasForbiddenEffect: summary.hasForbiddenEffect,
            forbiddenReason: summary.forbiddenReason,
            sourceLabel: describeFunction(fn)
        });
    }
    for (const fn of getAllGenericFunctionInfos()) {
        const summary = summarizeGenericFunction(fn);
        definitions.set(fn.name, {
            name: fn.name,
            kind: "generic_function",
            directReads: new Set(summary.reads),
            callees: new Set(summary.callees),
            hasForbiddenEffect: summary.hasForbiddenEffect,
            forbiddenReason: summary.forbiddenReason,
            sourceLabel: describeFunction(fn)
        });
    }
    for (const globalInfo of moduleGlobals) {
        const registeredGlobal = registeredGlobalsByName.get(globalInfo.symbol);
        if (registeredGlobal === undefined) {
            throw new Error(`internal error: missing global info for '${globalInfo.symbol}'`);
        }
        const summary = summarizeGlobal(registeredGlobal);
        definitions.set(globalInfo.symbol, {
            name: globalInfo.symbol,
            kind: "global_init",
            directReads: new Set(summary.reads),
            callees: new Set(summary.callees),
            hasForbiddenEffect: summary.hasForbiddenEffect,
            forbiddenReason: summary.forbiddenReason,
            sourceLabel: describeGlobal(registeredGlobal)
        });
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const definition of definitions.values()) {
            for (const calleeName of definition.callees) {
                const calleeDefinition = definitions.get(calleeName);
                if (calleeDefinition === undefined) {
                    continue;
                }
                const readCount = definition.directReads.size;
                calleeDefinition.directReads.forEach((readName) => definition.directReads.add(readName));
                if (definition.directReads.size !== readCount) {
                    changed = true;
                }
                if (!definition.hasForbiddenEffect && calleeDefinition.hasForbiddenEffect) {
                    definition.hasForbiddenEffect = true;
                    definition.forbiddenReason = calleeDefinition.forbiddenReason;
                    changed = true;
                }
            }
        }
    }

    const depsByGlobal = new Map<string, ReadonlySet<string>>();
    const realizedGlobals = new Map(moduleGlobals.map((globalDef) => [globalDef.symbol, globalDef]));
    for (const globalDef of moduleGlobals) {
        const state = definitions.get(globalDef.symbol);
        if (state === undefined) {
            throw new Error(`internal error: missing global init state for '${globalDef.symbol}'`);
        }
        if (state.hasForbiddenEffect && state.forbiddenReason !== null) {
            throw new Error(state.forbiddenReason);
        }
        const deps = new Set<string>();
        state.directReads.forEach((name) => {
            if (realizedGlobals.has(name)) {
                deps.add(name);
            }
        });
        if (deps.has(globalDef.symbol)) {
            throw new Error(`module global initializer for '${globalDef.symbol}' may read itself (${formatDefinitionLocation(globalDef.unitId, globalDef.filePath)})`);
        }
        depsByGlobal.set(globalDef.symbol, deps);
    }

    const initializationOrder = topoSortGlobals(moduleGlobals, depsByGlobal);
    const globals = moduleGlobals.map((globalDef) => ({
        ...globalDef,
        dependsOn: sortNames(depsByGlobal.get(globalDef.symbol) ?? [])
    }));
    const definitionReads = new Map<string, readonly string[]>();
    const definitionCallees = new Map<string, readonly string[]>();
    for (const [name, definition] of definitions.entries()) {
        definitionReads.set(name, sortNames(definition.directReads));
        definitionCallees.set(name, sortNames(definition.callees));
    }
    currentModuleGlobalInitPlan = {
        globals,
        initializationOrder,
        definitionReads,
        definitionCallees
    };
    return currentModuleGlobalInitPlan;
}
