import type {
    BackendFunctionIR,
    BackendValueRepresentation,
    FinalBackendIRProgram
} from "./Backend-Windows-IR-Shared";
import type { LoweringExportedIwFunction } from "../Lowering-Frontend-Shared";
import { parseDeclaredCFunctionName } from "../DeclaredCFunctionName";
import { GenericClassInstanceTypeValue, PrimitiveTypeValue, type TypeValue } from "./Backend-Windows-Typecheck-Core";

interface DeclaredStdSysFfiRename {
    readonly helperName: string;
    readonly symbol: string;
    readonly params: readonly string[];
    readonly paramRepresentations: readonly BackendValueRepresentation[];
    readonly resultRepresentation: BackendValueRepresentation;
}

interface DeclaredCHeapHostHelperRequirements {
    readonly needsS3: boolean;
    readonly needsArrayS3: boolean;
    readonly needsArrayI5: boolean;
}

interface ExportedIwFunctionArtifact {
    readonly metadata: LoweringExportedIwFunction;
    readonly fn: BackendFunctionIR;
}

export interface WindowsCHostInteropDependencies {
    readonly builtinSharedSyscallHelpers: string;
    readonly builtinSharedThreadHelpers: string;
    readonly cFunctionName: (symbol: string) => string;
    readonly cParamName: (name: string) => string;
    readonly cStringLiteral: (text: string) => string;
    readonly cTypeForRepresentation: (representation: BackendValueRepresentation) => string;
    readonly cZeroValueForRepresentation: (representation: BackendValueRepresentation) => string;
    readonly emitStandaloneGcScopedBlock: (rootNames: readonly string[], bodyLines: readonly string[], indentLevel: number) => string;
    readonly integerImmediateExpression: (typeName: string, expression: string) => string;
    readonly integerValueExpression: (typeName: string, expression: string) => string;
    readonly representationFromTypeValue: (type: TypeValue) => BackendValueRepresentation;
}

function buildDeclaredStdSysHelperName(functionName: string): string | null {
    if (
        !functionName.startsWith("iw_sys_")
        && !functionName.startsWith("iw_thread_")
        && !functionName.startsWith("iw_mutex_")
        && !functionName.startsWith("iw_cond_")
        && !functionName.startsWith("iw_tls_")
        && !functionName.startsWith("iw_sem_")
        && functionName !== "iw_sleep_ms"
    ) {
        return null;
    }
    return `iw_builtin_${functionName.slice(3)}`;
}

function collectDeclaredStdSysFfiRenames(program: FinalBackendIRProgram): readonly DeclaredStdSysFfiRename[] {
    const renamesByHelperName = new Map<string, DeclaredStdSysFfiRename>();
    for (const fn of program.externFunctions) {
        if (fn.callingConvention !== "c_ffi") {
            continue;
        }
        const parsed = parseDeclaredCFunctionName(fn.symbol);
        if (parsed === null) {
            continue;
        }
        const helperName = buildDeclaredStdSysHelperName(parsed.functionName);
        if (helperName === null) {
            continue;
        }
        const existing = renamesByHelperName.get(helperName);
        if (existing !== undefined && existing.symbol !== fn.symbol) {
            throw new Error(`C backend found multiple declared C FFI symbols for shared std sys helper '${parsed.functionName}': '${existing.symbol}' and '${fn.symbol}'`);
        }
        renamesByHelperName.set(helperName, {
            helperName,
            symbol: fn.symbol,
            params: fn.params,
            paramRepresentations: fn.paramRepresentations,
            resultRepresentation: fn.resultRepresentation
        });
    }
    return Array.from(renamesByHelperName.values()).sort((left, right) => left.helperName.localeCompare(right.helperName));
}

function emitDeclaredStdSysFfiWrapper(rename: DeclaredStdSysFfiRename, deps: WindowsCHostInteropDependencies): string {
    const params = rename.params
        .map((param, index) => `${deps.cTypeForRepresentation(rename.paramRepresentations[index] ?? "reference")} ${deps.cParamName(param)}`)
        .join(", ");
    const args = rename.params.map((param) => deps.cParamName(param)).join(", ");
    return `${deps.cTypeForRepresentation(rename.resultRepresentation)} ${rename.symbol}(${params}) { return ${rename.helperName}(${args}); }`;
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

function collectDeclaredCHeapHostHelperRequirementsFromType(
    type: TypeValue,
    requirements: { needsS3: boolean; needsArrayS3: boolean; needsArrayI5: boolean; }
): void {
    if (isPrimitiveTypeNamed(type, "s3")) {
        requirements.needsS3 = true;
        return;
    }
    if (isBuiltinArrayOfPrimitive(type, "s3")) {
        requirements.needsS3 = true;
        requirements.needsArrayS3 = true;
        return;
    }
    if (isBuiltinArrayOfPrimitive(type, "i5")) {
        requirements.needsArrayI5 = true;
    }
}

function collectDeclaredCHeapHostHelperRequirements(program: FinalBackendIRProgram): DeclaredCHeapHostHelperRequirements {
    const requirements = {
        needsS3: false,
        needsArrayS3: false,
        needsArrayI5: false
    };
    for (const fn of program.externFunctions) {
        if (fn.callingConvention !== "c_ffi") {
            continue;
        }
        fn.paramTypes.forEach((type) => collectDeclaredCHeapHostHelperRequirementsFromType(type, requirements));
        collectDeclaredCHeapHostHelperRequirementsFromType(fn.resultType, requirements);
    }
    for (const fn of program.metadata.exportedIwFunctions) {
        fn.paramTypes.forEach((type) => collectDeclaredCHeapHostHelperRequirementsFromType(type, requirements));
        collectDeclaredCHeapHostHelperRequirementsFromType(fn.resultType, requirements);
    }
    return requirements;
}

function collectExportedIwFunctionArtifacts(program: FinalBackendIRProgram): readonly ExportedIwFunctionArtifact[] {
    if (program.metadata.exportedIwFunctions.length === 0) {
        return [];
    }

    const functionsBySymbol = new Map<string, BackendFunctionIR>([
        [program.entry.symbol, program.entry],
        ...program.functions.map((fn) => [fn.symbol, fn] as const)
    ]);

    return program.metadata.exportedIwFunctions
        .map((metadata) => {
            const fn = functionsBySymbol.get(metadata.concreteSymbol);
            if (fn === undefined) {
                throw new Error(`C backend could not find exported IW function body for '${metadata.exportSymbol}' (expected symbol '${metadata.concreteSymbol}')`);
            }
            return { metadata, fn };
        })
        .sort((left, right) => left.metadata.exportSymbol.localeCompare(right.metadata.exportSymbol));
}

function collectExportedIwHostHelperRequirements(program: FinalBackendIRProgram): DeclaredCHeapHostHelperRequirements {
    const requirements = {
        needsS3: false,
        needsArrayS3: false,
        needsArrayI5: false
    };
    for (const fn of program.metadata.exportedIwFunctions) {
        fn.paramTypes.forEach((type) => collectDeclaredCHeapHostHelperRequirementsFromType(type, requirements));
        collectDeclaredCHeapHostHelperRequirementsFromType(fn.resultType, requirements);
    }
    return requirements;
}

function exportedIwHostParamType(type: TypeValue): string {
    if (isPrimitiveTypeNamed(type, "i5")) {
        return "int32_t";
    }
    if (isPrimitiveTypeNamed(type, "s3")) {
        return "const char *";
    }
    if (isBuiltinArrayOfPrimitive(type, "i5")) {
        return "iw_host_array_i5_t";
    }
    if (isBuiltinArrayOfPrimitive(type, "s3")) {
        return "iw_host_array_s3_t";
    }
    throw new Error(`C backend encountered unsupported exported IW parameter type '${type.hash()}'`);
}

function exportedIwHostReturnType(type: TypeValue): string {
    if (isPrimitiveTypeNamed(type, "i5")) {
        return "int32_t";
    }
    if (isPrimitiveTypeNamed(type, "s3")) {
        return "char *";
    }
    if (isBuiltinArrayOfPrimitive(type, "i5")) {
        return "iw_host_array_i5_t";
    }
    if (isBuiltinArrayOfPrimitive(type, "s3")) {
        return "iw_host_array_s3_t";
    }
    throw new Error(`C backend encountered unsupported exported IW return type '${type.hash()}'`);
}

function emitExportedIwHostToValueExpression(type: TypeValue, expression: string, deps: WindowsCHostInteropDependencies): string {
    if (isPrimitiveTypeNamed(type, "i5")) {
        return deps.integerImmediateExpression("i5", expression);
    }
    if (isPrimitiveTypeNamed(type, "s3")) {
        return `iw_host_to_value_s3(${expression})`;
    }
    if (isBuiltinArrayOfPrimitive(type, "i5")) {
        return `iw_host_to_value_array_i5(${expression})`;
    }
    if (isBuiltinArrayOfPrimitive(type, "s3")) {
        return `iw_host_to_value_array_s3(${expression})`;
    }
    throw new Error(`C backend encountered unsupported exported IW host-to-value type '${type.hash()}'`);
}

function emitExportedIwValueToHostExpression(
    type: TypeValue,
    expression: string,
    usageContext: string,
    deps: WindowsCHostInteropDependencies
): string {
    if (isPrimitiveTypeNamed(type, "i5")) {
        return deps.integerValueExpression("i5", expression);
    }
    if (isPrimitiveTypeNamed(type, "s3")) {
        return `iw_host_copy_s3(${expression}, ${deps.cStringLiteral(usageContext)})`;
    }
    if (isBuiltinArrayOfPrimitive(type, "i5")) {
        return `iw_host_copy_array_i5(${expression}, ${deps.cStringLiteral(usageContext)})`;
    }
    if (isBuiltinArrayOfPrimitive(type, "s3")) {
        return `iw_host_copy_array_s3(${expression}, ${deps.cStringLiteral(usageContext)})`;
    }
    throw new Error(`C backend encountered unsupported exported IW value-to-host type '${type.hash()}'`);
}

function emitExportedIwFunctionWrapper(artifact: ExportedIwFunctionArtifact, deps: WindowsCHostInteropDependencies): string {
    const { metadata, fn } = artifact;
    const params = metadata.paramTypes.map((type, index) => `${exportedIwHostParamType(type)} iw_export_param_${index}`).join(", ");
    const rootNames: string[] = [];
    const localDeclarations: string[] = [];
    const callArgs: string[] = [];

    metadata.paramTypes.forEach((type, index) => {
        const paramName = `iw_export_param_${index}`;
        if (deps.representationFromTypeValue(type) === "reference") {
            const rootName = `iw_export_root_${rootNames.length}`;
            rootNames.push(rootName);
            localDeclarations.push(`    iw_value_t ${rootName} = ${emitExportedIwHostToValueExpression(type, paramName, deps)};`);
            callArgs.push(rootName);
            return;
        }

        callArgs.push(emitExportedIwHostToValueExpression(type, paramName, deps));
    });

    const resultRepresentation = deps.representationFromTypeValue(metadata.resultType);
    const callLine = `iw_export_raw_result = ${deps.cFunctionName(fn.symbol)}(${callArgs.join(", ")});`;
    const callBlock = rootNames.length === 0
        ? `    ${callLine}`
        : deps.emitStandaloneGcScopedBlock(rootNames, [callLine], 1);
    const hostResultType = exportedIwHostReturnType(metadata.resultType);
    const hostResultExpression = emitExportedIwValueToHostExpression(metadata.resultType, "iw_export_raw_result", `${metadata.exportSymbol} return`, deps);

    return [
        `${exportedIwHostReturnType(metadata.resultType)} IW_HOST_ABI ${metadata.exportSymbol}(${params.length === 0 ? "void" : params}) {`,
        "    int iw_export_stack_anchor_local = 0;",
        "    int iw_export_attached_here = iw_gc_ensure_current_thread_attached((uintptr_t)&iw_export_stack_anchor_local);",
        ...localDeclarations,
        `    ${deps.cTypeForRepresentation(resultRepresentation)} iw_export_raw_result = ${deps.cZeroValueForRepresentation(resultRepresentation)};`,
        callBlock,
        `    ${hostResultType} iw_export_host_result = ${hostResultExpression};`,
        "    if (iw_export_attached_here) {",
        "        iw_gc_detach_current_thread();",
        "    }",
        "    return iw_export_host_result;",
        "}"
    ].join("\n");
}

function emitExportedIwFunctionPrototype(artifact: ExportedIwFunctionArtifact): string {
    const { metadata } = artifact;
    const params = metadata.paramTypes.map((type, index) => `${exportedIwHostParamType(type)} iw_export_param_${index}`).join(", ");
    return `${exportedIwHostReturnType(metadata.resultType)} IW_HOST_ABI ${metadata.exportSymbol}(${params.length === 0 ? "void" : params});`;
}

export function emitWindowsCDeclaredStdSysFfiRuntime(program: FinalBackendIRProgram, deps: WindowsCHostInteropDependencies): string {
    const renames = collectDeclaredStdSysFfiRenames(program);
    return [
        deps.builtinSharedSyscallHelpers,
        deps.builtinSharedThreadHelpers,
        ...renames.map((rename) => emitDeclaredStdSysFfiWrapper(rename, deps))
    ].join("\n\n");
}

export function emitWindowsCDeclaredCHeapHostHelperRuntime(program: FinalBackendIRProgram): string {
    const requirements = collectDeclaredCHeapHostHelperRequirements(program);
    const blocks: string[] = [];

    if (requirements.needsS3) {
        blocks.push([
            "static inline iw_value_t make_iw_s3(const char *data) {",
            "    return iw_text_copy_bytes(data, strlen(data), \"make_iw_s3\");",
            "}",
            "static inline iw_value_t _iw_s3_get(iw_value_t raw_value, int64_t index) {",
            "    return iw_builtin_text_get(raw_value, iw_from_i64(index), \"_iw_s3_get\");",
            "}",
            "static inline void _iw_s3_set(iw_value_t raw_value, int64_t index, iw_value_t raw_char) {",
            "    (void)iw_builtin_text_set(raw_value, iw_from_i64(index), raw_char, \"_iw_s3_set\");",
            "}",
            "static inline int64_t _iw_s3_length(iw_value_t raw_value) {",
            "    return iw_as_i64(iw_builtin_text_length(raw_value, \"_iw_s3_length\"));",
            "}"
        ].join("\n"));
    }

    if (requirements.needsArrayS3) {
        blocks.push([
            "static inline iw_value_t make_iw_array_s3(int64_t length) {",
            "    return iw_builtin_array_new(iw_from_i64(length), make_iw_s3(\"\"));",
            "}",
            "static inline iw_value_t _iw_array_s3_get(iw_value_t raw_value, int64_t index) {",
            "    return iw_builtin_array_get(raw_value, iw_from_i64(index));",
            "}",
            "static inline void _iw_array_s3_set(iw_value_t raw_value, int64_t index, iw_value_t element_value) {",
            "    (void)iw_builtin_array_set(raw_value, iw_from_i64(index), element_value);",
            "}",
            "static inline int64_t _iw_array_s3_length(iw_value_t raw_value) {",
            "    return iw_as_i64(iw_builtin_array_length(raw_value));",
            "}"
        ].join("\n"));
    }

    if (requirements.needsArrayI5) {
        blocks.push([
            "static inline iw_value_t make_iw_array_i5(int64_t length) {",
            "    return iw_builtin_array_new(iw_from_i64(length), iw_from_i64(0));",
            "}",
            "static inline int32_t _iw_array_i5_get(iw_value_t raw_value, int64_t index) {",
            "    return (int32_t)iw_as_i64(iw_builtin_array_get(raw_value, iw_from_i64(index)));",
            "}",
            "static inline void _iw_array_i5_set(iw_value_t raw_value, int64_t index, int32_t element_value) {",
            "    (void)iw_builtin_array_set(raw_value, iw_from_i64(index), iw_from_i64((int64_t)element_value));",
            "}",
            "static inline int64_t _iw_array_i5_length(iw_value_t raw_value) {",
            "    return iw_as_i64(iw_builtin_array_length(raw_value));",
            "}"
        ].join("\n"));
    }

    return blocks.join("\n\n");
}

export function emitWindowsCExportedIwFunctionRuntime(program: FinalBackendIRProgram, deps: WindowsCHostInteropDependencies): string {
    const artifacts = collectExportedIwFunctionArtifacts(program);
    if (artifacts.length === 0) {
        return "";
    }

    const requirements = collectExportedIwHostHelperRequirements(program);
    const blocks: string[] = [];

    if (requirements.needsArrayI5) {
        blocks.push("typedef struct iw_host_array_i5_t { int64_t length; int32_t *items; } iw_host_array_i5_t;");
    }
    if (requirements.needsArrayS3) {
        blocks.push("typedef struct iw_host_array_s3_t { int64_t length; char **items; } iw_host_array_s3_t;");
    }

    if (requirements.needsS3) {
        blocks.push([
            "static inline iw_value_t iw_host_to_value_s3(const char *value) {",
            "    return make_iw_s3(value == NULL ? \"\" : value);",
            "}",
            "static inline char* iw_host_copy_s3(iw_value_t raw_value, const char *context) {",
            "    iw_text_value_t *value = iw_text_expect(raw_value, context);",
            "    size_t length = (size_t)value->length;",
            "    char *result = (char*)malloc(length + 1u);",
            "    if (result == NULL) {",
            "        fprintf(stderr, \"Ironwall allocation failed while copying exported s3 in %s\\n\", context);",
            "        abort();",
            "    }",
            "    if (length > 0u) {",
            "        memcpy(result, value->data, length);",
            "    }",
            "    result[length] = '\\0';",
            "    return result;",
            "}",
            "static inline void iw_host_free_s3(char *value) {",
            "    free(value);",
            "}"
        ].join("\n"));
    }

    if (requirements.needsArrayI5) {
        blocks.push([
            "static inline iw_value_t iw_host_to_value_array_i5(iw_host_array_i5_t value) {",
            "    if (value.length < 0) {",
            "        fprintf(stderr, \"Ironwall exported array i5 length must be non-negative\\n\");",
            "        abort();",
            "    }",
            "    if (value.length > 0 && value.items == NULL) {",
            "        fprintf(stderr, \"Ironwall exported array i5 items pointer must not be NULL when length > 0\\n\");",
            "        abort();",
            "    }",
            "    iw_value_t result = make_iw_array_i5(value.length);",
            "    for (int64_t index = 0; index < value.length; index += 1) {",
            "        _iw_array_i5_set(result, index, value.items[index]);",
            "    }",
            "    return result;",
            "}",
            "static inline iw_host_array_i5_t iw_host_copy_array_i5(iw_value_t raw_value, const char *context) {",
            "    (void)context;",
            "    int64_t length = _iw_array_i5_length(raw_value);",
            "    if (length < 0) {",
            "        fprintf(stderr, \"Ironwall exported array i5 length became negative in %s\\n\", context);",
            "        abort();",
            "    }",
            "    if (length == 0) {",
            "        return (iw_host_array_i5_t){ 0, NULL };",
            "    }",
            "    int32_t *items = (int32_t*)malloc((size_t)length * sizeof(int32_t));",
            "    if (items == NULL) {",
            "        fprintf(stderr, \"Ironwall allocation failed while copying exported <array i5> in %s\\n\", context);",
            "        abort();",
            "    }",
            "    for (int64_t index = 0; index < length; index += 1) {",
            "        items[index] = _iw_array_i5_get(raw_value, index);",
            "    }",
            "    return (iw_host_array_i5_t){ length, items };",
            "}",
            "static inline void iw_host_free_array_i5(iw_host_array_i5_t value) {",
            "    free(value.items);",
            "}"
        ].join("\n"));
    }

    if (requirements.needsArrayS3) {
        blocks.push([
            "static inline iw_value_t iw_host_to_value_array_s3(iw_host_array_s3_t value) {",
            "    if (value.length < 0) {",
            "        fprintf(stderr, \"Ironwall exported array s3 length must be non-negative\\n\");",
            "        abort();",
            "    }",
            "    if (value.length > 0 && value.items == NULL) {",
            "        fprintf(stderr, \"Ironwall exported array s3 items pointer must not be NULL when length > 0\\n\");",
            "        abort();",
            "    }",
            "    iw_value_t result = make_iw_array_s3(value.length);",
            "    for (int64_t index = 0; index < value.length; index += 1) {",
            "        _iw_array_s3_set(result, index, iw_host_to_value_s3(value.items[index]));",
            "    }",
            "    return result;",
            "}",
            "static inline iw_host_array_s3_t iw_host_copy_array_s3(iw_value_t raw_value, const char *context) {",
            "    int64_t length = _iw_array_s3_length(raw_value);",
            "    if (length < 0) {",
            "        fprintf(stderr, \"Ironwall exported array s3 length became negative in %s\\n\", context);",
            "        abort();",
            "    }",
            "    if (length == 0) {",
            "        return (iw_host_array_s3_t){ 0, NULL };",
            "    }",
            "    char **items = (char**)malloc((size_t)length * sizeof(char*));",
            "    if (items == NULL) {",
            "        fprintf(stderr, \"Ironwall allocation failed while copying exported <array s3> in %s\\n\", context);",
            "        abort();",
            "    }",
            "    for (int64_t index = 0; index < length; index += 1) {",
            "        items[index] = iw_host_copy_s3(_iw_array_s3_get(raw_value, index), context);",
            "    }",
            "    return (iw_host_array_s3_t){ length, items };",
            "}",
            "static inline void iw_host_free_array_s3(iw_host_array_s3_t value) {",
            "    if (value.items == NULL) {",
            "        return;",
            "    }",
            "    for (int64_t index = 0; index < value.length; index += 1) {",
            "        free(value.items[index]);",
            "    }",
            "    free(value.items);",
            "}"
        ].join("\n"));
    }

    blocks.push(...artifacts.map((artifact) => emitExportedIwFunctionWrapper(artifact, deps)));
    return blocks.join("\n\n");
}

export function generateWindowsCHeaderFromFinalBackendIR(program: FinalBackendIRProgram): string {
    const artifacts = collectExportedIwFunctionArtifacts(program);
    const requirements = collectExportedIwHostHelperRequirements(program);
    const body: string[] = [
        "#ifndef IRONWALL_GENERATED_FFI_H",
        "#define IRONWALL_GENERATED_FFI_H",
        "",
        "#include <stdint.h>",
        "#include <stdlib.h>",
        "",
        "#ifndef IW_HOST_ABI",
        "#define IW_HOST_ABI",
        "#endif",
        "",
        "typedef intptr_t iw_value_t;",
        "static inline int64_t iw_as_i64(iw_value_t value) { return ((int64_t)value) >> 1; }",
        "static inline iw_value_t iw_from_i64(int64_t value) { return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL); }",
        "void IW_HOST_ABI __iw_c_init_runtime(void);",
        ""
    ];

    if (requirements.needsArrayI5) {
        body.push("typedef struct iw_host_array_i5_t { int64_t length; int32_t *items; } iw_host_array_i5_t;");
    }
    if (requirements.needsArrayS3) {
        body.push("typedef struct iw_host_array_s3_t { int64_t length; char **items; } iw_host_array_s3_t;");
    }
    if (requirements.needsS3) {
        body.push("static inline void iw_host_free_s3(char *value) { free(value); }");
    }
    if (requirements.needsArrayI5) {
        body.push("static inline void iw_host_free_array_i5(iw_host_array_i5_t value) { free(value.items); }");
    }
    if (requirements.needsArrayS3) {
        body.push([
            "static inline void iw_host_free_array_s3(iw_host_array_s3_t value) {",
            "    if (value.items == NULL) {",
            "        return;",
            "    }",
            "    for (int64_t index = 0; index < value.length; index += 1) {",
            "        free(value.items[index]);",
            "    }",
            "    free(value.items);",
            "}"
        ].join("\n"));
    }

    if (artifacts.length > 0) {
        body.push("");
        body.push(...artifacts.map((artifact) => emitExportedIwFunctionPrototype(artifact)));
    }

    body.push("", "#endif");
    return body.join("\n");
}