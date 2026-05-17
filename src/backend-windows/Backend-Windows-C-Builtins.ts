import type { BackendValueRepresentation } from "./Backend-Windows-IR-Shared";
import { loadWindowsCRuntimeTemplate } from "./Backend-Windows-C-RuntimeTemplates";

export type BuiltinEmitter = (args: readonly string[]) => string;

export interface BuiltinSpec {
    readonly arity: number;
    readonly emit: BuiltinEmitter;
}

export interface BuiltinRuntimeTypeArtifact {
    readonly symbolName: string;
    readonly runtimeTypeTagId: string;
}

interface ComplexTypeSpec {
    readonly complexTypeName: "z5" | "z6" | "z7";
    readonly componentTypeName: "f5" | "f6" | "f7";
    readonly runtimeTypeSymbolName: string;
}

interface TextPrimitiveSpec {
    readonly stringTypeName: "s3" | "s4" | "s5";
    readonly charTypeName: "c3" | "c4" | "c5";
}

export interface WindowsCBuiltinArtifacts {
    readonly builtinEmitters: ReadonlyMap<string, BuiltinSpec>;
    readonly builtinHelpers: string;
    readonly builtinRuntimeTypes: readonly BuiltinRuntimeTypeArtifact[];
    readonly builtinSharedSyscallHelpers: string;
    readonly builtinSharedThreadHelpers: string;
}

export interface WindowsCBuiltinArtifactDependencies {
    readonly cTypeForRepresentation: (representation: BackendValueRepresentation) => string;
    readonly scalarTypeRepresentation: (typeName: string) => BackendValueRepresentation;
    readonly integerValueExpression: (typeName: string, expression: string) => string;
    readonly integerImmediateExpression: (typeName: string, expression: string) => string;
    readonly runtimeTypeTagLiteral: (runtimeTypeTagId: string) => string;
    readonly floatRuntimeTypeTagIds: {
        readonly f5: string;
        readonly f6: string;
        readonly f7: string;
    };
    readonly complexRuntimeTypeTagIds: {
        readonly z5: string;
        readonly z6: string;
        readonly z7: string;
    };
}

const INTEGER_TYPE_NAMES = ["i5", "i6", "i7", "u5", "u6", "u7"] as const;
const FLOAT_TYPE_NAMES = ["f5", "f6", "f7"] as const;
const CHARACTER_TYPE_NAMES = ["c3", "c4", "c5"] as const;
const SCALAR_CONVERSION_SOURCE_TYPE_NAMES = ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] as const;
const SCALAR_CONVERSION_TARGET_TYPE_NAMES = ["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"] as const;
const CHAR_CONVERSION_SOURCE_TYPE_NAMES = ["c3", "c4", "c5"] as const;
const CHAR_CONVERSION_TARGET_TYPE_NAMES = ["i5", "u5"] as const;
const COMPLEX_TYPE_SPECS: readonly ComplexTypeSpec[] = [
    { complexTypeName: "z5", componentTypeName: "f5", runtimeTypeSymbolName: "iw_runtime_type_complex_z5" },
    { complexTypeName: "z6", componentTypeName: "f6", runtimeTypeSymbolName: "iw_runtime_type_complex_z6" },
    { complexTypeName: "z7", componentTypeName: "f7", runtimeTypeSymbolName: "iw_runtime_type_complex_z7" },
];
const TEXT_PRIMITIVE_SPECS: readonly TextPrimitiveSpec[] = [
    { stringTypeName: "s3", charTypeName: "c3" },
    { stringTypeName: "s4", charTypeName: "c4" },
    { stringTypeName: "s5", charTypeName: "c5" }
];
const INTEGER_TYPED_BUILTINS = ["add", "sub", "mul", "div", "mod", "le", "lt", "ge", "gt", "eq", "neq", "bwand", "bwor", "bwxor", "ls", "rs"] as const;
const FLOAT_ARITHMETIC_BUILTINS = ["add", "sub", "mul", "div", "mod"] as const;
const FLOAT_COMPARISON_BUILTINS = ["le", "lt", "ge", "gt", "eq", "neq"] as const;
const CHARACTER_COMPARISON_BUILTINS = ["le", "lt", "ge", "gt", "eq", "neq"] as const;
const FLOAT_TO_I5_UNARY_BUILTINS = ["round", "floor", "ceil", "trunc"] as const;

export function buildWindowsCBuiltinArtifacts(deps: WindowsCBuiltinArtifactDependencies): WindowsCBuiltinArtifacts {
    const cTypeForRepresentation = deps.cTypeForRepresentation;
    const scalarTypeRepresentation = deps.scalarTypeRepresentation;
    const integerValueExpression = deps.integerValueExpression;
    const integerImmediateExpression = deps.integerImmediateExpression;
    const runtimeTypeTagLiteral = deps.runtimeTypeTagLiteral;
    const F5_BOXED_RUNTIME_TYPE_TAG_ID = deps.floatRuntimeTypeTagIds.f5;
    const F6_BOXED_RUNTIME_TYPE_TAG_ID = deps.floatRuntimeTypeTagIds.f6;
    const F7_BOXED_RUNTIME_TYPE_TAG_ID = deps.floatRuntimeTypeTagIds.f7;
    const Z5_RUNTIME_TYPE_TAG_ID = deps.complexRuntimeTypeTagIds.z5;
    const Z6_RUNTIME_TYPE_TAG_ID = deps.complexRuntimeTypeTagIds.z6;
    const Z7_RUNTIME_TYPE_TAG_ID = deps.complexRuntimeTypeTagIds.z7;

    function isFloatTypeName(typeName: string): boolean {
        return FLOAT_TYPE_NAMES.includes(typeName as typeof FLOAT_TYPE_NAMES[number]);
    }

    function numericBuiltinSymbol(name: string, typeName: string): string {
        return `__iw_builtin_${name}_${typeName}`;
    }

    function numericHelperSymbol(name: string, typeName: string): string {
        return `iw_builtin_${name}_${typeName}`;
    }

    function floatConstructorName(typeName: string): string {
        switch (typeName) {
            case "f5":
                return "iw_from_f32";
            case "f6":
                return "iw_from_f64";
            case "f7":
                return "iw_from_f128";
            default:
                throw new Error(`Unsupported float constructor '${typeName}'`);
        }
    }

    function floatExtractorName(typeName: string): string {
        switch (typeName) {
            case "f5":
                return "iw_as_f32";
            case "f6":
                return "iw_as_f64";
            case "f7":
                return "iw_as_f128";
            default:
                throw new Error(`Unsupported float extractor '${typeName}'`);
        }
    }

    function scalarTypeCType(typeName: string, paramName: string): string {
        void typeName;
        return `iw_value_t ${paramName}`;
    }

    function scalarConversionSymbolName(targetTypeName: string, sourceTypeName: string): string {
        return `iw_ty_to_${targetTypeName}_${sourceTypeName}`;
    }

    function scalarConversionHelperName(targetTypeName: string, sourceTypeName: string): string {
        return `iw_builtin_ty_to_${targetTypeName}_${sourceTypeName}`;
    }

    function scalarBinaryConversionSymbolName(targetTypeName: string, sourceTypeName: string): string {
        return `iw_bin_to_${targetTypeName}_${sourceTypeName}`;
    }

    function scalarBinaryConversionHelperName(targetTypeName: string, sourceTypeName: string): string {
        return `iw_builtin_bin_to_${targetTypeName}_${sourceTypeName}`;
    }

    function isSignedIntegerTypeName(typeName: string): boolean {
        return typeName === "i5" || typeName === "i6" || typeName === "i7";
    }

    function scalarIntegerTargetBitWidth(typeName: string): string {
        switch (typeName) {
            case "i5":
            case "u5":
                return "32u";
            case "i6":
            case "i7":
            case "u6":
            case "u7":
                return "64u";
            default:
                throw new Error(`Unsupported scalar integer target '${typeName}'`);
        }
    }

    function scalarBinaryNativeType(typeName: string): string {
        switch (typeName) {
            case "i5":
                return "int32_t";
            case "i6":
            case "i7":
                return "int64_t";
            case "u5":
                return "uint32_t";
            case "u6":
            case "u7":
                return "uint64_t";
            case "f5":
                return "float";
            case "f6":
                return "double";
            case "f7":
                return "long double";
            case "c3":
            case "c4":
            case "c5":
                return "unsigned char";
            default:
                throw new Error(`Unsupported scalar binary native type '${typeName}'`);
        }
    }

    function scalarBinaryNativeInitializer(typeName: string): string {
        switch (typeName) {
            case "f5":
                return "0.0f";
            case "f6":
                return "0.0";
            case "f7":
                return "0.0L";
            case "i5":
            case "i6":
            case "i7":
            case "u5":
            case "u6":
            case "u7":
            case "c3":
            case "c4":
            case "c5":
                return "0";
            default:
                throw new Error(`Unsupported scalar binary initializer '${typeName}'`);
        }
    }

    function scalarBinarySourceValueExpression(typeName: string, usageContext: string): string {
        switch (typeName) {
            case "i5":
                return "(int32_t)iw_as_i64(raw_value)";
            case "i6":
            case "i7":
                return "(int64_t)iw_as_i64(raw_value)";
            case "u5":
                return "(uint32_t)(uint64_t)iw_as_i64(raw_value)";
            case "u6":
            case "u7":
                return "(uint64_t)iw_as_i64(raw_value)";
            case "f5":
                return `iw_as_f32(raw_value, \"${usageContext}\")`;
            case "f6":
                return `iw_as_f64(raw_value, \"${usageContext}\")`;
            case "f7":
                return `iw_as_f128(raw_value, \"${usageContext}\")`;
            default:
                throw new Error(`Unsupported scalar binary source '${typeName}'`);
        }
    }

    function scalarBinaryReturnExpression(typeName: string): string {
        switch (typeName) {
            case "i5":
            case "i6":
            case "i7":
            case "u5":
            case "u6":
            case "u7":
                return integerImmediateExpression(typeName, "copied_value");
            case "f5":
                return "iw_from_f32(copied_value)";
            case "f6":
                return "iw_from_f64(copied_value)";
            case "f7":
                return "iw_from_f128(copied_value)";
            default:
                throw new Error(`Unsupported scalar binary target '${typeName}'`);
        }
    }

    function integerSemanticBitWidth(typeName: string): 32 | 64 {
        switch (typeName) {
            case "i5":
            case "u5":
                return 32;
            case "i6":
            case "i7":
            case "u6":
            case "u7":
                return 64;
            default:
                throw new Error(`Unsupported integer type '${typeName}'`);
        }
    }

    function integerSignedCType(typeName: string): "int32_t" | "int64_t" {
        return integerSemanticBitWidth(typeName) === 32 ? "int32_t" : "int64_t";
    }

    function integerUnsignedCType(typeName: string): "uint32_t" | "uint64_t" {
        return integerSemanticBitWidth(typeName) === 32 ? "uint32_t" : "uint64_t";
    }

    function integerCType(typeName: string): string {
        return isSignedIntegerTypeName(typeName) ? integerSignedCType(typeName) : integerUnsignedCType(typeName);
    }

    function scalarValIntegerBitsExpression(sourceTypeName: string, usageContext: string, targetBitWidth: string): string {
        if (isFloatTypeName(sourceTypeName)) {
            return `iw_trunc_long_double_to_u64(${scalarSourceToLongDoubleExpression(sourceTypeName, "raw_value", usageContext)}, ${targetBitWidth})`;
        }
        return "(uint64_t)iw_as_i64(raw_value)";
    }

    function scalarSourceToLongDoubleExpression(typeName: string, expression: string, usageContext: string): string {
        switch (typeName) {
            case "f5":
                return `(long double)iw_as_f32(${expression}, "${usageContext}")`;
            case "f6":
                return `(long double)iw_as_f64(${expression}, "${usageContext}")`;
            case "f7":
                return `iw_as_f128(${expression}, "${usageContext}")`;
            case "i5":
            case "i6":
            case "i7":
            case "u5":
            case "u6":
            case "u7":
                return `(long double)iw_as_i64(${expression})`;
            default:
                throw new Error(`Unsupported scalar source type '${typeName}'`);
        }
    }

    function scalarLongDoubleToTargetExpression(typeName: string, expression: string): string {
        switch (typeName) {
            case "f5":
                return `iw_from_f32((float)(${expression}))`;
            case "f6":
                return `iw_from_f64((double)(${expression}))`;
            case "f7":
                return `iw_from_f128(${expression})`;
            case "i5":
            case "i6":
            case "i7":
            case "u5":
            case "u6":
            case "u7":
                return integerImmediateExpression(typeName, expression);
            default:
                throw new Error(`Unsupported scalar target type '${typeName}'`);
        }
    }

    function buildScalarConversionEmitterEntries(): readonly [string, BuiltinSpec][] {
        const entries: [string, BuiltinSpec][] = [];
        for (const targetTypeName of SCALAR_CONVERSION_TARGET_TYPE_NAMES) {
            for (const sourceTypeName of SCALAR_CONVERSION_SOURCE_TYPE_NAMES) {
                const symbol = scalarConversionSymbolName(targetTypeName, sourceTypeName);
                const helper = scalarConversionHelperName(targetTypeName, sourceTypeName);
                entries.push([symbol, { arity: 1, emit: ([value]) => `${helper}(${value})` }]);

                const binarySymbol = scalarBinaryConversionSymbolName(targetTypeName, sourceTypeName);
                const binaryHelper = scalarBinaryConversionHelperName(targetTypeName, sourceTypeName);
                entries.push([binarySymbol, { arity: 1, emit: ([value]) => `${binaryHelper}(${value})` }]);
            }
        }
        for (const targetTypeName of CHAR_CONVERSION_TARGET_TYPE_NAMES) {
            for (const sourceTypeName of CHAR_CONVERSION_SOURCE_TYPE_NAMES) {
                const symbol = scalarConversionSymbolName(targetTypeName, sourceTypeName);
                const helper = scalarConversionHelperName(targetTypeName, sourceTypeName);
                entries.push([symbol, { arity: 1, emit: ([value]) => `${helper}(${value})` }]);

                const binarySymbol = scalarBinaryConversionSymbolName(targetTypeName, sourceTypeName);
                const binaryHelper = scalarBinaryConversionHelperName(targetTypeName, sourceTypeName);
                entries.push([binarySymbol, { arity: 1, emit: ([value]) => `${binaryHelper}(${value})` }]);
            }
        }
        return entries;
    }

    function buildScalarConversionHelpers(): readonly string[] {
        const helpers: string[] = [
            "static inline uint64_t iw_mask_low_bits_u64(uint64_t value, unsigned width) { if (width >= 64u) { return value; } return value & ((1ULL << width) - 1ULL); }",
            "static inline int64_t iw_sign_extend_u64(uint64_t value, unsigned width) { if (width >= 64u) { return (int64_t)value; } uint64_t masked = iw_mask_low_bits_u64(value, width); uint64_t sign = 1ULL << (width - 1u); return (int64_t)((masked ^ sign) - sign); }",
            "static inline uint64_t iw_trunc_long_double_to_u64(long double value, unsigned width) { if (!isfinite(value)) { return 0ULL; } long double truncated = truncl(value); long double modulus = width >= 64u ? 0x1p64L : (long double)(1ULL << width); long double remainder = fmodl(truncated, modulus); if (remainder < 0.0L) { remainder += modulus; } return (uint64_t)remainder; }",
            "static inline void iw_copy_low_bytes(void *dst, size_t dst_size, const void *src, size_t src_size) { size_t copy_size = dst_size < src_size ? dst_size : src_size; memset(dst, 0, dst_size); memcpy(dst, src, copy_size); }"
        ];
        for (const targetTypeName of SCALAR_CONVERSION_TARGET_TYPE_NAMES) {
            for (const sourceTypeName of SCALAR_CONVERSION_SOURCE_TYPE_NAMES) {
                const helperName = scalarConversionHelperName(targetTypeName, sourceTypeName);
                const resultType = cTypeForRepresentation(scalarTypeRepresentation(targetTypeName));
                const paramDecl = scalarTypeCType(sourceTypeName, "raw_value");
                const usageContext = `val_to_${targetTypeName}_${sourceTypeName}`;
                if (isFloatTypeName(targetTypeName)) {
                    const resultExpression = scalarLongDoubleToTargetExpression(
                        targetTypeName,
                        scalarSourceToLongDoubleExpression(sourceTypeName, "raw_value", usageContext)
                    );
                    helpers.push(`static inline ${resultType} ${helperName}(${paramDecl}) { return ${resultExpression}; }`);
                } else {
                    const targetBitWidth = scalarIntegerTargetBitWidth(targetTypeName);
                    const bitsExpression = scalarValIntegerBitsExpression(sourceTypeName, usageContext, targetBitWidth);
                    const maskedBitsExpression = `iw_mask_low_bits_u64(${bitsExpression}, ${targetBitWidth})`;
                    const valueExpression = isSignedIntegerTypeName(targetTypeName)
                        ? `iw_sign_extend_u64(${maskedBitsExpression}, ${targetBitWidth})`
                        : `(int64_t)${maskedBitsExpression}`;
                    helpers.push(`static inline ${resultType} ${helperName}(${paramDecl}) { return iw_from_i64(${valueExpression}); }`);
                }

                const binaryHelperName = scalarBinaryConversionHelperName(targetTypeName, sourceTypeName);
                const binaryUsageContext = `bin_to_${targetTypeName}_${sourceTypeName}`;
                const sourceNativeType = scalarBinaryNativeType(sourceTypeName);
                const targetNativeType = scalarBinaryNativeType(targetTypeName);
                const sourceValueExpression = scalarBinarySourceValueExpression(sourceTypeName, binaryUsageContext);
                const targetInitializer = scalarBinaryNativeInitializer(targetTypeName);
                const binaryReturnExpression = scalarBinaryReturnExpression(targetTypeName);
                helpers.push(`static inline ${resultType} ${binaryHelperName}(${paramDecl}) { ${sourceNativeType} source_value = ${sourceValueExpression}; ${targetNativeType} copied_value = ${targetInitializer}; iw_copy_low_bytes(&copied_value, sizeof(copied_value), &source_value, sizeof(source_value)); return ${binaryReturnExpression}; }`);
            }
        }
        for (const targetTypeName of CHAR_CONVERSION_TARGET_TYPE_NAMES) {
            for (const sourceTypeName of CHAR_CONVERSION_SOURCE_TYPE_NAMES) {
                const helperName = scalarConversionHelperName(targetTypeName, sourceTypeName);
                const usageContext = `val_to_${targetTypeName}_${sourceTypeName}`;
                const targetBitWidth = scalarIntegerTargetBitWidth(targetTypeName);
                const maskedBitsExpression = `iw_mask_low_bits_u64((uint64_t)(unsigned char)value->data[0], ${targetBitWidth})`;
                const valueExpression = isSignedIntegerTypeName(targetTypeName)
                    ? `iw_sign_extend_u64(${maskedBitsExpression}, ${targetBitWidth})`
                    : `(int64_t)${maskedBitsExpression}`;
                helpers.push(`static inline iw_value_t ${helperName}(iw_value_t raw_value) { iw_text_value_t *value = (iw_text_value_t*)(intptr_t)iw_expect_heap_header(raw_value, "${usageContext}"); if (value->header.tag != 0x5445585400000001ULL) { fprintf(stderr, "Ironwall C backend text tag mismatch in %s\\n", "${usageContext}"); abort(); } if (value->length != 1u) { fprintf(stderr, "Ironwall expected single char text in %s, got length=%u\\n", "${usageContext}", (unsigned)value->length); abort(); } return iw_from_i64(${valueExpression}); }`);

                const binaryHelperName = scalarBinaryConversionHelperName(targetTypeName, sourceTypeName);
                const binaryUsageContext = `bin_to_${targetTypeName}_${sourceTypeName}`;
                const targetNativeType = scalarBinaryNativeType(targetTypeName);
                const targetInitializer = scalarBinaryNativeInitializer(targetTypeName);
                const binaryReturnExpression = scalarBinaryReturnExpression(targetTypeName);
                helpers.push(`static inline iw_value_t ${binaryHelperName}(iw_value_t raw_value) { iw_text_value_t *value = (iw_text_value_t*)(intptr_t)iw_expect_heap_header(raw_value, "${binaryUsageContext}"); if (value->header.tag != 0x5445585400000001ULL) { fprintf(stderr, "Ironwall C backend text tag mismatch in %s\\n", "${binaryUsageContext}"); abort(); } if (value->length != 1u) { fprintf(stderr, "Ironwall expected single char text in %s, got length=%u\\n", "${binaryUsageContext}", (unsigned)value->length); abort(); } unsigned char source_value = (unsigned char)value->data[0]; ${targetNativeType} copied_value = ${targetInitializer}; iw_copy_low_bytes(&copied_value, sizeof(copied_value), &source_value, sizeof(source_value)); return ${binaryReturnExpression}; }`);
            }
        }
        return helpers;
    }

    function complexBuiltinHelperName(symbol: string): string {
        return `iw_builtin_${symbol.slice(3)}`;
    }

    function componentToLongDoubleExpression(typeName: string, expression: string, usageContext: string): string {
        switch (typeName) {
            case "f5":
                return `(long double)iw_as_f32(${expression}, \"${usageContext}\")`;
            case "f6":
                return `(long double)iw_as_f64(${expression}, \"${usageContext}\")`;
            case "f7":
                return `iw_as_f128(${expression}, \"${usageContext}\")`;
            default:
                throw new Error(`Unsupported complex component type '${typeName}'`);
        }
    }

    function longDoubleToComponentExpression(typeName: string, expression: string): string {
        switch (typeName) {
            case "f5":
                return `iw_from_f32((float)(${expression}))`;
            case "f6":
                return `iw_from_f64((double)(${expression}))`;
            case "f7":
                return `iw_from_f128(${expression})`;
            default:
                throw new Error(`Unsupported complex component type '${typeName}'`);
        }
    }

    function complexRuntimeTypeTagId(typeName: string): string {
        switch (typeName) {
            case "z5":
                return Z5_RUNTIME_TYPE_TAG_ID;
            case "z6":
                return Z6_RUNTIME_TYPE_TAG_ID;
            case "z7":
                return Z7_RUNTIME_TYPE_TAG_ID;
            default:
                throw new Error(`Unsupported complex type '${typeName}'`);
        }
    }

    function buildComplexEmitterEntries(): readonly [string, BuiltinSpec][] {
        const unaryOps = ["zreal", "zimg", "zabs", "zarg", "zconj", "zproj", "zexp", "zlog", "zsqrt"] as const;
        const entries: [string, BuiltinSpec][] = [];
        for (const spec of COMPLEX_TYPE_SPECS) {
            entries.push([`${spec.complexTypeName}_new`, { arity: 1, emit: ([value]) => `iw_builtin_${spec.complexTypeName}_new(${value})` }]);
            entries.push([`${spec.complexTypeName}_set_value`, { arity: 2, emit: ([target, value]) => `iw_builtin_${spec.complexTypeName}_set_value(${target}, ${value})` }]);
            entries.push([`${spec.complexTypeName}_set_parts`, { arity: 3, emit: ([target, real, imag]) => `iw_builtin_${spec.complexTypeName}_set_parts(${target}, ${real}, ${imag})` }]);
            entries.push([`${spec.complexTypeName}_real`, { arity: 1, emit: ([value]) => `${complexBuiltinHelperName(`iw_zreal_${spec.complexTypeName}`)}(${value})` }]);
            entries.push([`${spec.complexTypeName}_img`, { arity: 1, emit: ([value]) => `${complexBuiltinHelperName(`iw_zimg_${spec.complexTypeName}`)}(${value})` }]);
            entries.push([
                `iw_${spec.complexTypeName}_rect`,
                { arity: 2, emit: ([real, imag]) => `${complexBuiltinHelperName(`iw_${spec.complexTypeName}_rect`)}(${real}, ${imag})` }
            ]);
            for (const op of unaryOps) {
                const symbol = `iw_${op}_${spec.complexTypeName}`;
                entries.push([symbol, { arity: 1, emit: ([value]) => `${complexBuiltinHelperName(symbol)}(${value})` }]);
            }
            const powSymbol = `iw_zpow_${spec.complexTypeName}`;
            entries.push([powSymbol, { arity: 2, emit: ([base, exponent]) => `${complexBuiltinHelperName(powSymbol)}(${base}, ${exponent})` }]);
        }
        return entries;
    }

    function buildTextPrimitiveEmitterEntries(): readonly [string, BuiltinSpec][] {
        const entries: [string, BuiltinSpec][] = [];
        for (const spec of TEXT_PRIMITIVE_SPECS) {
            entries.push([`${spec.stringTypeName}_new_copy`, { arity: 1, emit: ([value]) => `iw_builtin_${spec.stringTypeName}_new_copy(${value})` }]);
            entries.push([`${spec.stringTypeName}_new_fill`, { arity: 2, emit: ([length, initChar]) => `iw_builtin_${spec.stringTypeName}_new_fill(${length}, ${initChar})` }]);
            entries.push([`${spec.stringTypeName}_get`, { arity: 2, emit: ([value, index]) => `iw_builtin_${spec.stringTypeName}_get(${value}, ${index})` }]);
            entries.push([`${spec.stringTypeName}_set`, { arity: 3, emit: ([value, index, nextChar]) => `iw_builtin_${spec.stringTypeName}_set(${value}, ${index}, ${nextChar})` }]);
            entries.push([`${spec.stringTypeName}_length`, { arity: 1, emit: ([value]) => `iw_builtin_${spec.stringTypeName}_length(${value})` }]);
        }
        return entries;
    }

    function buildComplexBuiltinHelpers(): readonly string[] {
        const helpers: string[] = [];
        for (const spec of COMPLEX_TYPE_SPECS) {
            const runtimeTag = runtimeTypeTagLiteral(complexRuntimeTypeTagId(spec.complexTypeName));
            const accessContext = `${spec.complexTypeName} access`;
            const newContext = `${spec.complexTypeName} new`;
            const setTargetContext = `${spec.complexTypeName} set target`;
            const setValueContext = `${spec.complexTypeName} set value`;
            const absHelperName = `iw_builtin_zabs_${spec.complexTypeName}`;
            const argHelperName = `iw_builtin_zarg_${spec.complexTypeName}`;
            const rectHelperName = `iw_builtin_${spec.complexTypeName}_rect`;
            const newHelperName = `iw_builtin_${spec.complexTypeName}_new`;
            const setValueHelperName = `iw_builtin_${spec.complexTypeName}_set_value`;
            const setPartsHelperName = `iw_builtin_${spec.complexTypeName}_set_parts`;
            const realHelperName = `iw_builtin_zreal_${spec.complexTypeName}`;
            const imagHelperName = `iw_builtin_zimg_${spec.complexTypeName}`;
            const conjHelperName = `iw_builtin_zconj_${spec.complexTypeName}`;
            const projHelperName = `iw_builtin_zproj_${spec.complexTypeName}`;
            const expHelperName = `iw_builtin_zexp_${spec.complexTypeName}`;
            const logHelperName = `iw_builtin_zlog_${spec.complexTypeName}`;
            const sqrtHelperName = `iw_builtin_zsqrt_${spec.complexTypeName}`;
            const powHelperName = `iw_builtin_zpow_${spec.complexTypeName}`;
            const realArgType = "iw_value_t real";
            const imagArgType = "iw_value_t imag";
            const realExpr = componentToLongDoubleExpression(spec.componentTypeName, "real", `${spec.complexTypeName}_rect real`);
            const imagExpr = componentToLongDoubleExpression(spec.componentTypeName, "imag", `${spec.complexTypeName}_rect imag`);
            const realReturn = longDoubleToComponentExpression(spec.componentTypeName, "value->real");
            const imagReturn = longDoubleToComponentExpression(spec.componentTypeName, "value->imag");
            const absReturn = longDoubleToComponentExpression(spec.componentTypeName, `iw_complex_abs(value->real, value->imag)`);
            const argReturn = longDoubleToComponentExpression(spec.componentTypeName, `iw_atan2_approx(value->imag, value->real)`);

            helpers.push(`static inline iw_value_t ${rectHelperName}(${realArgType}, ${imagArgType}) { return iw_complex_box(&${spec.runtimeTypeSymbolName}, ${realExpr}, ${imagExpr}); }`);
            helpers.push(`static inline iw_value_t ${newHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, "${newContext}"); return iw_complex_box(&${spec.runtimeTypeSymbolName}, value->real, value->imag); }`);
            helpers.push(`static inline iw_value_t ${setValueHelperName}(iw_value_t raw_target, iw_value_t raw_value) { iw_complex_value_t *target = iw_complex_expect(raw_target, ${runtimeTag}, "${setTargetContext}"); iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, "${setValueContext}"); if (iw_gc_lookup_heap_registry_entry((iw_heap_header_t*)target) == NULL) { fprintf(stderr, "Ironwall attempted to mutate immutable complex in %s\\n", "${setTargetContext}"); abort(); } target->real = value->real; target->imag = value->imag; return iw_from_i64(0); }`);
            helpers.push(`static inline iw_value_t ${setPartsHelperName}(iw_value_t raw_target, ${realArgType}, ${imagArgType}) { iw_complex_value_t *target = iw_complex_expect(raw_target, ${runtimeTag}, "${setTargetContext}"); if (iw_gc_lookup_heap_registry_entry((iw_heap_header_t*)target) == NULL) { fprintf(stderr, "Ironwall attempted to mutate immutable complex in %s\\n", "${setTargetContext}"); abort(); } target->real = ${realExpr}; target->imag = ${imagExpr}; return iw_from_i64(0); }`);
            helpers.push(`static inline iw_value_t ${realHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); return ${realReturn}; }`);
            helpers.push(`static inline iw_value_t ${imagHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); return ${imagReturn}; }`);
            helpers.push(`static inline iw_value_t ${absHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); return ${absReturn}; }`);
            helpers.push(`static inline iw_value_t ${argHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); return ${argReturn}; }`);
            helpers.push(`static inline iw_value_t ${conjHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); return iw_complex_box(&${spec.runtimeTypeSymbolName}, value->real, -value->imag); }`);
            helpers.push(`static inline iw_value_t ${projHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); return iw_complex_box(&${spec.runtimeTypeSymbolName}, value->real, value->imag); }`);
            helpers.push(`static inline iw_value_t ${expHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); iw_complex_parts_t result = iw_complex_exp_parts(value->real, value->imag); return iw_complex_box(&${spec.runtimeTypeSymbolName}, result.real, result.imag); }`);
            helpers.push(`static inline iw_value_t ${logHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); iw_complex_parts_t result = iw_complex_log_parts(value->real, value->imag); return iw_complex_box(&${spec.runtimeTypeSymbolName}, result.real, result.imag); }`);
            helpers.push(`static inline iw_value_t ${sqrtHelperName}(iw_value_t raw_value) { iw_complex_value_t *value = iw_complex_expect(raw_value, ${runtimeTag}, \"${accessContext}\"); iw_complex_parts_t result = iw_complex_sqrt_parts(value->real, value->imag); return iw_complex_box(&${spec.runtimeTypeSymbolName}, result.real, result.imag); }`);
            helpers.push(`static inline iw_value_t ${powHelperName}(iw_value_t raw_base, iw_value_t raw_exponent) { iw_complex_value_t *base = iw_complex_expect(raw_base, ${runtimeTag}, \"${spec.complexTypeName} pow base\"); iw_complex_value_t *exponent = iw_complex_expect(raw_exponent, ${runtimeTag}, \"${spec.complexTypeName} pow exponent\"); iw_complex_parts_t result = iw_complex_pow_parts(base->real, base->imag, exponent->real, exponent->imag); return iw_complex_box(&${spec.runtimeTypeSymbolName}, result.real, result.imag); }`);
        }
        return helpers;
    }

    function buildTextPrimitiveHelpers(): readonly string[] {
        const helpers: string[] = [
            "static char iw_text_char_cache_bytes[256][2];",
            "static iw_text_value_t iw_text_char_cache_values[256];",
            "static pthread_once_t iw_text_char_cache_once = PTHREAD_ONCE_INIT;",
            "static void iw_text_char_cache_build(void) { for (size_t index = 0u; index < 256u; index += 1u) { iw_text_char_cache_bytes[index][0] = (char)index; iw_text_char_cache_bytes[index][1] = '\\0'; iw_text_char_cache_values[index].header.tag = 0x5445585400000001ULL; iw_text_char_cache_values[index].header.type_info = &iw_runtime_type_text; iw_text_char_cache_values[index].length = 1u; iw_text_char_cache_values[index].data = iw_text_char_cache_bytes[index]; } }",
            "static inline iw_value_t iw_text_cached_single_char(unsigned char value) { pthread_once(&iw_text_char_cache_once, iw_text_char_cache_build); return (iw_value_t)(intptr_t)&iw_text_char_cache_values[(size_t)value]; }",
            "static inline iw_value_t iw_builtin_text_copy(iw_value_t raw_value, const char *context) { iw_text_value_t *value = iw_text_expect(raw_value, context); return iw_text_copy_bytes(value->data, value->length, context); }",
            "static inline iw_value_t iw_builtin_text_repeat(iw_value_t raw_length, iw_value_t raw_init_char, const char *context) { int64_t length = iw_as_i64(raw_length); if (length < 0) { fprintf(stderr, \"Ironwall text length must be non-negative in %s: %lld\\n\", context, (long long)length); abort(); } iw_text_value_t *init_char = iw_text_expect(raw_init_char, context); if (init_char->length != 1u) { fprintf(stderr, \"Ironwall expected single char text in %s, got length=%u\\n\", context, (unsigned)init_char->length); abort(); } size_t count = (size_t)length; char *buffer = (char*)malloc(count == 0u ? 1u : count); if (buffer == NULL) { fprintf(stderr, \"Ironwall allocation failed in %s\\n\", context); abort(); } if (count != 0u) { memset(buffer, init_char->data[0], count); } iw_value_t result = iw_text_copy_bytes(buffer, count, context); free(buffer); return result; }",
            "static inline iw_value_t iw_builtin_text_get(iw_value_t raw_value, iw_value_t raw_index, const char *context) { iw_text_value_t *value = iw_text_expect(raw_value, context); int64_t index = iw_as_i64(raw_index); if (index < 0 || (uint64_t)index >= (uint64_t)value->length) { fprintf(stderr, \"Ironwall text index out of bounds in %s: index=%lld length=%u\\n\", context, (long long)index, (unsigned)value->length); abort(); } return iw_text_cached_single_char((unsigned char)value->data[(size_t)index]); }",
            "static inline iw_value_t iw_builtin_text_set(iw_value_t raw_value, iw_value_t raw_index, iw_value_t raw_char, const char *context) { iw_text_value_t *value = iw_text_expect(raw_value, context); iw_text_value_t *next_char = iw_text_expect(raw_char, context); int64_t index = iw_as_i64(raw_index); if (next_char->length != 1u) { fprintf(stderr, \"Ironwall expected single char text in %s, got length=%u\\n\", context, (unsigned)next_char->length); abort(); } if (index < 0 || (uint64_t)index >= (uint64_t)value->length) { fprintf(stderr, \"Ironwall text index out of bounds in %s: index=%lld length=%u\\n\", context, (long long)index, (unsigned)value->length); abort(); } if (iw_gc_lookup_heap_registry_entry((iw_heap_header_t*)value) == NULL) { fprintf(stderr, \"Ironwall attempted to mutate immutable text in %s\\n\", context); abort(); } ((char*)value->data)[(size_t)index] = next_char->data[0]; return iw_from_i64(0); }",
            "static inline iw_value_t iw_builtin_text_length(iw_value_t raw_value, const char *context) { iw_text_value_t *value = iw_text_expect(raw_value, context); return iw_from_i64((int64_t)value->length); }"
        ];
        for (const spec of TEXT_PRIMITIVE_SPECS) {
            helpers.push(`static inline iw_value_t iw_builtin_${spec.stringTypeName}_new_copy(iw_value_t raw_value) { return iw_builtin_text_copy(raw_value, \"${spec.stringTypeName}_new\"); }`);
            helpers.push(`static inline iw_value_t iw_builtin_${spec.stringTypeName}_new_fill(iw_value_t raw_length, iw_value_t raw_init_char) { return iw_builtin_text_repeat(raw_length, raw_init_char, \"${spec.stringTypeName}_new\"); }`);
            helpers.push(`static inline iw_value_t iw_builtin_${spec.stringTypeName}_get(iw_value_t raw_value, iw_value_t raw_index) { return iw_builtin_text_get(raw_value, raw_index, \"${spec.stringTypeName}_get\"); }`);
            helpers.push(`static inline iw_value_t iw_builtin_${spec.stringTypeName}_set(iw_value_t raw_value, iw_value_t raw_index, iw_value_t raw_char) { return iw_builtin_text_set(raw_value, raw_index, raw_char, \"${spec.stringTypeName}_set\"); }`);
            helpers.push(`static inline iw_value_t iw_builtin_${spec.stringTypeName}_length(iw_value_t raw_value) { return iw_builtin_text_length(raw_value, \"${spec.stringTypeName}_length\"); }`);
        }
        return helpers;
    }

    function buildIntegerBuiltinHelper(op: string, typeName: string): string {
        const helperName = numericHelperSymbol(op, typeName);
        const cType = integerCType(typeName);
        const signedType = integerSignedCType(typeName);
        const unsignedType = integerUnsignedCType(typeName);
        const bitWidth = integerSemanticBitWidth(typeName);
        const left = integerValueExpression(typeName, "left");
        const right = integerValueExpression(typeName, "right");
        const result = (expression: string): string => integerImmediateExpression(typeName, expression);
        const binaryWrap = (operator: string): string => `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; ${unsignedType} result = (${unsignedType})left_value ${operator} (${unsignedType})right_value; return ${result(`(${cType})result`)}; }`;
        const signedDivide = (operator: string): string => {
            const overflowResult = operator === "/" ? `(${cType})left_value` : `(${cType})0`;
            return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; if (right_value == (${cType})0) { fprintf(stderr, \"Ironwall integer division by zero in ${op}_${typeName}\\n\"); abort(); } if (left_value == (${cType})${signedType === "int32_t" ? "INT32_MIN" : "INT64_MIN"} && right_value == (${cType})-1) { return ${result(overflowResult)}; } return ${result(`(${cType})(left_value ${operator} right_value)`)}; }`;
        };
        const unsignedDivide = (operator: string): string => `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; if (right_value == (${cType})0) { fprintf(stderr, \"Ironwall integer division by zero in ${op}_${typeName}\\n\"); abort(); } return ${result(`(${cType})(left_value ${operator} right_value)`)}; }`;
        switch (op) {
            case "add":
                return binaryWrap("+");
            case "sub":
                return binaryWrap("-");
            case "mul":
                return binaryWrap("*");
            case "div":
                return isSignedIntegerTypeName(typeName) ? signedDivide("/") : unsignedDivide("/");
            case "mod":
                return isSignedIntegerTypeName(typeName) ? signedDivide("%") : unsignedDivide("%");
            case "le":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return iw_from_i64(left_value <= right_value ? 1 : 0); }`;
            case "lt":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return iw_from_i64(left_value < right_value ? 1 : 0); }`;
            case "ge":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return iw_from_i64(left_value >= right_value ? 1 : 0); }`;
            case "gt":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return iw_from_i64(left_value > right_value ? 1 : 0); }`;
            case "eq":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return iw_from_i64(left_value == right_value ? 1 : 0); }`;
            case "neq":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return iw_from_i64(left_value != right_value ? 1 : 0); }`;
            case "bwand":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return ${result(`(${cType})((${unsignedType})left_value & (${unsignedType})right_value)`)}; }`;
            case "bwor":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return ${result(`(${cType})((${unsignedType})left_value | (${unsignedType})right_value)`)}; }`;
            case "bwxor":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; return ${result(`(${cType})((${unsignedType})left_value ^ (${unsignedType})right_value)`)}; }`;
            case "ls":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; uint32_t shift = (uint32_t)right_value & ${bitWidth - 1}u; return ${result(`(${cType})((${unsignedType})left_value << shift)`)}; }`;
            case "rs":
                return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { ${cType} left_value = ${left}; ${cType} right_value = ${right}; uint32_t shift = (uint32_t)right_value & ${bitWidth - 1}u; return ${result(`(${cType})(left_value >> shift)`)}; }`;
            default:
                throw new Error(`Unsupported integer builtin '${op}' for '${typeName}'`);
        }
    }

    function buildFloatArithmeticHelper(op: string, typeName: string, operator: string): string {
        const helperName = numericHelperSymbol(op, typeName);
        if (op === "mod") {
            const constructorName = floatConstructorName(typeName);
            const extractorName = floatExtractorName(typeName);
            return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { return ${constructorName}(iw_fmod_approx((long double)${extractorName}(left, "${op}_${typeName} lhs"), (long double)${extractorName}(right, "${op}_${typeName} rhs"))); }`;
        }
        const constructorName = floatConstructorName(typeName);
        const extractorName = floatExtractorName(typeName);
        return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { return ${constructorName}(${extractorName}(left, \"${op}_${typeName} lhs\") ${operator} ${extractorName}(right, \"${op}_${typeName} rhs\")); }`;
    }

    function buildFloatComparisonHelper(op: string, typeName: string, operator: string): string {
        const helperName = numericHelperSymbol(op, typeName);
        const extractorName = floatExtractorName(typeName);
        return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { return iw_from_i64(${extractorName}(left, \"${op}_${typeName} lhs\") ${operator} ${extractorName}(right, \"${op}_${typeName} rhs\") ? 1 : 0); }`;
    }

    function buildCharacterComparisonHelper(op: string, typeName: string): string {
        const helperName = numericHelperSymbol(op, typeName);
        const operator = op === "le"
            ? "<="
            : op === "lt"
                ? "<"
                : op === "ge"
                    ? ">="
                    : op === "gt"
                        ? ">"
                        : op === "eq"
                            ? "=="
                            : "!=";
        const usageContext = `${op}_${typeName}`;
        return `static inline iw_value_t ${helperName}(iw_value_t left, iw_value_t right) { iw_text_value_t *left_value = (iw_text_value_t*)(intptr_t)iw_expect_heap_header(left, "${usageContext} lhs"); iw_text_value_t *right_value = (iw_text_value_t*)(intptr_t)iw_expect_heap_header(right, "${usageContext} rhs"); if (left_value->header.tag != 0x5445585400000001ULL || right_value->header.tag != 0x5445585400000001ULL) { fprintf(stderr, "Ironwall C backend text tag mismatch in %s\\n", "${usageContext}"); abort(); } if (left_value->length != 1u || right_value->length != 1u) { fprintf(stderr, "Ironwall expected single char text in %s: left=%u right=%u\\n", "${usageContext}", (unsigned)left_value->length, (unsigned)right_value->length); abort(); } return iw_from_i64(((unsigned char)left_value->data[0]) ${operator} ((unsigned char)right_value->data[0]) ? 1 : 0); }`;
    }

    function buildFloatToI5UnaryHelper(op: string, typeName: string): string {
        const helperName = numericHelperSymbol(op, typeName);
        const narrowingHelper = op === "round"
            ? "iw_round_to_i64"
            : op === "floor"
                ? "iw_floor_to_i64"
                : op === "ceil"
                    ? "iw_ceil_to_i64"
                    : "iw_trunc_to_i64";
        const extractorName = floatExtractorName(typeName);
        return `static inline iw_value_t ${helperName}(iw_value_t value) { return iw_from_i64(${narrowingHelper}((long double)${extractorName}(value, \"${op}_${typeName}\"))); }`;
    }

    function emitBinaryBuiltin(helperName: string): BuiltinEmitter {
        return (args) => `${helperName}(${args[0]}, ${args[1]})`;
    }

    function emitUnaryBuiltin(helperName: string): BuiltinEmitter {
        return (args) => `${helperName}(${args[0]})`;
    }

    const builtinEmitters: ReadonlyMap<string, BuiltinSpec> = new Map<string, BuiltinSpec>([
        ...INTEGER_TYPE_NAMES.flatMap((typeName) => INTEGER_TYPED_BUILTINS.map((name) => [numericBuiltinSymbol(name, typeName), { arity: 2, emit: emitBinaryBuiltin(numericHelperSymbol(name, typeName)) }] as [string, BuiltinSpec])),
        ...FLOAT_ARITHMETIC_BUILTINS.flatMap((name) => FLOAT_TYPE_NAMES.map((typeName) => [numericBuiltinSymbol(name, typeName), { arity: 2, emit: emitBinaryBuiltin(numericHelperSymbol(name, typeName)) }] as [string, BuiltinSpec])),
        ...FLOAT_COMPARISON_BUILTINS.flatMap((name) => FLOAT_TYPE_NAMES.map((typeName) => [numericBuiltinSymbol(name, typeName), { arity: 2, emit: emitBinaryBuiltin(numericHelperSymbol(name, typeName)) }] as [string, BuiltinSpec])),
        ...CHARACTER_COMPARISON_BUILTINS.flatMap((name) => CHARACTER_TYPE_NAMES.map((typeName) => [numericBuiltinSymbol(name, typeName), { arity: 2, emit: emitBinaryBuiltin(numericHelperSymbol(name, typeName)) }] as [string, BuiltinSpec])),
        ...FLOAT_TO_I5_UNARY_BUILTINS.flatMap((name) => FLOAT_TYPE_NAMES.map((typeName) => [numericBuiltinSymbol(name, typeName), { arity: 1, emit: emitUnaryBuiltin(numericHelperSymbol(name, typeName)) }] as [string, BuiltinSpec])),
        ...buildTextPrimitiveEmitterEntries(),
        ...buildComplexEmitterEntries(),
        ...buildScalarConversionEmitterEntries(),
        ["not", { arity: 1, emit: ([value]) => `iw_builtin_not(${value})` }],
        ["and", { arity: 2, emit: ([left, right]) => `iw_builtin_and(${left}, ${right})` }],
        ["or", { arity: 2, emit: ([left, right]) => `iw_builtin_or(${left}, ${right})` }],
        ["xor", { arity: 2, emit: ([left, right]) => `iw_builtin_xor(${left}, ${right})` }],
        ["array_new", { arity: 2, emit: ([length, initialValue]) => `iw_builtin_array_new(${length}, ${initialValue})` }],
        ["array_get", { arity: 2, emit: ([arrayValue, index]) => `iw_builtin_array_get(${arrayValue}, ${index})` }],
        ["array_set", { arity: 3, emit: ([arrayValue, index, value]) => `iw_builtin_array_set(${arrayValue}, ${index}, ${value})` }],
        ["array_length", { arity: 1, emit: ([arrayValue]) => `iw_builtin_array_length(${arrayValue})` }],
        ["iw_match_unreachable", { arity: 0, emit: () => "iw_builtin_match_unreachable()" }],
        ["iw_gc_collect", { arity: 0, emit: () => "iw_gc_collect()" }],
        ["iw_i5_to_f5", { arity: 1, emit: ([value]) => `iw_builtin_i5_to_f5(${value})` }],
        ["iw_round_f5", { arity: 1, emit: ([value]) => `iw_builtin_round_f5(${value})` }],
        ["iw_round_f6", { arity: 1, emit: ([value]) => `iw_builtin_round_f6(${value})` }],
        ["iw_round_f7", { arity: 1, emit: ([value]) => `iw_builtin_round_f7(${value})` }],
        ["iw_floor_f5", { arity: 1, emit: ([value]) => `iw_builtin_floor_f5(${value})` }],
        ["iw_floor_f6", { arity: 1, emit: ([value]) => `iw_builtin_floor_f6(${value})` }],
        ["iw_floor_f7", { arity: 1, emit: ([value]) => `iw_builtin_floor_f7(${value})` }],
        ["iw_ceil_f5", { arity: 1, emit: ([value]) => `iw_builtin_ceil_f5(${value})` }],
        ["iw_ceil_f6", { arity: 1, emit: ([value]) => `iw_builtin_ceil_f6(${value})` }],
        ["iw_ceil_f7", { arity: 1, emit: ([value]) => `iw_builtin_ceil_f7(${value})` }],
        ["iw_trunc_f5", { arity: 1, emit: ([value]) => `iw_builtin_trunc_f5(${value})` }],
        ["iw_trunc_f6", { arity: 1, emit: ([value]) => `iw_builtin_trunc_f6(${value})` }],
        ["iw_trunc_f7", { arity: 1, emit: ([value]) => `iw_builtin_trunc_f7(${value})` }],
        ["iw_sin_f5", { arity: 1, emit: ([value]) => `iw_builtin_sin_f5(${value})` }],
        ["iw_sin_f6", { arity: 1, emit: ([value]) => `iw_builtin_sin_f6(${value})` }],
        ["iw_sin_f7", { arity: 1, emit: ([value]) => `iw_builtin_sin_f7(${value})` }],
        ["iw_cos_f5", { arity: 1, emit: ([value]) => `iw_builtin_cos_f5(${value})` }],
        ["iw_cos_f6", { arity: 1, emit: ([value]) => `iw_builtin_cos_f6(${value})` }],
        ["iw_cos_f7", { arity: 1, emit: ([value]) => `iw_builtin_cos_f7(${value})` }],
        ["iw_sqrt_f5", { arity: 1, emit: ([value]) => `iw_builtin_sqrt_f5(${value})` }],
        ["iw_sqrt_f6", { arity: 1, emit: ([value]) => `iw_builtin_sqrt_f6(${value})` }],
        ["iw_sqrt_f7", { arity: 1, emit: ([value]) => `iw_builtin_sqrt_f7(${value})` }],
        ["iw_atan2_f5", { arity: 2, emit: ([y, x]) => `iw_builtin_atan2_f5(${y}, ${x})` }],
        ["iw_atan2_f6", { arity: 2, emit: ([y, x]) => `iw_builtin_atan2_f6(${y}, ${x})` }],
        ["iw_atan2_f7", { arity: 2, emit: ([y, x]) => `iw_builtin_atan2_f7(${y}, ${x})` }],
        ["iw_stdin_read_i5", { arity: 0, emit: () => "iw_builtin_stdin_read_i5()" }],
        ["iw_stdin_read_f5", { arity: 0, emit: () => "iw_builtin_stdin_read_f5()" }],
        ["iw_stdin_read_line_s3", { arity: 0, emit: () => "iw_builtin_stdin_read_line_s3()" }],
        ["iw_stdout_write_s3", { arity: 1, emit: ([value]) => `iw_builtin_stdout_write_text(${value})` }],
        ["iw_stdout_write_s4", { arity: 1, emit: ([value]) => `iw_builtin_stdout_write_text(${value})` }],
        ["iw_stdout_write_s5", { arity: 1, emit: ([value]) => `iw_builtin_stdout_write_text(${value})` }],
        ["iw_stdout_println_s3", { arity: 1, emit: ([value]) => `iw_builtin_stdout_println_text(${value})` }],
        ["iw_stdout_println_s4", { arity: 1, emit: ([value]) => `iw_builtin_stdout_println_text(${value})` }],
        ["iw_stdout_println_s5", { arity: 1, emit: ([value]) => `iw_builtin_stdout_println_text(${value})` }],
        ["iw_stdout_write_c3", { arity: 1, emit: ([value]) => `iw_builtin_stdout_write_char(${value})` }],
        ["iw_stdout_write_i5_ascii", { arity: 1, emit: ([value]) => `iw_builtin_stdout_write_i5_ascii(${value})` }],
        ["iw_stdout_write_f5_ascii", { arity: 1, emit: ([value]) => `iw_builtin_stdout_write_f5_ascii(${value})` }],
        ["iw_stderr_write_s3", { arity: 1, emit: ([value]) => `iw_builtin_stderr_write_text(${value})` }],
        ["iw_stderr_write_s4", { arity: 1, emit: ([value]) => `iw_builtin_stderr_write_text(${value})` }],
        ["iw_stderr_write_s5", { arity: 1, emit: ([value]) => `iw_builtin_stderr_write_text(${value})` }],
        ["iw_stderr_println_s3", { arity: 1, emit: ([value]) => `iw_builtin_stderr_println_text(${value})` }],
        ["iw_stderr_println_s4", { arity: 1, emit: ([value]) => `iw_builtin_stderr_println_text(${value})` }],
        ["iw_stderr_println_s5", { arity: 1, emit: ([value]) => `iw_builtin_stderr_println_text(${value})` }],
        ["iw_stderr_write_c3", { arity: 1, emit: ([value]) => `iw_builtin_stderr_write_char(${value})` }],
        ["iw_stderr_write_i5_ascii", { arity: 1, emit: ([value]) => `iw_builtin_stderr_write_i5_ascii(${value})` }],
        ["iw_stderr_write_f5_ascii", { arity: 1, emit: ([value]) => `iw_builtin_stderr_write_f5_ascii(${value})` }],
        ["iw_stdout_flush", { arity: 0, emit: () => "iw_builtin_stdout_flush()" }],
        ["iw_stderr_flush", { arity: 0, emit: () => "iw_builtin_stderr_flush()" }],
        ["iw_read_file_s3", { arity: 1, emit: ([path]) => `iw_builtin_read_file_s3(${path})` }],
        ["iw_write_file_s3", { arity: 2, emit: ([path, value]) => `iw_builtin_write_file_s3(${path}, ${value})` }],
        ["iw_append_file_s3", { arity: 2, emit: ([path, value]) => `iw_builtin_append_file_s3(${path}, ${value})` }],
        ["iw_file_open_write_s3", { arity: 1, emit: ([path]) => `iw_builtin_file_open_write_s3(${path})` }],
        ["iw_file_open_append_s3", { arity: 1, emit: ([path]) => `iw_builtin_file_open_append_s3(${path})` }],
        ["iw_file_close", { arity: 1, emit: ([handle]) => `iw_builtin_file_close(${handle})` }],
        ["iw_file_write_s3", { arity: 2, emit: ([handle, value]) => `iw_builtin_file_write_s3(${handle}, ${value})` }],
        ["iw_file_write_c3", { arity: 2, emit: ([handle, value]) => `iw_builtin_file_write_c3(${handle}, ${value})` }],
        ["iw_file_write_i5_ascii", { arity: 2, emit: ([handle, value]) => `iw_builtin_file_write_i5_ascii(${handle}, ${value})` }],
        ["iw_file_write_f5_ascii", { arity: 2, emit: ([handle, value]) => `iw_builtin_file_write_f5_ascii(${handle}, ${value})` }]
    ]);

    const builtinRuntimeTypes: readonly BuiltinRuntimeTypeArtifact[] = [
        { symbolName: "iw_runtime_type_float_f5", runtimeTypeTagId: F5_BOXED_RUNTIME_TYPE_TAG_ID },
        { symbolName: "iw_runtime_type_float_f6", runtimeTypeTagId: F6_BOXED_RUNTIME_TYPE_TAG_ID },
        { symbolName: "iw_runtime_type_float_f7", runtimeTypeTagId: F7_BOXED_RUNTIME_TYPE_TAG_ID },
        { symbolName: "iw_runtime_type_complex_z5", runtimeTypeTagId: runtimeTypeTagLiteral(Z5_RUNTIME_TYPE_TAG_ID).slice(2, -3) ? Z5_RUNTIME_TYPE_TAG_ID : Z5_RUNTIME_TYPE_TAG_ID },
        { symbolName: "iw_runtime_type_complex_z6", runtimeTypeTagId: runtimeTypeTagLiteral(Z6_RUNTIME_TYPE_TAG_ID).slice(2, -3) ? Z6_RUNTIME_TYPE_TAG_ID : Z6_RUNTIME_TYPE_TAG_ID },
        { symbolName: "iw_runtime_type_complex_z7", runtimeTypeTagId: runtimeTypeTagLiteral(Z7_RUNTIME_TYPE_TAG_ID).slice(2, -3) ? Z7_RUNTIME_TYPE_TAG_ID : Z7_RUNTIME_TYPE_TAG_ID },
        { symbolName: "iw_runtime_type_array", runtimeTypeTagId: "A4152524159000001" },
        { symbolName: "iw_runtime_type_text", runtimeTypeTagId: "T5445585400000001" }
    ];

    const builtinHelpers = [
        "typedef intptr_t iw_value_t;",
        "typedef enum iw_runtime_kind_t { IW_RUNTIME_KIND_FLOAT = 1, IW_RUNTIME_KIND_UNION = 2, IW_RUNTIME_KIND_ARRAY = 3, IW_RUNTIME_KIND_TEXT = 4, IW_RUNTIME_KIND_CLASS = 5, IW_RUNTIME_KIND_CLOSURE = 6, IW_RUNTIME_KIND_COMPLEX = 7 } iw_runtime_kind_t;",
        "typedef enum iw_gc_metadata_kind_t { IW_GC_METADATA_HEAP = 1, IW_GC_METADATA_FRAME = 2, IW_GC_METADATA_GLOBAL = 3 } iw_gc_metadata_kind_t;",
        "typedef enum iw_gc_length_kind_t { IW_GC_LENGTH_NONE = 0, IW_GC_LENGTH_I64 = 1, IW_GC_LENGTH_U32 = 2 } iw_gc_length_kind_t;",
        "typedef enum iw_gc_variable_member_kind_t { IW_GC_VARIABLE_MEMBER_NONE = 0, IW_GC_VARIABLE_MEMBER_VALUE = 1, IW_GC_VARIABLE_MEMBER_BYTE = 2 } iw_gc_variable_member_kind_t;",
        "typedef struct iw_runtime_slot_info_t { const char *name; uint64_t type_tag; size_t offset; } iw_runtime_slot_info_t;",
        "typedef struct iw_runtime_union_member_info_t { uint64_t type_tag; } iw_runtime_union_member_info_t;",
        "typedef struct iw_runtime_method_info_t { const char *name; const char *symbol; uint32_t arity; } iw_runtime_method_info_t;",
        "typedef struct iw_runtime_type_info_t { uint64_t tag; iw_runtime_kind_t kind; const char *name; uint32_t gc_slot_count; const iw_runtime_slot_info_t *gc_slots; uint32_t union_member_count; const iw_runtime_union_member_info_t *union_members; uint32_t method_count; const iw_runtime_method_info_t *methods; uint32_t capture_count; const iw_runtime_slot_info_t *captures; uint32_t closure_arity; const char *closure_apply_symbol; uint64_t closure_environment_tag; } iw_runtime_type_info_t;",
        "typedef struct iw_gc_metadata_ref_t { uint64_t first_tag; uint64_t end_confirmation; } iw_gc_metadata_ref_t;",
        "typedef struct iw_gc_metadata_key_t { uint64_t uuid_hi; uint64_t uuid_lo; uint64_t uuid_hash; const char *name; } iw_gc_metadata_key_t;",
        "typedef struct iw_gc_metadata_entry_t { uint64_t table_uuid_hi; uint64_t table_uuid_lo; uint64_t table_uuid_hash; uint64_t struct_uuid_hi; uint64_t struct_uuid_lo; uint64_t first_tag; uint64_t struct_uuid_hash; uint64_t layout_hash; uint64_t static_info_hash; uint64_t end_confirmation; const char *name; iw_gc_metadata_kind_t kind; iw_gc_length_kind_t length_kind; size_t fixed_size_bytes; size_t length_offset_bytes; size_t length_scale_bytes; size_t length_bias_bytes; iw_gc_variable_member_kind_t variable_member_kind; const char *variable_member_label; uint32_t slot_count; uint8_t structure_only; } iw_gc_metadata_entry_t;",
        "typedef struct iw_gc_metadata_table_t { const char *name; uint32_t key_count; const iw_gc_metadata_key_t *keys; uint32_t entry_count; const iw_gc_metadata_entry_t *const *entries; } iw_gc_metadata_table_t;",
        "typedef struct iw_gc_metadata_lookup_node_t { const iw_gc_metadata_entry_t *entry; struct iw_gc_metadata_lookup_node_t *next; } iw_gc_metadata_lookup_node_t;",
        "typedef struct iw_gc_metadata_ref_lookup_bucket_t { uint64_t first_tag; uint64_t end_confirmation; const iw_gc_metadata_entry_t *entry; } iw_gc_metadata_ref_lookup_bucket_t;",
        "typedef struct iw_gc_metadata_key_lookup_bucket_t { uint64_t uuid_hi; uint64_t uuid_lo; uint64_t uuid_hash; const iw_gc_metadata_key_t *key; } iw_gc_metadata_key_lookup_bucket_t;",
        "typedef struct iw_gc_runtime_type_binding_t { uint64_t runtime_tag; iw_gc_metadata_ref_t metadata_ref; } iw_gc_runtime_type_binding_t;",
        "typedef struct iw_gc_global_table_t { const char *name; const void *block_base; iw_gc_metadata_ref_t metadata_ref; uint32_t slot_count; const iw_runtime_slot_info_t *slots; void (*print_live)(void); } iw_gc_global_table_t;",
        "typedef struct iw_heap_header_t { uint64_t tag; const iw_runtime_type_info_t *type_info; } iw_heap_header_t;",
        "typedef struct iw_gc_heap_registry_entry_t { iw_heap_header_t *base; size_t total_size_bytes; iw_gc_metadata_ref_t metadata_ref; uint8_t marked; } iw_gc_heap_registry_entry_t;",
        "typedef struct iw_gc_thread_state_t { pthread_t thread; pid_t tid; uintptr_t stack_top; uintptr_t safepoint_sp; uint8_t parked; uint32_t blocking_depth; struct iw_gc_thread_state_t *next; } iw_gc_thread_state_t;",
        "static iw_gc_heap_registry_entry_t *iw_gc_heap_registry_entries = NULL;",
        "static iw_gc_metadata_lookup_node_t **iw_gc_metadata_lookup_buckets = NULL;",
        "static size_t iw_gc_metadata_lookup_bucket_count = 0u;",
        "static iw_gc_metadata_ref_lookup_bucket_t *iw_gc_metadata_ref_lookup_buckets = NULL;",
        "static size_t iw_gc_metadata_ref_lookup_bucket_count = 0u;",
        "static iw_gc_metadata_key_lookup_bucket_t *iw_gc_metadata_key_lookup_buckets = NULL;",
        "static size_t iw_gc_metadata_key_lookup_bucket_count = 0u;",
        "static size_t *iw_gc_heap_registry_buckets = NULL;",
        "static size_t iw_gc_heap_registry_count = 0u;",
        "static size_t iw_gc_heap_registry_capacity = 0u;",
        "static size_t iw_gc_heap_registry_bucket_count = 0u;",
        "static pthread_once_t iw_gc_runtime_once = PTHREAD_ONCE_INIT;",
        "static pthread_mutex_t iw_gc_world_lock = PTHREAD_MUTEX_INITIALIZER;",
        "static pthread_cond_t iw_gc_world_cond = PTHREAD_COND_INITIALIZER;",
        "static pthread_mutex_t iw_gc_heap_registry_lock = PTHREAD_MUTEX_INITIALIZER;",
        "static iw_gc_thread_state_t *iw_gc_thread_list = NULL;",
        "static size_t iw_gc_thread_count = 0u;",
        "static size_t iw_gc_parked_thread_count = 0u;",
        "static volatile int iw_gc_stop_requested = 0;",
        "static volatile int iw_gc_collection_in_progress = 0;",
        "static pthread_t iw_gc_collector_thread;",
        "static _Thread_local iw_gc_thread_state_t *iw_gc_current_thread = NULL;",
        "static inline int64_t iw_as_i64(iw_value_t value) { return ((int64_t)value) >> 1; }",
        "static inline iw_value_t iw_from_i64(int64_t value) { return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL); }",
        "static inline int iw_is_heap_value(iw_value_t value) { return value != (iw_value_t)0 && (((uintptr_t)value & 1ULL) == 0ULL); }",
        "static inline void iw_gc_init_runtime(uintptr_t stack_top);",
        "static inline void iw_gc_runtime_global_init_once(void);",
        "static inline int iw_gc_ensure_current_thread_attached(uintptr_t stack_top);",
        "static inline void iw_gc_detach_current_thread(void);",
        "static inline void iw_gc_safepoint_poll(uintptr_t current_sp);",
        "static inline void iw_gc_blocking_section_begin(uintptr_t current_sp);",
        "static inline void iw_gc_blocking_section_end(void);",
        "static inline void iw_gc_begin_stop_the_world(uintptr_t current_sp);",
        "static inline void iw_gc_end_stop_the_world(void);",
        "static inline iw_gc_metadata_ref_t iw_gc_metadata_ref_for_runtime_type(uint64_t runtime_tag);",
        "static inline size_t iw_gc_total_size_bytes(const iw_gc_metadata_entry_t *metadata, const void *base);",
        "static inline uint64_t iw_gc_end_confirmation_value(const iw_gc_metadata_entry_t *metadata);",
        "static inline uint64_t* iw_gc_end_confirmation_slot(void *base, size_t total_size_bytes);",
        "static inline void iw_gc_write_end_confirmation(void *base, const iw_gc_metadata_entry_t *metadata, size_t total_size_bytes);",
        "static inline int iw_gc_validate_tagged_block(const void *base, const iw_gc_metadata_entry_t *metadata);",
        "static inline void* iw_gc_allocate(size_t total_size_bytes, const iw_runtime_type_info_t *type_info, iw_gc_metadata_ref_t metadata_ref, const char *context);",
        "static inline void iw_gc_publish_allocation(iw_heap_header_t *base, size_t total_size_bytes, iw_gc_metadata_ref_t metadata_ref);",
        "static inline iw_gc_heap_registry_entry_t* iw_gc_lookup_heap_registry_entry(iw_heap_header_t *base);",
        "static inline iw_heap_header_t* iw_expect_heap_header(iw_value_t raw_value, const char *context);",
        "static inline void iw_gc_rebuild_metadata_lookup_indexes(void);",
        "static inline iw_value_t iw_gc_collect(void);",
        "static inline void iw_gc_mark_value(iw_value_t value);",
        "static inline void iw_gc_mark_thread_runtime_roots(void);",
        "static inline void iw_gc_print_value_summary(iw_value_t value);",
        "typedef struct iw_float_value_t { iw_heap_header_t header; long double value; } iw_float_value_t;",
        "typedef struct iw_complex_value_t { iw_heap_header_t header; long double real; long double imag; } iw_complex_value_t;",
        "typedef struct iw_complex_parts_t { long double real; long double imag; } iw_complex_parts_t;",
        "typedef struct iw_union_value_t { iw_heap_header_t header; uint64_t member_tag; iw_value_t payload; } iw_union_value_t;",
        "typedef struct iw_array_value_t { iw_heap_header_t header; int64_t length; iw_value_t items[]; } iw_array_value_t;",
        "typedef struct iw_text_value_t { iw_heap_header_t header; uint32_t length; const char *data; } iw_text_value_t;",
        "typedef struct iw_closure_value_t { iw_heap_header_t header; uintptr_t apply; iw_value_t env; uint32_t arity; } iw_closure_value_t;",
        "#define IW_IO_MAX_HANDLES 64",
        `static const iw_runtime_type_info_t iw_runtime_type_float_f5 = { ${runtimeTypeTagLiteral(F5_BOXED_RUNTIME_TYPE_TAG_ID)}, IW_RUNTIME_KIND_FLOAT, \"f5\", 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };`,
        `static const iw_runtime_type_info_t iw_runtime_type_float_f6 = { ${runtimeTypeTagLiteral(F6_BOXED_RUNTIME_TYPE_TAG_ID)}, IW_RUNTIME_KIND_FLOAT, \"f6\", 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };`,
        `static const iw_runtime_type_info_t iw_runtime_type_float_f7 = { ${runtimeTypeTagLiteral(F7_BOXED_RUNTIME_TYPE_TAG_ID)}, IW_RUNTIME_KIND_FLOAT, \"f7\", 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };`,
        `static const iw_runtime_type_info_t iw_runtime_type_complex_z5 = { ${runtimeTypeTagLiteral(Z5_RUNTIME_TYPE_TAG_ID)}, IW_RUNTIME_KIND_COMPLEX, \"z5\", 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };`,
        `static const iw_runtime_type_info_t iw_runtime_type_complex_z6 = { ${runtimeTypeTagLiteral(Z6_RUNTIME_TYPE_TAG_ID)}, IW_RUNTIME_KIND_COMPLEX, \"z6\", 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };`,
        `static const iw_runtime_type_info_t iw_runtime_type_complex_z7 = { ${runtimeTypeTagLiteral(Z7_RUNTIME_TYPE_TAG_ID)}, IW_RUNTIME_KIND_COMPLEX, \"z7\", 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };`,
        "static const iw_runtime_type_info_t iw_runtime_type_array = { 0x4152524159000001ULL, IW_RUNTIME_KIND_ARRAY, \"array\", 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };",
        "static const iw_runtime_type_info_t iw_runtime_type_text = { 0x5445585400000001ULL, IW_RUNTIME_KIND_TEXT, \"text\", 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0u, NULL, 0ULL };",
        "static inline iw_value_t iw_float_box(const iw_runtime_type_info_t *type_info, long double value) { iw_gc_metadata_ref_t metadata_ref = iw_gc_metadata_ref_for_runtime_type(type_info->tag); iw_float_value_t *boxed = (iw_float_value_t*)iw_gc_allocate(sizeof(iw_float_value_t), type_info, metadata_ref, \"float\"); boxed->value = value; iw_gc_publish_allocation((iw_heap_header_t*)boxed, sizeof(iw_float_value_t), metadata_ref); return (iw_value_t)(intptr_t)boxed; }",
        "static inline iw_float_value_t* iw_float_expect(iw_value_t raw_value, uint64_t expected_tag, const char *context) { iw_float_value_t *value = (iw_float_value_t*)(intptr_t)iw_expect_heap_header(raw_value, context); if (value->header.tag != expected_tag) { fprintf(stderr, \"Ironwall C backend float tag mismatch in %s\\n\", context); abort(); } return value; }",
        "static inline iw_value_t iw_complex_box(const iw_runtime_type_info_t *type_info, long double real, long double imag) { iw_gc_metadata_ref_t metadata_ref = iw_gc_metadata_ref_for_runtime_type(type_info->tag); iw_complex_value_t *boxed = (iw_complex_value_t*)iw_gc_allocate(sizeof(iw_complex_value_t), type_info, metadata_ref, \"complex\"); boxed->real = real; boxed->imag = imag; iw_gc_publish_allocation((iw_heap_header_t*)boxed, sizeof(iw_complex_value_t), metadata_ref); return (iw_value_t)(intptr_t)boxed; }",
        "static inline iw_complex_value_t* iw_complex_expect(iw_value_t raw_value, uint64_t expected_tag, const char *context) { iw_complex_value_t *value = (iw_complex_value_t*)(intptr_t)iw_expect_heap_header(raw_value, context); if (value->header.tag != expected_tag) { fprintf(stderr, \"Ironwall C backend complex tag mismatch in %s\\n\", context); abort(); } return value; }",
        "static inline iw_value_t iw_from_f32(float value) { return iw_float_box(&iw_runtime_type_float_f5, (long double)value); }",
        "static inline iw_value_t iw_from_f64(double value) { return iw_float_box(&iw_runtime_type_float_f6, (long double)value); }",
        "static inline iw_value_t iw_from_f128(long double value) { return iw_float_box(&iw_runtime_type_float_f7, value); }",
        `static inline float iw_as_f32(iw_value_t value, const char *context) { return (float)iw_float_expect(value, ${runtimeTypeTagLiteral(F5_BOXED_RUNTIME_TYPE_TAG_ID)}, context)->value; }`,
        `static inline double iw_as_f64(iw_value_t value, const char *context) { return (double)iw_float_expect(value, ${runtimeTypeTagLiteral(F6_BOXED_RUNTIME_TYPE_TAG_ID)}, context)->value; }`,
        `static inline long double iw_as_f128(iw_value_t value, const char *context) { return iw_float_expect(value, ${runtimeTypeTagLiteral(F7_BOXED_RUNTIME_TYPE_TAG_ID)}, context)->value; }`,
        "static inline long double iw_wrap_angle(long double value) { const long double pi = 3.141592653589793238462643383279502884L; const long double two_pi = 6.283185307179586476925286766559005768L; while (value > pi) { value -= two_pi; } while (value < -pi) { value += two_pi; } return value; }",
        "static inline long double iw_sin_taylor(long double x) { long double x2 = x * x; long double term = x; long double result = term; term *= -x2 / (2.0L * 3.0L); result += term; term *= -x2 / (4.0L * 5.0L); result += term; term *= -x2 / (6.0L * 7.0L); result += term; term *= -x2 / (8.0L * 9.0L); result += term; term *= -x2 / (10.0L * 11.0L); result += term; term *= -x2 / (12.0L * 13.0L); result += term; term *= -x2 / (14.0L * 15.0L); result += term; return result; }",
        "static inline long double iw_cos_taylor(long double x) { long double x2 = x * x; long double term = 1.0L; long double result = term; term *= -x2 / (1.0L * 2.0L); result += term; term *= -x2 / (3.0L * 4.0L); result += term; term *= -x2 / (5.0L * 6.0L); result += term; term *= -x2 / (7.0L * 8.0L); result += term; term *= -x2 / (9.0L * 10.0L); result += term; term *= -x2 / (11.0L * 12.0L); result += term; term *= -x2 / (13.0L * 14.0L); result += term; return result; }",
        "static inline long double iw_sin_approx(long double value) { const long double pi = 3.141592653589793238462643383279502884L; const long double half_pi = 1.570796326794896619231321691639751442L; long double x = iw_wrap_angle(value); if (x > half_pi) { x = pi - x; } else if (x < -half_pi) { x = -pi - x; } return iw_sin_taylor(x); }",
        "static inline long double iw_cos_approx(long double value) { const long double pi = 3.141592653589793238462643383279502884L; const long double half_pi = 1.570796326794896619231321691639751442L; long double x = iw_wrap_angle(value); long double sign = 1.0L; if (x > half_pi) { x = pi - x; sign = -1.0L; } else if (x < -half_pi) { x = -pi - x; sign = -1.0L; } return sign * iw_cos_taylor(x); }",
        "static inline long double iw_sqrt_approx(long double value) { if (value < 0.0L) { fprintf(stderr, \"Ironwall sqrt_f5 expected non-negative input\\n\"); abort(); } if (value == 0.0L) { return 0.0L; } long double guess = value > 1.0L ? value : 1.0L; for (int step = 0; step < 12; step += 1) { guess = 0.5L * (guess + (value / guess)); } return guess; }",
        "static inline long double iw_exp_approx(long double value) { const long double ln2 = 0.693147180559945309417232121458176568L; long double scaled_value = value / ln2; int64_t scale = (int64_t)scaled_value; if ((long double)scale > scaled_value) { scale -= 1; } long double reduced = value - ((long double)scale * ln2); long double term = 1.0L; long double result = 1.0L; for (int step = 1; step <= 18; step += 1) { term *= reduced / (long double)step; result += term; } while (scale > 0) { result *= 2.0L; scale -= 1; } while (scale < 0) { result *= 0.5L; scale += 1; } return result; }",
        "static inline long double iw_log_approx(long double value) { const long double ln2 = 0.693147180559945309417232121458176568L; if (value <= 0.0L) { fprintf(stderr, \"Ironwall complex log expected positive magnitude\\n\"); abort(); } int64_t scale = 0; while (value > 1.5L) { value *= 0.5L; scale += 1; } while (value < 0.75L) { value *= 2.0L; scale -= 1; } long double t = (value - 1.0L) / (value + 1.0L); long double t2 = t * t; long double term = t; long double series = term; for (int step = 3; step <= 19; step += 2) { term *= t2; series += term / (long double)step; } return (2.0L * series) + ((long double)scale * ln2); }",
        "static inline long double iw_atan_approx(long double value) { const long double pi_over_2 = 1.570796326794896619231321691639751442L; if (value > 1.0L) { return pi_over_2 - iw_atan_approx(1.0L / value); } if (value < -1.0L) { return -pi_over_2 - iw_atan_approx(1.0L / value); } long double x2 = value * value; long double term = value; long double result = term; term *= -x2; result += term / 3.0L; term *= -x2; result += term / 5.0L; term *= -x2; result += term / 7.0L; term *= -x2; result += term / 9.0L; term *= -x2; result += term / 11.0L; return result; }",
        "static inline long double iw_atan2_approx(long double y, long double x) { const long double pi = 3.141592653589793238462643383279502884L; const long double pi_over_2 = 1.570796326794896619231321691639751442L; if (x > 0.0L) { return iw_atan_approx(y / x); } if (x < 0.0L && y >= 0.0L) { return iw_atan_approx(y / x) + pi; } if (x < 0.0L && y < 0.0L) { return iw_atan_approx(y / x) - pi; } if (x == 0.0L && y > 0.0L) { return pi_over_2; } if (x == 0.0L && y < 0.0L) { return -pi_over_2; } return 0.0L; }",
        "static inline long double iw_fmod_approx(long double left, long double right) { int64_t truncated = (int64_t)(left / right); return left - ((long double)truncated * right); }",
        "static inline long double iw_complex_abs(long double real, long double imag) { return iw_sqrt_approx((real * real) + (imag * imag)); }",
        "static inline iw_complex_parts_t iw_complex_mul_parts(long double ar, long double ai, long double br, long double bi) { iw_complex_parts_t result; result.real = (ar * br) - (ai * bi); result.imag = (ar * bi) + (ai * br); return result; }",
        "static inline iw_complex_parts_t iw_complex_exp_parts(long double real, long double imag) { long double scale = iw_exp_approx(real); iw_complex_parts_t result; result.real = scale * iw_cos_approx(imag); result.imag = scale * iw_sin_approx(imag); return result; }",
        "static inline iw_complex_parts_t iw_complex_log_parts(long double real, long double imag) { iw_complex_parts_t result; result.real = iw_log_approx(iw_complex_abs(real, imag)); result.imag = iw_atan2_approx(imag, real); return result; }",
        "static inline iw_complex_parts_t iw_complex_sqrt_parts(long double real, long double imag) { long double magnitude = iw_complex_abs(real, imag); long double real_part = iw_sqrt_approx((magnitude + real) * 0.5L); long double imag_seed = (magnitude - real) * 0.5L; long double imag_part = iw_sqrt_approx(imag_seed < 0.0L ? 0.0L : imag_seed); if (imag < 0.0L) { imag_part = -imag_part; } iw_complex_parts_t result; result.real = real_part; result.imag = imag_part; return result; }",
        "static inline iw_complex_parts_t iw_complex_pow_parts(long double base_real, long double base_imag, long double exponent_real, long double exponent_imag) { iw_complex_parts_t logged = iw_complex_log_parts(base_real, base_imag); iw_complex_parts_t scaled = iw_complex_mul_parts(exponent_real, exponent_imag, logged.real, logged.imag); return iw_complex_exp_parts(scaled.real, scaled.imag); }",
        "static inline int64_t iw_trunc_to_i64(long double value) { return (int64_t)value; }",
        "static inline int64_t iw_floor_to_i64(long double value) { int64_t truncated = (int64_t)value; return (long double)truncated > value ? truncated - 1 : truncated; }",
        "static inline int64_t iw_ceil_to_i64(long double value) { int64_t truncated = (int64_t)value; return (long double)truncated < value ? truncated + 1 : truncated; }",
        "static inline int64_t iw_round_to_i64(long double value) { return (int64_t)(value >= 0.0L ? value + 0.5L : value - 0.5L); }",
        "static inline iw_value_t iw_builtin_i5_to_f5(iw_value_t value) { return iw_from_f32((float)(int32_t)iw_as_i64(value)); }",
        "static inline iw_value_t iw_builtin_sin_f5(iw_value_t value) { return iw_from_f32((float)iw_sin_approx((long double)iw_as_f32(value, \"sin_f5\"))); }",
        "static inline iw_value_t iw_builtin_sin_f6(iw_value_t value) { return iw_from_f64((double)iw_sin_approx((long double)iw_as_f64(value, \"sin_f6\"))); }",
        "static inline iw_value_t iw_builtin_sin_f7(iw_value_t value) { return iw_from_f128(iw_sin_approx(iw_as_f128(value, \"sin_f7\"))); }",
        "static inline iw_value_t iw_builtin_cos_f5(iw_value_t value) { return iw_from_f32((float)iw_cos_approx((long double)iw_as_f32(value, \"cos_f5\"))); }",
        "static inline iw_value_t iw_builtin_cos_f6(iw_value_t value) { return iw_from_f64((double)iw_cos_approx((long double)iw_as_f64(value, \"cos_f6\"))); }",
        "static inline iw_value_t iw_builtin_cos_f7(iw_value_t value) { return iw_from_f128(iw_cos_approx(iw_as_f128(value, \"cos_f7\"))); }",
        "static inline iw_value_t iw_builtin_sqrt_f5(iw_value_t value) { return iw_from_f32((float)iw_sqrt_approx((long double)iw_as_f32(value, \"sqrt_f5\"))); }",
        "static inline iw_value_t iw_builtin_sqrt_f6(iw_value_t value) { return iw_from_f64((double)iw_sqrt_approx((long double)iw_as_f64(value, \"sqrt_f6\"))); }",
        "static inline iw_value_t iw_builtin_sqrt_f7(iw_value_t value) { return iw_from_f128(iw_sqrt_approx(iw_as_f128(value, \"sqrt_f7\"))); }",
        "static inline iw_value_t iw_builtin_atan2_f5(iw_value_t y, iw_value_t x) { return iw_from_f32((float)iw_atan2_approx((long double)iw_as_f32(y, \"atan2_f5 y\"), (long double)iw_as_f32(x, \"atan2_f5 x\"))); }",
        "static inline iw_value_t iw_builtin_atan2_f6(iw_value_t y, iw_value_t x) { return iw_from_f64((double)iw_atan2_approx((long double)iw_as_f64(y, \"atan2_f6 y\"), (long double)iw_as_f64(x, \"atan2_f6 x\"))); }",
        "static inline iw_value_t iw_builtin_atan2_f7(iw_value_t y, iw_value_t x) { return iw_from_f128(iw_atan2_approx(iw_as_f128(y, \"atan2_f7 y\"), iw_as_f128(x, \"atan2_f7 x\"))); }",
        ...buildScalarConversionHelpers(),
        ...buildComplexBuiltinHelpers(),
        "static inline iw_value_t iw_union_box(const iw_runtime_type_info_t *type_info, uint64_t member_tag, iw_value_t payload) { iw_gc_metadata_ref_t metadata_ref = iw_gc_metadata_ref_for_runtime_type(type_info->tag); iw_union_value_t *value = (iw_union_value_t*)iw_gc_allocate(sizeof(iw_union_value_t), type_info, metadata_ref, \"union\"); value->member_tag = member_tag; value->payload = payload; iw_gc_publish_allocation((iw_heap_header_t*)value, sizeof(iw_union_value_t), metadata_ref); return (iw_value_t)(intptr_t)value; }",
        "static inline iw_union_value_t* iw_union_expect(iw_value_t raw_value, uint64_t union_tag, const char *context) { iw_union_value_t *value = (iw_union_value_t*)(intptr_t)iw_expect_heap_header(raw_value, context); if (value->header.tag != union_tag) { fprintf(stderr, \"Ironwall C backend union member tag mismatch in %s\\n\", context); abort(); } return value; }",
        "static inline iw_value_t iw_union_has_member(iw_value_t raw_value, uint64_t union_tag, uint64_t member_tag, const char *context) { iw_union_value_t *value = iw_union_expect(raw_value, union_tag, context); return iw_from_i64(value->member_tag == member_tag ? 1 : 0); }",
        "static inline iw_value_t iw_union_get_payload(iw_value_t raw_value, uint64_t union_tag, uint64_t member_tag, const char *context) { iw_union_value_t *value = iw_union_expect(raw_value, union_tag, context); if (value->member_tag != member_tag) { fprintf(stderr, \"Ironwall C backend union member tag mismatch in %s\\n\", context); abort(); } return value->payload; }",
        ...INTEGER_TYPE_NAMES.flatMap((typeName) => INTEGER_TYPED_BUILTINS.map((name) => buildIntegerBuiltinHelper(name, typeName))),
        ...FLOAT_ARITHMETIC_BUILTINS.flatMap((name) => {
            const operator = name === "add" ? "+" : name === "sub" ? "-" : name === "mul" ? "*" : name === "div" ? "/" : "%";
            return FLOAT_TYPE_NAMES.map((typeName) => buildFloatArithmeticHelper(name, typeName, operator));
        }),
        ...FLOAT_COMPARISON_BUILTINS.flatMap((name) => {
            const operator = name === "le" ? "<=" : name === "lt" ? "<" : name === "ge" ? ">=" : name === "gt" ? ">" : name === "eq" ? "==" : "!=";
            return FLOAT_TYPE_NAMES.map((typeName) => buildFloatComparisonHelper(name, typeName, operator));
        }),
        ...CHARACTER_COMPARISON_BUILTINS.flatMap((name) => CHARACTER_TYPE_NAMES.map((typeName) => buildCharacterComparisonHelper(name, typeName))),
        ...FLOAT_TO_I5_UNARY_BUILTINS.flatMap((name) => FLOAT_TYPE_NAMES.map((typeName) => buildFloatToI5UnaryHelper(name, typeName))),
        "static inline iw_value_t iw_builtin_not(iw_value_t value) { return iw_from_i64((iw_as_i64(value) == 0) ? 1 : 0); }",
        "static inline iw_value_t iw_builtin_and(iw_value_t left, iw_value_t right) { return iw_from_i64((iw_as_i64(left) != 0 && iw_as_i64(right) != 0) ? 1 : 0); }",
        "static inline iw_value_t iw_builtin_or(iw_value_t left, iw_value_t right) { return iw_from_i64((iw_as_i64(left) != 0 || iw_as_i64(right) != 0) ? 1 : 0); }",
        "static inline iw_value_t iw_builtin_xor(iw_value_t left, iw_value_t right) { return iw_from_i64(((iw_as_i64(left) != 0) != (iw_as_i64(right) != 0)) ? 1 : 0); }",
        "static inline iw_array_value_t* iw_array_expect(iw_value_t raw_value, const char *context) { iw_array_value_t *value = (iw_array_value_t*)(intptr_t)iw_expect_heap_header(raw_value, context); if (value->header.tag != 0x4152524159000001ULL) { fprintf(stderr, \"Ironwall C backend array tag mismatch in %s\\n\", context); abort(); } return value; }",
        "static inline iw_array_value_t* iw_array_index(iw_value_t raw_value, iw_value_t raw_index, const char *context) { iw_array_value_t *value = iw_array_expect(raw_value, context); int64_t index = iw_as_i64(raw_index); if (index < 0 || index >= value->length) { fprintf(stderr, \"Ironwall array index out of bounds in %s: index=%lld length=%lld\\n\", context, (long long)index, (long long)value->length); abort(); } return value; }",
        "static inline iw_value_t iw_builtin_array_new(iw_value_t raw_length, iw_value_t initial_value) { int64_t length = iw_as_i64(raw_length); if (length < 0) { fprintf(stderr, \"Ironwall array length must be non-negative: %lld\\n\", (long long)length); abort(); } size_t total_size = sizeof(iw_array_value_t) + ((size_t)length * sizeof(iw_value_t)); iw_gc_metadata_ref_t metadata_ref = iw_gc_metadata_ref_for_runtime_type(iw_runtime_type_array.tag); iw_array_value_t *value = (iw_array_value_t*)iw_gc_allocate(total_size, &iw_runtime_type_array, metadata_ref, \"array\"); value->length = length; for (int64_t index = 0; index < length; index += 1) { value->items[index] = initialValue; } iw_gc_publish_allocation((iw_heap_header_t*)value, total_size, metadata_ref); return (iw_value_t)(intptr_t)value; }".replace("initialValue", "initial_value"),
        "static inline iw_value_t iw_builtin_array_get(iw_value_t raw_value, iw_value_t raw_index) { iw_array_value_t *value = iw_array_index(raw_value, raw_index, \"array_get\"); return value->items[iw_as_i64(raw_index)]; }",
        "static inline iw_value_t iw_builtin_array_set(iw_value_t raw_value, iw_value_t raw_index, iw_value_t element_value) { iw_array_value_t *value = iw_array_index(raw_value, raw_index, \"array_set\"); value->items[iw_as_i64(raw_index)] = element_value; return iw_from_i64(0); }",
        "static inline iw_value_t iw_builtin_array_length(iw_value_t raw_value) { iw_array_value_t *value = iw_array_expect(raw_value, \"array_length\"); return iw_from_i64(value->length); }",
        "static inline iw_text_value_t* iw_text_expect(iw_value_t raw_value, const char *context) { iw_text_value_t *value = (iw_text_value_t*)(intptr_t)iw_expect_heap_header(raw_value, context); if (value->header.tag != 0x5445585400000001ULL) { fprintf(stderr, \"Ironwall C backend text tag mismatch in %s\\n\", context); abort(); } return value; }",
        "static inline iw_value_t iw_text_copy_bytes(const char *data, size_t length, const char *context);",
        ...buildTextPrimitiveHelpers(),
        "static inline iw_value_t iw_builtin_match_unreachable(void) { fprintf(stderr, \"Ironwall unreachable: exhaustive match failed at runtime\\n\"); abort(); return iw_from_i64(0); }",
        "static FILE *iw_io_handles[IW_IO_MAX_HANDLES] = { NULL };",
        "static inline void iw_io_init(void) { static int initialized = 0; if (initialized) { return; } iw_io_handles[0] = stdin; iw_io_handles[1] = stdout; iw_io_handles[2] = stderr; initialized = 1; }",
        "static inline iw_value_t iw_text_copy_bytes(const char *data, size_t length, const char *context) { size_t total_size = sizeof(iw_text_value_t) + length + 1u; iw_gc_metadata_ref_t metadata_ref = iw_gc_metadata_ref_for_runtime_type(iw_runtime_type_text.tag); iw_text_value_t *value = (iw_text_value_t*)iw_gc_allocate(total_size, &iw_runtime_type_text, metadata_ref, context); char *storage = (char*)(value + 1); if (length != 0u) { memcpy(storage, data, length); } storage[length] = '\\0'; value->length = (uint32_t)length; value->data = storage; iw_gc_publish_allocation((iw_heap_header_t*)value, total_size, metadata_ref); return (iw_value_t)(intptr_t)value; }",
        "static inline FILE* iw_file_from_handle(iw_value_t raw_handle, const char *context) { iw_io_init(); int64_t handle = iw_as_i64(raw_handle); if (handle < 0 || handle >= IW_IO_MAX_HANDLES || iw_io_handles[handle] == NULL) { fprintf(stderr, \"Ironwall invalid file handle in %s: %lld\\n\", context, (long long)handle); abort(); } return iw_io_handles[handle]; }",
        "static inline iw_value_t iw_file_register(FILE *file, const char *context) { iw_io_init(); if (file == NULL) { fprintf(stderr, \"Ironwall failed to open file in %s\\n\", context); abort(); } for (int64_t index = 3; index < IW_IO_MAX_HANDLES; index += 1) { if (iw_io_handles[index] == NULL) { iw_io_handles[index] = file; return iw_from_i64(index); } } fprintf(stderr, \"Ironwall out of file handles in %s\\n\", context); abort(); return iw_from_i64(-1); }",
        "static inline iw_value_t iw_write_text_to_stream(FILE *file, iw_value_t raw_value, const char *context) { iw_text_value_t *value = iw_text_expect(raw_value, context); if (fwrite(value->data, 1, value->length, file) != value->length) { fprintf(stderr, \"Ironwall failed to write text in %s\\n\", context); abort(); } return iw_from_i64(0); }",
        "static inline iw_value_t iw_write_line_text_to_stream(FILE *file, iw_value_t raw_value, const char *context) { iw_write_text_to_stream(file, raw_value, context); if (fputc('\\n', file) == EOF) { fprintf(stderr, \"Ironwall failed to write trailing newline in %s\\n\", context); abort(); } return iw_from_i64(0); }",
        "static inline iw_value_t iw_write_char_to_stream(FILE *file, iw_value_t raw_value, const char *context) { iw_text_value_t *value = iw_text_expect(raw_value, context); if (value->length != 1u) { fprintf(stderr, \"Ironwall expected single char text in %s, got length=%u\\n\", context, (unsigned)value->length); abort(); } if (fputc((unsigned char)value->data[0], file) == EOF) { fprintf(stderr, \"Ironwall failed to write char in %s\\n\", context); abort(); } return iw_from_i64(0); }",
        "static inline iw_value_t iw_write_i5_ascii_to_stream(FILE *file, iw_value_t raw_value, const char *context) { if (fprintf(file, \"%d\", (int)(int32_t)iw_as_i64(raw_value)) < 0) { fprintf(stderr, \"Ironwall failed to write i5 in %s\\n\", context); abort(); } return iw_from_i64(0); }",
        "static inline iw_value_t iw_write_f5_ascii_to_stream(FILE *file, float value, const char *context) { if (fprintf(file, \"%.9g\", (double)value) < 0) { fprintf(stderr, \"Ironwall failed to write f5 in %s\\n\", context); abort(); } return iw_from_i64(0); }",
        "static inline iw_value_t iw_builtin_stdin_read_i5(void) { iw_io_init(); int value = 0; if (fscanf(stdin, \"%d\", &value) != 1) { fprintf(stderr, \"Ironwall failed to read i5 from stdin\\n\"); abort(); } return iw_from_i64((int64_t)(int32_t)value); }",
        "static inline iw_value_t iw_builtin_stdin_read_f5(void) { iw_io_init(); float value = 0.0f; if (fscanf(stdin, \"%f\", &value) != 1) { fprintf(stderr, \"Ironwall failed to read f5 from stdin\\n\"); abort(); } return iw_from_f32(value); }",
        "static inline iw_value_t iw_read_line_from_stream(FILE *file, const char *context) { size_t capacity = 64u; size_t length = 0u; char *buffer = (char*)malloc(capacity); if (buffer == NULL) { fprintf(stderr, \"Ironwall allocation failed in %s\\n\", context); abort(); } int ch = 0; while ((ch = fgetc(file)) != EOF) { if (length + 1u >= capacity) { size_t next_capacity = capacity * 2u; char *next = (char*)realloc(buffer, next_capacity); if (next == NULL) { free(buffer); fprintf(stderr, \"Ironwall allocation failed in %s\\n\", context); abort(); } buffer = next; capacity = next_capacity; } if (ch == '\\n') { break; } buffer[length] = (char)ch; length += 1u; } iw_value_t result = iw_text_copy_bytes(buffer, length, context); free(buffer); return result; }",
        "static inline iw_value_t iw_builtin_stdin_read_line_s3(void) { iw_io_init(); return iw_read_line_from_stream(stdin, \"stdin_read_line_s3\"); }",
        "static inline iw_value_t iw_builtin_stdout_write_text(iw_value_t raw_value) { iw_io_init(); return iw_write_text_to_stream(stdout, raw_value, \"stdout_write_s3\"); }",
        "static inline iw_value_t iw_builtin_stdout_println_text(iw_value_t raw_value) { iw_io_init(); return iw_write_line_text_to_stream(stdout, raw_value, \"stdout_println_s3\"); }",
        "static inline iw_value_t iw_builtin_stdout_write_char(iw_value_t raw_value) { iw_io_init(); return iw_write_char_to_stream(stdout, raw_value, \"stdout_write_c3\"); }",
        "static inline iw_value_t iw_builtin_stdout_write_i5_ascii(iw_value_t raw_value) { iw_io_init(); return iw_write_i5_ascii_to_stream(stdout, raw_value, \"stdout_write_i5_ascii\"); }",
        "static inline iw_value_t iw_builtin_stdout_write_f5_ascii(iw_value_t raw_value) { iw_io_init(); return iw_write_f5_ascii_to_stream(stdout, iw_as_f32(raw_value, \"stdout_write_f5_ascii\"), \"stdout_write_f5_ascii\"); }",
        "static inline iw_value_t iw_builtin_stderr_write_text(iw_value_t raw_value) { iw_io_init(); return iw_write_text_to_stream(stderr, raw_value, \"stderr_write_s3\"); }",
        "static inline iw_value_t iw_builtin_stderr_println_text(iw_value_t raw_value) { iw_io_init(); return iw_write_line_text_to_stream(stderr, raw_value, \"stderr_println_s3\"); }",
        "static inline iw_value_t iw_builtin_stderr_write_char(iw_value_t raw_value) { iw_io_init(); return iw_write_char_to_stream(stderr, raw_value, \"stderr_write_c3\"); }",
        "static inline iw_value_t iw_builtin_stderr_write_i5_ascii(iw_value_t raw_value) { iw_io_init(); return iw_write_i5_ascii_to_stream(stderr, raw_value, \"stderr_write_i5_ascii\"); }",
        "static inline iw_value_t iw_builtin_stderr_write_f5_ascii(iw_value_t raw_value) { iw_io_init(); return iw_write_f5_ascii_to_stream(stderr, iw_as_f32(raw_value, \"stderr_write_f5_ascii\"), \"stderr_write_f5_ascii\"); }",
        "static inline iw_value_t iw_builtin_stdout_flush(void) { iw_io_init(); if (fflush(stdout) != 0) { fprintf(stderr, \"Ironwall failed to flush stdout\\n\"); abort(); } return iw_from_i64(0); }",
        "static inline iw_value_t iw_builtin_stderr_flush(void) { iw_io_init(); if (fflush(stderr) != 0) { fprintf(stderr, \"Ironwall failed to flush stderr\\n\"); abort(); } return iw_from_i64(0); }",
        "static inline iw_value_t iw_builtin_read_file_s3(iw_value_t raw_path) { iw_text_value_t *path = iw_text_expect(raw_path, \"read_file_s3 path\"); FILE *file = fopen(path->data, \"rb\"); if (file == NULL) { fprintf(stderr, \"Ironwall failed to open file for read: %s\\n\", path->data); abort(); } size_t capacity = 256u; size_t length = 0u; char *buffer = (char*)malloc(capacity); if (buffer == NULL) { fclose(file); fprintf(stderr, \"Ironwall allocation failed in read_file_s3\\n\"); abort(); } int ch = 0; while ((ch = fgetc(file)) != EOF) { if (length + 1u >= capacity) { size_t next_capacity = capacity * 2u; char *next = (char*)realloc(buffer, next_capacity); if (next == NULL) { free(buffer); fclose(file); fprintf(stderr, \"Ironwall allocation failed in read_file_s3\\n\"); abort(); } buffer = next; capacity = next_capacity; } buffer[length] = (char)ch; length += 1u; } fclose(file); iw_value_t result = iw_text_copy_bytes(buffer, length, \"read_file_s3\"); free(buffer); return result; }",
        "static inline iw_value_t iw_builtin_write_file_s3(iw_value_t raw_path, iw_value_t raw_value) { iw_text_value_t *path = iw_text_expect(raw_path, \"write_file_s3 path\"); FILE *file = fopen(path->data, \"wb\"); if (file == NULL) { fprintf(stderr, \"Ironwall failed to open file for write: %s\\n\", path->data); abort(); } iw_write_text_to_stream(file, raw_value, \"write_file_s3\"); fclose(file); return iw_from_i64(0); }",
        "static inline iw_value_t iw_builtin_append_file_s3(iw_value_t raw_path, iw_value_t raw_value) { iw_text_value_t *path = iw_text_expect(raw_path, \"append_file_s3 path\"); FILE *file = fopen(path->data, \"ab\"); if (file == NULL) { fprintf(stderr, \"Ironwall failed to open file for append: %s\\n\", path->data); abort(); } iw_write_text_to_stream(file, raw_value, \"append_file_s3\"); fclose(file); return iw_from_i64(0); }",
        "static inline iw_value_t iw_builtin_file_open_write_s3(iw_value_t raw_path) { iw_text_value_t *path = iw_text_expect(raw_path, \"file_open_write_s3 path\"); return iw_file_register(fopen(path->data, \"wb\"), \"file_open_write_s3\"); }",
        "static inline iw_value_t iw_builtin_file_open_append_s3(iw_value_t raw_path) { iw_text_value_t *path = iw_text_expect(raw_path, \"file_open_append_s3 path\"); return iw_file_register(fopen(path->data, \"ab\"), \"file_open_append_s3\"); }",
        "static inline iw_value_t iw_builtin_file_close(iw_value_t raw_handle) { iw_io_init(); int64_t handle = iw_as_i64(raw_handle); if (handle < 3 || handle >= IW_IO_MAX_HANDLES || iw_io_handles[handle] == NULL) { fprintf(stderr, \"Ironwall invalid close handle: %lld\\n\", (long long)handle); abort(); } fclose(iw_io_handles[handle]); iw_io_handles[handle] = NULL; return iw_from_i64(0); }",
        "static inline iw_value_t iw_builtin_file_write_s3(iw_value_t raw_handle, iw_value_t raw_value) { return iw_write_text_to_stream(iw_file_from_handle(raw_handle, \"file_write_s3\"), raw_value, \"file_write_s3\"); }",
        "static inline iw_value_t iw_builtin_file_write_c3(iw_value_t raw_handle, iw_value_t raw_value) { return iw_write_char_to_stream(iw_file_from_handle(raw_handle, \"file_write_c3\"), raw_value, \"file_write_c3\"); }",
        "static inline iw_value_t iw_builtin_file_write_i5_ascii(iw_value_t raw_handle, iw_value_t raw_value) { return iw_write_i5_ascii_to_stream(iw_file_from_handle(raw_handle, \"file_write_i5_ascii\"), raw_value, \"file_write_i5_ascii\"); }",
        "static inline iw_value_t iw_builtin_file_write_f5_ascii(iw_value_t raw_handle, iw_value_t raw_value) { return iw_write_f5_ascii_to_stream(iw_file_from_handle(raw_handle, \"file_write_f5_ascii\"), iw_as_f32(raw_value, \"file_write_f5_ascii\"), \"file_write_f5_ascii\"); }",
        "static inline iw_value_t iw_closure_box(const iw_runtime_type_info_t *type_info, uintptr_t apply, iw_value_t env, uint32_t arity) { iw_gc_metadata_ref_t metadata_ref = iw_gc_metadata_ref_for_runtime_type(type_info->tag); iw_closure_value_t *closure = (iw_closure_value_t*)iw_gc_allocate(sizeof(iw_closure_value_t), type_info, metadata_ref, \"closure\"); closure->apply = apply; closure->env = env; closure->arity = arity; iw_gc_publish_allocation((iw_heap_header_t*)closure, sizeof(iw_closure_value_t), metadata_ref); return (iw_value_t)(intptr_t)closure; }",
        "static inline iw_closure_value_t* iw_closure_expect(iw_value_t raw_value, uint32_t expected_arity, const char *context) { iw_closure_value_t *closure = (iw_closure_value_t*)(intptr_t)iw_expect_heap_header(raw_value, context); if (closure->header.type_info->kind != IW_RUNTIME_KIND_CLOSURE) { fprintf(stderr, \"Ironwall C backend closure tag mismatch in %s\\n\", context); abort(); } if (closure->arity != expected_arity) { fprintf(stderr, \"Ironwall C backend closure arity mismatch in %s: expected %u, got %u\\n\", context, (unsigned)expected_arity, (unsigned)closure->arity); abort(); } return closure; }",
        "static inline const iw_runtime_type_info_t* iw_runtime_lookup_type(uint64_t runtime_tag, const iw_runtime_type_info_t *const *all_types, size_t type_count) { for (size_t index = 0; index < type_count; index += 1) { if (all_types[index]->tag == runtime_tag) { return all_types[index]; } } return NULL; }"
    ].join("\n");

    return {
        builtinEmitters,
        builtinHelpers,
        builtinRuntimeTypes,
        builtinSharedSyscallHelpers: loadWindowsCRuntimeTemplate("iw-syscall-windows.c"),
        builtinSharedThreadHelpers: loadWindowsCRuntimeTemplate("iw-thread-windows.c")
    };
}
