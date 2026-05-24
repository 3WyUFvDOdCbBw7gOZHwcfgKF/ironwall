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

function runBuiltTest(suiteName: string, testFilePath: string, env: NodeJS.ProcessEnv): void {
    const testFileName: string = basename(testFilePath);
    if (heavyTestFileNames.has(testFileName) && !shouldRunHeavyTests()) {
        process.stdout.write(`${suiteName} skipped heavy ${testFileName}\n`);
        return;
    }

    process.stdout.write(`${suiteName} running ${testFileName}\n`);
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
    const collectedTestFiles: string[] = collectBuiltTestFiles(options.buildTestDirs);
    const orderedTestFiles: string[] = options.orderTestFiles === undefined
        ? collectedTestFiles
        : options.orderTestFiles(collectedTestFiles);
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...options.env
    };
    for (const testFilePath of orderedTestFiles) {
        runBuiltTest(options.suiteName, testFilePath, env);
    }
    process.stdout.write(`${options.suiteName} ok ${orderedTestFiles.length} tests\n`);
}
