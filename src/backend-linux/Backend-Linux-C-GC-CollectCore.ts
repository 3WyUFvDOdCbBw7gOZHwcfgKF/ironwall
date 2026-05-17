import type { LinuxCGcCollectCoreOptions } from "./Backend-Linux-C-GC-Shared";
import {
    type LinuxCRuntimeTemplateReplacements,
    renderLinuxCRuntimeTemplate
} from "./Backend-Linux-C-RuntimeTemplates";

export function emitLinuxCGcCollectCoreRuntime(options: LinuxCGcCollectCoreOptions): string {
    const linkedRuntimeInitSymbols: readonly string[] = options.linkedRuntimeInitSymbols ?? [];
    const linkedRuntimeInitDeclarations: readonly string[] = linkedRuntimeInitSymbols.map((symbol: string): string => `extern void ${symbol}(void);`);
    const linkedRuntimeInitCalls: readonly string[] = linkedRuntimeInitSymbols.map((symbol: string): string => `    ${symbol}();`);
    const exportedRuntimeInitLines: readonly string[] = options.exportedRuntimeInitSymbol === undefined
        ? []
        : [
            `void ${options.exportedRuntimeInitSymbol}(void) {`,
            "    pthread_once(&iw_gc_runtime_once, iw_gc_runtime_global_init_once);",
            ...(options.exportedRuntimeInitCallLine === undefined ? [] : [options.exportedRuntimeInitCallLine]),
            "}"
        ];
    const replacements: LinuxCRuntimeTemplateReplacements = {
        GC_LINKED_RUNTIME_INIT_DECLARATIONS: linkedRuntimeInitDeclarations.join("\n"),
        GC_GLOBAL_INIT_LINES: options.globalInitLines.join("\n"),
        GC_LINKED_RUNTIME_INIT_CALLS: linkedRuntimeInitCalls.join("\n"),
        GC_EXPORTED_RUNTIME_INIT_LINES: exportedRuntimeInitLines.join("\n")
    };

    return renderLinuxCRuntimeTemplate("iw-gc-collect-core-linux.c", replacements);
}