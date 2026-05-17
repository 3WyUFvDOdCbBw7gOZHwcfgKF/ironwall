import type {
    WindowsCGcGlobalDescriptorArtifact,
    WindowsCGcMetadataArtifact,
    WindowsCGcPrintPassCodegen,
    WindowsCGcPrintPassDependencies
} from "./Backend-Windows-C-GC-Shared";
import {
    type WindowsCRuntimeTemplateReplacements,
    renderWindowsCRuntimeTemplate
} from "./Backend-Windows-C-RuntimeTemplates";

function emitWindowsCGcClassContentPrinter(codegen: WindowsCGcPrintPassCodegen, deps: WindowsCGcPrintPassDependencies): string {
    const layouts = Array.from(codegen.layouts.values()).sort((left, right) => left.className.localeCompare(right.className));
    const lines: string[] = [
        "static inline int iw_gc_print_compiled_class_fields(const iw_heap_header_t *header) {"
    ];
    for (const layout of layouts) {
        lines.push(`    if (header->tag == ${deps.runtimeTypeTagLiteral(layout.runtimeTypeTagId)}) {`);
        lines.push(`        const ${deps.cStructName(layout.className)} *object = (const ${deps.cStructName(layout.className)}*)header;`);
        lines.push("        printf(\" fields={\");");
        if (layout.propertyOrder.length === 0) {
            lines.push("        printf(\"<none>\");");
        } else {
            layout.propertyOrder.forEach((fieldName, index) => {
                if (index > 0) {
                    lines.push("        printf(\", \");");
                }
                lines.push(`        printf(${deps.cStringLiteral(`${fieldName}=`)});`);
                lines.push(`        iw_gc_print_value_summary(object->${deps.cFieldName(fieldName)});`);
            });
        }
        lines.push("        printf(\"}\");");
        lines.push("        return 1;");
        lines.push("    }");
    }
    lines.push("    return 0;");
    lines.push("}");
    return lines.join("\n");
}

function emitWindowsCGcFrameContentPrinter(codegen: WindowsCGcPrintPassCodegen, deps: WindowsCGcPrintPassDependencies): string {
    const descriptors = Array.from(codegen.gcFrameDescriptors.values()).sort((left, right) => left.key.localeCompare(right.key));
    const lines: string[] = [
        "static inline int iw_gc_print_compiled_frame_fields(const char *metadata_name, const void *frame_base) {"
    ];
    for (const descriptor of descriptors) {
        const metadata = codegen.gcMetadataByCanonicalName.get(descriptor.metadataCanonicalName);
        if (!metadata) {
            throw new Error(`C backend encountered missing GC metadata for frame '${descriptor.metadataCanonicalName}'`);
        }
        lines.push(`    if (strcmp(metadata_name, ${deps.cStringLiteral(metadata.displayName)}) == 0) {`);
        lines.push(`        const ${descriptor.structName} *frame = (const ${descriptor.structName}*)frame_base;`);
        lines.push("        printf(\" roots={\");");
        if (descriptor.rootNames.length === 0) {
            lines.push("        printf(\"<none>\");");
        } else {
            descriptor.rootNames.forEach((rootName, index) => {
                if (index > 0) {
                    lines.push("        printf(\", \" );");
                }
                lines.push(`        printf(${deps.cStringLiteral(`${rootName}=`)});`);
                lines.push(`        iw_gc_print_value_summary(frame->${deps.cFieldName(rootName)});`);
            });
        }
        lines.push("        printf(\"}\");");
        lines.push("        return 1;");
        lines.push("    }");
    }
    lines.push("    return 0;");
    lines.push("}");
    lines.push("");
    lines.push("static inline void iw_gc_print_live_frame(const iw_gc_metadata_entry_t *metadata, const void *frame_base) {");
    lines.push("    printf(\"gc-live-frame %s addr=%p\", metadata->name, frame_base);");
    lines.push("    if (!iw_gc_print_compiled_frame_fields(metadata->name, frame_base)) {");
    lines.push("        printf(\" roots={<unknown>}\");");
    lines.push("    }");
    lines.push("    printf(\"\\n\");");
    lines.push("}");
    return lines.join("\n");
}

export function emitWindowsCGcGlobalContentPrinter(
    globalDescriptor: WindowsCGcGlobalDescriptorArtifact,
    globalMetadata: WindowsCGcMetadataArtifact,
    deps: WindowsCGcPrintPassDependencies
): string {
    const lines: string[] = [
        `static inline void ${globalDescriptor.livePrinterSymbolName}(void) {`,
        `    printf(\"gc-live-global %s addr=%p fields={\", ${deps.cStringLiteral(globalMetadata.displayName)}, (const void*)&${globalDescriptor.blockSymbolName});`
    ];
    if (globalDescriptor.fieldOrder.length === 0) {
        lines.push("    printf(\"<none>\");");
    } else {
        globalDescriptor.fieldOrder.forEach((fieldName, index) => {
            if (index > 0) {
                lines.push("    printf(\", \" );");
            }
            lines.push(`    printf(${deps.cStringLiteral(`${fieldName}=`)});`);
            lines.push(`    iw_gc_print_value_summary(${deps.cGlobalName(fieldName)});`);
        });
    }
    lines.push("    printf(\"}\\n\");");
    lines.push("}");
    return lines.join("\n");
}

export function emitWindowsCGcPrintPassRuntime(codegen: WindowsCGcPrintPassCodegen, deps: WindowsCGcPrintPassDependencies): string {
    const classContentPrinter: string = emitWindowsCGcClassContentPrinter(codegen, deps);
    const frameContentPrinter: string = emitWindowsCGcFrameContentPrinter(codegen, deps);
    const maxVerboseHeapEntries: number = 32;
    const replacements: WindowsCRuntimeTemplateReplacements = {
        GC_MAX_VERBOSE_HEAP_ENTRIES: String(maxVerboseHeapEntries),
        GC_CLASS_CONTENT_PRINTER: classContentPrinter,
        GC_FRAME_CONTENT_PRINTER: frameContentPrinter
    };

    return renderWindowsCRuntimeTemplate("iw-gc-print-windows.c", replacements);
}