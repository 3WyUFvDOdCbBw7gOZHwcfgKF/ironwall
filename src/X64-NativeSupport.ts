import { hashText } from "./backend-linux/Backend-Linux-Typecheck-Core";

export function sanitizeX64NativeSymbolPart(name: string): string {
    const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

export function x64NativeGcFrameKey(rootNames: readonly string[]): string {
    const canonicalRootNames = [...rootNames].sort((left, right) => left.localeCompare(right));
    return `${canonicalRootNames.length}_${hashText(canonicalRootNames.join("|"))}`;
}

export function encodeX64NumericLiteralSymbolPart(text: string): string {
    return text
        .replace(/_/g, "__")
        .replace(/\./g, "_dot_")
        .replace(/-/g, "_neg_")
        .replace(/\+/g, "_plus_");
}

export function decodeX64NumericLiteralSymbolPart(text: string): string {
    return text
        .replace(/_plus_/g, "+")
        .replace(/_neg_/g, "-")
        .replace(/_dot_/g, ".")
        .replace(/__/g, "_");
}

export function x64NativeAllocSymbol(className: string): string {
    return `__iw_x64_alloc_${sanitizeX64NativeSymbolPart(className)}`;
}

export function x64NativeObjectGetFieldSymbol(className: string, fieldName: string): string {
    return `__iw_x64_object_get_${sanitizeX64NativeSymbolPart(className)}_${sanitizeX64NativeSymbolPart(fieldName)}`;
}

export function x64NativeObjectSetFieldSymbol(className: string, fieldName: string): string {
    return `__iw_x64_object_set_${sanitizeX64NativeSymbolPart(className)}_${sanitizeX64NativeSymbolPart(fieldName)}`;
}

export function x64NativeSlotLoadSymbol(className: string, slotName: string): string {
    return `__iw_x64_slot_load_${sanitizeX64NativeSymbolPart(className)}_${sanitizeX64NativeSymbolPart(slotName)}`;
}

export function x64NativeSlotStoreSymbol(className: string, slotName: string): string {
    return `__iw_x64_slot_store_${sanitizeX64NativeSymbolPart(className)}_${sanitizeX64NativeSymbolPart(slotName)}`;
}

export function x64NativeUnionInjectSymbol(unionTypeTagId: string, memberTypeTagId: string): string {
    return `__iw_x64_union_inject_${sanitizeX64NativeSymbolPart(unionTypeTagId)}_${sanitizeX64NativeSymbolPart(memberTypeTagId)}`;
}

export function x64NativeUnionHasTagSymbol(unionTypeTagId: string, memberTypeTagId: string): string {
    return `__iw_x64_union_has_tag_${sanitizeX64NativeSymbolPart(unionTypeTagId)}_${sanitizeX64NativeSymbolPart(memberTypeTagId)}`;
}

export function x64NativeUnionGetPayloadSymbol(unionTypeTagId: string, memberTypeTagId: string): string {
    return `__iw_x64_union_get_payload_${sanitizeX64NativeSymbolPart(unionTypeTagId)}_${sanitizeX64NativeSymbolPart(memberTypeTagId)}`;
}

export function x64NativeTextValueSymbol(referenceName: string): string {
    return `iw_text_value_${sanitizeX64NativeSymbolPart(referenceName)}`;
}

export function x64NativeDirectCallWrapperSymbol(symbol: string): string {
    return `__iw_x64_call_${sanitizeX64NativeSymbolPart(symbol)}`;
}

export function x64NativeDirectFunctionValueSymbol(symbol: string): string {
    return `__iw_x64_direct_value_${sanitizeX64NativeSymbolPart(symbol)}`;
}

export function x64NativeBoxedNumberValueSymbol(typeName: string, value: number): string {
    return `__iw_x64_direct_value_num_${sanitizeX64NativeSymbolPart(typeName)}_${encodeX64NumericLiteralSymbolPart(String(value))}`;
}

export function x64NativeClosureCreateSymbol(closureId: string): string {
    return `__iw_x64_make_${sanitizeX64NativeSymbolPart(closureId)}`;
}

export function x64NativeClosureCallSymbol(arity: number): string {
    return `__iw_x64_closure_call_${arity}`;
}

export function x64NativeGcFrameInitSymbol(frameKey: string): string {
    return `__iw_x64_gc_frame_init_${sanitizeX64NativeSymbolPart(frameKey)}`;
}
