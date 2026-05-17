import { hashText } from "./Typecheck-Core";

const DECLARED_C_FUNCTION_LANGUAGE: string = "clang";
const DECLARED_C_FUNCTION_NAME_PATTERN: RegExp = /^_([A-Za-z0-9]+)_clang_([A-Za-z_][A-Za-z0-9_]*)_([0-9A-Fa-f]{8})$/;
const EXPORTED_IW_FUNCTION_LANGUAGE: string = "iwlang";
const EXPORTED_IW_FUNCTION_NAME_PATTERN: RegExp = /^_([A-Za-z0-9]+)_iwlang_([A-Za-z_][A-Za-z0-9_]*)_([0-9A-Fa-f]{8})$/;

export class DeclaredCFunctionName {
    public readonly fullName: string;
    public readonly uuid: string;
    public readonly language: string;
    public readonly functionName: string;
    public readonly confirmationTag: string;

    constructor(fullName: string, uuid: string, functionName: string, confirmationTag: string) {
        this.fullName = fullName;
        this.uuid = uuid;
        this.language = DECLARED_C_FUNCTION_LANGUAGE;
        this.functionName = functionName;
        this.confirmationTag = confirmationTag.toLowerCase();
    }
}

export class ExportedIwFunctionName {
    public readonly fullName: string;
    public readonly uuid: string;
    public readonly language: string;
    public readonly functionName: string;
    public readonly confirmationTag: string;

    constructor(fullName: string, uuid: string, functionName: string, confirmationTag: string) {
        this.fullName = fullName;
        this.uuid = uuid;
        this.language = EXPORTED_IW_FUNCTION_LANGUAGE;
        this.functionName = functionName;
        this.confirmationTag = confirmationTag.toLowerCase();
    }
}

function buildDeclaredCFunctionHashInput(uuid: string, functionName: string): string {
    return `${uuid}${DECLARED_C_FUNCTION_LANGUAGE}${functionName}`;
}

function buildExportedIwFunctionHashInput(uuid: string, functionName: string): string {
    return `${uuid}${EXPORTED_IW_FUNCTION_LANGUAGE}${functionName}`;
}

export function buildDeclaredCFunctionConfirmationTag(uuid: string, functionName: string): string {
    return hashText(buildDeclaredCFunctionHashInput(uuid, functionName)).slice(-8);
}

export function buildDeclaredCFunctionName(uuid: string, functionName: string): string {
    return `_${uuid}_${DECLARED_C_FUNCTION_LANGUAGE}_${functionName}_${buildDeclaredCFunctionConfirmationTag(uuid, functionName)}`;
}

export function buildExportedIwFunctionConfirmationTag(uuid: string, functionName: string): string {
    return hashText(buildExportedIwFunctionHashInput(uuid, functionName)).slice(-8);
}

export function buildExportedIwFunctionName(uuid: string, functionName: string): string {
    return `_${uuid}_${EXPORTED_IW_FUNCTION_LANGUAGE}_${functionName}_${buildExportedIwFunctionConfirmationTag(uuid, functionName)}`;
}

export function parseDeclaredCFunctionName(name: string): DeclaredCFunctionName | null {
    const match: RegExpMatchArray | null = name.match(DECLARED_C_FUNCTION_NAME_PATTERN);
    if (match === null) {
        return null;
    }

    const uuid: string = match[1];
    const functionName: string = match[2];
    const confirmationTag: string = match[3].toLowerCase();
    return new DeclaredCFunctionName(name, uuid, functionName, confirmationTag);
}

export function parseExportedIwFunctionName(name: string): ExportedIwFunctionName | null {
    const match: RegExpMatchArray | null = name.match(EXPORTED_IW_FUNCTION_NAME_PATTERN);
    if (match === null) {
        return null;
    }

    const uuid: string = match[1];
    const functionName: string = match[2];
    const confirmationTag: string = match[3].toLowerCase();
    return new ExportedIwFunctionName(name, uuid, functionName, confirmationTag);
}

export function resolveDeclaredCFunctionAlias(name: string): string {
    return parseDeclaredCFunctionName(name)?.functionName ?? name;
}

export function isGcCollectLikeSymbol(name: string): boolean {
    const resolvedName = resolveDeclaredCFunctionAlias(name);
    return resolvedName === "gc_collect"
        || resolvedName === "iw_gc_collect"
        || resolvedName.endsWith("@gc_collect")
        || resolvedName.endsWith("@iw_gc_collect");
}

export function lowerGcCollectLikeSymbolToBuiltin(name: string): string {
    return isGcCollectLikeSymbol(name) ? "iw_gc_collect" : name;
}

export function validateDeclaredCFunctionName(name: string): DeclaredCFunctionName {
    const parsed: DeclaredCFunctionName | null = parseDeclaredCFunctionName(name);
    if (parsed === null) {
        throw new Error(`declare function '${name}' must use the _<uuid>_clang_<function_name>_<tag1> naming scheme`);
    }

    const expectedTag: string = buildDeclaredCFunctionConfirmationTag(parsed.uuid, parsed.functionName);
    if (parsed.confirmationTag !== expectedTag) {
        throw new Error(`declare function '${name}' has invalid confirmation tag '${parsed.confirmationTag}'; expected '${expectedTag}' for uuid '${parsed.uuid}' and function '${parsed.functionName}'`);
    }

    return parsed;
}

export function validateExportedIwFunctionName(name: string): ExportedIwFunctionName {
    const parsed: ExportedIwFunctionName | null = parseExportedIwFunctionName(name);
    if (parsed === null) {
        throw new Error(`function '${name}' must use the _<uuid>_iwlang_<function_name>_<tag1> naming scheme`);
    }

    const expectedTag: string = buildExportedIwFunctionConfirmationTag(parsed.uuid, parsed.functionName);
    if (parsed.confirmationTag !== expectedTag) {
        throw new Error(`function '${name}' has invalid iwlang confirmation tag '${parsed.confirmationTag}'; expected '${expectedTag}' for uuid '${parsed.uuid}' and function '${parsed.functionName}'`);
    }

    return parsed;
}
