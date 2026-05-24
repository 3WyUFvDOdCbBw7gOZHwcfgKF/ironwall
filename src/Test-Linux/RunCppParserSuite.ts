import { existsSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { runBuiltTestSuite } from "../Test/RunSuiteSupport";

const repoRoot: string = resolve(__dirname, "..", "..");
const defaultExternalFrontendJsonCommand: string = join(repoRoot, "src", "astvis-qt", "build", "bin", "iw-frontend-json");
const parityTestFileName: string = "frontend-json-parity.test.js";

function getExternalFrontendJsonCommand(): string {
    const configuredPath: string | undefined = process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND;
    if (configuredPath !== undefined && configuredPath.trim().length > 0) {
        return resolve(configuredPath.trim());
    }
    return defaultExternalFrontendJsonCommand;
}

function ensureUsableExternalFrontendJsonCommand(commandPath: string): void {
    if (!existsSync(commandPath) || !statSync(commandPath).isFile()) {
        throw new Error(
            [
                `Missing C++ frontend JSON command at '${commandPath}'.`,
                "Build src/astvis-qt first so the iw-frontend-json binary exists, or set IW_EXTERNAL_FRONTEND_JSON_COMMAND to an alternate path."
            ].join(" ")
        );
    }
}

function orderTestFiles(testFiles: readonly string[]): string[] {
    const parityTestPath: string | undefined = testFiles.find((testFilePath: string) => basename(testFilePath) === parityTestFileName);
    const remainingTests: string[] = testFiles.filter((testFilePath: string) => basename(testFilePath) !== parityTestFileName);
    return parityTestPath === undefined
        ? [...remainingTests]
        : [parityTestPath, ...remainingTests];
}

const externalFrontendJsonCommand: string = getExternalFrontendJsonCommand();
ensureUsableExternalFrontendJsonCommand(externalFrontendJsonCommand);

runBuiltTestSuite({
    suiteName: "cpp-parser-suite",
    buildTestDirs: [
        join(__dirname, "..", "Test"),
        __dirname
    ],
    env: {
        IW_EXTERNAL_FRONTEND_JSON_COMMAND: externalFrontendJsonCommand,
        IW_TEST_TARGET: "linux-x64"
    },
    orderTestFiles
});
