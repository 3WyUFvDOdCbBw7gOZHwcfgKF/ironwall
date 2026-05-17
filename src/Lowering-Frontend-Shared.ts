import { AstNode, ClassNode, DfunNode } from "./AstNode";
import type { FunctionTypeValue, TypeValue } from "./Typecheck-Core";

export interface LoweringUnionMemberMetadata {
    readonly runtimeTypeTagId: string;
}

export interface LoweringUnionMetadata {
    readonly unionTypeTagId: string;
    readonly members: readonly LoweringUnionMemberMetadata[];
}

export interface LoweringEntryParam {
    readonly name: string;
    readonly typeExp: AstNode;
}

export interface LoweringSnapshotClassDefinition {
    readonly concreteName: string;
    readonly runtimeTypeTagId: string;
    readonly classNode: ClassNode;
    readonly propertyTypes: ReadonlyMap<string, TypeValue>;
    readonly methodTypes: ReadonlyMap<string, FunctionTypeValue>;
    readonly constructorParamTypes: readonly (readonly TypeValue[])[];
    readonly isExternal?: boolean;
    readonly sourceName: string;
    readonly instanceHash?: string;
    readonly unitId?: string | null;
}

export interface LoweringSnapshotFunctionDefinition {
    readonly concreteName: string;
    readonly functionNode: DfunNode;
    readonly functionType: FunctionTypeValue;
    readonly sourceName: string;
    readonly instanceHash?: string;
    readonly unitId?: string | null;
}

export interface LoweringSnapshotDeclaredFunction {
    readonly symbol: string;
    readonly paramNames: readonly string[];
    readonly functionType: FunctionTypeValue;
    readonly sourceName: string;
    readonly callingConvention: "c_ffi" | "iw_external";
    readonly unitId?: string | null;
}

export interface LoweringExportedIwFunction {
    readonly concreteSymbol: string;
    readonly exportSymbol: string;
    readonly paramTypes: readonly TypeValue[];
    readonly resultType: TypeValue;
}

export interface LoweringMetadata {
    readonly sourceTopLevelNodeCount: number;
    readonly executableStatementCount: number;
    readonly concreteClassCount: number;
    readonly concreteFunctionCount: number;
    readonly monomorphizedClassCount: number;
    readonly monomorphizedFunctionCount: number;
    readonly concreteClassTypeTagIds: readonly string[];
    readonly referencedUnionTypeTagIds: readonly string[];
    readonly referencedUnionMetadata: readonly LoweringUnionMetadata[];
    readonly exportedIwFunctions: readonly LoweringExportedIwFunction[];
    readonly entryConcreteFunctionSymbol: string | null;
    readonly entryParams: readonly LoweringEntryParam[];
}

export interface LoweringGlobalDefinition {
    readonly symbol: string;
    readonly type: TypeValue;
    readonly isExternal?: boolean;
    readonly unitId?: string | null;
}

export interface LoweringSnapshotProgram {
    readonly kind: "lowering_snapshot_program";
    readonly topLevelStatements: readonly AstNode[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly concreteClasses: readonly LoweringSnapshotClassDefinition[];
    readonly concreteFunctions: readonly LoweringSnapshotFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly metadata: LoweringMetadata;
}

export interface BackendExternFunctionIR {
    readonly symbol: string;
    readonly params: readonly string[];
    readonly paramTypes: readonly TypeValue[];
    readonly paramRepresentations: readonly ("immediate" | "reference")[];
    readonly resultType: TypeValue;
    readonly resultRepresentation: "immediate" | "reference";
    readonly callingConvention: "c_ffi" | "iw_external";
}

export interface LoweringClassLayout {
    readonly className: string;
    readonly runtimeTypeTagId: string;
    readonly isExternal?: boolean;
    readonly unitId?: string | null;
    readonly propertyOrder: readonly string[];
    readonly propertyTypes: ReadonlyMap<string, TypeValue>;
    readonly methodOrder: readonly string[];
    readonly methodTypes: ReadonlyMap<string, FunctionTypeValue>;
    readonly methodSymbols: ReadonlyMap<string, string>;
    readonly constructors: readonly LoweringConstructorLayout[];
}

export interface LoweringConstructorLayout {
    readonly symbol: string;
    readonly paramTypes: readonly TypeValue[];
}

export interface LoweringLayoutTable {
    readonly kind: "lowering_layout_table";
    readonly classes: ReadonlyMap<string, LoweringClassLayout>;
}

export interface LoweredBinding {
    readonly name: string;
    readonly typeExp: AstNode;
}

export interface LoweredLetBinding {
    readonly bind: LoweredBinding;
    readonly value: LoweredExpr;
}

export interface LoweredClause {
    readonly cond: LoweredExpr;
    readonly body: LoweredExpr;
}

export interface LoweredMatchBranch {
    readonly bind: LoweredBinding;
    readonly memberTypeTagId: string;
    readonly body: LoweredExpr;
}

export interface LoweredIdentifierExpr {
    readonly kind: "identifier";
    readonly name: string;
}

export interface LoweredNumberLiteralExpr {
    readonly kind: "number_literal";
    readonly value: number;
    readonly typeName: string;
}

export interface LoweredTextLiteralExpr {
    readonly kind: "text_literal";
    readonly typeName: string;
    readonly referenceName: string;
    readonly content: string;
}

export interface LoweredFnExpr {
    readonly kind: "fn";
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: LoweredExpr;
}

export interface LoweredLetExpr {
    readonly kind: "let";
    readonly bindings: readonly LoweredLetBinding[];
    readonly body: LoweredExpr;
}

export interface LoweredIfExpr {
    readonly kind: "if";
    readonly condExpr: LoweredExpr;
    readonly trueBranchExpr: LoweredExpr;
    readonly falseBranchExpr: LoweredExpr;
}

export interface LoweredWhileExpr {
    readonly kind: "while";
    readonly condExpr: LoweredExpr;
    readonly bodyExpr: LoweredExpr;
}

export interface LoweredCondExpr {
    readonly kind: "cond";
    readonly clauses: readonly LoweredClause[];
}

export interface LoweredDvarExpr {
    readonly kind: "dvar";
    readonly bind: LoweredBinding;
    readonly value: LoweredExpr;
}

export interface LoweredSeqExpr {
    readonly kind: "seq";
    readonly expressions: readonly LoweredExpr[];
}

export interface LoweredSetLocalExpr {
    readonly kind: "set_local";
    readonly identifier: string;
    readonly value: LoweredExpr;
}

export interface LoweredCallExpr {
    readonly kind: "call";
    readonly callee: LoweredExpr;
    readonly args: readonly LoweredExpr[];
}

export interface LoweredDirectCallExpr {
    readonly kind: "direct_call";
    readonly symbol: string;
    readonly args: readonly LoweredExpr[];
}

export interface LoweredDirectFunctionRefExpr {
    readonly kind: "direct_function_ref";
    readonly symbol: string;
}

export interface LoweredObjectAllocExpr {
    readonly kind: "object_alloc";
    readonly className: string;
}

export interface LoweredObjectGetFieldExpr {
    readonly kind: "object_get_field";
    readonly receiver: LoweredExpr;
    readonly className: string;
    readonly fieldName: string;
}

export interface LoweredObjectSetFieldExpr {
    readonly kind: "object_set_field";
    readonly receiver: LoweredExpr;
    readonly className: string;
    readonly fieldName: string;
    readonly value: LoweredExpr;
}

export interface LoweredMethodClosureCreateExpr {
    readonly kind: "method_closure_create";
    readonly receiver: LoweredExpr;
    readonly className: string;
    readonly methodName: string;
    readonly methodSymbol: string;
}

export interface LoweredUnionInjectExpr {
    readonly kind: "union_inject";
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly value: LoweredExpr;
}

export interface LoweredMatchExpr {
    readonly kind: "match";
    readonly unionTypeTagId: string;
    readonly unionExpr: LoweredExpr;
    readonly branches: readonly LoweredMatchBranch[];
}

export type LoweredExpr =
    | LoweredIdentifierExpr
    | LoweredNumberLiteralExpr
    | LoweredTextLiteralExpr
    | LoweredFnExpr
    | LoweredLetExpr
    | LoweredIfExpr
    | LoweredWhileExpr
    | LoweredCondExpr
    | LoweredDvarExpr
    | LoweredSeqExpr
    | LoweredSetLocalExpr
    | LoweredCallExpr
    | LoweredDirectCallExpr
    | LoweredDirectFunctionRefExpr
    | LoweredObjectAllocExpr
    | LoweredObjectGetFieldExpr
    | LoweredObjectSetFieldExpr
    | LoweredMethodClosureCreateExpr
    | LoweredUnionInjectExpr
    | LoweredMatchExpr;

export interface LoweredPropertyDefinition {
    readonly bind: LoweredBinding;
}

export interface LoweredMethodDefinition {
    readonly methodName: string;
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: LoweredExpr;
}

export interface LoweredConstructorDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly body: LoweredExpr;
}

export interface LoweredClassDefinition {
    readonly className: string;
    readonly propertyOrder: readonly LoweredPropertyDefinition[];
    readonly methods: readonly LoweredMethodDefinition[];
    readonly constructorDefs: readonly LoweredConstructorDefinition[];
}

export interface LoweredFunctionOrigin {
    readonly kind: "top_level" | "method" | "constructor" | "closure_shrink";
    readonly className?: string;
    readonly methodName?: string;
}

export interface LoweredFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: LoweredExpr;
    readonly origin: LoweredFunctionOrigin;
    readonly unitId?: string | null;
}

export interface LoweredClassPrimitiveProgram {
    readonly kind: "lowered_class_primitive_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly classes: readonly LoweredClassDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface LiftedLoweringProgram {
    readonly kind: "lifted_lowering_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly liftedMethodMap: ReadonlyMap<string, string>;
    readonly metadata: LoweringMetadata;
}

export interface LoweringStageAResult {
    readonly snapshot: LoweringSnapshotProgram;
    readonly layouts: LoweringLayoutTable;
    readonly pass2: LoweredClassPrimitiveProgram;
    readonly pass3: LiftedLoweringProgram;
}

export interface DesugaredCoreProgram {
    readonly kind: "desugared_core_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface AnfProgram {
    readonly kind: "anf_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface SimplifiedAnfStats {
    readonly foldedConstantIfs: number;
    readonly removedDeadLets: number;
    readonly collapsedIdentityLets: number;
    readonly flattenedSeqs: number;
    readonly removedRedundantIfs: number;
}

export interface SimplifiedAnfProgram {
    readonly kind: "simplified_anf_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
    readonly stats: SimplifiedAnfStats;
}

export interface UnknownValueFact {
    readonly kind: "unknown";
}

export interface BooleanValueFact {
    readonly kind: "boolean_literal";
    readonly value: boolean;
}

export interface NumberValueFact {
    readonly kind: "number_literal";
    readonly value: number;
    readonly typeName: string;
}

export interface TextValueFact {
    readonly kind: "text_literal";
    readonly typeName: string;
    readonly referenceName: string;
}

export interface DirectFunctionValueFact {
    readonly kind: "direct_function_ref";
    readonly symbol: string;
}

export type ValueFact =
    | UnknownValueFact
    | BooleanValueFact
    | NumberValueFact
    | TextValueFact
    | DirectFunctionValueFact;

export interface BindingFact {
    readonly bindingId: string;
    readonly name: string;
    readonly declaredIn: "let" | "param" | "match";
    readonly useCount: number;
    readonly isAssigned: boolean;
    readonly isCaptured: boolean;
    readonly escapes: boolean;
    readonly isPure: boolean;
    readonly fact: ValueFact;
}

export interface FactsAnalysisResult {
    readonly kind: "facts_analysis";
    readonly bindings: readonly BindingFact[];
}

export interface PropagatedFactStats {
    readonly inlinedSingleUseBindings: number;
    readonly propagatedConstants: number;
    readonly propagatedBooleans: number;
    readonly propagatedDirectFunctions: number;
    readonly foldedConstantIfs: number;
    readonly collapsedEquivalentIfs: number;
    readonly removedDeadLets: number;
}

export interface PropagatedFactsProgram {
    readonly kind: "propagated_facts_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
    readonly stats: PropagatedFactStats;
}

export interface KnownCallStats {
    readonly convertedCalls: number;
    readonly convertedAliases: number;
}

export interface KnownCallProgram {
    readonly kind: "known_call_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
    readonly stats: KnownCallStats;
}

export interface TinyInlineStats {
    readonly inlinedCalls: number;
    readonly skippedRecursiveCalls: number;
}

export interface TinyInlinedProgram {
    readonly kind: "tiny_inlined_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
    readonly stats: TinyInlineStats;
}

export interface LambdaFreeVarInfo {
    readonly siteId: string;
    readonly boundVariables: readonly string[];
    readonly freeVariables: readonly string[];
    readonly capturesMutableLocal: boolean;
}

export interface BoundMethodCaptureInfo {
    readonly siteId: string;
    readonly className: string;
    readonly methodName: string;
    readonly methodSymbol: string;
    readonly capturedVariables: readonly string[];
}

export interface FreeVarAnalysisResult {
    readonly kind: "free_var_analysis";
    readonly lambdaSites: ReadonlyMap<string, LambdaFreeVarInfo>;
    readonly boundMethodSites: ReadonlyMap<string, BoundMethodCaptureInfo>;
}

export type EscapeSourceKind = "lambda" | "bound_method" | "fresh_object" | "fresh_union";

export type EscapeClassification = "non_escaping" | "returned" | "stored" | "argument_escape" | "local_only";

export interface EscapeSiteInfo {
    readonly sourceId: string;
    readonly ownerId: string;
    readonly bindingName?: string;
    readonly sourceKind: EscapeSourceKind;
    readonly classification: EscapeClassification;
    readonly lambdaSiteId?: string;
    readonly boundMethodSiteId?: string;
    readonly localCallUses: number;
    readonly returned: boolean;
    readonly stored: boolean;
    readonly argumentEscapes: boolean;
    readonly capturesMutableLocal: boolean;
}

export interface EscapeAnalysisResult {
    readonly kind: "escape_analysis";
    readonly sites: readonly EscapeSiteInfo[];
}

export interface ShrinkClosureStats {
    readonly loweredNonCapturedLambdas: number;
    readonly rewrittenDirectCalls: number;
    readonly rewrittenImmediateCalls: number;
    readonly rewrittenBoundMethodCalls: number;
}

export interface ShrunkClosureProgram {
    readonly kind: "shrunk_closure_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
    readonly stats: ShrinkClosureStats;
}

export interface LoweringStageBResult extends LoweringStageAResult {
    readonly pass4: DesugaredCoreProgram;
    readonly pass5: AnfProgram;
    readonly pass5a: SimplifiedAnfProgram;
    readonly pass5b: FactsAnalysisResult;
    readonly pass5c: PropagatedFactsProgram;
    readonly pass5cFacts: FactsAnalysisResult;
    readonly pass5d: KnownCallProgram;
    readonly pass5e: TinyInlinedProgram;
    readonly pass6: FreeVarAnalysisResult;
    readonly pass6a: EscapeAnalysisResult;
    readonly pass6b: ShrunkClosureProgram;
    readonly pass6c: FreeVarAnalysisResult;
    readonly pass6d: EscapeAnalysisResult;
}

export interface MutableCaptureDiagnostic {
    readonly siteId: string;
    readonly freeVariables: readonly string[];
    readonly message: string;
}

export interface CapturedMutableCheckedProgram {
    readonly kind: "captured_mutable_checked_program";
    readonly topLevelStatements: readonly LoweredExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LoweredFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
    readonly analysis: FreeVarAnalysisResult;
    readonly diagnostics: readonly MutableCaptureDiagnostic[];
}

export interface ClosureIdentifierExpr {
    readonly kind: "identifier";
    readonly name: string;
}

export interface ClosureNumberLiteralExpr {
    readonly kind: "number_literal";
    readonly value: number;
    readonly typeName: string;
}

export interface ClosureLetBinding {
    readonly bind: LoweredBinding;
    readonly value: ClosureExpr;
}

export interface ClosureLetExpr {
    readonly kind: "let";
    readonly bindings: readonly ClosureLetBinding[];
    readonly body: ClosureExpr;
}

export interface ClosureIfExpr {
    readonly kind: "if";
    readonly condExpr: ClosureExpr;
    readonly trueBranchExpr: ClosureExpr;
    readonly falseBranchExpr: ClosureExpr;
}

export interface ClosureWhileExpr {
    readonly kind: "while";
    readonly condExpr: ClosureExpr;
    readonly bodyExpr: ClosureExpr;
}

export interface ClosureSeqExpr {
    readonly kind: "seq";
    readonly expressions: readonly ClosureExpr[];
}

export interface ClosureSetLocalExpr {
    readonly kind: "set_local";
    readonly identifier: string;
    readonly value: ClosureExpr;
}

export interface ClosureDirectCallExpr {
    readonly kind: "direct_call";
    readonly symbol: string;
    readonly args: readonly ClosureExpr[];
}

export interface ClosureDirectFunctionRefExpr {
    readonly kind: "direct_function_ref";
    readonly symbol: string;
}

export interface ClosureObjectAllocExpr {
    readonly kind: "object_alloc";
    readonly className: string;
}

export interface ClosureObjectGetFieldExpr {
    readonly kind: "object_get_field";
    readonly receiver: ClosureExpr;
    readonly className: string;
    readonly fieldName: string;
}

export interface ClosureObjectSetFieldExpr {
    readonly kind: "object_set_field";
    readonly receiver: ClosureExpr;
    readonly className: string;
    readonly fieldName: string;
    readonly value: ClosureExpr;
}

export interface ClosureSlotLoadExpr {
    readonly kind: "slot_load";
    readonly receiver: ClosureExpr;
    readonly className: string;
    readonly slotName: string;
}

export interface ClosureSlotStoreExpr {
    readonly kind: "slot_store";
    readonly receiver: ClosureExpr;
    readonly className: string;
    readonly slotName: string;
    readonly value: ClosureExpr;
}

export interface ClosureCreateExpr {
    readonly kind: "closure_create";
    readonly closureId: string;
    readonly applySymbol: string;
    readonly environmentLayout: string;
    readonly captures: readonly ClosureExpr[];
}

export interface ClosureCallExpr {
    readonly kind: "closure_call";
    readonly callee: ClosureExpr;
    readonly args: readonly ClosureExpr[];
}

export interface ClosureMatchBranch {
    readonly bind: LoweredBinding;
    readonly memberTypeTagId: string;
    readonly body: ClosureExpr;
}

export interface ClosureUnionInjectExpr {
    readonly kind: "union_inject";
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly value: ClosureExpr;
}

export interface ClosureMatchExpr {
    readonly kind: "match";
    readonly unionTypeTagId: string;
    readonly unionExpr: ClosureExpr;
    readonly branches: readonly ClosureMatchBranch[];
}

export interface ClosureTextLiteralExpr {
    readonly kind: "text_literal";
    readonly typeName: string;
    readonly referenceName: string;
    readonly content: string;
}

export type ClosureExpr =
    | ClosureIdentifierExpr
    | ClosureNumberLiteralExpr
    | ClosureTextLiteralExpr
    | ClosureLetExpr
    | ClosureIfExpr
    | ClosureWhileExpr
    | ClosureSeqExpr
    | ClosureSetLocalExpr
    | ClosureDirectCallExpr
    | ClosureDirectFunctionRefExpr
    | ClosureObjectAllocExpr
    | ClosureObjectGetFieldExpr
    | ClosureObjectSetFieldExpr
    | ClosureSlotLoadExpr
    | ClosureSlotStoreExpr
    | ClosureUnionInjectExpr
    | ClosureCreateExpr
    | ClosureCallExpr
    | ClosureMatchExpr;

export interface ClosureFunctionOrigin {
    readonly kind: "top_level" | "method" | "constructor" | "closure_apply" | "closure_shrink";
    readonly className?: string;
    readonly methodName?: string;
    readonly closureId?: string;
}

export interface ClosureConvertedFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: ClosureExpr;
    readonly origin: ClosureFunctionOrigin;
    readonly unitId?: string | null;
}

export interface ClosureHelperDefinition {
    readonly closureId: string;
    readonly applySymbol: string;
    readonly environmentLayout: string;
    readonly captureOrder: readonly string[];
    readonly captureTypes: ReadonlyMap<string, TypeValue>;
    readonly sourceKind: "lambda" | "bound_method";
}

export interface ClosureConvertedProgram {
    readonly kind: "closure_converted_program";
    readonly topLevelStatements: readonly ClosureExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly ClosureConvertedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface TypedSlotProgram {
    readonly kind: "typed_slot_program";
    readonly topLevelStatements: readonly ClosureExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly ClosureConvertedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export interface FoldedTypedPrimitiveProgramStats {
    readonly forwardedSlotLoads: number;
    readonly foldedInjectedMatches: number;
}

export interface FoldedTypedPrimitiveProgram {
    readonly kind: "folded_typed_primitive_program";
    readonly topLevelStatements: readonly ClosureExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly ClosureConvertedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
    readonly stats: FoldedTypedPrimitiveProgramStats;
}

export interface ScalarReplacedFreshProgramStats {
    readonly scalarizedObjects: number;
    readonly replacedSlotStores: number;
    readonly replacedSlotLoads: number;
    readonly scalarizedClosures: number;
    readonly rewrittenClosureCalls: number;
}

export interface ScalarReplacedFreshProgram {
    readonly kind: "scalar_replaced_fresh_program";
    readonly topLevelStatements: readonly ClosureExpr[];
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly ClosureConvertedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
    readonly stats: ScalarReplacedFreshProgramStats;
}

export interface LinearLocalOperand {
    readonly kind: "local";
    readonly name: string;
}

export interface LinearNumberOperand {
    readonly kind: "number_literal";
    readonly value: number;
    readonly typeName: string;
}

export interface LinearTextOperand {
    readonly kind: "text_literal";
    readonly typeName: string;
    readonly referenceName: string;
    readonly content: string;
}

export interface LinearDirectFunctionOperand {
    readonly kind: "direct_function";
    readonly symbol: string;
}

export type LinearOperand = LinearLocalOperand | LinearNumberOperand | LinearTextOperand | LinearDirectFunctionOperand;

export interface LinearCopyRvalue {
    readonly kind: "copy";
    readonly value: LinearOperand;
}

export interface LinearObjectAllocRvalue {
    readonly kind: "object_alloc";
    readonly className: string;
}

export interface LinearObjectGetFieldRvalue {
    readonly kind: "object_get_field";
    readonly receiver: LinearOperand;
    readonly className: string;
    readonly fieldName: string;
}

export interface LinearSlotLoadRvalue {
    readonly kind: "slot_load";
    readonly receiver: LinearOperand;
    readonly className: string;
    readonly slotName: string;
}

export interface LinearUnionInjectRvalue {
    readonly kind: "union_inject";
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
    readonly value: LinearOperand;
}

export interface LinearUnionHasTagRvalue {
    readonly kind: "union_has_tag";
    readonly unionValue: LinearOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
}

export interface LinearUnionGetPayloadRvalue {
    readonly kind: "union_get_payload";
    readonly unionValue: LinearOperand;
    readonly unionTypeTagId: string;
    readonly memberTypeTagId: string;
}

export interface LinearClosureCreateRvalue {
    readonly kind: "closure_create";
    readonly closureId: string;
    readonly applySymbol: string;
    readonly environmentLayout: string;
    readonly captures: readonly LinearOperand[];
}

export interface LinearDirectCallRvalue {
    readonly kind: "direct_call";
    readonly symbol: string;
    readonly args: readonly LinearOperand[];
}

export interface LinearClosureCallRvalue {
    readonly kind: "closure_call";
    readonly callee: LinearOperand;
    readonly args: readonly LinearOperand[];
}

export type LinearRvalue =
    | LinearCopyRvalue
    | LinearObjectAllocRvalue
    | LinearObjectGetFieldRvalue
    | LinearSlotLoadRvalue
    | LinearUnionInjectRvalue
    | LinearUnionHasTagRvalue
    | LinearUnionGetPayloadRvalue
    | LinearClosureCreateRvalue
    | LinearDirectCallRvalue
    | LinearClosureCallRvalue;

export interface LinearAssignStatement {
    readonly kind: "assign";
    readonly target: string;
    readonly value: LinearRvalue;
}

export interface LinearSetLocalStatement {
    readonly kind: "set_local";
    readonly target: string;
    readonly value: LinearOperand;
}

export interface LinearObjectSetFieldStatement {
    readonly kind: "object_set_field";
    readonly receiver: LinearOperand;
    readonly className: string;
    readonly fieldName: string;
    readonly value: LinearOperand;
}

export interface LinearSlotStoreStatement {
    readonly kind: "slot_store";
    readonly receiver: LinearOperand;
    readonly className: string;
    readonly slotName: string;
    readonly value: LinearOperand;
}

export interface LinearIfStatement {
    readonly kind: "if";
    readonly cond: LinearOperand;
    readonly thenStatements: readonly LinearStatement[];
    readonly elseStatements: readonly LinearStatement[];
}

export interface LinearWhileStatement {
    readonly kind: "while";
    readonly condStatements: readonly LinearStatement[];
    readonly cond: LinearOperand;
    readonly bodyStatements: readonly LinearStatement[];
}

export type LinearStatement =
    | LinearAssignStatement
    | LinearSetLocalStatement
    | LinearObjectSetFieldStatement
    | LinearSlotStoreStatement
    | LinearIfStatement
    | LinearWhileStatement;

export interface LinearBody {
    readonly locals: readonly string[];
    readonly statements: readonly LinearStatement[];
    readonly result: LinearOperand;
}

export interface LinearizedFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: LinearBody;
    readonly origin: ClosureFunctionOrigin;
    readonly unitId?: string | null;
}

export interface LinearizedProgram {
    readonly kind: "linearized_program";
    readonly topLevelBody: LinearBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly LinearizedFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export type CfgStatement =
    | LinearAssignStatement
    | LinearSetLocalStatement
    | LinearObjectSetFieldStatement
    | LinearSlotStoreStatement;

export interface CfgReturnTerminator {
    readonly kind: "return";
    readonly value: LinearOperand;
}

export interface CfgJumpTerminator {
    readonly kind: "jump";
    readonly target: string;
}

export interface CfgBranchTerminator {
    readonly kind: "branch";
    readonly cond: LinearOperand;
    readonly trueTarget: string;
    readonly falseTarget: string;
}

export type CfgTerminator = CfgReturnTerminator | CfgJumpTerminator | CfgBranchTerminator;

export interface CfgBlock {
    readonly label: string;
    readonly statements: readonly CfgStatement[];
    readonly terminator: CfgTerminator;
}

export interface CfgBody {
    readonly entryLabel: string;
    readonly locals: readonly string[];
    readonly blocks: readonly CfgBlock[];
}

export interface CfgFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: CfgBody;
    readonly origin: ClosureFunctionOrigin;
    readonly unitId?: string | null;
}

export interface CfgProgram {
    readonly kind: "cfg_program";
    readonly entry: CfgBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly CfgFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}

export type SsaOperand = LinearOperand;
export type SsaRvalue = LinearRvalue;
export type SsaStatement =
    | LinearAssignStatement
    | LinearSetLocalStatement
    | LinearObjectSetFieldStatement
    | LinearSlotStoreStatement;
export type SsaTerminator = CfgTerminator;

export interface SsaEntryBinding {
    readonly variable: string;
    readonly value: string;
}

export interface SsaPhiInput {
    readonly predecessor: string;
    readonly value: SsaOperand;
}

export interface SsaPhiNode {
    readonly variable: string;
    readonly target: string;
    readonly sources: readonly SsaPhiInput[];
}

export interface SsaBlock {
    readonly label: string;
    readonly predecessors: readonly string[];
    readonly immediateDominator: string | null;
    readonly dominanceFrontier: readonly string[];
    readonly phiNodes: readonly SsaPhiNode[];
    readonly statements: readonly SsaStatement[];
    readonly statementSourceIndexes: readonly number[];
    readonly terminator: SsaTerminator;
}

export interface SsaBody {
    readonly entryLabel: string;
    readonly locals: readonly string[];
    readonly entryBindings: readonly SsaEntryBinding[];
    readonly blocks: readonly SsaBlock[];
}

export interface SsaFunctionDefinition {
    readonly symbol: string;
    readonly params: readonly LoweredBinding[];
    readonly returnType: AstNode;
    readonly body: SsaBody;
    readonly origin: ClosureFunctionOrigin;
    readonly unitId?: string | null;
}

export interface SsaProgram {
    readonly kind: "ssa_program";
    readonly entry: SsaBody;
    readonly globals: readonly LoweringGlobalDefinition[];
    readonly functions: readonly SsaFunctionDefinition[];
    readonly declaredFunctions: readonly LoweringSnapshotDeclaredFunction[];
    readonly closureHelpers: readonly ClosureHelperDefinition[];
    readonly layouts: LoweringLayoutTable;
    readonly metadata: LoweringMetadata;
}
