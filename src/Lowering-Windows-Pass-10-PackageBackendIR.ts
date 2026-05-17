import type {
    BackendValueRepresentation,
    BackendFunctionIR,
    FinalBackendIRProgram,
    GcRootPlan,
    RepresentationSelectionProgram
} from "./backend-windows/Backend-Windows-IR-Shared";
import type { NoOptimizeX64PassBundle } from "./backend-windows/Backend-Windows-NoOptimize-Program";
import type { OptimizedX64PassBundle } from "./backend-windows/Backend-Windows-Optimize-Program";
import type { BackendExternFunctionIR, LinearOperand, LinearizedProgram, LinearRvalue, LinearStatement, LoweringClassLayout } from "./Lowering-Frontend-Shared";
import type { OptimizedLoweringFrontendStageCResult } from "./Lowering-Frontend-Optimize-Program";
import {
    ClassTypeValue,
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    PrimitiveTypeValue,
    UnionTypeValue,
    builtinGenericTypeNames,
    type TypeValue
} from "./Typecheck-Core";
import { getMonomorphizedArtifacts } from "./Typecheck-Pipeline";
import { performLoweringStageBFromArtifacts } from "./Lowering-Pass-6-FreeVars";
import type { LoweringSnapshotOptions } from "./Lowering-Pass-0-Snapshot";
import { boxCapturedMutablesPass } from "./Lowering-Pass-7-BoxCapturedMutables";
import { closureConvertPass } from "./Lowering-Pass-8-ClosureConvert";
import { lowerTypedSlotsPass } from "./Lowering-Pass-8a-LowerTypedSlots";
import { foldTypedPrimitivesPass } from "./Lowering-Pass-8b-FoldTypedPrimitives";
import { scalarReplaceFreshPass } from "./Lowering-Pass-8c-ScalarReplaceFresh";
import { linearizePass } from "./Lowering-Pass-9-Linearize";
import { lowerToCfgPass } from "./Lowering-Pass-9c-LowerToCfg";
import { buildSsaPass } from "./Lowering-Pass-9f-BuildSSA";
import { canonicalizeSsaPass, validateSsaProgram } from "./Lowering-Pass-9h-CanonicalizeSSA";
import { selectRepresentationsPass } from "./Lowering-Pass-9b-SelectRepresentations";
import { annotateMayCollectPass } from "./Lowering-Pass-9d-AnnotateMayCollect";
import { trimRootCandidatesPass } from "./Lowering-Pass-9e-TrimRootCandidates";
import { trimCfgRootCandidatesPass } from "./Lowering-Pass-9g-TrimCfgRoots";
import { planGcRootsFromCfgPass } from "./Lowering-Pass-9a-PlanRoots";
import { buildX64MirPass } from "./backend-windows/Backend-Windows-x64-Pass-11x64-BuildMir";
import { selectX64InstructionsPass } from "./backend-windows/Backend-Windows-x64-Pass-12x64-SelectInstr";
import { copyPropagateX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-13x64-CopyPropagate";
import { livenessAnalysisX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-14a-x64-LivenessAnalysis";
import { buildInterferenceGraphX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-14b-x64-BuildInterferenceGraph";
import { graphColorRegallocX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-14c-x64-GraphColorRegalloc";
import { materializeRegallocX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-14d-x64-MaterializeRegalloc";
import { frameLayoutX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-15x64-FrameLayout";
import { postRaPeepholeX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-16x64-PostRAPeephole";
import { emitX64TextualAssemblyPass } from "./backend-windows/Backend-Windows-x64-Pass-16x64-Emit";
import { branchOptimizeX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-17x64-BranchOptimize";
import { layoutX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-18x64-Layout";
import { basicScheduleX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-18a-x64-BasicSchedule";
import { round2BranchOptimizeX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-19x64-Round2-BranchOptimize";
import { round2LayoutX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-20x64-Round2-Layout";
import { round2PeepholeX64Pass } from "./backend-windows/Backend-Windows-x64-Pass-21x64-Round2-Peephole";
import { buildX64MirPass as buildNoOptimizeX64MirPass } from "./backend-windows/Backend-Windows-x64-NoOptimize-Pass-1-BuildMir";
import { selectX64InstructionsPass as selectNoOptimizeX64InstructionsPass } from "./backend-windows/Backend-Windows-x64-NoOptimize-Pass-2-SelectInstr";
import { linearScanRegallocX64Pass as linearScanNoOptimizeX64Pass } from "./backend-windows/Backend-Windows-x64-NoOptimize-Pass-3-LinearScanRegalloc";
import { frameLayoutX64Pass as frameLayoutNoOptimizeX64Pass } from "./backend-windows/Backend-Windows-x64-NoOptimize-Pass-4-FrameLayout";
import { layoutX64Pass as layoutNoOptimizeX64Pass } from "./backend-windows/Backend-Windows-x64-NoOptimize-Pass-5-Layout";
import { emitX64TextualAssemblyPass as emitNoOptimizeX64TextualAssemblyPass } from "./backend-windows/Backend-Windows-x64-NoOptimize-Pass-6-Emit";

interface LoweringStageCOptions extends LoweringSnapshotOptions {}

interface BackendReachabilityState {
    readonly reachableFunctionSymbols: Set<string>;
    readonly reachableExternSymbols: Set<string>;
    readonly reachableClosureIds: Set<string>;
    readonly reachableClassNames: Set<string>;
    readonly reachableUnionTypeTags: Set<string>;
}

function representationFromTypeValue(type: TypeValue): BackendValueRepresentation {
    if (type instanceof PrimitiveTypeValue) {
        if (["i5", "i6", "i7", "u5", "u6", "u7", "bool", "unit"].includes(type.name)) {
            return "immediate";
        }
    }
    return "reference";
}

function collectSymbolFromOperand(operand: LinearOperand, state: BackendReachabilityState): void {
    if (operand.kind === "direct_function") {
        state.reachableFunctionSymbols.add(operand.symbol);
    }
}

function collectReachableTypesFromType(type: TypeValue, state: BackendReachabilityState): void {
    if (type instanceof ClassTypeValue) {
        state.reachableClassNames.add(type.className);
        return;
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        if (!builtinGenericTypeNames.has(type.genericName)) {
            state.reachableClassNames.add(type.genericName);
        }
        type.typeArgs.forEach((typeArg) => collectReachableTypesFromType(typeArg, state));
        return;
    }
    if (type instanceof UnionTypeValue) {
        state.reachableUnionTypeTags.add(type.hash());
        type.types.forEach((member) => collectReachableTypesFromType(member, state));
        return;
    }
    if (type instanceof FunctionTypeValue) {
        type.paramTypes.forEach((paramType) => collectReachableTypesFromType(paramType, state));
        collectReachableTypesFromType(type.returnType, state);
    }
}

function collectSymbolsFromRvalue(rvalue: LinearRvalue, state: BackendReachabilityState): void {
    switch (rvalue.kind) {
        case "copy":
            collectSymbolFromOperand(rvalue.value, state);
            return;
        case "object_alloc":
            state.reachableClassNames.add(rvalue.className);
            return;
        case "object_get_field":
        case "slot_load":
            state.reachableClassNames.add(rvalue.className);
            return;
        case "union_inject":
            state.reachableUnionTypeTags.add(rvalue.unionTypeTagId);
            state.reachableUnionTypeTags.add(rvalue.memberTypeTagId);
            collectSymbolFromOperand(rvalue.value, state);
            return;
        case "union_has_tag":
        case "union_get_payload":
            state.reachableUnionTypeTags.add(rvalue.unionTypeTagId);
            state.reachableUnionTypeTags.add(rvalue.memberTypeTagId);
            return;
        case "closure_create":
            state.reachableFunctionSymbols.add(rvalue.applySymbol);
            state.reachableClosureIds.add(rvalue.closureId);
            state.reachableClassNames.add(rvalue.environmentLayout);
            rvalue.captures.forEach((capture) => collectSymbolFromOperand(capture, state));
            return;
        case "direct_call":
            state.reachableFunctionSymbols.add(rvalue.symbol);
            rvalue.args.forEach((arg) => collectSymbolFromOperand(arg, state));
            return;
        case "closure_call":
            collectSymbolFromOperand(rvalue.callee, state);
            rvalue.args.forEach((arg) => collectSymbolFromOperand(arg, state));
            return;
    }
}

function collectSymbolsFromStatements(statements: readonly LinearStatement[], state: BackendReachabilityState): void {
    for (const statement of statements) {
        switch (statement.kind) {
            case "assign":
                collectSymbolsFromRvalue(statement.value, state);
                break;
            case "set_local":
                collectSymbolFromOperand(statement.value, state);
                break;
            case "object_set_field":
            case "slot_store":
                state.reachableClassNames.add(statement.className);
                collectSymbolFromOperand(statement.receiver, state);
                collectSymbolFromOperand(statement.value, state);
                break;
            case "if":
                collectSymbolFromOperand(statement.cond, state);
                collectSymbolsFromStatements(statement.thenStatements, state);
                collectSymbolsFromStatements(statement.elseStatements, state);
                break;
            case "while":
                collectSymbolsFromStatements(statement.condStatements, state);
                collectSymbolFromOperand(statement.cond, state);
                collectSymbolsFromStatements(statement.bodyStatements, state);
                break;
        }
    }
}

function expandReachableLayoutTypes(program: FinalBackendIRProgram, state: BackendReachabilityState): void {
    const originalLayouts = program.layouts.classes;
    const closureHelpersById = new Map(program.closureHelpers.map((helper) => [helper.closureId, helper] as const));
    const pendingClassNames = [...state.reachableClassNames];
    const visitedClassNames = new Set<string>();

    while (pendingClassNames.length > 0) {
        const className = pendingClassNames.pop();
        if (className === undefined || visitedClassNames.has(className)) {
            continue;
        }
        visitedClassNames.add(className);

        const layout = originalLayouts.get(className);
        if (layout !== undefined) {
            layout.propertyTypes.forEach((type) => collectReachableTypesFromType(type, state));
            layout.methodTypes.forEach((type) => collectReachableTypesFromType(type, state));
            layout.constructors.forEach((constructor) => {
                constructor.paramTypes.forEach((type) => collectReachableTypesFromType(type, state));
            });
        }

        const closureHelper = Array.from(closureHelpersById.values()).find((helper) => helper.environmentLayout === className);
        if (closureHelper !== undefined) {
            closureHelper.captureTypes.forEach((type) => collectReachableTypesFromType(type, state));
        }

        for (const reachableClassName of state.reachableClassNames) {
            if (!visitedClassNames.has(reachableClassName)) {
                pendingClassNames.push(reachableClassName);
            }
        }
    }
}

function pruneReachableLayouts(program: FinalBackendIRProgram, state: BackendReachabilityState): ReadonlyMap<string, LoweringClassLayout> {
    return new Map(
        Array.from(program.layouts.classes.entries()).filter(([className]) => state.reachableClassNames.has(className))
    );
}

function pruneReachableBackendIRPass(program: FinalBackendIRProgram): FinalBackendIRProgram {
    const functionMap = new Map<string, BackendFunctionIR>([
        ...program.functions.map((fn) => [fn.symbol, fn] as const),
        [program.entry.symbol, program.entry] as const
    ]);
    const externSymbols = new Set(program.externFunctions.map((fn) => fn.symbol));
    const processed = new Set<string>();
    const exportedIwFunctionSymbols = program.metadata.exportedIwFunctions.map((entry) => entry.concreteSymbol);
    const state: BackendReachabilityState = {
        reachableFunctionSymbols: new Set<string>([program.entry.symbol, ...exportedIwFunctionSymbols]),
        reachableExternSymbols: new Set<string>(),
        reachableClosureIds: new Set<string>(),
        reachableClassNames: new Set<string>(),
        reachableUnionTypeTags: new Set<string>()
    };
    const worklist: string[] = [program.entry.symbol, ...exportedIwFunctionSymbols];

    while (worklist.length > 0) {
        const symbol = worklist.pop();
        if (symbol === undefined || processed.has(symbol)) {
            continue;
        }
        processed.add(symbol);

        const fn = functionMap.get(symbol);
        if (fn === undefined) {
            if (externSymbols.has(symbol)) {
                state.reachableExternSymbols.add(symbol);
            }
            continue;
        }

        const before = state.reachableFunctionSymbols.size;
        collectSymbolsFromStatements(fn.statements, state);
        collectSymbolFromOperand(fn.result, state);
        if (state.reachableFunctionSymbols.size > before) {
            for (const reachableSymbol of state.reachableFunctionSymbols) {
                if (!processed.has(reachableSymbol)) {
                    worklist.push(reachableSymbol);
                }
            }
        }
        for (const reachableSymbol of state.reachableFunctionSymbols) {
            if (!processed.has(reachableSymbol)) {
                worklist.push(reachableSymbol);
            }
        }
    }

    for (const globalDef of program.globals) {
        collectReachableTypesFromType(globalDef.type, state);
    }
    for (const fn of [program.entry, ...program.functions.filter((candidate) => state.reachableFunctionSymbols.has(candidate.symbol))]) {
        fn.bindingRepresentations.forEach((_representation, _name) => {
            return;
        });
    }
    expandReachableLayoutTypes(program, state);

    const prunedLayouts = pruneReachableLayouts(program, state);
    const prunedMetadata = {
        ...program.metadata,
        concreteClassTypeTagIds: program.metadata.concreteClassTypeTagIds.filter((tagId) => Array.from(prunedLayouts.values()).some((layout) => layout.runtimeTypeTagId === tagId)),
        referencedUnionTypeTagIds: program.metadata.referencedUnionTypeTagIds.filter((tagId) => state.reachableUnionTypeTags.has(tagId)),
        referencedUnionMetadata: program.metadata.referencedUnionMetadata.filter((metadata) => state.reachableUnionTypeTags.has(metadata.unionTypeTagId))
    };

    return {
        ...program,
        functions: program.functions.filter((fn) => state.reachableFunctionSymbols.has(fn.symbol)),
        externFunctions: program.externFunctions.filter((fn) => state.reachableExternSymbols.has(fn.symbol)),
        closureHelpers: program.closureHelpers.filter((helper) => state.reachableClosureIds.has(helper.closureId)),
        layouts: {
            kind: "lowering_layout_table",
            classes: prunedLayouts
        },
        metadata: prunedMetadata
    };
}

function collectImmediateNames(selection: RepresentationSelectionProgram["entry"]): readonly string[] {
    return Array.from(selection.bindingRepresentations.entries())
        .filter(([, representation]) => representation === "immediate")
        .map(([name]) => name);
}

function packageFunction(
    symbol: string,
    params: readonly string[],
    body: LinearizedProgram["functions"][number]["body"],
    origin: LinearizedProgram["functions"][number]["origin"],
    unitId: string | null | undefined,
    gcPlan: GcRootPlan["functions"][number]["body"],
    selection: RepresentationSelectionProgram["functions"][number]["body"]
): BackendFunctionIR {
    return {
        symbol,
        params,
        locals: body.locals,
        bindingRepresentations: selection.bindingRepresentations,
        immediateNames: collectImmediateNames(selection),
        resultRepresentation: selection.resultRepresentation,
        gcRootNames: gcPlan.gcRootNames,
        gcPlan,
        statements: body.statements,
        result: body.result,
        origin,
        unitId: unitId ?? null
    };
}

export function validateFinalBackendIRProgram(program: FinalBackendIRProgram): void {
    const seen = new Set<string>();
    for (const fn of [program.entry, ...program.functions]) {
        if (seen.has(fn.symbol)) {
            throw new Error(`Pass 10 backend packaging validation failed: duplicate function symbol '${fn.symbol}'`);
        }
        seen.add(fn.symbol);
    }
    for (const fn of program.externFunctions) {
        if (seen.has(fn.symbol)) {
            throw new Error(`Pass 10 backend packaging validation failed: duplicate extern function symbol '${fn.symbol}'`);
        }
        seen.add(fn.symbol);
    }
}

export function packageBackendIRPass(program: LinearizedProgram, selection: RepresentationSelectionProgram, rootPlan: GcRootPlan): FinalBackendIRProgram {
    const rootPlansByFunction = new Map(rootPlan.functions.map((fn) => [fn.symbol, fn.body]));
    const selectionByFunction = new Map(selection.functions.map((fn) => [fn.symbol, fn.body]));
    const entry: BackendFunctionIR = {
        symbol: "__iw_backend_entry",
        params: program.metadata.entryParams.map((param) => param.name),
        locals: program.topLevelBody.locals,
        bindingRepresentations: selection.entry.bindingRepresentations,
        immediateNames: collectImmediateNames(selection.entry),
        resultRepresentation: selection.entry.resultRepresentation,
        gcRootNames: rootPlan.entry.gcRootNames,
        gcPlan: rootPlan.entry,
        statements: program.topLevelBody.statements,
        result: program.topLevelBody.result,
        origin: { kind: "top_level" },
        unitId: null
    };
    const backendProgram: FinalBackendIRProgram = {
        kind: "final_backend_ir_program",
        entry,
        globals: program.globals,
        functions: program.functions.map((fn) => packageFunction(
            fn.symbol,
            fn.params.map((param) => param.name),
            fn.body,
            fn.origin,
            fn.unitId,
            rootPlansByFunction.get(fn.symbol) ?? { gcRootNames: [], statementPlans: [], resultGcRoots: [] },
            selectionByFunction.get(fn.symbol) ?? { bindingRepresentations: new Map<string, BackendValueRepresentation>(), resultRepresentation: "reference" }
        )),
        externFunctions: program.declaredFunctions.map<BackendExternFunctionIR>((fn) => ({
            symbol: fn.symbol,
            params: fn.paramNames,
            paramTypes: fn.functionType.paramTypes,
            paramRepresentations: fn.functionType.paramTypes.map((paramType) => representationFromTypeValue(paramType)),
            resultType: fn.functionType.returnType,
            resultRepresentation: representationFromTypeValue(fn.functionType.returnType),
            callingConvention: fn.callingConvention
        })),
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
    validateFinalBackendIRProgram(backendProgram);
    return backendProgram;
}

type PreparedStageCResult = OptimizedLoweringFrontendStageCResult & {
    readonly pass10Support: FinalBackendIRProgram;
};

export type PreparedLoweringStageCResult = PreparedStageCResult;

type X64PassBundle = OptimizedX64PassBundle;

export interface NoOptimizeBackendLoweringStageCResult extends PreparedLoweringStageCResult, NoOptimizeX64PassBundle {}

function performOptimizedFrontendLoweringStageCFromArtifacts(programAst: import("./AstNode").AstNode, options?: LoweringStageCOptions): PreparedStageCResult {
    const artifacts = getMonomorphizedArtifacts();
    const stageB = performLoweringStageBFromArtifacts(programAst, artifacts, options);
    const pass7 = boxCapturedMutablesPass(stageB.pass6b, stageB.pass6c);
    const pass8 = closureConvertPass(pass7);
    const pass8a = lowerTypedSlotsPass(pass8);
    const pass8b = foldTypedPrimitivesPass(pass8a);
    const pass8c = scalarReplaceFreshPass(pass8b);
    const pass9 = linearizePass(pass8c);
    const pass9c = lowerToCfgPass(pass9);
    const pass9f = buildSsaPass(pass9c);
    validateSsaProgram(pass9f);
    const pass9h = canonicalizeSsaPass(pass9f);
    validateSsaProgram(pass9h);
    const pass9b = selectRepresentationsPass(pass9c);
    const pass9d = annotateMayCollectPass(pass9);
    const pass9e = trimRootCandidatesPass(pass9, pass9b, pass9d);
    const pass9g = trimCfgRootCandidatesPass(pass9c, pass9b, pass9d);
    const pass9a = planGcRootsFromCfgPass(pass9, pass9g);
    const pass10Support = packageBackendIRPass(pass9, pass9b, pass9a);
    const pass10 = pruneReachableBackendIRPass(pass10Support);
    return {
        ...stageB,
        pass7,
        pass8,
        pass8a,
        pass8b,
        pass8c,
        pass9,
        pass9c,
        pass9f,
        pass9h,
        pass9b,
        pass9d,
        pass9e,
        pass9g,
        pass9a,
        pass10Support,
        pass10
    };
}

function performOptimizedX64BackendLoweringStageC(prepared: PreparedStageCResult): X64PassBundle {
    const pass11x64mir = buildX64MirPass(prepared.pass9h, prepared.pass9b, prepared.pass9g);
    const pass12x64selected = selectX64InstructionsPass(pass11x64mir);
    const pass13x64copyprop = copyPropagateX64Pass(pass12x64selected);
    const pass14ax64liveness = livenessAnalysisX64Pass(pass13x64copyprop);
    const pass14bx64interference = buildInterferenceGraphX64Pass(pass14ax64liveness);
    const pass14cx64allocation = graphColorRegallocX64Pass(pass14bx64interference);
    const pass14x64regalloc = materializeRegallocX64Pass(pass14cx64allocation);
    const pass15x64framelayout = frameLayoutX64Pass(pass14x64regalloc);
    const pass16x64postra = postRaPeepholeX64Pass(pass15x64framelayout);
    const pass17x64branchopt = branchOptimizeX64Pass(pass16x64postra);
    const pass18x64layout = layoutX64Pass(pass17x64branchopt);
    const pass19x64round2branchopt = round2BranchOptimizeX64Pass(pass18x64layout);
    const pass20x64round2layout = round2LayoutX64Pass(pass19x64round2branchopt);
    const scheduledX64Round2 = basicScheduleX64Pass(pass20x64round2layout);
    const pass21x64round2peephole = round2PeepholeX64Pass(scheduledX64Round2);
    const pass22x64emit = emitX64TextualAssemblyPass(pass21x64round2peephole);
    return {
        pass11x64mir,
        pass12x64selected,
        pass13x64copyprop,
        pass14ax64liveness,
        pass14bx64interference,
        pass14cx64allocation,
        pass14x64regalloc,
        pass15x64framelayout,
        pass16x64postra,
        pass17x64branchopt,
        pass18x64layout,
        pass19x64round2branchopt,
        pass20x64round2layout,
        pass21x64round2peephole,
        pass22x64emit
    };
}

function performNoOptimizedX64BackendLoweringStageC(prepared: PreparedStageCResult): NoOptimizeBackendLoweringStageCResult {
    const pass11x64mir = buildNoOptimizeX64MirPass(prepared.pass9h, prepared.pass9b, prepared.pass9g);
    const pass12x64selected = selectNoOptimizeX64InstructionsPass(pass11x64mir);
    const pass14x64regalloc = linearScanNoOptimizeX64Pass(pass12x64selected);
    const pass15x64framelayout = frameLayoutNoOptimizeX64Pass(pass14x64regalloc);
    const pass18x64layout = layoutNoOptimizeX64Pass(pass15x64framelayout);
    const pass22x64emit = emitNoOptimizeX64TextualAssemblyPass(pass18x64layout);
    return {
        ...prepared,
        pass11x64mir,
        pass12x64selected,
        pass14x64regalloc,
        pass15x64framelayout,
        pass18x64layout,
        pass22x64emit
    };
}

function mergePreparedAndX64Lowering(prepared: PreparedStageCResult, x64: X64PassBundle): PreparedStageCResult & X64PassBundle {
    return {
        ...prepared,
        ...x64
    };
}

export function performOptimizedCBackendLoweringStageCFromArtifacts(programAst: import("./AstNode").AstNode, options?: LoweringStageCOptions): PreparedLoweringStageCResult {
    return performOptimizedFrontendLoweringStageCFromArtifacts(programAst, options);
}

export function performLoweringStageCFromArtifacts(programAst: import("./AstNode").AstNode, options?: LoweringStageCOptions): PreparedStageCResult & X64PassBundle {
    const prepared = performOptimizedFrontendLoweringStageCFromArtifacts(programAst, options);
    return mergePreparedAndX64Lowering(prepared, performOptimizedX64BackendLoweringStageC(prepared));
}

export function performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts(programAst: import("./AstNode").AstNode, options?: LoweringStageCOptions): NoOptimizeBackendLoweringStageCResult {
    const prepared = performOptimizedFrontendLoweringStageCFromArtifacts(programAst, options);
    return performNoOptimizedX64BackendLoweringStageC(prepared);
}
