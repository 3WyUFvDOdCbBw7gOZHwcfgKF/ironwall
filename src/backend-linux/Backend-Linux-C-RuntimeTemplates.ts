// Shared helpers for Linux C runtime templates.

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

export interface LinuxCRuntimeTemplateReplacements {
    readonly [name: string]: string;
}

const RUNTIME_TEMPLATE_TOKEN_PATTERN: RegExp = /__IW_TEMPLATE_[A-Z0-9_]+__/;

function resolveLinuxCRuntimeTemplatePath(fileName: string): string {
    const candidatePaths: readonly string[] = [
        resolve(dirname(process.execPath), "runtime", fileName),
        resolve(__dirname, "..", "..", "src", "backend-linux", "runtime", fileName),
        resolve(__dirname, "..", "src", "backend-linux", "runtime", fileName),
        resolve(__dirname, "..", "..", "src", "backend", "runtime", fileName),
        resolve(__dirname, "..", "src", "backend", "runtime", fileName),
        resolve(process.cwd(), "runtime", fileName),
        resolve(process.cwd(), "src", "backend-linux", "runtime", fileName),
        resolve(process.cwd(), "src", "backend", "runtime", fileName)
    ];
    for (const candidatePath of candidatePaths) {
        if (existsSync(candidatePath)) {
            return candidatePath;
        }
    }
    throw new Error(`Unable to locate Linux C runtime template '${fileName}'`);
}

function runtimeTemplateToken(replacementName: string): string {
    return `__IW_TEMPLATE_${replacementName}__`;
}

export function loadLinuxCRuntimeTemplate(fileName: string): string {
    const runtimePath: string = resolveLinuxCRuntimeTemplatePath(fileName);
    return readFileSync(runtimePath, "utf8").trim();
}

export function renderLinuxCRuntimeTemplate(
    fileName: string,
    replacements: LinuxCRuntimeTemplateReplacements = {}
): string {
    const templateSource: string = loadLinuxCRuntimeTemplate(fileName);
    return renderLinuxCRuntimeTemplateSource(templateSource, replacements);
}

export function renderLinuxCRuntimeTemplateSource(
    templateSource: string,
    replacements: LinuxCRuntimeTemplateReplacements
): string {
    let renderedSource: string = templateSource.trim();
    const replacementNames: readonly string[] = Object.keys(replacements);
    for (const replacementName of replacementNames) {
        const replacementValue: string = replacements[replacementName];
        renderedSource = renderedSource.split(runtimeTemplateToken(replacementName)).join(replacementValue);
    }
    const unresolvedTokenMatch: RegExpMatchArray | null = renderedSource.match(RUNTIME_TEMPLATE_TOKEN_PATTERN);
    if (unresolvedTokenMatch !== null) {
        throw new Error(`Unresolved Linux C runtime template token '${unresolvedTokenMatch[0]}'`);
    }
    return renderedSource;
}