import { deepStrictEqual, match, strictEqual } from "assert";
import { execFileSync, spawnSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { dumpAstToJsonText } from "../FrontendJson";
import { parseProgramSource } from "../ModuleLoader";

const repoRoot: string = resolve(__dirname, "..", "..");
const commandPath: string = join(repoRoot, "src", "examples", "json-lib", "run-iw-frontend-json.js");
const { runIronwallDump } = require(commandPath) as {
    runIronwallDump: (inputFile: string, options?: { quietStderr?: boolean; frontendAstOnly?: boolean }) => unknown;
};
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "frontend-json");
const sourcePath: string = join(fixtureDir, "minimal-program.iw");
const source: string = readFileSync(sourcePath, "utf8");
const expectedAst = JSON.parse(readFileSync(join(fixtureDir, "minimal-program.ast.json"), "utf8"));
const expectedBundle = JSON.parse(readFileSync(join(fixtureDir, "minimal-program.bundle.json"), "utf8"));

const ast = JSON.parse(runFrontendJson(["--input-file", sourcePath]));
const tokens = JSON.parse(runFrontendJson(["--tokens", "--input-file", sourcePath]));
const bundle = JSON.parse(runFrontendJson(["--bundle", "--input-file", sourcePath]));

deepStrictEqual(ast, expectedAst, "minimal external frontend AST scaffold mismatch");
deepStrictEqual(tokens, expectedBundle.tokens, "minimal external frontend token scaffold mismatch");
deepStrictEqual(bundle, expectedBundle, "minimal external frontend bundle scaffold mismatch");

process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND = commandPath;
deepStrictEqual(
    JSON.parse(dumpAstToJsonText(parseProgramSource(source, { filePath: sourcePath }))),
    expectedAst,
    "minimal external frontend ModuleLoader AST mismatch"
);

const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-iw-frontend-json-import-"));
try {
    const importSource: string = "{program test~json~import@main (import app~json~lib)}";
    const importPath: string = join(tempDir, "import.iw");
    writeFileSync(importPath, importSource, "utf8");
    deepStrictEqual(
        JSON.parse(runFrontendJson(["--input-file", importPath])),
        JSON.parse(dumpAstToJsonText(parseProgramSource(importSource, { filePath: importPath }))),
        "import external frontend AST mismatch"
    );

    const multiImportSource: string = "{program test~json~imports@main (import std~string) (import app~json~lib)}";
    const multiImportPath: string = join(tempDir, "multi-import.iw");
    writeFileSync(multiImportPath, multiImportSource, "utf8");
    deepStrictEqual(
        JSON.parse(runFrontendJson(["--input-file", multiImportPath])),
        JSON.parse(dumpAstToJsonText(parseProgramSource(multiImportSource, { filePath: multiImportPath }))),
        "multi-import external frontend AST mismatch"
    );

    const classSource: string = [
        "{program test~json~class@defs",
        "  (export (class Counter",
        "    (public (property [value i5]))",
        "    (public (method read () to i5 in (cm_get self value)))",
        "    (constructor ([init i5]) in (cm_set self value init))",
        "  ))",
        "  (export (function make_counter ([value i5]) to Counter in (class_new Counter value)))",
        "}"
    ].join("\n");
    const classPath: string = join(tempDir, "class.iw");
    writeFileSync(classPath, classSource, "utf8");
    deepStrictEqual(
        JSON.parse(runFrontendJson(["--input-file", classPath])),
        JSON.parse(dumpAstToJsonText(parseProgramSource(classSource, { filePath: classPath }))),
        "class external frontend AST mismatch"
    );
    const classDump = runIronwallDump(classPath, { frontendAstOnly: true }) as {
        parser?: {
            frontendAst?: { kind?: string };
        };
    };
    strictEqual(classDump.parser?.frontendAst?.kind, "ProgramNode", "class dump should emit frontendAst directly");
    strictEqual(Object.prototype.hasOwnProperty.call(classDump.parser ?? {}, "rawAst"), false, "class dump should not require rawAst");

    const genericClassSource: string = [
        "{program test~json~generic~class@main",
        "  (class <generic Box T>",
        "    (public (property [value T]))",
        "    (constructor ([value0 T]) in (cm_set self value value0))",
        "  )",
        "  (function <generic make_box T> ([value T]) to <Box T> in (class_new <Box T> value))",
        "}"
    ].join("\n");
    const genericClassPath: string = join(tempDir, "generic-class.iw");
    writeFileSync(genericClassPath, genericClassSource, "utf8");
    const genericClassDump = runIronwallDump(genericClassPath, { frontendAstOnly: true }) as {
        parser?: {
            frontendAst?: { kind?: string };
        };
    };
    strictEqual(genericClassDump.parser?.frontendAst?.kind, "ProgramNode", "generic class dump should emit frontendAst directly");
    strictEqual(Object.prototype.hasOwnProperty.call(genericClassDump.parser ?? {}, "rawAst"), false, "generic class dump should not require rawAst");

    const legacyGenericCallSource: string = [
        "{program test~json~legacy~generic@main",
        "  (function main () to <Option i5> in (option_none <i5>))",
        "}"
    ].join("\n");
    const legacyGenericCallPath: string = join(tempDir, "legacy-generic-call.iw");
    writeFileSync(legacyGenericCallPath, legacyGenericCallSource, "utf8");
    deepStrictEqual(
        JSON.parse(runFrontendJson(["--input-file", legacyGenericCallPath])),
        JSON.parse(dumpAstToJsonText(parseProgramSource(legacyGenericCallSource, { filePath: legacyGenericCallPath }))),
        "legacy generic call external frontend AST mismatch"
    );
    const legacyGenericCallDump = runIronwallDump(legacyGenericCallPath, { frontendAstOnly: true }) as {
        parser?: {
            frontendAst?: { kind?: string };
            hasErrors?: boolean;
        };
    };
    strictEqual(legacyGenericCallDump.parser?.hasErrors, false, "legacy generic call dump should not set parse errors");
    strictEqual(legacyGenericCallDump.parser?.frontendAst?.kind, "ProgramNode", "legacy generic call dump should emit frontendAst directly");
    strictEqual(Object.prototype.hasOwnProperty.call(legacyGenericCallDump.parser ?? {}, "rawAst"), false, "legacy generic call dump should not require rawAst");

    const declaredExportSource: string = [
        "{program test~json~declare@defs",
        "  (export (declare (function native_make () to s3)))",
        "}"
    ].join("\n");
    const declaredExportPath: string = join(tempDir, "declared-export.iw");
    writeFileSync(declaredExportPath, declaredExportSource, "utf8");
    deepStrictEqual(
        JSON.parse(runFrontendJson(["--input-file", declaredExportPath])),
        JSON.parse(dumpAstToJsonText(parseProgramSource(declaredExportSource, { filePath: declaredExportPath }))),
        "declared export external frontend AST mismatch"
    );
    const declaredExportDump = runIronwallDump(declaredExportPath, { frontendAstOnly: true }) as {
        parser?: {
            frontendAst?: { kind?: string };
            hasErrors?: boolean;
        };
    };
    strictEqual(declaredExportDump.parser?.hasErrors, false, "declared export dump should not set parse errors");
    strictEqual(declaredExportDump.parser?.frontendAst?.kind, "ProgramNode", "declared export dump should emit frontendAst directly");
    strictEqual(Object.prototype.hasOwnProperty.call(declaredExportDump.parser ?? {}, "rawAst"), false, "declared export dump should not require rawAst");

    const exportPlainExpressionSource: string = [
        "{program test~json~export~plain@main",
        "  (export $1^i5)",
        "}"
    ].join("\n");
    const exportPlainExpressionPath: string = join(tempDir, "export-plain-expression.iw");
    writeFileSync(exportPlainExpressionPath, exportPlainExpressionSource, "utf8");
    deepStrictEqual(
        JSON.parse(runFrontendJson(["--input-file", exportPlainExpressionPath])),
        JSON.parse(dumpAstToJsonText(parseProgramSource(exportPlainExpressionSource, { filePath: exportPlainExpressionPath }))),
        "export plain expression external frontend AST mismatch"
    );

    const nestedExportSource: string = [
        "{program test~json~nested~export@main",
        "  (function main ([args <array s3>]) to i5 in",
        "    (export (function inner () to i5 in $0^i5))",
        "  )",
        "}"
    ].join("\n");
    const nestedExportPath: string = join(tempDir, "nested-export.iw");
    writeFileSync(nestedExportPath, nestedExportSource, "utf8");
    deepStrictEqual(
        JSON.parse(runFrontendJson(["--input-file", nestedExportPath])),
        JSON.parse(dumpAstToJsonText(parseProgramSource(nestedExportSource, { filePath: nestedExportPath }))),
        "nested export external frontend AST mismatch"
    );

    const outsideClassPublicSource: string = [
        "{program test~json~public~outside@main",
        "  (public (function main ([args <array s3>]) to i5 in $0^i5))",
        "}"
    ].join("\n");
    const outsideClassPublicPath: string = join(tempDir, "outside-class-public.iw");
    writeFileSync(outsideClassPublicPath, outsideClassPublicSource, "utf8");
    deepStrictEqual(
        JSON.parse(runFrontendJson(["--input-file", outsideClassPublicPath])),
        JSON.parse(dumpAstToJsonText(parseProgramSource(outsideClassPublicSource, { filePath: outsideClassPublicPath }))),
        "public outside class external frontend AST mismatch"
    );

    const parserDefsPath: string = join(repoRoot, "src", "examples", "json-lib", "app~iw~parse@defs.iw");
    const parserDefsDump = runIronwallDump(parserDefsPath, { frontendAstOnly: true }) as {
        parser?: {
            frontendAst?: { kind?: string };
            hasErrors?: boolean;
        };
    };
    strictEqual(parserDefsDump.parser?.hasErrors, false, "parser defs dump should not set parse errors");
    strictEqual(parserDefsDump.parser?.frontendAst?.kind, "ProgramNode", "parser defs dump should emit frontendAst directly");
    strictEqual(Object.prototype.hasOwnProperty.call(parserDefsDump.parser ?? {}, "rawAst"), false, "parser defs dump should not require rawAst");
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}

const invalidTempDir: string = mkdtempSync(join(tmpdir(), "ironwall-iw-frontend-json-invalid-"));
try {
    const invalidCases: ReadonlyArray<{ readonly fileName: string; readonly source: string; readonly message: RegExp; readonly diagnosticMessage?: string }> = [
        {
            fileName: "invalid-import.iw",
            source: "{program test~json~invalid@main (import)}",
            message: /Invalid import structure/,
            diagnosticMessage: "Invalid import structure: expected (import package-path)"
        },
        {
            fileName: "export-arity-zero.iw",
            source: "{program test~json~export~arity@main (export)}",
            message: /export expects exactly one argument/,
            diagnosticMessage: "export expects exactly one argument"
        },
        {
            fileName: "public-wrap-expression.iw",
            source: [
                "{program test~json~public~wrap@main",
                "  (class WrappedExpr",
                "    (public $1^i5)",
                "    (constructor () in unit)",
                "  )",
                "}"
            ].join("\n"),
            message: /public may only wrap class properties and methods/,
            diagnosticMessage: "public may only wrap class properties and methods"
        },
        {
            fileName: "public-wrap-constructor.iw",
            source: [
                "{program test~json~public~ctor@main",
                "  (class WrappedCtor",
                "    (public (constructor () in unit))",
                "  )",
                "}"
            ].join("\n"),
            message: /constructors are always public and cannot be wrapped in public/,
            diagnosticMessage: "constructors are always public and cannot be wrapped in public"
        },
        {
            fileName: "public-wrap-public.iw",
            source: [
                "{program test~json~public~public@main",
                "  (class DoublePublic",
                "    (public (public (property [value i5])))",
                "    (constructor () in (cm_set self value $1^i5))",
                "  )",
                "}"
            ].join("\n"),
            message: /public cannot wrap public/,
            diagnosticMessage: "public cannot wrap public"
        }
    ];

    for (const invalidCase of invalidCases) {
        const invalidPath: string = join(invalidTempDir, invalidCase.fileName);
        writeFileSync(invalidPath, invalidCase.source, "utf8");
        const invalidResult = spawnSync(process.execPath, [commandPath, "--input-file", invalidPath], {
            cwd: repoRoot,
            encoding: "utf8"
        });
        strictEqual(invalidResult.status, 2, `${invalidCase.fileName} should exit with status 2`);
        strictEqual(invalidResult.stdout, "", `${invalidCase.fileName} should not emit stdout JSON`);
        match(invalidResult.stderr, invalidCase.message, `${invalidCase.fileName} should surface parser diagnostics on stderr`);

        if (invalidCase.diagnosticMessage !== undefined) {
            const invalidDump = runIronwallDump(invalidPath, { frontendAstOnly: true }) as {
                parser?: {
                    hasErrors?: boolean;
                    diagnosticMessage?: string;
                    frontendAst?: unknown;
                };
            };
            strictEqual(invalidDump.parser?.hasErrors, true, `${invalidCase.fileName} dump should set parse errors`);
            strictEqual(invalidDump.parser?.diagnosticMessage, invalidCase.diagnosticMessage, `${invalidCase.fileName} dump should expose parser diagnosticMessage`);
            strictEqual(Object.prototype.hasOwnProperty.call(invalidDump.parser ?? {}, "rawAst"), false, `${invalidCase.fileName} initial dump should not require rawAst`);
        }
    }

    const stubDumpPath: string = join(invalidTempDir, "stub-dump.js");
    writeFileSync(stubDumpPath, [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ parser: { frontendAst: null, hasErrors: true, diagnosticMessage: 'stub parser diagnostic' }, lexer: { tokens: [], frontendTokens: [] } }));"
    ].join("\n"), "utf8");
    chmodSync(stubDumpPath, 0o755);
    const stubResult = spawnSync(process.execPath, [commandPath, "--input-file", sourcePath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            IRONWALL_IW_DUMP_BIN: stubDumpPath
        }
    });
    strictEqual(stubResult.status, 2, "parser diagnostic stub should exit with status 2");
    strictEqual(stubResult.stdout, "", "parser diagnostic stub should not emit stdout JSON");
    match(stubResult.stderr, /stub parser diagnostic/, "parser diagnostic stub should fail from the initial parser diagnostic");

    const noFrontendStubDumpPath: string = join(invalidTempDir, "stub-no-frontend.js");
    writeFileSync(noFrontendStubDumpPath, [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ parser: { frontendAst: null, hasErrors: false }, lexer: { tokens: [], frontendTokens: [] } }));"
    ].join("\n"), "utf8");
    chmodSync(noFrontendStubDumpPath, 0o755);
    const noFrontendStubResult = spawnSync(process.execPath, [commandPath, "--input-file", sourcePath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            IRONWALL_IW_DUMP_BIN: noFrontendStubDumpPath
        }
    });
    strictEqual(noFrontendStubResult.status, 2, "missing frontendAst stub should exit with status 2");
    strictEqual(noFrontendStubResult.stdout, "", "missing frontendAst stub should not emit stdout JSON");
    match(noFrontendStubResult.stderr, /Ironwall dump did not provide parser.frontendAst/, "missing frontendAst stub should fail directly");
} finally {
    rmSync(invalidTempDir, { recursive: true, force: true });
}

process.stdout.write("iw-frontend-json-external-scaffold ok\n");

function runFrontendJson(args: readonly string[]): string {
    return execFileSync(process.execPath, [commandPath, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
    });
}
