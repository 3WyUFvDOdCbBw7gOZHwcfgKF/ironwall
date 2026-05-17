import { deepStrictEqual, ok, strictEqual, throws } from "assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IdentifierToken, tokenize } from "../lexer";
import { IronwallDiagnosticError } from "../Diagnostics";
import { parseProgramSource } from "../ModuleLoader";
import { formatIw } from "../IwFormatter";

const dottedSource: string = "{program test~member~sugar@main (function main ([args <array s3>]) to i5 in (cm_get (cm_get data left) right))}";
const expectedDottedFormat: string = [
    "{program test~member~sugar@main",
    "  (function main ([args <array s3>]) to i5 in data.left.right)",
    "}",
    ""
].join("\n");

strictEqual(
    formatIw(parseProgramSource(dottedSource)),
    expectedDottedFormat,
    "formatter should collapse nested cm_get chains into dot sugar"
);

const directDottedProgram = parseProgramSource("{program test~member~source@main (function main ([args <array s3>]) to i5 in source.left.right)}");
strictEqual(
    formatIw(directDottedProgram),
    [
        "{program test~member~source@main",
        "  (function main ([args <array s3>]) to i5 in source.left.right)",
        "}",
        ""
    ].join("\n"),
    "dot sugar should parse and round-trip through formatting"
);

const singleSegmentPackageProgram = parseProgramSource("{program singlepkg@main (function main ([args <array s3>]) to i5 in unit)}");
strictEqual(singleSegmentPackageProgram.unitId?.name, "singlepkg@main", "single-segment package ids should parse without requiring '~'");

throws(
    () => tokenize("source-left-right"),
    (error: unknown): boolean => {
        ok(error instanceof IronwallDiagnosticError, `unexpected lexer error type: ${String(error)}`);
        strictEqual(error.diagnostic.stage, "lexer");
        strictEqual(error.diagnostic.code, "INVALID_CHARACTER");
        strictEqual(error.diagnostic.location?.line, 1);
        strictEqual(error.diagnostic.location?.column, 7);
        strictEqual(error.diagnostic.location?.excerpt, "-");
        return true;
    },
    "legacy dash member sugar should report a structured lexer diagnostic"
);
deepStrictEqual(tokenize("_ffi_symbol"), [new IdentifierToken("_ffi_symbol")], "leading-underscore identifiers should tokenize");
deepStrictEqual(tokenize("pkg@unit"), [new IdentifierToken("pkg@unit")], "single-segment package ids should tokenize");
deepStrictEqual(tokenize("pkg~name@_ffi_symbol"), [new IdentifierToken("pkg~name@_ffi_symbol")], "package-qualified names should allow leading-underscore exports");

function lintFormatSingleFile(filePath: string, fixFormatting: boolean): string {
    const source = readFileSync(filePath, "utf8");
    const formatted = formatIw(parseProgramSource(source));
    if (source === formatted) {
        return "Formatting OK: 1 file(s)";
    }
    if (!fixFormatting) {
        throw new Error(`Formatting mismatch in ${filePath}`);
    }
    writeFileSync(filePath, formatted, "utf8");
    return "Formatting fixed: 1/1 file(s)";
}

const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-member-chain-"));
try {
    const filePath: string = join(tempDir, "test~member~lint@main.iw");
    const source = [
        "{program test~member~lint@main",
        "(function main ([args <array s3>]) to i5 in",
        "{",
        "((cm_get source set) $0^i5 $1^i5)",
        "(cm_get (cm_get source left) right)",
        "(cm_get (array_get raw $0^i5) value)",
        "}",
        ")",
        "}"
    ].join("\n");
    writeFileSync(filePath, source, "utf8");

    const fixOutput: string = lintFormatSingleFile(filePath, true);
    strictEqual(fixOutput.trim(), "Formatting fixed: 1/1 file(s)", `unexpected lint-format --fix output\n${fixOutput}`);

    const formattedSource: string = readFileSync(filePath, "utf8");
    strictEqual(
        formattedSource,
        [
            "{program test~member~lint@main",
            "  (function main ([args <array s3>]) to i5 in",
            "    {",
            "      (source.set $0^i5 $1^i5)",
            "      source.left.right",
            "      (cm_get (array_get raw $0^i5) value)",
            "    }",
            "  )",
            "}",
            ""
        ].join("\n"),
        "lint-format --fix should rewrite eligible cm_get chains to dot sugar only"
    );

    const verifyOutput: string = lintFormatSingleFile(filePath, false);
    strictEqual(verifyOutput.trim(), "Formatting OK: 1 file(s)", `unexpected lint-format verify output\n${verifyOutput}`);
    process.stdout.write("member-chain-sugar format ok\n");
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}
