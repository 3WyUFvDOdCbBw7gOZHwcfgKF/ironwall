import { execFileSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { heavyTestFileNames, shouldRunHeavyTests } from "./HeavyTests";

const TEST_TIMEOUT_MS: number = 15 * 60 * 1000;
const MAX_BUFFER_BYTES: number = 128 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const buildRoot: string = join(repoRoot, "build");

export interface RunBuiltTestSuiteOptions {
    readonly suiteName: string;
    readonly buildTestDirs: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly excludeTestFileNames?: ReadonlySet<string>;
    readonly startAtTestFileName?: string;
    readonly orderTestFiles?: (testFiles: readonly string[]) => string[];
}

function collectBuiltTestFiles(buildTestDirs: readonly string[]): string[] {
    const testFiles: string[] = [];
    for (const buildTestDir of buildTestDirs) {
        if (!existsSync(buildTestDir) || !statSync(buildTestDir).isDirectory()) {
            continue;
        }
        for (const entryName of readdirSync(buildTestDir).sort()) {
            if (!entryName.endsWith(".test.js")) {
                continue;
            }
            const entryPath: string = join(buildTestDir, entryName);
            if (!statSync(entryPath).isFile()) {
                continue;
            }
            const sourcePath: string = join(repoRoot, "src", buildTestDir.slice(buildRoot.length + 1), entryName.replace(/\.js$/, ".ts"));
            if (!existsSync(sourcePath)) {
                continue;
            }
            testFiles.push(entryPath);
        }
    }
    if (testFiles.length === 0) {
        throw new Error(`No built test files found. Run 'npm run build' first.`);
    }
    return testFiles;
}

function formatExecOutput(output: string | Buffer | undefined): string {
    if (output === undefined) {
        return "";
    }
    return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function formatProgressLabel(testIndex: number, testCount: number): string {
    return `[${String(testIndex)}/${String(testCount)}]`;
}

function runBuiltTest(
    suiteName: string,
    testFilePath: string,
    env: NodeJS.ProcessEnv,
    testIndex: number,
    testCount: number
): void {
    const testFileName: string = basename(testFilePath);
    const progressLabel: string = formatProgressLabel(testIndex, testCount);
    if (heavyTestFileNames.has(testFileName) && !shouldRunHeavyTests()) {
        process.stdout.write(`${suiteName} skipped heavy ${progressLabel} ${testFileName}\n`);
        return;
    }

    process.stdout.write(`${suiteName} running ${progressLabel} ${testFileName}\n`);
    try {
        const output: string = execFileSync(process.execPath, [testFilePath], {
            cwd: repoRoot,
            encoding: "utf8",
            env,
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        if (output.length > 0) {
            process.stdout.write(output);
        }
        process.stdout.write(`${suiteName} passed ${progressLabel} ${testFileName}\n`);
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
                `${suiteName} failed in ${testFileName}`,
                `status=${String(execError.status)} signal=${String(execError.signal)}`,
                stdout.length === 0 ? "stdout:<empty>" : `stdout:\n${stdout}`,
                stderr.length === 0 ? "stderr:<empty>" : `stderr:\n${stderr}`
            ].join("\n")
        );
    }
}

export function runBuiltTestSuite(options: RunBuiltTestSuiteOptions): void {
    const excludedFileNames: ReadonlySet<string> = options.excludeTestFileNames ?? new Set<string>();
    const collectedTestFiles: string[] = collectBuiltTestFiles(options.buildTestDirs).filter(
        (testFilePath: string) => !excludedFileNames.has(basename(testFilePath))
    );
    if (collectedTestFiles.length === 0) {
        throw new Error(`${options.suiteName} has no test files after exclusions.`);
    }
    const orderedTestFiles: string[] = options.orderTestFiles === undefined
        ? collectedTestFiles
        : options.orderTestFiles(collectedTestFiles);
    const startIndex: number = options.startAtTestFileName === undefined
        ? 0
        : orderedTestFiles.findIndex((testFilePath: string) => basename(testFilePath) === options.startAtTestFileName);
    if (options.startAtTestFileName !== undefined && startIndex < 0) {
        throw new Error(`${options.suiteName} could not find start test '${options.startAtTestFileName}'.`);
    }
    const selectedTestFiles: string[] = orderedTestFiles.slice(startIndex);
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...options.env
    };
    for (let index = 0; index < selectedTestFiles.length; index += 1) {
        runBuiltTest(options.suiteName, selectedTestFiles[index], env, index + 1, selectedTestFiles.length);
    }
    process.stdout.write(`${options.suiteName} ok ${selectedTestFiles.length} tests\n`);
}
