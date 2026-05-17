import { loadLinuxCRuntimeTemplate } from "./Backend-Linux-C-RuntimeTemplates";

export function emitLinuxCGcValidationPassRuntime(): string {
    return loadLinuxCRuntimeTemplate("iw-gc-validation-linux.c");
}