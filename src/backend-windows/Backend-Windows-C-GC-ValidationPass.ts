import { loadWindowsCRuntimeTemplate } from "./Backend-Windows-C-RuntimeTemplates";

export function emitWindowsCGcValidationPassRuntime(): string {
    return loadWindowsCRuntimeTemplate("iw-gc-validation-windows.c");
}