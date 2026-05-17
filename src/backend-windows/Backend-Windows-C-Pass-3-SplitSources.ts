export interface WindowsCBackendSourcePass3Result {
    readonly runtimeSource: string;
    readonly driverSource: string;
}

const DRIVER_MARKER = "\n/* IW_WINDOWS_C_BACKEND_DRIVER */\n";
const WINDOWS_C_DRIVER_PREAMBLE_LINES: readonly string[] = [
    "#include <stdint.h>",
    "#include <stdio.h>",
    '#include "ironwall.h"'
];

export function performWindowsCBackendSourcePass3SplitRuntimeAndDriverSource(
    runtimeAndDriverSource: string,
    driverResultType: string
): WindowsCBackendSourcePass3Result {
    const driverIndex = runtimeAndDriverSource.indexOf(DRIVER_MARKER);
    if (driverIndex < 0) {
        throw new Error("C backend internal error: missing driver marker");
    }

    return {
        runtimeSource: [
            runtimeAndDriverSource.slice(0, driverIndex),
            "",
            "void __iw_c_init_runtime(void) {",
            "    int iw_stack_anchor_local = 0;",
            "    uintptr_t iw_stack_anchor = (uintptr_t)&iw_stack_anchor_local;",
            "    iw_gc_init_runtime(iw_stack_anchor);",
            "}"
        ].join("\n"),
        driverSource: [
            ...WINDOWS_C_DRIVER_PREAMBLE_LINES,
            `extern ${driverResultType} __iw_host_entry_main(int argc, char **argv);`,
            "extern void __iw_c_init_runtime(void);",
            "",
            "int main(int argc, char **argv) {",
            "    __iw_c_init_runtime();",
            `    ${driverResultType} result = __iw_host_entry_main(argc, argv);`,
            "    return (int)iw_as_i64(result);",
            "}"
        ].join("\n")
    };
}