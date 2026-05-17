import type {
    BackendValueRepresentation,
    BackendFunctionIR,
    FinalBackendIRProgram,
    GcRootPlanStatement
} from "./Backend-Windows-IR-Shared";
import type {
    ClosureHelperDefinition,
    LoweringClassLayout,
    LoweringExportedIwFunction,
    LoweringGlobalDefinition,
    LinearOperand,
    LinearRvalue,
    LinearStatement,
    LoweringUnionMetadata
} from "../Lowering-Frontend-Shared";
import { parseDeclaredCFunctionName } from "../DeclaredCFunctionName";
import { PrimitiveTypeValue, getClassTypeId, getRuntimeTypeId, hashText, type TypeValue } from "./Backend-Windows-Typecheck-Core";
import {
    decodeX64NumericLiteralSymbolPart,
    x64NativeAllocSymbol,
    x64NativeClosureCallSymbol,
    x64NativeClosureCreateSymbol,
    x64NativeBoxedNumberValueSymbol,
    x64NativeDirectFunctionValueSymbol,
    x64NativeGcFrameInitSymbol,
    x64NativeDirectCallWrapperSymbol,
    x64NativeObjectGetFieldSymbol,
    x64NativeObjectSetFieldSymbol,
    x64NativeSlotLoadSymbol,
    x64NativeSlotStoreSymbol,
    x64NativeUnionGetPayloadSymbol,
    x64NativeUnionHasTagSymbol,
    x64NativeUnionInjectSymbol,
    x64NativeTextValueSymbol
} from "./Backend-Windows-X64-NativeSupport";
import {
    performWindowsCBackendSourcePass1CollectSections,
    performWindowsCBackendX64SupportPass1CollectSections
} from "./Backend-Windows-C-Pass-1-CollectSections";
import {
    performWindowsCBackendSourcePass2AssembleRuntimeAndDriverSource,
    performWindowsCBackendX64SupportPass2AssembleSource
} from "./Backend-Windows-C-Pass-2-AssembleSource";
import { performWindowsCBackendSourcePass3SplitRuntimeAndDriverSource } from "./Backend-Windows-C-Pass-3-SplitSources";
import { buildWindowsCBuiltinArtifacts } from "./Backend-Windows-C-Builtins";
import {
    emitWindowsCDeclaredCHeapHostHelperRuntime,
    emitWindowsCDeclaredStdSysFfiRuntime,
    emitWindowsCExportedIwFunctionRuntime,
    generateWindowsCHeaderFromFinalBackendIR
} from "./Backend-Windows-C-HostInterop";
import { emitWindowsCGcCollectCoreRuntime } from "./Backend-Windows-C-GC-CollectCore";
import {
    emitWindowsCGcGlobalContentPrinter,
    emitWindowsCGcPrintPassRuntime
} from "./Backend-Windows-C-GC-PrintPass";
import type { WindowsCGcPrintPassDependencies } from "./Backend-Windows-C-GC-Shared";
import { emitWindowsCGcValidationPassRuntime } from "./Backend-Windows-C-GC-ValidationPass";

interface DirectFunctionClosureArtifact {
    readonly symbol: string;
    readonly runtimeTypeTagId: string;
    readonly arity: number;
}

type BuiltinEmitter = (args: readonly string[]) => string;

interface BuiltinSpec {
    readonly arity: number;
    readonly emit: BuiltinEmitter;
}

interface BuiltinRuntimeTypeArtifact {
    readonly symbolName: string;
    readonly runtimeTypeTagId: string;
}

interface ClosureDescriptorArtifact {
    readonly runtimeTypeTagId: string;
    readonly debugName: string;
    readonly applySymbol: string;
    readonly environmentLayout?: string;
    readonly captureOrder: readonly string[];
    readonly captureTypeTagIds: readonly string[];
    readonly arity: number;
    readonly sourceKind: "lambda" | "bound_method" | "direct_function";
}

interface FunctionSignatureArtifact {
    readonly paramRepresentations: readonly BackendValueRepresentation[];
    readonly resultRepresentation: BackendValueRepresentation;
}

const INTEGER_TYPE_NAMES = ["i5", "i6", "i7", "u5", "u6", "u7"] as const;
const CHARACTER_TYPE_NAMES = ["c3", "c4", "c5"] as const;
const INTEGER_COMPARISON_BUILTINS = ["le", "lt", "ge", "gt", "eq", "neq"] as const;
const FLOAT_TO_I5_UNARY_BUILTINS = ["round", "floor", "ceil", "trunc"] as const;
const F5_BOXED_RUNTIME_TYPE_TAG_ID = "F4635000000000001";
const F6_BOXED_RUNTIME_TYPE_TAG_ID = "F4636000000000001";
const F7_BOXED_RUNTIME_TYPE_TAG_ID = "F4637000000000001";
const Z5_RUNTIME_TYPE_TAG_ID = getRuntimeTypeId(new PrimitiveTypeValue("z5"));
const Z6_RUNTIME_TYPE_TAG_ID = getRuntimeTypeId(new PrimitiveTypeValue("z6"));
const Z7_RUNTIME_TYPE_TAG_ID = getRuntimeTypeId(new PrimitiveTypeValue("z7"));
const IMMEDIATE_RUNTIME_TYPE_TAG_IDS: ReadonlySet<string> = new Set(["bool", "unit", "i5", "i6", "i7", "u5", "u6", "u7"].map((name) => getRuntimeTypeId(new PrimitiveTypeValue(name))));

function scalarTypeRepresentation(typeName: string): BackendValueRepresentation {
    if (typeName === "f5" || typeName === "f6" || typeName === "f7") {
        return "reference";
    }
    if (typeName === "c3" || typeName === "c4" || typeName === "c5") {
        return "reference";
    }
    if (["i5", "i6", "i7", "u5", "u6", "u7", "bool", "unit"].includes(typeName)) {
        return "immediate";
    }
    throw new Error(`Unsupported scalar type '${typeName}'`);
}

function integerValueExpression(typeName: string, expression: string): string {
    switch (typeName) {
        case "i5":
            return `(int32_t)iw_as_i64(${expression})`;
        case "i6":
        case "i7":
            return `(int64_t)iw_as_i64(${expression})`;
        case "u5":
            return `(uint32_t)(uint64_t)iw_as_i64(${expression})`;
        case "u6":
        case "u7":
            return `(uint64_t)iw_as_i64(${expression})`;
        default:
            throw new Error(`Unsupported integer type '${typeName}'`);
    }
}

function integerImmediateExpression(typeName: string, expression: string): string {
    switch (typeName) {
        case "i5":
            return `iw_from_i64((int64_t)(int32_t)(${expression}))`;
        case "i6":
        case "i7":
            return `iw_from_i64((int64_t)(${expression}))`;
        case "u5":
            return `iw_from_i64((int64_t)(uint32_t)(${expression}))`;
        case "u6":
        case "u7":
            return `iw_from_i64((int64_t)(uint64_t)(${expression}))`;
        default:
            throw new Error(`Unsupported integer type '${typeName}'`);
    }
}

const LINUX_C_BUILTIN_ARTIFACTS = buildWindowsCBuiltinArtifacts({
    cTypeForRepresentation,
    scalarTypeRepresentation,
    integerValueExpression,
    integerImmediateExpression,
    runtimeTypeTagLiteral,
    floatRuntimeTypeTagIds: {
        f5: F5_BOXED_RUNTIME_TYPE_TAG_ID,
        f6: F6_BOXED_RUNTIME_TYPE_TAG_ID,
        f7: F7_BOXED_RUNTIME_TYPE_TAG_ID
    },
    complexRuntimeTypeTagIds: {
        z5: Z5_RUNTIME_TYPE_TAG_ID,
        z6: Z6_RUNTIME_TYPE_TAG_ID,
        z7: Z7_RUNTIME_TYPE_TAG_ID
    }
});

const BUILTIN_EMITTERS: ReadonlyMap<string, BuiltinSpec> = LINUX_C_BUILTIN_ARTIFACTS.builtinEmitters;
const BUILTIN_RUNTIME_TYPES: readonly BuiltinRuntimeTypeArtifact[] = LINUX_C_BUILTIN_ARTIFACTS.builtinRuntimeTypes;
const BUILTIN_SHARED_SYSCALL_HELPERS = LINUX_C_BUILTIN_ARTIFACTS.builtinSharedSyscallHelpers;
const BUILTIN_SHARED_THREAD_HELPERS = LINUX_C_BUILTIN_ARTIFACTS.builtinSharedThreadHelpers;
const BUILTIN_HELPERS = LINUX_C_BUILTIN_ARTIFACTS.builtinHelpers;

interface FunctionCodegenContext {
    readonly currentFunction: BackendFunctionIR;
    readonly functionNames: ReadonlySet<string>;
    readonly paramNames: ReadonlySet<string>;
    readonly localNames: ReadonlySet<string>;
    readonly program: ProgramCodegenArtifacts;
}

interface ProgramCodegenArtifacts {
    readonly layouts: ReadonlyMap<string, LoweringClassLayout>;
    readonly globalRepresentations: ReadonlyMap<string, BackendValueRepresentation>;
    readonly functionArities: ReadonlyMap<string, number>;
    readonly functionSignatures: ReadonlyMap<string, FunctionSignatureArtifact>;
    readonly closureHelperApplyArities: ReadonlyMap<string, number>;
    readonly closureCallArities: readonly number[];
    readonly textLiterals: readonly TextLiteralArtifact[];
    readonly directFunctions: readonly DirectFunctionClosureArtifact[];
    readonly closureDescriptors: readonly ClosureDescriptorArtifact[];
    readonly unionMetadata: readonly LoweringUnionMetadata[];
    readonly gcMetadataTables: readonly GcMetadataTableArtifact[];
    readonly gcMetadata: readonly GcMetadataArtifact[];
    readonly gcMetadataByCanonicalName: ReadonlyMap<string, GcMetadataArtifact>;
    readonly gcMetadataByRuntimeTypeTagId: ReadonlyMap<string, GcMetadataArtifact>;
    readonly gcFrameDescriptors: ReadonlyMap<string, GcFrameDescriptorArtifact>;
    readonly gcGlobalDescriptors: readonly GcGlobalDescriptorArtifact[];
}

interface LinkedGcTableExportBinding {
    readonly tableKey: string;
    readonly exportSymbol: string;
}

interface X64NativeSupportOptions {
    readonly omitHostEntryWrapper?: boolean;
    readonly omitRuntimeInit?: boolean;
    readonly entryAsmSymbolOverride?: string;
    readonly sharedGcMetadataTableKeyOverride?: string;
    readonly linkedGcMetadataTableSymbols?: readonly string[];
    readonly linkedGcGlobalTableSymbols?: readonly string[];
    readonly linkedRuntimeInitSymbols?: readonly string[];
    readonly exportedGcMetadataTableSymbols?: readonly LinkedGcTableExportBinding[];
    readonly exportedGcGlobalTableSymbols?: readonly LinkedGcTableExportBinding[];
    readonly exportedRuntimeInitSymbol?: string;
}

interface TextLiteralArtifact {
    readonly typeName: string;
    readonly referenceName: string;
    readonly content: string;
}

interface BoxedNumberLiteralArtifact {
    readonly typeName: "f5" | "f6" | "f7";
    readonly value: number;
    readonly symbol: string;
}

interface GcMetadataTableArtifact {
    readonly key: string;
    readonly symbolName: string;
    readonly displayName: string;
    readonly uuidHiHex: string;
    readonly uuidLoHex: string;
    readonly uuidHash64Hex: string;
    readonly entriesName: string;
    readonly entries: readonly GcMetadataArtifact[];
}

interface GcMetadataArtifact {
    readonly tableKey: string;
    readonly tableSymbolName: string;
    readonly tableDisplayName: string;
    readonly tableUuidHiHex: string;
    readonly tableUuidLoHex: string;
    readonly tableUuidHash64Hex: string;
    readonly structUuidHiHex: string;
    readonly structUuidLoHex: string;
    readonly firstTagHex: string;
    readonly structUuidHash64Hex: string;
    readonly canonicalName: string;
    readonly symbolName: string;
    readonly displayName: string;
    readonly endConfirmationHex: string;
    readonly kind: "heap" | "frame" | "global";
    readonly lengthKind: "none" | "i64" | "u32";
    readonly fixedSizeBytesExpr: string;
    readonly lengthOffsetBytesExpr: string;
    readonly lengthScaleBytesExpr: string;
    readonly lengthBiasBytesExpr: string;
    readonly variableMemberKind: "none" | "value" | "byte";
    readonly variableMemberLabel: string;
    readonly slotCount: number;
    readonly structureOnly: boolean;
    readonly layoutHashHex: string;
    readonly staticInfoHashHex: string;
    readonly runtimeTypeTagId?: string;
}

interface GcFrameDescriptorArtifact {
    readonly key: string;
    readonly structName: string;
    readonly metadataCanonicalName: string;
    readonly rootNames: readonly string[];
}

interface GcGlobalDescriptorArtifact {
    readonly key: string;
    readonly displayName: string;
    readonly metadataTableKey: string;
    readonly payloadStructName: string;
    readonly blockStructName: string;
    readonly blockSymbolName: string;
    readonly tableSymbolName: string;
    readonly refSlotsSymbolName: string;
    readonly livePrinterSymbolName: string;
    readonly initSymbolName: string;
    readonly metadataCanonicalName: string;
    readonly fieldOrder: readonly string[];
}

interface GcMetadataSeedArtifact {
    readonly tableKey: string;
    readonly canonicalName: string;
    readonly displayName: string;
    readonly kind: "heap" | "frame" | "global";
    readonly lengthKind: "none" | "i64" | "u32";
    readonly fixedSizeBytesExpr: string;
    readonly lengthOffsetBytesExpr: string;
    readonly lengthScaleBytesExpr: string;
    readonly lengthBiasBytesExpr: string;
    readonly variableMemberKind?: "none" | "value" | "byte";
    readonly variableMemberLabel?: string;
    readonly slotCount: number;
    readonly structureOnly: boolean;
    readonly layoutHashHex: string;
    readonly runtimeTypeTagId?: string;
}

interface GcMetadataBuildResult {
    readonly tables: readonly GcMetadataTableArtifact[];
    readonly metadata: readonly GcMetadataArtifact[];
}

export interface GcAuthSnapshotTable {
    readonly key: string;
    readonly displayName: string;
    readonly uuidHash64Hex: string;
    readonly entryCount: number;
}

export interface GcAuthSnapshotEntry {
    readonly tableKey: string;
    readonly canonicalName: string;
    readonly kind: "heap" | "frame" | "global";
    readonly firstTagHex: string;
    readonly firstTagStructHash48Hex: string;
    readonly firstTagConfirmation16Hex: string;
    readonly structUuidHash64Hex: string;
    readonly tableUuidHash64Hex: string;
    readonly endConfirmationHex: string;
}

export interface GcAuthSnapshot {
    readonly tables: readonly GcAuthSnapshotTable[];
    readonly entries: readonly GcAuthSnapshotEntry[];
}

function sanitizeIdentifier(name: string): string {
    const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function mangleX64AsmSymbol(symbol: string): string {
    return symbol.replace(/[^A-Za-z0-9_.$]/g, "_");
}

function cFunctionName(symbol: string): string {
    return `iw_fn_${sanitizeIdentifier(symbol)}`;
}

const X64_NATIVE_ENTRY_SYMBOL = "iw_x64_entry";

function cParamName(name: string): string {
    return `iw_param_${sanitizeIdentifier(name)}`;
}

function cLocalName(name: string): string {
    return `iw_local_${sanitizeIdentifier(name)}`;
}

function cGlobalName(name: string): string {
    return `iw_global_${sanitizeIdentifier(name)}`;
}

function utf8ByteLength(text: string): number {
    let byteLength = 0;
    for (const codePointText of text) {
        const codePoint = codePointText.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }
        if (codePoint <= 0x7f) {
            byteLength += 1;
        } else if (codePoint <= 0x7ff) {
            byteLength += 2;
        } else if (codePoint <= 0xffff) {
            byteLength += 3;
        } else {
            byteLength += 4;
        }
    }
    return byteLength;
}

function cGcMetadataName(canonicalName: string): string {
    return `iw_gc_metadata_${sanitizeIdentifier(canonicalName)}`;
}

const BUILTIN_GC_METADATA_TABLE_KEY = "builtin";
const SHARED_GC_METADATA_TABLE_KEY = "shared-generated";

function gcUnitMetadataTableKey(unitId: string): string {
    return `unit:${unitId}`;
}

function gcMetadataTableDisplayName(key: string): string {
    if (key === BUILTIN_GC_METADATA_TABLE_KEY) {
        return BUILTIN_GC_METADATA_TABLE_KEY;
    }
    if (key === SHARED_GC_METADATA_TABLE_KEY) {
        return SHARED_GC_METADATA_TABLE_KEY;
    }
    return key.startsWith("unit:") ? key.slice("unit:".length) : key;
}

function cGcMetadataTableName(key: string): string {
    return `iw_gc_metadata_table_${sanitizeIdentifier(key)}`;
}

function cGcMetadataEntriesName(key: string): string {
    return `iw_gc_metadata_entries_${sanitizeIdentifier(key)}`;
}

function cGcFrameStructName(key: string): string {
    return `iw_gc_frame_${sanitizeIdentifier(key)}`;
}

function cGcGlobalPayloadName(key: string): string {
    return `iw_gc_global_payload_${sanitizeIdentifier(key)}_t`;
}

function cGcGlobalBlockName(key: string): string {
    return `iw_gc_global_block_${sanitizeIdentifier(key)}_t`;
}

function cGcGlobalBlockVarName(key: string): string {
    return `iw_gc_global_block_${sanitizeIdentifier(key)}`;
}

function cGcGlobalTableName(key: string): string {
    return `iw_gc_global_table_${sanitizeIdentifier(key)}`;
}

function cGcGlobalRefSlotsName(key: string): string {
    return `iw_gc_global_ref_slots_${sanitizeIdentifier(key)}`;
}

function cGcGlobalLivePrinterName(key: string): string {
    return `iw_gc_print_live_global_block_${sanitizeIdentifier(key)}`;
}

function cGcGlobalInitName(key: string): string {
    return `iw_init_gc_global_block_${sanitizeIdentifier(key)}`;
}

function gcFrameKey(rootNames: readonly string[]): string {
    const canonicalRootNames = [...rootNames].sort((left, right) => left.localeCompare(right));
    return `${canonicalRootNames.length}_${hashText(canonicalRootNames.join("|"))}`;
}

function gcDeterministicHex(namespace: string, seed: string): string {
    return hashText(`${namespace}<${seed}>`);
}

function gcLayoutHashHex(canonicalName: string, parts: readonly string[]): string {
    return hashText(`${canonicalName}<${parts.join("|")}>`);
}

const U64_MASK = 0xffffffffffffffffn;
const GC_HASH_COMBINE_CONST = 0x9e3779b97f4a7c15n;
const GC_TAG1_CONFIRMATION_SEED = 0xa5c9d3e17b2f0461n;
const GC_END_CONFIRMATION_SEED = 0x6a09e667f3bcc909n;

function hexToBigInt(hex: string): bigint {
    return BigInt(`0x${hex}`);
}

function u64BigIntToHex(value: bigint): string {
    return (value & U64_MASK).toString(16).padStart(16, "0");
}

function mixU64BigInt(value: bigint): bigint {
    let mixed = value & U64_MASK;
    mixed ^= mixed >> 33n;
    mixed = (mixed * 0xff51afd7ed558ccdn) & U64_MASK;
    mixed ^= mixed >> 33n;
    mixed = (mixed * 0xc4ceb9fe1a85ec53n) & U64_MASK;
    mixed ^= mixed >> 33n;
    return mixed & U64_MASK;
}

function combineU64BigInt(state: bigint, word: bigint): bigint {
    return mixU64BigInt((state ^ word ^ GC_HASH_COMBINE_CONST) & U64_MASK);
}

function gcMetadataTableUuidHiHex(key: string): string {
    return gcDeterministicHex("gc-metadata-table-uuid-hi", key);
}

function gcMetadataTableUuidLoHex(key: string): string {
    return gcDeterministicHex("gc-metadata-table-uuid-lo", key);
}

function gcMetadataTableUuidHash64Hex(tableUuidHiHex: string, tableUuidLoHex: string): string {
    return gcDeterministicHex("gc-metadata-table-uuid-h64", `${tableUuidHiHex}|${tableUuidLoHex}`);
}

function gcMetadataStructUuidHiHex(tableKey: string, canonicalName: string): string {
    return gcDeterministicHex("gc-struct-uuid-hi", `${tableKey}|${canonicalName}`);
}

function gcMetadataStructUuidLoHex(tableKey: string, canonicalName: string): string {
    return gcDeterministicHex("gc-struct-uuid-lo", `${tableKey}|${canonicalName}`);
}

function gcMetadataStructHash48Hex(structUuidHiHex: string, structUuidLoHex: string): string {
    return gcDeterministicHex("gc-struct-uuid-h48", `${structUuidHiHex}|${structUuidLoHex}`).slice(0, 12);
}

function gcMetadataStructHash64Hex(structUuidHiHex: string, structUuidLoHex: string): string {
    return gcDeterministicHex("gc-struct-uuid-h64", `${structUuidHiHex}|${structUuidLoHex}`);
}

function gcMetadataFirstTagConfirmation16Hex(structHash48Hex: string): string {
    const confirmation = mixU64BigInt(hexToBigInt(structHash48Hex) ^ GC_TAG1_CONFIRMATION_SEED) & 0xffffn;
    return confirmation.toString(16).padStart(4, "0");
}

function gcMetadataFirstTagHex(structUuidHiHex: string, structUuidLoHex: string): string {
    const structHash48Hex = gcMetadataStructHash48Hex(structUuidHiHex, structUuidLoHex);
    return `${structHash48Hex}${gcMetadataFirstTagConfirmation16Hex(structHash48Hex)}`;
}

function gcMetadataStaticInfoHashHex(seedArtifact: GcMetadataSeedArtifact): string {
    return gcDeterministicHex(
        "gc-struct-static-info",
        [
            seedArtifact.canonicalName,
            seedArtifact.kind,
            seedArtifact.lengthKind,
            seedArtifact.fixedSizeBytesExpr,
            seedArtifact.lengthOffsetBytesExpr,
            seedArtifact.lengthScaleBytesExpr,
            seedArtifact.lengthBiasBytesExpr,
            seedArtifact.variableMemberKind ?? "none",
            seedArtifact.variableMemberLabel ?? "",
            String(seedArtifact.slotCount),
            seedArtifact.structureOnly ? "1" : "0",
            seedArtifact.layoutHashHex
        ].join("|")
    );
}

function ensureUniqueGcMetadataValue(
    seen: Map<string, string>,
    value: string,
    owner: string,
    label: string
): void {
    const previousOwner = seen.get(value);
    if (previousOwner !== undefined) {
        throw new Error(`GC metadata ${label} '${value}' is reused by ${owner}; first used by ${previousOwner}`);
    }
    seen.set(value, owner);
}

function gcEndConfirmationDeterministicHex(
    structUuidHiHex: string,
    structUuidLoHex: string,
    staticInfoHashHex: string
): string {
    let state = GC_END_CONFIRMATION_SEED;
    state = combineU64BigInt(state, hexToBigInt(structUuidHiHex));
    state = combineU64BigInt(state, hexToBigInt(structUuidLoHex));
    state = combineU64BigInt(state, hexToBigInt(staticInfoHashHex));
    return u64BigIntToHex(state);
}

function u64HexLiteral(hex: string): string {
    return `0x${hex.toLowerCase()}ULL`;
}

function gcMetadataRefLiteral(metadata: GcMetadataArtifact): string {
    return `{ ${u64HexLiteral(metadata.firstTagHex)}, ${u64HexLiteral(metadata.endConfirmationHex)} }`;
}

function alignUp(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function backendRepresentationSizeBytes(representation: BackendValueRepresentation): number {
    void representation;
    return 8;
}

function backendRepresentationAlignmentBytes(representation: BackendValueRepresentation): number {
    void representation;
    return 8;
}

function gcGlobalBlockSizeBytes(
    globalDescriptor: GcGlobalDescriptorArtifact,
    globalRepresentations: ReadonlyMap<string, BackendValueRepresentation>
): number {
    const fieldRepresentations = globalDescriptor.fieldOrder.length === 0
        ? ["reference" as const]
        : globalDescriptor.fieldOrder.map((fieldName) => globalRepresentations.get(fieldName) ?? "reference");
    let payloadSize = 0;
    let payloadAlignment = 1;
    for (const representation of fieldRepresentations) {
        const alignment = backendRepresentationAlignmentBytes(representation);
        payloadSize = alignUp(payloadSize, alignment);
        payloadSize += backendRepresentationSizeBytes(representation);
        payloadAlignment = Math.max(payloadAlignment, alignment);
    }
    payloadSize = alignUp(payloadSize, payloadAlignment);
    return alignUp(8 + payloadSize, 8) + 8;
}

function gcGlobalFieldOffsetMap(
    globalDescriptor: GcGlobalDescriptorArtifact,
    globalRepresentations: ReadonlyMap<string, BackendValueRepresentation>
): ReadonlyMap<string, number> {
    const offsets = new Map<string, number>();
    let payloadOffset = 0;
    for (const fieldName of globalDescriptor.fieldOrder) {
        const representation = globalRepresentations.get(fieldName) ?? "reference";
        payloadOffset = alignUp(payloadOffset, backendRepresentationAlignmentBytes(representation));
        offsets.set(fieldName, 8 + payloadOffset);
        payloadOffset += backendRepresentationSizeBytes(representation);
    }
    return offsets;
}

function buildWindowsCHostInteropDependencies(
    emitStandaloneGcScopedBlock: (rootNames: readonly string[], bodyLines: readonly string[], indentLevel: number) => string
) {
    return {
        builtinSharedSyscallHelpers: BUILTIN_SHARED_SYSCALL_HELPERS,
        builtinSharedThreadHelpers: BUILTIN_SHARED_THREAD_HELPERS,
        cFunctionName,
        cParamName,
        cStringLiteral,
        cTypeForRepresentation,
        cZeroValueForRepresentation,
        emitStandaloneGcScopedBlock,
        integerImmediateExpression,
        integerValueExpression,
        representationFromTypeValue
    };
}

function generateCHeaderFromFinalBackendIR(program: FinalBackendIRProgram): string {
    return generateWindowsCHeaderFromFinalBackendIR(program);
}

export interface CBackendSources {
    readonly headerSource: string;
    readonly runtimeSource: string;
    readonly driverSource: string;
}

function cStructName(className: string): string {
    return `iw_obj_${sanitizeIdentifier(className)}`;
}

function cFieldName(fieldName: string): string {
    return `iw_field_${sanitizeIdentifier(fieldName)}`;
}

function cCastHelperName(className: string): string {
    return `iw_cast_${sanitizeIdentifier(className)}`;
}

function cAllocHelperName(className: string): string {
    return `iw_alloc_${sanitizeIdentifier(className)}`;
}

function cClosureTargetName(symbol: string): string {
    return `iw_closure_target_${sanitizeIdentifier(symbol)}`;
}

function cClosureMakerName(closureId: string): string {
    return `iw_make_${sanitizeIdentifier(closureId)}`;
}

function cTextBytesName(referenceName: string): string {
    return `iw_text_bytes_${sanitizeIdentifier(referenceName)}`;
}

function cTextValueName(referenceName: string): string {
    return `iw_text_value_${sanitizeIdentifier(referenceName)}`;
}

function cTypeInfoName(tagOrName: string): string {
    return `iw_typeinfo_${sanitizeIdentifier(tagOrName)}`;
}

function cSlotsName(name: string): string {
    return `iw_slots_${sanitizeIdentifier(name)}`;
}

function cUnionMembersName(name: string): string {
    return `iw_union_members_${sanitizeIdentifier(name)}`;
}

function cMethodsName(name: string): string {
    return `iw_methods_${sanitizeIdentifier(name)}`;
}

function formatFloatingLiteral(value: number, suffix: string): string {
    if (Number.isInteger(value)) {
        return `${value}.0${suffix}`;
    }
    return `${String(value)}${suffix}`;
}

function formatNumberLiteral(value: number, typeName: string): string {
    switch (typeName) {
        case "i5":
        case "i6":
        case "i7":
        case "u5":
        case "u6":
        case "u7":
            return integerImmediateExpression(typeName, `${value}LL`);
        case "f5":
            return `iw_from_f32(${formatFloatingLiteral(value, "f")})`;
        case "f6":
            return `iw_from_f64(${formatFloatingLiteral(value, "")})`;
        case "f7":
            return `iw_from_f128(${formatFloatingLiteral(value, "L")})`;
        default:
            throw new Error(`C backend encountered unsupported numeric literal type '${typeName}'`);
    }
}

function escapeCString(text: string): string {
    const characters: readonly string[] = Array.from(text);
    let result: string = "";
    for (const character of characters) {
        if (character === "\\") {
            result += "\\\\";
            continue;
        }
        if (character === '"') {
            result += '\\"';
            continue;
        }
        if (character === "\n") {
            result += "\\n";
            continue;
        }
        if (character === "\r") {
            result += "\\r";
            continue;
        }
        if (character === "\t") {
            result += "\\t";
            continue;
        }

        const codePoint: number | undefined = character.codePointAt(0);
        if (codePoint === undefined) {
            throw new Error("C backend encountered an empty character while escaping a C string literal");
        }
        if (codePoint < 0x20 || codePoint === 0x7f) {
            result += `\\${codePoint.toString(8).padStart(3, "0")}`;
            continue;
        }
        result += character;
    }
    return result;
}

function cStringLiteral(text: string): string {
    return `\"${escapeCString(text)}\"`;
}

function runtimeTypeTagLiteral(runtimeTypeTagId: string): string {
    return `0x${runtimeTypeTagId.slice(1)}ULL`;
}

function closureRuntimeTypeTagId(name: string): string {
    return `L${hashText(`Closure<${name}>`)}`;
}

function representationFromTypeValue(type: TypeValue): BackendValueRepresentation {
    if (type instanceof PrimitiveTypeValue) {
        if (["bool", "unit", "i5", "i6", "i7", "u5", "u6", "u7"].includes(type.name)) {
            return "immediate";
        }
    }
    return "reference";
}

function cTypeForRepresentation(representation: BackendValueRepresentation): string {
    void representation;
    return "iw_value_t";
}

function cZeroValueForRepresentation(representation: BackendValueRepresentation): string {
    void representation;
    return "0";
}

function getBindingRepresentation(name: string, context: FunctionCodegenContext): BackendValueRepresentation {
    return context.currentFunction.bindingRepresentations.get(name)
        ?? context.program.globalRepresentations.get(name)
        ?? "reference";
}

function getOperandRepresentation(operand: LinearOperand, context: FunctionCodegenContext): BackendValueRepresentation {
    switch (operand.kind) {
        case "local":
            if (resolveScopedLocal(operand.name, context)) {
                return getBindingRepresentation(operand.name, context);
            }
            if (context.program.globalRepresentations.has(operand.name)) {
                return context.program.globalRepresentations.get(operand.name) ?? "reference";
            }
            return context.program.functionArities.has(operand.name) ? "reference" : "reference";
        case "number_literal":
            return operand.typeName === "i5" ? "immediate" : "reference";
        case "text_literal":
            return "reference";
        case "direct_function":
            return "reference";
    }
}

function convertExpressionRepresentation(
    expression: string,
    from: BackendValueRepresentation,
    to: BackendValueRepresentation,
    usageContext: string
): string {
    void from;
    void to;
    void usageContext;
    return expression;
}

function builtinSignature(symbol: string, arity: number): FunctionSignatureArtifact {
    const scalarConversionMatch = symbol.match(/^iw_(?:ty|bin)_to_([a-z][0-9])_([a-z][0-9])$/i);
    if (scalarConversionMatch) {
        const [, targetTypeName, sourceTypeName] = scalarConversionMatch;
        return {
            paramRepresentations: [scalarTypeRepresentation(sourceTypeName)],
            resultRepresentation: scalarTypeRepresentation(targetTypeName)
        };
    }
    if (symbol === "iw_z5_rect") {
        return { paramRepresentations: ["reference", "reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_z6_rect") {
        return { paramRepresentations: ["reference", "reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_z7_rect") {
        return { paramRepresentations: ["reference", "reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_zreal_z5" || symbol === "iw_zimg_z5" || symbol === "iw_zabs_z5" || symbol === "iw_zarg_z5") {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_zreal_z6" || symbol === "iw_zimg_z6" || symbol === "iw_zabs_z6" || symbol === "iw_zarg_z6") {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_zreal_z7" || symbol === "iw_zimg_z7" || symbol === "iw_zabs_z7" || symbol === "iw_zarg_z7") {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (
        symbol === "iw_zconj_z5" || symbol === "iw_zproj_z5" || symbol === "iw_zexp_z5" || symbol === "iw_zlog_z5" || symbol === "iw_zsqrt_z5"
        || symbol === "iw_zconj_z6" || symbol === "iw_zproj_z6" || symbol === "iw_zexp_z6" || symbol === "iw_zlog_z6" || symbol === "iw_zsqrt_z6"
        || symbol === "iw_zconj_z7" || symbol === "iw_zproj_z7" || symbol === "iw_zexp_z7" || symbol === "iw_zlog_z7" || symbol === "iw_zsqrt_z7"
    ) {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_zpow_z5" || symbol === "iw_zpow_z6" || symbol === "iw_zpow_z7") {
        return { paramRepresentations: ["reference", "reference"], resultRepresentation: "reference" };
    }
    if (
        symbol === "s3_new_copy" || symbol === "s4_new_copy" || symbol === "s5_new_copy"
        || symbol === "s3_get" || symbol === "s4_get" || symbol === "s5_get"
    ) {
        return symbol.endsWith("_get")
            ? { paramRepresentations: ["reference", "immediate"], resultRepresentation: "reference" }
            : { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (symbol === "s3_set" || symbol === "s4_set" || symbol === "s5_set") {
        return { paramRepresentations: ["reference", "immediate", "reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "s3_new_fill" || symbol === "s4_new_fill" || symbol === "s5_new_fill") {
        return { paramRepresentations: ["immediate", "reference"], resultRepresentation: "reference" };
    }
    if (symbol === "s3_length" || symbol === "s4_length" || symbol === "s5_length") {
        return { paramRepresentations: ["reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "z5_new" || symbol === "z6_new" || symbol === "z7_new") {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (symbol === "z5_set_value" || symbol === "z6_set_value" || symbol === "z7_set_value") {
        return { paramRepresentations: ["reference", "reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "z5_set_parts") {
        return { paramRepresentations: ["reference", "reference", "reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "z6_set_parts" || symbol === "z7_set_parts") {
        return { paramRepresentations: ["reference", "reference", "reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "z5_real" || symbol === "z5_img") {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (symbol === "z6_real" || symbol === "z6_img" || symbol === "z7_real" || symbol === "z7_img") {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_i5_to_f5") {
        return { paramRepresentations: ["immediate"], resultRepresentation: "reference" };
    }
    if (
        symbol === "iw_stdout_write_s3"
        || symbol === "iw_stdout_write_s4"
        || symbol === "iw_stdout_write_s5"
        || symbol === "iw_stdout_println_s3"
        || symbol === "iw_stdout_println_s4"
        || symbol === "iw_stdout_println_s5"
        || symbol === "iw_stderr_write_s3"
        || symbol === "iw_stderr_write_s4"
        || symbol === "iw_stderr_write_s5"
        || symbol === "iw_stderr_println_s3"
        || symbol === "iw_stderr_println_s4"
        || symbol === "iw_stderr_println_s5"
    ) {
        return { paramRepresentations: ["reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "iw_stdout_flush" || symbol === "iw_stderr_flush") {
        return { paramRepresentations: [], resultRepresentation: "immediate" };
    }
    if (symbol === "iw_gc_collect") {
        return { paramRepresentations: [], resultRepresentation: "immediate" };
    }
    if (
        symbol === "iw_round_f5"
        || symbol === "iw_floor_f5"
        || symbol === "iw_ceil_f5"
        || symbol === "iw_trunc_f5"
    ) {
        return { paramRepresentations: ["reference"], resultRepresentation: "immediate" };
    }
    if (
        symbol === "iw_round_f6"
        || symbol === "iw_round_f7"
        || symbol === "iw_floor_f6"
        || symbol === "iw_floor_f7"
        || symbol === "iw_ceil_f6"
        || symbol === "iw_ceil_f7"
        || symbol === "iw_trunc_f6"
        || symbol === "iw_trunc_f7"
    ) {
        return { paramRepresentations: ["reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "iw_sin_f5" || symbol === "iw_cos_f5" || symbol === "iw_sqrt_f5") {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (
        symbol === "iw_sin_f6"
        || symbol === "iw_sin_f7"
        || symbol === "iw_cos_f6"
        || symbol === "iw_cos_f7"
        || symbol === "iw_sqrt_f6"
        || symbol === "iw_sqrt_f7"
    ) {
        return { paramRepresentations: ["reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_atan2_f5") {
        return { paramRepresentations: ["reference", "reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_atan2_f6" || symbol === "iw_atan2_f7") {
        return { paramRepresentations: ["reference", "reference"], resultRepresentation: "reference" };
    }
    if (symbol === "iw_stdin_read_f5") {
        return { paramRepresentations: [], resultRepresentation: "reference" };
    }
    if (symbol === "iw_stdout_write_f5_ascii" || symbol === "iw_stderr_write_f5_ascii") {
        return { paramRepresentations: ["reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "iw_file_write_f5_ascii") {
        return { paramRepresentations: ["immediate", "reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "not") {
        return { paramRepresentations: ["immediate"], resultRepresentation: "immediate" };
    }
    if (symbol === "and" || symbol === "or" || symbol === "xor") {
        return { paramRepresentations: ["immediate", "immediate"], resultRepresentation: "immediate" };
    }
    if (symbol === "array_new") {
        return { paramRepresentations: ["immediate", "reference"], resultRepresentation: "reference" };
    }
    if (symbol === "array_get") {
        return { paramRepresentations: ["reference", "immediate"], resultRepresentation: "reference" };
    }
    if (symbol === "array_set") {
        return { paramRepresentations: ["reference", "immediate", "reference"], resultRepresentation: "immediate" };
    }
    if (symbol === "array_length") {
        return { paramRepresentations: ["reference"], resultRepresentation: "immediate" };
    }
    const numericBuiltinMatch = symbol.match(/^__iw_builtin_([a-z]+)_([a-z][0-9])$/i);
    if (numericBuiltinMatch) {
        const [, op, typeName] = numericBuiltinMatch;
        const isComparison = INTEGER_COMPARISON_BUILTINS.includes(op as typeof INTEGER_COMPARISON_BUILTINS[number]);
        const isFloatToI5Unary = FLOAT_TO_I5_UNARY_BUILTINS.includes(op as typeof FLOAT_TO_I5_UNARY_BUILTINS[number]);
        if (INTEGER_TYPE_NAMES.includes(typeName as typeof INTEGER_TYPE_NAMES[number])) {
            return {
                paramRepresentations: Array.from({ length: arity }, () => "immediate"),
                resultRepresentation: isComparison ? "immediate" : "immediate"
            };
        }
        if (typeName === "f5") {
            return {
                paramRepresentations: Array.from({ length: arity }, () => "reference"),
                resultRepresentation: isComparison || isFloatToI5Unary ? "immediate" : "reference"
            };
        }
        if (typeName === "f6" || typeName === "f7") {
            return {
                paramRepresentations: Array.from({ length: arity }, () => "reference"),
                resultRepresentation: isComparison || isFloatToI5Unary ? "immediate" : "reference"
            };
        }
        if (CHARACTER_TYPE_NAMES.includes(typeName as typeof CHARACTER_TYPE_NAMES[number])) {
            return {
                paramRepresentations: Array.from({ length: arity }, () => "reference"),
                resultRepresentation: "immediate"
            };
        }
    }
    return { paramRepresentations: Array.from({ length: arity }, () => "reference"), resultRepresentation: "reference" };
}

function resolveScopedLocal(name: string, context: FunctionCodegenContext): string | undefined {
    if (context.paramNames.has(name)) {
        return cParamName(name);
    }
    if (context.localNames.has(name)) {
        return cLocalName(name);
    }
    return undefined;
}

function getClassLayout(className: string, context: FunctionCodegenContext, usageContext: string): LoweringClassLayout {
    const layout = context.program.layouts.get(className);
    if (!layout) {
        throw new Error(`C backend encountered missing class layout for '${className}' in ${usageContext}`);
    }
    return layout;
}

function getGcMetadataByCanonicalName(canonicalName: string, context: FunctionCodegenContext, usageContext: string): GcMetadataArtifact {
    const metadata = context.program.gcMetadataByCanonicalName.get(canonicalName);
    if (!metadata) {
        throw new Error(`C backend encountered missing GC metadata '${canonicalName}' in ${usageContext}`);
    }
    return metadata;
}

function getGcFrameDescriptor(rootNames: readonly string[], context: FunctionCodegenContext, usageContext: string): GcFrameDescriptorArtifact {
    const descriptor = context.program.gcFrameDescriptors.get(gcFrameKey(rootNames));
    if (!descriptor) {
        throw new Error(`C backend encountered missing GC frame descriptor for roots [${rootNames.join(", ")}] in ${usageContext}`);
    }
    return descriptor;
}

function buildSyntheticClosureLayout(helper: ClosureHelperDefinition): LoweringClassLayout {
    return {
        className: helper.environmentLayout,
        runtimeTypeTagId: getClassTypeId(helper.environmentLayout),
        propertyOrder: helper.captureOrder,
        propertyTypes: new Map(helper.captureOrder.map((captureName) => {
            const captureType = helper.captureTypes.get(captureName);
            if (!captureType) {
                throw new Error(`C backend encountered missing capture type for '${helper.closureId}.${captureName}'`);
            }
            return [captureName, captureType] as const;
        })),
        methodOrder: [],
        methodTypes: new Map(),
        methodSymbols: new Map(),
        constructors: [{
            symbol: `${helper.environmentLayout}_ctor`,
            paramTypes: []
        }]
    };
}

function buildEffectiveLayouts(program: FinalBackendIRProgram, extraLayouts?: ReadonlyMap<string, LoweringClassLayout>): ReadonlyMap<string, LoweringClassLayout> {
    const layouts = new Map<string, LoweringClassLayout>(program.layouts.classes);
    if (extraLayouts) {
        for (const [className, layout] of extraLayouts.entries()) {
            if (!layouts.has(className)) {
                layouts.set(className, layout);
            }
        }
    }
    for (const helper of program.closureHelpers) {
        if (!layouts.has(helper.environmentLayout)) {
            layouts.set(helper.environmentLayout, buildSyntheticClosureLayout(helper));
        }
    }
    return layouts;
}

function buildFunctionArityTable(program: FinalBackendIRProgram): ReadonlyMap<string, number> {
    const arities = new Map<string, number>();
    for (const [symbol, builtin] of BUILTIN_EMITTERS.entries()) {
        arities.set(symbol, builtin.arity);
    }
    for (const fn of [program.entry, ...program.functions]) {
        arities.set(fn.symbol, fn.params.length);
    }
    for (const fn of program.externFunctions) {
        arities.set(fn.symbol, fn.params.length);
    }
    return arities;
}

function resolveBuiltinEmitterSymbol(symbol: string): string {
    const parsed = parseDeclaredCFunctionName(symbol);
    if (parsed !== null && BUILTIN_EMITTERS.has(parsed.functionName)) {
        return parsed.functionName;
    }
    return symbol;
}

function hasBuiltinEmitterSymbol(symbol: string): boolean {
    return BUILTIN_EMITTERS.has(resolveBuiltinEmitterSymbol(symbol));
}

function buildFunctionSignatureTable(program: FinalBackendIRProgram, functionArities: ReadonlyMap<string, number>): ReadonlyMap<string, FunctionSignatureArtifact> {
    const signatures = new Map<string, FunctionSignatureArtifact>();
    for (const [symbol, arity] of functionArities.entries()) {
        const builtinSymbol = resolveBuiltinEmitterSymbol(symbol);
        if (BUILTIN_EMITTERS.has(builtinSymbol)) {
            signatures.set(symbol, builtinSignature(builtinSymbol, arity));
        }
    }
    for (const fn of [program.entry, ...program.functions]) {
        signatures.set(fn.symbol, {
            paramRepresentations: fn.params.map((param) => fn.bindingRepresentations.get(param) ?? "reference"),
            resultRepresentation: fn.resultRepresentation
        });
    }
    for (const fn of program.externFunctions) {
        if (hasBuiltinEmitterSymbol(fn.symbol)) {
            continue;
        }
        signatures.set(fn.symbol, {
            paramRepresentations: fn.paramRepresentations,
            resultRepresentation: fn.resultRepresentation
        });
    }
    return signatures;
}

function buildClosureHelperApplyArities(program: FinalBackendIRProgram): ReadonlyMap<string, number> {
    const helperFunctions = new Map(program.functions.map((fn) => [fn.symbol, fn]));
    const arities = new Map<string, number>();
    for (const helper of program.closureHelpers) {
        const applyFn = helperFunctions.get(helper.applySymbol);
        if (!applyFn) {
            throw new Error(`C backend expected closure helper apply function '${helper.applySymbol}' to exist`);
        }
        if (applyFn.params.length < 1) {
            throw new Error(`C backend expected closure helper '${helper.applySymbol}' to accept an environment parameter`);
        }
        arities.set(helper.applySymbol, applyFn.params.length - 1);
    }
    return arities;
}

function collectLinearOperandDirectFunctions(operand: LinearOperand, sink: Set<string>): void {
    if (operand.kind === "direct_function") {
        sink.add(operand.symbol);
    }
}

function collectLinearOperandTextLiterals(operand: LinearOperand, sink: Map<string, TextLiteralArtifact>): void {
    if (operand.kind === "text_literal") {
        sink.set(operand.referenceName, {
            typeName: operand.typeName,
            referenceName: operand.referenceName,
            content: operand.content
        });
    }
}

function collectLinearOperandX64BoxedNumberLiterals(operand: LinearOperand, sink: Map<string, BoxedNumberLiteralArtifact>): void {
    if (operand.kind === "number_literal" && (operand.typeName === "f5" || operand.typeName === "f6" || operand.typeName === "f7")) {
        const symbol = x64NativeBoxedNumberValueSymbol(operand.typeName, operand.value);
        sink.set(symbol, {
            typeName: operand.typeName,
            value: operand.value,
            symbol
        });
    }
}

function collectLinearStatementInfo(statements: readonly LinearStatement[], closureCallArities: Set<number>, directFunctions: Set<string>, textLiterals: Map<string, TextLiteralArtifact>): void {
    for (const statement of statements) {
        switch (statement.kind) {
            case "assign":
                collectLinearRvalueInfo(statement.value, closureCallArities, directFunctions, textLiterals);
                break;
            case "set_local":
                collectLinearOperandDirectFunctions(statement.value, directFunctions);
                collectLinearOperandTextLiterals(statement.value, textLiterals);
                break;
            case "object_set_field":
                collectLinearOperandDirectFunctions(statement.receiver, directFunctions);
                collectLinearOperandTextLiterals(statement.receiver, textLiterals);
                collectLinearOperandDirectFunctions(statement.value, directFunctions);
                collectLinearOperandTextLiterals(statement.value, textLiterals);
                break;
            case "if":
                collectLinearOperandDirectFunctions(statement.cond, directFunctions);
                collectLinearOperandTextLiterals(statement.cond, textLiterals);
                collectLinearStatementInfo(statement.thenStatements, closureCallArities, directFunctions, textLiterals);
                collectLinearStatementInfo(statement.elseStatements, closureCallArities, directFunctions, textLiterals);
                break;
        }
    }
}

function collectLinearStatementX64BoxedNumberLiterals(statements: readonly LinearStatement[], sink: Map<string, BoxedNumberLiteralArtifact>): void {
    for (const statement of statements) {
        switch (statement.kind) {
            case "assign":
                collectLinearRvalueX64BoxedNumberLiterals(statement.value, sink);
                break;
            case "set_local":
                collectLinearOperandX64BoxedNumberLiterals(statement.value, sink);
                break;
            case "object_set_field":
                collectLinearOperandX64BoxedNumberLiterals(statement.receiver, sink);
                collectLinearOperandX64BoxedNumberLiterals(statement.value, sink);
                break;
            case "if":
                collectLinearOperandX64BoxedNumberLiterals(statement.cond, sink);
                collectLinearStatementX64BoxedNumberLiterals(statement.thenStatements, sink);
                collectLinearStatementX64BoxedNumberLiterals(statement.elseStatements, sink);
                break;
        }
    }
}

function collectLinearRvalueInfo(rvalue: LinearRvalue, closureCallArities: Set<number>, directFunctions: Set<string>, textLiterals: Map<string, TextLiteralArtifact>): void {
    switch (rvalue.kind) {
        case "copy":
            collectLinearOperandDirectFunctions(rvalue.value, directFunctions);
            collectLinearOperandTextLiterals(rvalue.value, textLiterals);
            return;
        case "object_get_field":
            collectLinearOperandDirectFunctions(rvalue.receiver, directFunctions);
            collectLinearOperandTextLiterals(rvalue.receiver, textLiterals);
            return;
        case "union_inject":
            collectLinearOperandDirectFunctions(rvalue.value, directFunctions);
            collectLinearOperandTextLiterals(rvalue.value, textLiterals);
            return;
        case "union_has_tag":
        case "union_get_payload":
            collectLinearOperandDirectFunctions(rvalue.unionValue, directFunctions);
            collectLinearOperandTextLiterals(rvalue.unionValue, textLiterals);
            return;
        case "direct_call":
            rvalue.args.forEach((arg) => {
                collectLinearOperandDirectFunctions(arg, directFunctions);
                collectLinearOperandTextLiterals(arg, textLiterals);
            });
            return;
        case "closure_create":
            rvalue.captures.forEach((capture) => {
                collectLinearOperandDirectFunctions(capture, directFunctions);
                collectLinearOperandTextLiterals(capture, textLiterals);
            });
            return;
        case "closure_call":
            closureCallArities.add(rvalue.args.length);
            collectLinearOperandDirectFunctions(rvalue.callee, directFunctions);
            collectLinearOperandTextLiterals(rvalue.callee, textLiterals);
            rvalue.args.forEach((arg) => {
                collectLinearOperandDirectFunctions(arg, directFunctions);
                collectLinearOperandTextLiterals(arg, textLiterals);
            });
            return;
        case "object_alloc":
            return;
    }
}

function collectLinearRvalueX64BoxedNumberLiterals(rvalue: LinearRvalue, sink: Map<string, BoxedNumberLiteralArtifact>): void {
    switch (rvalue.kind) {
        case "copy":
            collectLinearOperandX64BoxedNumberLiterals(rvalue.value, sink);
            return;
        case "object_get_field":
            collectLinearOperandX64BoxedNumberLiterals(rvalue.receiver, sink);
            return;
        case "union_inject":
            collectLinearOperandX64BoxedNumberLiterals(rvalue.value, sink);
            return;
        case "union_has_tag":
        case "union_get_payload":
            collectLinearOperandX64BoxedNumberLiterals(rvalue.unionValue, sink);
            return;
        case "direct_call":
            rvalue.args.forEach((arg) => collectLinearOperandX64BoxedNumberLiterals(arg, sink));
            return;
        case "closure_create":
            rvalue.captures.forEach((capture) => collectLinearOperandX64BoxedNumberLiterals(capture, sink));
            return;
        case "closure_call":
            collectLinearOperandX64BoxedNumberLiterals(rvalue.callee, sink);
            rvalue.args.forEach((arg) => collectLinearOperandX64BoxedNumberLiterals(arg, sink));
            return;
        case "object_alloc":
            return;
    }
}

function collectX64BoxedNumberLiterals(program: FinalBackendIRProgram): readonly BoxedNumberLiteralArtifact[] {
    const sink = new Map<string, BoxedNumberLiteralArtifact>();
    [program.entry, ...program.functions].forEach((fn) => {
        collectLinearStatementX64BoxedNumberLiterals(fn.statements, sink);
        collectLinearOperandX64BoxedNumberLiterals(fn.result, sink);
    });
    return Array.from(sink.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function collectX64BoxedNumberLiteralsFromAssembly(assemblyText: string): readonly BoxedNumberLiteralArtifact[] {
    const sink = new Map<string, BoxedNumberLiteralArtifact>();
    const pattern = /__iw_x64_direct_value_num_(f5|f6|f7)_([A-Za-z0-9_]+)/g;
    for (const match of assemblyText.matchAll(pattern)) {
        const typeName = match[1] as "f5" | "f6" | "f7";
        const symbol = match[0];
        const decodedValue = Number(decodeX64NumericLiteralSymbolPart(match[2]));
        if (!Number.isFinite(decodedValue)) {
            throw new Error(`C backend encountered invalid x64 boxed number literal symbol '${symbol}'`);
        }
        sink.set(symbol, {
            typeName,
            value: decodedValue,
            symbol
        });
    }
    return Array.from(sink.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function buildDirectFunctionArtifacts(functionArities: ReadonlyMap<string, number>, reachableDirectFunctions: ReadonlySet<string>): readonly DirectFunctionClosureArtifact[] {
    return Array.from(functionArities.entries())
        .filter(([symbol]) => reachableDirectFunctions.has(symbol))
        .map(([symbol, arity]) => ({ symbol, arity }))
        .sort((left, right) => left.symbol.localeCompare(right.symbol))
        .map(({ symbol, arity }) => {
            return {
                symbol,
                runtimeTypeTagId: closureRuntimeTypeTagId(`direct:${symbol}`),
                arity
            };
        });
}

function buildClosureDescriptorArtifacts(program: FinalBackendIRProgram, closureHelperApplyArities: ReadonlyMap<string, number>, directFunctions: readonly DirectFunctionClosureArtifact[]): readonly ClosureDescriptorArtifact[] {
    const helperDescriptors = program.closureHelpers.map((helper) => {
        const arity = closureHelperApplyArities.get(helper.applySymbol);
        if (arity === undefined) {
            throw new Error(`C backend encountered missing closure apply arity for '${helper.applySymbol}'`);
        }
        return {
            runtimeTypeTagId: closureRuntimeTypeTagId(helper.closureId),
            debugName: helper.closureId,
            applySymbol: helper.applySymbol,
            environmentLayout: helper.environmentLayout,
            captureOrder: helper.captureOrder,
            captureTypeTagIds: helper.captureOrder.map((captureName) => {
                const captureType = helper.captureTypes.get(captureName);
                if (!captureType) {
                    throw new Error(`C backend encountered missing capture type for '${helper.closureId}.${captureName}'`);
                }
                return getRuntimeTypeId(captureType);
            }),
            arity,
            sourceKind: helper.sourceKind
        } satisfies ClosureDescriptorArtifact;
    });
    const directDescriptors = directFunctions.map((artifact) => ({
        runtimeTypeTagId: artifact.runtimeTypeTagId,
        debugName: `direct:${artifact.symbol}`,
        applySymbol: artifact.symbol,
        captureOrder: [],
        captureTypeTagIds: [],
        arity: artifact.arity,
        sourceKind: "direct_function"
    } satisfies ClosureDescriptorArtifact));
    return [...helperDescriptors, ...directDescriptors].sort((left, right) => left.debugName.localeCompare(right.debugName));
}

function collectUnionMetadataFromRvalue(rvalue: LinearRvalue, sink: Map<string, Set<string>>): void {
    switch (rvalue.kind) {
        case "union_inject": {
            const members = sink.get(rvalue.unionTypeTagId) ?? new Set<string>();
            members.add(rvalue.memberTypeTagId);
            sink.set(rvalue.unionTypeTagId, members);
            return;
        }
        case "union_has_tag":
        case "union_get_payload": {
            const members = sink.get(rvalue.unionTypeTagId) ?? new Set<string>();
            members.add(rvalue.memberTypeTagId);
            sink.set(rvalue.unionTypeTagId, members);
            return;
        }
        case "copy":
        case "object_alloc":
        case "object_get_field":
        case "direct_call":
        case "closure_create":
        case "closure_call":
            return;
    }
}

function collectUnionMetadataFromStatements(statements: readonly LinearStatement[], sink: Map<string, Set<string>>): void {
    for (const statement of statements) {
        switch (statement.kind) {
            case "assign":
                collectUnionMetadataFromRvalue(statement.value, sink);
                break;
            case "if":
                collectUnionMetadataFromStatements(statement.thenStatements, sink);
                collectUnionMetadataFromStatements(statement.elseStatements, sink);
                break;
            case "set_local":
            case "object_set_field":
                break;
        }
    }
}

function buildUnionMetadata(program: FinalBackendIRProgram): readonly LoweringUnionMetadata[] {
    const membersByUnionTag = new Map<string, Set<string>>();
    for (const unionMetadata of program.metadata.referencedUnionMetadata) {
        membersByUnionTag.set(unionMetadata.unionTypeTagId, new Set(unionMetadata.members.map((member) => member.runtimeTypeTagId)));
    }
    for (const fn of [program.entry, ...program.functions]) {
        collectUnionMetadataFromStatements(fn.statements, membersByUnionTag);
    }
    return Array.from(membersByUnionTag.entries())
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([unionTypeTagId, memberTypeTagIds]) => ({
            unionTypeTagId,
            members: Array.from(memberTypeTagIds.values()).sort((left, right) => left.localeCompare(right)).map((runtimeTypeTagId) => ({ runtimeTypeTagId }))
        }));
}

function collectGcRootsFromPlanStatements(statements: readonly GcRootPlanStatement[], sink: Map<string, readonly string[]>): void {
    for (const statement of statements) {
        if (statement.gcRoots.length > 0) {
            sink.set(gcFrameKey(statement.gcRoots), statement.gcRoots);
        }
        switch (statement.kind) {
            case "assign":
            case "set_local":
            case "object_set_field":
            case "slot_store":
                break;
            case "if":
                collectGcRootsFromPlanStatements(statement.thenStatements, sink);
                collectGcRootsFromPlanStatements(statement.elseStatements, sink);
                break;
            case "while":
                collectGcRootsFromPlanStatements(statement.condStatements, sink);
                collectGcRootsFromPlanStatements(statement.bodyStatements, sink);
                break;
        }
    }
}

function buildExportedIwWrapperRootNames(metadata: LoweringExportedIwFunction): readonly string[] {
    const rootNames: string[] = [];
    for (const paramType of metadata.paramTypes) {
        if (representationFromTypeValue(paramType) === "reference") {
            rootNames.push(`iw_export_root_${rootNames.length}`);
        }
    }
    return rootNames;
}

function buildGcFrameDescriptors(program: FinalBackendIRProgram): ReadonlyMap<string, GcFrameDescriptorArtifact> {
    const rootSets: Map<string, readonly string[]> = new Map();
    for (const fn of [program.entry, ...program.functions]) {
        collectGcRootsFromPlanStatements(fn.gcPlan.statementPlans, rootSets);
        if (fn.gcPlan.resultGcRoots.length > 0) {
            rootSets.set(gcFrameKey(fn.gcPlan.resultGcRoots), fn.gcPlan.resultGcRoots);
        }
    }
    for (const metadata of program.metadata.exportedIwFunctions) {
        const rootNames = buildExportedIwWrapperRootNames(metadata);
        if (rootNames.length > 0) {
            rootSets.set(gcFrameKey(rootNames), rootNames);
        }
    }
    const descriptors: GcFrameDescriptorArtifact[] = Array.from(rootSets.entries())
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([_key, rootNames]) => {
            const canonicalRootNames = [...rootNames].sort((left, right) => left.localeCompare(right));
            const key = gcFrameKey(canonicalRootNames);
            const metadataCanonicalName = `frame:${canonicalRootNames.join("|")}`;
            return {
                key,
                structName: cGcFrameStructName(key),
                metadataCanonicalName,
                rootNames: canonicalRootNames
            };
        });
    return new Map(descriptors.map((descriptor) => [descriptor.key, descriptor] as const));
}

function buildGcFrameDescriptorForRootNames(rootNames: readonly string[]): GcFrameDescriptorArtifact {
    const canonicalRootNames = [...rootNames].sort((left, right) => left.localeCompare(right));
    const key = gcFrameKey(canonicalRootNames);
    const metadataCanonicalName = `frame:${canonicalRootNames.join("|")}`;
    return {
        key,
        structName: cGcFrameStructName(key),
        metadataCanonicalName,
        rootNames: canonicalRootNames
    };
}

function collectX64GcFrameRootSetsFromAssembly(assemblyText: string): readonly (readonly string[])[] {
    const rootSets = new Map<string, readonly string[]>();
    const regex = /^\s*# gc_frame_begin (.+)$/gm;
    let match: RegExpExecArray | null = regex.exec(assemblyText);
    while (match) {
        const rawRoots = (match[1]?.trim() ?? "").split(/\s+\|\s+key=/, 2)[0]?.trim() ?? "";
        if (rawRoots.length > 0 && rawRoots !== "<none>") {
            const rootNames = rawRoots
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name.length > 0)
                .sort((left, right) => left.localeCompare(right));
            if (rootNames.length > 0) {
                rootSets.set(gcFrameKey(rootNames), rootNames);
            }
        }
        match = regex.exec(assemblyText);
    }
    return Array.from(rootSets.values()).sort((left, right) => left.join("|").localeCompare(right.join("|")));
}

function augmentCodegenWithX64AssemblyGcFrames(
    codegen: ProgramCodegenArtifacts,
    assemblyText: string
): ProgramCodegenArtifacts {
    if (assemblyText.trim().length === 0) {
        return codegen;
    }
    const assemblyRootSets = collectX64GcFrameRootSetsFromAssembly(assemblyText);
    if (assemblyRootSets.length === 0) {
        return codegen;
    }
    const gcFrameDescriptors = new Map(codegen.gcFrameDescriptors);
    for (const rootNames of assemblyRootSets) {
        const descriptor = buildGcFrameDescriptorForRootNames(rootNames);
        if (!gcFrameDescriptors.has(descriptor.key)) {
            gcFrameDescriptors.set(descriptor.key, descriptor);
        }
    }
    if (gcFrameDescriptors.size === codegen.gcFrameDescriptors.size) {
        return codegen;
    }
    const gcMetadataBuild = buildGcMetadataArtifacts(
        codegen.layouts,
        codegen.unionMetadata,
        codegen.closureDescriptors,
        gcFrameDescriptors,
        codegen.gcGlobalDescriptors,
        codegen.globalRepresentations
    );
    return {
        ...codegen,
        gcMetadataTables: gcMetadataBuild.tables,
        gcMetadata: gcMetadataBuild.metadata,
        gcMetadataByCanonicalName: new Map(gcMetadataBuild.metadata.map((artifact) => [artifact.canonicalName, artifact] as const)),
        gcMetadataByRuntimeTypeTagId: new Map(gcMetadataBuild.metadata.filter((artifact) => artifact.runtimeTypeTagId !== undefined).map((artifact) => [artifact.runtimeTypeTagId!, artifact] as const)),
        gcFrameDescriptors
    };
}

function gcMetadataTableKeyCompare(left: string, right: string): number {
    const order = (key: string): number => {
        if (key === BUILTIN_GC_METADATA_TABLE_KEY) {
            return 0;
        }
        if (key === SHARED_GC_METADATA_TABLE_KEY) {
            return 1;
        }
        if (key.startsWith("unit:")) {
            return 2;
        }
        return 3;
    };
    const orderDelta = order(left) - order(right);
    if (orderDelta !== 0) {
        return orderDelta;
    }
    return gcMetadataTableDisplayName(left).localeCompare(gcMetadataTableDisplayName(right));
}

function findEntryConcreteFunctionUnitId(program: FinalBackendIRProgram): string | null {
    const entrySymbol = program.metadata.entryConcreteFunctionSymbol;
    if (entrySymbol === null) {
        return null;
    }
    const matchedFunction = program.functions.find((fn) => fn.symbol === entrySymbol);
    return matchedFunction?.unitId ?? null;
}

function collectGcRuntimeUnitIds(program: FinalBackendIRProgram): readonly string[] {
    const unitIds = new Set<string>();
    const entryUnitId = findEntryConcreteFunctionUnitId(program);
    if (entryUnitId !== null) {
        unitIds.add(entryUnitId);
    }
    for (const globalDef of program.globals) {
        if (!globalDef.isExternal && globalDef.unitId) {
            unitIds.add(globalDef.unitId);
        }
    }
    for (const layout of program.layouts.classes.values()) {
        if (!layout.isExternal && layout.unitId) {
            unitIds.add(layout.unitId);
        }
    }
    return Array.from(unitIds.values()).sort((left, right) => left.localeCompare(right));
}

function buildGcGlobalDescriptors(
    globals: readonly LoweringGlobalDefinition[],
    unitIds: readonly string[]
): readonly GcGlobalDescriptorArtifact[] {
    const globalsByKey = new Map<string, LoweringGlobalDefinition[]>();
    for (const unitId of unitIds) {
        globalsByKey.set(gcUnitMetadataTableKey(unitId), []);
    }
    if (globalsByKey.size === 0) {
        globalsByKey.set(SHARED_GC_METADATA_TABLE_KEY, []);
    }
    for (const globalDef of globals.filter((candidate) => !candidate.isExternal)) {
        const key = globalDef.unitId ? gcUnitMetadataTableKey(globalDef.unitId) : SHARED_GC_METADATA_TABLE_KEY;
        const globals = globalsByKey.get(key);
        if (globals) {
            globals.push(globalDef);
        } else {
            globalsByKey.set(key, [globalDef]);
        }
    }
    return Array.from(globalsByKey.entries())
        .sort((left, right) => gcMetadataTableKeyCompare(left[0], right[0]))
        .map(([key, globalDefs]) => {
            const fieldOrder = [...globalDefs.map((globalDef) => globalDef.symbol)].sort((left, right) => left.localeCompare(right));
            const displayName = gcMetadataTableDisplayName(key);
            const metadataCanonicalName = `global:${displayName}`;
            return {
                key,
                displayName,
                metadataTableKey: key,
                payloadStructName: cGcGlobalPayloadName(key),
                blockStructName: cGcGlobalBlockName(key),
                blockSymbolName: cGcGlobalBlockVarName(key),
                tableSymbolName: cGcGlobalTableName(key),
                refSlotsSymbolName: cGcGlobalRefSlotsName(key),
                livePrinterSymbolName: cGcGlobalLivePrinterName(key),
                initSymbolName: cGcGlobalInitName(key),
                metadataCanonicalName,
                fieldOrder
            };
        });
}

function buildGcMetadataArtifacts(
    layouts: ReadonlyMap<string, LoweringClassLayout>,
    unionMetadata: readonly LoweringUnionMetadata[],
    closureDescriptors: readonly ClosureDescriptorArtifact[],
    frameDescriptors: ReadonlyMap<string, GcFrameDescriptorArtifact>,
    globalDescriptors: readonly GcGlobalDescriptorArtifact[],
    globalRepresentations: ReadonlyMap<string, BackendValueRepresentation>,
    sharedMetadataTableKeyOverride?: string
): GcMetadataBuildResult {
    const sharedMetadataTableKey = sharedMetadataTableKeyOverride ?? SHARED_GC_METADATA_TABLE_KEY;
    const rawArtifacts: GcMetadataSeedArtifact[] = [
        {
            tableKey: BUILTIN_GC_METADATA_TABLE_KEY,
            canonicalName: "heap:builtin:float:f5",
            displayName: "heap:builtin:float:f5",
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: "sizeof(iw_float_value_t)",
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: 0,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex("heap:builtin:float:f5", [F5_BOXED_RUNTIME_TYPE_TAG_ID, "float"]),
            runtimeTypeTagId: F5_BOXED_RUNTIME_TYPE_TAG_ID
        },
        {
            tableKey: BUILTIN_GC_METADATA_TABLE_KEY,
            canonicalName: "heap:builtin:float:f6",
            displayName: "heap:builtin:float:f6",
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: "sizeof(iw_float_value_t)",
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: 0,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex("heap:builtin:float:f6", [F6_BOXED_RUNTIME_TYPE_TAG_ID, "float"]),
            runtimeTypeTagId: F6_BOXED_RUNTIME_TYPE_TAG_ID
        },
        {
            tableKey: BUILTIN_GC_METADATA_TABLE_KEY,
            canonicalName: "heap:builtin:float:f7",
            displayName: "heap:builtin:float:f7",
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: "sizeof(iw_float_value_t)",
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: 0,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex("heap:builtin:float:f7", [F7_BOXED_RUNTIME_TYPE_TAG_ID, "float"]),
            runtimeTypeTagId: F7_BOXED_RUNTIME_TYPE_TAG_ID
        },
        {
            tableKey: BUILTIN_GC_METADATA_TABLE_KEY,
            canonicalName: "heap:builtin:complex:z5",
            displayName: "heap:builtin:complex:z5",
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: "sizeof(iw_complex_value_t)",
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: 0,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex("heap:builtin:complex:z5", [Z5_RUNTIME_TYPE_TAG_ID, "complex"]),
            runtimeTypeTagId: Z5_RUNTIME_TYPE_TAG_ID
        },
        {
            tableKey: BUILTIN_GC_METADATA_TABLE_KEY,
            canonicalName: "heap:builtin:complex:z6",
            displayName: "heap:builtin:complex:z6",
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: "sizeof(iw_complex_value_t)",
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: 0,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex("heap:builtin:complex:z6", [Z6_RUNTIME_TYPE_TAG_ID, "complex"]),
            runtimeTypeTagId: Z6_RUNTIME_TYPE_TAG_ID
        },
        {
            tableKey: BUILTIN_GC_METADATA_TABLE_KEY,
            canonicalName: "heap:builtin:complex:z7",
            displayName: "heap:builtin:complex:z7",
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: "sizeof(iw_complex_value_t)",
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: 0,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex("heap:builtin:complex:z7", [Z7_RUNTIME_TYPE_TAG_ID, "complex"]),
            runtimeTypeTagId: Z7_RUNTIME_TYPE_TAG_ID
        },
        {
            tableKey: BUILTIN_GC_METADATA_TABLE_KEY,
            canonicalName: "heap:builtin:array",
            displayName: "heap:builtin:array",
            kind: "heap",
            lengthKind: "i64",
            fixedSizeBytesExpr: "sizeof(iw_array_value_t)",
            lengthOffsetBytesExpr: "offsetof(iw_array_value_t, length)",
            lengthScaleBytesExpr: "sizeof(iw_value_t)",
            lengthBiasBytesExpr: "0u",
            variableMemberKind: "value",
            variableMemberLabel: "item",
            slotCount: 0,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex("heap:builtin:array", ["array", "i64", "value", "iw_value_t"]),
            runtimeTypeTagId: "A4152524159000001"
        },
        {
            tableKey: BUILTIN_GC_METADATA_TABLE_KEY,
            canonicalName: "heap:builtin:text",
            displayName: "heap:builtin:text",
            kind: "heap",
            lengthKind: "u32",
            fixedSizeBytesExpr: "sizeof(iw_text_value_t)",
            lengthOffsetBytesExpr: "offsetof(iw_text_value_t, length)",
            lengthScaleBytesExpr: "1u",
            lengthBiasBytesExpr: "1u",
            variableMemberKind: "byte",
            variableMemberLabel: "byte",
            slotCount: 0,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex("heap:builtin:text", ["text", "u32", "byte", "char", "nul-terminated"]),
            runtimeTypeTagId: "T5445585400000001"
        }
    ];

    for (const layout of Array.from(layouts.values()).sort((left, right) => left.className.localeCompare(right.className))) {
        rawArtifacts.push({
            tableKey: layout.unitId ? gcUnitMetadataTableKey(layout.unitId) : sharedMetadataTableKey,
            canonicalName: `heap:class:${layout.className}`,
            displayName: `heap:class:${layout.className}`,
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: `sizeof(${cStructName(layout.className)})`,
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: layout.propertyOrder.length,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex(
                `heap:class:${layout.className}`,
                [
                    layout.runtimeTypeTagId,
                    ...layout.propertyOrder.map((fieldName) => {
                        const fieldType = layout.propertyTypes.get(fieldName);
                        return `${fieldName}:${fieldType ? getRuntimeTypeId(fieldType) : "unknown"}`;
                    })
                ]
            ),
            runtimeTypeTagId: layout.runtimeTypeTagId
        });
    }

    for (const unionDef of unionMetadata) {
        rawArtifacts.push({
            tableKey: sharedMetadataTableKey,
            canonicalName: `heap:union:${unionDef.unionTypeTagId}`,
            displayName: `heap:union:${unionDef.unionTypeTagId}`,
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: "sizeof(iw_union_value_t)",
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: 1,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex(
                `heap:union:${unionDef.unionTypeTagId}`,
                [unionDef.unionTypeTagId, ...unionDef.members.map((member) => member.runtimeTypeTagId)]
            ),
            runtimeTypeTagId: unionDef.unionTypeTagId
        });
    }

    for (const closure of closureDescriptors) {
        rawArtifacts.push({
            tableKey: sharedMetadataTableKey,
            canonicalName: `heap:closure:${closure.debugName}`,
            displayName: `heap:closure:${closure.debugName}`,
            kind: "heap",
            lengthKind: "none",
            fixedSizeBytesExpr: "sizeof(iw_closure_value_t)",
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: 1,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex(
                `heap:closure:${closure.debugName}`,
                [
                    closure.runtimeTypeTagId,
                    closure.applySymbol,
                    closure.environmentLayout ?? "",
                    String(closure.arity),
                    ...closure.captureTypeTagIds
                ]
            ),
            runtimeTypeTagId: closure.runtimeTypeTagId
        });
    }

    for (const globalDescriptor of globalDescriptors) {
        rawArtifacts.push({
            tableKey: globalDescriptor.metadataTableKey,
            canonicalName: globalDescriptor.metadataCanonicalName,
            displayName: globalDescriptor.metadataCanonicalName,
            kind: "global",
            lengthKind: "none",
            fixedSizeBytesExpr: `${gcGlobalBlockSizeBytes(globalDescriptor, globalRepresentations)}u`,
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: globalDescriptor.fieldOrder.filter((fieldName) => (globalRepresentations.get(fieldName) ?? "reference") === "reference").length,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex(
                globalDescriptor.metadataCanonicalName,
                globalDescriptor.fieldOrder.map((fieldName) => `${fieldName}:${globalRepresentations.get(fieldName) ?? "reference"}`)
            )
        });
    }

    for (const frame of Array.from(frameDescriptors.values()).sort((left, right) => left.key.localeCompare(right.key))) {
        rawArtifacts.push({
            tableKey: sharedMetadataTableKey,
            canonicalName: frame.metadataCanonicalName,
            displayName: frame.metadataCanonicalName,
            kind: "frame",
            lengthKind: "none",
            fixedSizeBytesExpr: `sizeof(${frame.structName})`,
            lengthOffsetBytesExpr: "0u",
            lengthScaleBytesExpr: "0u",
            lengthBiasBytesExpr: "0u",
            slotCount: frame.rootNames.length,
            structureOnly: true,
            layoutHashHex: gcLayoutHashHex(frame.metadataCanonicalName, frame.rootNames)
        });
    }

    const artifactsByTable = new Map<string, typeof rawArtifacts>();
    for (const artifact of rawArtifacts) {
        const tableArtifacts = artifactsByTable.get(artifact.tableKey);
        if (tableArtifacts) {
            tableArtifacts.push(artifact);
        } else {
            artifactsByTable.set(artifact.tableKey, [artifact]);
        }
    }

    const tableKeys = new Set<string>([
        BUILTIN_GC_METADATA_TABLE_KEY,
        SHARED_GC_METADATA_TABLE_KEY,
        ...globalDescriptors.map((descriptor) => descriptor.metadataTableKey),
        ...Array.from(artifactsByTable.keys())
    ]);
    const seenTableUuids = new Map<string, string>();
    const seenStructUuids = new Map<string, string>();
    const seenAuthKeys = new Map<string, string>();

    const tables = Array.from(tableKeys.values())
        .sort(gcMetadataTableKeyCompare)
        .map((tableKey) => {
            const displayName = gcMetadataTableDisplayName(tableKey);
            const uuidHiHex = gcMetadataTableUuidHiHex(tableKey);
            const uuidLoHex = gcMetadataTableUuidLoHex(tableKey);
            const uuidHash64Hex = gcMetadataTableUuidHash64Hex(uuidHiHex, uuidLoHex);
            ensureUniqueGcMetadataValue(seenTableUuids, `${uuidHiHex}|${uuidLoHex}`, tableKey, "table UUID");
            const entries = (artifactsByTable.get(tableKey) ?? [])
                .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName))
                .map((artifact) => {
                    const structUuidHiHex = gcMetadataStructUuidHiHex(tableKey, artifact.canonicalName);
                    const structUuidLoHex = gcMetadataStructUuidLoHex(tableKey, artifact.canonicalName);
                    const firstTagHex = gcMetadataFirstTagHex(structUuidHiHex, structUuidLoHex);
                    const structUuidHash64Hex = gcMetadataStructHash64Hex(structUuidHiHex, structUuidLoHex);
                    const staticInfoHashHex = gcMetadataStaticInfoHashHex(artifact);
                    const endConfirmationHex = gcEndConfirmationDeterministicHex(
                        structUuidHiHex,
                        structUuidLoHex,
                        staticInfoHashHex
                    );
                    const owner = `${tableKey}:${artifact.canonicalName}`;
                    ensureUniqueGcMetadataValue(seenStructUuids, `${structUuidHiHex}|${structUuidLoHex}`, owner, "struct UUID");
                    ensureUniqueGcMetadataValue(seenAuthKeys, `${firstTagHex}|${endConfirmationHex}`, owner, "tagged block key");
                    return {
                        ...artifact,
                        tableSymbolName: cGcMetadataTableName(tableKey),
                        tableDisplayName: displayName,
                        tableUuidHiHex: uuidHiHex,
                        tableUuidLoHex: uuidLoHex,
                        tableUuidHash64Hex: uuidHash64Hex,
                        structUuidHiHex,
                        structUuidLoHex,
                        variableMemberKind: artifact.variableMemberKind ?? "none",
                        variableMemberLabel: artifact.variableMemberLabel ?? "",
                        firstTagHex,
                        structUuidHash64Hex,
                        symbolName: cGcMetadataName(artifact.canonicalName),
                        staticInfoHashHex,
                        endConfirmationHex
                    };
                });
            return {
                key: tableKey,
                symbolName: cGcMetadataTableName(tableKey),
                displayName,
                uuidHiHex,
                uuidLoHex,
                uuidHash64Hex,
                entriesName: cGcMetadataEntriesName(tableKey),
                entries
            };
        });

    return {
        tables,
        metadata: tables.flatMap((table) => table.entries)
    };
}

function buildProgramCodegenArtifacts(program: FinalBackendIRProgram, extraLayouts?: ReadonlyMap<string, LoweringClassLayout>): ProgramCodegenArtifacts {
    const closureCallArities = new Set<number>();
    const directFunctions = new Set<string>();
    const textLiterals = new Map<string, TextLiteralArtifact>();
    const functionArities = buildFunctionArityTable(program);
    const functionSignatures = buildFunctionSignatureTable(program, functionArities);
    const closureHelperApplyArities = buildClosureHelperApplyArities(program);
    for (const fn of [program.entry, ...program.functions]) {
        collectLinearStatementInfo(fn.statements, closureCallArities, directFunctions, textLiterals);
        collectLinearOperandDirectFunctions(fn.result, directFunctions);
        collectLinearOperandTextLiterals(fn.result, textLiterals);
    }
    const directFunctionArtifacts = buildDirectFunctionArtifacts(functionArities, directFunctions);
    const requiredClosureCallArities = new Set<number>(closureCallArities);
    directFunctionArtifacts.forEach((artifact) => requiredClosureCallArities.add(artifact.arity));
    closureHelperApplyArities.forEach((arity) => requiredClosureCallArities.add(arity));
    const layouts = buildEffectiveLayouts(program, extraLayouts);
    const globalRepresentations = new Map(program.globals.map((globalDef) => [globalDef.symbol, representationFromTypeValue(globalDef.type)] as const));
    const unionMetadata = buildUnionMetadata(program);
    const closureDescriptors = buildClosureDescriptorArtifacts(program, closureHelperApplyArities, directFunctionArtifacts);
    const gcFrameDescriptors = buildGcFrameDescriptors(program);
    const gcRuntimeUnitIds = collectGcRuntimeUnitIds(program);
    const gcGlobalDescriptors = buildGcGlobalDescriptors(program.globals, gcRuntimeUnitIds);
    const gcMetadataBuild = buildGcMetadataArtifacts(layouts, unionMetadata, closureDescriptors, gcFrameDescriptors, gcGlobalDescriptors, globalRepresentations);
    return {
        layouts,
        globalRepresentations,
        functionArities,
        functionSignatures,
        closureHelperApplyArities,
        closureCallArities: Array.from(requiredClosureCallArities.values()).sort((left, right) => left - right),
        textLiterals: Array.from(textLiterals.values()).sort((left, right) => left.referenceName.localeCompare(right.referenceName)),
        directFunctions: directFunctionArtifacts,
        closureDescriptors,
        unionMetadata,
        gcMetadataTables: gcMetadataBuild.tables,
        gcMetadata: gcMetadataBuild.metadata,
        gcMetadataByCanonicalName: new Map(gcMetadataBuild.metadata.map((artifact) => [artifact.canonicalName, artifact] as const)),
        gcMetadataByRuntimeTypeTagId: new Map(gcMetadataBuild.metadata.filter((artifact) => artifact.runtimeTypeTagId !== undefined).map((artifact) => [artifact.runtimeTypeTagId!, artifact] as const)),
        gcFrameDescriptors,
        gcGlobalDescriptors
    };
}

function buildProgramCodegenArtifactsWithOptions(
    program: FinalBackendIRProgram,
    extraLayouts?: ReadonlyMap<string, LoweringClassLayout>,
    sharedMetadataTableKeyOverride?: string
): ProgramCodegenArtifacts {
    const closureCallArities = new Set<number>();
    const directFunctions = new Set<string>();
    const textLiterals = new Map<string, TextLiteralArtifact>();
    const functionArities = buildFunctionArityTable(program);
    const functionSignatures = buildFunctionSignatureTable(program, functionArities);
    const closureHelperApplyArities = buildClosureHelperApplyArities(program);
    for (const fn of [program.entry, ...program.functions]) {
        collectLinearStatementInfo(fn.statements, closureCallArities, directFunctions, textLiterals);
        collectLinearOperandDirectFunctions(fn.result, directFunctions);
        collectLinearOperandTextLiterals(fn.result, textLiterals);
    }
    const directFunctionArtifacts = buildDirectFunctionArtifacts(functionArities, directFunctions);
    const requiredClosureCallArities = new Set<number>(closureCallArities);
    directFunctionArtifacts.forEach((artifact) => requiredClosureCallArities.add(artifact.arity));
    closureHelperApplyArities.forEach((arity) => requiredClosureCallArities.add(arity));
    const layouts = buildEffectiveLayouts(program, extraLayouts);
    const globalRepresentations = new Map(program.globals.map((globalDef) => [globalDef.symbol, representationFromTypeValue(globalDef.type)] as const));
    const unionMetadata = buildUnionMetadata(program);
    const closureDescriptors = buildClosureDescriptorArtifacts(program, closureHelperApplyArities, directFunctionArtifacts);
    const gcFrameDescriptors = buildGcFrameDescriptors(program);
    const gcRuntimeUnitIds = collectGcRuntimeUnitIds(program);
    const gcGlobalDescriptors = buildGcGlobalDescriptors(program.globals, gcRuntimeUnitIds);
    const gcMetadataBuild = buildGcMetadataArtifacts(
        layouts,
        unionMetadata,
        closureDescriptors,
        gcFrameDescriptors,
        gcGlobalDescriptors,
        globalRepresentations,
        sharedMetadataTableKeyOverride
    );
    return {
        layouts,
        globalRepresentations,
        functionArities,
        functionSignatures,
        closureHelperApplyArities,
        closureCallArities: Array.from(requiredClosureCallArities.values()).sort((left, right) => left - right),
        textLiterals: Array.from(textLiterals.values()).sort((left, right) => left.referenceName.localeCompare(right.referenceName)),
        directFunctions: directFunctionArtifacts,
        closureDescriptors,
        unionMetadata,
        gcMetadataTables: gcMetadataBuild.tables,
        gcMetadata: gcMetadataBuild.metadata,
        gcMetadataByCanonicalName: new Map(gcMetadataBuild.metadata.map((artifact) => [artifact.canonicalName, artifact] as const)),
        gcMetadataByRuntimeTypeTagId: new Map(gcMetadataBuild.metadata.filter((artifact) => artifact.runtimeTypeTagId !== undefined).map((artifact) => [artifact.runtimeTypeTagId!, artifact] as const)),
        gcFrameDescriptors,
        gcGlobalDescriptors
    };
}

function emitBuiltinCall(symbol: string, args: readonly string[], usageContext: string): string {
    const builtin = BUILTIN_EMITTERS.get(resolveBuiltinEmitterSymbol(symbol));
    if (!builtin) {
        throw new Error(`C backend does not support builtin '${symbol}' in ${usageContext}`);
    }
    if (args.length !== builtin.arity) {
        throw new Error(`C backend expected builtin '${symbol}' to have arity ${builtin.arity} in ${usageContext}, got ${args.length}`);
    }
    return builtin.emit(args);
}

function getFunctionArity(symbol: string, context: FunctionCodegenContext, usageContext: string): number {
    const arity = context.program.functionArities.get(symbol);
    if (arity === undefined) {
        throw new Error(`C backend encountered unknown function arity for '${symbol}' in ${usageContext}`);
    }
    return arity;
}

function getFunctionSignature(symbol: string, context: FunctionCodegenContext, usageContext: string): FunctionSignatureArtifact {
    const signature = context.program.functionSignatures.get(symbol);
    if (!signature) {
        throw new Error(`C backend encountered missing function signature for '${symbol}' in ${usageContext}`);
    }
    return signature;
}

function getDirectFunctionTypeInfo(symbol: string, context: FunctionCodegenContext): DirectFunctionClosureArtifact {
    const descriptor = context.program.directFunctions.find((entry) => entry.symbol === symbol);
    if (!descriptor) {
        throw new Error(`C backend encountered missing direct-function closure descriptor for '${symbol}'`);
    }
    return descriptor;
}

function emitDirectFunctionOperand(symbol: string, context: FunctionCodegenContext, usageContext: string): string {
    const descriptor = getDirectFunctionTypeInfo(symbol, context);
    const arity = getFunctionArity(symbol, context, usageContext);
    return `iw_closure_box(&${cTypeInfoName(descriptor.runtimeTypeTagId)}, (uintptr_t)${cClosureTargetName(symbol)}, iw_from_i64(0LL), ${arity}u)`;
}

function emitOperand(operand: LinearOperand, context: FunctionCodegenContext, usageContext: string): string {
    switch (operand.kind) {
        case "local": {
            const scopedName = resolveScopedLocal(operand.name, context);
            if (!scopedName) {
                if (context.program.globalRepresentations.has(operand.name)) {
                    return cGlobalName(operand.name);
                }
                if (context.program.functionArities.has(operand.name)) {
                    return emitDirectFunctionOperand(operand.name, context, usageContext);
                }
                throw new Error(`C backend encountered unresolved local operand '${operand.name}' in ${usageContext}`);
            }
            return scopedName;
        }
        case "number_literal":
            return formatNumberLiteral(operand.value, operand.typeName);
        case "text_literal":
            return `(iw_value_t)(intptr_t)&${cTextValueName(operand.referenceName)}`;
        case "direct_function":
            return emitDirectFunctionOperand(operand.symbol, context, usageContext);
    }
}

function emitOperandAs(operand: LinearOperand, representation: BackendValueRepresentation, context: FunctionCodegenContext, usageContext: string): string {
    return convertExpressionRepresentation(
        emitOperand(operand, context, usageContext),
        getOperandRepresentation(operand, context),
        representation,
        usageContext
    );
}

function emitDirectCall(symbol: string, args: readonly string[], context: FunctionCodegenContext, usageContext: string): string {
    if (hasBuiltinEmitterSymbol(symbol)) {
        return emitBuiltinCall(symbol, args, usageContext);
    }
    if (!context.functionNames.has(symbol)) {
        throw new Error(`C backend encountered unknown direct_call target '${symbol}' in ${usageContext}`);
    }
    return `${cFunctionName(symbol)}(${args.join(", ")})`;
}

function emitRvalue(rvalue: LinearRvalue, context: FunctionCodegenContext, usageContext: string): string {
    switch (rvalue.kind) {
        case "copy":
            return emitOperand(rvalue.value, context, usageContext);
        case "direct_call": {
            const signature = getFunctionSignature(rvalue.symbol, context, usageContext);
            const args = rvalue.args.map((arg, index) => emitOperandAs(arg, signature.paramRepresentations[index] ?? "reference", context, `${usageContext} arg ${index}`));
            return emitDirectCall(rvalue.symbol, args, context, usageContext);
        }
        case "closure_call": {
            const args = rvalue.args.map((arg, index) => emitOperandAs(arg, "reference", context, `${usageContext} arg ${index}`));
            const callee = emitOperandAs(rvalue.callee, "reference", context, `${usageContext} callee`);
            return `iw_closure_call_${args.length}(${callee}, ${cStringLiteral(usageContext)}${args.length > 0 ? `, ${args.join(", ")}` : ""})`;
        }
        case "object_alloc": {
            const layout = getClassLayout(rvalue.className, context, usageContext);
            return `${cAllocHelperName(rvalue.className)}(&${cTypeInfoName(layout.runtimeTypeTagId)})`;
        }
        case "object_get_field": {
            const layout = getClassLayout(rvalue.className, context, usageContext);
            if (!layout.propertyOrder.includes(rvalue.fieldName)) {
                throw new Error(`C backend encountered unknown field '${rvalue.className}.${rvalue.fieldName}' in ${usageContext}`);
            }
            return `${cCastHelperName(rvalue.className)}(${emitOperandAs(rvalue.receiver, "reference", context, `${usageContext} receiver`)}, ${cStringLiteral(usageContext)})->${cFieldName(rvalue.fieldName)}`;
        }
        case "slot_load": {
            const layout = getClassLayout(rvalue.className, context, usageContext);
            if (!layout.propertyOrder.includes(rvalue.slotName)) {
                throw new Error(`C backend encountered unknown slot '${rvalue.className}.${rvalue.slotName}' in ${usageContext}`);
            }
            return `${cCastHelperName(rvalue.className)}(${emitOperandAs(rvalue.receiver, "reference", context, `${usageContext} receiver`)}, ${cStringLiteral(usageContext)})->${cFieldName(rvalue.slotName)}`;
        }
        case "union_inject":
            return `iw_union_box(&${cTypeInfoName(rvalue.unionTypeTagId)}, ${runtimeTypeTagLiteral(rvalue.memberTypeTagId)}, ${emitOperandAs(rvalue.value, "reference", context, `${usageContext} value`)})`;
        case "union_has_tag":
            return `iw_union_has_member(${emitOperandAs(rvalue.unionValue, "reference", context, `${usageContext} union`)}, ${runtimeTypeTagLiteral(rvalue.unionTypeTagId)}, ${runtimeTypeTagLiteral(rvalue.memberTypeTagId)}, ${cStringLiteral(usageContext)})`;
        case "union_get_payload":
            return `iw_union_get_payload(${emitOperandAs(rvalue.unionValue, "reference", context, `${usageContext} union`)}, ${runtimeTypeTagLiteral(rvalue.unionTypeTagId)}, ${runtimeTypeTagLiteral(rvalue.memberTypeTagId)}, ${cStringLiteral(usageContext)})`;
        case "closure_create": {
            const captures = rvalue.captures.map((capture, index) => emitOperand(capture, context, `${usageContext} capture ${index}`));
            return `${cClosureMakerName(rvalue.closureId)}(${captures.join(", ")})`;
        }
    }
}

function emitRvalueAs(rvalue: LinearRvalue, representation: BackendValueRepresentation, context: FunctionCodegenContext, usageContext: string): string {
    let naturalRepresentation: BackendValueRepresentation = "reference";
    switch (rvalue.kind) {
        case "copy":
            naturalRepresentation = getOperandRepresentation(rvalue.value, context);
            break;
        case "object_get_field": {
            const layout = getClassLayout(rvalue.className, context, usageContext);
            const fieldType = layout.propertyTypes.get(rvalue.fieldName);
            naturalRepresentation = fieldType ? representationFromTypeValue(fieldType) : "reference";
            break;
        }
        case "slot_load": {
            const layout = getClassLayout(rvalue.className, context, usageContext);
            const fieldType = layout.propertyTypes.get(rvalue.slotName);
            naturalRepresentation = fieldType ? representationFromTypeValue(fieldType) : "reference";
            break;
        }
        case "direct_call":
            naturalRepresentation = getFunctionSignature(rvalue.symbol, context, usageContext).resultRepresentation;
            break;
        case "closure_call":
        case "object_alloc":
        case "union_inject":
        case "closure_create":
            naturalRepresentation = "reference";
            break;
        case "union_has_tag":
            naturalRepresentation = "immediate";
            break;
        case "union_get_payload":
            naturalRepresentation = "reference";
            break;
    }
    return convertExpressionRepresentation(emitRvalue(rvalue, context, usageContext), naturalRepresentation, representation, usageContext);
}

function emitStatement(statement: LinearStatement, context: FunctionCodegenContext, indentLevel: number): string {
    const indent = "    ".repeat(indentLevel);
    switch (statement.kind) {
        case "assign":
            return `${indent}${cLocalName(statement.target)} = ${emitRvalueAs(statement.value, getBindingRepresentation(statement.target, context), context, `assignment to ${statement.target}`)};`;
        case "set_local": {
            const target = resolveScopedLocal(statement.target, context);
            if (!target) {
                if (!context.program.globalRepresentations.has(statement.target)) {
                    throw new Error(`C backend encountered unresolved set_local target '${statement.target}'`);
                }
                return `${indent}${cGlobalName(statement.target)} = ${emitOperandAs(statement.value, getBindingRepresentation(statement.target, context), context, `set_local ${statement.target}`)};`;
            }
            return `${indent}${target} = ${emitOperandAs(statement.value, getBindingRepresentation(statement.target, context), context, `set_local ${statement.target}`)};`;
        }
        case "if": {
            const cond = emitOperandAs(statement.cond, "immediate", context, "if condition");
            const thenBlock = statement.thenStatements.map((inner) => emitStatement(inner, context, indentLevel + 1)).join("\n");
            const elseBlock = statement.elseStatements.map((inner) => emitStatement(inner, context, indentLevel + 1)).join("\n");
            return [
                `${indent}if (iw_as_i64(${cond})) {`,
                thenBlock,
                `${indent}} else {`,
                elseBlock,
                `${indent}}`
            ].join("\n");
        }
        case "while": {
            const condSetup = statement.condStatements.map((inner) => emitStatement(inner, context, indentLevel + 1)).join("\n");
            const cond = emitOperandAs(statement.cond, "immediate", context, "while condition");
            const bodyBlock = statement.bodyStatements.map((inner) => emitStatement(inner, context, indentLevel + 1)).join("\n");
            const parts = [`${indent}while (1) {`];
            if (condSetup.length > 0) {
                parts.push(condSetup);
            }
            parts.push(`${indent}    if (!iw_as_i64(${cond})) { break; }`);
            if (bodyBlock.length > 0) {
                parts.push(bodyBlock);
            }
            parts.push(`${indent}}`);
            return parts.join("\n");
        }
        case "object_set_field": {
            const layout = getClassLayout(statement.className, context, `object_set_field ${statement.className}.${statement.fieldName}`);
            if (!layout.propertyOrder.includes(statement.fieldName)) {
                throw new Error(`C backend encountered unknown field '${statement.className}.${statement.fieldName}'`);
            }
            const fieldType = layout.propertyTypes.get(statement.fieldName);
            const fieldRepresentation = fieldType ? representationFromTypeValue(fieldType) : "reference";
            const receiver = emitOperandAs(statement.receiver, "reference", context, `object_set_field ${statement.className}.${statement.fieldName} receiver`);
            const value = emitOperandAs(statement.value, fieldRepresentation, context, `object_set_field ${statement.className}.${statement.fieldName} value`);
            return `${indent}${cCastHelperName(statement.className)}(${receiver}, ${cStringLiteral(`object_set_field ${statement.className}.${statement.fieldName}`)})->${cFieldName(statement.fieldName)} = ${value};`;
        }
        case "slot_store": {
            const layout = getClassLayout(statement.className, context, `slot_store ${statement.className}.${statement.slotName}`);
            if (!layout.propertyOrder.includes(statement.slotName)) {
                throw new Error(`C backend encountered unknown slot '${statement.className}.${statement.slotName}'`);
            }
            const fieldType = layout.propertyTypes.get(statement.slotName);
            const fieldRepresentation = fieldType ? representationFromTypeValue(fieldType) : "reference";
            const receiver = emitOperandAs(statement.receiver, "reference", context, `slot_store ${statement.className}.${statement.slotName} receiver`);
            const value = emitOperandAs(statement.value, fieldRepresentation, context, `slot_store ${statement.className}.${statement.slotName} value`);
            return `${indent}${cCastHelperName(statement.className)}(${receiver}, ${cStringLiteral(`slot_store ${statement.className}.${statement.slotName}`)})->${cFieldName(statement.slotName)} = ${value};`;
        }
    }
}

function emitGcScopedBlock(rootNames: readonly string[], body: string, context: FunctionCodegenContext, indentLevel: number): string {
    const indent = "    ".repeat(indentLevel);
    const innerIndent = "    ".repeat(indentLevel + 1);
    const indentedBody = body.length === 0
        ? ""
        : body.split("\n").map((line) => line.length === 0 ? line : `${innerIndent}${line}`).join("\n");
    if (rootNames.length === 0) {
        return body;
    }
    const descriptor = getGcFrameDescriptor(rootNames, context, "gc scoped block");
    const metadata = getGcMetadataByCanonicalName(descriptor.metadataCanonicalName, context, "gc scoped block");
    const rootAssignments = rootNames.map((name) => `${innerIndent}iw_gc_frame.${cFieldName(name)} = ${context.paramNames.has(name) ? cParamName(name) : cLocalName(name)};`).join("\n");
    return [
        `${indent}{`,
        `${innerIndent}${descriptor.structName} iw_gc_frame;`,
        `${innerIndent}memset(&iw_gc_frame, 0, sizeof(iw_gc_frame));`,
        rootAssignments,
        `${innerIndent}iw_gc_frame.gc_tag1 = ${u64HexLiteral(metadata.firstTagHex)};`,
        `${innerIndent}iw_gc_write_end_confirmation(&iw_gc_frame, &${metadata.symbolName}, sizeof(iw_gc_frame));`,
        `${innerIndent}iw_gc_safepoint_poll((uintptr_t)&iw_gc_frame);`,
        indentedBody,
        `${innerIndent}iw_gc_frame.gc_tag1 = 0ULL;`,
        `${innerIndent}iw_gc_frame.gc_end_confirmation = 0ULL;`,
        `${indent}}`
    ].filter((line) => line.length > 0).join("\n");
}

function emitStandaloneGcScopedBlock(rootNames: readonly string[], bodyLines: readonly string[], codegen: ProgramCodegenArtifacts, indentLevel: number): string {
    if (rootNames.length === 0) {
        return bodyLines.map((line) => `${"    ".repeat(indentLevel)}${line}`).join("\n");
    }

    const descriptor = codegen.gcFrameDescriptors.get(gcFrameKey(rootNames));
    if (!descriptor) {
        throw new Error(`C backend encountered missing GC frame descriptor for exported wrapper roots [${rootNames.join(", ")}]`);
    }
    const metadata = codegen.gcMetadataByCanonicalName.get(descriptor.metadataCanonicalName);
    if (!metadata) {
        throw new Error(`C backend encountered missing GC metadata '${descriptor.metadataCanonicalName}' for exported wrapper roots [${rootNames.join(", ")}]`);
    }

    const indent = "    ".repeat(indentLevel);
    const innerIndent = "    ".repeat(indentLevel + 1);
    const rootAssignments = rootNames.map((name) => `${innerIndent}iw_gc_frame.${cFieldName(name)} = ${name};`).join("\n");
    return [
        `${indent}{`,
        `${innerIndent}${descriptor.structName} iw_gc_frame;`,
        `${innerIndent}memset(&iw_gc_frame, 0, sizeof(iw_gc_frame));`,
        rootAssignments,
        `${innerIndent}iw_gc_frame.gc_tag1 = ${u64HexLiteral(metadata.firstTagHex)};`,
        `${innerIndent}iw_gc_write_end_confirmation(&iw_gc_frame, &${metadata.symbolName}, sizeof(iw_gc_frame));`,
        ...bodyLines.map((line) => `${innerIndent}${line}`),
        `${innerIndent}iw_gc_frame.gc_tag1 = 0ULL;`,
        `${innerIndent}iw_gc_frame.gc_end_confirmation = 0ULL;`,
        `${indent}}`
    ].join("\n");
}

function emitStatementSequenceWithGcPlan(
    statements: readonly LinearStatement[],
    plans: readonly GcRootPlanStatement[],
    context: FunctionCodegenContext,
    indentLevel: number
): string {
    if (statements.length !== plans.length) {
        throw new Error(`C backend encountered GC plan length mismatch: expected ${statements.length}, got ${plans.length}`);
    }
    return statements
        .map((statement, index) => emitStatementWithGcPlan(statement, plans[index], context, indentLevel))
        .join("\n");
}

function emitStatementWithGcPlan(
    statement: LinearStatement,
    plan: GcRootPlanStatement,
    context: FunctionCodegenContext,
    indentLevel: number,
    suppressOuterGcScope = false
): string {
    if (statement.kind !== plan.kind) {
        throw new Error(`C backend encountered GC plan mismatch for statement kind '${statement.kind}'`);
    }
    if (statement.kind === "if" && plan.kind === "if") {
        const indent = "    ".repeat(indentLevel);
        const cond = emitOperandAs(statement.cond, "immediate", context, "if condition");
        const thenBlock = emitStatementSequenceWithGcPlan(statement.thenStatements, plan.thenStatements, context, indentLevel + 1);
        const elseBlock = emitStatementSequenceWithGcPlan(statement.elseStatements, plan.elseStatements, context, indentLevel + 1);
        const emittedIf = [
            `${indent}if (iw_as_i64(${cond})) {`,
            thenBlock,
            `${indent}} else {`,
            elseBlock,
            `${indent}}`
        ].join("\n");
        return suppressOuterGcScope ? emittedIf : emitGcScopedBlock(plan.gcRoots, emittedIf, context, indentLevel);
    }
    const emittedStatement = emitStatement(statement, context, indentLevel);
    return suppressOuterGcScope ? emittedStatement : emitGcScopedBlock(plan.gcRoots, emittedStatement, context, indentLevel);
}

function emitFunction(fn: BackendFunctionIR, functionNames: ReadonlySet<string>, program: ProgramCodegenArtifacts): string {
    const paramNames = new Set(fn.params);
    const localNames = new Set(fn.locals.filter((name) => !paramNames.has(name)));
    const context: FunctionCodegenContext = {
        currentFunction: fn,
        functionNames,
        paramNames,
        localNames,
        program
    };
    const params = fn.params.map((param) => `${cTypeForRepresentation(fn.bindingRepresentations.get(param) ?? "reference")} ${cParamName(param)}`).join(", ");
    const sortedLocals = Array.from(localNames).sort((left, right) => left.localeCompare(right));
    const localDeclarations = sortedLocals.map((name) => `    ${cTypeForRepresentation(fn.bindingRepresentations.get(name) ?? "reference")} ${cLocalName(name)} = ${cZeroValueForRepresentation(fn.bindingRepresentations.get(name) ?? "reference")};`).join("\n");
    const statements = emitStatementSequenceWithGcPlan(fn.statements, fn.gcPlan.statementPlans, context, 1);
    const resultOperand = fn.origin.kind === "constructor" && fn.params.length > 0
        ? { kind: "local", name: fn.params[0] } as const
        : fn.result;
    const resultDeclaration = `    ${cTypeForRepresentation(fn.resultRepresentation)} iw_result = ${cZeroValueForRepresentation(fn.resultRepresentation)};`;
    const emittedResult = `    iw_result = ${emitOperandAs(resultOperand, fn.resultRepresentation, context, `${fn.symbol} return`)};`;
    const result = emitGcScopedBlock(fn.gcPlan.resultGcRoots, emittedResult, context, 1);
    return [
        `static inline ${cTypeForRepresentation(fn.resultRepresentation)} IW_INTERNAL_ABI ${cFunctionName(fn.symbol)}(${params}) {`,
        localDeclarations,
        statements,
        resultDeclaration,
        result,
        "    return iw_result;",
        "}"
    ].filter((line) => line.length > 0).join("\n");
}

function emitPrototype(fn: BackendFunctionIR): string {
    const params = fn.params.map((param) => `${cTypeForRepresentation(fn.bindingRepresentations.get(param) ?? "reference")} ${cParamName(param)}`).join(", ");
    return `static inline ${cTypeForRepresentation(fn.resultRepresentation)} IW_INTERNAL_ABI ${cFunctionName(fn.symbol)}(${params});`;
}

function emitExternPrototype(fn: FinalBackendIRProgram["externFunctions"][number]): string {
    const params = fn.params.map((param, index) => `${cTypeForRepresentation(fn.paramRepresentations[index] ?? "reference")} ${cParamName(param)}`).join(", ");
    if (fn.callingConvention === "c_ffi") {
        return `extern ${cTypeForRepresentation(fn.resultRepresentation)} ${cFunctionName(fn.symbol)}(${params}) __asm__(${cStringLiteral(fn.symbol)});`;
    }
    return `extern ${cTypeForRepresentation(fn.resultRepresentation)} ${cFunctionName(fn.symbol)}(${params});`;
}

function emitX64CompiledPrototype(fn: BackendFunctionIR, asmSymbol = fn.symbol): string {
    const params = fn.params.map((param) => `${cTypeForRepresentation(fn.bindingRepresentations.get(param) ?? "reference")} ${cParamName(param)}`).join(", ");
    return `extern ${cTypeForRepresentation(fn.resultRepresentation)} IW_INTERNAL_ABI ${cFunctionName(fn.symbol)}(${params}) __asm__(${cStringLiteral(mangleX64AsmSymbol(asmSymbol))});`;
}

function emitX64ExternPrototype(fn: FinalBackendIRProgram["externFunctions"][number]): string {
    const params = fn.params.map((param, index) => `${cTypeForRepresentation(fn.paramRepresentations[index] ?? "reference")} ${cParamName(param)}`).join(", ");
    if (fn.callingConvention === "c_ffi") {
        return `extern ${cTypeForRepresentation(fn.resultRepresentation)} IW_HOST_ABI ${cFunctionName(fn.symbol)}(${params}) __asm__(${cStringLiteral(fn.symbol)});`;
    }
    return `extern ${cTypeForRepresentation(fn.resultRepresentation)} IW_INTERNAL_ABI ${cFunctionName(fn.symbol)}(${params}) __asm__(${cStringLiteral(mangleX64AsmSymbol(fn.symbol))});`;
}

function emitClassRuntime(layout: LoweringClassLayout): string {
    const structName = cStructName(layout.className);
    const fields = layout.propertyOrder.map((fieldName) => {
        const fieldType = layout.propertyTypes.get(fieldName);
        return `    ${cTypeForRepresentation(fieldType ? representationFromTypeValue(fieldType) : "reference")} ${cFieldName(fieldName)};`;
    }).join("\n");
    const tagLiteral = runtimeTypeTagLiteral(layout.runtimeTypeTagId);
    return [
        `typedef struct ${structName} {`,
        "    iw_heap_header_t header;",
        fields.length > 0 ? fields : "    iw_value_t __iw_unused;",
        `} ${structName};`,
        `static inline ${structName}* ${cCastHelperName(layout.className)}(iw_value_t value, const char *context) {`,
        `    ${structName}* object = (${structName}*)(intptr_t)iw_expect_heap_header(value, context);`,
        `    if (object->header.tag != ${tagLiteral}) {`,
        `        fprintf(stderr, \"Ironwall C backend tag mismatch in %s: expected ${layout.runtimeTypeTagId}\\n\", context);`,
        "        abort();",
        "    }",
        "    return object;",
        "}",
        `static inline iw_value_t ${cAllocHelperName(layout.className)}(const iw_runtime_type_info_t *type_info) {`,
        "    iw_gc_metadata_ref_t metadata_ref = iw_gc_metadata_ref_for_runtime_type(type_info->tag);",
        `    ${structName}* object = (${structName}*)iw_gc_allocate(sizeof(${structName}), type_info, metadata_ref, ${cStringLiteral(layout.className)});`,
        `    iw_gc_publish_allocation((iw_heap_header_t*)object, sizeof(${structName}), metadata_ref);`,
        "    return (iw_value_t)(intptr_t)object;",
        "}"
    ].join("\n");
}

function emitClosureCallHelpers(closureCallArities: readonly number[]): string {
    if (closureCallArities.length === 0) {
        return "";
    }
    const blocks: string[] = [];
    for (const arity of closureCallArities) {
        const argDecls = Array.from({ length: arity }, (_unused, index) => `iw_value_t arg${index}`);
        const applyTypeArgs = ["iw_value_t env", ...argDecls].join(", ");
        const forwardedArgs = ["closure->env", ...Array.from({ length: arity }, (_unused, index) => `arg${index}`)].join(", ");
        const callArgs = ["iw_value_t raw_closure", "const char *context", ...argDecls].join(", ");
        blocks.push(`typedef iw_value_t (IW_INTERNAL_ABI *iw_closure_apply_${arity}_t)(${applyTypeArgs});`);
        blocks.push(`static inline iw_value_t iw_closure_call_${arity}(${callArgs}) { iw_closure_value_t *closure = iw_closure_expect(raw_closure, ${arity}u, context); return ((iw_closure_apply_${arity}_t)closure->apply)(${forwardedArgs}); }`);
    }
    return blocks.join("\n");
}

function emitDirectFunctionWrappers(functionArities: ReadonlyMap<string, number>, functionSignatures: ReadonlyMap<string, FunctionSignatureArtifact>): string {
    if (functionArities.size === 0) {
        return "";
    }
    const wrappers: string[] = [];
    for (const symbol of Array.from(functionArities.keys()).sort((left, right) => left.localeCompare(right))) {
        const arity = functionArities.get(symbol)!;
        const argDecls = Array.from({ length: arity }, (_unused, index) => `iw_value_t arg${index}`);
        const wrapperParams = ["iw_value_t env", ...argDecls].join(", ");
        const signature = functionSignatures.get(symbol);
        if (!signature) {
            throw new Error(`C backend encountered missing boxed-wrapper signature for '${symbol}'`);
        }
        const callArgs = signature.paramRepresentations.map((representation, index) => convertExpressionRepresentation(`arg${index}`, "reference", representation, `direct function wrapper ${symbol} arg ${index}`)).join(", ");
        const targetCall = hasBuiltinEmitterSymbol(symbol)
            ? emitBuiltinCall(symbol, signature.paramRepresentations.map((representation, index) => convertExpressionRepresentation(`arg${index}`, "reference", representation, `direct function wrapper ${symbol} arg ${index}`)), `direct function wrapper ${symbol}`)
            : `${cFunctionName(symbol)}(${callArgs})`;
        wrappers.push([
            `static inline iw_value_t IW_INTERNAL_ABI ${cClosureTargetName(symbol)}(${wrapperParams}) {`,
            "    (void)env;",
            `    return ${convertExpressionRepresentation(targetCall, signature.resultRepresentation, "reference", `direct function wrapper ${symbol} result`)};`,
            "}"
        ].join("\n"));
    }
    return wrappers.join("\n\n");
}

function emitSelectedDirectFunctionWrappers(directFunctions: readonly DirectFunctionClosureArtifact[], functionSignatures: ReadonlyMap<string, FunctionSignatureArtifact>): string {
    if (directFunctions.length === 0) {
        return "";
    }

    return emitDirectFunctionWrappers(
        new Map(directFunctions.map((artifact) => [artifact.symbol, artifact.arity] as const)),
        functionSignatures
    );
}

function resolveWindowsX64DirectCallConvention(
    symbol: string,
    programSymbols: ReadonlySet<string>,
    externCallingConventions: ReadonlyMap<string, "c_ffi" | "iw_external">
): "internal" | "sysv_c_ffi" {
    if (programSymbols.has(symbol)) {
        return "internal";
    }
    const externCallingConvention = externCallingConventions.get(symbol);
    if (externCallingConvention === "iw_external") {
        return "internal";
    }
    return "sysv_c_ffi";
}

function emitClosureMakerHelpers(program: FinalBackendIRProgram, codegen: ProgramCodegenArtifacts): string {
    if (program.closureHelpers.length === 0) {
        return "";
    }
    const blocks: string[] = [];
    for (const helper of program.closureHelpers) {
        const applyArity = codegen.closureHelperApplyArities.get(helper.applySymbol);
        if (applyArity === undefined) {
            throw new Error(`C backend encountered missing closure apply arity for '${helper.applySymbol}'`);
        }
        const captureParams = helper.captureOrder.map((captureName, index) => {
            const captureType = helper.captureTypes.get(captureName);
            const captureRepresentation = captureType ? representationFromTypeValue(captureType) : "reference";
            return `${cTypeForRepresentation(captureRepresentation)} iw_capture_${sanitizeIdentifier(captureName)}_${index}`;
        });
        const envValueName = "iw_env";
        const body: string[] = [
            `static inline iw_value_t ${cClosureMakerName(helper.closureId)}(${captureParams.join(", ")}) {`,
            `    iw_value_t ${envValueName} = ${cAllocHelperName(helper.environmentLayout)}(&${cTypeInfoName(getClassTypeId(helper.environmentLayout))});`
        ];
        helper.captureOrder.forEach((captureName, index) => {
            body.push(`    ${cCastHelperName(helper.environmentLayout)}(${envValueName}, ${cStringLiteral(`closure capture ${helper.closureId}.${captureName}`)})->${cFieldName(captureName)} = iw_capture_${sanitizeIdentifier(captureName)}_${index};`);
        });
        body.push(`    return iw_closure_box(&${cTypeInfoName(closureRuntimeTypeTagId(helper.closureId))}, (uintptr_t)${cFunctionName(helper.applySymbol)}, ${envValueName}, ${applyArity}u);`);
        body.push("}");
        blocks.push(body.join("\n"));
    }
    return blocks.join("\n\n");
}

function emitTextLiteralRuntime(textLiterals: readonly TextLiteralArtifact[]): string {
    if (textLiterals.length === 0) {
        return "";
    }
    return textLiterals.map((literal) => {
        const byteLength = utf8ByteLength(literal.content);
        return [
            `static const char ${cTextBytesName(literal.referenceName)}[] = ${cStringLiteral(literal.content)};`,
            `static iw_text_value_t ${cTextValueName(literal.referenceName)} = { { 0x5445585400000001ULL, &iw_runtime_type_text }, ${byteLength}u, ${cTextBytesName(literal.referenceName)} };`
        ].join("\n");
    }).join("\n\n");
}

const X64_WEAK_ATTRIBUTE = "__attribute__((weak))";

function emitX64TextLiteralRuntime(textLiterals: readonly TextLiteralArtifact[]): string {
    if (textLiterals.length === 0) {
        return "";
    }
    return textLiterals.map((literal) => {
        const byteLength = utf8ByteLength(literal.content);
        return [
            `${X64_WEAK_ATTRIBUTE} const char ${cTextBytesName(literal.referenceName)}[] = ${cStringLiteral(literal.content)};`,
            `${X64_WEAK_ATTRIBUTE} iw_text_value_t ${x64NativeTextValueSymbol(literal.referenceName)} = { { 0x5445585400000001ULL, &iw_runtime_type_text }, ${byteLength}u, ${cTextBytesName(literal.referenceName)} };`
        ].join("\n");
    }).join("\n\n");
}

function emitX64BoxedNumberLiteralRuntime(literals: readonly BoxedNumberLiteralArtifact[]): string {
    if (literals.length === 0) {
        return "";
    }
    return literals.map((literal) => {
        const runtimeTypeSymbol = literal.typeName === "f5"
            ? "iw_runtime_type_float_f5"
            : literal.typeName === "f6"
                ? "iw_runtime_type_float_f6"
                : "iw_runtime_type_float_f7";
        const runtimeTypeTag = literal.typeName === "f5"
            ? runtimeTypeTagLiteral(F5_BOXED_RUNTIME_TYPE_TAG_ID)
            : literal.typeName === "f6"
                ? runtimeTypeTagLiteral(F6_BOXED_RUNTIME_TYPE_TAG_ID)
                : runtimeTypeTagLiteral(F7_BOXED_RUNTIME_TYPE_TAG_ID);
        const valueLiteral = literal.typeName === "f5"
            ? formatFloatingLiteral(literal.value, "f")
            : literal.typeName === "f6"
                ? formatFloatingLiteral(literal.value, "")
                : formatFloatingLiteral(literal.value, "L");
        return `${X64_WEAK_ATTRIBUTE} iw_float_value_t ${literal.symbol} = { { ${runtimeTypeTag}, &${runtimeTypeSymbol} }, ${valueLiteral} };`;
    }).join("\n");
}

function emitX64DirectCallWrappers(program: FinalBackendIRProgram, codegen: ProgramCodegenArtifacts): string {
    const programSymbols = new Set<string>([
        program.entry.symbol,
        ...program.functions.map((fn) => fn.symbol)
    ]);
    const externCallingConventions = new Map(program.externFunctions.map((fn) => [fn.symbol, fn.callingConvention] as const));
    const wrappers: string[] = [];
    for (const [symbol] of Array.from(codegen.functionArities.entries()).sort((left, right) => left[0].localeCompare(right[0]))) {
        if (resolveWindowsX64DirectCallConvention(symbol, programSymbols, externCallingConventions) === "internal") {
            continue;
        }
        const signature = codegen.functionSignatures.get(symbol);
        if (!signature) {
            throw new Error(`C backend encountered missing x64 direct-call wrapper signature for '${symbol}'`);
        }
        const params = signature.paramRepresentations.map((representation, index) => `${cTypeForRepresentation(representation)} arg${index}`).join(", ");
        const args = signature.paramRepresentations.map((_representation, index) => `arg${index}`);
        const targetCall = hasBuiltinEmitterSymbol(symbol)
            ? emitBuiltinCall(symbol, args, `x64 direct-call wrapper ${symbol}`)
            : `${cFunctionName(symbol)}(${args.join(", ")})`;
        wrappers.push([
            `${X64_WEAK_ATTRIBUTE} ${cTypeForRepresentation(signature.resultRepresentation)} IW_HOST_ABI ${x64NativeDirectCallWrapperSymbol(symbol)}(${params}) {`,
            `    return ${targetCall};`,
            "}"
        ].join("\n"));
    }
    return wrappers.join("\n\n");
}

function emitX64ClosureCallWrappers(closureCallArities: readonly number[]): string {
    if (closureCallArities.length === 0) {
        return "";
    }

    return closureCallArities.map((arity) => {
        const params = ["iw_value_t raw_closure", ...Array.from({ length: arity }, (_unused, index) => `iw_value_t arg${index}`)].join(", ");
        const forwardedArgs = Array.from({ length: arity }, (_unused, index) => `arg${index}`).join(", ");
        return [
            `${X64_WEAK_ATTRIBUTE} iw_value_t IW_HOST_ABI ${x64NativeClosureCallSymbol(arity)}(${params}) {`,
            `    return iw_closure_call_${arity}(raw_closure, ${cStringLiteral(`x64 closure_call_${arity}`)}${forwardedArgs.length > 0 ? `, ${forwardedArgs}` : ""});`,
            "}"
        ].join("\n");
    }).join("\n\n");
}

function emitX64ClosureCreateWrappers(program: FinalBackendIRProgram): string {
    if (program.closureHelpers.length === 0) {
        return "";
    }

    const blocks: string[] = [];
    for (const helper of program.closureHelpers) {
        const captureParams = helper.captureOrder.map((captureName, index) => {
            const captureType = helper.captureTypes.get(captureName);
            const captureRepresentation = captureType ? representationFromTypeValue(captureType) : "reference";
            return `${cTypeForRepresentation(captureRepresentation)} iw_capture_${sanitizeIdentifier(captureName)}_${index}`;
        });
        const captureArgs = helper.captureOrder.map((captureName, index) => `iw_capture_${sanitizeIdentifier(captureName)}_${index}`);
        blocks.push([
            `${X64_WEAK_ATTRIBUTE} iw_value_t IW_HOST_ABI ${x64NativeClosureCreateSymbol(helper.closureId)}(${captureParams.join(", ")}) {`,
            `    return ${cClosureMakerName(helper.closureId)}(${captureArgs.join(", ")});`,
            "}"
        ].join("\n"));
    }
    return blocks.join("\n\n");
}

function emitX64DirectFunctionValues(directFunctions: readonly DirectFunctionClosureArtifact[]): string {
    if (directFunctions.length === 0) {
        return "";
    }

    return directFunctions.map((artifact) => [
        `${X64_WEAK_ATTRIBUTE} iw_closure_value_t ${x64NativeDirectFunctionValueSymbol(artifact.symbol)} = {`,
        `    { ${runtimeTypeTagLiteral(artifact.runtimeTypeTagId)}, &${cTypeInfoName(artifact.runtimeTypeTagId)} },`,
        `    (uintptr_t)${cClosureTargetName(artifact.symbol)},`,
        "    (iw_value_t)1,",
        `    ${artifact.arity}u`
        ,"};"
    ].join("\n")).join("\n\n");
}

function emitX64ObjectAccessWrappers(codegen: ProgramCodegenArtifacts): string {
    const blocks: string[] = [];
    const sortedLayouts = Array.from(codegen.layouts.values()).sort((left, right) => left.className.localeCompare(right.className));
    for (const layout of sortedLayouts) {
        blocks.push([
            `${X64_WEAK_ATTRIBUTE} iw_value_t IW_HOST_ABI ${x64NativeAllocSymbol(layout.className)}(void) {`,
            `    return ${cAllocHelperName(layout.className)}(&${cTypeInfoName(layout.runtimeTypeTagId)});`,
            "}"
        ].join("\n"));
        for (const fieldName of layout.propertyOrder) {
            const fieldType = layout.propertyTypes.get(fieldName);
            const fieldRepresentation = fieldType ? representationFromTypeValue(fieldType) : "reference";
            const fieldCType = cTypeForRepresentation(fieldRepresentation);
            blocks.push([
                `${X64_WEAK_ATTRIBUTE} ${fieldCType} IW_HOST_ABI ${x64NativeObjectGetFieldSymbol(layout.className, fieldName)}(iw_value_t raw_receiver) {`,
                `    return ${cCastHelperName(layout.className)}(raw_receiver, ${cStringLiteral(`x64 object_get_field ${layout.className}.${fieldName}`)})->${cFieldName(fieldName)};`,
                "}"
            ].join("\n"));
            blocks.push([
                `${X64_WEAK_ATTRIBUTE} iw_value_t IW_HOST_ABI ${x64NativeObjectSetFieldSymbol(layout.className, fieldName)}(iw_value_t raw_receiver, ${fieldCType} raw_value) {`,
                `    ${cCastHelperName(layout.className)}(raw_receiver, ${cStringLiteral(`x64 object_set_field ${layout.className}.${fieldName}`)})->${cFieldName(fieldName)} = raw_value;`,
                "    return iw_from_i64(0);",
                "}"
            ].join("\n"));
            blocks.push([
                `${X64_WEAK_ATTRIBUTE} ${fieldCType} IW_HOST_ABI ${x64NativeSlotLoadSymbol(layout.className, fieldName)}(iw_value_t raw_receiver) {`,
                `    return ${cCastHelperName(layout.className)}(raw_receiver, ${cStringLiteral(`x64 slot_load ${layout.className}.${fieldName}`)})->${cFieldName(fieldName)};`,
                "}"
            ].join("\n"));
            blocks.push([
                `${X64_WEAK_ATTRIBUTE} iw_value_t IW_HOST_ABI ${x64NativeSlotStoreSymbol(layout.className, fieldName)}(iw_value_t raw_receiver, ${fieldCType} raw_value) {`,
                `    ${cCastHelperName(layout.className)}(raw_receiver, ${cStringLiteral(`x64 slot_store ${layout.className}.${fieldName}`)})->${cFieldName(fieldName)} = raw_value;`,
                "    return iw_from_i64(0);",
                "}"
            ].join("\n"));
        }
    }
    const sortedUnionMetadata = [...codegen.unionMetadata].sort((left, right) => left.unionTypeTagId.localeCompare(right.unionTypeTagId));
    for (const unionMetadata of sortedUnionMetadata) {
        for (const member of unionMetadata.members) {
            const contextBase = `x64 union ${unionMetadata.unionTypeTagId}/${member.runtimeTypeTagId}`;
            blocks.push([
                `${X64_WEAK_ATTRIBUTE} iw_value_t IW_HOST_ABI ${x64NativeUnionInjectSymbol(unionMetadata.unionTypeTagId, member.runtimeTypeTagId)}(iw_value_t raw_value) {`,
                `    return iw_union_box(&${cTypeInfoName(unionMetadata.unionTypeTagId)}, ${runtimeTypeTagLiteral(member.runtimeTypeTagId)}, raw_value);`,
                "}"
            ].join("\n"));
            blocks.push([
                `${X64_WEAK_ATTRIBUTE} iw_value_t IW_HOST_ABI ${x64NativeUnionHasTagSymbol(unionMetadata.unionTypeTagId, member.runtimeTypeTagId)}(iw_value_t raw_union) {`,
                `    return iw_union_has_member(raw_union, ${runtimeTypeTagLiteral(unionMetadata.unionTypeTagId)}, ${runtimeTypeTagLiteral(member.runtimeTypeTagId)}, ${cStringLiteral(`${contextBase} has_tag`)});`,
                "}"
            ].join("\n"));
            blocks.push([
                `${X64_WEAK_ATTRIBUTE} iw_value_t IW_HOST_ABI ${x64NativeUnionGetPayloadSymbol(unionMetadata.unionTypeTagId, member.runtimeTypeTagId)}(iw_value_t raw_union) {`,
                `    return iw_union_get_payload(raw_union, ${runtimeTypeTagLiteral(unionMetadata.unionTypeTagId)}, ${runtimeTypeTagLiteral(member.runtimeTypeTagId)}, ${cStringLiteral(`${contextBase} get_payload`)});`,
                "}"
            ].join("\n"));
        }
    }
    return blocks.join("\n\n");
}

function emitGcFrameRuntime(codegen: ProgramCodegenArtifacts): string {
    const descriptors = Array.from(codegen.gcFrameDescriptors.values()).sort((left, right) => left.key.localeCompare(right.key));
    if (descriptors.length === 0) {
        return "";
    }

    return descriptors.map((descriptor) => {
        const fields = descriptor.rootNames.map((rootName) => `    iw_value_t ${cFieldName(rootName)};`).join("\n");
        return [
            `typedef struct ${descriptor.structName} {`,
            "    uint64_t gc_tag1;",
            fields.length > 0 ? fields : "    iw_value_t __iw_unused;",
            "    uint64_t gc_end_confirmation;",
            `} ${descriptor.structName};`
        ].join("\n");
    }).join("\n\n");
}

function emitX64GcFrameInitHelpers(codegen: ProgramCodegenArtifacts): string {
    const descriptors = Array.from(codegen.gcFrameDescriptors.values()).sort((left, right) => left.key.localeCompare(right.key));
    if (descriptors.length === 0) {
        return "";
    }

    return descriptors.map((descriptor) => {
        const metadata = codegen.gcMetadataByCanonicalName.get(descriptor.metadataCanonicalName);
        if (!metadata) {
            throw new Error(`C backend encountered missing GC metadata for x64 GC frame '${descriptor.metadataCanonicalName}'`);
        }
        return [
            `${X64_WEAK_ATTRIBUTE} void IW_HOST_ABI ${x64NativeGcFrameInitSymbol(descriptor.key)}(void *frame_base) {`,
            `    ${descriptor.structName} *iw_gc_frame = (${descriptor.structName}*)frame_base;`,
            `    iw_gc_frame->gc_tag1 = ${u64HexLiteral(metadata.firstTagHex)};`,
            `    iw_gc_write_end_confirmation(iw_gc_frame, &${metadata.symbolName}, sizeof(*iw_gc_frame));`,
            "    iw_gc_safepoint_poll((uintptr_t)iw_gc_frame);",
            "}"
        ].join("\n");
    }).join("\n\n");
}

function emitGlobalRuntime(
    program: FinalBackendIRProgram,
    codegen: ProgramCodegenArtifacts,
    linkedGcGlobalTableSymbols: readonly string[] = [],
    exportedGcGlobalTableSymbols: readonly LinkedGcTableExportBinding[] = []
): string {
    const globalDefinitionsBySymbol = new Map(
        program.globals
            .filter((globalDef) => !globalDef.isExternal)
            .map((globalDef) => [globalDef.symbol, globalDef] as const)
    );
    const externalGlobalDeclarations = program.globals
        .filter((globalDef) => globalDef.isExternal)
        .sort((left, right) => left.symbol.localeCompare(right.symbol))
        .map((globalDef) => {
            const representation = representationFromTypeValue(globalDef.type);
            return `extern ${cTypeForRepresentation(representation)} ${cGlobalName(globalDef.symbol)} __asm__(${cStringLiteral(mangleX64AsmSymbol(globalDef.symbol))});`;
        });
    const exportedGlobalTableSymbolMap = new Map(exportedGcGlobalTableSymbols.map((binding) => [binding.tableKey, binding.exportSymbol] as const));
    const matchedExportedGlobalTableKeys = new Set<string>();
    const blocks = codegen.gcGlobalDescriptors.map((globalDescriptor) => {
        const globalMetadata = codegen.gcMetadataByCanonicalName.get(globalDescriptor.metadataCanonicalName);
        if (!globalMetadata) {
            throw new Error(`C backend encountered missing GC metadata for global aggregate '${globalDescriptor.metadataCanonicalName}'`);
        }
        const globalFieldOffsets = gcGlobalFieldOffsetMap(globalDescriptor, codegen.globalRepresentations);
        const orderedGlobals = globalDescriptor.fieldOrder.map((fieldName) => {
            const globalDef = globalDefinitionsBySymbol.get(fieldName);
            if (!globalDef) {
                throw new Error(`C backend encountered missing global definition for '${fieldName}'`);
            }
            return globalDef;
        });

        const payloadFields = orderedGlobals
            .map((globalDef) => {
                const representation = representationFromTypeValue(globalDef.type);
                return `    ${cTypeForRepresentation(representation)} ${cGlobalName(globalDef.symbol)};`;
            })
            .join("\n");
        const x64AsmAliases = orderedGlobals
            .map((globalDef) => {
                const offsetBytes = globalFieldOffsets.get(globalDef.symbol);
                if (offsetBytes === undefined) {
                    throw new Error(`C backend encountered missing global offset for '${globalDef.symbol}'`);
                }
                const asmName = mangleX64AsmSymbol(globalDef.symbol);
                return `__asm__(${cStringLiteral(`.globl ${asmName}\n.set ${asmName}, ${globalDescriptor.blockSymbolName} + ${offsetBytes}`)});`;
            })
            .join("\n");
        const fieldMacros = orderedGlobals
            .map((globalDef) => `#define ${cGlobalName(globalDef.symbol)} (${globalDescriptor.blockSymbolName}.payload.${cGlobalName(globalDef.symbol)})`)
            .join("\n");
        const referenceSlotEntries = orderedGlobals.flatMap((globalDef) => {
            const representation = representationFromTypeValue(globalDef.type);
            if (representation !== "reference") {
                return [];
            }
            return [`{ ${cStringLiteral(globalDef.symbol)}, 0ULL, offsetof(${globalDescriptor.blockStructName}, payload.${cGlobalName(globalDef.symbol)}) }`];
        });
        const referenceSlotStorage = referenceSlotEntries.length > 0
            ? `static const iw_runtime_slot_info_t ${globalDescriptor.refSlotsSymbolName}[] = { ${referenceSlotEntries.join(", ")} };`
            : `static const iw_runtime_slot_info_t *const ${globalDescriptor.refSlotsSymbolName} = NULL;`;
        const exportPointerSymbol = exportedGlobalTableSymbolMap.get(globalDescriptor.key);
        if (exportPointerSymbol !== undefined) {
            matchedExportedGlobalTableKeys.add(globalDescriptor.key);
        }

        return [
            `typedef struct ${globalDescriptor.payloadStructName} {`,
            payloadFields.length > 0 ? payloadFields : "    iw_value_t __iw_unused;",
            `} ${globalDescriptor.payloadStructName};`,
            "",
            `typedef struct ${globalDescriptor.blockStructName} {`,
            "    uint64_t gc_tag1;",
            `    ${globalDescriptor.payloadStructName} payload;`,
            "    uint64_t gc_end_confirmation;",
            `} ${globalDescriptor.blockStructName};`,
            "",
            `static ${globalDescriptor.blockStructName} ${globalDescriptor.blockSymbolName};`,
            x64AsmAliases,
            referenceSlotStorage,
            fieldMacros,
            emitGcGlobalContentPrinter(globalDescriptor, globalMetadata),
            `static inline void ${globalDescriptor.initSymbolName}(void) {`,
            `    memset(&${globalDescriptor.blockSymbolName}, 0, sizeof(${globalDescriptor.blockSymbolName}));`,
            `    ${globalDescriptor.blockSymbolName}.gc_tag1 = ${u64HexLiteral(globalMetadata.firstTagHex)};`,
            "    iw_gc_write_end_confirmation(",
            `        &${globalDescriptor.blockSymbolName},`,
            `        &${globalMetadata.symbolName},`,
            `        sizeof(${globalDescriptor.blockStructName})`,
            "    );",
            "}",
            `static const iw_gc_global_table_t ${globalDescriptor.tableSymbolName} = { ${cStringLiteral(globalDescriptor.metadataCanonicalName)}, (const void*)&${globalDescriptor.blockSymbolName}, ${gcMetadataRefLiteral(globalMetadata)}, ${globalMetadata.slotCount}u, ${referenceSlotEntries.length > 0 ? globalDescriptor.refSlotsSymbolName : "NULL"}, ${globalDescriptor.livePrinterSymbolName} };`,
            exportPointerSymbol === undefined
                ? ""
                : `const iw_gc_global_table_t *const ${exportPointerSymbol} = &${globalDescriptor.tableSymbolName};`
        ].filter((line) => line.length > 0).join("\n");
    });
    const missingExportedGlobalTableLines = exportedGcGlobalTableSymbols
        .filter((binding) => !matchedExportedGlobalTableKeys.has(binding.tableKey))
        .map((binding) => `const iw_gc_global_table_t *const ${binding.exportSymbol} = NULL;`);
    const linkedTableDeclarations = linkedGcGlobalTableSymbols.map((symbol) => `extern const iw_gc_global_table_t *const ${symbol};`);
    const allGlobalTables = [
        ...codegen.gcGlobalDescriptors.map((descriptor) => `&${descriptor.tableSymbolName}`),
        ...linkedGcGlobalTableSymbols
    ];
    const globalTableArraySize = allGlobalTables.length === 0 ? 1 : allGlobalTables.length;
    const globalTableInitLines = allGlobalTables.map((tableExpr, index) => `    iw_gc_all_global_tables[${index}] = ${tableExpr};`);

    return [
        ...externalGlobalDeclarations,
        ...blocks,
        ...missingExportedGlobalTableLines,
        ...linkedTableDeclarations,
        `static const size_t iw_gc_all_global_table_count = ${allGlobalTables.length}u;`,
        `static const iw_gc_global_table_t *iw_gc_all_global_tables[${globalTableArraySize}u];`,
        "static inline void iw_gc_init_all_global_tables(void) {",
        ...globalTableInitLines,
        "}"
    ].join("\n\n");
}

function emitGcMetadataRuntime(
    codegen: ProgramCodegenArtifacts,
    linkedGcMetadataTableSymbols: readonly string[] = [],
    exportedGcMetadataTableSymbols: readonly LinkedGcTableExportBinding[] = []
): string {
    const metadataLines = codegen.gcMetadata.map((metadata) => {
        const kindLiteral = metadata.kind === "heap"
            ? "IW_GC_METADATA_HEAP"
            : metadata.kind === "frame"
                ? "IW_GC_METADATA_FRAME"
                : "IW_GC_METADATA_GLOBAL";
        const lengthKindLiteral = metadata.lengthKind === "none"
            ? "IW_GC_LENGTH_NONE"
            : metadata.lengthKind === "i64"
                ? "IW_GC_LENGTH_I64"
                : "IW_GC_LENGTH_U32";
        const variableMemberKindLiteral = metadata.variableMemberKind === "none"
            ? "IW_GC_VARIABLE_MEMBER_NONE"
            : metadata.variableMemberKind === "value"
                ? "IW_GC_VARIABLE_MEMBER_VALUE"
                : "IW_GC_VARIABLE_MEMBER_BYTE";
        return `static const iw_gc_metadata_entry_t ${metadata.symbolName} = { ${u64HexLiteral(metadata.tableUuidHiHex)}, ${u64HexLiteral(metadata.tableUuidLoHex)}, ${u64HexLiteral(metadata.tableUuidHash64Hex)}, ${u64HexLiteral(metadata.structUuidHiHex)}, ${u64HexLiteral(metadata.structUuidLoHex)}, ${u64HexLiteral(metadata.firstTagHex)}, ${u64HexLiteral(metadata.structUuidHash64Hex)}, ${u64HexLiteral(metadata.layoutHashHex)}, ${u64HexLiteral(metadata.staticInfoHashHex)}, ${u64HexLiteral(metadata.endConfirmationHex)}, ${cStringLiteral(metadata.displayName)}, ${kindLiteral}, ${lengthKindLiteral}, ${metadata.fixedSizeBytesExpr}, ${metadata.lengthOffsetBytesExpr}, ${metadata.lengthScaleBytesExpr}, ${metadata.lengthBiasBytesExpr}, ${variableMemberKindLiteral}, ${cStringLiteral(metadata.variableMemberLabel)}, ${metadata.slotCount}u, ${metadata.structureOnly ? 1 : 0}u };`;
    });
    const metadataKeysName = "iw_gc_metadata_keys";
    const metadataEntriesName = "iw_gc_metadata_entries";
    const metadataCollectionSymbolName = "iw_gc_metadata_table_all_keys";
    const metadataKeyArrayLine = codegen.gcMetadataTables.length > 0
        ? `static const iw_gc_metadata_key_t ${metadataKeysName}[] = { ${codegen.gcMetadataTables.map((table) => `{ ${u64HexLiteral(table.uuidHiHex)}, ${u64HexLiteral(table.uuidLoHex)}, ${u64HexLiteral(table.uuidHash64Hex)}, ${cStringLiteral(table.displayName)} }`).join(", ")} };`
        : "";
    const metadataEntryArrayLine = codegen.gcMetadata.length > 0
        ? `static const iw_gc_metadata_entry_t *const ${metadataEntriesName}[] = { ${codegen.gcMetadata.map((entry) => `&${entry.symbolName}`).join(", ")} };`
        : "";
    const exportedMetadataTableSymbolMap = new Map(exportedGcMetadataTableSymbols.map((binding) => [binding.tableKey, binding.exportSymbol] as const));
    const matchedExportedMetadataTableKeys = new Set<string>();
    const metadataKeySet = new Set(codegen.gcMetadataTables.map((table) => table.key));
    const metadataTableLine = `static iw_gc_metadata_table_t ${metadataCollectionSymbolName} = { ${cStringLiteral("all-metadata-keys")}, ${codegen.gcMetadataTables.length}u, ${codegen.gcMetadataTables.length > 0 ? metadataKeysName : "NULL"}, ${codegen.gcMetadata.length}u, ${codegen.gcMetadata.length > 0 ? metadataEntriesName : "NULL"} };`;
    const metadataExportLines = exportedGcMetadataTableSymbols.map((binding) => {
        if (metadataKeySet.has(binding.tableKey)) {
            matchedExportedMetadataTableKeys.add(binding.tableKey);
            return `iw_gc_metadata_table_t *const ${binding.exportSymbol} = &${metadataCollectionSymbolName};`;
        }
        return "";
    }).filter((line) => line.length > 0);
    for (const table of codegen.gcMetadataTables) {
        const exportPointerSymbol = exportedMetadataTableSymbolMap.get(table.key);
        if (exportPointerSymbol !== undefined) {
            matchedExportedMetadataTableKeys.add(table.key);
        }
    }
    const missingExportedMetadataTableLines = exportedGcMetadataTableSymbols
        .filter((binding) => !matchedExportedMetadataTableKeys.has(binding.tableKey))
        .map((binding) => `iw_gc_metadata_table_t *const ${binding.exportSymbol} = NULL;`);
    const runtimeTypeBindings = codegen.gcMetadata
        .filter((metadata) => metadata.runtimeTypeTagId !== undefined)
        .sort((left, right) => left.runtimeTypeTagId!.localeCompare(right.runtimeTypeTagId!))
        .map((metadata) => `{ ${runtimeTypeTagLiteral(metadata.runtimeTypeTagId!)}, ${gcMetadataRefLiteral(metadata)} }`);
    const linkedMetadataTableDeclarations = linkedGcMetadataTableSymbols.map((symbol) => `extern iw_gc_metadata_table_t *const ${symbol};`);
    const allMetadataTables = [
        `&${metadataCollectionSymbolName}`,
        ...linkedGcMetadataTableSymbols
    ];
    const metadataTableArraySize = allMetadataTables.length === 0 ? 1 : allMetadataTables.length;
    const metadataTableInitLines = allMetadataTables.map((tableExpr, index) => `    iw_gc_all_metadata_tables[${index}] = ${tableExpr};`);

    return [
        ...metadataLines,
        metadataKeyArrayLine,
        metadataEntryArrayLine,
        metadataTableLine,
        ...metadataExportLines,
        ...missingExportedMetadataTableLines,
        ...linkedMetadataTableDeclarations,
        `static const size_t iw_gc_all_metadata_table_count = ${allMetadataTables.length}u;`,
        `static iw_gc_metadata_table_t *iw_gc_all_metadata_tables[${metadataTableArraySize}u];`,
        "static inline void iw_gc_init_all_metadata_tables(void) {",
        ...metadataTableInitLines,
        "    iw_gc_rebuild_metadata_lookup_indexes();",
        "}",
        `static const iw_gc_runtime_type_binding_t iw_gc_runtime_type_bindings[] = { ${runtimeTypeBindings.join(", ")} };`
    ].join("\n\n");
}

const LINUX_C_GC_PRINT_PASS_DEPENDENCIES: WindowsCGcPrintPassDependencies = {
    cFieldName,
    cGlobalName,
    cStringLiteral,
    cStructName,
    runtimeTypeTagLiteral
};

function emitGcGlobalContentPrinter(
    globalDescriptor: GcGlobalDescriptorArtifact,
    globalMetadata: GcMetadataArtifact
): string {
    return emitWindowsCGcGlobalContentPrinter(globalDescriptor, globalMetadata, LINUX_C_GC_PRINT_PASS_DEPENDENCIES);
}

function emitGcRuntimeSupport(
    codegen: ProgramCodegenArtifacts,
    linkedRuntimeInitSymbols: readonly string[] = [],
    exportedRuntimeInitSymbol?: string,
    exportedRuntimeInitCallLine?: string
): string {
    const globalInitLines: readonly string[] = codegen.gcGlobalDescriptors.map((descriptor: GcGlobalDescriptorArtifact): string => `    ${descriptor.initSymbolName}();`);
    return [
        emitWindowsCGcValidationPassRuntime(),
        emitWindowsCGcPrintPassRuntime(codegen, LINUX_C_GC_PRINT_PASS_DEPENDENCIES),
        emitWindowsCGcCollectCoreRuntime({
            globalInitLines,
            linkedRuntimeInitSymbols,
            exportedRuntimeInitSymbol,
            exportedRuntimeInitCallLine
        })
    ].join("\n\n");
}

function emitRuntimeDescriptors(codegen: ProgramCodegenArtifacts): string {
    const blocks: string[] = [];
    const typeInfoNames: string[] = [];

    for (const unionMetadata of codegen.unionMetadata) {
        const unionMembersName = cUnionMembersName(unionMetadata.unionTypeTagId);
        const gcSlotsName = cSlotsName(`${unionMetadata.unionTypeTagId}_gc`);
        blocks.push(`static const iw_runtime_union_member_info_t ${unionMembersName}[] = { ${unionMetadata.members.map((member) => `{ ${runtimeTypeTagLiteral(member.runtimeTypeTagId)} }`).join(", ")} };`);
        blocks.push(`static const iw_runtime_slot_info_t ${gcSlotsName}[] = { { \"payload\", 0ULL, offsetof(iw_union_value_t, payload) } };`);
        const typeInfoName = cTypeInfoName(unionMetadata.unionTypeTagId);
        typeInfoNames.push(`&${typeInfoName}`);
        blocks.push(`static const iw_runtime_type_info_t ${typeInfoName} = { ${runtimeTypeTagLiteral(unionMetadata.unionTypeTagId)}, IW_RUNTIME_KIND_UNION, ${cStringLiteral(unionMetadata.unionTypeTagId)}, 1u, ${gcSlotsName}, ${unionMetadata.members.length}u, ${unionMembersName}, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };`);
    }

    for (const layout of Array.from(codegen.layouts.values()).sort((left, right) => left.className.localeCompare(right.className))) {
        const slotsName = cSlotsName(layout.runtimeTypeTagId);
        const methodsName = cMethodsName(layout.runtimeTypeTagId);
        const slotEntries = layout.propertyOrder.flatMap((fieldName) => {
            const fieldType = layout.propertyTypes.get(fieldName);
            if (!fieldType) {
                throw new Error(`C backend encountered missing property type for '${layout.className}.${fieldName}'`);
            }
            if (representationFromTypeValue(fieldType) !== "reference") {
                return [];
            }
            return [`{ ${cStringLiteral(fieldName)}, ${runtimeTypeTagLiteral(getRuntimeTypeId(fieldType))}, offsetof(${cStructName(layout.className)}, ${cFieldName(fieldName)}) }`];
        });
        const methodEntries = layout.methodOrder.map((methodName) => {
            const methodType = layout.methodTypes.get(methodName);
            const methodSymbol = layout.methodSymbols.get(methodName);
            if (!methodType || !methodSymbol) {
                throw new Error(`C backend encountered missing method metadata for '${layout.className}.${methodName}'`);
            }
            return `{ ${cStringLiteral(methodName)}, ${cStringLiteral(methodSymbol)}, ${methodType.paramTypes.length}u }`;
        });
        if (slotEntries.length > 0) {
            blocks.push(`static const iw_runtime_slot_info_t ${slotsName}[] = { ${slotEntries.join(", ")} };`);
        }
        if (methodEntries.length > 0) {
            blocks.push(`static const iw_runtime_method_info_t ${methodsName}[] = { ${methodEntries.join(", ")} };`);
        }
        const typeInfoName = cTypeInfoName(layout.runtimeTypeTagId);
        typeInfoNames.push(`&${typeInfoName}`);
        blocks.push(`static const iw_runtime_type_info_t ${typeInfoName} = { ${runtimeTypeTagLiteral(layout.runtimeTypeTagId)}, IW_RUNTIME_KIND_CLASS, ${cStringLiteral(layout.className)}, ${slotEntries.length}u, ${slotEntries.length > 0 ? slotsName : "NULL"}, 0u, NULL, ${methodEntries.length}u, ${methodEntries.length > 0 ? methodsName : "NULL"}, 0u, NULL, 0u, NULL, 0ULL };`);
    }

    const closureEnvSlotName = cSlotsName("closure_gc");
    blocks.push(`static const iw_runtime_slot_info_t ${closureEnvSlotName}[] = { { \"env\", 0ULL, offsetof(iw_closure_value_t, env) } };`);
    for (const closure of codegen.closureDescriptors) {
        const capturesName = cSlotsName(`${closure.runtimeTypeTagId}_captures`);
        const referenceCaptureEntries = closure.environmentLayout
            ? closure.captureOrder.flatMap((captureName, index) => {
                const captureTypeTagId = closure.captureTypeTagIds[index];
                if (IMMEDIATE_RUNTIME_TYPE_TAG_IDS.has(captureTypeTagId)) {
                    return [];
                }
                return [`{ ${cStringLiteral(captureName)}, ${runtimeTypeTagLiteral(captureTypeTagId)}, offsetof(${cStructName(closure.environmentLayout!)}, ${cFieldName(captureName)}) }`];
            })
            : [];
        const captureGcCount = referenceCaptureEntries.length;
        if (closure.captureOrder.length > 0 && closure.environmentLayout) {
            if (referenceCaptureEntries.length > 0) {
                blocks.push(`static const iw_runtime_slot_info_t ${capturesName}[] = { ${referenceCaptureEntries.join(", ")} };`);
            }
        }
        const typeInfoName = cTypeInfoName(closure.runtimeTypeTagId);
        typeInfoNames.push(`&${typeInfoName}`);
        const envTag = closure.environmentLayout ? runtimeTypeTagLiteral(getClassTypeId(closure.environmentLayout)) : "0ULL";
        blocks.push(`static const iw_runtime_type_info_t ${typeInfoName} = { ${runtimeTypeTagLiteral(closure.runtimeTypeTagId)}, IW_RUNTIME_KIND_CLOSURE, ${cStringLiteral(closure.debugName)}, 1u, ${closureEnvSlotName}, 0u, NULL, 0u, NULL, ${captureGcCount}u, ${captureGcCount > 0 ? capturesName : "NULL"}, ${closure.arity}u, ${cStringLiteral(closure.applySymbol)}, ${envTag} };`);
    }

    for (const builtin of BUILTIN_RUNTIME_TYPES) {
        typeInfoNames.push(`&${builtin.symbolName}`);
    }

    blocks.push(`static const iw_runtime_type_info_t *const iw_runtime_all_types[] = { ${typeInfoNames.join(", ")} };`);
    blocks.push("static inline const iw_runtime_type_info_t* iw_runtime_lookup_compiled_type(uint64_t runtime_tag) { return iw_runtime_lookup_type(runtime_tag, iw_runtime_all_types, sizeof(iw_runtime_all_types) / sizeof(iw_runtime_all_types[0])); }");
    return blocks.join("\n\n");
}

function emitHostArgvArrayHelper(): string {
    return [
        "static inline iw_value_t __iw_host_build_entry_args(int argc, char **argv) {",
        "    int64_t shell_argc = argc > 1 ? (int64_t)(argc - 1) : 0;",
        "    size_t total_size = sizeof(iw_array_value_t) + ((size_t)shell_argc * sizeof(iw_value_t));",
        "    iw_gc_metadata_ref_t metadata_ref = iw_gc_metadata_ref_for_runtime_type(iw_runtime_type_array.tag);",
        "    iw_array_value_t *array = (iw_array_value_t*)iw_gc_allocate(total_size, &iw_runtime_type_array, metadata_ref, \"host argv init\");",
        "    array->length = shell_argc;",
        "    for (int64_t index = 0; index < shell_argc; index += 1) {",
        "        const char *arg = argv[index + 1] == NULL ? \"\" : argv[index + 1];",
        "        array->items[index] = iw_text_copy_bytes(arg, strlen(arg), \"host argv value\");",
        "    }",
        "    iw_gc_publish_allocation((iw_heap_header_t*)array, total_size, metadata_ref);",
        "    return (iw_value_t)(intptr_t)array;",
        "}"
    ].join("\n");
}

function emitHostEntryWrapper(program: FinalBackendIRProgram, exported = false): string {
    if (program.entry.params.length > 1) {
        throw new Error(`C backend host wrapper only supports entry arity 0 or 1, got ${program.entry.params.length}`);
    }

    const prefix = exported ? "" : "static inline ";
    const resultType = cTypeForRepresentation(program.entry.resultRepresentation);
    const body = program.entry.params.length === 0
        ? [
            "    (void)argc;",
            "    (void)argv;",
            `    return ${cFunctionName(program.entry.symbol)}();`
        ]
        : [`    return ${cFunctionName(program.entry.symbol)}(__iw_host_build_entry_args(argc, argv));`];

    return [
        `${prefix}${resultType} IW_HOST_ABI __iw_host_entry_main(int argc, char **argv) {`,
        ...body,
        "}"
    ].join("\n");
}

export function debugBuildGcAuthSnapshotFromFinalBackendIR(
    program: FinalBackendIRProgram,
    extraLayouts?: ReadonlyMap<string, LoweringClassLayout>
): GcAuthSnapshot {
    const codegen = buildProgramCodegenArtifacts(program, extraLayouts);
    return {
        tables: codegen.gcMetadataTables.map((table) => ({
            key: table.key,
            displayName: table.displayName,
            uuidHash64Hex: table.uuidHash64Hex,
            entryCount: table.entries.length
        })),
        entries: codegen.gcMetadata.map((metadata) => ({
            tableKey: metadata.tableKey,
            canonicalName: metadata.canonicalName,
            kind: metadata.kind,
            firstTagHex: metadata.firstTagHex,
            firstTagStructHash48Hex: metadata.firstTagHex.slice(0, 12),
            firstTagConfirmation16Hex: metadata.firstTagHex.slice(12),
            structUuidHash64Hex: metadata.structUuidHash64Hex,
            tableUuidHash64Hex: metadata.tableUuidHash64Hex,
            endConfirmationHex: metadata.endConfirmationHex
        }))
    };
}

export function generateCFromFinalBackendIR(program: FinalBackendIRProgram, extraSupportSource = ""): string {
    const sources = generateCBackendSources(program, extraSupportSource);
    return [
        sources.runtimeSource,
        "",
        sources.driverSource
            .split("\n")
            .filter((line) => line !== '#include "ironwall.h"')
            .join("\n")
    ].join("\n");
}

export function generateCBackendSources(program: FinalBackendIRProgram, extraSupportSource = ""): CBackendSources {
    const functionNames = new Set<string>([
        program.entry.symbol,
        ...program.functions.map((fn) => fn.symbol),
        ...program.externFunctions.map((fn) => fn.symbol)
    ]);
    const codegen = buildProgramCodegenArtifacts(program);
    const hostInteropDeps = buildWindowsCHostInteropDependencies((rootNames, bodyLines, indentLevel) => emitStandaloneGcScopedBlock(rootNames, bodyLines, codegen, indentLevel));
    const stdSysFfiRuntime = emitWindowsCDeclaredStdSysFfiRuntime(program, hostInteropDeps);
    const declaredCHeapHostHelperRuntime = emitWindowsCDeclaredCHeapHostHelperRuntime(program);
    const exportedIwFunctionRuntime = emitWindowsCExportedIwFunctionRuntime(program, hostInteropDeps);
    const allFunctions = [...program.functions, program.entry];
    const prototypes = [...allFunctions.map((fn) => emitPrototype(fn)), ...program.externFunctions.map((fn) => emitExternPrototype(fn))]
        .join("\n");
    const classRuntime = Array.from(codegen.layouts.values())
        .sort((left, right) => left.className.localeCompare(right.className))
        .map((layout) => emitClassRuntime(layout))
        .join("\n\n");
    const gcFrameRuntime = emitGcFrameRuntime(codegen);
    const closureRuntime = [
        emitClosureCallHelpers(codegen.closureCallArities),
        emitSelectedDirectFunctionWrappers(codegen.directFunctions, codegen.functionSignatures),
        emitClosureMakerHelpers(program, codegen)
    ].filter((text) => text.length > 0).join("\n\n");
    const textRuntime = emitTextLiteralRuntime(codegen.textLiterals);
    const globalRuntime = emitGlobalRuntime(program, codegen);
    const runtimeDescriptors = emitRuntimeDescriptors(codegen);
    const gcMetadataRuntime = emitGcMetadataRuntime(codegen);
    const gcRuntimeSupport = emitGcRuntimeSupport(codegen);
    const hostArgvRuntime = program.entry.params.length === 0 ? "" : emitHostArgvArrayHelper();
    const hostEntryWrapper = emitHostEntryWrapper(program, true);
    const emittedFunctions = allFunctions
        .map((fn) => emitFunction(fn, functionNames, codegen))
        .join("\n\n");
    const sourcePass1 = performWindowsCBackendSourcePass1CollectSections({
        builtinHelpers: BUILTIN_HELPERS,
        classRuntime,
        gcFrameRuntime,
        runtimeDescriptors,
        gcMetadataRuntime,
        globalRuntime,
        stdSysFfiRuntime,
        declaredCHeapHostHelperRuntime,
        exportedIwFunctionRuntime,
        gcRuntimeSupport,
        prototypes,
        hostArgvRuntime,
        hostEntryWrapper,
        closureRuntime,
        textRuntime,
        extraSupportSource,
        emittedFunctions,
        driverResultType: cTypeForRepresentation(program.entry.resultRepresentation)
    });
    const runtimeAndDriverSource = performWindowsCBackendSourcePass2AssembleRuntimeAndDriverSource(sourcePass1);
    const splitSources = performWindowsCBackendSourcePass3SplitRuntimeAndDriverSource(runtimeAndDriverSource, sourcePass1.driverResultType);
    return {
        headerSource: generateCHeaderFromFinalBackendIR(program),
        runtimeSource: splitSources.runtimeSource,
        driverSource: splitSources.driverSource
    };
}

export function generateX64NativeSupportCFromFinalBackendIR(
    program: FinalBackendIRProgram,
    extraSupportSource = "",
    extraLayouts?: ReadonlyMap<string, LoweringClassLayout>,
    assemblyText = "",
    options: X64NativeSupportOptions = {}
): string {
    const baseCodegen = buildProgramCodegenArtifactsWithOptions(program, extraLayouts, options.sharedGcMetadataTableKeyOverride);
    const codegen = augmentCodegenWithX64AssemblyGcFrames(baseCodegen, assemblyText);
    const hostInteropDeps = buildWindowsCHostInteropDependencies((rootNames, bodyLines, indentLevel) => emitStandaloneGcScopedBlock(rootNames, bodyLines, codegen, indentLevel));
    const stdSysFfiRuntime = emitWindowsCDeclaredStdSysFfiRuntime(program, hostInteropDeps);
    const declaredCHeapHostHelperRuntime = emitWindowsCDeclaredCHeapHostHelperRuntime(program);
    const exportedIwFunctionRuntime = emitWindowsCExportedIwFunctionRuntime(program, hostInteropDeps);
    let exportedRuntimeInitCallLine: string | undefined;
    if (options.exportedRuntimeInitSymbol !== undefined) {
        if (program.entry.params.length !== 0) {
            throw new Error("x64 precompiled library unit init requires a zero-argument lowered entry body");
        }
        exportedRuntimeInitCallLine = `    (void)${cFunctionName(program.entry.symbol)}();`;
    }
    const boxedNumberLiterals = new Map<string, BoxedNumberLiteralArtifact>();
    collectX64BoxedNumberLiterals(program).forEach((literal) => boxedNumberLiterals.set(literal.symbol, literal));
    collectX64BoxedNumberLiteralsFromAssembly(assemblyText).forEach((literal) => boxedNumberLiterals.set(literal.symbol, literal));
    const boxedNumberRuntime = emitX64BoxedNumberLiteralRuntime(Array.from(boxedNumberLiterals.values()).sort((left, right) => left.symbol.localeCompare(right.symbol)));
    const compiledPrototypes = [
        emitX64CompiledPrototype(program.entry, options.entryAsmSymbolOverride ?? X64_NATIVE_ENTRY_SYMBOL),
        ...program.functions.map((fn) => emitX64CompiledPrototype(fn)),
        ...program.externFunctions.map((fn) => emitX64ExternPrototype(fn))
    ].join("\n");
    const classRuntime = Array.from(codegen.layouts.values())
        .sort((left, right) => left.className.localeCompare(right.className))
        .map((layout) => emitClassRuntime(layout))
        .join("\n\n");
    const gcFrameRuntime = emitGcFrameRuntime(codegen);
    const gcFrameInitHelpers = emitX64GcFrameInitHelpers(codegen);
    const closureRuntime = [
        emitClosureCallHelpers(codegen.closureCallArities),
        emitSelectedDirectFunctionWrappers(codegen.directFunctions, codegen.functionSignatures),
        emitClosureMakerHelpers(program, codegen)
    ].filter((text) => text.length > 0).join("\n\n");
    const textRuntime = emitX64TextLiteralRuntime(codegen.textLiterals);
    const directFunctionRuntime = emitX64DirectFunctionValues(codegen.directFunctions);
    const globalRuntime = emitGlobalRuntime(
        program,
        codegen,
        options.linkedGcGlobalTableSymbols ?? [],
        options.exportedGcGlobalTableSymbols ?? []
    );
    const runtimeDescriptors = emitRuntimeDescriptors(codegen);
    const gcMetadataRuntime = emitGcMetadataRuntime(
        codegen,
        options.linkedGcMetadataTableSymbols ?? [],
        options.exportedGcMetadataTableSymbols ?? []
    );
    const gcRuntimeSupport = emitGcRuntimeSupport(
        codegen,
        options.linkedRuntimeInitSymbols ?? [],
        options.exportedRuntimeInitSymbol,
        exportedRuntimeInitCallLine
    );
    const hostArgvRuntime = options.omitHostEntryWrapper || program.entry.params.length === 0 ? "" : emitHostArgvArrayHelper();
    const hostEntryWrapper = options.omitHostEntryWrapper ? "" : emitHostEntryWrapper(program, true);
    const supportWrappers = [
        gcFrameInitHelpers,
        emitX64ClosureCallWrappers(codegen.closureCallArities),
        emitX64ClosureCreateWrappers(program),
        emitX64DirectCallWrappers(program, codegen),
        emitX64ObjectAccessWrappers(codegen)
    ].filter((text) => text.length > 0).join("\n\n");
    const sourcePass1 = performWindowsCBackendX64SupportPass1CollectSections({
        builtinHelpers: BUILTIN_HELPERS,
        classRuntime,
        gcFrameRuntime,
        runtimeDescriptors,
        gcMetadataRuntime,
        globalRuntime,
        compiledPrototypes,
        stdSysFfiRuntime,
        declaredCHeapHostHelperRuntime,
        exportedIwFunctionRuntime,
        gcRuntimeSupport,
        hostArgvRuntime,
        hostEntryWrapper,
        closureRuntime,
        textRuntime,
        boxedNumberRuntime,
        directFunctionRuntime,
        extraSupportSource,
        supportWrappers,
        omitRuntimeInit: options.omitRuntimeInit ?? false
    });
    return performWindowsCBackendX64SupportPass2AssembleSource(sourcePass1);
}
