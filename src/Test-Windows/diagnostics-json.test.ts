import { deepStrictEqual, strictEqual } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { IronwallDiagnostic } from "../Diagnostics";
import { spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");

function runFailureDiagnostic(fileName: string, source: string): IronwallDiagnostic {
    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-diagnostic-json-"));
    try {
        const filePath = join(tempDir, fileName);
        writeFileSync(filePath, source, "utf8");
        const result = spawnBuildJsonCliSync(cliPath, ["check", filePath, "--no-base-lib"], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        strictEqual(result.status, 1, `expected failure for ${fileName}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        return JSON.parse(result.stderr) as IronwallDiagnostic;
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

const lexerDiagnostic = runFailureDiagnostic(
    "diag~lexer@main.iw",
    [
        "{program diag~lexer@main",
        "  -",
        "}",
        ""
    ].join("\n")
);
strictEqual(lexerDiagnostic.stage, "lexer");
strictEqual(lexerDiagnostic.code, "INVALID_CHARACTER");
strictEqual(lexerDiagnostic.location?.line, 2);
strictEqual(lexerDiagnostic.location?.column, 3);
strictEqual(lexerDiagnostic.location?.excerpt, "-");
strictEqual(lexerDiagnostic.location?.contextStartLine, 1);
strictEqual(lexerDiagnostic.location?.contextEndLine, 3);
deepStrictEqual(lexerDiagnostic.location?.contextLines, [
    { line: 1, text: "{program diag~lexer@main", isPrimary: false },
    { line: 2, text: "  -", isPrimary: true, caretLine: "  ^" },
    { line: 3, text: "}", isPrimary: false },
]);
process.stdout.write("diagnostics-json lexer ok\n");

const parserDiagnostic = runFailureDiagnostic(
    "diag~parser@main.iw",
    [
        "{program diag~parser@main",
        "  ]",
        "}",
        ""
    ].join("\n")
);
strictEqual(parserDiagnostic.stage, "parser-pass-1");
strictEqual(parserDiagnostic.code, "MISMATCHED_CLOSING_BRACKET");
strictEqual(parserDiagnostic.location?.line, 2);
strictEqual(parserDiagnostic.location?.column, 3);
strictEqual(parserDiagnostic.location?.excerpt, "]");
deepStrictEqual(parserDiagnostic.location?.contextLines, [
    { line: 1, text: "{program diag~parser@main", isPrimary: false },
    { line: 2, text: "  ]", isPrimary: true, caretLine: "  ^" },
    { line: 3, text: "}", isPrimary: false },
]);
process.stdout.write("diagnostics-json parser ok\n");

const typecheckDiagnostic = runFailureDiagnostic(
    "diag~typecheck@main.iw",
    [
        "{program diag~typecheck@main",
        "  (function main ([args <array s3>]) to i5 in missing_value)",
        "}",
        ""
    ].join("\n")
);
strictEqual(typecheckDiagnostic.stage, "typecheck");
strictEqual(typecheckDiagnostic.code, "TYPECHECK_ERROR");
strictEqual(typecheckDiagnostic.location?.line, 2);
strictEqual(typecheckDiagnostic.location?.column, 47);
strictEqual(typecheckDiagnostic.location?.excerpt, "missing_value");
deepStrictEqual(typecheckDiagnostic.location?.lineText.trim(), "(function main ([args <array s3>]) to i5 in missing_value)");
deepStrictEqual(typecheckDiagnostic.location?.contextLines, [
    { line: 1, text: "{program diag~typecheck@main", isPrimary: false },
    {
        line: 2,
        text: "  (function main ([args <array s3>]) to i5 in missing_value)",
        isPrimary: true,
        caretLine: "                                              ^^^^^^^^^^^^^"
    },
    { line: 3, text: "}", isPrimary: false },
]);
process.stdout.write("diagnostics-json typecheck ok\n");

const topLevelTypecheckDiagnostic = runFailureDiagnostic(
    "diag~toplevel@main.iw",
    [
        "{program diag~toplevel@main",
        "  stray_value",
        "}",
        ""
    ].join("\n")
);
strictEqual(topLevelTypecheckDiagnostic.stage, "typecheck");
strictEqual(topLevelTypecheckDiagnostic.code, "TYPECHECK_ERROR");
strictEqual(topLevelTypecheckDiagnostic.location?.line, 2);
strictEqual(topLevelTypecheckDiagnostic.location?.column, 3);
strictEqual(topLevelTypecheckDiagnostic.location?.excerpt, "stray_value");
strictEqual(topLevelTypecheckDiagnostic.message.includes("module mode only allows"), true);
deepStrictEqual(topLevelTypecheckDiagnostic.location?.contextLines, [
    { line: 1, text: "{program diag~toplevel@main", isPrimary: false },
    { line: 2, text: "  stray_value", isPrimary: true, caretLine: "  ^^^^^^^^^^^" },
    { line: 3, text: "}", isPrimary: false },
]);
process.stdout.write("diagnostics-json top-level-typecheck ok\n");