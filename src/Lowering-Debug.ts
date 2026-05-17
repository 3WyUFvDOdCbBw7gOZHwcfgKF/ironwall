import { AstNode } from "./AstNode";
import { astToString } from "./parser";
import type {
    AnfProgram,
    FactsAnalysisResult,
    CapturedMutableCheckedProgram,
    ClosureConvertedProgram,
    DesugaredCoreProgram,
    EscapeAnalysisResult,
    FoldedTypedPrimitiveProgram,
    KnownCallProgram,
    FreeVarAnalysisResult,
    LiftedLoweringProgram,
    LinearizedProgram,
    LoweredClassDefinition,
    LoweredExpr,
    LoweredFunctionDefinition,
    LoweredMethodDefinition,
    LoweringClassLayout,
    LoweringLayoutTable,
    LoweringSnapshotProgram,
    PropagatedFactsProgram,
    ScalarReplacedFreshProgram,
    ShrunkClosureProgram,
    SsaProgram,
    TinyInlinedProgram,
    SimplifiedAnfProgram
} from "./Lowering-Frontend-Shared";
import type * as FrontendTypes from "./Lowering-Frontend-Shared";
import type {
    BackendValueRepresentation,
    FinalBackendIRProgram,
    RepresentationSelectionProgram,
    X64MirProgram,
    X64CopyPropagatedProgram,
    X64BranchOptimizedProgram,
    X64FrameLayoutProgram,
    X64LaidOutProgram,
    X64PostRAPeepholeProgram,
    X64TextualAssemblyProgram,
    X64SelectedProgram,
    X64RegAllocatedProgram
} from "./backend-linux/Backend-Linux-IR-Shared";
import type * as BackendTypes from "./backend-linux/Backend-Linux-IR-Shared";

function indent(text: string, prefix = "  "): string {
    return text
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n");
}

export function formatLoweringSnapshot(program: LoweringSnapshotProgram): string {
    const classLines = program.concreteClasses.map((classDef) => `${classDef.concreteName} tag=${classDef.runtimeTypeTagId}`);
    const functionLines = program.concreteFunctions.map((fn) => fn.concreteName);
    const globalLines = program.globals.map((globalDef) => globalDef.symbol);
    const statementLines = program.topLevelStatements.map((statement) => astToString(statement));
    return [
        "snapshot_program",
        `metadata sourceTopLevelNodeCount=${program.metadata.sourceTopLevelNodeCount} executableStatementCount=${program.metadata.executableStatementCount} concreteClassCount=${program.metadata.concreteClassCount} concreteFunctionCount=${program.metadata.concreteFunctionCount} classTagCount=${program.metadata.concreteClassTypeTagIds.length} unionTagCount=${program.metadata.referencedUnionTypeTagIds.length}`,
        "classes",
        indent(classLines.length > 0 ? classLines.join("\n") : "<none>"),
        "globals",
        indent(globalLines.length > 0 ? globalLines.join("\n") : "<none>"),
        "referenced_union_tags",
        indent(program.metadata.referencedUnionTypeTagIds.length > 0 ? program.metadata.referencedUnionTypeTagIds.join("\n") : "<none>"),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>"),
        "top_level_statements",
        indent(statementLines.length > 0 ? statementLines.join("\n") : "<none>")
    ].join("\n");
}

export function formatLoweringLayout(layout: LoweringClassLayout): string {
    const methods = layout.methodOrder.map((methodName) => `${methodName} -> ${layout.methodSymbols.get(methodName) ?? "<missing>"}`);
    const constructors = layout.constructors.map((constructor) => `${constructor.symbol}[arity=${constructor.paramTypes.length}]`);
    return [
        `class ${layout.className} tag=${layout.runtimeTypeTagId}`,
        indent(`fields: ${layout.propertyOrder.join(", ") || "<none>"}`),
        indent(`constructors: ${constructors.join(", ") || "<none>"}`),
        indent(`methods: ${methods.join(", ") || "<none>"}`)
    ].join("\n");
}

export function formatLoweringLayoutTable(layoutTable: LoweringLayoutTable): string {
    const blocks = Array.from(layoutTable.classes.values())
        .sort((left, right) => left.className.localeCompare(right.className))
        .map((layout) => formatLoweringLayout(layout));
    return ["layout_table", indent(blocks.length > 0 ? blocks.join("\n") : "<none>")].join("\n");
}

function formatBinding(name: string, typeExp: AstNode): string {
    return `[${name} ${astToString(typeExp)}]`;
}

export function formatLoweredExpr(expr: LoweredExpr): string {
    switch (expr.kind) {
        case "identifier":
            return expr.name;
        case "number_literal":
            return `${expr.value}`;
        case "text_literal":
            return expr.referenceName;
        case "fn":
            return `(fn (${expr.params.map((param) => formatBinding(param.name, param.typeExp)).join(" ")}) to ${astToString(expr.returnType)} in ${formatLoweredExpr(expr.body)})`;
        case "let":
            return `(let (${expr.bindings.map((binding) => `(${formatBinding(binding.bind.name, binding.bind.typeExp)} ${formatLoweredExpr(binding.value)})`).join(" ")}) in ${formatLoweredExpr(expr.body)})`;
        case "if":
            return `(if ${formatLoweredExpr(expr.condExpr)} then ${formatLoweredExpr(expr.trueBranchExpr)} else ${formatLoweredExpr(expr.falseBranchExpr)})`;
        case "while":
            return `(while ${formatLoweredExpr(expr.condExpr)} in ${formatLoweredExpr(expr.bodyExpr)})`;
        case "cond":
            return `(cond ${expr.clauses.map((clause) => `(${formatLoweredExpr(clause.cond)} ${formatLoweredExpr(clause.body)})`).join(" ")})`;
        case "dvar":
            return `(dvar ${formatBinding(expr.bind.name, expr.bind.typeExp)} ${formatLoweredExpr(expr.value)})`;
        case "seq":
            return `(seq ${expr.expressions.map((inner) => formatLoweredExpr(inner)).join(" ")})`;
        case "set_local":
            return `(set ${expr.identifier} ${formatLoweredExpr(expr.value)})`;
        case "call":
            return `(${formatLoweredExpr(expr.callee)} ${expr.args.map((arg) => formatLoweredExpr(arg)).join(" ")})`;
        case "direct_call":
            return `(direct_call ${expr.symbol}${expr.args.length > 0 ? ` ${expr.args.map((arg) => formatLoweredExpr(arg)).join(" ")}` : ""})`;
        case "direct_function_ref":
            return `(direct_function_ref ${expr.symbol})`;
        case "object_alloc":
            return `(object_alloc ${expr.className})`;
        case "object_get_field":
            return `(object_get_field ${formatLoweredExpr(expr.receiver)} ${expr.className} ${expr.fieldName})`;
        case "object_set_field":
            return `(object_set_field ${formatLoweredExpr(expr.receiver)} ${expr.className} ${expr.fieldName} ${formatLoweredExpr(expr.value)})`;
        case "method_closure_create":
            return `(method_closure_create ${formatLoweredExpr(expr.receiver)} ${expr.className} ${expr.methodName} ${expr.methodSymbol})`;
        case "union_inject":
            return `(union_inject ${expr.unionTypeTagId} ${expr.memberTypeTagId} ${formatLoweredExpr(expr.value)})`;
        case "match":
            return `(match ${expr.unionTypeTagId} ${formatLoweredExpr(expr.unionExpr)} ${expr.branches.map((branch) => `(${branch.memberTypeTagId} ${formatBinding(branch.bind.name, branch.bind.typeExp)} ${formatLoweredExpr(branch.body)})`).join(" ")})`;
    }
}

function formatLoweredMethod(method: LoweredMethodDefinition): string {
    return `(method ${method.methodName} -> ${method.symbol} (${method.params.map((param) => formatBinding(param.name, param.typeExp)).join(" ")}) to ${astToString(method.returnType)} in ${formatLoweredExpr(method.body)})`;
}

function formatLoweredClass(classDef: LoweredClassDefinition): string {
    return [
        `class ${classDef.className}`,
        indent(`properties: ${classDef.propertyOrder.map((property) => property.bind.name).join(", ") || "<none>"}`),
        indent(`constructors: ${classDef.constructorDefs.map((constructorDef) => constructorDef.symbol).join(", ") || "<none>"}`),
        indent(classDef.methods.length > 0 ? classDef.methods.map((method) => formatLoweredMethod(method)).join("\n") : "methods: <none>")
    ].join("\n");
}

function formatLoweredFunction(fn: LoweredFunctionDefinition): string {
    const originParts: string[] = [fn.origin.kind];
    if (fn.origin.className) {
        originParts.push(fn.origin.className);
    }
    if (fn.origin.methodName) {
        originParts.push(fn.origin.methodName);
    }
    return `(dfun ${fn.symbol} ; origin=${originParts.join(":")} (${fn.params.map((param) => formatBinding(param.name, param.typeExp)).join(" ")}) to ${astToString(fn.returnType)} in ${formatLoweredExpr(fn.body)})`;
}

export function formatLoweredClassPrimitiveProgram(classes: readonly LoweredClassDefinition[], functions: readonly LoweredFunctionDefinition[], topLevelStatements: readonly LoweredExpr[]): string {
    return [
        "lowered_class_primitive_program",
        "classes",
        indent(classes.length > 0 ? classes.map((classDef) => formatLoweredClass(classDef)).join("\n") : "<none>"),
        "functions",
        indent(functions.length > 0 ? functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(topLevelStatements.length > 0 ? topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatLiftedLoweringProgram(program: LiftedLoweringProgram): string {
    return [
        "lifted_lowering_program",
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatDesugaredCoreProgram(program: DesugaredCoreProgram): string {
    return [
        "desugared_core_program",
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatAnfProgram(program: AnfProgram): string {
    return [
        "anf_program",
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatSimplifiedAnfProgram(program: SimplifiedAnfProgram): string {
    return [
        "simplified_anf_program",
        `stats foldedConstantIfs=${program.stats.foldedConstantIfs} removedDeadLets=${program.stats.removedDeadLets} collapsedIdentityLets=${program.stats.collapsedIdentityLets} flattenedSeqs=${program.stats.flattenedSeqs} removedRedundantIfs=${program.stats.removedRedundantIfs}`,
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

function formatValueFact(fact: FrontendTypes.ValueFact): string {
    switch (fact.kind) {
        case "unknown":
            return "unknown";
        case "boolean_literal":
            return `bool(${fact.value})`;
        case "number_literal":
            return `number(${fact.typeName}:${fact.value})`;
        case "text_literal":
            return `text(${fact.typeName}:${fact.referenceName})`;
        case "direct_function_ref":
            return `direct_function(${fact.symbol})`;
    }
}

export function formatFactsAnalysis(result: FactsAnalysisResult): string {
    const lines = result.bindings
        .map((binding) => `${binding.bindingId} ${binding.name} declaredIn=${binding.declaredIn} useCount=${binding.useCount} assigned=${binding.isAssigned} captured=${binding.isCaptured} escapes=${binding.escapes} pure=${binding.isPure} fact=${formatValueFact(binding.fact)}`)
        .sort((left, right) => left.localeCompare(right));
    return [
        "facts_analysis",
        "bindings",
        indent(lines.length > 0 ? lines.join("\n") : "<none>")
    ].join("\n");
}

export function formatPropagatedFactsProgram(program: PropagatedFactsProgram): string {
    return [
        "propagated_facts_program",
        `stats inlinedSingleUseBindings=${program.stats.inlinedSingleUseBindings} propagatedConstants=${program.stats.propagatedConstants} propagatedBooleans=${program.stats.propagatedBooleans} propagatedDirectFunctions=${program.stats.propagatedDirectFunctions} foldedConstantIfs=${program.stats.foldedConstantIfs} collapsedEquivalentIfs=${program.stats.collapsedEquivalentIfs} removedDeadLets=${program.stats.removedDeadLets}`,
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatKnownCallProgram(program: KnownCallProgram): string {
    return [
        "known_call_program",
        `stats convertedCalls=${program.stats.convertedCalls} convertedAliases=${program.stats.convertedAliases}`,
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatTinyInlinedProgram(program: TinyInlinedProgram): string {
    return [
        "tiny_inlined_program",
        `stats inlinedCalls=${program.stats.inlinedCalls} skippedRecursiveCalls=${program.stats.skippedRecursiveCalls}`,
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatFreeVarAnalysis(result: FreeVarAnalysisResult): string {
    const lambdaLines = Array.from(result.lambdaSites.values())
        .sort((left, right) => left.siteId.localeCompare(right.siteId))
        .map((site) => `${site.siteId}: bound=[${site.boundVariables.join(", ")}] free=[${site.freeVariables.join(", ")}] mutable=${site.capturesMutableLocal}`);
    const boundMethodLines = Array.from(result.boundMethodSites.values())
        .sort((left, right) => left.siteId.localeCompare(right.siteId))
        .map((site) => `${site.siteId}: ${site.className}.${site.methodName} -> [${site.capturedVariables.join(", ")}]`);
    return [
        "free_var_analysis",
        "lambda_sites",
        indent(lambdaLines.length > 0 ? lambdaLines.join("\n") : "<none>"),
        "bound_method_sites",
        indent(boundMethodLines.length > 0 ? boundMethodLines.join("\n") : "<none>")
    ].join("\n");
}

export function formatEscapeAnalysis(result: EscapeAnalysisResult): string {
    const siteLines = result.sites
        .map((site) => `${site.sourceId} owner=${site.ownerId} binding=${site.bindingName ?? "<none>"} kind=${site.sourceKind} classification=${site.classification} localCalls=${site.localCallUses} returned=${site.returned} stored=${site.stored} argumentEscapes=${site.argumentEscapes} capturesMutable=${site.capturesMutableLocal}${site.lambdaSiteId ? ` lambdaSite=${site.lambdaSiteId}` : ""}${site.boundMethodSiteId ? ` boundMethodSite=${site.boundMethodSiteId}` : ""}`)
        .sort((left, right) => left.localeCompare(right));
    return [
        "escape_analysis",
        "sites",
        indent(siteLines.length > 0 ? siteLines.join("\n") : "<none>")
    ].join("\n");
}

export function formatShrunkClosureProgram(program: ShrunkClosureProgram): string {
    return [
        "shrunk_closure_program",
        `stats loweredNonCapturedLambdas=${program.stats.loweredNonCapturedLambdas} rewrittenDirectCalls=${program.stats.rewrittenDirectCalls} rewrittenImmediateCalls=${program.stats.rewrittenImmediateCalls} rewrittenBoundMethodCalls=${program.stats.rewrittenBoundMethodCalls}`,
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatLoweredFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatLoweredExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

function formatClosureExpr(expr: FrontendTypes.ClosureExpr): string {
    switch (expr.kind) {
        case "identifier":
            return expr.name;
        case "number_literal":
            return `${expr.value}`;
        case "text_literal":
            return expr.referenceName;
        case "let":
            return `(let (${expr.bindings.map((binding) => `(${formatBinding(binding.bind.name, binding.bind.typeExp)} ${formatClosureExpr(binding.value)})`).join(" ")}) in ${formatClosureExpr(expr.body)})`;
        case "if":
            return `(if ${formatClosureExpr(expr.condExpr)} then ${formatClosureExpr(expr.trueBranchExpr)} else ${formatClosureExpr(expr.falseBranchExpr)})`;
        case "while":
            return `(while ${formatClosureExpr(expr.condExpr)} in ${formatClosureExpr(expr.bodyExpr)})`;
        case "seq":
            return `(seq ${expr.expressions.map((inner) => formatClosureExpr(inner)).join(" ")})`;
        case "set_local":
            return `(set ${expr.identifier} ${formatClosureExpr(expr.value)})`;
        case "direct_call":
            return `(direct_call ${expr.symbol}${expr.args.length > 0 ? ` ${expr.args.map((arg) => formatClosureExpr(arg)).join(" ")}` : ""})`;
        case "direct_function_ref":
            return `(direct_function_ref ${expr.symbol})`;
        case "object_alloc":
            return `(object_alloc ${expr.className})`;
        case "object_get_field":
            return `(object_get_field ${formatClosureExpr(expr.receiver)} ${expr.className} ${expr.fieldName})`;
        case "object_set_field":
            return `(object_set_field ${formatClosureExpr(expr.receiver)} ${expr.className} ${expr.fieldName} ${formatClosureExpr(expr.value)})`;
        case "slot_load":
            return `(slot_load ${formatClosureExpr(expr.receiver)} ${expr.className} ${expr.slotName})`;
        case "slot_store":
            return `(slot_store ${formatClosureExpr(expr.receiver)} ${expr.className} ${expr.slotName} ${formatClosureExpr(expr.value)})`;
        case "union_inject":
            return `(union_inject ${expr.unionTypeTagId} ${expr.memberTypeTagId} ${formatClosureExpr(expr.value)})`;
        case "closure_create":
            return `(closure_create ${expr.closureId} ${expr.applySymbol} ${expr.environmentLayout}${expr.captures.length > 0 ? ` ${expr.captures.map((capture) => formatClosureExpr(capture)).join(" ")}` : ""})`;
        case "closure_call":
            return `(closure_call ${formatClosureExpr(expr.callee)}${expr.args.length > 0 ? ` ${expr.args.map((arg) => formatClosureExpr(arg)).join(" ")}` : ""})`;
        case "match":
            return `(match ${expr.unionTypeTagId} ${formatClosureExpr(expr.unionExpr)} ${expr.branches.map((branch) => `(${branch.memberTypeTagId} ${formatBinding(branch.bind.name, branch.bind.typeExp)} ${formatClosureExpr(branch.body)})`).join(" ")})`;
    }
}

function formatClosureFunction(fn: FrontendTypes.ClosureConvertedFunctionDefinition): string {
    const originParts: string[] = [fn.origin.kind];
    if (fn.origin.className) {
        originParts.push(fn.origin.className);
    }
    if (fn.origin.methodName) {
        originParts.push(fn.origin.methodName);
    }
    if (fn.origin.closureId) {
        originParts.push(fn.origin.closureId);
    }
    return `(dfun ${fn.symbol} ; origin=${originParts.join(":")} (${fn.params.map((param) => formatBinding(param.name, param.typeExp)).join(" ")}) to ${astToString(fn.returnType)} in ${formatClosureExpr(fn.body)})`;
}

export function formatCapturedMutableCheck(program: CapturedMutableCheckedProgram): string {
    return [
        "captured_mutable_checked_program",
        "diagnostics",
        indent(program.diagnostics.length > 0 ? program.diagnostics.map((diagnostic) => `${diagnostic.siteId}: ${diagnostic.message}`).join("\n") : "<none>")
    ].join("\n");
}

export function formatClosureConvertedProgram(program: ClosureConvertedProgram): string {
    const helperLines = program.closureHelpers.map((helper) => `${helper.closureId}: ${helper.applySymbol} env=${helper.environmentLayout} captures=[${helper.captureOrder.join(", ")}] kind=${helper.sourceKind}`);
    return [
        "closure_converted_program",
        "helpers",
        indent(helperLines.length > 0 ? helperLines.join("\n") : "<none>"),
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatClosureFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatClosureExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatTypedSlotProgram(program: FrontendTypes.TypedSlotProgram): string {
    const helperLines = program.closureHelpers.map((helper) => `${helper.closureId}: ${helper.applySymbol} env=${helper.environmentLayout} captures=[${helper.captureOrder.join(", ")}] kind=${helper.sourceKind}`);
    return [
        "typed_slot_program",
        "helpers",
        indent(helperLines.length > 0 ? helperLines.join("\n") : "<none>"),
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatClosureFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatClosureExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatFoldedTypedPrimitiveProgram(program: FoldedTypedPrimitiveProgram): string {
    const helperLines = program.closureHelpers.map((helper) => `${helper.closureId}: ${helper.applySymbol} env=${helper.environmentLayout} captures=[${helper.captureOrder.join(", ")}] kind=${helper.sourceKind}`);
    return [
        "folded_typed_primitive_program",
        `stats forwardedSlotLoads=${program.stats.forwardedSlotLoads} foldedInjectedMatches=${program.stats.foldedInjectedMatches}`,
        "helpers",
        indent(helperLines.length > 0 ? helperLines.join("\n") : "<none>"),
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatClosureFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatClosureExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

export function formatScalarReplacedFreshProgram(program: ScalarReplacedFreshProgram): string {
    const helperLines = program.closureHelpers.map((helper) => `${helper.closureId}: ${helper.applySymbol} env=${helper.environmentLayout} captures=[${helper.captureOrder.join(", ")}] kind=${helper.sourceKind}`);
    return [
        "scalar_replaced_fresh_program",
        `stats scalarizedObjects=${program.stats.scalarizedObjects} replacedSlotStores=${program.stats.replacedSlotStores} replacedSlotLoads=${program.stats.replacedSlotLoads} scalarizedClosures=${program.stats.scalarizedClosures} rewrittenClosureCalls=${program.stats.rewrittenClosureCalls}`,
        "helpers",
        indent(helperLines.length > 0 ? helperLines.join("\n") : "<none>"),
        "functions",
        indent(program.functions.length > 0 ? program.functions.map((fn) => formatClosureFunction(fn)).join("\n") : "<none>"),
        "top_level_statements",
        indent(program.topLevelStatements.length > 0 ? program.topLevelStatements.map((statement) => formatClosureExpr(statement)).join("\n") : "<none>")
    ].join("\n");
}

function formatLinearOperand(operand: FrontendTypes.LinearOperand): string {
    switch (operand.kind) {
        case "local":
            return operand.name;
        case "number_literal":
            return `${operand.value}`;
        case "text_literal":
            return operand.referenceName;
        case "direct_function":
            return operand.symbol;
    }
}

function formatLinearRvalue(rvalue: FrontendTypes.LinearRvalue): string {
    switch (rvalue.kind) {
        case "copy":
            return formatLinearOperand(rvalue.value);
        case "object_alloc":
            return `(object_alloc ${rvalue.className})`;
        case "object_get_field":
            return `(object_get_field ${formatLinearOperand(rvalue.receiver)} ${rvalue.className} ${rvalue.fieldName})`;
        case "slot_load":
            return `(slot_load ${formatLinearOperand(rvalue.receiver)} ${rvalue.className} ${rvalue.slotName})`;
        case "union_inject":
            return `(union_inject ${rvalue.unionTypeTagId} ${rvalue.memberTypeTagId} ${formatLinearOperand(rvalue.value)})`;
        case "union_has_tag":
            return `(union_has_tag ${rvalue.unionTypeTagId} ${rvalue.memberTypeTagId} ${formatLinearOperand(rvalue.unionValue)})`;
        case "union_get_payload":
            return `(union_get_payload ${rvalue.unionTypeTagId} ${rvalue.memberTypeTagId} ${formatLinearOperand(rvalue.unionValue)})`;
        case "closure_create":
            return `(closure_create ${rvalue.closureId} ${rvalue.applySymbol} ${rvalue.environmentLayout}${rvalue.captures.length > 0 ? ` ${rvalue.captures.map((capture) => formatLinearOperand(capture)).join(" ")}` : ""})`;
        case "direct_call":
            return `(direct_call ${rvalue.symbol}${rvalue.args.length > 0 ? ` ${rvalue.args.map((arg) => formatLinearOperand(arg)).join(" ")}` : ""})`;
        case "closure_call":
            return `(closure_call ${formatLinearOperand(rvalue.callee)}${rvalue.args.length > 0 ? ` ${rvalue.args.map((arg) => formatLinearOperand(arg)).join(" ")}` : ""})`;
    }
}

function formatLinearStatement(statement: FrontendTypes.LinearStatement): string {
    switch (statement.kind) {
        case "assign":
            return `${statement.target} = ${formatLinearRvalue(statement.value)}`;
        case "set_local":
            return `(set ${statement.target} ${formatLinearOperand(statement.value)})`;
        case "object_set_field":
            return `(object_set_field ${formatLinearOperand(statement.receiver)} ${statement.className} ${statement.fieldName} ${formatLinearOperand(statement.value)})`;
        case "slot_store":
            return `(slot_store ${formatLinearOperand(statement.receiver)} ${statement.className} ${statement.slotName} ${formatLinearOperand(statement.value)})`;
        case "if":
            return `(if ${formatLinearOperand(statement.cond)} then [${statement.thenStatements.map((inner) => formatLinearStatement(inner)).join("; ")}] else [${statement.elseStatements.map((inner) => formatLinearStatement(inner)).join("; ")}])`;
        case "while":
            return `(while [${statement.condStatements.map((inner) => formatLinearStatement(inner)).join("; ")}] ${formatLinearOperand(statement.cond)} do [${statement.bodyStatements.map((inner) => formatLinearStatement(inner)).join("; ")}])`;
    }
}

export function formatLinearizedProgram(program: LinearizedProgram): string {
    const functionLines = program.functions.map((fn) => `${fn.symbol} locals=[${fn.body.locals.join(", ")}] ${fn.body.statements.map((statement) => formatLinearStatement(statement)).join("; ")} => ${formatLinearOperand(fn.body.result)}`);
    const globalLines = program.globals.map((globalDef) => globalDef.symbol);
    return [
        "linearized_program",
        "globals",
        indent(globalLines.length > 0 ? globalLines.join("\n") : "<none>"),
        "entry",
        indent(`${program.topLevelBody.statements.map((statement) => formatLinearStatement(statement)).join("; ")} => ${formatLinearOperand(program.topLevelBody.result)}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

function formatCfgTerminator(terminator: FrontendTypes.CfgTerminator): string {
    switch (terminator.kind) {
        case "return":
            return `(return ${formatLinearOperand(terminator.value)})`;
        case "jump":
            return `(jump ${terminator.target})`;
        case "branch":
            return `(branch ${formatLinearOperand(terminator.cond)} ${terminator.trueTarget} ${terminator.falseTarget})`;
    }
}

function formatCfgBody(body: FrontendTypes.CfgBody): string {
    return body.blocks
        .map((block) => `${block.label}: ${block.statements.map((statement) => formatLinearStatement(statement)).join("; ")}${block.statements.length > 0 ? "; " : ""}${formatCfgTerminator(block.terminator)}`)
        .join("\n");
}

export function formatCfgProgram(program: FrontendTypes.CfgProgram): string {
    const functionLines = program.functions.map((fn) => `${fn.symbol} entry=${fn.body.entryLabel} locals=[${fn.body.locals.join(", ")}]
${indent(formatCfgBody(fn.body))}`);
    const globalLines = program.globals.map((globalDef) => globalDef.symbol);
    return [
        "cfg_program",
        "globals",
        indent(globalLines.length > 0 ? globalLines.join("\n") : "<none>"),
        "entry",
        indent(`entry=${program.entry.entryLabel}\n${indent(formatCfgBody(program.entry), "")}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

function formatSsaPhi(phi: FrontendTypes.SsaPhiNode): string {
    return `(phi ${phi.target} ; ${phi.variable} <- ${phi.sources.map((source) => `${source.predecessor}:${formatLinearOperand(source.value)}`).join(", ")})`;
}

function formatSsaBody(body: FrontendTypes.SsaBody): string {
    return body.blocks
        .map((block) => `${block.label} preds=[${block.predecessors.join(", ")}] idom=${block.immediateDominator ?? "<entry>"} df=[${block.dominanceFrontier.join(", ")}]: ${[
            ...block.phiNodes.map((phi) => formatSsaPhi(phi)),
            ...block.statements.map((statement) => formatLinearStatement(statement)),
            formatCfgTerminator(block.terminator)
        ].join("; ")}`)
        .join("\n");
}

export function formatSsaProgram(program: SsaProgram): string {
    const functionLines = program.functions.map((fn) => `${fn.symbol} entry=${fn.body.entryLabel} bindings=[${fn.body.entryBindings.map((binding) => `${binding.variable}:${binding.value}`).join(", ")}]
${indent(formatSsaBody(fn.body))}`);
    const globalLines = program.globals.map((globalDef) => globalDef.symbol);
    return [
        "ssa_program",
        "globals",
        indent(globalLines.length > 0 ? globalLines.join("\n") : "<none>"),
        "entry",
        indent(`entry=${program.entry.entryLabel} bindings=[${program.entry.entryBindings.map((binding) => `${binding.variable}:${binding.value}`).join(", ")}]\n${indent(formatSsaBody(program.entry), "")}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

function formatX64MirOperand(operand: BackendTypes.X64MirOperand): string {
    switch (operand.kind) {
        case "vreg":
            return `${operand.name}:${operand.bank}`;
        case "imm_i64":
            return `${operand.value}`;
        case "symbol":
            return `@${operand.symbol}`;
        case "text":
            return `${operand.referenceName}<${operand.typeName}>`;
    }
}

function formatX64MirInstruction(instruction: BackendTypes.X64MirInstruction): string {
    const roots = instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : "";
    switch (instruction.kind) {
        case "move":
            return `move ${formatX64MirOperand(instruction.target)} <- ${formatX64MirOperand(instruction.source)}${roots}`;
        case "call_direct":
            return `${instruction.target ? `${formatX64MirOperand(instruction.target)} <- ` : ""}call_direct ${instruction.symbol}(${instruction.args.map((arg) => formatX64MirOperand(arg)).join(", ")})${roots}`;
        case "call_closure":
            return `${instruction.target ? `${formatX64MirOperand(instruction.target)} <- ` : ""}call_closure ${formatX64MirOperand(instruction.callee)}(${instruction.args.map((arg) => formatX64MirOperand(arg)).join(", ")})${roots}`;
        case "object_alloc":
            return `${formatX64MirOperand(instruction.target)} <- object_alloc ${instruction.className}${roots}`;
        case "object_get_field":
            return `${formatX64MirOperand(instruction.target)} <- object_get_field ${formatX64MirOperand(instruction.receiver)}.${instruction.className}.${instruction.fieldName}${roots}`;
        case "object_set_field":
            return `object_set_field ${formatX64MirOperand(instruction.receiver)}.${instruction.className}.${instruction.fieldName} <- ${formatX64MirOperand(instruction.value)}${roots}`;
        case "slot_load":
            return `${formatX64MirOperand(instruction.target)} <- slot_load ${formatX64MirOperand(instruction.receiver)}.${instruction.className}.${instruction.slotName}${roots}`;
        case "slot_store":
            return `slot_store ${formatX64MirOperand(instruction.receiver)}.${instruction.className}.${instruction.slotName} <- ${formatX64MirOperand(instruction.value)}${roots}`;
        case "union_inject":
            return `${formatX64MirOperand(instruction.target)} <- union_inject ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64MirOperand(instruction.value)}${roots}`;
        case "union_has_tag":
            return `${formatX64MirOperand(instruction.target)} <- union_has_tag ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64MirOperand(instruction.unionValue)}${roots}`;
        case "union_get_payload":
            return `${formatX64MirOperand(instruction.target)} <- union_get_payload ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64MirOperand(instruction.unionValue)}${roots}`;
        case "closure_create":
            return `${formatX64MirOperand(instruction.target)} <- closure_create ${instruction.closureId} apply=${instruction.applySymbol} env=${instruction.environmentLayout} [${instruction.captures.map((capture) => formatX64MirOperand(capture)).join(", ")}]${roots}`;
    }
}

export function formatX64MirProgram(program: X64MirProgram): string {
    const formatBody = (body: BackendTypes.X64MirBody): string => body.blocks
        .map((block) => `${block.label} preds=[${block.predecessors.join(", ")}] params=[${block.params.map((param) => formatX64MirOperand(param)).join(", ")}]: ${[
            ...block.instructions.map((instruction) => formatX64MirInstruction(instruction)),
            block.terminator.kind === "return"
                ? `return ${formatX64MirOperand(block.terminator.value)}`
                : block.terminator.kind === "jump"
                    ? `jump ${block.terminator.target}(${block.terminator.args.map((arg) => formatX64MirOperand(arg)).join(", ")})`
                    : `branch ${formatX64MirOperand(block.terminator.cond)} ? ${block.terminator.trueTarget}(${block.terminator.trueArgs.map((arg) => formatX64MirOperand(arg)).join(", ")}) : ${block.terminator.falseTarget}(${block.terminator.falseArgs.map((arg) => formatX64MirOperand(arg)).join(", ")})`
        ].join("; ")}`)
        .join("\n");
    const functionLines = program.functions.map((fn) => `${fn.symbol} entry=${fn.body.entryLabel} roots=[${fn.body.gcRootNames.join(", ")}]
${indent(formatBody(fn.body))}`);
    return [
        "x64_mir_program",
        "entry",
        indent(`entry=${program.entry.entryLabel} roots=[${program.entry.gcRootNames.join(", ")}]\n${indent(formatBody(program.entry), "")}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

function formatX64SelectedOperand(operand: BackendTypes.X64SelectedOperand): string {
    switch (operand.kind) {
        case "preg":
            return `%${operand.name}:${operand.bank}`;
        case "stack_arg":
            return `stack_arg[${operand.index}]:${operand.bank}`;
        case "incoming_stack_arg":
            return `incoming_stack_arg[${operand.index}]:${operand.bank}`;
        case "vreg":
            return `${operand.name}:${operand.bank}`;
        case "imm_i64":
            return `${operand.value}`;
        case "symbol":
            return `@${operand.symbol}`;
        case "text":
            return `${operand.referenceName}<${operand.typeName}>`;
    }
}

function formatX64SelectedInstruction(instruction: BackendTypes.X64SelectedInstruction): string {
    switch (instruction.kind) {
        case "copy":
            return `copy ${formatX64SelectedOperand(instruction.target)} <- ${formatX64SelectedOperand(instruction.source)}`;
        case "call_direct":
            return `call ${instruction.symbol}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "call_indirect":
            return `call *${formatX64SelectedOperand(instruction.callee)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "gc_frame_begin":
            return `gc_frame_begin roots=[${instruction.gcRoots.join(", ")}] values=[${instruction.gcRootOperands.map((operand) => formatX64SelectedOperand(operand)).join(", ")}]`;
        case "gc_frame_end":
            return `gc_frame_end roots=[${instruction.gcRoots.join(", ")}]`;
        case "test":
            return `test ${formatX64SelectedOperand(instruction.left)}, ${formatX64SelectedOperand(instruction.right)}`;
        case "pseudo_object_alloc":
            return `${instruction.target.name}:${instruction.target.bank} <- pseudo_object_alloc ${instruction.className}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_object_get_field":
            return `${instruction.target.name}:${instruction.target.bank} <- pseudo_object_get_field ${formatX64SelectedOperand(instruction.receiver)}.${instruction.className}.${instruction.fieldName}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_object_set_field":
            return `pseudo_object_set_field ${formatX64SelectedOperand(instruction.receiver)}.${instruction.className}.${instruction.fieldName} <- ${formatX64SelectedOperand(instruction.value)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_slot_load":
            return `${instruction.target.name}:${instruction.target.bank} <- pseudo_slot_load ${formatX64SelectedOperand(instruction.receiver)}.${instruction.className}.${instruction.slotName}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_slot_store":
            return `pseudo_slot_store ${formatX64SelectedOperand(instruction.receiver)}.${instruction.className}.${instruction.slotName} <- ${formatX64SelectedOperand(instruction.value)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_union_inject":
            return `${instruction.target.name}:${instruction.target.bank} <- pseudo_union_inject ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64SelectedOperand(instruction.value)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_union_has_tag":
            return `${instruction.target.name}:${instruction.target.bank} <- pseudo_union_has_tag ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64SelectedOperand(instruction.unionValue)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_union_get_payload":
            return `${instruction.target.name}:${instruction.target.bank} <- pseudo_union_get_payload ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64SelectedOperand(instruction.unionValue)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_closure_create":
            return `${instruction.target.name}:${instruction.target.bank} <- pseudo_closure_create ${instruction.closureId} apply=${instruction.applySymbol} env=${instruction.environmentLayout} [${instruction.captures.map((capture) => formatX64SelectedOperand(capture)).join(", ")}]${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
    }
}

export function formatX64SelectedProgram(program: X64SelectedProgram): string {
    const formatBody = (body: BackendTypes.X64SelectedBody): string => body.blocks
        .map((block) => `${block.label} preds=[${block.predecessors.join(", ")}] params=[${block.params.map((param) => formatX64MirOperand(param)).join(", ")}]: ${[
            ...block.instructions.map((instruction) => formatX64SelectedInstruction(instruction)),
            block.terminator.kind === "ret"
                ? "ret"
                : block.terminator.kind === "jmp"
                    ? `jmp ${block.terminator.target}(${block.terminator.args.map((arg) => formatX64SelectedOperand(arg)).join(", ")})`
                    : `jcc ${block.terminator.condition} ${block.terminator.trueTarget}(${block.terminator.trueArgs.map((arg) => formatX64SelectedOperand(arg)).join(", ")}) else ${block.terminator.falseTarget}(${block.terminator.falseArgs.map((arg) => formatX64SelectedOperand(arg)).join(", ")})`
        ].join("; ")}`)
        .join("\n");
    const functionLines = program.functions.map((fn) => `${fn.symbol} entry=${fn.body.entryLabel} roots=[${fn.body.gcRootNames.join(", ")}]
${indent(formatBody(fn.body))}`);
    return [
        "x64_selected_program",
        "entry",
        indent(`entry=${program.entry.entryLabel} roots=[${program.entry.gcRootNames.join(", ")}]\n${indent(formatBody(program.entry), "")}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

export function formatX64CopyPropagatedProgram(program: X64CopyPropagatedProgram): string {
    return formatX64SelectedProgram({
        kind: "x64_selected_program",
        entry: program.entry,
        globals: program.globals,
        functions: program.functions,
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    });
}

function formatX64RegAllocatedOperand(operand: BackendTypes.X64RegAllocatedOperand): string {
    switch (operand.kind) {
        case "preg":
            return `%${operand.name}:${operand.bank}`;
        case "stack_slot":
            return `stack_slot[${operand.index}]:${operand.bank}`;
        case "stack_arg":
            return `stack_arg[${operand.index}]:${operand.bank}`;
        case "incoming_stack_arg":
            return `incoming_stack_arg[${operand.index}]:${operand.bank}`;
        case "imm_i64":
            return `${operand.value}`;
        case "symbol":
            return `@${operand.symbol}`;
        case "text":
            return `${operand.referenceName}<${operand.typeName}>`;
    }
}

function formatX64RegAllocatedInstruction(instruction: BackendTypes.X64RegAllocatedInstruction): string {
    switch (instruction.kind) {
        case "copy":
            return `copy ${formatX64RegAllocatedOperand(instruction.target)} <- ${formatX64RegAllocatedOperand(instruction.source)}`;
        case "call_direct":
            return `call ${instruction.symbol}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "call_indirect":
            return `call *${formatX64RegAllocatedOperand(instruction.callee)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "gc_frame_begin":
            return `gc_frame_begin roots=[${instruction.gcRoots.join(", ")}] values=[${instruction.gcRootOperands.map((operand) => formatX64RegAllocatedOperand(operand)).join(", ")}]`;
        case "gc_frame_end":
            return `gc_frame_end roots=[${instruction.gcRoots.join(", ")}]`;
        case "test":
            return `test ${formatX64RegAllocatedOperand(instruction.left)}, ${formatX64RegAllocatedOperand(instruction.right)}`;
        case "pseudo_object_alloc":
            return `${formatX64RegAllocatedOperand(instruction.target)} <- pseudo_object_alloc ${instruction.className}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_object_get_field":
            return `${formatX64RegAllocatedOperand(instruction.target)} <- pseudo_object_get_field ${formatX64RegAllocatedOperand(instruction.receiver)}.${instruction.className}.${instruction.fieldName}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_object_set_field":
            return `pseudo_object_set_field ${formatX64RegAllocatedOperand(instruction.receiver)}.${instruction.className}.${instruction.fieldName} <- ${formatX64RegAllocatedOperand(instruction.value)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_slot_load":
            return `${formatX64RegAllocatedOperand(instruction.target)} <- pseudo_slot_load ${formatX64RegAllocatedOperand(instruction.receiver)}.${instruction.className}.${instruction.slotName}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_slot_store":
            return `pseudo_slot_store ${formatX64RegAllocatedOperand(instruction.receiver)}.${instruction.className}.${instruction.slotName} <- ${formatX64RegAllocatedOperand(instruction.value)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_union_inject":
            return `${formatX64RegAllocatedOperand(instruction.target)} <- pseudo_union_inject ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64RegAllocatedOperand(instruction.value)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_union_has_tag":
            return `${formatX64RegAllocatedOperand(instruction.target)} <- pseudo_union_has_tag ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64RegAllocatedOperand(instruction.unionValue)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_union_get_payload":
            return `${formatX64RegAllocatedOperand(instruction.target)} <- pseudo_union_get_payload ${instruction.unionTypeTagId}/${instruction.memberTypeTagId} ${formatX64RegAllocatedOperand(instruction.unionValue)}${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
        case "pseudo_closure_create":
            return `${formatX64RegAllocatedOperand(instruction.target)} <- pseudo_closure_create ${instruction.closureId} apply=${instruction.applySymbol} env=${instruction.environmentLayout} [${instruction.captures.map((capture) => formatX64RegAllocatedOperand(capture)).join(", ")}]${instruction.gcRoots.length > 0 ? ` roots=[${instruction.gcRoots.join(", ")}]` : ""}`;
    }
}

export function formatX64RegAllocatedProgram(program: X64RegAllocatedProgram): string {
    const formatBody = (body: BackendTypes.X64RegAllocatedBody): string => body.blocks
        .map((block) => `${block.label} preds=[${block.predecessors.join(", ")}] params=[${block.params.map((param) => formatX64RegAllocatedOperand(param)).join(", ")}]: ${[
            ...block.instructions.map((instruction) => formatX64RegAllocatedInstruction(instruction)),
            block.terminator.kind === "ret"
                ? "ret"
                : block.terminator.kind === "jmp"
                    ? `jmp ${block.terminator.target}(${block.terminator.args.map((arg) => formatX64RegAllocatedOperand(arg)).join(", ")})`
                    : `jcc ${block.terminator.condition} ${block.terminator.trueTarget}(${block.terminator.trueArgs.map((arg) => formatX64RegAllocatedOperand(arg)).join(", ")}) else ${block.terminator.falseTarget}(${block.terminator.falseArgs.map((arg) => formatX64RegAllocatedOperand(arg)).join(", ")})`
        ].join("; ")}`)
        .join("\n");
    const functionLines = program.functions.map((fn) => `${fn.symbol} entry=${fn.body.entryLabel} roots=[${fn.body.gcRootNames.join(", ")}] spill_slots=${fn.body.spillSlotCount}
${indent(formatBody(fn.body))}`);
    return [
        "x64_reg_allocated_program",
        "entry",
        indent(`entry=${program.entry.entryLabel} roots=[${program.entry.gcRootNames.join(", ")}] spill_slots=${program.entry.spillSlotCount}\n${indent(formatBody(program.entry), "")}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

export function formatX64FrameLayoutProgram(program: X64FrameLayoutProgram): string {
    const formatSlot = (slot: BackendTypes.X64FrameSlotLayout): string => {
        const offset = slot.offsetFromRbp >= 0 ? `+${slot.offsetFromRbp}` : `${slot.offsetFromRbp}`;
        return `${slot.kind} ${slot.bank}#${slot.index} @ rbp${offset} size=${slot.size}`;
    };
    const formatBody = (body: BackendTypes.X64FrameLayoutBody): string => [
        `entry=${body.entryLabel} roots=[${body.gcRootNames.join(", ")}] spill_slots=${body.spillSlotCount} outgoing_args=${body.outgoingStackArgCount} frame_size=${body.frameSizeBytes} align=${body.stackAlignmentBytes} callee_saved=[${body.calleeSavedRegisters.join(", ")}] gc_shadow_size=${body.gcShadowFrameSizeBytes} gc_shadow_offset=${body.gcShadowFrameOffsetFromRbp}`,
        "slots",
        indent(body.slots.length > 0 ? body.slots.map((slot) => formatSlot(slot)).join("\n") : "<none>"),
        "blocks",
        indent(body.blocks
            .map((block) => `${block.label} preds=[${block.predecessors.join(", ")}] params=[${block.params.map((param) => formatX64RegAllocatedOperand(param)).join(", ")}]: ${[
                ...block.instructions.map((instruction) => formatX64RegAllocatedInstruction(instruction)),
                block.terminator.kind === "ret"
                    ? "ret"
                    : block.terminator.kind === "jmp"
                        ? `jmp ${block.terminator.target}(${block.terminator.args.map((arg) => formatX64RegAllocatedOperand(arg)).join(", ")})`
                        : `jcc ${block.terminator.condition} ${block.terminator.trueTarget}(${block.terminator.trueArgs.map((arg) => formatX64RegAllocatedOperand(arg)).join(", ")}) else ${block.terminator.falseTarget}(${block.terminator.falseArgs.map((arg) => formatX64RegAllocatedOperand(arg)).join(", ")})`
            ].join("; ")}`)
            .join("\n"))
    ].join("\n");
    const functionLines = program.functions.map((fn) => `${fn.symbol}\n${indent(formatBody(fn.body))}`);
    return [
        "x64_frame_layout_program",
        "entry",
        indent(formatBody(program.entry)),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

export function formatX64PostRAPeepholeProgram(program: X64PostRAPeepholeProgram): string {
    const asFrameProgram: X64FrameLayoutProgram = {
        kind: "x64_frame_layout_program",
        entry: program.entry,
        globals: program.globals,
        functions: program.functions.map((fn) => ({
            symbol: fn.symbol,
            params: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            origin: fn.origin
        })),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
    return formatX64FrameLayoutProgram(asFrameProgram);
}

export function formatX64BranchOptimizedProgram(program: X64BranchOptimizedProgram): string {
    const asFrameProgram: X64FrameLayoutProgram = {
        kind: "x64_frame_layout_program",
        entry: program.entry,
        globals: program.globals,
        functions: program.functions.map((fn) => ({
            symbol: fn.symbol,
            params: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            origin: fn.origin
        })),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
    return formatX64FrameLayoutProgram(asFrameProgram);
}

export function formatX64LaidOutProgram(program: X64LaidOutProgram): string {
    const asFrameProgram: X64FrameLayoutProgram = {
        kind: "x64_frame_layout_program",
        entry: program.entry,
        globals: program.globals,
        functions: program.functions.map((fn) => ({
            symbol: fn.symbol,
            params: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            origin: fn.origin
        })),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
    return formatX64FrameLayoutProgram(asFrameProgram);
}

export function formatX64TextualAssemblyProgram(program: X64TextualAssemblyProgram): string {
    return program.text;
}

function formatMayCollectStatement(statement: BackendTypes.MayCollectStatement): string {
    switch (statement.kind) {
        case "assign":
        case "set_local":
        case "object_set_field":
        case "slot_store":
            return `${statement.kind}{may_collect=${statement.mayCollect}}`;
        case "if":
            return `(if may_collect=${statement.mayCollect} then [${statement.thenStatements.map((inner) => formatMayCollectStatement(inner)).join("; ")}] else [${statement.elseStatements.map((inner) => formatMayCollectStatement(inner)).join("; ")}])`;
        case "while":
            return `(while may_collect=${statement.mayCollect} cond=[${statement.condStatements.map((inner) => formatMayCollectStatement(inner)).join("; ")}] body=[${statement.bodyStatements.map((inner) => formatMayCollectStatement(inner)).join("; ")}])`;
    }
}

export function formatMayCollectProgram(program: BackendTypes.MayCollectProgram): string {
    const functionLines = program.functions.map((fn) => `${fn.symbol} may_collect=${fn.body.mayCollect} [${fn.body.statementAnnotations.map((statement) => formatMayCollectStatement(statement)).join("; ")}]`);
    return [
        "may_collect_program",
        "entry",
        indent(`may_collect=${program.entry.mayCollect} [${program.entry.statementAnnotations.map((statement) => formatMayCollectStatement(statement)).join("; ")}]`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

function formatTrimmedRootStatement(statement: BackendTypes.TrimmedRootCandidateStatement): string {
    switch (statement.kind) {
        case "assign":
        case "set_local":
        case "object_set_field":
        case "slot_store":
            return `${statement.kind}{roots=[${statement.gcRoots.join(", ")}]}`;
        case "if":
            return `(if roots=[${statement.gcRoots.join(", ")}] then [${statement.thenStatements.map((inner) => formatTrimmedRootStatement(inner)).join("; ")}] else [${statement.elseStatements.map((inner) => formatTrimmedRootStatement(inner)).join("; ")}])`;
        case "while":
            return `(while roots=[${statement.gcRoots.join(", ")}] cond=[${statement.condStatements.map((inner) => formatTrimmedRootStatement(inner)).join("; ")}] body=[${statement.bodyStatements.map((inner) => formatTrimmedRootStatement(inner)).join("; ")}])`;
    }
}

export function formatTrimmedRootCandidateProgram(program: BackendTypes.TrimmedRootCandidateProgram): string {
    const functionLines = program.functions.map((fn) => `${fn.symbol} roots=[${fn.body.gcRootNames.join(", ")}] result_roots=[${fn.body.resultGcRoots.join(", ")}] [${fn.body.statementRoots.map((statement) => formatTrimmedRootStatement(statement)).join("; ")}]`);
    return [
        "trimmed_root_candidate_program",
        "entry",
        indent(`roots=[${program.entry.gcRootNames.join(", ")}] result_roots=[${program.entry.resultGcRoots.join(", ")}] [${program.entry.statementRoots.map((statement) => formatTrimmedRootStatement(statement)).join("; ")}]`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

function formatCfgTrimmedRootStatement(statement: BackendTypes.CfgTrimmedRootCandidateStatement): string {
    return `${statement.kind}{roots=[${statement.gcRoots.join(", ")}] may_collect=${statement.mayCollect}}`;
}

export function formatCfgTrimmedRootCandidateProgram(program: BackendTypes.CfgTrimmedRootCandidateProgram): string {
    const formatBody = (body: BackendTypes.CfgTrimmedRootCandidateBody): string => body.blocks
        .map((block) => `${block.label} preds=[${block.predecessors.join(", ")}] live_in=[${block.liveIn.join(", ")}] live_out=[${block.liveOut.join(", ")}] term_roots=[${block.terminatorRoots.join(", ")}] ${block.statementRoots.map((statement) => formatCfgTrimmedRootStatement(statement)).join("; ")}`)
        .join("\n");
    const functionLines = program.functions.map((fn) => `${fn.symbol} roots=[${fn.body.gcRootNames.join(", ")}] return_roots=[${fn.body.returnRoots.join(", ")}]
${indent(formatBody(fn.body))}`);
    return [
        "cfg_trimmed_root_candidate_program",
        "entry",
        indent(`roots=[${program.entry.gcRootNames.join(", ")}] return_roots=[${program.entry.returnRoots.join(", ")}]\n${indent(formatBody(program.entry), "")}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

function formatRepresentationMap(representations: ReadonlyMap<string, BackendValueRepresentation>): string {
    return Array.from(representations.entries())
        .map(([name, representation]) => `${name}:${representation}`)
        .join(", ");
}

export function formatRepresentationSelectionProgram(program: RepresentationSelectionProgram): string {
    const functionLines = program.functions.map((fn) => `${fn.symbol} bindings=[${formatRepresentationMap(fn.body.bindingRepresentations)}] result=${fn.body.resultRepresentation}`);
    return [
        "representation_selection_program",
        "entry",
        indent(`bindings=[${formatRepresentationMap(program.entry.bindingRepresentations)}] result=${program.entry.resultRepresentation}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}

export function formatFinalBackendIRProgram(program: FinalBackendIRProgram): string {
    const functionLines = program.functions.map((fn) => `${fn.symbol}(${fn.params.join(", ")}) locals=[${fn.locals.join(", ")}] bindings=[${formatRepresentationMap(fn.bindingRepresentations)}] immediates=[${fn.immediateNames.join(", ")}] result_rep=${fn.resultRepresentation} roots=[${fn.gcRootNames.join(", ")}] ${fn.statements.map((statement) => formatLinearStatement(statement)).join("; ")} => ${formatLinearOperand(fn.result)}`);
    const globalLines = program.globals.map((globalDef) => globalDef.symbol);
    return [
        "final_backend_ir_program",
        "globals",
        indent(globalLines.length > 0 ? globalLines.join("\n") : "<none>"),
        "entry",
        indent(`${program.entry.symbol} locals=[${program.entry.locals.join(", ")}] bindings=[${formatRepresentationMap(program.entry.bindingRepresentations)}] immediates=[${program.entry.immediateNames.join(", ")}] result_rep=${program.entry.resultRepresentation} roots=[${program.entry.gcRootNames.join(", ")}] ${program.entry.statements.map((statement) => formatLinearStatement(statement)).join("; ")} => ${formatLinearOperand(program.entry.result)}`),
        "functions",
        indent(functionLines.length > 0 ? functionLines.join("\n") : "<none>")
    ].join("\n");
}
