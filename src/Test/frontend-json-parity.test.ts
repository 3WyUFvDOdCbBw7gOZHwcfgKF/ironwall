import { deepStrictEqual } from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { dumpFrontendBundleToJsonText, dumpTokensToJsonText } from "../FrontendJson";
import { tokenize } from "../lexer";
import { parse } from "../parser";
import { ensureCurrentNodeProcessHasMemoryLimit } from "./NodeMemoryLimit";

ensureCurrentNodeProcessHasMemoryLimit();

interface InlineSourceCase {
    readonly label: string;
    readonly source: string;
}

interface TokenOnlyCase {
    readonly label: string;
    readonly source: string;
}

class BundleParityFileCase {
    public readonly label: string;
    public readonly inputPath: string;

    public constructor(label0: string, inputPath0: string) {
        this.label = label0;
        this.inputPath = inputPath0;
    }
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
    const bundleParityFileCases: readonly BundleParityFileCase[] = [
        new BundleParityFileCase(
            "language-rules app",
            join(repoRoot, "src", "Test", "Fixtures", "language-rules", "test~language~rules~app@main.iw")
        ),
        new BundleParityFileCase(
            "language-rules lib defs",
            join(repoRoot, "src", "Test", "Fixtures", "language-rules", "test~language~rules~lib@defs.iw")
        ),
        new BundleParityFileCase(
            "language-rules export app",
            join(repoRoot, "src", "Test", "Fixtures", "language-rules", "test~language~rules~export~app@main.iw")
        ),
        new BundleParityFileCase(
            "precompiled-lib generic box defs",
            join(repoRoot, "src", "Test", "Fixtures", "precompiled-lib", "lib", "test~precompiled~lib@box.iw")
        ),
        new BundleParityFileCase(
            "generic-stress flow",
            join(repoRoot, "src", "Test", "Fixtures", "generic-stress", "test~generic~stress~flow@main.iw")
        ),
        new BundleParityFileCase(
            "export declared function defs",
            join(repoRoot, "src", "Test", "Fixtures", "language-rules-check", "export-declared-success", "test~language~rules~export~declare@defs.iw")
        ),
        new BundleParityFileCase(
            "export plain expression main",
            join(repoRoot, "src", "Test", "Fixtures", "language-rules-typecheck", "test~language~rules~export_plain_expression@main.iw")
        ),
        new BundleParityFileCase(
            "nested export main",
            join(repoRoot, "src", "Test", "Fixtures", "language-rules-typecheck", "test~language~rules~nested_export@main.iw")
        ),
        new BundleParityFileCase(
            "ffi heap return main",
            join(repoRoot, "src", "Test", "Fixtures", "ffi-c-heap-return", "test~ffi~c~heap_return@main.iw")
        ),
        new BundleParityFileCase(
            "public-visibility app",
            join(repoRoot, "src", "Test", "Fixtures", "public-visibility", "test~public~visibility~app@main.iw")
        ),
        new BundleParityFileCase(
            "public outside class main",
            join(repoRoot, "src", "Test", "Fixtures", "public-visibility-typecheck", "test~public~visibility~outside_class@main.iw")
        ),
        new BundleParityFileCase(
            "builtin-ops main",
            join(repoRoot, "src", "Test", "Fixtures", "builtin-ops", "test~builtin~ops@main.iw")
        ),
        new BundleParityFileCase(
            "variadic-builtins main",
            join(repoRoot, "src", "Test", "Fixtures", "variadic-builtins", "test~variadic~builtins@main.iw")
        ),
        new BundleParityFileCase(
            "raytracer main",
            join(repoRoot, "src", "examples", "raytracer", "src", "ray~tracer@main.iw")
        )
    ];
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
        },
        {
            label: "generic-type-inline-program",
            source: [
                "{program test~generic~types@main",
                "  (class <generic Box T>",
                "    (public (property [value T]))",
                "    (constructor ([value0 T]) in (cm_set self value value0))",
                "  )",
                "  (function <generic make_box T> ([value T]) to <Box T> in (class_new <Box T> value))",
                "  (function make_reader ([base i5]) to <to <Box i5> from i5> in",
                "    (fn ([delta i5]) to <Box i5> in (<make_box i5> (add base delta)))",
                "  )",
                "  (function choose_payload ([flag bool] [value i5]) to <union i5 bool <Box i5>> in",
                "    (if flag",
                "      then (<make_box i5> value)",
                "      else value",
                "    )",
                "  )",
                "}"
            ].join("\n")
        },
        {
            label: "legacy-generic-call-inline-program",
            source: [
                "{program test~legacy~generic@main",
                "  (function main () to <Option i5> in (option_none <i5>))",
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

    for (const fileCase of bundleParityFileCases) {
        if (parserNegativeParityFixtureNames.has(basename(fileCase.inputPath))) {
            continue;
        }
        const source: string = readFileSync(fileCase.inputPath, "utf8");
        assertBundleParity(externalFrontendJsonCommand.trim(), repoRoot, source, fileCase.label);
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
