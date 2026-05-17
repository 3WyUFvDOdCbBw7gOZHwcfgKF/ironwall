import { execFileSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { basename, join, resolve } from "path";

const TEST_TIMEOUT_MS: number = 15 * 60 * 1000;
const MAX_BUFFER_BYTES: number = 128 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const buildTestDir: string = __dirname;
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

function collectBuiltTestFiles(): string[] {
    const testFiles: string[] = [];
    for (const entryName of readdirSync(buildTestDir).sort()) {
        if (!entryName.endsWith(".test.js")) {
            continue;
        }
        const entryPath: string = join(buildTestDir, entryName);
        if (!statSync(entryPath).isFile()) {
            continue;
        }
        testFiles.push(entryPath);
    }
    if (testFiles.length === 0) {
        throw new Error(`No built test files found under '${buildTestDir}'. Run 'npm run build' first.`);
    }
    return testFiles;
}

function orderTestFiles(testFiles: readonly string[]): string[] {
    const parityTestPath: string | undefined = testFiles.find((testFilePath: string) => basename(testFilePath) === parityTestFileName);
    const remainingTests: string[] = testFiles.filter((testFilePath: string) => basename(testFilePath) !== parityTestFileName);
    return parityTestPath === undefined
        ? [...remainingTests]
        : [parityTestPath, ...remainingTests];
}

function formatExecOutput(output: string | Buffer | undefined): string {
    if (output === undefined) {
        return "";
    }
    return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function runBuiltTest(testFilePath: string, externalFrontendJsonCommand: string): void {
    process.stdout.write(`cpp-parser-suite running ${basename(testFilePath)}\n`);
    try {
        const output: string = execFileSync(process.execPath, [testFilePath], {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                IW_EXTERNAL_FRONTEND_JSON_COMMAND: externalFrontendJsonCommand
            },
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        if (output.length > 0) {
            process.stdout.write(output);
        }
    } catch (error) {
        const execError = error as Error & {
            readonly stdout?: string | Buffer;
            readonly stderr?: string | Buffer;
            readonly status?: number | null;
            readonly signal?: NodeJS.Signals | null;
        };
        const stdout: string = formatExecOutput(execError.stdout);
        const stderr: string = formatExecOutput(execError.stderr);
        throw new Error(
            [
                `cpp-parser-suite failed in ${basename(testFilePath)}`,
                `status=${String(execError.status)} signal=${String(execError.signal)}`,
                stdout.length === 0 ? "stdout:<empty>" : `stdout:\n${stdout}`,
                stderr.length === 0 ? "stderr:<empty>" : `stderr:\n${stderr}`,
            ].join("\n")
        );
    }
}

const externalFrontendJsonCommand: string = getExternalFrontendJsonCommand();
ensureUsableExternalFrontendJsonCommand(externalFrontendJsonCommand);

const orderedTestFiles: string[] = orderTestFiles(collectBuiltTestFiles());
for (const testFilePath of orderedTestFiles) {
    runBuiltTest(testFilePath, externalFrontendJsonCommand);
}

process.stdout.write(
    `cpp-parser-suite ok ${orderedTestFiles.length} tests via ${externalFrontendJsonCommand}\n`
);