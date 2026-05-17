import type { AstNode } from "./AstNode";
import type { AbstractToken } from "./lexer";

export interface SourceDocument {
    readonly text: string;
    readonly filePath?: string;
}

export interface SourceRange {
    readonly startOffset: number;
    readonly endOffset: number;
}

export interface DiagnosticLocation {
    readonly filePath?: string;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly line: number;
    readonly column: number;
    readonly endLine: number;
    readonly endColumn: number;
    readonly lineText: string;
    readonly excerpt: string;
    readonly caretLine: string;
    readonly contextStartLine: number;
    readonly contextEndLine: number;
    readonly contextLines: readonly DiagnosticContextLine[];
}

export interface DiagnosticContextLine {
    readonly line: number;
    readonly text: string;
    readonly isPrimary: boolean;
    readonly caretLine?: string;
}

export interface IronwallDiagnostic {
    readonly format: "ironwall.error/v1";
    readonly severity: "error";
    readonly stage: string;
    readonly code: string;
    readonly message: string;
    readonly location?: DiagnosticLocation;
    readonly details?: Readonly<Record<string, unknown>>;
}

interface SourceMetadata {
    readonly document: SourceDocument;
    readonly range: SourceRange;
}

interface DiagnosticSourceOptions {
    readonly ast?: AstNode;
    readonly token?: AbstractToken;
    readonly document?: SourceDocument;
    readonly range?: SourceRange;
}

interface CreateDiagnosticOptions extends DiagnosticSourceOptions {
    readonly details?: Readonly<Record<string, unknown>>;
}

const tokenSourceMetadata: WeakMap<object, SourceMetadata> = new WeakMap();
const astSourceMetadata: WeakMap<object, SourceMetadata> = new WeakMap();
const lineStartCache: WeakMap<SourceDocument, readonly number[]> = new WeakMap();
const DIAGNOSTIC_CONTEXT_LINE_RADIUS = 1;

const activeParserNodeStack: AstNode[] = [];
const activeTypecheckNodeStack: AstNode[] = [];
const activeConcreteTypecheckNodeStack: AstNode[] = [];

export class IronwallDiagnosticError extends Error {
    readonly diagnostic: IronwallDiagnostic;

    constructor(diagnostic: IronwallDiagnostic) {
        super(diagnostic.message);
        this.name = "IronwallDiagnosticError";
        this.diagnostic = diagnostic;
    }
}

export function createSourceDocument(text: string, filePath?: string): SourceDocument {
    return { text, filePath };
}

export function annotateTokenSource(token: AbstractToken, document: SourceDocument, range: SourceRange): void {
    tokenSourceMetadata.set(token as object, { document, range });
}

export function getTokenSource(token: AbstractToken): SourceMetadata | undefined {
    return tokenSourceMetadata.get(token as object);
}

export function annotateAstSource(node: AstNode, document: SourceDocument, range: SourceRange): AstNode {
    astSourceMetadata.set(node as object, { document, range });
    return node;
}

export function inheritAstSource(target: AstNode, source: AstNode): AstNode {
    const metadata = getAstSource(source);
    if (metadata !== undefined) {
        annotateAstSource(target, metadata.document, metadata.range);
    }
    return target;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isAstNodeLike(value: unknown): value is AstNode {
    return isObjectRecord(value) && "kind" in value;
}

function copyAstSourceValue(sourceValue: unknown, targetValue: unknown, visited: WeakSet<object>): void {
    if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
        const length = Math.min(sourceValue.length, targetValue.length);
        for (let index = 0; index < length; index += 1) {
            copyAstSourceValue(sourceValue[index], targetValue[index], visited);
        }
        return;
    }

    if (isAstNodeLike(sourceValue) && isAstNodeLike(targetValue)) {
        copyAstSourceTree(sourceValue, targetValue, visited);
        return;
    }

    if (!isObjectRecord(sourceValue) || !isObjectRecord(targetValue)) {
        return;
    }

    if (visited.has(targetValue)) {
        return;
    }
    visited.add(targetValue);

    for (const [key, nestedSourceValue] of Object.entries(sourceValue)) {
        if (!(key in targetValue)) {
            continue;
        }
        copyAstSourceValue(nestedSourceValue, targetValue[key], visited);
    }
}

export function copyAstSourceTree(source: AstNode, target: AstNode, visited: WeakSet<object> = new WeakSet()): void {
    if (visited.has(target as object)) {
        return;
    }
    visited.add(target as object);

    inheritAstSource(target, source);
    for (const [key, sourceValue] of Object.entries(source as unknown as Record<string, unknown>)) {
        copyAstSourceValue(sourceValue, (target as unknown as Record<string, unknown>)[key], visited);
    }
}

export function getAstSource(node: AstNode): SourceMetadata | undefined {
    return astSourceMetadata.get(node as object);
}

function buildLineStarts(document: SourceDocument): readonly number[] {
    const cached = lineStartCache.get(document);
    if (cached !== undefined) {
        return cached;
    }

    const starts: number[] = [0];
    for (let index = 0; index < document.text.length; index += 1) {
        if (document.text[index] === "\n") {
            starts.push(index + 1);
        }
    }
    lineStartCache.set(document, starts);
    return starts;
}

function clampOffset(text: string, offset: number): number {
    return Math.max(0, Math.min(offset, text.length));
}

function findLineIndex(lineStarts: readonly number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const start = lineStarts[mid];
        const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.POSITIVE_INFINITY;
        if (offset < start) {
            high = mid - 1;
            continue;
        }
        if (offset >= nextStart) {
            low = mid + 1;
            continue;
        }
        return mid;
    }

    return Math.max(0, Math.min(lineStarts.length - 1, low));
}

function readLineText(document: SourceDocument, lineStart: number): string {
    let lineEnd = document.text.indexOf("\n", lineStart);
    if (lineEnd < 0) {
        lineEnd = document.text.length;
    }
    return document.text.slice(lineStart, lineEnd);
}

function buildCaretLine(lineText: string, column: number, endColumn: number): string {
    const safeColumn = Math.max(1, column);
    const safeEndColumn = Math.max(safeColumn, endColumn);
    const prefixWidth = safeColumn - 1;
    const caretWidth = Math.max(1, safeEndColumn - safeColumn);
    const prefix = " ".repeat(Math.min(prefixWidth, lineText.length));
    return `${prefix}${"^".repeat(caretWidth)}`;
}

function buildContextCaretLine(document: SourceDocument, lineStarts: readonly number[], lineIndex: number, startOffset: number, endOffset: number): string | undefined {
    const lineStart = lineStarts[lineIndex];
    const lineText = readLineText(document, lineStart);
    const lineEnd = lineStart + lineText.length;
    const highlightStartOffset = Math.max(lineStart, Math.min(startOffset, lineEnd));
    const highlightEndOffset = Math.min(lineEnd, Math.max(highlightStartOffset + 1, endOffset));
    if (highlightStartOffset > lineEnd || highlightEndOffset <= lineStart) {
        return undefined;
    }
    return buildCaretLine(
        lineText,
        highlightStartOffset - lineStart + 1,
        highlightEndOffset - lineStart + 1,
    );
}

function buildDiagnosticContextLines(
    document: SourceDocument,
    lineStarts: readonly number[],
    startLineIndex: number,
    endLineIndex: number,
    startOffset: number,
    endOffset: number,
): readonly DiagnosticContextLine[] {
    const contextStartLineIndex = Math.max(0, startLineIndex - DIAGNOSTIC_CONTEXT_LINE_RADIUS);
    const contextEndLineIndex = Math.min(lineStarts.length - 1, endLineIndex + DIAGNOSTIC_CONTEXT_LINE_RADIUS);
    const contextLines: DiagnosticContextLine[] = [];

    for (let lineIndex = contextStartLineIndex; lineIndex <= contextEndLineIndex; lineIndex += 1) {
        const isPrimary = lineIndex >= startLineIndex && lineIndex <= endLineIndex;
        contextLines.push({
            line: lineIndex + 1,
            text: readLineText(document, lineStarts[lineIndex]),
            isPrimary,
            caretLine: isPrimary
                ? buildContextCaretLine(document, lineStarts, lineIndex, startOffset, endOffset)
                : undefined,
        });
    }

    return contextLines;
}

export function buildDiagnosticLocation(document: SourceDocument, range: SourceRange): DiagnosticLocation {
    const lineStarts = buildLineStarts(document);
    const startOffset = clampOffset(document.text, range.startOffset);
    const rawEndOffset = clampOffset(document.text, Math.max(range.startOffset, range.endOffset));
    const endOffset = rawEndOffset > startOffset ? rawEndOffset : startOffset + 1;
    const startLineIndex = findLineIndex(lineStarts, startOffset);
    const endAnchorOffset = Math.max(startOffset, endOffset - 1);
    const endLineIndex = findLineIndex(lineStarts, endAnchorOffset);
    const startLineStart = lineStarts[startLineIndex];
    const endLineStart = lineStarts[endLineIndex];
    const lineText = readLineText(document, startLineStart);
    const contextLines = buildDiagnosticContextLines(document, lineStarts, startLineIndex, endLineIndex, startOffset, endOffset);

    return {
        filePath: document.filePath,
        startOffset,
        endOffset,
        line: startLineIndex + 1,
        column: startOffset - startLineStart + 1,
        endLine: endLineIndex + 1,
        endColumn: endOffset - endLineStart + 1,
        lineText,
        excerpt: document.text.slice(startOffset, Math.min(endOffset, document.text.length)),
        caretLine: buildCaretLine(lineText, startOffset - startLineStart + 1, endOffset - startLineStart + 1),
        contextStartLine: contextLines[0]?.line ?? startLineIndex + 1,
        contextEndLine: contextLines[contextLines.length - 1]?.line ?? endLineIndex + 1,
        contextLines,
    };
}

function resolveSourceMetadata(options: DiagnosticSourceOptions): SourceMetadata | undefined {
    if (options.range !== undefined && options.document !== undefined) {
        return {
            document: options.document,
            range: options.range,
        };
    }
    if (options.ast !== undefined) {
        const astMetadata = getAstSource(options.ast);
        if (astMetadata !== undefined) {
            return astMetadata;
        }
    }
    if (options.token !== undefined) {
        const tokenMetadata = getTokenSource(options.token);
        if (tokenMetadata !== undefined) {
            return tokenMetadata;
        }
    }
    return undefined;
}

export function createDiagnostic(stage: string, code: string, message: string, options: CreateDiagnosticOptions = {}): IronwallDiagnostic {
    const metadata = resolveSourceMetadata(options);
    return {
        format: "ironwall.error/v1",
        severity: "error",
        stage,
        code,
        message,
        location: metadata === undefined ? undefined : buildDiagnosticLocation(metadata.document, metadata.range),
        details: options.details,
    };
}

export function diagnosticError(stage: string, code: string, message: string, options: CreateDiagnosticOptions = {}): IronwallDiagnosticError {
    return new IronwallDiagnosticError(createDiagnostic(stage, code, message, options));
}

export function extractErrorMessage(error: unknown): string {
    if (error instanceof IronwallDiagnosticError) {
        return error.diagnostic.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function wrapErrorAsDiagnostic(error: unknown, stage: string, code: string, options: CreateDiagnosticOptions = {}): IronwallDiagnosticError {
    if (error instanceof IronwallDiagnosticError) {
        return error;
    }
    return diagnosticError(stage, code, extractErrorMessage(error), options);
}

export function formatErrorAsJson(error: unknown, fallbackStage = "internal", fallbackCode = "INTERNAL_ERROR"): string {
    const diagnostic = error instanceof IronwallDiagnosticError
        ? error.diagnostic
        : createDiagnostic(fallbackStage, fallbackCode, extractErrorMessage(error));
    return JSON.stringify(diagnostic, null, 2);
}

export function withActiveParserNode<T>(node: AstNode, fn: () => T): T {
    activeParserNodeStack.push(node);
    try {
        return fn();
    } finally {
        activeParserNodeStack.pop();
    }
}

export function getActiveParserNode(): AstNode | undefined {
    return activeParserNodeStack.length === 0 ? undefined : activeParserNodeStack[activeParserNodeStack.length - 1];
}

export function withActiveTypecheckNode<T>(node: AstNode, fn: () => T): T {
    activeTypecheckNodeStack.push(node);
    try {
        return fn();
    } finally {
        activeTypecheckNodeStack.pop();
    }
}

export function getActiveTypecheckNode(): AstNode | undefined {
    return activeTypecheckNodeStack.length === 0 ? undefined : activeTypecheckNodeStack[activeTypecheckNodeStack.length - 1];
}

export function withActiveConcreteTypecheckNode<T>(node: AstNode, fn: () => T): T {
    activeConcreteTypecheckNodeStack.push(node);
    try {
        return fn();
    } finally {
        activeConcreteTypecheckNodeStack.pop();
    }
}

export function getActiveConcreteTypecheckNode(): AstNode | undefined {
    return activeConcreteTypecheckNodeStack.length === 0 ? undefined : activeConcreteTypecheckNodeStack[activeConcreteTypecheckNodeStack.length - 1];
}