export interface LinuxCBackendSourcePass3Result {
    readonly runtimeSource: string;
    readonly driverSource: string;
}

const DRIVER_MARKER = "\nstatic void iw_raise_stack_limit(void) {";

export function performLinuxCBackendSourcePass3SplitRuntimeAndDriverSource(
    runtimeAndDriverSource: string,
    driverResultType: string
): LinuxCBackendSourcePass3Result {
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
            "#define _GNU_SOURCE",
            "#define _POSIX_C_SOURCE 200809L",
            "#include <stdint.h>",
            "#include <stdio.h>",
            "#include <sys/resource.h>",
            '#include "ironwall.h"',
            `extern ${driverResultType} __iw_host_entry_main(int argc, char **argv);`,
            "extern void __iw_c_init_runtime(void);",
            "",
            "static void iw_raise_stack_limit(void) {",
            "    struct rlimit limit;",
            "    if (getrlimit(RLIMIT_STACK, &limit) != 0) {",
            "        return;",
            "    }",
            "    if (limit.rlim_cur == limit.rlim_max) {",
            "        return;",
            "    }",
            "    limit.rlim_cur = limit.rlim_max;",
            "    (void)setrlimit(RLIMIT_STACK, &limit);",
            "}",
            "",
            "int main(int argc, char **argv) {",
            "    iw_raise_stack_limit();",
            "    __iw_c_init_runtime();",
            `    ${driverResultType} result = __iw_host_entry_main(argc, argv);`,
            "    return (int)iw_as_i64(result);",
            "}"
        ].join("\n")
    };
}