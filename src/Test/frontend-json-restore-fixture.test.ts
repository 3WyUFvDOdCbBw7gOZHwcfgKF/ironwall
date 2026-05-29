import { deepStrictEqual } from "assert";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import {
    dumpAstToJsonText,
    dumpFrontendBundleToJsonText,
    restoreAstFromJsonText,
    restoreFrontendBundleFromJsonText
} from "../FrontendJson";
import { tokenize } from "../lexer";
import { parse } from "../parser";

const repoRoot: string = resolve(__dirname, "..", "..");
const fixtureDir: string = join(repoRoot, "src", "Test", "Fixtures", "frontend-json");
const sourcePath: string = join(fixtureDir, "minimal-program.iw");
const astJsonPath: string = join(fixtureDir, "minimal-program.ast.json");
const bundleJsonPath: string = join(fixtureDir, "minimal-program.bundle.json");

const source: string = readFileSync(sourcePath, "utf8");
const astJsonText: string = readFileSync(astJsonPath, "utf8");
const bundleJsonText: string = readFileSync(bundleJsonPath, "utf8");
const expectedTokens = tokenize(source);
const expectedAst = parse(expectedTokens);

const restoredAst = restoreAstFromJsonText(astJsonText);
const restoredBundle = restoreFrontendBundleFromJsonText(bundleJsonText);

deepStrictEqual(
    JSON.parse(dumpAstToJsonText(restoredAst)),
    JSON.parse(dumpAstToJsonText(expectedAst)),
    "minimal frontend-json AST fixture mismatch"
);

deepStrictEqual(
    JSON.parse(dumpFrontendBundleToJsonText(restoredBundle.tokens, restoredBundle.ast)),
    JSON.parse(dumpFrontendBundleToJsonText(expectedTokens, expectedAst)),
    "minimal frontend-json bundle fixture mismatch"
);

process.stdout.write("frontend-json-restore-fixture ok\n");