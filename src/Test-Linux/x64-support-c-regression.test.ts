import { execFileSync } from "child_process";
import { ok, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { performNoOptimizeLoweringStageCFromArtifacts, performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { performLoweringStageCFromArtifacts, performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts } from "../Lowering-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { generateX64NativeSupportCFromFinalBackendIR } from "../backend-linux/Backend-Linux-C";
import type { FinalBackendIRProgram, X64LaidOutProgram, X64TextualAssemblyProgram } from "../backend-linux/Backend-Linux-IR-Shared";

interface X64Case {
    readonly label: string;
    readonly frontendProfile: "optimized" | "no-optimized";
    readonly backendProfile: "optimized-x64-backend" | "no-optimized-backend";
}

interface X64StageCResult {
    readonly pass10Support: FinalBackendIRProgram;
    readonly pass18x64layout: X64LaidOutProgram;
    readonly pass22x64emit: X64TextualAssemblyProgram;
}

const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test-Linux", "Fixtures", "x64-support-c");
const entryUnitId = "test~x64~support_c@main";

const X64_NATIVE_DRIVER_SOURCE = `#include <stdint.h>
#include <stdio.h>
typedef intptr_t iw_value_t;
extern void __iw_x64_init_runtime(void);
extern iw_value_t __iw_host_entry_main(int argc, char **argv);
static inline long long iw_as_i64(iw_value_t value) { return ((long long)value) >> 1; }
int main(int argc, char **argv) {
    __iw_x64_init_runtime();
    iw_value_t result = __iw_host_entry_main(argc, argv);
    printf("%lld\\n", iw_as_i64(result));
    return 0;
}
`;

const x64Cases: readonly X64Case[] = [
    {
        label: "optimized-frontend optimized-backend",
        frontendProfile: "optimized",
        backendProfile: "optimized-x64-backend"
    },
    {
        label: "optimized-frontend no-optimized-backend",
        frontendProfile: "optimized",
        backendProfile: "no-optimized-backend"
    },
    {
        label: "no-optimized-frontend optimized-backend",
        frontendProfile: "no-optimized",
        backendProfile: "optimized-x64-backend"
    },
    {
        label: "no-optimized-frontend no-optimized-backend",
        frontendProfile: "no-optimized",
        backendProfile: "no-optimized-backend"
    }
];

function buildStageC(testCase: X64Case): X64StageCResult {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots()
    });
    performTypeChecking(ast, {
        disableBaseLibAutoLoad: false
    });

    const loweringOptions = {
        disableBaseLibAutoLoad: false,
        entryUnitId,
        requireEntryPoint: true
    };

    if (testCase.frontendProfile === "optimized") {
        return testCase.backendProfile === "no-optimized-backend"
            ? performOptimizedFrontendNoOptimizedBackendLoweringStageCFromArtifacts(ast, loweringOptions)
            : performLoweringStageCFromArtifacts(ast, loweringOptions);
    }

    return testCase.backendProfile === "no-optimized-backend"
        ? performNoOptimizeNoOptimizedBackendLoweringStageCFromArtifacts(ast, loweringOptions)
        : performNoOptimizeLoweringStageCFromArtifacts(ast, loweringOptions);
}

function assertLinksAndRuns(supportC: string, assemblyText: string, expectedStdout: string): void {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-x64-support-link-"));
    try {
        const supportPath = join(tempDir, "program.support.c");
        const driverPath = join(tempDir, "program.driver.c");
        const asmPath = join(tempDir, "program.s");
        const binaryPath = join(tempDir, "program.out");

        writeFileSync(supportPath, supportC, "utf8");
        writeFileSync(driverPath, X64_NATIVE_DRIVER_SOURCE, "utf8");
        writeFileSync(asmPath, assemblyText, "utf8");

        execFileSync("cc", ["-O0", "-std=c11", "-pthread", "-no-pie", supportPath, driverPath, asmPath, "-lm", "-o", binaryPath], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });

        const output = execFileSync(binaryPath, {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15000
        });
        strictEqual(output.trim(), expectedStdout, `x64 support binary stdout mismatch\n${output}`);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

for (const testCase of x64Cases) {
    const stageC = buildStageC(testCase);
    const asm = stageC.pass22x64emit.text;
    ok(asm.endsWith("\n"), `${testCase.label} assembly should end with a trailing newline`);
    ok(
        asm.includes('.section .note.GNU-stack,"",@progbits'),
        `${testCase.label} assembly should declare a non-executable GNU stack section`
    );

    ok(
        asm.includes("__iw_x64_closure_call_2"),
        `${testCase.label} should reference __iw_x64_closure_call_2, got:\n${asm}`
    );
    ok(
        asm.includes("__iw_x64_direct_value_num_f6_"),
        `${testCase.label} should reference an f6 direct-value support symbol, got:\n${asm}`
    );
    ok(
        asm.includes("__iw_x64_direct_value_num_f7_"),
        `${testCase.label} should reference an f7 direct-value support symbol, got:\n${asm}`
    );

    const supportC = generateX64NativeSupportCFromFinalBackendIR(
        stageC.pass10Support,
        "",
        stageC.pass18x64layout.layouts.classes,
        asm
    );

    ok(
        supportC.includes("__iw_x64_closure_call_2") && supportC.includes("__iw_x64_direct_value_num_f6_") && supportC.includes("__iw_x64_direct_value_num_f7_"),
        `${testCase.label} support C should materialize the required x64 helper symbols`
    );

    assertLinksAndRuns(supportC, asm, "1");
    process.stdout.write(`x64-support-c ${testCase.label} ok\n`);
}