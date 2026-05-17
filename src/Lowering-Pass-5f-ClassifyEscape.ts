import type {
    EscapeAnalysisResult,
    EscapeClassification,
    EscapeSiteInfo,
    FreeVarAnalysisResult,
    LoweredExpr,
    ShrunkClosureProgram,
    TinyInlinedProgram
} from "./Lowering-Frontend-Shared";

type UseContext = "value" | "returned" | "call_callee" | "argument" | "stored";

interface EscapeSeed {
    readonly sourceId?: string;
    readonly bindingName?: string;
}

type MutableEscapeSite = {
    -readonly [K in keyof Omit<EscapeSiteInfo, "classification">]: Omit<EscapeSiteInfo, "classification">[K];
} & {
    classification?: EscapeClassification;
};

interface AnalysisState {
    lambdaCounter: number;
    boundMethodCounter: number;
    objectCounter: number;
    unionCounter: number;
    readonly freeVarAnalysis: FreeVarAnalysisResult;
    readonly sites: Map<string, MutableEscapeSite>;
}

function mergeSourceIds(...groups: ReadonlyArray<readonly string[] | undefined>): readonly string[] | undefined {
    const merged = new Set<string>();
    for (const group of groups) {
        if (!group) {
            continue;
        }
        for (const sourceId of group) {
            merged.add(sourceId);
        }
    }
    return merged.size > 0 ? Array.from(merged) : undefined;
}

function noteUse(site: MutableEscapeSite, context: UseContext): void {
    switch (context) {
        case "call_callee":
            site.localCallUses += 1;
            return;
        case "returned":
            site.returned = true;
            return;
        case "stored":
            site.stored = true;
            return;
        case "argument":
            site.argumentEscapes = true;
            return;
        case "value":
            return;
    }
}

function classifySite(site: MutableEscapeSite): EscapeClassification {
    if (site.returned) {
        return "returned";
    }
    if (site.stored) {
        return "stored";
    }
    if (site.argumentEscapes) {
        return "argument_escape";
    }
    if ((site.sourceKind === "lambda" || site.sourceKind === "bound_method") && site.localCallUses > 0) {
        return "non_escaping";
    }
    return "local_only";
}

function ensureSite(
    state: AnalysisState,
    sourceId: string,
    ownerId: string,
    sourceKind: EscapeSiteInfo["sourceKind"],
    bindingName?: string,
    lambdaSiteId?: string,
    boundMethodSiteId?: string,
    capturesMutableLocal = false
): MutableEscapeSite {
    const existing = state.sites.get(sourceId);
    if (existing) {
        return existing;
    }
    const created: MutableEscapeSite = {
        sourceId,
        ownerId,
        bindingName,
        sourceKind,
        lambdaSiteId,
        boundMethodSiteId,
        localCallUses: 0,
        returned: false,
        stored: false,
        argumentEscapes: false,
        capturesMutableLocal
    };
    state.sites.set(sourceId, created);
    return created;
}

function analyzeFnExpr(
    expr: Extract<LoweredExpr, { readonly kind: "fn" }>,
    env: Map<string, readonly string[]>,
    context: UseContext,
    state: AnalysisState,
    ownerId: string,
    seed?: EscapeSeed
): readonly string[] {
    const lambdaSiteId = `fn_${state.lambdaCounter}`;
    state.lambdaCounter += 1;
    const lambdaInfo = state.freeVarAnalysis.lambdaSites.get(lambdaSiteId);
    if (!lambdaInfo) {
        throw new Error(`Pass 5f escape classification failed: missing free-var info for lambda site '${lambdaSiteId}'`);
    }
    const sourceId = seed?.sourceId ?? `${ownerId}:${lambdaSiteId}`;
    const site = ensureSite(state, sourceId, ownerId, "lambda", seed?.bindingName, lambdaSiteId, undefined, lambdaInfo.capturesMutableLocal);
    const bodyEnv = new Map(env);
    for (const param of expr.params) {
        bodyEnv.delete(param.name);
    }
    analyzeValue(expr.body, bodyEnv, "returned", state, sourceId);
    noteUse(site, context);
    return [sourceId];
}

function analyzeBoundMethodExpr(
    expr: Extract<LoweredExpr, { readonly kind: "method_closure_create" }>,
    env: Map<string, readonly string[]>,
    context: UseContext,
    state: AnalysisState,
    ownerId: string,
    seed?: EscapeSeed
): readonly string[] {
    const boundMethodSiteId = `method_closure_${state.boundMethodCounter}`;
    state.boundMethodCounter += 1;
    const boundInfo = state.freeVarAnalysis.boundMethodSites.get(boundMethodSiteId);
    if (!boundInfo) {
        throw new Error(`Pass 5f escape classification failed: missing bound-method capture info for site '${boundMethodSiteId}'`);
    }
    analyzeValue(expr.receiver, env, "value", state, ownerId);
    const sourceId = seed?.sourceId ?? `${ownerId}:${boundMethodSiteId}`;
    const site = ensureSite(state, sourceId, ownerId, "bound_method", seed?.bindingName, undefined, boundMethodSiteId, false);
    noteUse(site, context);
    return [sourceId];
}

function analyzeObjectExpr(
    context: UseContext,
    state: AnalysisState,
    ownerId: string,
    seed?: EscapeSeed
): readonly string[] {
    const objectSiteId = `fresh_object_${state.objectCounter}`;
    state.objectCounter += 1;
    const sourceId = seed?.sourceId ?? `${ownerId}:${objectSiteId}`;
    const site = ensureSite(state, sourceId, ownerId, "fresh_object", seed?.bindingName);
    noteUse(site, context);
    return [sourceId];
}

function analyzeUnionExpr(
    expr: Extract<LoweredExpr, { readonly kind: "union_inject" }>,
    env: Map<string, readonly string[]>,
    context: UseContext,
    state: AnalysisState,
    ownerId: string,
    seed?: EscapeSeed
): readonly string[] {
    analyzeValue(expr.value, env, "stored", state, ownerId);
    const unionSiteId = `fresh_union_${state.unionCounter}`;
    state.unionCounter += 1;
    const sourceId = seed?.sourceId ?? `${ownerId}:${unionSiteId}`;
    const site = ensureSite(state, sourceId, ownerId, "fresh_union", seed?.bindingName);
    noteUse(site, context);
    return [sourceId];
}

function analyzeValue(
    expr: LoweredExpr,
    env: Map<string, readonly string[]>,
    context: UseContext,
    state: AnalysisState,
    ownerId: string,
    seed?: EscapeSeed
): readonly string[] | undefined {
    switch (expr.kind) {
        case "identifier": {
            const sourceIds = env.get(expr.name);
            if (!sourceIds) {
                return undefined;
            }
            for (const sourceId of sourceIds) {
                const site = state.sites.get(sourceId);
                if (!site) {
                    throw new Error(`Pass 5f escape classification failed: missing tracked source '${sourceId}' for identifier '${expr.name}'`);
                }
                noteUse(site, context);
            }
            return sourceIds;
        }
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
            return undefined;
        case "object_alloc":
            return analyzeObjectExpr(context, state, ownerId, seed);
        case "fn":
            return analyzeFnExpr(expr, env, context, state, ownerId, seed);
        case "method_closure_create":
            return analyzeBoundMethodExpr(expr, env, context, state, ownerId, seed);
        case "union_inject":
            return analyzeUnionExpr(expr, env, context, state, ownerId, seed);
        case "let": {
            const scopedEnv = new Map(env);
            for (const binding of expr.bindings) {
                const bindingSourceId = analyzeValue(binding.value, scopedEnv, "value", state, ownerId, {
                    sourceId: `${ownerId}:${binding.bind.name}`,
                    bindingName: binding.bind.name
                });
                if (bindingSourceId && bindingSourceId.length > 0) {
                    scopedEnv.set(binding.bind.name, bindingSourceId);
                } else {
                    scopedEnv.delete(binding.bind.name);
                }
            }
            return analyzeValue(expr.body, scopedEnv, context, state, ownerId);
        }
        case "if": {
            analyzeValue(expr.condExpr, new Map(env), "value", state, ownerId);
            const trueSite = analyzeValue(expr.trueBranchExpr, new Map(env), context, state, ownerId);
            const falseSite = analyzeValue(expr.falseBranchExpr, new Map(env), context, state, ownerId);
            return mergeSourceIds(trueSite, falseSite);
        }
        case "while":
            analyzeValue(expr.condExpr, new Map(env), "value", state, ownerId);
            analyzeValue(expr.bodyExpr, new Map(env), "value", state, ownerId);
            return undefined;
        case "seq": {
            const scopedEnv = new Map(env);
            for (let index = 0; index < expr.expressions.length; index += 1) {
                const inner = expr.expressions[index];
                const innerContext = index === expr.expressions.length - 1 ? context : "value";
                const result = analyzeValue(inner, scopedEnv, innerContext, state, ownerId);
                if (index === expr.expressions.length - 1) {
                    return result;
                }
            }
            return undefined;
        }
        case "set_local": {
            const assignedSourceId = analyzeValue(expr.value, env, "value", state, ownerId);
            if (assignedSourceId && assignedSourceId.length > 0) {
                env.set(expr.identifier, assignedSourceId);
            } else {
                env.delete(expr.identifier);
            }
            return undefined;
        }
        case "call":
            analyzeValue(expr.callee, new Map(env), "call_callee", state, ownerId);
            for (const arg of expr.args) {
                analyzeValue(arg, new Map(env), "argument", state, ownerId);
            }
            return undefined;
        case "direct_call":
            for (let index = 0; index < expr.args.length; index += 1) {
                const arg = expr.args[index];
                const argContext: UseContext = expr.symbol.startsWith("__iw_lowered_ctor_") && index === 0
                    ? "value"
                    : "argument";
                analyzeValue(arg, new Map(env), argContext, state, ownerId);
            }
            return undefined;
        case "object_get_field":
            analyzeValue(expr.receiver, new Map(env), "value", state, ownerId);
            return undefined;
        case "object_set_field":
            analyzeValue(expr.receiver, new Map(env), "value", state, ownerId);
            analyzeValue(expr.value, new Map(env), "stored", state, ownerId);
            return undefined;
        case "match": {
            analyzeValue(expr.unionExpr, new Map(env), "value", state, ownerId);
            let branchSites: readonly string[] | undefined;
            for (const branch of expr.branches) {
                const branchEnv = new Map(env);
                branchEnv.delete(branch.bind.name);
                const branchSite = analyzeValue(branch.body, branchEnv, context, state, ownerId);
                branchSites = mergeSourceIds(branchSites, branchSite);
            }
            return branchSites;
        }
        case "cond":
        case "dvar":
            throw new Error(`Pass 5f escape classification failed: unexpected node kind '${expr.kind}'`);
    }
}

export function classifyEscapePass(program: TinyInlinedProgram | ShrunkClosureProgram, freeVarAnalysis: FreeVarAnalysisResult): EscapeAnalysisResult {
    const state: AnalysisState = {
        lambdaCounter: 0,
        boundMethodCounter: 0,
        objectCounter: 0,
        unionCounter: 0,
        freeVarAnalysis,
        sites: new Map()
    };

    for (const statement of program.topLevelStatements) {
        analyzeValue(statement, new Map(), "value", state, "<top>");
    }
    for (const fn of program.functions) {
        const env = new Map<string, readonly string[]>();
        for (const param of fn.params) {
            env.delete(param.name);
        }
        analyzeValue(fn.body, env, "returned", state, fn.symbol);
    }

    const sites: EscapeSiteInfo[] = Array.from(state.sites.values())
        .map((site) => ({
            ...site,
            classification: classifySite(site)
        }))
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId));

    return {
        kind: "escape_analysis",
        sites
    };
}