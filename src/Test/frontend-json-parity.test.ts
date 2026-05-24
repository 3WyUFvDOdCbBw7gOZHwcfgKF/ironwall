import { deepStrictEqual } from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { dumpFrontendBundleToJsonText, dumpTokensToJsonText } from "../FrontendJson";
import { tokenize } from "../lexer";
import { parse } from "../parser";

interface InlineSourceCase {
    readonly label: string;
    readonly source: string;
}

interface TokenOnlyCase {
    readonly label: string;
    readonly source: string;
}

const externalFrontendJsonCommand: string | undefined = process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND;
const parserNegativeParityFixtureNames: ReadonlySet<string> = new Set([
    "test~language~rules~export_arity_many@main.iw",
    "test~language~rules~export_arity_zero@main.iw",
    "test~public~visibility~public_arity_many@main.iw",
    "test~public~visibility~public_arity_zero@main.iw",
    "test~public~visibility~public_wrap_constructor@main.iw",
    "test~public~visibility~public_wrap_expression@main.iw",
    "test~public~visibility~public_wrap_public@main.iw"
]);

if (externalFrontendJsonCommand === undefined || externalFrontendJsonCommand.trim().length === 0) {
    process.stdout.write("frontend-json-parity skipped\n");
} else {
    const repoRoot: string = resolve(__dirname, "..", "..");
    const inlineSourceCases: readonly InlineSourceCase[] = [
        {
            label: "member-chain-inline-program",
            source: "{program test~member~source@main (function main ([args <array s3>]) to i5 in source.left.right)}"
        },
        {
            label: "public-export-inline-program",
            source: [
                "{program test~public~export@defs",
                "  (export (class Counter",
                "    (public (property [value i5]))",
                "    (public (method read () to i5 in (cm_get self value)))",
                "    (constructor ([init i5]) in (cm_set self value init))",
                "  ))",
                "  (export (function make_counter ([value i5]) to Counter in (class_new Counter value)))",
                "}"
            ].join("\n")
        },
        {
            label: "variadic-inline-program",
            source: [
                "{program test~variadic~parser@main",
                "  (function fold_add () to i5 in (add $1^i5 $2^i5 $3^i5 $4^i5))",
                "  (function fold_sub () to i5 in (sub $10^i5 $3^i5 $2^i5 $1^i5))",
                "  (function fold_mul () to i5 in (mul $2^i5 $3^i5 $4^i5 $5^i5))",
                "  (function fold_and () to bool in (and true false true true))",
                "  (function fold_or () to bool in (or false false true false))",
                "  (function chain_le () to bool in (le $1^i5 $2^i5 $3^i5 $4^i5))",
                "  (function chain_eq () to bool in (eq $7^i5 $7^i5 $7^i5 $7^i5))",
                "}"
            ].join("\n")
        }
    ];
    const tokenOnlyCases: readonly TokenOnlyCase[] = [
        {
            label: "leading-underscore-identifier",
            source: "_ffi_symbol"
        },
        {
            label: "qualified-leading-underscore-identifier",
            source: "pkg~name@_ffi_symbol"
        }
    ];

    for (const testCase of tokenOnlyCases) {
        const tsTokens = JSON.parse(dumpTokensToJsonText(tokenize(testCase.source)));
        const cppTokens = JSON.parse(runExternalFrontendJson(externalFrontendJsonCommand.trim(), repoRoot, testCase.source, ["--tokens"]));
        deepStrictEqual(cppTokens, tsTokens, `${testCase.label} token JSON mismatch`);
    }

    for (const filePath of collectParityInputFiles(repoRoot)) {
        if (parserNegativeParityFixtureNames.has(basename(filePath))) {
            continue;
        }
        const source: string = readFileSync(filePath, "utf8");
        assertBundleParity(externalFrontendJsonCommand.trim(), repoRoot, source, filePath);
    }

    for (const testCase of inlineSourceCases) {
        assertBundleParity(externalFrontendJsonCommand.trim(), repoRoot, testCase.source, testCase.label);
    }

    process.stdout.write("frontend-json-parity ok\n");
}

function assertBundleParity(commandPath: string, repoRoot: string, source: string, label: string): void {
    const tokens = tokenize(source);
    const ast = parse(tokens);
    const tsBundle = JSON.parse(dumpFrontendBundleToJsonText(tokens, ast));
    const cppBundle = JSON.parse(runExternalFrontendJson(commandPath, repoRoot, source, ["--bundle"]));
    deepStrictEqual(cppBundle, tsBundle, `${label} frontend JSON mismatch`);
}

function runExternalFrontendJson(commandPath: string, repoRoot: string, source: string, args: readonly string[]): string {
    const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-frontend-json-parity-"));
    try {
        const inputPath: string = join(tempDir, "input.iw");
        writeFileSync(inputPath, source, "utf8");
        return execFileSync(commandPath, [...args, "--input-file", inputPath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function collectParityInputFiles(repoRoot: string): string[] {
    const roots: readonly string[] = [
        join(repoRoot, "src", "Test", "Fixtures"),
        join(repoRoot, "artifacts"),
        ...getBaseLibSourceRoots()
    ];
    const seen = new Set<string>();
    const files: string[] = [];

    for (const root of roots) {
        for (const filePath of collectIwFiles(root)) {
            if (seen.has(filePath)) {
                continue;
            }
            seen.add(filePath);
            files.push(filePath);
        }
    }

    files.sort();
    return files;
}

function collectIwFiles(inputPath: string): string[] {
    const stats = statSync(inputPath);
    if (stats.isFile()) {
        return inputPath.endsWith(".iw") ? [inputPath] : [];
    }
    if (!stats.isDirectory()) {
        return [];
    }

    const files: string[] = [];
    for (const child of readdirSync(inputPath).sort()) {
        files.push(...collectIwFiles(join(inputPath, child)));
    }
    return files;
}
