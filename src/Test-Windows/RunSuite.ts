import { basename, join } from "path";
import { runBuiltTestSuite } from "../Test/RunSuiteSupport";

const excludedTestFileNames: ReadonlySet<string> = new Set([
    "frontend-json-parity.test.js",
    "iw-frontend-json-compiler-smoke.test.js",
    "iw-frontend-json-external-scaffold.test.js"
]);

runBuiltTestSuite({
    suiteName: "windows-suite",
    buildTestDirs: [
        join(__dirname, "..", "Test"),
        __dirname
    ],
    excludeTestFileNames: excludedTestFileNames,
    env: {
        IW_TEST_TARGET: "windows-x64"
    },
    orderTestFiles: (testFiles: readonly string[]): string[] => {
        const deduped = new Map<string, string>();
        for (const testFilePath of testFiles) {
            deduped.set(basename(testFilePath), testFilePath);
        }
        return Array.from(deduped.values()).sort((left, right) => left.localeCompare(right));
    }
});
