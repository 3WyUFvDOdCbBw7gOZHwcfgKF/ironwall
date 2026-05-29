import { basename, join } from "path";
import { runBuiltTestSuite } from "../Test/RunSuiteSupport";

const excludedTestFileNames: ReadonlySet<string> = new Set([
    "frontend-json-parity.test.js",
    "frontend-json-restore-fixture.test.js",
    "iw-frontend-json-compiler-smoke.test.js",
    "iw-frontend-json-external-scaffold.test.js",
    "iw-frontend-json-backend-smoke.test.js",
    "iw-frontend-json-fixture-check-smoke.test.js"
]);

const externalFrontendIncompatibleTestFileNames: ReadonlySet<string> = new Set([
    "diagnostics-json.test.js"
]);

function orderTestFiles(testFiles: readonly string[]): string[] {
    if (process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND === undefined || process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND.trim().length === 0) {
        return [...testFiles];
    }

    return testFiles.filter((testFilePath: string) => !externalFrontendIncompatibleTestFileNames.has(basename(testFilePath)));
}

runBuiltTestSuite({
    suiteName: "linux-suite",
    buildTestDirs: [
        join(__dirname, "..", "Test"),
        __dirname
    ],
    excludeTestFileNames: excludedTestFileNames,
    env: {
        IW_TEST_TARGET: "linux-x64"
    },
    orderTestFiles
});
