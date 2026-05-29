import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, extname, join, relative, resolve } from "path";
import { ProgramNode } from "./AstNode";
import { restoreTokensFromJsonText } from "./FrontendJson";
import { annotateCompilationUnitExpressions, parseCompilationUnitId } from "./ModuleMetadata";
import { parse } from "./parser";
import { tokenize } from "./lexer";
import {
    annotateProgramPackageStringDatabase,
    buildProgramPackageStringDatabase,
    isPackageStringDatabaseStem,
    loadPackageStringDatabaseFile,
} from "./StringDatabase";

export interface LoadedCompilationUnit {
    readonly filePath: string;
    readonly stem: string;
    readonly ast: ProgramNode;
}

export interface LoadProgramAstOptions {
    readonly additionalInputPaths?: readonly string[];
}

export interface LoadedProgramAstBundle {
    readonly ast: ProgramNode;
    readonly sourceFiles: readonly string[];
    readonly packageDbFiles: readonly string[];
}

const MODULE_UNIT_ID_PATTERN: RegExp = /^[a-zA-Z][a-zA-Z0-9_]*(?:~[a-zA-Z][a-zA-Z0-9_]*)*@([a-zA-Z][a-zA-Z0-9_]*)$/;
const EXTERNAL_FRONTEND_JSON_COMMAND_ENV_NAME: string = "IW_EXTERNAL_FRONTEND_JSON_COMMAND";

export function readSourceFile(inputPath: string): string {
    return readFileSync(resolve(inputPath), "utf8");
}

export interface ParseProgramSourceOptions {
    readonly filePath?: string;
}

function parseWithExternalFrontend(command: string, source: string): ProgramNode {
    const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-external-frontend-"));
    try {
        const inputPath: string = join(tempDir, "input.iw");
        writeFileSync(inputPath, source, "utf8");
        return parse(
            restoreTokensFromJsonText(
                execFileSync(command, ["--tokens", "--input-file", inputPath], {
                    encoding: "utf8",
                    maxBuffer: 64 * 1024 * 1024
                })
            )
        ) as ProgramNode;
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

export function parseProgramSource(source: string, options?: ParseProgramSourceOptions): ProgramNode {
    const externalFrontendJsonCommand: string | undefined = process.env[EXTERNAL_FRONTEND_JSON_COMMAND_ENV_NAME];
    const ast = externalFrontendJsonCommand === undefined || externalFrontendJsonCommand.trim().length === 0
        ? parse(tokenize(source, { filePath: options?.filePath }))
        : parseWithExternalFrontend(externalFrontendJsonCommand.trim(), source);
    if (!(ast instanceof ProgramNode)) {
        throw new Error("An .iw file must contain exactly one root {program ...} block");
    }
    return ast;
}

export function collectIwFiles(inputPath: string): string[] {
    const resolvedPath = resolve(inputPath);
    const stats = statSync(resolvedPath);
    if (stats.isFile()) {
        if (extname(resolvedPath) !== ".iw") {
            throw new Error(`Expected an .iw file, got '${resolvedPath}'`);
        }
        return [resolvedPath];
    }

    if (!stats.isDirectory()) {
        throw new Error(`Expected a file or directory, got '${resolvedPath}'`);
    }

    const results: string[] = [];
    for (const child of readdirSync(resolvedPath).sort()) {
        const childPath = join(resolvedPath, child);
        const childStats = statSync(childPath);
        if (childStats.isDirectory()) {
            results.push(...collectIwFiles(childPath));
            continue;
        }
        if (childStats.isFile() && extname(childPath) === ".iw") {
            results.push(childPath);
        }
    }
    return results;
}

function collectDistinctFiles(inputPaths: readonly string[], collector: (inputPath: string) => readonly string[]): string[] {
    const seenFiles = new Set<string>();
    const collected: string[] = [];

    for (const inputPath of inputPaths) {
        for (const filePath of collector(inputPath)) {
            if (seenFiles.has(filePath)) {
                continue;
            }
            seenFiles.add(filePath);
            collected.push(filePath);
        }
    }

    return collected;
}

function resolveProgramInputRoots(inputPath: string, options?: LoadProgramAstOptions): readonly string[] {
    const roots = [resolve(inputPath), ...(options?.additionalInputPaths ?? []).map((path) => resolve(path))];
    const seenRoots = new Set<string>();
    const result: string[] = [];

    for (const root of roots) {
        if (seenRoots.has(root)) {
            continue;
        }
        seenRoots.add(root);
        result.push(root);
    }

    return result;
}

function collectPackageDbFiles(inputPath: string): string[] {
    const resolvedPath = resolve(inputPath);
    const stats = statSync(resolvedPath);
    if (stats.isFile()) {
        return [];
    }

    if (!stats.isDirectory()) {
        throw new Error(`Expected a file or directory, got '${resolvedPath}'`);
    }

    const results: string[] = [];
    for (const child of readdirSync(resolvedPath).sort()) {
        const childPath = join(resolvedPath, child);
        const childStats = statSync(childPath);
        if (childStats.isDirectory()) {
            results.push(...collectPackageDbFiles(childPath));
            continue;
        }
        if (childStats.isFile() && extname(childPath) === ".json" && isPackageStringDatabaseStem(basename(childPath, ".json"))) {
            results.push(childPath);
        }
    }
    return results;
}

export function normalizeText(text: string): string {
    return `${text.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function requireValidModuleUnitId(unitId: string, context: string): void {
    if (!MODULE_UNIT_ID_PATTERN.test(unitId)) {
        throw new Error(`${context} must use a canonical compilation unit id '<package-path>@<unit-name>', got '${unitId}'`);
    }
}

function formatDiagnosticPath(filePath: string): string {
    const relativePath = relative(process.cwd(), filePath);
    return relativePath.length === 0 ? filePath : relativePath;
}

function loadCompilationUnit(filePath: string): LoadedCompilationUnit {
    const resolvedPath = resolve(filePath);
    const source = readSourceFile(resolvedPath);
    const ast = parseProgramSource(source, { filePath: resolvedPath });
    const stem = basename(resolvedPath, ".iw");

    requireValidModuleUnitId(stem, `File '${resolvedPath}'`);
    if (ast.unitId === null) {
        throw new Error(`Module file '${formatDiagnosticPath(resolvedPath)}' must declare its compilation unit id in the program header`);
    }

    requireValidModuleUnitId(ast.unitId.name, `Program header in '${formatDiagnosticPath(resolvedPath)}'`);
    if (ast.unitId.name !== stem) {
        throw new Error(`Module file '${formatDiagnosticPath(resolvedPath)}' declares program header '${ast.unitId.name}', which does not match file name stem '${stem}'`);
    }
    const metadata = parseCompilationUnitId(ast.unitId.name);
    if (metadata === null) {
        throw new Error(`Program header in '${formatDiagnosticPath(resolvedPath)}' must use a canonical compilation unit id '<package-path>@<unit-name>', got '${ast.unitId.name}'`);
    }
    annotateCompilationUnitExpressions(ast, {
        ...metadata,
        filePath: resolvedPath
    });

    return {
        filePath: resolvedPath,
        stem,
        ast,
    };
}

export function loadProgramAstWithSources(inputPath: string, options?: LoadProgramAstOptions): LoadedProgramAstBundle {
    const inputRoots = resolveProgramInputRoots(inputPath, options);
    const files = collectDistinctFiles(inputRoots, collectIwFiles);
    if (files.length === 0) {
        throw new Error(`No .iw files found under '${resolve(inputPath)}'`);
    }

    const units = files.map((filePath) => loadCompilationUnit(filePath));
    const seenUnitFiles: Map<string, string> = new Map();
    for (const unit of units) {
        const previousPath = seenUnitFiles.get(unit.stem);
        if (previousPath !== undefined) {
            throw new Error(`Duplicate compilation unit id '${unit.stem}': ${formatDiagnosticPath(previousPath)} and ${formatDiagnosticPath(unit.filePath)}`);
        }
        seenUnitFiles.set(unit.stem, unit.filePath);
    }

    const packageDbFiles = collectDistinctFiles(inputRoots, collectPackageDbFiles);
    const packageDatabase = buildProgramPackageStringDatabase(
        packageDbFiles.map((filePath) => loadPackageStringDatabaseFile(filePath, basename(filePath, ".json")))
    );

    if (units.length === 1) {
        annotateProgramPackageStringDatabase(units[0].ast, packageDatabase);
        return {
            ast: units[0].ast,
            sourceFiles: files,
            packageDbFiles
        };
    }

    const program = new ProgramNode(units.flatMap((unit) => unit.ast.topLevelExpressions));
    annotateProgramPackageStringDatabase(program, packageDatabase);
    return {
        ast: program,
        sourceFiles: files,
        packageDbFiles
    };
}

export function loadProgramAst(inputPath: string, options?: LoadProgramAstOptions): ProgramNode {
    return loadProgramAstWithSources(inputPath, options).ast;
}
