#!/usr/bin/env node

import { generateX64NativeSupportCFromFinalBackendIR } from "./backend-windows/Backend-Windows-C";
import { buildX64TextualAssembly } from "./backend-windows/Backend-Windows-x64-TextualAssembly";
import { performLoweringStageCFromArtifacts } from "./Lowering-Windows-Pass-10-PackageBackendIR";
import { runPlatformReleaseCli, runPlatformReleaseCliMain, type PlatformReleaseHooks } from "./main-release-platform";

const windowsReleaseHooks: PlatformReleaseHooks = {
    platformTarget: "windows-x64",
    performLoweringStageCFromArtifacts: (programAst, options) => performLoweringStageCFromArtifacts(programAst, options),
    generateX64NativeSupportCFromFinalBackendIR: (pass10Support, extraSupportSource, classLayouts, assemblyText, options) => generateX64NativeSupportCFromFinalBackendIR(pass10Support as Parameters<typeof generateX64NativeSupportCFromFinalBackendIR>[0], extraSupportSource, classLayouts as Parameters<typeof generateX64NativeSupportCFromFinalBackendIR>[2], assemblyText, options),
    buildX64TextualAssembly
};

if (require.main === module) {
    runPlatformReleaseCliMain(process.argv.slice(2), windowsReleaseHooks);
}

export function runCli(argv: readonly string[]): number {
    return runPlatformReleaseCli(argv, windowsReleaseHooks);
}